/**
 * Pure layout: walks styled segments and lays each grapheme along a path.
 * No canvas rendering happens here — that's the caller's job. Reusable
 * for hit-testing, debugging, alternate renderers (SVG, GPU).
 *
 * Joining-script support: graphemes from Arabic, Hebrew, Indic, Thai, Khmer,
 * Myanmar and related scripts within a single segment are grouped into one
 * "shaped run" placement. The browser's fillText/measureText then shapes the
 * run as a unit (cursive joining, reordering, conjuncts) — something
 * per-grapheme drawing cannot do.
 */

import type { ResolvedStyle, StyledNode } from '../types.js';
import { Measurer, type FontMetricsTable, type MeasureState, graphemes as splitGraphemes, hasTextClip, transformTextRuns } from '../layout.js';
import {
  BidiTextBuilder, bidiClass, bidiContextFor, lineLevels, resolveBidi, visualOrder,
  type BidiContext,
} from '../bidi.js';
import type { PathLike, Point } from './svg-path.js';

export interface Segment {
  text: string;
  style: ResolvedStyle;
  /** An atomic or block element starts a new CSS word for capitalize. */
  wordBoundaryBefore?: boolean;
  /**
   * Innermost `unicode-bidi` context around this text (an isolate, embedding
   * or override); null/absent = the path's own paragraph. Visual order comes
   * from UAX #9 over ALL segments together (src/bidi.ts), not per segment.
   */
  bidi?: BidiContext | null;
  /** Nearest ancestor-or-self element declaring background-clip:text + background.
   * Threaded because background-image/clip don't inherit, so text in a nested
   * inline child wouldn't carry them (mirrors the main renderer). */
  clipStyle?: ResolvedStyle;
  /** Nearest ancestor-or-self element declaring --rt-text-stroke-image. */
  strokeImageStyle?: ResolvedStyle;
}

export interface GlyphPlacement {
  /**
   * Renderable text unit — usually a single grapheme cluster, but joining
   * scripts (Arabic, Indic, Thai, Khmer, Myanmar, …) emit multi-grapheme runs
   * here so the browser can shape them correctly during fillText.
   */
  char: string;
  /** Origin of the glyph on the path (translate target before fillText). */
  x: number;
  y: number;
  /** Tangent angle at the glyph origin, in radians. */
  rotation: number;
  /** Advance width of the glyph or shaped run. */
  width: number;
  /** Resolved style to apply when drawing this glyph. */
  style: ResolvedStyle;
  /** Font ascent above the baseline (px) — used for visual extent. */
  ascent: number;
  /** Font descent below the baseline (px). */
  descent: number;
  /** Distance from the start of the text along the path (px). */
  pathOffset: number;
  /** True when this placement is a shaped run, not a single grapheme. */
  shaped: boolean;
  /** Nearest declaring element for background-clip:text (see Segment). */
  clipStyle?: ResolvedStyle;
  /** Nearest declaring element for --rt-text-stroke-image (see Segment). */
  strokeImageStyle?: ResolvedStyle;
  /** Natural-offset range [start, start+width) of the clip declarer's glyphs —
   * the fragment the clip gradient spans (mirrors the main renderer's
   * fragment box; a whole-text declarer spans the whole text). */
  clipRange?: { start: number; width: number };
  /** Same fragment range for the stroke-image declarer. */
  strokeImageRange?: { start: number; width: number };
}

export type AlignMode = 'left' | 'center' | 'right' | 'justify';

/**
 * Where the path runs relative to the rendered text.
 *  - `alphabetic` (default) — path = text baseline; descenders drop below.
 *  - `middle` — path runs through the vertical center of the text.
 *  - `top` — path runs along the top of the text.
 *  - `bottom` — path runs along the bottom (including descenders).
 *  - `hanging` / `ideographic` — approximations of the matching CSS values.
 */
export type TextBaseline =
  | 'alphabetic' | 'middle' | 'top' | 'bottom' | 'hanging' | 'ideographic';

interface LayoutInput {
  segments: Segment[];
  /** The paragraph direction (UAX #9 paragraph level); default `ltr`. */
  direction?: 'ltr' | 'rtl';
  path: PathLike;
  ctx: CanvasRenderingContext2D;
  align: AlignMode;
  textBaseline: TextBaseline;
  /** Where the call's font metrics are recorded, for paint (`layoutFontMetrics`). */
  fontMetrics?: FontMetricsTable;
}

