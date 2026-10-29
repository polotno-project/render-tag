// The inline data model: text runs, segments and their flags, and what a text earns on
// its own (CJK, emoji, kinsoku, the measuring context). Read by every pass; leaf module.
import type { StyledNode, LayoutNode, ResolvedStyle, LayoutLine, LayoutLineBox } from '../types.js';
import { bidiClass, overriddenText, type BidiContext } from '../bidi.js';
import type { Measurer, MeasureState } from './session.js';

// ── Inline text run types ──

export interface TextRun {
  text: string;
  style: ResolvedStyle;
  /** Atomic inline-block content starts a new CSS word. */
  wordBoundaryBefore?: boolean;
  /**
   * The style of the parent of this run's element: what `vertical-align` shifts against
   * (CSS 2.1 §10.8.1), not the tallest run on the line.
   */
  parentStyle?: ResolvedStyle;
  /** If this run came from an inline element with visible box styles */
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box */
  boxClose?: ResolvedStyle;
  /** The edge is the box's margin, outside its padding and border and its background. */
  margin?: true;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
  /** Source element for an atomic inline-block with its own inner line flow. */
  inlineBlock?: StyledNode;
  /** Innermost inline `unicode-bidi` context (isolate/embed/override); none = the paragraph. */
  bidi?: BidiContext | null;
}

export interface InlineBlockLayout {
  nodes: LayoutNode[];
  lines: LayoutLine[];
  lineBoxes: LayoutLineBox[];
  contentWidth: number;
  contentHeight: number;
  /** Last inner line's baseline, measured from the margin-box top. */
  baselineOffset: number;
  marginBoxHeight: number;
}

/** One item of a committed line as the emit pass reads it (`FlowItems.word`). */
export interface Word {
  text: string;
  width: number;
  refs: SegmentRefs;
  isSpace: boolean;
  /** Tab character — its width is the advance to the tab stop it reached */
  isTab?: boolean;
  inlineBlockLayout?: InlineBlockLayout;
  /** See `SEG_RUN_SEAM`. */
  runSeam?: true;
  /** A line-clamp's '…', or a bidi run ending with it (`CLAMP_ELLIPSIS`). */
  ellipsis?: true;
  /** A single-paint bidi line's own levels (`RUN_LEVELS`). */
  levels?: Uint8Array;
}

/** A committed line as the emit pass reads it: a `FlowLine` with its items materialized. */
export interface PositionedLine {
  words: Word[];
  totalWidth: number;
  lineHeight: number;
  /** True at a forced break (preserved \n or <br>); uses text-align-last. */
  endedByHardBreak?: boolean;
  /** Its soft wrap consumed white space (`SPACE_WRAP`). */
  spaceWrap?: true;
}

/** True for atomic inline-block words (boxOpen && boxClose && text together). */
export function isAtomicInlineBlock(w: Word): boolean {
  return !!(w.refs.boxOpen && w.refs.boxClose && w.text);
}

/** Text in a script without spaces between words (Thai, Khmer, Lao, Myanmar). */
export function needsSegmenter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (
      (code >= 0x0E00 && code <= 0x0E7F) ||  // Thai
      (code >= 0x0E80 && code <= 0x0EFF) ||  // Lao
      (code >= 0x1000 && code <= 0x109F) ||  // Myanmar
      (code >= 0x1780 && code <= 0x17FF)     // Khmer
    ) return true;
    if (code > 0xFFFF) i++; // skip surrogate pair
  }
  return false;
}

