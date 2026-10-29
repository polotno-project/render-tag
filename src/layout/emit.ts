// The final flow's lines become nodes: bidi reordering, alignment, line boxes, inline
// backgrounds, text nodes and the paint-declarer fragment boxes.
import type { StyledNode, LayoutBox, LayoutNode, LayoutText, ResolvedStyle, LayoutLine, LayoutLineBox } from '../types.js';
import { isTransparent, resolvePercentages } from '../css-resolver.js';
import { CANVAS_BIDI_LINE } from '../engine.js';
import { BidiTextBuilder, levelRuns, lineLevels, mayNeedBidi, overridesRtl, resolveBidi, visualOrder } from '../bidi.js';
import {
  CLAMP_ELLIPSIS, INLINE_BLOCK, inlineBlockExtra, isShiftedVAlign, LINE_BASELINE, LINE_BOX, LINE_TOP,
  RUN_LEVELS, RUN_REVERSED, RUN_SEAM, SPACE_WRAP, verticalAlignShift,
  type LayoutSession, type Measurer, type PrivateLineBox, type PrivateText,
} from './session.js';
import {
  appendAll, createsLineBox, horizontalFrame, horizontalMargins, resolveChildPercentages, sameDecorationBand,
  textEdges, withDirection,
} from './util.js';
import {
  inlineEdgeWidth, isAtomicInlineBlock, overriddenText, type InlineBlockLayout, type PositionedLine, type PreparedInline, type Word,
} from './segment.js';
import { clampLines, clampSpent, FlowItems, flowLines, LineFlow, type LineClampState } from './flow.js';
import { inlineBlockContentWidth, takePreparedInline } from './prepare.js';

/**
 * The final flow's widths for segments preparing could not size (inline-blocks,
 * percentage edges) at `containingWidth`, each inline-block laid out at its width.
 * Undefined when every prepared width stands.
 */
function usedSegmentWidths(
  session: LayoutSession,
  prepared: PreparedInline,
  containingWidth: number,
): { widths: number[]; layouts: Map<number, InlineBlockLayout> | undefined } | undefined {
  if (prepared.inlineBlocks.length === 0 && prepared.percentEdges.length === 0) return undefined;
  const widths = prepared.width.slice();
  for (const i of prepared.percentEdges) {
    const refs = prepared.refs[prepared.ref[i]];
    widths[i] = inlineEdgeWidth(refs, refs.boxOpen ?? refs.boxClose!);
  }
  let layouts: Map<number, InlineBlockLayout> | undefined;
  for (const i of prepared.inlineBlocks) {
    const source = prepared.refs[prepared.ref[i]].inlineBlock!;
    const s = source.style;
    const margins = horizontalMargins(s);
    const frame = horizontalFrame(s);
    const contentWidth = inlineBlockContentWidth(
      session, source, s, Math.max(0, containingWidth - margins - frame));
    // The source node is the inner root; its box properties are applied here.
    resolvePercentages(s, contentWidth, true);
    resolveChildPercentages(source, contentWidth);
    const inner = layoutInlineContent(session, source, 0, 0, contentWidth);
    const contentHeight = inner.height || session.measurer.lineHeight(s);
    const lastBaseline = inner.lines.at(-1)?.y ??
      session.measurer.leadedBox(s).ascent;
    const extra = inlineBlockExtra(s);
    const baselineOffset = extra.top + lastBaseline;
    const marginBoxHeight = extra.top + contentHeight + extra.bottom;
    widths[i] = margins + frame + contentWidth;
    (layouts ??= new Map()).set(i, {
      nodes: inner.nodes,
      lines: inner.lines,
      lineBoxes: inner.lineBoxes,
      contentWidth,
      contentHeight,
      baselineOffset,
      marginBoxHeight,
    });
  }
  return { widths, layouts };
}

// ── Bidi reordering ──

/**
 * Per line, per word, UAX #9 levels after L1 (`null` for a padding marker or a line that
 * needs none; `null` overall for a paragraph without RTL). Resolved over the whole
 * paragraph, as W2/W7 look across lines; an atomic inline is one U+FFFC.
 */