export interface LayoutOutput {
  glyphs: GlyphPlacement[];
  /**
   * Natural width of the rendered text: the sum of the measured placement
   * widths (each already carrying its letter-spacing) less the trailing
   * letter-space of the last one, which must not hang off the end.
   */
  textWidth: number;
  pathLength: number;
  /**
   * Max line height across all segments. Resolved CSS line-height in px when
   * set; otherwise the segment's font size. Useful as the ribbon thickness
   * when drawing a background polygon around curved text.
   */
  lineHeight: number;
  /**
   * Visible bounding box of the rendered text in the layout's coordinate
   * system. Computed as the union of each glyph's cell, where the cell is
   * width × per-glyph line-height (CSS line-height in px when set, else
   * font size) and rotated by the glyph's tangent. lineHeight is
   * distributed above/below the baseline by the font's ascent/descent
   * ratio. Per-glyph (not max-across) so mixed-size curve text doesn't
   * inflate.
   *
   * Consumers (e.g. Polotno) use this to keep an element's width/height in
   * sync with the rendered model. The library does not consume `bounds`
   * itself — it's purely exposed for callers.
   */
  bounds: { x: number; y: number; width: number; height: number };
  /** The textBaseline mode used for this layout (echoes the input). */
  textBaseline: TextBaseline;
}

/**
 * Returns the local-y of the alphabetic baseline given a textBaseline
 * choice and a glyph's ascent/descent. All baseline-relative computations
 * (decoration positions, background polygons, bounds cells) ADD this offset
 * to their local-y so the path line through (0,0) corresponds to the
 * requested baseline anchor.
 */
export function baselineLocalY(
  tb: TextBaseline, ascent: number, descent: number,
): number {
  switch (tb) {
    case 'alphabetic':  return 0;
    case 'middle':      return (ascent - descent) / 2;
    case 'top':         return ascent;
    case 'bottom':      return -descent;
    case 'hanging':     return ascent * 0.8;
    case 'ideographic': return -descent * 0.5;
  }
}

/**
 * Flatten a styled tree into a flat sequence of styled text segments.
 * Walks in document order; text transforms keep word context across elements.
 * Each `#text` node contributes one segment with its resolved style.
 */
export function flattenSegments(root: StyledNode): Segment[] {
  const out: Segment[] = [];
  let wordBoundaryBefore = false;
  function walk(
    node: StyledNode,
    bidi: BidiContext | null,
    clipStyle?: ResolvedStyle,
    strokeImageStyle?: ResolvedStyle,
  ) {
    if (node.style.display === 'none') return;
    if (node.tagName === '#text' && node.textContent) {
      out.push({
        text: node.textContent, style: node.style, bidi, clipStyle, strokeImageStyle,
        wordBoundaryBefore,
      });
      wordBoundaryBefore = false;
      return;
    }
    const block = node !== root && node.style.display !== 'inline' && node.style.display !== 'contents';
    if (block) {
      wordBoundaryBefore = true;
    }
    // A path is ONE line, so a nested block cannot start a paragraph of its
    // own; it isolates its content in its own direction instead (HTML gives
    // blocks `unicode-bidi: isolate`). An inline element opens what its
    // `unicode-bidi` says.
    const ownBidi = node === root ? bidi
      : bidiContextFor(block ? 'isolate' : node.style.unicodeBidi, node.style.direction, bidi);
    // Track the nearest element declaring a background-clip:text background or
    // a --rt-text-stroke-image — those paints propagate to descendant glyphs
    // even though the properties don't inherit.
    const newClip = hasTextClip(node.style) ? node.style : clipStyle;
    const newStroke =
      node.style.webkitTextStrokeImage && node.style.webkitTextStrokeImage !== 'none'
        ? node.style : strokeImageStyle;
    for (const child of node.children) walk(child, ownBidi, newClip, newStroke);
  }
  walk(root, null);
  return transformTextRuns(out);
}

