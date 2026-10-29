// Prepare an inline context once per call (segment and measure), and the intrinsic sizes
// read off the prepared content: one recursion, as an atomic inline-block is prepared at its
// max-content width, which prepares its own content.
import type { StyledNode, ResolvedStyle } from '../types.js';
import { anonymousBlockStyle, borderBoxSize, contentBoxSize, intrinsicStyle } from '../css-resolver.js';
import { bidiContextFor, type BidiContext } from '../bidi.js';
import type { LayoutSession } from './session.js';
import {
  hasOnlyInlineChildren, hasStrokeImage, hasTextClip, hasVisibleBoxStyles, horizontalFrame,
  horizontalMargins, isInline, layoutUnitCeil, transformTextRuns,
} from './util.js';
import {
  abutsWithoutBreak, breakFlags, forEachHyphenPiece, inlineEdgeWidth, measureAfter, needsSegmenter, overriddenText, segmenter,
  SegmentBuilder, wordSpacingIn,
  SEG_NO_BREAK_BEFORE, SEG_RUN_SEAM, SEG_SOFT_HYPHEN, SEG_SPACE, SEG_TAB,
  type Cumulative, type PreparedInline, type TextRun,
} from './segment.js';
import { FlowItems, flowLines, LineFlow, widestLine } from './flow.js';

// ── Inline layout ──

/**
 * Collect text runs from inline children, with open/close markers for inline boxes and the
 * nearest paint declarers (`clipStyle`, `strokeImageStyle`).
 */
function collectTextRuns(node: StyledNode): TextRun[] {
  const runs: TextRun[] = [];

  function walk(
    n: StyledNode,
    boxStyle?: ResolvedStyle,
    clipStyle?: ResolvedStyle,
    strokeImageStyle?: ResolvedStyle,
    parentStyle?: ResolvedStyle,
    bidi: BidiContext | null = null,
  ) {
    if (n.tagName === '#text' && n.textContent) {
      // A #text node carries its parent element's style, so its vertical-align shifts against
      // that element's parent: `parentStyle`.
      runs.push({
        text: n.textContent, style: n.style, parentStyle, boxStyle, clipStyle, strokeImageStyle, bidi,
      });
      return;
    }
    const isInlineBlock = n.style.display === 'inline-block';
    const inline = isInline(n);
    // Inline-block always needs box treatment (padding/margin affect layout)
    const isBox = isInlineBlock || (inline && hasVisibleBoxStyles(n.style));
    const newBoxStyle = isBox ? n.style : boxStyle;
    // Nearest clip / stroke-image declarer: those properties do not inherit.
    const newClipStyle = inline && hasTextClip(n.style) ? n.style : clipStyle;
    const newStrokeImageStyle = inline && hasStrokeImage(n.style) ? n.style : strokeImageStyle;
    // Inline-axis margin, border and padding move the content whether or not the box paints.
    const hasHorizSpacing = inline && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);
    const hasMargins = inline && (n.style.marginLeft !== 0 || n.style.marginRight !== 0);

    if (isInlineBlock) {
      // An inline-block is one atomic run, sized from its own content. Its text is U+FFFC, what
      // an atomic inline is to line breaking and bidi; empty content is only its opening edge.
      const hasText = !!n.element?.textContent;
      runs.push({
        text: hasText ? '\uFFFC' : '',
        style: n.style,
        wordBoundaryBefore: true,
        parentStyle,
        boxStyle: newBoxStyle,
        clipStyle: newClipStyle,
        strokeImageStyle: newStrokeImageStyle,
        // Both edges mark it atomic; an empty one is only its opening edge.
        boxOpen: n.style,
        boxClose: hasText ? n.style : undefined,
        inlineBlock: n,
        bidi,
      });
      return;
    }

    // The element's bidi context (CSS Writing Modes 3 §2.4.2). An RTL override is reordered
    // per line, after breaking, like any RTL text (`emitLineText`).
    const childBidi = bidiContextFor(n.style.unicodeBidi, n.style.direction, bidi);

    // A margin lies outside the box's background: its edge belongs to the enclosing box.
    if (hasMargins) runs.push({ text: '', style: n.style, boxStyle, boxOpen: n.style, margin: true, bidi });
    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style, bidi });
    }

    for (const child of n.children) {
      walk(
        child, newBoxStyle, newClipStyle, newStrokeImageStyle,
        // A text child's vertical-align belongs to this element, so it shifts against this
        // element's parent.
        child.tagName === '#text' ? parentStyle : n.style,
        childBidi,
      );
    }

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style, bidi });
    }
    if (hasMargins) runs.push({ text: '', style: n.style, boxStyle, boxClose: n.style, margin: true, bidi });
  }

  // The block itself is the parent every top-level run measures against.
  for (const child of node.children) {
    walk(child, undefined, undefined, undefined, node.style);
  }
  return runs;
}