function resolveLineBidi(
  lines: PositionedLine[], rtl: boolean,
): Array<Array<Uint8Array | null> | null> | null {
  let needed = rtl;
  for (let i = 0; !needed && i < lines.length; i++) {
    for (const w of lines[i].words) {
      let rtlContext = false;
      for (let c = w.refs.bidi; c && !rtlContext; c = c.parent) rtlContext = mayNeedBidi(c.open);
      if (rtlContext || mayNeedBidi(w.text)) { needed = true; break; }
    }
  }
  if (!needed) return null;

  const builder = new BidiTextBuilder();
  const starts = lines.map((line) => {
    const at = line.words.map((w) => w.text === ''
      ? -1
      : builder.push(isAtomicInlineBlock(w) ? '\uFFFC' : w.text, w.refs.bidi ?? null));
    if (line.endedByHardBreak) builder.paragraphBreak();
    return at;
  });
  builder.enter(null);
  const par = resolveBidi(builder.text, rtl ? 1 : 0);

  return lines.map((line, li) => {
    const at = starts[li];
    const lengthOf = (k: number) => isAtomicInlineBlock(line.words[k]) ? 1 : line.words[k].text.length;
    let first = -1;
    let end = -1;
    at.forEach((start, k) => {
      if (start < 0) return;
      if (first < 0) first = start;
      end = start + lengthOf(k);
    });
    if (first < 0) return null;
    const levels = lineLevels(par, first, end);
    if (!rtl && levels.every((level) => level === 0)) return null;
    return at.map((start, k) => start < 0
      ? null
      : levels.subarray(start - first, start - first + lengthOf(k)));
  });
}

/** Can two visually adjacent pieces of one level paint as ONE fillText? */
function sameBidiRun(a: Word, b: Word): boolean {
  return overridesRtl(a.refs.bidi) === overridesRtl(b.refs.bidi) &&
    a.refs.boxStyle === b.refs.boxStyle && a.refs.clipStyle === b.refs.clipStyle &&
    a.refs.strokeImageStyle === b.refs.strokeImageStyle && a.refs.parentStyle === b.refs.parentStyle &&
    sameGlyphPaint(a.refs.style, b.refs.style);
}

/**
 * Do two styles place and paint glyphs alike? A merged bidi run paints with its first
 * piece's style, so EVERY property the text painter reads must be compared here.
 */
function sameGlyphPaint(p: ResolvedStyle, q: ResolvedStyle): boolean {
  if (p === q) return true;
  if (p.fontFamily !== q.fontFamily || p.fontSize !== q.fontSize || p.fontWeight !== q.fontWeight ||
    p.fontStyle !== q.fontStyle || p.fontVariantCaps !== q.fontVariantCaps || p.fontKerning !== q.fontKerning ||
    p.color !== q.color || p.webkitTextFillColor !== q.webkitTextFillColor ||
    p.textDecorationLine !== q.textDecorationLine) return false;
  // Decorations that would paint differently must not merge into one band.
  const da = p.textDecorations, db = q.textDecorations;
  if (da !== db) {
    if (!da || !db || da.length !== db.length) return false;
    for (let i = 0; i < da.length; i++) {
      if (da[i].line !== db[i].line || da[i].color !== db[i].color || da[i].style !== db[i].style ||
        !sameDecorationBand(da[i], db[i])) return false;
    }
  }
  return p.backgroundColor === q.backgroundColor &&
    p.letterSpacing === q.letterSpacing && p.wordSpacing === q.wordSpacing &&
    p.verticalAlign === q.verticalAlign && p.textShadow === q.textShadow &&
    p.webkitTextStrokeWidth === q.webkitTextStrokeWidth &&
    p.webkitTextStrokeColor === q.webkitTextStrokeColor &&
    p.strokeLinejoin === q.strokeLinejoin && p.paintOrder === q.paintOrder;
}

/**
 * A line in ONE paint as a single run in the paragraph direction, so Canvas shapes it as
 * layout does (`CANVAS_BIDI_LINE`), only when Canvas alone reaches the paragraph's
 * levels for it (not when W2/W7/N1 reach across a wrap). `null` otherwise.
 */
function singlePaintLine(
  words: Word[],
  wordLevels: Array<Uint8Array | null>,
  paragraphLevel: 0 | 1,
  justifying: boolean,
): { words: Word[]; levels: number[]; keys: number[] } | null {
  if (words.length === 0 || justifying) return null;
  const first = words[0];
  for (const w of words) {
    if (w.text === '' || w.isTab || isAtomicInlineBlock(w) ||
      w.refs.bidi !== first.refs.bidi || !sameBidiRun(first, w)) return null;
  }
  const text = words.map((w) => w.text).join('');
  const own = resolveBidi(text, paragraphLevel);
  const ownLevels = lineLevels(own, 0, text.length);
  let at = 0;
  for (let k = 0; k < words.length; k++) {
    const lv = wordLevels[k]!;
    for (let i = 0; i < lv.length; i++) if (lv[i] !== ownLevels[at + i]) return null;
    at += lv.length;
  }
  return {
    words: [{
      ...first, text, width: words.reduce((sum, w) => sum + w.width, 0), isSpace: false,
      ellipsis: words[words.length - 1].ellipsis,
      levels: ownLevels.some((level) => level !== paragraphLevel) ? ownLevels : undefined,
    }],
    levels: [paragraphLevel],
    keys: [0],
  };
}