// Unicode ranges where graphemes need shape-aware rendering. The browser's
// fillText handles these correctly only when given the whole run at once,
// not one grapheme at a time:
//  - Hebrew (no joining, but RTL+BiDi)
//  - Arabic + presentation forms (cursive joining)
//  - N'Ko, Mandaic, Syriac, Thaana (joining/RTL)
//  - Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
//    Malayalam, Sinhala (Indic reordering + conjuncts)
//  - Thai, Lao (combining marks + word break)
//  - Tibetan (stacking)
//  - Myanmar (reordering + stacking)
//  - Khmer (reordering + subscript consonants)
// IMPORTANT: written with `\u` escapes only. Mixing literal RTL characters
// confuses the regex parser at parse time — e.g. the precomposed `יִ` is
// actually two code points (U+05D9 + U+05B4) and a literal range starting
// at the second code point engulfs CJK / Hangul / Hiragana / Katakana,
// causing `needsShaping('中')` to return true.
const SHAPING_RE = new RegExp(
  '[' +
    '\\u0590-\\u05FF' +            // Hebrew
    '\\u0600-\\u06FF' +            // Arabic
    '\\u0700-\\u074F' +            // Syriac
    '\\u0750-\\u077F' +            // Arabic Supplement
    '\\u0780-\\u07BF' +            // Thaana
    '\\u07C0-\\u07FF' +            // NKo
    '\\u0800-\\u083F' +            // Samaritan
    '\\u0840-\\u085F' +            // Mandaic
    '\\u0860-\\u086F' +            // Syriac Supplement
    '\\u08A0-\\u08FF' +            // Arabic Extended-A
    '\\u0900-\\u097F' +            // Devanagari
    '\\u0980-\\u09FF' +            // Bengali
    '\\u0A00-\\u0A7F' +            // Gurmukhi
    '\\u0A80-\\u0AFF' +            // Gujarati
    '\\u0B00-\\u0B7F' +            // Oriya
    '\\u0B80-\\u0BFF' +            // Tamil
    '\\u0C00-\\u0C7F' +            // Telugu
    '\\u0C80-\\u0CFF' +            // Kannada
    '\\u0D00-\\u0D7F' +            // Malayalam
    '\\u0D80-\\u0DFF' +            // Sinhala
    '\\u0E00-\\u0E7F' +            // Thai
    '\\u0E80-\\u0EFF' +            // Lao
    '\\u0F00-\\u0FFF' +            // Tibetan
    '\\u1000-\\u109F' +            // Myanmar
    '\\u1780-\\u17FF' +            // Khmer
    '\\u1800-\\u18AF' +            // Mongolian
    '\\uFB1D-\\uFB4F' +            // Hebrew Presentation Forms
    '\\uFB50-\\uFDFF' +            // Arabic Presentation Forms-A
    '\\uFE70-\\uFEFF' +            // Arabic Presentation Forms-B
  ']'
);

function needsShaping(s: string): boolean {
  return SHAPING_RE.test(s);
}

interface PreGlyph {
  /** Renderable text — one grapheme or one shaped run. */
  text: string;
  /** Advance width as measured by ctx.measureText AFTER applying the style. */
  width: number;
  style: ResolvedStyle;
  /** True when this is purely an ASCII U+0020 space (justify-eligible). */
  isSpace: boolean;
  ascent: number;
  descent: number;
  shaped: boolean;
  clipStyle?: ResolvedStyle;
  strokeImageStyle?: ResolvedStyle;
  /** UAX #9 level (uniform over the placement). */
  level: number;
}

/**
 * Classes a shaped run may hold: strong letters, marks and digits. A neutral
 * (Arabic comma, ؟) or a level change ends it, so every shaped run is
 * level-uniform AND free of neutrals — then fillText's own bidi pass, under any
 * base direction, orders its inside exactly as UAX #9 does, and L2 orders the
 * placements.
 */
const SHAPED_RUN_CLASSES = new Set(['L', 'R', 'AL', 'NSM', 'EN', 'AN']);

/**
 * Split a single styled segment into PreGlyphs, in LOGICAL order.
 *
 * Non-joining graphemes (Latin, CJK, …) emit one PreGlyph per grapheme so the
 * curve can drive per-glyph rotation. Joining-script graphemes are grouped
 * into runs (split at whitespace, style, level and neutral boundaries) so the
 * browser can shape them correctly when we later call fillText on the run as
 * a whole. `levels` are the segment's UAX #9 levels per UTF-16 unit; the
 * caller reorders the placements (L2) across ALL segments.
 */