/** `[ \t\n\r\f\v]`: what collapsible white space splits on. */
function isCollapsibleSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** Segment and measure one string into `out` by white-space mode. */
function prepareString(
  session: LayoutSession, out: SegmentBuilder, text: string, run: TextRun, ref: number,
  cumState?: Cumulative,
): void {
  const m = session.measurer;
  // Zero-width spaces and soft hyphens are break opportunities; the parts share one context.
  if (text.includes('\u200B') || text.includes('\u00AD')) {
    const parts = text.split(/(\u200B|\u00AD)/);
    const sharedState = cumState ?? { text: '', width: 0, word: 0 };
    let nextIsSoftHyphen = false;
    for (const part of parts) {
      if (part === '\u00AD') {
        nextIsSoftHyphen = true;
        continue;
      }
      if (part === '\u200B' || part === '') {
        nextIsSoftHyphen = false;
        continue;
      }
      // The segment before this part — possibly one from an earlier run.
      const prevLen = out.count;
      prepareString(session, out, part, run, ref, sharedState);
      if (nextIsSoftHyphen && prevLen > 0) {
        out.flags[prevLen - 1] |= SEG_SOFT_HYPHEN;
      }
      nextIsSoftHyphen = false;
    }
    if (nextIsSoftHyphen && out.count > 0) {
      out.flags[out.count - 1] |= SEG_SOFT_HYPHEN;
    }
    return;
  }

  const state = m.stateOf(run.style);
  const spacing = run.style.wordSpacing || 0;
  const n = text.length;

  // `pre-line` collapses spaces and tabs (its newlines were split off in prepareInline).
  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'break-spaces';

  if (isPreserve) {
    // Space runs, single tabs and the text between them, split after hyphens.
    const tabStopInterval = m.width(state, ' ') * 8; // CSS default: 8 spaces
    let i = 0;
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 9) {
        // A placeholder: the flow resolves a tab against the tab stops.
        out.push('\t', tabStopInterval, SEG_SPACE | SEG_TAB, ref);
        i++;
        continue;
      }
      let j = i + 1;
      if (code === 32) {
        while (j < n && text.charCodeAt(j) === 32) j++;
        const w = text.slice(i, j);
        out.push(w, m.width(state, w) + wordSpacingIn(w, spacing), SEG_SPACE, ref);
      } else {
        while (j < n && text.charCodeAt(j) !== 32 && text.charCodeAt(j) !== 9) j++;
        forEachHyphenPiece(text, i, j, (w) => out.push(w, m.width(state, overriddenText(w, run.bidi)) + wordSpacingIn(w, spacing), breakFlags(w), ref));
      }
      i = j;
    }
    return;
  }

  // A word breaks after "?" (Chrome wraps URLs at the query; not at / & = . :), and before an
  // NBSP only after a hyphen or break-after char (UAX #14 LB12a; measured: - | \u2013 \u2014).
  const cum: Cumulative = cumState ?? { text: '', width: 0, word: 0 };
  const word = (w: string) => {
    // Use Intl.Segmenter for scripts without spaces (Thai, Khmer, etc.)
    if (needsSegmenter(w)) {
      const wordSeg = segmenter('word');
      if (wordSeg) {
        for (const seg of wordSeg.segment(w)) {
          const s = seg.segment;
          out.push(s, measureAfter(m, state, cum, overriddenText(s, run.bidi)) + wordSpacingIn(s, spacing), breakFlags(s), ref);
        }
        return;
      }
    }
    const width = measureAfter(m, state, cum, overriddenText(w, run.bidi)) + wordSpacingIn(w, spacing);
    if (session.debug) {
      // Measured alone for the debug callback only.
      const directWidth = m.width(state, w);
      session.debug({
        type: 'measure-word',
        message: `"${w}" delta=${width.toFixed(2)} direct=${directWidth.toFixed(2)} diff=${(width - directWidth).toFixed(2)} context="${cum.text}"`,
        data: { text: w, deltaWidth: width, directWidth, contextWidth: cum.width, contextBefore: cum.width - width, font: run.style.fontFamily, fontSize: run.style.fontSize },
      });
    }
    out.push(w, width, breakFlags(w), ref);
  };
  let i = 0;
  while (i < n) {
    let j = i + 1;
    if (isCollapsibleSpace(text.charCodeAt(i))) {
      while (j < n && isCollapsibleSpace(text.charCodeAt(j))) j++;
      out.push(' ', measureAfter(m, state, cum, ' ') + spacing, SEG_SPACE, ref);
      i = j;
      continue;
    }
    while (j < n && !isCollapsibleSpace(text.charCodeAt(j))) j++;
    let start = i;
    for (let q = i + 1; q < j; q++) {
      const before = text.charCodeAt(q - 1);
      const at = text.charCodeAt(q);
      if ((before === 0x3F && at !== 0x2028 && at !== 0x2029) ||
          (at === 0xA0 && (before === 0x2D || before === 0x7C || before === 0x2013 || before === 0x2014))) {
        forEachHyphenPiece(text, start, q, word);
        start = q;
      }
    }
    forEachHyphenPiece(text, start, j, word);
    i = j;
  }
}