/**
 * One line's words as level-uniform pieces in VISUAL order (UAX #9 L2). A word with mixed
 * levels is cut, sharing its width by measure. Padding markers go at the visual edges of
 * their box's content. Adjacent pieces of one non-zero level and paint merge into one run
 * (one fillText); level-0 words never merge. `keys` give each piece its logical position.
 */
function bidiLineItems(
  m: Measurer,
  words: Word[],
  wordLevels: Array<Uint8Array | null>,
  paragraphLevel: 0 | 1,
  justifying: boolean,
): { words: Word[]; levels: number[]; keys: number[] } {
  const single = CANVAS_BIDI_LINE && singlePaintLine(words, wordLevels, paragraphLevel, justifying);
  if (single) return single;

  const items: Word[] = [];
  const levels: number[] = [];
  words.forEach((word, k) => {
    const lv = wordLevels[k];
    if (!lv) {
      items.push(word);
      levels.push(-1); // a marker: resolved below
      return;
    }
    const cuts = levelRuns(lv);
    if (cuts.length === 1 || isAtomicInlineBlock(word)) {
      items.push(word);
      levels.push(lv[0]);
      return;
    }
    const state = m.stateOf(word.refs.style);
    const measured = cuts.map(([a, b]) => m.width(state, word.text.slice(a, b)));
    const sum = measured.reduce((x, y) => x + y, 0);
    cuts.forEach(([a, b], i) => {
      items.push({
        ...word,
        text: word.text.slice(a, b),
        width: sum > 0 ? word.width * measured[i] / sum : 0,
      });
      levels.push(lv[a]);
    });
  });

  // Markers are not characters: reorder the content alone, then put each marker at its
  // box's visual edge (`<code>render()</code>` in Arabic).
  const content: number[] = [];
  items.forEach((_, i) => { if (levels[i] >= 0) content.push(i); });
  const order = visualOrder(content.map((i) => levels[i]));
  const visualPos = new Map<number, number>(); // item index → visual slot
  order.forEach((k, v) => visualPos.set(content[k], v));
  const before: number[][] = order.map(() => []);
  const after: number[][] = order.map(() => []);
  const trailing: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (levels[i] >= 0) continue;
    const marker = items[i];
    const closing = !!marker.refs.boxClose && !marker.refs.boxOpen;
    // The box's content on this line: between the marker and its partner
    // (or the line edge when the partner is on another line).
    let from = i + 1;
    let to = items.length;
    if (closing) {
      from = 0;
      to = i;
      for (let j = i - 1; j >= 0; j--) {
        if (levels[j] < 0 && items[j].refs.boxOpen === marker.refs.boxClose && !items[j].refs.boxClose) { from = j + 1; break; }
      }
    } else if (marker.refs.boxOpen) {
      for (let j = i + 1; j < items.length; j++) {
        if (levels[j] < 0 && items[j].refs.boxClose === marker.refs.boxOpen && !items[j].refs.boxOpen) { to = j; break; }
      }
    } else {
      to = from + 1; // an inline-block's margin: it belongs to the next item
    }
    let first = Infinity;
    let last = -1;
    for (let j = from; j < to; j++) {
      const v = visualPos.get(j);
      if (v !== undefined) { first = Math.min(first, v); last = Math.max(last, v); }
    }
    if (last >= 0) {
      if (closing) after[last].push(i);
      else before[first].push(i);
      continue;
    }
    // An empty box: stay beside the logically nearest content.
    let near: number | undefined;
    for (let j = i + 1; near === undefined && j < items.length; j++) near = visualPos.get(j);
    if (near !== undefined) before[near].push(i);
    else {
      for (let j = i - 1; near === undefined && j >= 0; j--) near = visualPos.get(j);
      if (near !== undefined) after[near].push(i);
      else trailing.push(i);
    }
  }
  // Item indices (logical order) in visual order.
  const sequence: number[] = [];
  order.forEach((k, v) => {
    appendAll(sequence, before[v]);
    sequence.push(content[k]);
    appendAll(sequence, after[v]);
  });
  appendAll(sequence, trailing);
  const visual = sequence.map((i) => items[i]);
  const visualLevels = sequence.map((i) => levels[i] >= 0 ? levels[i] : paragraphLevel);

  const mergeable = (w: Word) => w.text !== '' && !w.isTab && !isAtomicInlineBlock(w) &&
    !(justifying && w.isSpace);
  const outWords: Word[] = [];
  const outLevels: number[] = [];
  const outKeys: number[] = [];
  for (let i = 0; i < visual.length;) {
    const level = visualLevels[i];
    let j = i + 1;
    if (level > 0 && mergeable(visual[i])) {
      while (j < visual.length && visualLevels[j] === level && mergeable(visual[j]) &&
        sameBidiRun(visual[i], visual[j])) j++;
    }
    if (j === i + 1) {
      outWords.push(visual[i]);
    } else {
      const run = visual.slice(i, j);
      if (level % 2) run.reverse(); // back to logical order
      outWords.push({
        ...run[0],
        text: run.map((w) => w.text).join(''),
        // The flow's own advances (measured with context), not a fresh measure of the joined text.
        width: run.reduce((sum, w) => sum + w.width, 0),
        isSpace: run.every((w) => w.isSpace),
        ellipsis: run[run.length - 1].ellipsis,
      });
    }
    outLevels.push(level);
    let key = sequence[i];
    for (let k = i + 1; k < j; k++) key = Math.min(key, sequence[k]);
    outKeys.push(key);
    i = j;
  }
  return { words: outWords, levels: outLevels, keys: outKeys };
}

