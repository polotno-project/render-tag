/**
 * render-tag/path — draw rich text along an SVG path on a 2D canvas.
 *
 * Reuses render-tag's HTML+CSS pipeline (parseHTML, resolveStylesFromCSS) and
 * font primitives (applyFont) so styled spans, fonts, and colors come straight
 * from the input HTML — no separate option surface.
 *
 *   import { drawTextOnPath } from 'render-tag/path';
 *   drawTextOnPath({
 *     html: '<b>Hello</b> <span style="color:red">world</span>',
 *     path: 'M0,50 Q200,0 400,50',
 *     ctx,
 *     align: 'center',
 *   });
 *
 * For finer control:
 *   const result = layoutTextOnPath({ html, path, align });
 *   drawTextOnPathLayout({ layout: result, ctx });
 *
 * Supported styles (matches the main renderer):
 *   font-family / size / weight / style / kerning
 *   color, -webkit-text-fill-color, -webkit-text-stroke (width + color), paint-order
 *   background-color (span backgrounds drawn as curve-following polygons)
 *   text-shadow (rotates with glyphs; multi-shadow supported)
 *   text-decoration: underline / line-through / overline (solid/dotted/dashed/double/wavy)
 *   text-decoration-color, text-decoration-style
 *   background-clip:text + background-image:linear-gradient (gradient flows along the path)
 *   letter-spacing, direction: rtl, dir="rtl"
 *   Arabic / Hebrew / Indic / Thai / Khmer / Myanmar — shaped runs are
 *   rendered as a unit so cursive joining and reordering work correctly.
 */

import type { ResolvedStyle } from '../types.js';
import { parseHTML } from '../parse.js';
import { resolveStylesFromCSS, paintOrderHasStrokeFirst } from '../css-resolver.js';
import { applyFont, isTransparent } from '../layout.js';
import {
  parseTextShadows,
  parseLinearGradient,
  drawDecorationLine,
  decorationThickness,
  textFillColor,
  applyTextStroke,
} from '../render.js';
import { pathFromString, type PathLike } from './svg-path.js';
import {
  flattenSegments,
  layoutGlyphsOnPath,
  baselineLocalY,
  type AlignMode,
  type GlyphPlacement,
  type TextBaseline,
} from './glyph-layout.js';

export type { PathLike, GlyphPlacement, AlignMode, TextBaseline };
export { setDOMParser, type DOMParserLike } from '../dom.js';
import { createFallbackMeasureCtx } from '../dom.js';

export interface LayoutTextOnPathConfig {
  /** Rich-text HTML (same dialect as render-tag's main API). */
  html: string;
  /** SVG path 'd' attribute string, or a PathLike implementation. */
  path: string | PathLike;
  /** Alignment of text along the path (default 'left'). */
  align?: AlignMode;
  /**
   * Where the path runs relative to the rendered text. Default
   * `'alphabetic'` (path = baseline, descenders drop below). Use `'middle'`
   * for design-tool style "text centered on path" rendering. The choice
   * also affects `bounds`.
   */
  textBaseline?: TextBaseline;
  /**
   * Optional measurement context. If omitted, an offscreen canvas is created.
   * Pass one to share font measurement caches with other render-tag calls.
   */
  ctx?: CanvasRenderingContext2D;
}

export interface TextOnPathLayout {
  /** Per-glyph (or per-shaped-run) placement records. */
  glyphs: GlyphPlacement[];
  /** Sum of per-glyph advances (the natural width of the rendered text). */
  textWidth: number;
  /** Total arc length of the path. */
  pathLength: number;
  /**
   * Max line height across all segments. Useful as the thickness for a
   * background ribbon polygon around curved text.
   */
  lineHeight: number;
  /**
   * Visible bounding box of the rendered text in the layout's coordinate
   * system (same shape as `DOMRect`). Computed as the union of each glyph's
   * `width × per-glyph line-height` cell, rotated by the glyph's tangent.
   *
   * Consumer-facing: render-tag does not consume `bounds` itself. Use it to
   * keep a parent element's width/height in sync with the rendered curved
   * text without re-walking the glyphs.
   */
  bounds: { x: number; y: number; width: number; height: number };
  /** The textBaseline mode the layout was computed with. */
  textBaseline: TextBaseline;
}

