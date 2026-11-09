// The one line breaker: min-content at 0, max-content at Infinity, layout at the used width.
// A flow never writes to the prepared content; what it cuts is a piece in its own `FlowItems`.
import type { ResolvedStyle } from '../types.js';
import { overridesRtl } from '../bidi.js';
import { hasBackgroundImage, hasVisibleBoxStyles, layoutUnit, physicalAlign, preservesSpaces, wrapsPreservedSpaces } from './util.js';
import { type LayoutSession, type Measurer, type MeasureState, type TabStops } from './session.js';
import {
  forEachHyphenPiece, graphemes, isAtomicInlineBlock, isBoxEdge, isCJKCode, isEmojiCluster, isSimpleScript, MEASURE_CONTEXT,
  SEG_CJK, SEG_CLOSING_PUNCT, SEG_EMOJI, SEG_HARD_BREAK, SEG_INHERITED, SEG_NO_BREAK_BEFORE, SEG_OPENING_PUNCT,
  SEG_RUN_SEAM, SEG_SHAPED_APART, SEG_SOFT_HYPHEN, SEG_SPACE, SEG_TAB, segmentAdvance, textFlags, wordSpacingIn,
  type InlineBlockLayout, type PositionedLine, type PreparedInline, type SegmentRefs, type Word,
} from './segment.js';

/** How far over the grid budget a line still fits: one LayoutUnit, inclusive (120.015625px
 * fits 120px), as Blink's line breaker does. */
const LINE_FIT_TOLERANCE = 1 / 64;

/**
 * An inline box's opening edge (padding, border, margin) right before collapsible white space
 * stays with the word before it, so the word wraps once word + edge overflow, while at most
 * this many closing tags come between them: Chrome 151-156, `aaa bb <span>homaj</span><b
 * style="padding-left:6px"> rajtoj</b>` (Chrome 145 kept it with none; Gecko always; WebKit
 * never). Before preserved white space (`pre-wrap`) it stays at any depth. break-rules-parity.
 */
const EDGE_BEFORE_SPACE_MAX_CLOSES = 1;

/**
 * `-webkit-line-clamp` cut-off: trim trailing spaces and text (atomic inline-blocks
 * included) until "…" fits, then append it in the last text word's style and box.
 */
function applyEllipsisToLine(
  session: LayoutSession,
  line: PositionedLine,
  maxWidth: number,
): void {
  const words = line.words;
  let styleIdx = words.length - 1;
  while (styleIdx >= 0 && (words[styleIdx].text === '' || isAtomicInlineBlock(words[styleIdx]))) styleIdx--;
  if (styleIdx < 0) return;
  const { style, parentStyle, boxStyle } = words[styleIdx].refs;
  const m = session.measurer;
  const width = m.width(m.stateOf(style), '…');
  const pop = () => { line.totalWidth -= words.pop()!.width; };
  const popSpaces = () => { while (words.length && words[words.length - 1].isSpace) pop(); };
  popSpaces();
  // Only text runs and atomic inline-blocks carry text; box-edge markers are ''.
  while (line.totalWidth + width > maxWidth && words.length && words[words.length - 1].text) {
    pop();
    popSpaces();
  }
  words.push({ text: '…', width, refs: { style, parentStyle, boxStyle }, isSpace: false, ellipsis: true });
  if (session.stats) session.stats.wordObjects++;
  line.totalWidth += width;
}

// ── Line flow ──

/**
 * What one flow places on lines, by index: the prepared segments, then the pieces this
 * flow cuts from them. A flow never writes to the prepared arrays.
 */
export class FlowItems {
  private readonly base: number;
  private readonly pieceText: string[] = [];
  private readonly pieceWidth: number[] = [];
  private readonly pieceFlags: number[] = [];
  private readonly pieceRefs: SegmentRefs[] = [];
  /** The character each piece was measured after (`cut`'s `context`), '' when alone. */
  private readonly pieceContext: string[] = [];
  private textOnlyRefs: Map<SegmentRefs, SegmentRefs> | undefined;

  /**
   * `widths` stands in for the prepared widths when a pass sizes inline-blocks or
   * percentage padding (`usedSegmentWidths`).
   */
  constructor(
    readonly prepared: PreparedInline,
    private readonly widths: readonly number[] = prepared.width,
    private readonly inlineBlocks?: ReadonlyMap<number, InlineBlockLayout>,
  ) {
    this.base = prepared.count;
  }

  text(i: number): string {
    return i < this.base ? this.prepared.text[i] : this.pieceText[i - this.base];
  }

  /** Item `i`'s text for debug entries: an atomic inline reads as its content, not U+FFFC. */
  debugText(i: number): string {
    const inlineBlock = this.refs(i).inlineBlock;
    return inlineBlock ? inlineBlock.element?.textContent ?? '' : this.text(i);
  }

  width(i: number): number {
    return i < this.base ? this.widths[i] : this.pieceWidth[i - this.base];
  }

  flags(i: number): number {
    return i < this.base ? this.prepared.flags[i] : this.pieceFlags[i - this.base];
  }

  refs(i: number): SegmentRefs {
    return i < this.base ? this.prepared.refs[this.prepared.ref[i]] : this.pieceRefs[i - this.base];
  }

  inlineBlockLayout(i: number): InlineBlockLayout | undefined {
    return this.inlineBlocks?.get(i);
  }

  /**
   * A text split or tab advance: atomics stay whole, at their prepared index. `context`: the
   * character the piece was measured after (`kernBefore`).
   */
  cut(from: number, text: string, width: number, context = ''): number {
    return this.add(text, width, this.flags(from) & SEG_INHERITED, this.refs(from), context);
  }

  /**
   * New text continuing item `from`'s run but not its box (a soft hyphen's '-', a glued
   * chain fragment): style and declarers, never box edges.
   */
  textOf(from: SegmentRefs, text: string, width: number): number {
    this.textOnlyRefs ??= new Map();
    let refs = this.textOnlyRefs.get(from);
    if (!refs) {
      refs = {
        style: from.style,
        parentStyle: from.parentStyle,
        clipStyle: from.clipStyle,
        strokeImageStyle: from.strokeImageStyle,
        bidi: from.bidi,
      };
      this.textOnlyRefs.set(from, refs);
    }
    return this.add(text, width, 0, refs, '');
  }

  /**
   * The last character of the text prepared segment `i` is shaped after: '' where shaping
   * restarts at it (`SEG_SHAPED_APART`), at a tab, and under a bidi override.
   */
  contextBefore(i: number): string {
    if (i <= 0 || (this.flags(i) & (SEG_SHAPED_APART | SEG_TAB))) return '';
    const before = this.text(i - 1);
    if (!before || this.refs(i).inlineBlock || overridesRtl(this.refs(i).bidi) || overridesRtl(this.refs(i - 1).bidi)) return '';
    return before[before.length - 1];
  }