/** One inline context's layout output and the state its lines share (`emitLine` appends). */
interface InlineEmit {
  readonly session: LayoutSession;
  /**
   * The block's style: its strut seeds every line's height AND baseline, so small inline
   * text sits on the block-font baseline. Also the parent of runs with no inline ancestor.
   */
  readonly blockStyle: ResolvedStyle;
  readonly x: number;
  readonly contentWidth: number;
  readonly textIndent: number;
  readonly isRTL: boolean;
  /** Physical alignment (start/end resolved) of ordinary lines… */
  readonly textAlign: string;
  /** …and of the last line and lines ending at a forced break. */
  readonly textAlignLast: string;
  readonly nodes: LayoutNode[];
  readonly lines: LayoutLine[];
  readonly lineBoxes: LayoutLineBox[];
  /**
   * Text nodes under a clip / stroke-image declarer, to its style (`assignInlineFragmentBoxes`).
   */
  readonly clipRuns: Map<LayoutText, ResolvedStyle>;
  readonly strokeImageRuns: Map<LayoutText, ResolvedStyle>;
}

/**
 * Lay out inline content: `flowInlineLines`, `clampLines`, `emitLine` per line, then
 * `assignInlineFragmentBoxes`.
 */
export function layoutInlineContent(
  session: LayoutSession,
  node: StyledNode,
  x: number,
  y: number,
  contentWidth: number,
  clamp?: LineClampState,
): { nodes: LayoutNode[]; height: number; lines: LayoutLine[]; lineBoxes: LayoutLineBox[] } {
  // An ancestor's clamp already used its line budget — drop this content.
  if (clampSpent(clamp)) {
    return { nodes: [], height: 0, lines: [], lineBoxes: [] };
  }
  const prepared = takePreparedInline(session, node);
  if (prepared.runs === 0 && !node.children.some(createsLineBox)) {
    return { nodes: [], height: 0, lines: [], lineBoxes: [] };
  }

  const lines = flowInlineLines(session, node, prepared, contentWidth);
  clampLines(session, node.style, lines, contentWidth, clamp);

  const style = node.style;
  const isRTL = style.direction === 'rtl';
  const resolveDir = (a: string) => {
    if (a === 'start') return isRTL ? 'right' : 'left';
    if (a === 'end') return isRTL ? 'left' : 'right';
    return a;
  };
  const textAlign = resolveDir(style.textAlign);
  // text-align-last: 'auto' inherits from text-align except when text-align is
  // 'justify', then defaults to 'start' (CSS Text 3 §7.2).
  let textAlignLast = style.textAlignLast || 'auto';
  if (textAlignLast === 'auto') {
    textAlignLast = style.textAlign === 'justify' ? (isRTL ? 'right' : 'left') : textAlign;
  } else {
    textAlignLast = resolveDir(textAlignLast);
  }
  const out: InlineEmit = {
    session,
    blockStyle: style,
    x,
    contentWidth,
    textIndent: style.textIndent || 0,
    isRTL,
    textAlign,
    textAlignLast,
    nodes: [],
    lines: [],
    lineBoxes: [],
    clipRuns: new Map(),
    strokeImageRuns: new Map(),
  };

  const bidiLines = resolveLineBidi(lines, isRTL);
  let curY = y;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    curY += emitLine(out, lines[lineIdx], lineIdx === 0, lineIdx === lines.length - 1,
      bidiLines?.[lineIdx], curY);
  }

  assignInlineFragmentBoxes(session, out.nodes, out.clipRuns, (node, s, box) => {
    node.clip = {
      image: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : undefined,
      color: !isTransparent(s.backgroundColor) ? s.backgroundColor : undefined,
      ...box,
    };
  });
  assignInlineFragmentBoxes(session, out.nodes, out.strokeImageRuns, (node, s, box) => {
    node.strokeImage = { image: s.webkitTextStrokeImage, ...box };
  });

  return { nodes: out.nodes, height: curY - y, lines: out.lines, lineBoxes: out.lineBoxes };
}