export interface DrawTextOnPathLayoutConfig {
  /** Result from layoutTextOnPath(). */
  layout: TextOnPathLayout;
  /** Destination 2D context. Saved+restored around the whole batch. */
  ctx: CanvasRenderingContext2D;
}

export interface DrawTextOnPathConfig {
  /** Rich-text HTML (same dialect as render-tag's main API). */
  html: string;
  /** SVG path 'd' attribute string, or a PathLike implementation. */
  path: string | PathLike;
  /** Destination 2D context. */
  ctx: CanvasRenderingContext2D;
  /** Alignment of text along the path (default 'left'). */
  align?: AlignMode;
  /** Where the path runs relative to the text (default 'alphabetic'). */
  textBaseline?: TextBaseline;
}

export type DrawTextOnPathResult = TextOnPathLayout;

/**
 * Compute glyph placements for rich text along a path, without drawing.
 * Useful for inspection, hit-testing, or rendering the same layout multiple times.
 * The HTML's CSS resolves against an infinite-width container, so wrapping
 * does not happen — all text flows along the path as one logical line.
 *
 * The caller's ctx (when passed) has its `font`, `fontKerning`, and
 * `letterSpacing` state saved+restored around the measurement work; nothing
 * leaks to the caller.
 */
export function layoutTextOnPath(config: LayoutTextOnPathConfig): TextOnPathLayout {
  const { html, align = 'left', textBaseline = 'alphabetic' } = config;
  const path = typeof config.path === 'string' ? pathFromString(config.path) : config.path;

  const measureCtx = config.ctx ?? createMeasureCtx();
  const ownsCtx = config.ctx === undefined;

  const { fragment, css } = parseHTML(html);
  const { tree, cleanup } = resolveStylesFromCSS(fragment, css, Number.MAX_SAFE_INTEGER);

  if (!ownsCtx) measureCtx.save();
  try {
    const segments = flattenSegments(tree);
    return layoutGlyphsOnPath({ segments, path, ctx: measureCtx, align, textBaseline });
  } finally {
    if (!ownsCtx) measureCtx.restore();
    cleanup();
  }
}

/**
 * Draw a pre-computed layout onto a canvas context.
 *
 * Rendering passes (matching CSS painting order):
 *   1. Span backgrounds (background-color, curve-following polygons)
 *   2. Text shadows (per glyph, multi-shadow supported, rotates with glyph)
 *   3. Glyph fill + stroke (paint-order aware; gradient text via slicing)
 *   4. Text decoration (underline / line-through / overline)
 *
 * ctx state is saved+restored around the entire batch — nothing leaks.
 */
export function drawTextOnPathLayout(config: DrawTextOnPathLayoutConfig): void {
  const { layout, ctx } = config;
  if (layout.glyphs.length === 0) return;
  const tb = layout.textBaseline;

  ctx.save();
  try {
    drawBackgrounds(ctx, layout.glyphs, tb);
    drawShadowsAndGlyphs(ctx, layout.glyphs, layout.textWidth, tb);
    drawDecorations(ctx, layout.glyphs, tb);
  } finally {
    ctx.restore();
  }
}

/**
 * Convenience: compute layout and draw in a single call.
 */
export function drawTextOnPath(config: DrawTextOnPathConfig): DrawTextOnPathResult {
  const layout = layoutTextOnPath({
    html: config.html,
    path: config.path,
    align: config.align,
    textBaseline: config.textBaseline,
    ctx: config.ctx,
  });
  drawTextOnPathLayout({ layout, ctx: config.ctx });
  return layout;
}

function createMeasureCtx(): CanvasRenderingContext2D {
  // OffscreenCanvas-first, unlike the block-layout entry — this module's
  // historical source; keeps its pixel baselines frozen.
  return createFallbackMeasureCtx(false);
}

// ─── Pass 1: Backgrounds ──────────────────────────────────────────────

