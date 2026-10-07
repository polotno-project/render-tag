/** Lays each grapheme of styled segments along a path; joining scripts form
 * one "shaped run" placement so fillText shapes them as a unit. */

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
  /** Innermost `unicode-bidi` context; null = the path's paragraph. */
  bidi?: BidiContext | null;
  /** Nearest background-clip:text declarer (CLAUDE.md paint propagation). */
  clipStyle?: ResolvedStyle;
  /** Nearest --rt-text-stroke-image declarer. */
  strokeImageStyle?: ResolvedStyle;
}

export interface GlyphPlacement {
  /** One grapheme, or a multi-grapheme shaped run for joining scripts. */
  char: string;
  /** Glyph origin on the path. */
  x: number;
  y: number;
  /** Tangent angle, radians. */
  rotation: number;
  width: number;
  style: ResolvedStyle;
  ascent: number;
  descent: number;
  /** Natural offset from the start of the text. */
  pathOffset: number;
  shaped: boolean;
  clipStyle?: ResolvedStyle;
  strokeImageStyle?: ResolvedStyle;
  /** The clip declarer's fragment range, which its gradient spans. */
  clipRange?: { start: number; width: number };
  /** The stroke-image declarer's fragment range. */
  strokeImageRange?: { start: number; width: number };
}

export type AlignMode = 'left' | 'center' | 'right' | 'justify';

/** Where the path runs relative to the text (`alphabetic` = baseline);
 * `hanging` and `ideographic` approximate the CSS values. */
export type TextBaseline =
  | 'alphabetic' | 'middle' | 'top' | 'bottom' | 'hanging' | 'ideographic';

interface LayoutInput {
  segments: Segment[];
  /** Paragraph direction; default `ltr`. */
  direction?: 'ltr' | 'rtl';
  path: PathLike;
  ctx: CanvasRenderingContext2D;
  align: AlignMode;
  textBaseline: TextBaseline;
  /** Records the call's font metrics for paint (`layoutFontMetrics`). */
  fontMetrics?: FontMetricsTable;
}

export interface LayoutOutput {
  glyphs: GlyphPlacement[];
  /** Natural width, less the last placement's trailing letter-space. */
  textWidth: number;
  pathLength: number;
  /** Max CSS line-height in px (else font size) across segments. */
  lineHeight: number;
  /** Union of each glyph's rotated `width x line-height` cell, split at the
   * baseline by the font's ascent/descent ratio. For callers; render-tag
   * does not read it. */
  bounds: { x: number; y: number; width: number; height: number };
  textBaseline: TextBaseline;
}

/** Local y of the alphabetic baseline when the path runs at `tb`. */
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

/** A styled tree as text segments in document order, one per `#text`. */
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
    // One line: a nested block isolates its content (HTML's `unicode-bidi: isolate`).
    const ownBidi = node === root ? bidi
      : bidiContextFor(block ? 'isolate' : node.style.unicodeBidi, node.style.direction, bidi);
    const newClip = hasTextClip(node.style) ? node.style : clipStyle;
    const newStroke = hasStrokeImage(node.style) ? node.style : strokeImageStyle;
    for (const child of node.children) walk(child, ownBidi, newClip, newStroke);
  }
  walk(root, null);
  return transformTextRuns(out);
}

// Scripts fillText must shape as whole runs. `\u` escapes only: a literal RTL
// code point can silently corrupt the class.
const SHAPING_RE = /[\u0590-\u086F\u08A0-\u109F\u1780-\u18AF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

interface PreGlyph {
  text: string;
  width: number;
  style: ResolvedStyle;
  /** U+0020 (justify-eligible). */
  isSpace: boolean;
  ascent: number;
  descent: number;
  shaped: boolean;
  clipStyle?: ResolvedStyle;
  strokeImageStyle?: ResolvedStyle;
  /** UAX #9 level. */
  level: number;
}

/** Classes a shaped run may hold. Without neutrals and at one level, fillText's
 * own bidi pass orders the run's inside exactly as UAX #9 does. */
const SHAPED_RUN_CLASSES = new Set(['L', 'R', 'AL', 'NSM', 'EN', 'AN']);

/** A segment's PreGlyphs in logical order: one per grapheme, joining-script
 * graphemes grouped into shaped runs. The caller reorders all segments (L2). */
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

/** Measure placements, align them on the path, and rotate each to the tangent
 * between its ends; one past the path's end beyond the kerning slack is dropped. */
export function layoutGlyphsOnPath(input: LayoutInput): LayoutOutput {
  const { segments, path, ctx, align, textBaseline } = input;

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
    for (const deco of seg.style.textDecorations) m.metrics(deco.declarer);
    const segGlyphs = preGlyphsForSegment(
      m, state, seg, levels.subarray(starts[i], starts[i] + seg.text.length));
    if (segGlyphs.length === 0) return;
    logical.push(...segGlyphs);
    measuredWholeWidth += m.measureText(state, seg.text).width;
  });
  // UAX #9 L2: placements in visual order, across segments.
  const preGlyphs = visualOrder(logical.map((g) => g.level)).map((i) => logical[i]);

  let textWidth = 0;
  for (const g of preGlyphs) {
    textWidth += g.width;
  }
  // Drop the trailing letter-space so curved text centres its INK like Polotno's
  // straight text. Do not "fix" this: `ABC`, 1em spacing, 600px box, straight /
  // near-flat / arc prints at 299/299/299 with the trim, 299/279/279 without.
  if (preGlyphs.length > 0) {
    textWidth -= preGlyphs[preGlyphs.length - 1].style.letterSpacing || 0;
  }

  // Kerning makes the whole string narrower than the per-glyph sum.
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
    // Trimmed like `textWidth`, so a path of that length keeps the last glyph.
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

/** Each run of glyphs under one declarer gets its natural-offset range. */
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

/** Union of each glyph's `width x cellHeight` cell rotated by its tangent,
 * split above and below the baseline by the font's ascent/descent ratio.
 * See `LayoutOutput.bounds`. */
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