/** The final flow of `prepared` at `contentWidth`, inline-blocks laid out first. */
function flowInlineLines(
  session: LayoutSession,
  node: StyledNode,
  prepared: PreparedInline,
  contentWidth: number,
): PositionedLine[] {
  const m = session.measurer;
  const used = usedSegmentWidths(session, prepared, contentWidth);
  const textIndent = node.style.textIndent || 0;
  const tabMetrics = m.tabStops(node.style);
  // The block's strut: the minimum height of every line box.
  const strutLineHeight = m.lineHeight(node.style);
  const items = new FlowItems(prepared, used?.widths, used?.layouts);
  const lines: PositionedLine[] = flowLines(new LineFlow(
    session, items, contentWidth, node.style.whiteSpace, textIndent, false, tabMetrics, strutLineHeight,
  )).map((line) => ({
    words: line.items.map((i) => items.word(i)),
    totalWidth: line.totalWidth,
    lineHeight: line.lineHeight,
    endedByHardBreak: line.endedByHardBreak,
    spaceWrap: line.spaceWrap,
  }));
  if (session.stats) for (const line of lines) session.stats.wordObjects += line.words.length;
  // Content with no words can still make a line box (an empty inline with
  // inline-axis padding, an empty inline-block): it stands at the strut.
  if (lines.length === 0 && node.children.some(createsLineBox)) {
    lines.push({ words: [], totalWidth: 0, lineHeight: strutLineHeight });
  }
  return lines;
}

/**
 * The left edge of a line under physical `align`. A line overflowing its container falls
 * back to its start edge (CSS Text 3 §7.1), with sub-pixel tolerance; an RTL start is the
 * right edge, `x + lineMaxWidth` (which already excludes the indent).
 */
function alignedLineStart(
  out: InlineEmit, totalWidth: number, align: string, indent: number, lineMaxWidth: number,
): number {
  const { x, isRTL } = out;
  const overflows = totalWidth > lineMaxWidth + 0.5;
  let curX = x + indent;
  if (overflows) {
    // Overflow fallback: pin to the start edge (CSS Text 3 §7.1).
    curX = isRTL ? x + lineMaxWidth - totalWidth : x + indent;
  } else if (align === 'center') {
    curX = x + indent + (lineMaxWidth - totalWidth) / 2;
  } else if (align === 'right') {
    curX = (isRTL ? x + lineMaxWidth : x + indent + lineMaxWidth) - totalWidth;
  } else if (align === 'justify' && isRTL) {
    // RTL justify: anchor the right edge at the inset start; spaces expand left.
    curX = x + lineMaxWidth - totalWidth;
  }
  return curX;
}

/** Lay out one committed line at `y`: nodes, `LayoutLine` and line box. Returns its height. */
function emitLine(
  out: InlineEmit,
  line: PositionedLine,
  isFirstLine: boolean,
  isLastLine: boolean,
  wordLevels: Array<Uint8Array | null> | null | undefined,
  y: number,
): number {
  // Per-line alignment: lines ending at a forced break or the last line
  // use text-align-last; all others use text-align (CSS Text 3 §7.1, §7.2).
  const useLast = isLastLine || line.endedByHardBreak;
  const align = useLast ? out.textAlignLast : out.textAlign;

  const indent = isFirstLine ? out.textIndent : 0;
  const lineMaxWidth = out.contentWidth - indent;

  let justifyExtraPerSpace = 0;
  if (align === 'justify' && line.totalWidth < lineMaxWidth) {
    const spaceCount = line.words.filter(w => w.isSpace).length;
    if (spaceCount > 0) {
      justifyExtraPerSpace = (lineMaxWidth - line.totalWidth) / spaceCount;
    }
  }

  let curX = alignedLineStart(out, line.totalWidth, align, indent, lineMaxWidth);
  const lineLeftX = curX;

  if (line.words.length === 0) {
    out.lineBoxes.push({
      x: lineLeftX, y, width: 0, height: line.lineHeight,
      endedByHardBreak: !!line.endedByHardBreak,
    });
    return line.lineHeight;
  }

  const extent = lineBoxExtent(out, line.words);
  const lineBoxHeight = extent.ascent + extent.descent;
  const lineBaselineY = y + extent.ascent;

  // Bidi: level-uniform pieces in visual order, so both passes walk left to right.
  let emitWords = line.words;
  let emitLevels: number[] | null = null;
  let emitKeys: number[] | null = null;
  if (wordLevels) {
    ({ words: emitWords, levels: emitLevels, keys: emitKeys } = bidiLineItems(
      out.session.measurer, line.words, wordLevels, out.isRTL ? 1 : 0, justifyExtraPerSpace > 0));
    if (out.isRTL) {
      // An RTL line is anchored at its right edge; its pieces may measure differently.
      let total = 0;
      for (const w of emitWords) total += w.width + (w.isSpace ? justifyExtraPerSpace : 0);
      curX = curX + line.totalWidth - total;
    }
  }

  // Justified lines fill lineMaxWidth.
  const lineWidth =
    align === 'justify' && justifyExtraPerSpace > 0
      ? lineMaxWidth
      : line.totalWidth;
  const emittedLine: LayoutLine = {
    y: Math.round(lineBaselineY),
    // An inline-block contributes only its LAST row (earlier rows are lines of their own), and
    // nothing when it laid out no line.
    text: line.words.map((word) =>
      word.inlineBlockLayout?.lines.at(-1)?.text ?? (isAtomicInlineBlock(word) ? '' : word.text)).join(''),
    bounds: {
      x: lineLeftX,
      // The CSS line box; ink may overflow it, as in the DOM.
      y,
      width: lineWidth,
      height: lineBoxHeight,
    },
  };
  const lineBox: PrivateLineBox = { ...emittedLine.bounds, endedByHardBreak: !!line.endedByHardBreak };
  if (out.session.units) {
    lineBox[LINE_BASELINE] = lineBaselineY;
    if (line.spaceWrap) lineBox[SPACE_WRAP] = true;
  }
  emitInlineBackgrounds(out, emitWords, curX, lineBox, lineBaselineY, justifyExtraPerSpace);
  emitLineText(out, emitWords, emitLevels, emitKeys, curX, lineBox, lineBaselineY, justifyExtraPerSpace);
  out.lines.push(emittedLine);
  out.lineBoxes.push(lineBox);
  return lineBoxHeight;
}