function preGlyphsForSegment(
  m: Measurer,
  state: MeasureState,
  seg: Segment,
  levels: Uint8Array,
): PreGlyph[] {
  const graphemes = splitGraphemes(seg.text);
  if (graphemes.length === 0) return [];

  const { ascent, descent } = m.metrics(seg.style);

  // Group graphemes into (shaped run | single non-shaped grapheme).
  const runs: { text: string; shaped: boolean; isSpace: boolean; level: number }[] = [];
  let currentShapedRun = '';
  let currentLevel = -1;
  let offset = 0;
  const flush = () => {
    if (currentShapedRun) {
      runs.push({ text: currentShapedRun, shaped: true, isSpace: false, level: currentLevel });
      currentShapedRun = '';
    }
  };
  for (const g of graphemes) {
    const isSpace = g === ' ';
    const level = levels[offset];
    offset += g.length;
    const shapes = needsShaping(g) && !isSpace &&
      SHAPED_RUN_CLASSES.has(bidiClass(g.codePointAt(0)!));
    if (shapes) {
      if (currentShapedRun && level !== currentLevel) flush();
      currentShapedRun += g;
      currentLevel = level;
    } else {
      flush();
      runs.push({ text: g, shaped: false, isSpace, level });
    }
  }
  flush();

  // Measure each run under the segment's font, kerning and letter-spacing.
  const out: PreGlyph[] = [];
  for (const r of runs) {
    const width = m.measureText(state, r.text).width;
    out.push({
      text: r.text,
      width,
      style: seg.style,
      isSpace: r.isSpace,
      ascent,
      descent,
      shaped: r.shaped,
      clipStyle: seg.clipStyle,
      strokeImageStyle: seg.strokeImageStyle,
      level: r.level,
    });
  }
  return out;
}

/**
 * Lay out graphemes along a path. Pure: does not call ctx.fillText.
 *
 * Algorithm:
 *  1. Per segment, split into graphemes and shaped runs, measure each.
 *  2. Compute total natural width.
 *  3. Pick a starting offset along the path based on `align`.
 *  4. For each placement: get p0 / p1 from the path, rotation = atan2(p1-p0).
 *     If a placement would overshoot, only allow it within kerning slack.
 */