// Scripts fillText must shape as whole runs. Not Hebrew: its letters do not join, and a
// grapheme keeps its points. `\u` escapes only: a literal RTL code point can silently
// corrupt the class.
const SHAPING_RE = /[\u0600-\u086F\u08A0-\u109F\u1780-\u18AF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Classes a shaped run may hold. Without neutrals and at one level, fillText's
 * own bidi pass orders the run's inside exactly as UAX #9 does. */
const SHAPED_RUN_CLASSES = new Set(['L', 'R', 'AL', 'NSM', 'EN', 'AN']);

/** A grapheme that must be painted in one fillText with its shaped neighbours, never alone. */
export function shapesAsRun(grapheme: string): boolean {
  return SHAPING_RE.test(grapheme) &&
    SHAPED_RUN_CLASSES.has(bidiClass(grapheme.codePointAt(0)!));
}

const segmenters: Partial<Record<'word' | 'grapheme', Intl.Segmenter>> = {};
export function segmenter(granularity: 'word' | 'grapheme'): Intl.Segmenter | undefined {
  let seg = segmenters[granularity];
  if (!seg && typeof Intl !== 'undefined' && Intl.Segmenter) {
    seg = segmenters[granularity] = new Intl.Segmenter(undefined, { granularity });
  }
  return seg;
}

/**
 * A piece is measured as `w(context + piece) - w(context)`, so kerning across its edges
 * survives. Whole-run context was quadratic (2000 words sent 25.7M chars to measureText);
 * 32 UTF-16 units moved no wrap in the 1px sweeps, shorter moved RTL and fallback-font
 * lines. Past it the context restarts at the last word, never at a space: a bare ' '
 * measures in the primary font, but between fallback-font words the engine uses the
 * fallback, so a cut there mis-measured every RTL word after it.
 *
 * Simple-script text (`isSimpleScript`) restarts at EVERY word: kerning across a space is
 * pairwise and its neutrals need no bidi context, so the previous word and its space are
 * all the context a width depends on, at a third of the measured characters.
 */
export const MEASURE_CONTEXT = 32;

/**
 * Latin, Greek, Cyrillic and the punctuation and symbols set beside them, without bidi
 * controls (U+2000-200F, U+2028-202F) or anything shaped across words.
 */
function isSimpleScript(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x0590 || (c >= 0x2010 && c <= 0x2027) || (c >= 0x2030 && c <= 0x205E) ||
      (c >= 0x20A0 && c <= 0x2BFF)) continue;
    return false;
  }
  return true;
}

export interface Cumulative {
  text: string;
  width: number;
  word: number;
}

/** How far back an open bracket holds the context; a stray "(" cannot go quadratic. */
const MEASURE_BRACKET = 256;

/**
 * Where a context restart may cut `text`: at `word`, or earlier at a still-open bracket
 * and the word with the nearest letter before it: a pair takes its direction from the
 * type before the opener (UBA N0), and a number takes its type from a letter (W7).
 * Without it, `)` in `<Arabic>: $42.99 (<Arabic> … ₪158.50)` measured 0.38px narrow
 * in Lobster and moved a wrap.
 */
function contextStart(text: string, word: number): number {
  const open: number[] = [];
  // The last word too: an opener starting it still wants the letter before it.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ASCII by code; the Unicode property tests only past it.
    if (code < 0x80) {
      if (code === 0x28 || code === 0x5B || code === 0x7B) open.push(i);
      else if (code === 0x29 || code === 0x5D || code === 0x7D) open.pop();
    } else if (OPEN_BRACKET.test(text[i])) open.push(i);
    else if (CLOSE_BRACKET.test(text[i])) open.pop();
  }
  if (open.length === 0) return word;
  let start = open[0];
  while (start > 0 && !LETTER.test(text[start - 1])) start--;
  while (start > 0 && text[start - 1] !== ' ') start--;
  return word - start <= MEASURE_BRACKET ? start : word;
}
const OPEN_BRACKET = /\p{Ps}/u;
const CLOSE_BRACKET = /\p{Pe}/u;
const LETTER = /\p{L}/u;

/** The width `piece` adds after what `cum` holds, as it paints (`segmentAdvance`, in context);
 * appends it. */
export function measureAfter(
  m: Measurer, state: MeasureState, cum: Cumulative, piece: string, refs: SegmentRefs,
): number {
  const painted = overriddenText(piece, refs.bidi);
  const isSpace = piece === ' ';
  if (!isSpace && cum.word > 0 &&
      (cum.text.length > MEASURE_CONTEXT || (isSimpleScript(painted) && isSimpleScript(cum.text)))) {
    const start = contextStart(cum.text, cum.word);
    if (start > 0) {
      cum.text = cum.text.slice(start);
      cum.width = m.width(state, cum.text);
    }
  }
  const before = cum.width;
  if (!isSpace) cum.word = cum.text.length;
  cum.text += painted;
  cum.width = m.width(state, cum.text);
  return cum.width - before + wordSpacingIn(piece, refs.style.wordSpacing);
}