  /**
   * The kern item `i`'s width carries from the glyph before it, which every DOM books on that
   * glyph instead: the pair's kern, for simple scripts, whose kerning is pairwise.
   */
  private kernBefore(i: number, m: Measurer): number {
    const text = this.text(i);
    const before = i < this.base ? this.contextBefore(i) : this.pieceContext[i - this.base];
    if (!before || !text || !isSimpleScript(before + text[0])) return 0;
    const state = m.stateOf(this.refs(i).style);
    return m.width(state, before + text[0]) - m.width(state, before) - m.width(state, text[0]);
  }

  /** Item `i` as the emit pass reads it. */
  word(i: number, m: Measurer): Word {
    const flags = this.flags(i);
    return {
      text: this.text(i),
      width: this.width(i),
      refs: this.refs(i),
      isSpace: (flags & SEG_SPACE) !== 0,
      isTab: (flags & SEG_TAB) !== 0,
      inlineBlockLayout: this.inlineBlockLayout(i),
      runSeam: (flags & SEG_RUN_SEAM) !== 0 ? true : undefined,
      kernBefore: this.kernBefore(i, m) || undefined,
    };
  }

  private add(text: string, width: number, flags: number, refs: SegmentRefs, context: string): number {
    this.pieceText.push(text);
    this.pieceWidth.push(width);
    this.pieceFlags.push(flags | textFlags(text));
    this.pieceRefs.push(refs);
    this.pieceContext.push(context);
    return this.base + this.pieceText.length - 1;
  }
}

/** A line one flow committed: its items (`FlowItems` indices) in order. */
interface FlowLine {
  items: number[];
  totalWidth: number;
  lineHeight: number;
  /** True at a forced break (preserved \n or <br>); uses text-align-last. */
  endedByHardBreak?: boolean;
  /** Its soft wrap consumed white space (`SPACE_WRAP`). */
  spaceWrap?: true;
}

/**
 * The one measuring state every glyph on these items shares, so the line can be
 * re-measured as one string; `'mixed'` otherwise, `null` with no glyph. Spaces do not count.
 */
function lineMeasureState(
  m: Measurer, items: FlowItems, line: readonly number[], next: number,
): MeasureState | null | 'mixed' {
  let shared: MeasureState | null = null;
  for (let k = 0; k <= line.length; k++) {
    const i = k < line.length ? line[k] : next;
    // An inline-block is a box, not glyphs in any state.
    if (!items.text(i) || (items.flags(i) & SEG_SPACE) || items.refs(i).inlineBlock) continue;
    const state = m.stateOf(items.refs(i).style);
    if (shared && state !== shared) return 'mixed';
    shared = state;
  }
  return shared;
}

/**
 * Break segment `index` into character pieces if it holds CJK/emoji, under `break-all` when it
 * does not fit the rest of the line, or if break-word applies and it is too wide; `null` when
 * it stays whole. `wrapFirst`: a break-word last
 * resort takes the whitespace opportunity first, as native layout does (the caller wraps).
 * Measures only: a lookahead calls it too, with the `lineOffset` the line will have reached.
 */
function splitSegment(
  flow: LineFlow, index: number, lineOffset = flow.line.totalWidth,
): { texts: string[]; widths: number[]; contexts: string[]; wrapFirst: boolean } | null {
  const { items, m } = flow;
  const contentWidth = flow.budget();
  const flags = items.flags(index);
  const refs = items.refs(index);
  const style = refs.style;
  const hasCJK = (flags & SEG_CJK) !== 0;
  const hasEmoji = (flags & SEG_EMOJI) !== 0;

  const breaking = flow.wordBreaking(style);
  // `break-all`: every grapheme boundary is an ordinary opportunity, so the word fills the
  // current line before it breaks (Chrome), whether or not it fits a line of its own.
  const anywhere = breaking === 'anywhere';
  const needsBreak = breaking !== 'none' && items.width(index) + flow.endKern(index + 1) > contentWidth;

  if (!hasCJK && !hasEmoji && !needsBreak && !anywhere) return null;
  // A break-all word that fits the rest of the line with what glues after it breaks nowhere
  // inside: placing it whole is the same layout without measuring every grapheme.
  if (anywhere && !hasCJK && !hasEmoji &&
      flow.line.totalWidth + items.width(index) + flow.gluedTail(index) + flow.tailKern(index) <= contentWidth) return null;

  // CJK/emoji are ordinary opportunities, like `break-all`; ordinary splits fill the line. A
  // break-word last resort on a line with no opportunity (an opening edge, collapsible spaces)
  // shares it.
  const emergency = needsBreak && !hasCJK && !hasEmoji && breaking === 'last-resort';
  const wrapFirst = emergency && flow.canWrapBefore(index);
  let room = emergency && !wrapFirst ? contentWidth - lineOffset : contentWidth;

  // Each character is measured after its left context (`MEASURE_CONTEXT`); positions below
  // are in the context's coordinates, so a restart shifts them together.
  const state = m.stateOf(style);
  const text = items.text(index);
  // By grapheme when emoji are present or every boundary breaks, so clusters never split.
  const chars = hasEmoji || anywhere ? graphemes(text) : [...text];
  const texts: string[] = [];
  const widths: number[] = [];
  const contexts: string[] = [];
  const piece = (t: string, w: number, context: string) => {
    texts.push(t);
    widths.push(w);
    contexts.push(context);
  };

  let current = '';
  let currentWidth = 0;
  let currentContext = '';
  // Mid-line, after the text before it, as `measureAfter` measured the segment: the first piece
  // keeps the kern into it (`FlowItems.kernBefore`). At a line start, alone (`startWidth`).
  let measuredText = flow.line.items.length > 0 && !wrapFirst ? items.contextBefore(index) : '';
  let measuredWidth = measuredText ? segmentAdvance(m, state, measuredText, refs) : 0;
  let currentStartWidth = measuredWidth;
  let previous = '';

  for (const char of chars) {
    if (measuredText.length > MEASURE_CONTEXT && previous) {
      const restart = segmentAdvance(m, state, previous, refs);
      currentStartWidth -= measuredWidth - restart;
      measuredText = previous;
      measuredWidth = restart;
    }
    previous = char;
    const nextMeasuredText = measuredText + char;
    const nextMeasuredWidth = segmentAdvance(m, state, nextMeasuredText, refs);
    const charWidth = nextMeasuredWidth - measuredWidth;

    // Each emoji cluster and CJK character is a piece of its own: a break opportunity.
    if ((hasEmoji && isEmojiCluster(char)) || isCJKCode(char.codePointAt(0)!)) {
      if (current) {
        piece(current, currentWidth, currentContext);
        current = '';
        currentWidth = 0;
      }
      piece(char, charWidth, measuredText.slice(-1));
      currentStartWidth = nextMeasuredWidth;
      measuredText = nextMeasuredText;
      measuredWidth = nextMeasuredWidth;
      continue;
    }

    const candidateText = current + char;
    const candidateWidth = nextMeasuredWidth - currentStartWidth;

    if (current && needsBreak && candidateWidth > room) {
      // The next line starts here: Chrome shapes it alone (`LineFlow.startWidth`).
      piece(current, currentWidth, currentContext);
      room = contentWidth;
      current = char;
      currentContext = '';
      currentWidth = segmentAdvance(m, state, char, refs);
      currentStartWidth = 0;
      measuredText = char;
      measuredWidth = currentWidth;
      continue;
    }
    if (current && anywhere && breakAllAllows(current.slice(-1), char)) {
      piece(current, currentWidth, currentContext);
      currentContext = measuredText.slice(-1);
      current = char;
      currentWidth = charWidth;
      currentStartWidth = measuredWidth;
      measuredText = nextMeasuredText;
      measuredWidth = nextMeasuredWidth;
      continue;
    }

    if (!current) currentContext = measuredText.slice(-1);
    current = candidateText;
    currentWidth = candidateWidth;
    measuredText = nextMeasuredText;
    measuredWidth = nextMeasuredWidth;
  }

  if (current) piece(current, currentWidth, currentContext);

  return { texts, widths, contexts, wrapFirst };
}

