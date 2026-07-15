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
import { applyFont, getFontMetrics, hasTextClip } from '../layout.js';
import { stringToArray } from './grapheme.js';
import type { PathLike, Point } from './svg-path.js';

export interface Segment {
  text: string;
  style: ResolvedStyle;
  /** True when this segment should be laid out right-to-left. */
  rtl: boolean;
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

export interface LayoutInput {
  segments: Segment[];
  path: PathLike;
  ctx: CanvasRenderingContext2D;
  align: AlignMode;
  textBaseline: TextBaseline;
}

export interface LayoutOutput {
  glyphs: GlyphPlacement[];
  /** Sum of glyph widths + letterSpacing (the natural width of the rendered text). */
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
 * Walks in document order; concatenates text under nested inline elements.
 * Each `#text` node contributes one segment with its resolved style.
 */
export function flattenSegments(root: StyledNode): Segment[] {
  const out: Segment[] = [];
  function walk(
    node: StyledNode,
    inheritedRtl: boolean,
    clipStyle?: ResolvedStyle,
    strokeImageStyle?: ResolvedStyle,
  ) {
    const rtl = node.style.direction === 'rtl' || inheritedRtl;
    if (node.tagName === '#text' && node.textContent) {
      out.push({ text: node.textContent, style: node.style, rtl, clipStyle, strokeImageStyle });
      return;
    }
    // Track the nearest element declaring a background-clip:text background or
    // a --rt-text-stroke-image — those paints propagate to descendant glyphs
    // even though the properties don't inherit.
    const newClip = hasTextClip(node.style) ? node.style : clipStyle;
    const newStroke =
      node.style.webkitTextStrokeImage && node.style.webkitTextStrokeImage !== 'none'
        ? node.style : strokeImageStyle;
    for (const child of node.children) walk(child, rtl, newClip, newStroke);
  }
  walk(root, false);
  return out;
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
}

/**
 * Split a single styled segment into PreGlyphs.
 *
 * Non-joining graphemes (Latin, CJK, …) emit one PreGlyph per grapheme so the
 * curve can drive per-glyph rotation. Joining-script graphemes are grouped
 * into runs (split at whitespace + style boundaries) so the browser can shape
 * them correctly when we later call fillText on the run as a whole.
 *
 * For RTL segments, the RUN ORDER is reversed (not the graphemes inside a
 * shaped run) — that way Arabic words still shape correctly while flowing in
 * visual right-to-left order along an LTR path walk.
 */
function preGlyphsForSegment(
  ctx: CanvasRenderingContext2D,
  seg: Segment,
): PreGlyph[] {
  const graphemes = stringToArray(seg.text);
  if (graphemes.length === 0) return [];

  applyFont(ctx, seg.style);
  // Always assign — when the current segment's letterSpacing is 0/unset,
  // we still need to reset the previous segment's value.
  ctx.letterSpacing = `${seg.style.letterSpacing || 0}px` as any;
  const { ascent, descent } = getFontMetrics(ctx, seg.style);

  // Group graphemes into (shaped run | single non-shaped grapheme).
  // Boundaries: shape-status change, ASCII whitespace.
  const runs: { text: string; shaped: boolean; isSpace: boolean }[] = [];
  let currentShapedRun = '';
  for (const g of graphemes) {
    const isSpace = g === ' ';
    if (needsShaping(g) && !isSpace) {
      currentShapedRun += g;
    } else {
      if (currentShapedRun) {
        runs.push({ text: currentShapedRun, shaped: true, isSpace: false });
        currentShapedRun = '';
      }
      runs.push({ text: g, shaped: false, isSpace });
    }
  }
  if (currentShapedRun) {
    runs.push({ text: currentShapedRun, shaped: true, isSpace: false });
  }

  // RTL: reverse run order. Don't reverse graphemes inside a shaped run —
  // the browser will lay them out right-to-left during fillText.
  if (seg.rtl) runs.reverse();

  // Measure each run with the current ctx font/letterSpacing.
  const out: PreGlyph[] = [];
  for (const r of runs) {
    const width = ctx.measureText(r.text).width;
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
  // Caller's ctx state is mutated here (font, fontKerning, letterSpacing).
  // The outer drawTextOnPath/drawTextOnPathLayout calls ctx.save before this
  // and ctx.restore after, so the leak doesn't reach the caller.
  const preGlyphs: PreGlyph[] = [];
  let measuredWholeWidth = 0;
  let maxLineHeight = 0;
  for (const seg of segments) {
    if (!seg.text) continue;
    const lh = seg.style.lineHeight > 0 ? seg.style.lineHeight : seg.style.fontSize;
    if (lh > maxLineHeight) maxLineHeight = lh;
    const segGlyphs = preGlyphsForSegment(ctx, seg);
    if (segGlyphs.length === 0) continue;
    preGlyphs.push(...segGlyphs);
    // Whole-segment width — kerning makes this < sum of per-glyph widths.
    measuredWholeWidth += ctx.measureText(seg.text).width;
  }

  // 2. Sum natural width (sum of placement widths + letterSpacing per item).
  let textWidth = 0;
  for (const g of preGlyphs) {
    textWidth += g.width + (g.style.letterSpacing || 0);
  }
  // Trim the last letterSpacing — it shouldn't trail.
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
    const effectiveWidth = g.width + (g.isSpace ? extraPerSpace : 0);
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
      width: g.width,
      style: g.style,
      ascent: g.ascent,
      descent: g.descent,
      pathOffset: naturalOffset,
      shaped: g.shaped,
      clipStyle: g.clipStyle,
      strokeImageStyle: g.strokeImageStyle,
    });

    offset = endLen + (g.style.letterSpacing || 0);
    naturalOffset += g.width + (g.style.letterSpacing || 0);
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