/**
 * Round-trip a color through `ctx.fillStyle` to get the browser's
 * canonical form. This makes `red` and `rgb(255, 0, 0)` and `#f00`
 * compare equal so adjacent spans with semantically-identical colors
 * group into one polygon / one stroke (no visible seam, dash phase
 * continuous). Results cached so we don't pay the round-trip per glyph.
 */
const _colorCanonicalCache = new WeakMap<CanvasRenderingContext2D, Map<string, string>>();
function canonicalColor(ctx: CanvasRenderingContext2D, color: string): string {
  if (!color) return '';
  let perCtx = _colorCanonicalCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    _colorCanonicalCache.set(ctx, perCtx);
  }
  const cached = perCtx.get(color);
  if (cached !== undefined) return cached;
  // ctx.fillStyle returns the canonical form when read back.
  const prev = ctx.fillStyle;
  try {
    ctx.fillStyle = color;
    const canon = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : color;
    perCtx.set(color, canon);
    return canon;
  } catch {
    perCtx.set(color, color);
    return color;
  } finally {
    ctx.fillStyle = prev as any;
  }
}

/**
 * Group consecutive glyphs sharing a visible background color and draw each
 * group as a curve-following polygon (top edge + bottom edge).
 */
function drawBackgrounds(
  ctx: CanvasRenderingContext2D,
  glyphs: GlyphPlacement[],
  tb: TextBaseline,
): void {
  let i = 0;
  while (i < glyphs.length) {
    const bg = glyphs[i].style.backgroundColor;
    if (!bg || isTransparent(bg)) { i++; continue; }
    const canon = canonicalColor(ctx, bg);
    let j = i + 1;
    while (
      j < glyphs.length &&
      canonicalColor(ctx, glyphs[j].style.backgroundColor) === canon
    ) j++;
    fillGlyphPolygon(ctx, glyphs.slice(i, j), bg, tb);
    i = j;
  }
}

/**
 * Build the four-corner box of one glyph in world coordinates. Local y=0 is
 * the path point — actual baseline sits at `baselineLocalY(tb, ascent, descent)`.
 * The polygon spans `[baseY - ascent, baseY + descent]` so it hugs the painted
 * glyph extent regardless of which textBaseline anchor was chosen.
 */
function glyphCorners(g: GlyphPlacement, tb: TextBaseline) {
  const c = Math.cos(g.rotation);
  const s = Math.sin(g.rotation);
  const baseY = baselineLocalY(tb, g.ascent, g.descent);
  const top = baseY - g.ascent;
  const bottom = baseY + g.descent;
  const w = g.width;
  return {
    tl: { x: g.x + (-s) * top, y: g.y + c * top },
    tr: { x: g.x + c * w + (-s) * top, y: g.y + s * w + c * top },
    br: { x: g.x + c * w + (-s) * bottom, y: g.y + s * w + c * bottom },
    bl: { x: g.x + (-s) * bottom, y: g.y + c * bottom },
  };
}