/**
 * The line box's ascent and descent: the union of every box on it (strut, runs, shifted
 * runs, inline-blocks), each with its own leading: max(ascent - shift), max(descent + shift).
 */
function lineBoxExtent(out: InlineEmit, words: readonly Word[]): { ascent: number; descent: number } {
  const { session, blockStyle } = out;
  const m = session.measurer;
  const strutBox = m.leadedBox(blockStyle);
  let lineAscent = strutBox.ascent;
  let lineDescent = strutBox.descent;
  let previousRefs: Word['refs'] | undefined;
  for (const word of words) {
    if (word.text === '') continue;
    // Pieces of one run share its refs and its vertical extent; each atomic has refs of its own.
    if (word.refs === previousRefs) continue;
    previousRefs = word.refs;
    // A wrapper with no text of its own is still a box with its own line-height; its children
    // carry it as `parentStyle`. Added at its own shift, so it matches the box a direct-text
    // run of it brings. Positive shift is downward.
    if (word.refs.parentStyle) {
      const parentBox = m.leadedBox(word.refs.parentStyle);
      const va = word.refs.parentStyle.verticalAlign;
      const shift = isShiftedVAlign(va)
        ? verticalAlignShift(va, session, word.refs.parentStyle, blockStyle) : 0;
      if (parentBox.ascent - shift > lineAscent) lineAscent = parentBox.ascent - shift;
      if (parentBox.descent + shift > lineDescent) lineDescent = parentBox.descent + shift;
    }
    const own = m.leadedBox(word.refs.style);
    let ascent = own.ascent;
    let descent = own.descent;
    // An inline-block is an atomic box: its baseline with its margin box around it, unshifted,
    // as the emit pass ignores its vertical-align.
    const atomic = word.refs.boxStyle?.display === 'inline-block' ? word.refs.boxStyle : null;
    if (word.inlineBlockLayout) {
      const ib = word.inlineBlockLayout;
      ascent = ib.baselineOffset;
      descent = ib.marginBoxHeight - ib.baselineOffset;
    }
    const shift = atomic ? 0 : wordBaselineShift(out, word);
    if (ascent - shift > lineAscent) lineAscent = ascent - shift;
    if (descent + shift > lineDescent) lineDescent = descent + shift;
  }
  return { ascent: lineAscent, descent: lineDescent };
}

/** `word`'s vertical-align shift off the line's baseline (0 unless it shifts). */
function wordBaselineShift(out: InlineEmit, word: Word): number {
  const va = word.refs.style.verticalAlign;
  return isShiftedVAlign(va)
    ? verticalAlignShift(va, out.session, word.refs.style, word.refs.parentStyle ?? out.blockStyle)
    : 0;
}

/** Emit an inline background box hanging off the line's baseline. */
function emitInlineBox(
  out: InlineEmit, style: ResolvedStyle, bx: number, bw: number, lineBaselineY: number, textWord: Word,
): void {
  // Height from the inline box's OWN font; atomics use their inner layout instead.
  const { ascent: boxAscent, descent: boxDescent } = out.session.measurer.metrics(style);
  const padTop = style.paddingTop + style.borderTopWidth;
  const padBottom = style.paddingBottom + style.borderBottomWidth;
  const boxHeight = boxAscent + boxDescent + padTop + padBottom;
  // The box hangs off the line's baseline; a shifted band's glyphs move by the same amount.
  const baselineY = lineBaselineY + wordBaselineShift(out, textWord);
  const boxY = baselineY - boxAscent - padTop;
  out.nodes.push({
    type: 'box', style, x: bx, y: boxY, width: bw, height: boxHeight,
    tagName: 'span', children: [],
  });
}

