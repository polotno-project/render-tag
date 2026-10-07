/**
 * Pure layout: lays each grapheme of styled segments along a path, without
 * drawing. Joining scripts (Arabic, Indic, Thai, …) are grouped into one
 * "shaped run" placement so fillText can shape the run as a unit.
 */

import type { ResolvedStyle, StyledNode } from '../types.js';
import { Measurer, type FontMetricsTable, type MeasureState, graphemes as splitGraphemes, hasStrokeImage, hasTextClip, transformTextRuns } from '../layout.js';
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
   * Union of each glyph's rotated `width x line-height` cell (CSS line-height
   * in px when set, else font size), split above/below the baseline by the
   * font's ascent/descent ratio. For callers; render-tag does not read it.
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
    const newStroke = hasStrokeImage(node.style) ? node.style : strokeImageStyle;
    for (const child of node.children) walk(child, ownBidi, newClip, newStroke);
  }
  walk(root, null);
  return transformTextRuns(out);
}

// Scripts fillText must shape as whole runs: Hebrew, Arabic, Syriac, Thaana,
// NKo, Samaritan, Mandaic, Indic, Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian
// and the Hebrew/Arabic presentation forms. `\u` escapes only: a literal RTL
// code point can silently corrupt the class (it once matched CJK).
const SHAPING_RE = /[\u0590-\u086F\u08A0-\u109F\u1780-\u18AF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

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
  const out: PreGlyph[] = [];
  const emit = (text: string, shaped: boolean, isSpace: boolean, level: number) => {
    out.push({
      text,
      width: m.measureText(state, text).width,
      style: seg.style,
      isSpace,
      ascent,
      descent,
      shaped,
      clipStyle: seg.clipStyle,
      strokeImageStyle: seg.strokeImageStyle,
      level,
    });
  };
  let shapedRun = '';
  let runLevel = -1;
  let offset = 0;
  const flush = () => {
    if (shapedRun) {
      emit(shapedRun, true, false, runLevel);
      shapedRun = '';
    }
  };
  for (const g of graphemes) {
    const isSpace = g === ' ';
    const level = levels[offset];
    offset += g.length;
    const shapes = !isSpace && SHAPING_RE.test(g) &&
      SHAPED_RUN_CLASSES.has(bidiClass(g.codePointAt(0)!));
    if (shapes) {
      if (shapedRun && level !== runLevel) flush();
      shapedRun += g;
      runLevel = level;
    } else {
      flush();
      emit(g, false, isSpace, level);
    }
  }
  flush();
  return out;
}

/**
 * Lay out graphemes along a path: measure each placement, align the natural
 * width on the path, then rotate each placement to the tangent between its
 * ends. A placement past the path's end is dropped beyond the kerning slack.
 */
export function layoutGlyphsOnPath(input: LayoutInput): LayoutOutput {
  const { segments, path, ctx, align, textBaseline } = input;

  // Mutates the ctx's font state; layoutTextOnPath saves/restores a caller's ctx.
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
    const lh = cellHeight(seg.style);
    if (lh > maxLineHeight) maxLineHeight = lh;
    const state = m.stateOf(seg.style);
    // Paint reads the decoration declarers' metrics from this call's table.
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

  // measureText widths already carry one letter-space per grapheme, the
  // trailing one included (Chrome: 'ABC' at 40px spacing = 3 advances + 3 spaces).
  let textWidth = 0;
  for (const g of preGlyphs) {
    textWidth += g.width;
  }
  // Drop the trailing letter-space: curved text centres its INK, like straight
  // text in Polotno, so a near-flat curve prints where straight text does.
  // Do not "fix" this to the browser's advance-box centring.
  if (preGlyphs.length > 0) {
    textWidth -= preGlyphs[preGlyphs.length - 1].style.letterSpacing || 0;
  }

  // How far the per-glyph sum exceeds the kerned whole-string width: the
  // overshoot allowed at the path's end.
  const kerningSlack = Math.max(0, textWidth - measuredWholeWidth);

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

  // `offset` walks the path (justify extra included); `naturalOffset` is the
  // position in [0, textWidth] that gradients slice by (justify extra excluded).
  const glyphs: GlyphPlacement[] = [];
  let offset = startOffset;
  let naturalOffset = 0;
  for (let i = 0; i < preGlyphs.length; i++) {
    const g = preGlyphs[i];
    // The last placement drops its trailing letter-space, like `textWidth`, so a
    // path sized to `textWidth` keeps its final glyph (and its decoration/bounds cell).
    const trailing =
      i === preGlyphs.length - 1 ? g.style.letterSpacing || 0 : 0;
    const effectiveWidth =
      g.width - trailing + (g.isSpace ? extraPerSpace : 0);
    const p0 = path.getPointAtLength(offset);
    if (!p0) break;

    let endLen = offset + effectiveWidth;
    let p1: Point | null;
    if (endLen > pathLength) {
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
      width: g.width - trailing,
      style: g.style,
      ascent: g.ascent,
      descent: g.descent,
      pathOffset: naturalOffset,
      shaped: g.shaped,
      clipStyle: g.clipStyle,
      strokeImageStyle: g.strokeImageStyle,
    });

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
 * Give each contiguous run of glyphs under one paint declarer the
 * natural-offset range the run spans: the path's fragment box.
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

/** CSS line-height in px when set, else the font size (Polotno's cell metric). */
function cellHeight(style: ResolvedStyle): number {
  return style.lineHeight > 0 ? style.lineHeight : style.fontSize;
}

/** The corners tl, tr, br, bl of a glyph's local box `[0, width] x [top, bottom]`, in world space. */
export function rotatedBox(g: GlyphPlacement, top: number, bottom: number): Point[] {
  const c = Math.cos(g.rotation);
  const s = Math.sin(g.rotation);
  const w = g.width;
  return [
    { x: g.x + (-s) * top, y: g.y + c * top },
    { x: g.x + c * w + (-s) * top, y: g.y + s * w + c * top },
    { x: g.x + c * w + (-s) * bottom, y: g.y + s * w + c * bottom },
    { x: g.x + (-s) * bottom, y: g.y + c * bottom },
  ];
}

/**
 * Union of each glyph's `width x cellHeight` cell, rotated by its tangent. The
 * cell splits above/below the baseline by the font's ascent/descent ratio.
 */
function computeBounds(
  glyphs: GlyphPlacement[],
  textBaseline: TextBaseline,
): { x: number; y: number; width: number; height: number } {
  if (glyphs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of glyphs) {
    const lh = cellHeight(g.style);
    const fontHeight = g.ascent + g.descent;
    const ascentShare = fontHeight > 0 ? g.ascent / fontHeight : 0.75;
    const baseY = baselineLocalY(textBaseline, g.ascent, g.descent);
    for (const p of rotatedBox(g, baseY - lh * ascentShare, baseY + lh * (1 - ascentShare))) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