/** Fill a polygon hugging the path through a sequence of consecutive glyphs. */
function fillGlyphPolygon(
  ctx: CanvasRenderingContext2D,
  group: GlyphPlacement[],
  fill: string,
  tb: TextBaseline,
): void {
  if (group.length === 0) return;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  const first = glyphCorners(group[0], tb);
  ctx.moveTo(first.tl.x, first.tl.y);
  for (let i = 0; i < group.length; i++) {
    const c = glyphCorners(group[i], tb);
    ctx.lineTo(c.tl.x, c.tl.y);
    ctx.lineTo(c.tr.x, c.tr.y);
  }
  for (let i = group.length - 1; i >= 0; i--) {
    const c = glyphCorners(group[i], tb);
    ctx.lineTo(c.br.x, c.br.y);
    ctx.lineTo(c.bl.x, c.bl.y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Pass 2: Shadows + glyph fill/stroke ─────────────────────────────

/**
 * Iterate glyphs once. For each: draw the configured text-shadow stack (if
 * any), then fill (possibly through a sliced gradient) and stroke per
 * paint-order.
 */
function drawShadowsAndGlyphs(
  ctx: CanvasRenderingContext2D,
  glyphs: GlyphPlacement[],
  textWidth: number,
  tb: TextBaseline,
): void {
  for (const g of glyphs) {
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rotation);
    applyFont(ctx, g.style);
    // Keep ctx.textBaseline at 'alphabetic' and offset fillText's y instead.
    // This keeps our bounds / decoration / background math in agreement with
    // what fillText actually paints, regardless of which textBaseline the
    // caller picked.
    ctx.textBaseline = 'alphabetic';
    // Mirror the letter-spacing used at measurement time. Without this,
    // shaped runs (Arabic / Indic / Thai) whose `g.width` was measured WITH
    // letter-spacing render visibly tighter than the reserved width.
    // Always assign so a stale value from earlier glyphs doesn't leak.
    ctx.letterSpacing = `${g.style.letterSpacing || 0}px` as any;
    const baseY = baselineLocalY(tb, g.ascent, g.descent);

    // Shadow pass — drawn underneath the glyph fill. Multi-shadow stacks
    // paint last-listed-first so the first declared shadow is on top.
    const shadows = parseTextShadows(g.style.textShadow);
    if (shadows.length > 0) {
      for (let i = shadows.length - 1; i >= 0; i--) {
        const sh = shadows[i];
        ctx.save();
        ctx.shadowOffsetX = sh.offsetX;
        ctx.shadowOffsetY = sh.offsetY;
        ctx.shadowBlur = sh.blur;
        ctx.shadowColor = sh.color;
        ctx.fillStyle = textFillColor(g.style);
        ctx.fillText(g.char, 0, baseY);
        ctx.restore();
      }
    }

    drawGlyphFillAndStroke(ctx, g, textWidth, baseY);
    ctx.restore();
  }
}

function drawGlyphFillAndStroke(
  ctx: CanvasRenderingContext2D,
  g: GlyphPlacement,
  textWidth: number,
  baseY: number,
): void {
  const { style } = g;
  // Mirror the main renderer's transparency check: EITHER -webkit-text-fill-color
  // or color being 'transparent' suppresses the fill. textFillColor alone
  // would only catch one of the two by falling back through the precedence.
  const fillTransparent =
    style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent' ||
    isTransparent(textFillColor(style));
  const isStroked = style.webkitTextStrokeWidth > 0;
  const usesGradient =
    style.webkitBackgroundClip === 'text' &&
    style.backgroundImage && style.backgroundImage !== 'none';
  // Use the canonical helper instead of an ad-hoc regex — paint-order tokens
  // are positional ("fill stroke" = fill first), not a flag bag.
  const paintStrokeFirst = paintOrderHasStrokeFirst(style.paintOrder || '');

  const drawFill = () => {
    if (usesGradient) {
      drawGradientGlyph(ctx, g, textWidth, baseY);
      return;
    }
    if (fillTransparent) {
      if (isStroked) return;
      ctx.fillStyle = 'transparent';
      ctx.fillText(g.char, 0, baseY);
      return;
    }
    ctx.fillStyle = textFillColor(style);
    ctx.fillText(g.char, 0, baseY);
  };
  const drawStroke = () => {
    if (!isStroked) return;
    ctx.save();
    applyTextStroke(ctx, style);
    ctx.strokeText(g.char, 0, baseY);
    ctx.restore();
  };

  if (paintStrokeFirst) { drawStroke(); drawFill(); }
  else { drawFill(); drawStroke(); }
}

/**
 * Render one glyph with a gradient fill that flows along the path. The
 * gradient is created once per glyph spanning the FULL text width in the
 * glyph's local rotated frame, offset so the glyph's slice lines up with
 * the global gradient. Neighbouring glyphs stitch into one continuous color
 * curve when viewed along the path.
 */
function drawGradientGlyph(
  ctx: CanvasRenderingContext2D,
  g: GlyphPlacement,
  textWidth: number,
  baseY: number,
): void {
  // The gradient is laid out from (-pathOffset, *) to (textWidth-pathOffset, *)
  // in this glyph's local frame, so global gradient at fraction t/textWidth
  // matches what neighbouring glyphs render. The vertical band tracks the
  // glyph's full extent around the baseline anchor.
  const gradient = parseLinearGradient(
    ctx,
    g.style.backgroundImage,
    -g.pathOffset, textWidth,
    baseY - g.ascent, g.ascent + g.descent,
  );
  if (!gradient) {
    ctx.fillStyle = textFillColor(g.style);
    ctx.fillText(g.char, 0, baseY);
    return;
  }
  ctx.fillStyle = gradient;
  ctx.fillText(g.char, 0, baseY);
}

// ─── Pass 3: Decorations ─────────────────────────────────────────────

/**
 * Underline / line-through / overline: stroke a curve that follows the path
 * at the appropriate vertical offset. Groups consecutive glyphs sharing
 * decoration-line + style + color.
 */
function drawDecorations(
  ctx: CanvasRenderingContext2D,
  glyphs: GlyphPlacement[],
  tb: TextBaseline,
): void {
  const lines = ['underline', 'line-through', 'overline'] as const;
  for (const lineKind of lines) {
    let i = 0;
    while (i < glyphs.length) {
      const style = glyphs[i].style;
      if (!style.textDecorationLine || !style.textDecorationLine.includes(lineKind)) {
        i++;
        continue;
      }
      const color = style.textDecorationColor || style.color;
      const decoStyle = style.textDecorationStyle || 'solid';
      const colorCanon = canonicalColor(ctx, color);
      let j = i + 1;
      while (
        j < glyphs.length &&
        glyphs[j].style.textDecorationLine &&
        glyphs[j].style.textDecorationLine.includes(lineKind) &&
        canonicalColor(ctx, glyphs[j].style.textDecorationColor || glyphs[j].style.color) === colorCanon &&
        (glyphs[j].style.textDecorationStyle || 'solid') === decoStyle
      ) j++;
      strokeDecorationAlongGlyphs(ctx, glyphs.slice(i, j), lineKind, decoStyle, color, tb);
      i = j;
    }
  }
}

function strokeDecorationAlongGlyphs(
  ctx: CanvasRenderingContext2D,
  group: GlyphPlacement[],
  lineKind: 'underline' | 'line-through' | 'overline',
  decoStyle: string,
  color: string,
  tb: TextBaseline,
): void {
  if (group.length === 0) return;
  const lineWidth = decorationThickness(group[0].style.fontSize);

  // Per-glyph local y for this decoration kind. The decoration position is
  // baseline-relative, so we shift by the baseline's local-y under the
  // current textBaseline to land in the right spot on the canvas.
  const localY = (g: GlyphPlacement): number => {
    const baseY = baselineLocalY(tb, g.ascent, g.descent);
    if (lineKind === 'underline') return baseY + g.descent * 0.5;
    if (lineKind === 'line-through') return baseY - g.ascent * 0.3;
    return baseY - g.ascent * 0.9; // overline
  };

  if (decoStyle === 'double' || decoStyle === 'wavy') {
    // For double/wavy we draw each glyph segment independently using the
    // shared helper so the visual matches the main renderer.
    for (const g of group) {
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.rotation);
      drawDecorationLine(ctx, 0, localY(g), g.width, lineWidth, decoStyle, color);
      ctx.restore();
    }
    return;
  }

  // Solid / dotted / dashed: a single continuous polyline through (left,
  // right) endpoints of each glyph projected into world space. Stroking
  // once keeps the dash phase continuous across the whole decoration run.
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (decoStyle === 'dotted') ctx.setLineDash([lineWidth, lineWidth * 2]);
  else if (decoStyle === 'dashed') ctx.setLineDash([lineWidth * 3, lineWidth * 2]);
  ctx.beginPath();
  for (let i = 0; i < group.length; i++) {
    const g = group[i];
    const yOff = localY(g);
    const c = Math.cos(g.rotation);
    const s = Math.sin(g.rotation);
    const left = { x: g.x + (-s) * yOff, y: g.y + c * yOff };
    const right = {
      x: g.x + c * g.width + (-s) * yOff,
      y: g.y + s * g.width + c * yOff,
    };
    if (i === 0) ctx.moveTo(left.x, left.y);
    else ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ─── Style helpers ───────────────────────────────────────────────────