/** Segment and measure text runs: the one pass over an inline context's text per call. */
function prepareInline(session: LayoutSession, runs: TextRun[]): PreparedInline {
  const out = new SegmentBuilder();
  /** The text so far ends with a zero-width space (a break opportunity). */
  let zwspBefore = false;
  /** Style of the last text run that produced segments (`markSeam`). */
  let lastTextStyle: ResolvedStyle | null = null;
  let runStart = 0;

  for (const run of transformTextRuns(runs)) {
    // Atomic inline-block: one segment at its max-content width, re-sized by the final flow
    // (`usedSegmentWidths`). Checked before the box edges: it has both.
    if (run.boxOpen && run.boxClose && run.text) {
      const source = run.inlineBlock!;
      out.inlineBlocks.push(out.count);
      out.push(run.text, inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), Infinity), 0, out.addRefs(run));
      continue;
    }

    // Inline box edge (margin, or padding + border), or an empty inline-block's opening edge.
    // A percentage is 0 until `usedSegmentWidths`; a negative margin pulls the next item back.
    const edge = run.boxOpen ?? run.boxClose;
    if (edge) {
      const box = intrinsicStyle(edge);
      const pad = inlineEdgeWidth(run, box);
      if (pad !== 0 || box !== edge) {
        if (box !== edge) out.percentEdges.push(out.count);
        out.push('', pad, 0, out.addRefs(run));
      }
      continue;
    }

    const text = run.text;
    const ref = out.addRefs(run);
    runStart = out.count;
    /** Flag a seam when the previous text run had the same style object (`SEG_RUN_SEAM`). */
    const markSeam = (startLen: number, first: boolean) => {
      if (first && run.style === lastTextStyle && out.count > startLen) out.flags[startLen] |= SEG_RUN_SEAM;
    };
    // A zero-width space at the run boundary (a `<wbr>`, or one ending the
    // previous run) is a break opportunity there; it produces no segment itself.
    const breakAtStart = zwspBefore || text.charCodeAt(0) === 0x200B;
    zwspBefore = text.charCodeAt(text.length - 1) === 0x200B || (zwspBefore && /^\u200B*$/.test(text));

    // A run boundary inside a word is no break opportunity
    // (`abutsWithoutBreak`), unless a zero-width space opens one.
    const markGlue = (startLen: number) => {
      if (!breakAtStart && abutsWithoutBreak(out, startLen)) out.flags[startLen] |= SEG_NO_BREAK_BEFORE;
    };

    // A newline (from <br> or pre-wrap) is always a forced break.
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) out.push('\n', 0, 0, ref);
      if (parts[i]) {
        const startLen = out.count;
        prepareString(session, out, parts[i], run, ref);
        markSeam(startLen, i === 0);
        markGlue(startLen);
      }
    }
    if (out.count > runStart) lastTextStyle = run.style;
  }

  if (session.stats) {
    session.stats.tokenizePasses++;
    session.stats.segments += out.count;
  }
  out.runs = runs.length;
  return out;
}

/** The prepared content of `node`'s inline context for intrinsic sizing, made once per call. */
function preparedInline(session: LayoutSession, node: StyledNode): PreparedInline {
  let prepared = session.prepared.get(node);
  if (!prepared) {
    prepared = prepareInline(session, collectTextRuns(node));
    session.prepared.set(node, prepared);
  }
  return prepared;
}

/**
 * The prepared content for the layout, its last reader: taken off the session so a long
 * document does not hold every paragraph's segments.
 */
export function takePreparedInline(session: LayoutSession, node: StyledNode): PreparedInline {
  const prepared = session.prepared.get(node);
  if (!prepared) return prepareInline(session, collectTextRuns(node));
  session.prepared.delete(node);
  return prepared;
}

// ── Flex items and intrinsic sizes ──

/**
 * Bare text in a flex container is an anonymous flex item, built once per text node (the
 * content-size caches key by identity). It inherits the container's style with every box
 * property at its initial value.
 */
function anonymousFlexItem(session: LayoutSession, text: StyledNode): StyledNode {
  let wrapper = session.anonymousFlexItems.get(text);
  if (!wrapper) {
    wrapper = {
      element: null,
      tagName: 'div',
      style: anonymousBlockStyle(text.style),
      children: [text],
      textContent: null,
    };
    session.anonymousFlexItems.set(text, wrapper);
  }
  return wrapper;
}