// ── Prepared inline content ──

/** What a segment shares with its run: the run itself, one per run, referenced by index. */
export type SegmentRefs = Readonly<Omit<TextRun, 'text' | 'wordBoundaryBefore'>>;

/** An inline box edge's width (`boxOpen` the left, `boxClose` the right) from `style`. */
export function inlineEdgeWidth(refs: SegmentRefs, style: ResolvedStyle): number {
  if (refs.boxOpen) return refs.margin ? style.marginLeft : style.paddingLeft + style.borderLeftWidth;
  return refs.margin ? style.marginRight : style.paddingRight + style.borderRightWidth;
}

/**
 * The `word-spacing` `text` adds: one per U+0020 and U+00A0, the word separators every
 * engine's DOM widens (measured; not U+3000, U+2009 or U+1361). Measuring writes no
 * `ctx.wordSpacing`, so every measured width adds this.
 */
export function wordSpacingIn(text: string, spacing: number): number {
  if (!spacing) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0xA0) n++;
  }
  return n * spacing;
}

// The cursive scripts Chrome's canvas leaves unspaced (measured; not Adlam, Sogdian,
// Manichaean or Thaana), and the shared characters that may belong to them.
const CURSIVE = /^[\p{scx=Arabic}\p{scx=Syriac}\p{scx=Nko}\p{scx=Mongolian}\p{scx=Mandaic}\p{scx=Hanifi_Rohingya}\p{scx=Phags_Pa}]/u;
const SHARED = /^[\p{sc=Common}\p{sc=Inherited}]/u;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}+$/u;

/**
 * Per grapheme: does letter-spacing follow it, as Chrome's canvas spaces? Not after
 * default-ignorables (U+200B, U+00AD, bidi controls) or a cursive script. A shared character
 * of one (tatweel, the Arabic comma, U+202F) follows the last script before it, cursive when
 * there is none. Beside Arabic, Chrome also leaves a space unspaced in some fonts (Roboto,
 * kerned) but not others; not modelled.
 */
export function letterSpaced(clusters: readonly string[]): boolean[] {
  let cursive: boolean | undefined;
  return clusters.map((g) => {
    if (IGNORABLE.test(g)) return false;
    if (!SHARED.test(g)) return !(cursive = CURSIVE.test(g));
    return !(CURSIVE.test(g) && cursive !== false);
  });
}

/**
 * Segment text's advance as it paints: an RTL override wrapped (`overriddenText`), plus its
 * `word-spacing`. Every measure of segment text goes through it, or `measureAfter` in context.
 */
export function segmentAdvance(m: Measurer, state: MeasureState, text: string, refs: SegmentRefs): number {
  return m.width(state, overriddenText(text, refs.bidi)) + wordSpacingIn(text, refs.style.wordSpacing);
}

/** Collapsible or preserved whitespace; a space's width carries word-spacing. */
export const SEG_SPACE = 1 << 0;
/** A preserved tab: its width is a placeholder until the flow reaches a stop. */
export const SEG_TAB = 1 << 1;
/** Breaks after a soft hyphen: a visible '-' when a line ends here. */
export const SEG_SOFT_HYPHEN = 1 << 2;
/**
 * No soft-wrap opportunity before this segment: it abuts the previous one with no
 * whitespace (`<span>a</span><span>b</span>`).
 */
export const SEG_NO_BREAK_BEFORE = 1 << 3;
/** A new measuring run right after one of the same style object (`startsMeasuredRun`). */
export const SEG_RUN_SEAM = 1 << 4;
/** Flags a piece cut from a segment keeps (`FlowItems.cut`); the rest come from its own text. */
export const SEG_INHERITED = SEG_SPACE | SEG_TAB | SEG_SOFT_HYPHEN | SEG_NO_BREAK_BEFORE | SEG_RUN_SEAM;
/** The text is exactly `'\n'`: a forced break. */
export const SEG_HARD_BREAK = 1 << 5;
/** Holds a CJK character: always broken per character (`splitSegment`). */
export const SEG_CJK = 1 << 6;
/** Holds an emoji cluster: a break opportunity between clusters. */
export const SEG_EMOJI = 1 << 7;
/** Punctuation that cannot start a line (`TRAILING_PUNCT`). */
export const SEG_CLOSING_PUNCT = 1 << 8;
/** Punctuation that cannot end a line (`OPENING_PUNCT`). */
export const SEG_OPENING_PUNCT = 1 << 9;

