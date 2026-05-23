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
 * For finer control, mirror the main API's split:
 *   const result = layoutTextOnPath({ html, path, align });
 *   drawTextOnPathLayout({ layout: result, ctx });
 * Use the split when you want to inspect / hit-test glyphs before drawing,
 * or render the same layout onto multiple targets.
 *
 * Out of scope for the first cut: text-shadow, gradient/background-clip text,
 * text-decoration (underline/line-through), per-glyph kerning callbacks.
 * Mixed-script BiDi shaping is not supported (matches the konva limit) — pure
 * RTL strings render correctly via CSS `direction: rtl` or the `dir` attribute.
 */

import type { ResolvedStyle } from '../types.js';
import { parseHTML } from '../parse.js';
import { resolveStylesFromCSS } from '../css-resolver.js';
import { applyFont } from '../layout.js';
import { pathFromString, type PathLike } from './svg-path.js';
import {
  flattenSegments,
  layoutGlyphsOnPath,
  type AlignMode,
  type GlyphPlacement,
} from './glyph-layout.js';

export type { PathLike, GlyphPlacement, AlignMode };

export interface LayoutTextOnPathConfig {
  /** Rich-text HTML (same dialect as render-tag's main API). */
  html: string;
  /** SVG path 'd' attribute string, or a PathLike implementation. */
  path: string | PathLike;
  /** Alignment of text along the path (default 'left'). */
  align?: AlignMode;
  /**
   * Optional measurement context. If omitted, an offscreen canvas is created.
   * Pass one to share font measurement caches with other render-tag calls.
   */
  ctx?: CanvasRenderingContext2D;
}

export interface TextOnPathLayout {
  /** Per-glyph placement records (origin point, rotation, style). */
  glyphs: GlyphPlacement[];
  /** Sum of per-glyph advances (the natural width of the rendered text). */
  textWidth: number;
  /** Total arc length of the path. */
  pathLength: number;
  /**
   * Max line height across all segments (CSS line-height in px when set,
   * else the segment's font size). Use as the thickness for a background
   * ribbon polygon around curved text.
   */
  lineHeight: number;
}

export interface DrawTextOnPathLayoutConfig {
  /** Result from layoutTextOnPath(). */
  layout: TextOnPathLayout;
  /** Destination 2D context. The transform is saved/restored per glyph. */
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
  const { html, align = 'left' } = config;
  const path = typeof config.path === 'string' ? pathFromString(config.path) : config.path;

  // Use the caller's ctx for measurement if given; otherwise spin up our own.
  const measureCtx = config.ctx ?? createMeasureCtx();
  const ownsCtx = config.ctx === undefined;

  const { fragment, css } = parseHTML(html);
  const { tree, cleanup } = resolveStylesFromCSS(fragment, css, Number.MAX_SAFE_INTEGER);

  if (!ownsCtx) measureCtx.save();
  try {
    const segments = flattenSegments(tree);
    return layoutGlyphsOnPath({ segments, path, ctx: measureCtx, align });
  } finally {
    if (!ownsCtx) measureCtx.restore();
    cleanup();
  }
}

/**
 * Draw a pre-computed layout onto a canvas context.
 * Each glyph is rendered with its own style; ctx state is saved/restored
 * around the whole batch so the caller's state is preserved.
 */
export function drawTextOnPathLayout(config: DrawTextOnPathLayoutConfig): void {
  const { layout, ctx } = config;
  ctx.save();
  try {
    for (const g of layout.glyphs) drawGlyph(ctx, g);
  } finally {
    ctx.restore();
  }
}

/**
 * Convenience: compute layout and draw in a single call.
 * Equivalent to `drawTextOnPathLayout({ layout: layoutTextOnPath(...), ctx })`.
 */
export function drawTextOnPath(config: DrawTextOnPathConfig): DrawTextOnPathResult {
  // Save/restore is handled inside layoutTextOnPath + drawTextOnPathLayout,
  // so the caller's ctx state survives both stages even when sharing one ctx.
  const layout = layoutTextOnPath({
    html: config.html,
    path: config.path,
    align: config.align,
    ctx: config.ctx,
  });
  drawTextOnPathLayout({ layout, ctx: config.ctx });
  return layout;
}

function createMeasureCtx(): CanvasRenderingContext2D {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas');
  return canvas.getContext('2d')! as CanvasRenderingContext2D;
}

/** Draw a single grapheme at its origin with the given rotation. */
function drawGlyph(ctx: CanvasRenderingContext2D, g: GlyphPlacement): void {
  const { style } = g;
  ctx.save();
  ctx.translate(g.x, g.y);
  ctx.rotate(g.rotation);
  applyFont(ctx, style);
  ctx.textBaseline = 'alphabetic';
  // letterSpacing isn't applied per single glyph — it's already baked into
  // the glyph offset advance in glyph-layout.

  const fill = effectiveFill(style);
  const isStroked = style.webkitTextStrokeWidth > 0;
  const isFillTransparent = fill === 'transparent';
  const paintStrokeFirst = /paint-order:\s*stroke/i.test(style.paintOrder || '') ||
    /^stroke/i.test((style.paintOrder || '').trim());

  const drawFill = () => {
    if (isFillTransparent && isStroked) return;
    ctx.fillStyle = fill;
    ctx.fillText(g.char, 0, 0);
  };
  const drawStroke = () => {
    if (!isStroked) return;
    ctx.lineJoin = 'round';
    ctx.lineWidth = style.webkitTextStrokeWidth;
    ctx.strokeStyle = style.webkitTextStrokeColor || style.color;
    ctx.strokeText(g.char, 0, 0);
  };

  if (paintStrokeFirst) {
    drawStroke();
    drawFill();
  } else {
    drawFill();
    drawStroke();
  }

  ctx.restore();
}

function effectiveFill(style: ResolvedStyle): string {
  if (style.webkitTextFillColor && style.webkitTextFillColor !== 'transparent') {
    return style.webkitTextFillColor;
  }
  return style.color;
}