export function layoutGlyphsOnPath(input: LayoutInput): LayoutOutput {
  const { segments, path, ctx, align, textBaseline } = input;

  // 1. Pre-measure all placements (one per grapheme or shaped run).
  // Caller's ctx state is mutated here (font, fontKerning, letterSpacing, and
  // a non-zero wordSpacing reset to 0px).
  // The outer drawTextOnPath/drawTextOnPathLayout calls ctx.save before this
  // and ctx.restore after, so the leak doesn't reach the caller.
  const m = new Measurer(ctx, input.fontMetrics ?? new Map());
  // Bidi levels over the whole text: the path is one line of one paragraph.
  const builder = new BidiTextBuilder();
  const starts = segments.map((seg) => builder.push(seg.text, seg.bidi ?? null));
  builder.enter(null);
  const paragraph = resolveBidi(builder.text, input.direction === 'rtl' ? 1 : 0);
  const levels = lineLevels(paragraph, 0, builder.text.length);
  const logical: PreGlyph[] = [];
  let measuredWholeWidth = 0;
  let maxLineHeight = 0;
  segments.forEach((seg, i) => {
    if (!seg.text) return;
    const lh = seg.style.lineHeight > 0 ? seg.style.lineHeight : seg.style.fontSize;
    if (lh > maxLineHeight) maxLineHeight = lh;
    const state = m.stateOf(seg.style);
    // A decoration hangs off its DECLARER's metrics: record them with the
    // layout, so paint reads what this call measured (`layoutFontMetrics`).
    for (const deco of seg.style.textDecorations) m.metrics(deco.declarer);
    const segGlyphs = preGlyphsForSegment(
      m, state, seg, levels.subarray(starts[i], starts[i] + seg.text.length));
    if (segGlyphs.length === 0) return;
    logical.push(...segGlyphs);
    // Whole-segment width — kerning makes this < sum of per-glyph widths.
    measuredWholeWidth += m.measureText(state, seg.text).width;
  });
  // UAX #9 L2: placements in visual order, across segments.
  const preGlyphs = visualOrder(logical.map((g) => g.level)).map((i) => logical[i]);

  // 2. Sum natural width. `g.width` came out of measureText with
  // ctx.letterSpacing ALREADY applied, so it carries one letter-space per
  // grapheme in the run — a trailing one included. Adding letterSpacing again
  // here would double it. (Chrome folds the spacing into the advance:
  // `ctx.letterSpacing='40px'; measureText('ABC').width` is 3 advances plus
  // THREE spaces, not two.)
  let textWidth = 0;
  for (const g of preGlyphs) {
    textWidth += g.width;
  }
  // Trim the last letterSpacing — it shouldn't trail.
  //
  // DO NOT "fix" this to match how a browser centres a line box. A browser
  // centres the ADVANCE box, trailing space included; this centres the INK.
  // The reason is consistency for the thing curved text is FOR: a curve with a
  // very large radius must print where the same text prints straight. Measured
  // through Polotno's own pipeline, `ABC` at letterSpacing 1em in a 600px box —
  // straight, a near-flat curve, and a gentle arc:
  //
  //   with this trim:     299 / 299 / 299   (ink width 160 in all three)
  //   without this trim:  299 / 279 / 279
  //
  // Straight text is centred on its ink too (the consumer widens the layout box
  // by the trailing space to get there), so dropping the trim leaves a nearly
  // flat curve half a letter-space off from identical straight text.
  if (preGlyphs.length > 0) {
    textWidth -= preGlyphs[preGlyphs.length - 1].style.letterSpacing || 0;
  }

  // Kerning slack: how much the per-glyph sum can exceed the measured
  // whole-string width. When the path is sized to match the visual text,
  // we use this to allow up to N px of overshoot at the path's tail end.
  const kerningSlack = Math.max(0, textWidth - measuredWholeWidth);

  // 3. Starting offset + per-space extra (justify).
  const pathLength = path.length;
  let startOffset = 0;
  let extraPerSpace = 0;
  if (align === 'center') {
    startOffset = Math.max(0, (pathLength - textWidth) / 2);
  } else if (align === 'right') {
    startOffset = Math.max(0, pathLength - textWidth);
  } else if (align === 'justify') {
    const spaceCount = preGlyphs.filter(g => g.isSpace).length;
    if (spaceCount > 0 && pathLength > textWidth) {
      extraPerSpace = (pathLength - textWidth) / spaceCount;
    }
  }

  // 4. Walk the path.
  // We track two cumulative offsets:
  //  - `offset` is the path arc-length (used for path.getPointAtLength), and
  //    advances by `effectiveWidth` (incl. justify extraPerSpace).
  //  - `naturalOffset` is the glyph's position in NATURAL text-space
  //    [0, textWidth]. Used as `pathOffset` for gradient slicing — must NOT
  //    include extraPerSpace, otherwise late justified glyphs map past the
  //    gradient's last stop.
  const glyphs: GlyphPlacement[] = [];
  let offset = startOffset;
  let naturalOffset = 0;
  for (let i = 0; i < preGlyphs.length; i++) {
    const g = preGlyphs[i];
    // The LAST placement advances by its ink alone: `textWidth` above drops its
    // trailing letter-space, so advancing by the full measured width would walk
    // one space past the width we reported. On a path sized to `textWidth` —
    // which is what `align: right` and `justify` produce — that overshoot fell
    // outside `kerningSlack` and dropped the final glyph outright.
    const trailing =
      i === preGlyphs.length - 1 ? g.style.letterSpacing || 0 : 0;
    const effectiveWidth =
      g.width - trailing + (g.isSpace ? extraPerSpace : 0);
    const p0 = path.getPointAtLength(offset);
    if (!p0) break;

    let endLen = offset + effectiveWidth;
    let p1: Point | null;
    if (endLen > pathLength) {
      // Clamp to pathLength only if the overshoot is within the kerning slack —
      // keeps the last glyph from getting dropped to a sub-px rounding miss.
      if (endLen - pathLength <= kerningSlack + 0.5) {
        p1 = path.getPointAtLength(pathLength);
      } else {
        break;
      }
    } else {
      p1 = path.getPointAtLength(endLen);
    }
    if (!p1) break;

    const rotation = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    glyphs.push({
      char: g.text,
      x: p0.x,
      y: p0.y,
      rotation,
      // Trimmed for the last placement, like the advance above: this width is
      // also the glyph's decoration span and its cell in `bounds`, and neither
      // should reach into a trailing space no glyph occupies.
      width: g.width - trailing,
      style: g.style,
      ascent: g.ascent,
      descent: g.descent,
      pathOffset: naturalOffset,
      shaped: g.shaped,
      clipStyle: g.clipStyle,
      strokeImageStyle: g.strokeImageStyle,
    });

    // `g.width` already includes this glyph's trailing letter-space (see the
    // textWidth sum above), so the advance is the measured width alone — less
    // the last one's trailing space, so the walk ends exactly on `textWidth`
    // and `pathOffset + width` never overruns the range gradients slice by.
    offset = endLen;
    naturalOffset += effectiveWidth - (g.isSpace ? extraPerSpace : 0);
  }

  assignFragmentRanges(glyphs, g => g.clipStyle, (g, r) => { g.clipRange = r; });
  assignFragmentRanges(glyphs, g => g.strokeImageStyle, (g, r) => { g.strokeImageRange = r; });

  const bounds = computeBounds(glyphs, textBaseline);
  return {
    glyphs,
    textWidth,
    pathLength,
    lineHeight: maxLineHeight,
    bounds,
    textBaseline,
  };
}