/**
 * A flex container's items: a bare text node counts only with actual text, the same answer
 * for sizing and layout.
 */
export function flexItems(session: LayoutSession, node: StyledNode): StyledNode[] {
  return node.children
    .filter((child) => child.tagName !== '#text' || child.textContent?.trim())
    .map((child) => child.tagName === '#text' ? anonymousFlexItem(session, child) : child);
}

export function isFlexRow(style: ResolvedStyle): boolean {
  return style.flexDirection === 'row' || style.flexDirection === '';
}

/** Min- or max-content width of an inline context: the real flow at 0 or at Infinity. */
function inlineContentSize(session: LayoutSession, node: StyledNode, max: boolean): number {
  const prepared = preparedInline(session, node);
  let widths: number[] | undefined;
  if (!max) {
    // Prepared inline-blocks stand at max-content.
    for (const i of prepared.inlineBlocks) {
      const source = prepared.refs[prepared.ref[i]].inlineBlock!;
      widths ??= prepared.width.slice();
      widths[i] = inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), 0);
    }
  }
  const textIndent = intrinsicStyle(node.style).textIndent;
  // Blink's `LayoutUnit::FromFloatCeil`: a box shrunk to this width holds its content.
  return layoutUnitCeil(widestLine(flowLines(new LineFlow(
    session, new FlowItems(prepared, widths), max ? Infinity : 0, node.style.whiteSpace, textIndent, !max)), textIndent));
}

/**
 * Min- or max-content width of `node`'s content box, memoized per call. Percentages inside
 * are cyclic, so descendants read `intrinsicStyle`.
 */
export function contentSize(session: LayoutSession, node: StyledNode, max: boolean): number {
  const memo = max ? session.maxContent : session.minContent;
  const memoized = memo.get(node);
  if (memoized !== undefined) return memoized;
  const contribution = max ? maximumContribution : minimumContribution;
  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = inlineContentSize(session, node, max);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(session, node);
    for (const child of children) content += contribution(session, child, intrinsicStyle(child.style));
    content += intrinsicStyle(node.style).gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, contribution(session, child, intrinsicStyle(child.style)));
      }
    }
  }
  memo.set(node, content);
  return content;
}

/**
 * Min-content contribution of `node` as a margin-box width, its box read from `style`
 * (`node.style` for a flex item, else `intrinsicStyle`).
 */
export function minimumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  const frame = horizontalFrame(style);

  // An explicit min-width disables the flex automatic min-content size.
  if (style.minWidth !== null) {
    return margins + borderBoxSize(style, style.minWidth, frame);
  }

  let borderBox = frame + contentSize(session, node, false);
  // A definite width caps the automatic minimum size in the flex algorithm.
  if (style.width > 0) borderBox = Math.min(borderBox, borderBoxSize(style, style.width, frame));
  return margins + borderBox;
}

/** Max-content contribution of `node`, in the same outer currency (see `minimumContribution`). */
export function maximumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  // A definite width IS the max-content size.
  if (style.width > 0) return margins + borderBoxSize(style, style.width, horizontalFrame(style));
  return margins + horizontalFrame(style) + contentSize(session, node, true);
}

/**
 * An inline-block's content width with `available` px left: its own width, else
 * shrink-to-fit (CSS 2.1 §10.3.9), floored at min-width. At 0 / Infinity that is min- /
 * max-content, so sizing and the final flow ask the same question.
 */
export function inlineBlockContentWidth(
  session: LayoutSession, node: StyledNode, style: ResolvedStyle, available: number,
): number {
  const frame = horizontalFrame(style);
  // An inline-block's content is ONE inline flow, block children included, sized by it.
  const inlineOnly = hasOnlyInlineChildren(node);
  let width = style.width > 0
    ? contentBoxSize(style, style.width, frame)
    : Math.min(
      inlineOnly ? contentSize(session, node, true) : inlineContentSize(session, node, true),
      Math.max(inlineOnly ? contentSize(session, node, false) : inlineContentSize(session, node, false), available),
    );
  if (style.minWidth !== null) width = Math.max(width, contentBoxSize(style, style.minWidth, frame));
  return width;
}

/** An inline-block's margin box at `containingWidth`: what one line item of it takes. */
function inlineBlockOuterWidth(
  session: LayoutSession, node: StyledNode, style: ResolvedStyle, containingWidth: number,
): number {
  const margins = horizontalMargins(style);
  const frame = horizontalFrame(style);
  return margins + frame +
    inlineBlockContentWidth(session, node, style, Math.max(0, containingWidth - margins - frame));
}