/**
 * The line's inline background boxes from `startX`: one per run of words sharing a box
 * style (when it holds text), one per atomic inline-block.
 */
function emitInlineBackgrounds(
  out: InlineEmit, words: readonly Word[], startX: number, line: LayoutLineBox, lineBaselineY: number,
  justifyExtraPerSpace: number,
): void {
  let scanX = startX;
  let boxStartX = scanX;
  let currentBoxStyle: ResolvedStyle | undefined;
  // The open box group's first text word: decides whether its band is emitted and where.
  let boxTextWord: Word | undefined;

  for (const word of words) {
    if (isAtomicInlineBlock(word)) {
      if (currentBoxStyle) {
        if (boxTextWord) emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
        currentBoxStyle = undefined;
        boxTextWord = undefined;
      }
      const s = word.refs.style;
      const boxX = scanX + s.marginLeft;
      // Every nonempty atomic receives an inner layout in `usedSegmentWidths`.
      const ib = word.inlineBlockLayout!;
      const boxY = lineBaselineY - ib.baselineOffset + s.marginTop;
      const box: LayoutBox = {
        type: 'box', style: s, x: boxX,
        y: boxY,
        width: s.borderLeftWidth + s.paddingLeft + ib.contentWidth +
          s.paddingRight + s.borderRightWidth,
        height: s.borderTopWidth + s.paddingTop + ib.contentHeight +
          s.paddingBottom + s.borderBottomWidth,
        tagName: 'span', children: [],
        lineBoxes: ib.lineBoxes.map(inner => ({
          ...inner,
          x: inner.x + boxX + s.borderLeftWidth + s.paddingLeft,
          y: inner.y + boxY + s.borderTopWidth + s.paddingTop,
        })),
      };
      out.nodes.push(box);
      if (out.session.units) {
        // An enclosing inline-block's emit overwrites this: the outermost box owns the content.
        const owner = { box, line };
        for (const node of ib.nodes) if (node.type === 'text') (node as PrivateText)[INLINE_BLOCK] = owner;
      }
      boxTextWord = undefined;
      scanX += word.width;
      continue;
    }

    if (word.refs.boxStyle !== currentBoxStyle) {
      if (currentBoxStyle && boxTextWord) {
        emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
      }
      currentBoxStyle = word.refs.boxStyle;
      boxStartX = scanX;
      boxTextWord = undefined;
    }
    if (word.text && !word.isSpace) boxTextWord ??= word;
    scanX += word.width + (word.isSpace ? justifyExtraPerSpace : 0);
  }
  if (currentBoxStyle && boxTextWord) {
    emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
  }
}

/** Record a text node's stamps and paint declarers for the passes after layout. */
function registerTextNode(out: InlineEmit, node: PrivateText, word: Word, line: LayoutLineBox, reversed: boolean): void {
  out.nodes.push(node);
  node[LINE_TOP] = line.y;
  if (word.runSeam) node[RUN_SEAM] = true;
  if (out.session.units) {
    node[LINE_BOX] = line;
    if (word.levels) node[RUN_LEVELS] = word.levels;
    if (word.ellipsis) node[CLAMP_ELLIPSIS] = true;
    if (reversed) node[RUN_REVERSED] = true;
  }
  if (word.refs.clipStyle) out.clipRuns.set(node, word.refs.clipStyle);
  if (word.refs.strokeImageStyle) out.strokeImageRuns.set(node, word.refs.strokeImageStyle);
}

/**
 * The line's text nodes, left to right from `startX`; a bidi line's are put back in
 * logical order (`keys`), the document order consumers expect.
 */