/**
 * `break-all` keeps these with the character before (UAX #14: closers, infix and
 * exclamation punctuation, `/`, postfix `%`, U+2010 hyphen, figure and en dash) and after
 * (openers, opening quotes, apostrophes, currency prefixes), as Chrome does: `s://`, `(p`,
 * `n–`, `$1`, `n't` stay whole.
 */
const BREAK_ALL_GLUE_BEFORE = /^[)\]}»›”’,.:;!?\/%‰°‐‒–…'"]$/;
const BREAK_ALL_GLUE_AFTER = /^[(\[{«‹“‘"'’$€£¥₹]$/;

/** Whether `break-all` allows a break between characters `before` and `after`. */
function breakAllAllows(before: string, after: string): boolean {
  return !BREAK_ALL_GLUE_BEFORE.test(after) && !BREAK_ALL_GLUE_AFTER.test(before);
}

/**
 * What the boundary BEFORE a flow item allows; every breaking decision reads it.
 * - `'space'`: white space or a forced break.
 * - `'continues'`: a word continuing across a run boundary (`SEG_NO_BREAK_BEFORE`), and an
 *   opening edge into one.
 * - `'glued'`: closing punctuation (`TRAILING_PUNCT`), an inline box's closing edge, an opening
 *   edge before white space (`openingEdgeBreak`), a word's first `break-spaces` space.
 * - `'allowed'`: an ordinary break opportunity.
 * `splitPiece`: a piece after the first of a split segment. The split is the opportunity,
 * so run-boundary glue stays on the first piece; a closer still glues.
 */
type BreakBefore = 'space' | 'continues' | 'glued' | 'allowed';

function breakBefore(items: FlowItems, i: number, splitPiece = false): BreakBefore {
  const flags = items.flags(i);
  if ((flags & SEG_SPACE) && firstBreakSpace(items, i)) return 'glued';
  if (flags & (SEG_SPACE | SEG_HARD_BREAK)) return 'space';
  const text = items.text(i);
  if (text && !splitPiece && (flags & SEG_NO_BREAK_BEFORE)) return 'continues';
  if (flags & SEG_CLOSING_PUNCT) return 'glued';
  if (!text && items.refs(i).boxClose) return 'glued';
  if (!text && items.refs(i).boxOpen) return openingEdgeBreak(items, i);
  return 'allowed';
}

/**
 * A word's first white space under `break-spaces`: the opportunity is after it and it takes
 * room, so it wraps with the word (Chrome keeps "bbb" on a line only once "bbb " fits).
 */
function firstBreakSpace(items: FlowItems, i: number): boolean {
  if (items.refs(i).style.whiteSpace !== 'break-spaces') return false;
  let before = i - 1;
  while (before >= 0 && isBoxEdge(items.text(before), items.refs(before))) before--;
  return before >= 0 && (items.flags(before) & (SEG_SPACE | SEG_HARD_BREAK)) === 0;
}

/**
 * An opening edge has no opportunity of its own: it takes the one of the content it opens
 * onto (every engine keeps `luya<span style="padding:3px">lu` whole). Before white space,
 * whose opportunity is after it (UAX #14 LB7), the engine decides whether the edge stays
 * with what precedes it (`EDGE_BEFORE_SPACE_MAX_CLOSES`).
 */
function openingEdgeBreak(items: FlowItems, i: number): BreakBefore {
  const count = items.prepared.count;
  let next = i + 1;
  while (next < count && !items.text(next) && items.refs(next).boxOpen) next++;
  if (next >= count) return 'allowed';
  const cls = breakBefore(items, next);
  if (cls !== 'space') return cls;
  const maxCloses = preservesSpaces(items.refs(next).style.whiteSpace) ? Infinity : EDGE_BEFORE_SPACE_MAX_CLOSES;
  return (items.refs(i).closesBefore ?? 0) <= maxCloses ? 'glued' : 'allowed';
}

/** No line may start at an item of this class. */
function cannotStartLine(cls: BreakBefore): boolean {
  return cls === 'continues' || cls === 'glued';
}

/**
 * A line can end after item `i` (Blink `can_break_after`): text, an atomic inline (an empty
 * one is only an opening edge), or white space whose own white-space wraps. Box edges and
 * collapsible or `pre` spaces cannot: `<span pad> word` shares its line.
 */
function offersLineEnd(items: FlowItems, i: number): boolean {
  if (items.flags(i) & (SEG_SPACE | SEG_TAB)) return wrapsPreservedSpaces(items.refs(i).style.whiteSpace);
  return items.text(i) !== '' || items.refs(i).inlineBlock !== undefined;
}

// ── Glue: what must share a line ──

/**
 * Width of what follows segment `from` that cannot start a line (`breakBefore`): closing
 * punctuation, a closing box edge, a word continued across runs. It wraps with the word
 * before it ("Music Experie" + "nce" wraps whole).
 */
function gluedRunWidth(flow: LineFlow, from: number, end = gluedRunEnd(flow, from)): number {
  let total = 0;
  for (let index = from; index < end; index++) total += flow.items.width(index);
  return total;
}

/** Where the glued run starting at segment `from` (`gluedRunWidth`) ends: the next segment a line may start at. */
function gluedRunEnd(flow: LineFlow, from: number): number {
  const { items, session } = flow;
  const count = items.prepared.count;
  let index = from;
  while (index < count && cannotStartLine(breakBefore(items, index))) index++;
  if (session.stats) session.stats.glueSteps += index - from;
  return index;
}

/**
 * The glued width riding on split piece `piece`: a closing-punctuation piece belongs to the
 * character before it (`…습니다.` wraps as `다.`). The segment's own tail rides on its last.
 */
function trailingGlueWidth(items: FlowItems, piece: number, pieceEnd: number, gluedTailWidth: number): number {
  let tail = piece === pieceEnd - 1 ? gluedTailWidth : 0;
  for (let trailing = piece + 1; trailing < pieceEnd; trailing++) {
    if (breakBefore(items, trailing, true) !== 'glued') break;
    tail += items.width(trailing);
    if (trailing === pieceEnd - 1) tail += gluedTailWidth;
  }
  return tail;
}

/**
 * The width after piece `piece` that must share its line because no line may END there:
 * opening punctuation and an inline box's opening edge (padding-left goes with the content).
 */
function headGlueWidth(
  flow: LineFlow, segment: number, piece: number, isLastPiece: boolean, gluedTailWidth: number,
): number {
  const items = flow.items;
  const count = items.prepared.count;
  let headExtra = 0;
  const isOpener = (items.flags(piece) & SEG_OPENING_PUNCT) !== 0;
  if (isOpener && !isLastPiece) {
    // A CJK opener split mid-word glues to its next piece: Chrome never ends a line with
    // 「 or （ (measured).
    headExtra = items.width(piece + 1);
  } else if ((!items.text(piece) && items.refs(piece).boxOpen) ||
      (isOpener && gluedTailWidth === 0)) {
    let nextIndex = segment + 1;
    // An opener may be followed by box edges before its first glyph: `(<span>word</span>)`.
    while (nextIndex < count && !items.text(nextIndex) && items.refs(nextIndex).boxOpen) {
      headExtra += items.width(nextIndex);
      nextIndex++;
    }
    const nextText = nextIndex < count ? items.text(nextIndex) : '';
    if (nextText && !flow.isSpace(nextIndex)) {
      // Only the next segment's first BREAKABLE unit stays with the padding: the whole word, or
      // one character for CJK / break-word.
      const split = nextText.length > 1
        ? splitSegment(flow, nextIndex, flow.line.totalWidth + items.width(piece) + headExtra) : null;
      headExtra += split ? split.widths[0] : items.width(nextIndex);
      if (!split || split.texts.length === 1) {
        // Plus the word's own tail: `(<span>p50</span>,` never breaks inside word, edge and comma.
        headExtra += gluedRunWidth(flow, nextIndex + 1);
      }
    }
  }
  return headExtra;
}

// ── The line breaker ──

/** One flow's line state: the committed lines and the one being filled. */
export class LineFlow {
  readonly lines: FlowLine[] = [];
  line: FlowLine;
  /** At the start of content, or right after a forced break. */
  afterHardBreak = true;
  readonly m: Measurer;
  /** No soft wrapping at all: everything up to a forced break is one line. */
  readonly noWrap: boolean;
  private readonly keepsSpaceOnlyLines: boolean;
  /** The segment `gluedTail` last read, its width and the `endKern` after it. */
  private tailOf = -1;
  private tailWidth = 0;
  private tailEndKern = 0;
  /** Whether a soft-wrapped line's trailing space shows (`endKern`); undefined for intrinsic sizing. */
  private readonly blockShowsTrailingSpace: boolean | undefined;

  constructor(
    readonly session: LayoutSession,
    readonly items: FlowItems,
    readonly contentWidth: number,
    private readonly whiteSpace: string,
    private readonly textIndent: number,
    private readonly minContent: boolean,
    private readonly tabMetrics?: TabStops,
    private readonly strutLineHeight = 0,
    /** Laying lines out at the used width: the block, whose alignment and own paint decide
     * whether a soft-wrapped line's trailing space shows (`endKern`). Unset for intrinsic sizing. */
    block?: ResolvedStyle,
  ) {
    this.m = session.measurer;
    this.line = this.newLine();
    this.noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
    this.keepsSpaceOnlyLines = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';
    if (block) {
      const isRTL = block.direction === 'rtl';
      this.blockShowsTrailingSpace = physicalAlign(block.textAlign, isRTL) !== physicalAlign('start', isRTL) ||
        hasVisibleBoxStyles(block) || hasBackgroundImage(block);
    }
  }

  /** A line starts at the block's strut height: never shorter than its line-height. */
  private newLine(): FlowLine {
    return { items: [], totalWidth: 0, lineHeight: this.strutLineHeight };
  }

  /** Where the current line starts: text-indent offsets the first line only. */
  private lineStart(): number {
    return this.lines.length === 0 ? this.textIndent : 0;
  }

  /**
   * The width the current line may fill: content width and indent on the engine's layout
   * grid, plus `LINE_FIT_TOLERANCE`. The content width is snapped as one length; Blink snaps
   * width and padding separately, which can differ by a unit for a fractional frame.
   */
  budget(): number {
    return layoutUnit(this.contentWidth) - layoutUnit(this.lineStart()) + LINE_FIT_TOLERANCE;
  }

  /**
   * How a too-wide word may break: `anywhere` (`word-break: break-all`, an ordinary
   * opportunity), `last-resort` (`overflow-wrap: break-word`, which CSS ignores for
   * min-content; `overflow-wrap: anywhere` and its alias `word-break: break-word`, which
   * count for it) or `none`.
   */
  wordBreaking(style: ResolvedStyle): 'none' | 'anywhere' | 'last-resort' {
    if (style.wordBreak === 'break-all') return 'anywhere';
    if (style.overflowWrap === 'anywhere' || style.wordBreak === 'break-word') return 'last-resort';
    return !this.minContent && style.overflowWrap === 'break-word' ? 'last-resort' : 'none';
  }

  /**
   * `gluedRunWidth` after `segment`, read once per segment and only on demand: continuation
   * pieces never ask, and reading the rest of the chain for each of them is quadratic.
   */
  gluedTail(segment: number): number {
    this.readTail(segment);
    return this.tailWidth;
  }

  /** The `endKern` a line ending with `segment` and its glued tail keeps. */
  tailKern(segment: number): number {
    this.readTail(segment);
    return this.tailEndKern;
  }

  private readTail(segment: number): void {
    if (this.tailOf === segment) return;
    this.tailOf = segment;
    const end = gluedRunEnd(this, segment + 1);
    this.tailWidth = gluedRunWidth(this, segment + 1, end);
    this.tailEndKern = this.endKern(end);
  }

  /**
   * What a line ending right before item `i` keeps of it: a hanging space's kern into the
   * glyph before it, which `measureAfter` books on the space. Chrome fits and aligns a line on
   * its last glyph's advance kerned against that space, under every white-space (Playfair
   * "y " -1.04px at 40px; PT Sans ", " -0.078em), unless the space would show: then it lays
   * the line out without it, the glyph before unkerned. It shows on a line that is not
   * start-aligned, under a text decoration, inline background or inline border, and in a
   * block with its own border (transparent too), background or box-shadow; colour,
   * text-shadow, letter-spacing, the block's padding, outline or text-indent and an
   * ancestor's border or background keep it hidden. Min-content keeps the kern everywhere.
   * Box-shadow (unresolved) and RTL are unmodelled. Not on a `break-spaces` space, which
   * takes room, nor a tab, nor a collapsible space ending the paragraph or a line before a
   * forced break, which Chrome strips before it shapes (Playfair 40px "ab say ": 110.125px
   * wide, 109.09 kerned). break-rules-parity.
   */
  endKern(i: number): number {
    const { items, m } = this;
    const count = items.prepared.count;
    if (i >= count || (items.flags(i) & (SEG_SPACE | SEG_TAB)) !== SEG_SPACE) return 0;
    const refs = items.refs(i);
    if (refs.style.whiteSpace === 'break-spaces') return 0;
    if (this.blockShowsTrailingSpace !== undefined &&
        (this.blockShowsTrailingSpace || refs.style.textDecorations.length > 0 || refs.boxStyle)) return 0;
    if (!preservesSpaces(refs.style.whiteSpace)) {
      let next = i + 1;
      while (next < count && isBoxEdge(items.text(next), items.refs(next))) next++;
      if (next >= count || (items.flags(next) & SEG_HARD_BREAK)) return 0;
    }
    return items.width(i) - segmentAdvance(m, m.stateOf(refs.style), items.text(i), refs);
  }

  /**
   * Item `i`'s width starting a line: Chrome shapes it alone there, without the kern into it
   * from the text before the break that its in-context width carries (Arial " A" -2.21px at
   * 40px, Merriweather "-t" -6.65px, Arimo "A&shy;V" and a word broken inside "A|V" -7.42px at
   * 100px).
   */
  startWidth(i: number): number {
    const { items, m } = this;
    const refs = items.refs(i);
    if ((items.flags(i) & (SEG_SPACE | SEG_SHAPED_APART)) || !items.text(i) || refs.inlineBlock) return items.width(i);
    return segmentAdvance(m, m.stateOf(refs.style), items.text(i), refs);
  }

  isSpace(i: number): boolean {
    return (this.items.flags(i) & SEG_SPACE) !== 0;
  }

  /** The current line's last item is a space (false on an empty line). */
  endsWithSpace(): boolean {
    const line = this.line.items;
    return line.length > 0 && this.isSpace(line[line.length - 1]);
  }

  /** The line can end before `next`: Chrome takes this before an overflow-wrap break (Blink `HandleOverflow`). */
  canWrapBefore(next: number): boolean {
    return !cannotStartLine(breakBefore(this.items, next)) && this.holdsLineEnd();
  }

  /** The line holds an item a line can end after (`offersLineEnd`). */
  holdsLineEnd(): boolean {
    for (const i of this.line.items) if (offersLineEnd(this.items, i)) return true;
    return false;
  }

  /**
   * The current line holds an item whose `flags & mask` equals `value`. A loop, not `some`:
   * a closure here makes V8 allocate a context per call.
   */
  holds(mask: number, value: number): boolean {
    for (const i of this.line.items) if ((this.items.flags(i) & mask) === value) return true;
    return false;
  }

  /** The current line's text, for debug entries (`FlowItems.debugText`). */
  text(): string {
    let text = '';
    for (const i of this.line.items) text += this.items.debugText(i);
    return text;
  }

  /** Add item `i` to the current line at `width`. */
  place(i: number, width: number, lineHeight: number): void {
    this.line.items.push(i);
    this.line.totalWidth += width;
    this.line.lineHeight = Math.max(this.line.lineHeight, lineHeight);
  }

  /**
   * Advance to the next tab stop; a stop closer than half a space is skipped (Blink
   * Font::TabWidth). The tab placed is a piece of its own, at this flow's width.
   */
  placeTab(tab: number, lineHeight: number): void {
    const interval = this.tabMetrics?.interval || this.items.width(tab);
    const halfSpace = this.tabMetrics?.halfSpace ?? 0;
    const currentPos = this.lineStart() + this.line.totalWidth;
    // No stops at font-size 0 (`x % 0` is NaN): the tab advances nothing.
    let advance = interval > 0 ? interval - (currentPos % interval) : 0;
    if (advance < halfSpace) advance += interval;
    this.place(this.items.cut(tab, this.items.text(tab), advance), advance, lineHeight);
  }

  /** Commit the current line and start the next. */
  commit(isSoftWrap = false): void {
    const items = this.items;
    const current = this.line;
    const line = current.items;
    const hadWords = line.length > 0;
    // A line of preserved white space keeps its height, by the space's own white-space.
    let heldPreserved = false;
    // Trim trailing spaces: `break-spaces` keeps them; `pre`/`pre-wrap` keep them except at
    // soft wraps (CSS Text 3 §4.1.1).
    const preserveTrailing = this.whiteSpace === 'break-spaces'
      || (preservesSpaces(this.whiteSpace) && !isSoftWrap);
    if (!preserveTrailing) {
      while (line.length > 0 && this.isSpace(line[line.length - 1])) {
        const space = line[line.length - 1];
        if (preservesSpaces(items.refs(space).style.whiteSpace)) heldPreserved = true;
        current.totalWidth -= items.width(space) - this.endKern(space);
        line.pop();
        if (isSoftWrap) current.spaceWrap = true;
      }
    }
    // A soft wrap at a soft hyphen appends a visible '-'.
    if (isSoftWrap && line.length > 0) {
      const last = line[line.length - 1];
      if (items.flags(last) & SEG_SOFT_HYPHEN) {
        const refs = items.refs(last);
        const hyphenWidth = softHyphenAdvance(this.m, refs.style);
        // The '-' keeps the word's clip/stroke-image declarer, else it paints transparent.
        line.push(items.textOf(refs, '-', hyphenWidth));
        current.totalWidth += hyphenWidth;
      }
    }
    // In pre-wrap mode, space-only lines still need height (they are content)
    if (line.length > 0 || (hadWords && (this.keepsSpaceOnlyLines || heldPreserved))) {
      if (this.session.debug) {
        const text = this.text();
        this.session.debug({
          type: 'line-commit',
          message: `Line ${this.lines.length}: "${text}" width=${current.totalWidth.toFixed(2)} / ${this.contentWidth}`,
          data: { lineIndex: this.lines.length, text, totalWidth: current.totalWidth, contentWidth: this.contentWidth },
        });
      }
      this.lines.push(current);
    }
    this.line = this.newLine();
  }

  /** Take a soft-wrap opportunity: the content that follows starts a new line. */
  wrap(): void {
    this.commit(true);
    this.afterHardBreak = false;
  }

  /** A forced break (preserved \n or <br>); an empty line still stands at `lineHeight`. */
  forcedBreak(lineHeight: number): void {
    if (this.line.items.length === 0) {
      this.line.lineHeight = Math.max(this.line.lineHeight, lineHeight);
      this.line.endedByHardBreak = true;
      this.lines.push(this.line);
      this.line = this.newLine();
    } else {
      this.line.endedByHardBreak = true;
      this.commit();
    }
    this.afterHardBreak = true;
  }
}

/** The visible '-' of a soft-hyphen break, in the word's own measuring state. */
function softHyphenAdvance(m: Measurer, style: ResolvedStyle): number {
  return m.width(m.stateOf(style), '-');
}

/**
 * The ONE line breaker: the layout runs it at the used width, min-content at 0 and
 * max-content at Infinity. Phases: `breakBefore`, glue, `splitSegment`, `breakGluedChain`,
 * `placePiece` / `knifeEdgeOverflows`, then `LineFlow` commits.
 */
export function flowLines(flow: LineFlow): FlowLine[] {
  const items = flow.items;
  const count = items.prepared.count;
  for (let i = 0; i < count; i++) {
    // Only a line with no words keeps this height (`emitLine`); the rest get `lineBoxExtent`.
    const lineHeight = flow.m.lineHeight(items.refs(i).style);
    if (items.flags(i) & SEG_HARD_BREAK) {
      flow.forcedBreak(lineHeight);
      continue;
    }
    if (flow.noWrap) {
      flow.place(i, items.width(i), lineHeight);
      continue;
    }
    const chainEnd = gluedChainEnd(items, i);
    if (chainEnd > i && breakGluedChain(flow, i, chainEnd)) {
      i = chainEnd;
      continue;
    }
    placeSegment(flow, i, lineHeight);
  }
  flow.commit();
  return flow.lines;
}

/**
 * The last segment of the glued chain starting at `start` (one word across runs:
 * `<span>E</span>xperience`, `<span>wel</span>l-being`), or `start` when none.
 */
function gluedChainEnd(items: FlowItems, start: number): number {
  const cls = breakBefore(items, start);
  if (cls === 'space' || cls === 'continues' || !items.text(start)) return start;
  const refs = items.refs(start);
  if (refs.boxOpen || refs.boxClose) return start;
  const count = items.prepared.count;
  let end = start;
  while (end + 1 < count) {
    // The word continues through closing edges too (`abutsWithoutBreak`).
    let next = end + 1;
    while (next < count && isBoxEdge(items.text(next), items.refs(next)) && items.refs(next).boxClose) next++;
    if (next >= count || breakBefore(items, next) !== 'continues') break;
    end = next;
  }
  // Closing edges after the word share its last line: no line starts at one.
  while (end > start && end + 1 < count && isBoxEdge(items.text(end + 1), items.refs(end + 1)) &&
    items.refs(end + 1).boxClose) end++;
  return end;
}

/**
 * Break a word split across runs (`gluedChainEnd`) at its hyphens, `break-all` or break-word
 * points, which per-segment logic cannot see. False when it needs no breaking here.
 */
function breakGluedChain(flow: LineFlow, start: number, end: number): boolean {
  const { items, m } = flow;
  let combined = flow.endKern(end + 1);
  for (let j = start; j <= end; j++) combined += items.width(j);
  if (flow.line.totalWidth + combined <= flow.budget()) return false;
  const breaking = flow.wordBreaking(items.refs(start).style);
  const breakWord = breaking !== 'none';
  // `break-all` fills the current line, as `splitSegment` does for a one-run word.
  const anywhere = breaking === 'anywhere';
  let combinedText = '';
  for (let j = start; j <= end; j++) combinedText += items.text(j);
  // Hyphen break opportunities (same rule as the single-word hyphen path).
  const segTexts: string[] = [];
  if (combinedText) forEachHyphenPiece(combinedText, 0, combinedText.length, (p) => segTexts.push(p));
  const hyphenMode = segTexts.length > 1;
  // A hyphen breaks whenever the unit does not fit; break-word only when it cannot fit a
  // whole line.
  const enter = hyphenMode || anywhere || (breakWord && combined > flow.budget());
  if (!enter) return false;

  // Only a chain that splits needs characters, each keeping its segment's refs: style,
  // paint declarers and `parentStyle` (a vertical-align run shifts against its real parent).
  // A box edge inside the word (`abutsWithoutBreak`) is a cell with no character: its item.
  type Cell = { ch: string; refs: SegmentRefs; edge?: number };
  const cells: Cell[] = [];
  for (let j = start; j <= end; j++) {
    const refs = items.refs(j);
    const text = items.text(j);
    if (isBoxEdge(text, refs)) cells.push({ ch: '', refs, edge: j });
    else for (const ch of text) cells.push({ ch, refs });
  }
  if (flow.session.stats) flow.session.stats.chainCells += cells.length;

  // Atomic units for breaking: hyphen segments, else the whole chain. An opening edge
  // belongs to the segment of the character after it, a closing edge to the one before.
  const segs: Cell[][] = [];
  let ci = 0;
  for (const st of segTexts) {
    let len = [...st].length;
    const seg: Cell[] = [];
    while (ci < cells.length && (len > 0 || cells[ci].refs.boxClose && cells[ci].edge !== undefined)) {
      if (cells[ci].edge === undefined) len--;
      seg.push(cells[ci++]);
    }
    segs.push(seg);
  }
  if (ci < cells.length && segs.length > 0) segs[segs.length - 1].push(...cells.slice(ci));
  // Place cells, splitting same-style runs into pieces: `chars` wraps between characters
  // (break-word), else the segment is placed atomically and may overflow.
  const placeCells = (cs: Cell[], chars: boolean) => {
    let i = 0;
    while (i < cs.length) {
      const edge = cs[i].edge;
      if (edge !== undefined) {
        // An opening edge wraps with the character after it (padding-left goes with the content).
        if (chars && cs[i].refs.boxOpen && flow.line.items.length > 0) {
          const next = cs.find((c, k) => k > i && c.edge === undefined);
          const nextW = next ? segmentAdvance(m, m.stateOf(next.refs.style), next.ch, next.refs) : 0;
          if (flow.line.totalWidth + items.width(edge) + nextW > flow.budget()) flow.wrap();
        }
        flow.place(edge, items.width(edge), m.lineHeight(cs[i].refs.style));
        i++;
        continue;
      }
      // Refs are 1:1 with the style run, so the run start's cover every piece.
      const refs = cs[i].refs;
      const st = refs.style;
      const state = m.stateOf(st);
      const lh = m.lineHeight(st);
      let cur = '';
      let curW = 0;
      while (i < cs.length && cs[i].edge === undefined && cs[i].refs.style === st) {
        const ch = cs[i].ch;
        const candW = segmentAdvance(m, state, cur + ch, refs);
        // A closing edge right after this character shares its line.
        let closing = 0;
        for (let k = i + 1; k < cs.length && cs[k].edge !== undefined && cs[k].refs.boxClose; k++) {
          closing += items.width(cs[k].edge!);
        }
        if (chars && flow.line.totalWidth + candW + closing > flow.budget() &&
            (flow.line.items.length > 0 || cur)) {
          // Under `break-all`, back up to the last boundary the glue allows.
          let keep = cur;
          let carry = '';
          if (anywhere) {
            const chars = [...cur];
            let k = chars.length;
            let next = ch;
            while (k > 0 && !breakAllAllows(chars[k - 1], next)) next = chars[--k];
            if (k > 0 || flow.line.items.length > 0) {
              keep = chars.slice(0, k).join('');
              carry = chars.slice(k).join('');
            }
          }
          if (keep) {
            const keepW = keep === cur ? curW : segmentAdvance(m, state, keep, refs);
            flow.place(items.textOf(refs, keep, keepW), keepW, lh);
          }
          flow.wrap();
          cur = carry + ch;
          curW = segmentAdvance(m, state, cur, refs);
        } else {
          cur += ch;
          curW = candW;
        }
        i++;
      }
      if (cur) {
        flow.place(items.textOf(refs, cur, curW), curW, lh);
        flow.afterHardBreak = false;
      }
    }
  };
  const measureSeg = (cs: Cell[]) => {
    let w = 0;
    let i = 0;
    while (i < cs.length) {
      const edge = cs[i].edge;
      if (edge !== undefined) { w += items.width(edge); i++; continue; }
      const refs = cs[i].refs;
      let txt = '';
      while (i < cs.length && cs[i].edge === undefined && cs[i].refs.style === refs.style) { txt += cs[i].ch; i++; }
      w += segmentAdvance(m, m.stateOf(refs.style), txt, refs);
    }
    return w;
  };
  // Pure break-word is a last resort: wrap the whole word to a fresh line first.
  if (!hyphenMode && !anywhere && flow.canWrapBefore(start)) flow.wrap();
  for (const seg of segs) {
    const segW = measureSeg(seg);
    // A hyphen segment boundary is itself an opportunity.
    if (!anywhere && flow.holdsLineEnd() && flow.line.totalWidth + segW > flow.budget()) flow.wrap();
    // Char-break a segment under break-all, or under break-word when it can't fit a line.
    placeCells(seg, anywhere || (breakWord && segW > flow.budget()));
  }
  return true;
}

/** Flow one segment: split it if it breaks per character (`splitSegment`), place each piece. */
function placeSegment(flow: LineFlow, segment: number, lineHeight: number): void {
  const items = flow.items;
  // The pieces are consecutive items: the segment itself, or its cuts.
  let pieceStart = segment;
  let pieceEnd = segment + 1;
  if (!flow.isSpace(segment) && items.text(segment).length > 1) {
    const split = splitSegment(flow, segment);
    if (split) {
      if (split.wrapFirst) flow.wrap();
      for (let k = 0; k < split.texts.length; k++) {
        const piece = items.cut(segment, split.texts[k], split.widths[k], split.contexts[k]);
        if (k === 0) pieceStart = piece;
        pieceEnd = piece + 1;
      }
      if (split.texts.length === 0) pieceEnd = pieceStart;
    }
  }

  for (let piece = pieceStart; piece < pieceEnd; piece++) {
    placePiece(flow, segment, piece, pieceStart, pieceEnd, lineHeight);
  }
}

/**
 * The fit decision for one piece: wrap when it plus everything that must share its line
 * overflows (unless no line may start at it), then place it.
 */
function placePiece(
  flow: LineFlow, segment: number, piece: number, pieceStart: number, pieceEnd: number, lineHeight: number,
): void {
  const { items, m, session } = flow;
  const pieceFlags = items.flags(piece);
  // Closing punctuation, a closing edge and a word continuation stay with the word before.
  const glued = cannotStartLine(breakBefore(items, piece, piece !== pieceStart)) &&
    flow.line.items.length > 0 && !flow.endsWithSpace();
  const pieceWidth = items.width(piece);
  // overflow-wrap: a word too wide for any line breaks where it stops fitting, before its
  // closing punctuation too (Chrome, Firefox, WebKit: "aaaa." wraps as "aaaa" / ".").
  if (glued && (pieceFlags & SEG_CLOSING_PUNCT) && flow.wordBreaking(items.refs(piece).style) === 'last-resort' &&
      flow.line.totalWidth + pieceWidth + (piece === pieceEnd - 1 ? flow.endKern(segment + 1) : 0) > flow.budget() &&
      !flow.holds(SEG_SPACE, SEG_SPACE)) {
    flow.wrap();
  }
  // `break-spaces` spaces take room: they wrap like words and start the next line visibly.
  const breakSpaces = items.refs(piece).style.whiteSpace === 'break-spaces';

  if ((!(pieceFlags & SEG_SPACE) || breakSpaces) && !glued && flow.line.items.length > 0) {
    const gluedTailWidth = flow.gluedTail(segment);
    const tail = trailingGlueWidth(items, piece, pieceEnd, gluedTailWidth + flow.tailKern(segment));
    const headExtra = headGlueWidth(flow, segment, piece, piece === pieceEnd - 1, gluedTailWidth);
    // Chrome breaks at a soft hyphen only if the prefix PLUS its '-' fits: reserve it.
    const shReserve = pieceFlags & SEG_SOFT_HYPHEN
      ? softHyphenAdvance(m, items.refs(piece).style) : 0;
    const candidateLineWidth = flow.line.totalWidth + pieceWidth + shReserve + tail + headExtra;
    const overflow = candidateLineWidth - flow.budget();
    // Under 1px over, the summed advances may be wrong: re-measure.
    if (overflow > 0 && (overflow >= 1 || knifeEdgeOverflows(flow, piece, tail, headExtra))) {
      if (session.debug) {
        const lineText = flow.text();
        const pieceText = items.debugText(piece);
        session.debug({
          type: 'line-wrap',
          message: `"${pieceText}" overflow=${overflow.toFixed(2)} wrap=true lineWidth=${flow.line.totalWidth.toFixed(2)} pieceWidth=${pieceWidth.toFixed(2)} contentWidth=${flow.contentWidth}  line="${lineText}"`,
          data: { text: pieceText, overflow, lineWidth: flow.line.totalWidth, pieceWidth, contentWidth: flow.contentWidth, lineText },
        });
      }
      flow.wrap();
    }
  }

  // Leading spaces are dropped, except preserved ones after a hard break: by their own
  // white-space, a pre-wrap span keeps its space in a collapsing block.
  if ((pieceFlags & SEG_SPACE) && flow.line.items.length === 0 && !breakSpaces
      && (!flow.afterHardBreak || !preservesSpaces(items.refs(piece).style.whiteSpace))) return;

  if (pieceFlags & SEG_TAB) {
    flow.placeTab(piece, lineHeight);
  } else if (flow.line.items.length === 0) {
    const width = flow.startWidth(piece);
    flow.place(width === pieceWidth ? piece : items.cut(piece, items.text(piece), width), width, lineHeight);
  } else {
    flow.place(piece, pieceWidth, lineHeight);
  }
  if (!(pieceFlags & SEG_SPACE)) flow.afterHardBreak = false;
}

/**
 * Whether a line whose summed advances overflow by under 1px really does: re-measure it
 * as one string when its glyphs share one state. Only over the edge; a sum under it is
 * trusted.
 */
function knifeEdgeOverflows(flow: LineFlow, piece: number, tail: number, headExtra: number): boolean {
  const { items, m } = flow;
  // A tab's advance depends on its stop, which measureText('\t') ignores: trust the sum.
  if (flow.holds(SEG_TAB, SEG_TAB)) return true;
  const lineState = lineMeasureState(m, items, flow.line.items, piece);
  if (lineState === 'mixed') return true;
  // Under the full state every glyph shares, letter-spacing included.
  const state = lineState ?? m.stateOf(items.refs(piece).style);
  // Add back what the string misses: box-edge markers, atomic inline-blocks, and spaces set
  // in another state (`<b style="font-size:.7em"> </b>`).
  let textWidth = 0;
  let markerWidth = 0;
  let text = '';
  const lineItems = flow.line.items;
  for (let k = 0; k <= lineItems.length; k++) {
    const i = k < lineItems.length ? lineItems[k] : piece;
    const itemText = items.text(i);
    // An RTL override paints as its own wrapped pieces, not as this one string: trust the sum.
    if (overridesRtl(items.refs(i).bidi)) return true;
    if (!itemText || items.refs(i).inlineBlock) {
      markerWidth += items.width(i);
    } else if (flow.isSpace(i) && m.stateOf(items.refs(i).style) !== state) {
      if (text) textWidth += m.width(state, text);
      text = '';
      markerWidth += items.width(i);
    } else {
      // The engine shapes it apart from the text before it: no kerning joins them.
      if ((items.flags(i) & SEG_SHAPED_APART) && text) {
        textWidth += m.width(state, text);
        text = '';
      }
      text += itemText;
      markerWidth += wordSpacingIn(itemText, items.refs(i).style.wordSpacing);
    }
  }
  if (items.flags(piece) & SEG_SOFT_HYPHEN) text += '-';
  if (text) textWidth += m.width(state, text);
  const fullWidth = textWidth + markerWidth + tail + headExtra;
  return fullWidth > flow.budget();
}

/** The widest line of a flow, the first standing `textIndent` further in. */
export function widestLine(lines: readonly FlowLine[], textIndent: number): number {
  return lines.reduce(
    (widest, line, index) => Math.max(widest, index === 0 ? line.totalWidth + textIndent : line.totalWidth), 0);
}

/**
 * `-webkit-line-clamp` line budget shared across block descendants (Chrome legacy
 * `-webkit-box`).
 */
export interface LineClampState {
  /** Line boxes still allowed before the cut. */
  remaining: number;
  /** Truncation point reached — all subsequent content is dropped. */
  exhausted: boolean;
  /**
   * In-flow content follows the content being laid out, inside the clamping box: a budget
   * spent exactly at its end still hides something, so the last line takes the "…".
   * `layoutBlock` sets it right before every call that passes the clamp down.
   */
  followed: boolean;
}

/** True (and marks it exhausted) once a clamp has no lines left. */
export function clampSpent(clamp: LineClampState | undefined): boolean {
  if (!clamp || !(clamp.exhausted || clamp.remaining <= 0)) return false;
  clamp.exhausted = true;
  return true;
}

/**
 * `-webkit-line-clamp`: keep N lines and end the Nth with "…" when the cut hides anything
 * (later lines, or content after this one). The budget is an ancestor's shared clamp when
 * one is active, else this element's own.
 */
export function clampLines(
  session: LayoutSession,
  style: ResolvedStyle,
  lines: PositionedLine[],
  contentWidth: number,
  clamp: LineClampState | undefined,
): void {
  const clampN = clamp ? clamp.remaining : style.lineClamp;
  if (clampN > 0 && (lines.length > clampN || (lines.length === clampN && clamp?.followed))) {
    lines.length = clampN;
    const lastLine = lines[clampN - 1];
    // A first-line cut also loses the text-indent.
    const lineMaxForEllipsis = contentWidth - (clampN === 1 ? (style.textIndent || 0) : 0);
    applyEllipsisToLine(session, lastLine, lineMaxForEllipsis);
    // The ellipsis ends the line; it is not a source hard break.
    lastLine.endedByHardBreak = false;
    if (clamp) {
      clamp.remaining = 0;
      clamp.exhausted = true;
    }
  } else if (clamp) {
    clamp.remaining -= lines.length;
  }
}