/** The flags a text earns on its own: forced break and kinsoku glue. */
export function textFlags(text: string): number {
  if (!text) return 0;
  let flags = 0;
  if (text === '\n') flags |= SEG_HARD_BREAK;
  // Neither set holds an ASCII letter or digit: a text starting with one is in neither.
  if (isAsciiAlnum(text.charCodeAt(0))) return flags;
  if (TRAILING_PUNCT.test(text)) flags |= SEG_CLOSING_PUNCT;
  if (OPENING_PUNCT.test(text)) flags |= SEG_OPENING_PUNCT;
  return flags;
}

function isAsciiAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
}

/** Whether `splitSegment` breaks this text per character / cluster, whatever the width. */
export function breakFlags(text: string): number {
  let flags = 0;
  // U+200D is the lowest code `EMOJI_CANDIDATE` matches.
  let emojiCandidate = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code >= 0x200D) emojiCandidate = true;
    if (isCJKCode(code)) { flags |= SEG_CJK; break; }
    if (code > 0xFFFF) i++;
  }
  // Emoji only with a grapheme segmenter, so ZWJ sequences, skin tones and
  // flag pairs stay intact.
  if (emojiCandidate && segmenter('grapheme') && EMOJI_CANDIDATE.test(text) && graphemes(text).some(isEmojiCluster)) {
    flags |= SEG_EMOJI;
  }
  return flags;
}

/**
 * One inline formatting context's text, segmented and measured once per call and read by
 * every pass (min-content, max-content, the real flow); no pass writes to it. Struct of
 * arrays, one entry per segment; what a segment shares with its run sits once in `refs`.
 * Segment text is the exact measured string, never a slice of a concatenation.
 */
export interface PreparedInline {
  /** Text runs the content produced (`collectTextRuns`); 0 = nothing inline at all. */
  readonly runs: number;
  readonly count: number;
  readonly text: readonly string[];
  /** Advance in the run's own measuring state, with left context (`measureAfter`). */
  readonly width: readonly number[];
  readonly flags: readonly number[];
  /** Index into `refs`. */
  readonly ref: readonly number[];
  readonly refs: readonly SegmentRefs[];
  /**
   * Segments whose width the final flow decides: atomic inline-blocks (prepared at
   * max-content) and edges with percentage padding (prepared at 0). `usedSegmentWidths`.
   */
  readonly inlineBlocks: readonly number[];
  readonly percentEdges: readonly number[];
}

/** Grows the `PreparedInline` arrays while a pass appends segments. */
export class SegmentBuilder implements PreparedInline {
  runs = 0;
  count = 0;
  readonly text: string[] = [];
  readonly width: number[] = [];
  readonly flags: number[] = [];
  readonly ref: number[] = [];
  readonly refs: SegmentRefs[] = [];
  readonly inlineBlocks: number[] = [];
  readonly percentEdges: number[] = [];

  addRefs(refs: SegmentRefs): number {
    this.refs.push(refs);
    return this.refs.length - 1;
  }

  push(text: string, width: number, flags: number, ref: number): void {
    this.text.push(text);
    this.width.push(width);
    // A space's text is never a forced break or punctuation.
    this.flags.push(flags & SEG_SPACE ? flags : flags | textFlags(text));
    this.ref.push(ref);
    this.count++;
  }
}

/**
 * `text.slice(start, end)` split after hyphens, keeping the hyphen; a leading hyphen stays
 * with its word.
 */
export function forEachHyphenPiece(text: string, start: number, end: number, emit: (piece: string) => void): void {
  let from = start;
  for (let q = start + 2; q < end; q++) {
    if (text.charCodeAt(q - 1) === 0x2D) {
      emit(text.slice(from, q));
      from = q;
    }
  }
  emit(text.slice(from, end));
}