/**
 * Compute the natural-offset range spanned by each contiguous group of glyphs
 * sharing the same paint declarer (identity of the declaring element's style),
 * and assign it to every glyph in the group. This is the path equivalent of
 * the main renderer's fragment box: the declarer's gradient spans its own
 * glyphs, not the whole text.
 */
function assignFragmentRanges(
  glyphs: GlyphPlacement[],
  keyOf: (g: GlyphPlacement) => ResolvedStyle | undefined,
  assign: (g: GlyphPlacement, range: { start: number; width: number }) => void,
): void {
  for (let i = 0; i < glyphs.length;) {
    const declarer = keyOf(glyphs[i]);
    if (!declarer) { i++; continue; }
    let j = i;
    while (j < glyphs.length && keyOf(glyphs[j]) === declarer) j++;
    const start = glyphs[i].pathOffset;
    const last = glyphs[j - 1];
    const range = { start, width: last.pathOffset + last.width - start };
    for (let k = i; k < j; k++) assign(glyphs[k], range);
    i = j;
  }
}

/**
 * Bounding box of the rendered text: union of each glyph's
 * `width × per-glyph line-height` cell, rotated by the glyph's tangent.
 *
 * The cell height is the per-glyph line-height (CSS line-height when set,
 * else font-size — Polotno's chosen metric). It is distributed
 * ASYMMETRICALLY above/below the baseline using the font's natural
 * ascent/descent ratio, so cap-height + ascender area is covered and the
 * cell doesn't waste pixels below an empty descender. For a typical font
 * with ascent ~25 / descent ~7 / lineHeight 32, the cell extends ~25px
 * above and ~7px below the baseline, matching the painted glyph extent.
 *
 * Empty layouts return `{ x: 0, y: 0, width: 0, height: 0 }`.
 */
function computeBounds(
  glyphs: GlyphPlacement[],
  textBaseline: TextBaseline,
): { x: number; y: number; width: number; height: number } {
  if (glyphs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of glyphs) {
    const lh = g.style.lineHeight > 0 ? g.style.lineHeight : g.style.fontSize;
    // Distribute the lineHeight above/below the baseline by the font's
    // natural ascent/descent ratio (CSS line-box half-leading semantics).
    const fontHeight = g.ascent + g.descent;
    const ascentShare = fontHeight > 0 ? g.ascent / fontHeight : 0.75;
    const topFromBaseline = lh * ascentShare;        // above baseline
    const bottomFromBaseline = lh * (1 - ascentShare); // below baseline
    // Shift by the local-y of the baseline so the cell stays correct under
    // any textBaseline (e.g. 'middle' places the cell vertically centred
    // on the path; 'top' moves the entire cell down).
    const baseY = baselineLocalY(textBaseline, g.ascent, g.descent);
    const top = baseY - topFromBaseline;
    const bottom = baseY + bottomFromBaseline;
    const c = Math.cos(g.rotation);
    const s = Math.sin(g.rotation);
    // Local cell: x in [0, width], y in [top, bottom]. Rotate + translate.
    const corners = [
      { x: g.x + (-s) * top, y: g.y + c * top },
      { x: g.x + c * g.width + (-s) * top, y: g.y + s * g.width + c * top },
      { x: g.x + c * g.width + (-s) * bottom, y: g.y + s * g.width + c * bottom },
      { x: g.x + (-s) * bottom, y: g.y + c * bottom },
    ];
    for (const p of corners) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
