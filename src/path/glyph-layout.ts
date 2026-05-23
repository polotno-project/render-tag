/**
 * Pure layout: walks styled segments and lays each grapheme along a path.
 * No canvas rendering happens here — that's the caller's job. Reusable
 * for hit-testing, debugging, alternate renderers (SVG, GPU).
 */

import type { ResolvedStyle, StyledNode } from '../types.js';
import { applyFont } from '../layout.js';
import { stringToArray } from './grapheme.js';
import type { PathLike, Point } from './svg-path.js';

export interface Segment {
  text: string;
  style: ResolvedStyle;
  /** True when this segment should be laid out right-to-left. */
  rtl: boolean;
}

export interface GlyphPlacement {
  /** Single grapheme cluster. */
  char: string;
  /** Origin of the glyph on the path (where to translate to before fillText). */
  x: number;
  y: number;
  /** Tangent angle at the glyph origin, in radians. */
  rotation: number;
  /** Advance width of the glyph (without letterSpacing). */
  width: number;
  /** Resolved style to apply when drawing this glyph. */
  style: ResolvedStyle;
}

export type AlignMode = 'left' | 'center' | 'right' | 'justify';

export interface LayoutInput {
  segments: Segment[];
  path: PathLike;
  ctx: CanvasRenderingContext2D;
  align: AlignMode;
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
}

/**
 * Flatten a styled tree into a flat sequence of styled text segments.
 * Walks in document order; concatenates text under nested inline elements.
 * Each `#text` node contributes one segment with its resolved style.
 */
export function flattenSegments(root: StyledNode): Segment[] {
  const out: Segment[] = [];
  function walk(node: StyledNode, inheritedRtl: boolean) {
    const rtl = node.style.direction === 'rtl' || inheritedRtl;
    if (node.tagName === '#text' && node.textContent) {
      out.push({ text: node.textContent, style: node.style, rtl });
      return;
    }
    for (const child of node.children) walk(child, rtl);
  }
  walk(root, false);
  return out;
}

interface PreGlyph {
  char: string;
  width: number;
  style: ResolvedStyle;
  /** True for space characters — relevant for justify expansion. */
  isSpace: boolean;
}

/**
 * Lay out graphemes along a path. Pure: does not call ctx.fillText.
 *
 * Algorithm:
 *  1. Per segment, split into graphemes and measure each via ctx.measureText.
 *     RTL segments have their grapheme order reversed before walking the path
 *     (so a left-to-right path walk produces correct visual order).
 *  2. Compute total natural width.
 *  3. Pick a starting offset along the path based on `align`.
 *  4. For each grapheme:
 *       p0 = path.getPointAtLength(offset)
 *       p1 = path.getPointAtLength(offset + width)
 *       rotation = atan2(p1.y - p0.y, p1.x - p0.x)
 *     A trailing kerning slack (sum-of-glyph-widths > whole-string width)
 *     can push the last glyph 1–2px past pathLength; clamp the end point
 *     to pathLength in that narrow case to avoid dropping the last glyph.
 *  5. If a glyph would extend past the path entirely, stop emitting.
 */
export function layoutGlyphsOnPath(input: LayoutInput): LayoutOutput {
  const { segments, path, ctx, align } = input;

  // 1. Pre-measure all graphemes, segment-by-segment.
  // Caller's ctx state is mutated here (font, fontKerning, letterSpacing).
  // The outer drawTextOnPath/drawTextOnPathLayout calls ctx.save before this
  // and ctx.restore after, so the leak doesn't reach the caller.
  const preGlyphs: PreGlyph[] = [];
  let measuredWholeWidth = 0;
  let maxLineHeight = 0;
  for (const seg of segments) {
    if (!seg.text) continue;
    const graphemes = stringToArray(seg.text);
    if (graphemes.length === 0) continue;
    if (seg.rtl) graphemes.reverse();
    applyFont(ctx, seg.style);
    // Always assign — when the current segment's letterSpacing is 0/unset,
    // we still need to reset the previous segment's value.
    ctx.letterSpacing = `${seg.style.letterSpacing || 0}px` as any;
    // Track ribbon thickness: CSS line-height in px when set, else font size.
    const lh = seg.style.lineHeight > 0 ? seg.style.lineHeight : seg.style.fontSize;
    if (lh > maxLineHeight) maxLineHeight = lh;
    // Per-glyph width via measureText (browsers honor letterSpacing here).
    for (const g of graphemes) {
      const m = ctx.measureText(g);
      preGlyphs.push({
        char: g,
        width: m.width,
        style: seg.style,
        // Only ASCII space (U+0020) is justify-eligible. \n/\t/&nbsp; and
        // other Unicode whitespace must NOT expand — that would break
        // no-break-space contract and treat <br>-synthesized newlines as
        // expansible spaces.
        isSpace: g === ' ',
      });
    }
    // Whole-segment width — kerning makes this < sum of per-glyph widths.
    measuredWholeWidth += ctx.measureText(seg.text).width;
  }

  // 2. Sum natural width (sum of glyph widths + letterSpacing per glyph).
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
  const glyphs: GlyphPlacement[] = [];
  let offset = startOffset;
  for (let i = 0; i < preGlyphs.length; i++) {
    const g = preGlyphs[i];
    const effectiveWidth = g.width + (g.isSpace ? extraPerSpace : 0);
    const p0 = path.getPointAtLength(offset);
    if (!p0) break;

    let endLen = offset + effectiveWidth;
    let p1: Point | null;
    if (endLen > pathLength) {
      // Clamp to pathLength only if the overshoot is within the kerning slack —
      // matches konva's behavior to keep the last glyph from getting dropped.
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
      char: g.char,
      x: p0.x,
      y: p0.y,
      rotation,
      width: g.width,
      style: g.style,
    });

    offset = endLen + (g.style.letterSpacing || 0);
  }

  return { glyphs, textWidth, pathLength, lineHeight: maxLineHeight };
}