/** The first and last grapheme clusters of a non-empty text. */
function firstGrapheme(text: string): string {
  const seg = segmenter('grapheme');
  return seg ? seg.segment(text).containing(0)!.segment : String.fromCodePoint(text.codePointAt(0)!);
}
function lastGrapheme(text: string): string {
  const seg = segmenter('grapheme');
  if (seg) return seg.segment(text).containing(text.length - 1)!.segment;
  const chars = [...text];
  return chars[chars.length - 1];
}

export function isCJKCode(code: number): boolean {
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
    (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols
    (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
    (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul
    (code >= 0xFF00 && code <= 0xFFEF) ||   // Fullwidth
    (code >= 0x20000 && code <= 0x2A6DF)    // CJK Extension B
  );
}

const NON_ASCII_OR_CONTROL = /[^\x20-\x7E]/;

/** Split into grapheme clusters; code points when Intl.Segmenter is unavailable. */
export function graphemes(text: string): string[] {
  // Every printable ASCII character is a whole cluster; controls include the CRLF pair.
  if (!NON_ASCII_OR_CONTROL.test(text)) return text.split('');
  const seg = segmenter('grapheme');
  if (!seg) return [...text];
  const out: string[] = [];
  for (const s of seg.segment(text)) out.push(s.segment);
  return out;
}


const EMOJI_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** The characters `isEmojiCluster` can be true for: a cheap check before segmenting. */
const EMOJI_CANDIDATE = /[\u{1F000}-\u{10FFFF}\u200D\uFE0F]/u;
/**
 * An emoji cluster that is a break opportunity: emoji presentation only, so text symbols
 * like ©/®/™ (Extended_Pictographic, but no break) are excluded.
 */
export function isEmojiCluster(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f000) return true; // emoji planes (incl. regional indicators)
  }
  if (s.includes('\u200D') || s.includes('\uFE0F')) {
    return EMOJI_PICTOGRAPHIC.test(s); // ZWJ sequence or VS16 emoji presentation
  }
  return false;
}

// ── Break opportunities ──

/** Punctuation that cannot start a line — stays with the preceding word. Measured against
 * Chrome's DOM (`水×5 <char> 水×7`); small kana and `ー` stay out: `line-break: auto` breaks
 * before them. */
const TRAILING_PUNCT = /^[,.\;:!?\)\]\}'"»›」』】〕〉》”、。・！），：；？၊-၏។-៖៘-៚]+$/;
/** Punctuation that cannot end a line — stays with the following word. */
const OPENING_PUNCT = /^[\(\[\{«‹“‘「『【〔〈《（]+$/;

/**
 * Whether the run at segment `at` continues the text before it with no break opportunity
 * (`<span>E</span>xperience`): the source of `SEG_NO_BREAK_BEFORE`.
 */
export function abutsWithoutBreak(out: SegmentBuilder, at: number): boolean {
  if (at >= out.count || at === 0) return false;
  const first = out.text[at];
  if ((out.flags[at] & SEG_SPACE) || !first || first === '\n') return false;
  const prev = out.text[at - 1];
  const prevRefs = out.refs[out.ref[at - 1]];
  if (
    (out.flags[at - 1] & SEG_SPACE) || !prev.trim() ||
    prevRefs.boxOpen || prevRefs.boxClose
  ) return false;
  // Printable ASCII cannot contain a CJK/emoji cluster or a segmenter script.
  if (!NON_ASCII_OR_CONTROL.test(first) && !NON_ASCII_OR_CONTROL.test(prev)) return true;
  // Glue only ordinary text: CJK, emoji and segmenter scripts break at any element edge.
  // Graphemes, not code units or points: a VS16 emoji (❤️ = U+2764 U+FE0F) must read as emoji.
  const firstChar = firstGrapheme(first);
  const prevChar = lastGrapheme(prev);
  return !(
    isCJKCode(firstChar.codePointAt(0)!) || isCJKCode(prevChar.codePointAt(0)!) ||
    isEmojiCluster(firstChar) || isEmojiCluster(prevChar) ||
    needsSegmenter(first) || needsSegmenter(prev)
  );
}