function emitLineText(
  out: InlineEmit,
  words: readonly Word[],
  levels: number[] | null,
  keys: number[] | null,
  startX: number,
  line: LayoutLineBox,
  lineBaselineY: number,
  justifyExtraPerSpace: number,
): void {
  const results = out.nodes;
  let curX = startX;
  const textStart = results.length;
  const nodeKeys: number[] = [];
  const keyNodes = (key: number) => {
    while (textStart + nodeKeys.length < results.length) nodeKeys.push(key);
  };
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    if (keys && wordIndex > 0) keyNodes(keys[wordIndex - 1]);
    const word = words[wordIndex];
    if (word.text === '') {
      curX += word.width;
      continue;
    }

    // Atomic inline-block: position text inside the box (after margin + padding)
    if (isAtomicInlineBlock(word)) {
      const s = word.refs.style;
      const textX = curX + s.marginLeft + s.borderLeftWidth + s.paddingLeft;
      const ib = word.inlineBlockLayout!;
      const contentY = lineBaselineY - ib.baselineOffset + s.marginTop +
        s.borderTopWidth + s.paddingTop;
      emitInlineBlockContent(out, ib, textX, contentY);
      curX += word.width;
      continue;
    }

    const baselineY = lineBaselineY + wordBaselineShift(out, word);
    const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);
    // A bidi piece paints in its level's direction; an RTL one is anchored
    // at its right edge (`PaintState.text` sets textAlign). Canvas would order an RTL
    // override's letters by their own direction: it paints them reversed, left to right.
    const rtl = levels !== null && levels[wordIndex] % 2 === 1;
    const reversed = rtl && overridesRtl(word.refs.bidi);
    const rtlPiece = rtl && !reversed;

    const node: PrivateText = {
      type: 'text',
      text: reversed ? overriddenText(word.text, word.refs.bidi) : word.text,
      x: rtlPiece ? curX + effectiveWidth : curX,
      y: baselineY,
      width: effectiveWidth,
      // Paint direction is the bidi LEVEL's, never the CSS `direction` (unicode-bidi: normal
      // reorders nothing).
      style: withDirection(out.session, word.refs.style, rtlPiece ? 'rtl' : 'ltr'),
    };
    // Only when vertical-align moved this run off the line — an
    // underline from an unshifted declarer still hangs off the line.
    if (baselineY !== lineBaselineY) node.lineBaselineY = lineBaselineY;
    registerTextNode(out, node, word, line, reversed);

    curX += effectiveWidth;
  }
  if (keys && words.length > 0) {
    keyNodes(keys[words.length - 1]);
    const placed = results.splice(textStart).map((node, i) => ({ node, key: nodeKeys[i] }));
    placed.sort((a, b) => a.key - b.key); // stable: an inline-block keeps its inner order
    for (const { node } of placed) results.push(node);
  }
}

/** Move a laid-out inline node — and everything it carries — by (dx, dy). */
function translateInlineNode(layoutNode: LayoutNode, dx: number, dy: number): void {
  layoutNode.x += dx;
  layoutNode.y += dy;
  if (layoutNode.type === 'text') {
    if (layoutNode.lineBaselineY !== undefined) layoutNode.lineBaselineY += dy;
    const lineTop = (layoutNode as PrivateText)[LINE_TOP];
    if (lineTop !== undefined) (layoutNode as PrivateText)[LINE_TOP] = lineTop + dy;
    if (layoutNode.clip) {
      layoutNode.clip.x += dx;
      layoutNode.clip.y += dy;
    }
    if (layoutNode.strokeImage) {
      layoutNode.strokeImage.x += dx;
      layoutNode.strokeImage.y += dy;
    }
  } else {
    for (const line of layoutNode.lineBoxes ?? []) {
      line.x += dx;
      line.y += dy;
    }
    for (const child of layoutNode.children) translateInlineNode(child, dx, dy);
  }
}

/** An inline-block's layout at (textX, contentY); rows before the last become lines. */
function emitInlineBlockContent(out: InlineEmit, ib: InlineBlockLayout, textX: number, contentY: number): void {
  for (const innerNode of ib.nodes) {
    translateInlineNode(innerNode, textX, contentY);
    out.nodes.push(innerNode);
  }
  for (const innerLine of ib.lines.slice(0, -1)) {
    out.lines.push({
      y: Math.round(innerLine.y + contentY),
      text: innerLine.text,
      bounds: {
        x: innerLine.bounds.x + textX,
        y: innerLine.bounds.y + contentY,
        width: innerLine.bounds.width,
        height: innerLine.bounds.height,
      },
    });
  }
}

/**
 * Give each run under an inline paint declarer (background-clip:text, stroke image) a
 * paint box spanning the declarer's fragment on its line. A wrap starts a new fragment
 * (box-decoration-break: clone; Chrome's default `slice` would continue it).
 */
function assignInlineFragmentBoxes(
  session: LayoutSession,
  results: LayoutNode[],
  runs: Map<LayoutText, ResolvedStyle>,
  assign: (
    node: LayoutText,
    declarer: ResolvedStyle,
    box: { x: number; y: number; width: number; height: number },
  ) => void,
): void {
  if (runs.size === 0) return;
  for (let i = 0; i < results.length;) {
    const first = results[i];
    const declarer = first.type === 'text' ? runs.get(first) : undefined;
    if (!declarer) { i++; continue; }
    let j = i;
    let left = Infinity, right = -Infinity;
    while (j < results.length) {
      const n = results[j];
      if (n.type !== 'text' || runs.get(n) !== declarer || n.y !== first.y) break;
      const [l, r] = textEdges(n);
      if (l < left) left = l;
      if (r > right) right = r;
      j++;
    }
    const { ascent, descent } = session.measurer.metrics(declarer);
    const box = {
      x: left,
      y: first.y - ascent,
      width: right - left,
      height: ascent + descent,
    };
    for (let k = i; k < j; k++) assign(results[k] as LayoutText, declarer, box);
    i = j;
  }
}
