/**
 * render-tag/path — draw rich text along an SVG path on a 2D canvas.
 *
 * Reuses render-tag's HTML+CSS pipeline (parseHTML, resolveStylesFromCSS) and
 * font primitives (the `Measurer`) so styled spans, fonts, and colors come straight
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
 *   text-shadow (in path coordinates; multi-shadow supported)
 *   text-decoration: underline / line-through / overline (solid/dotted/dashed/double/wavy)
 *   text-decoration-color, text-decoration-style
 *   background-clip:text + background-image:linear-gradient (gradient flows along the path)
 *   letter-spacing, text-transform, direction: rtl, dir="rtl"
 *   Arabic / Hebrew / Indic / Thai / Khmer / Myanmar — shaped runs are
 *   rendered as a unit so cursive joining and reordering work correctly.
 */

import type { ShadowOptions, ResolvedStyle, DecorationEntry } from '../types.js';
import { paintOrderHasStrokeFirst, isTransparent } from '../css-resolver.js';
import { hasTextClip, paintsBoxBackground, sameDecorationBand, styleTree, layoutFontMetrics, type FontMetricsTable } from '../layout.js';
import { textFillColor } from '../render.js';
import { bandWidthFor, drawDecorationLine, explicitUnderlineDelta, legacyDash } from '../decoration.js';
import { parseLinearGradient } from '../gradient.js';
import { PaintState, withDraw } from '../paint-state.js';
import { STROKE_CASTS_TEXT_SHADOW } from '../engine.js';
import { paintTextShadows, shadowBounds, shadowsOf, textPaintBounds, transformBounds, unionBounds, withCanvasShadow, measurePaintBounds, type PaintBounds, type TextShadow } from '../shadow.js';
import { pathFromString, type PathLike } from './svg-path.js';
import {
  flattenSegments,
  layoutGlyphsOnPath,
  baselineLocalY,
  rotatedBox,
  type AlignMode,
  type GlyphPlacement,
  type TextBaseline,
  type LayoutOutput,
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

export interface TextOnPathLayout extends LayoutOutput {
  /** Conservative local painted bounds; same contract as LayoutResult.paintBounds.
   * Measured on first access and reused. Does not change the layout's bounds. */
  readonly paintBounds: PaintBounds;
}

export interface DrawTextOnPathLayoutConfig extends ShadowOptions {
  /** Result from layoutTextOnPath(). */
  layout: TextOnPathLayout;
  /** Destination 2D context. Saved+restored around the whole batch. */
  ctx: CanvasRenderingContext2D;
}

export interface DrawTextOnPathConfig extends LayoutTextOnPathConfig, ShadowOptions {
  /** Destination 2D context, also used for measurement. */
  ctx: CanvasRenderingContext2D;
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

  // OffscreenCanvas-first, unlike the block entry: keeps path pixels frozen.
  const measureCtx = config.ctx ?? createFallbackMeasureCtx(false);
  const ownsCtx = config.ctx === undefined;

  if (!ownsCtx) measureCtx.save();
  try {
    // No viewport: a vw/vh declaration is ignored.
    const tree = styleTree(html, measureCtx, Number.MAX_SAFE_INTEGER);
    const fontMetrics: FontMetricsTable = new Map();
    const segments = flattenSegments(tree);
    const result = layoutGlyphsOnPath({
      segments, path, ctx: measureCtx, align, textBaseline, fontMetrics,
      direction: tree.style.direction === 'rtl' ? 'rtl' : 'ltr',
    });
    let paintBounds: PaintBounds | undefined;
    const layout: TextOnPathLayout = {
      ...result,
      get paintBounds() {
        return paintBounds ??= measurePaintBounds(measureCtx,
          () => pathPaintBounds(new PaintState(measureCtx, 1, false, fontMetrics), result));
      },
    };
    layoutFontMetrics.set(layout, fontMetrics);
    return layout;
  } finally {
    if (!ownsCtx) measureCtx.restore();
  }
}

interface PathShadowGroup {
  glyphs: GlyphPlacement[][];
  shadows: TextShadow[];
  bounds?: PaintBounds;
}

function collectPathShadowGroups(glyphs: GlyphPlacement[]): Map<string, PathShadowGroup> {
  const groups = new Map<string, PathShadowGroup>();
  const parsed = new Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>();
  let previousKey = '';
  for (const glyph of glyphs) {
    const { shadows, key: json } = shadowsOf(parsed, glyph.style);
    const key = shadows.length ? json : '';
    if (key) {
      let group = groups.get(key);
      if (!group) { group = { glyphs: [], shadows }; groups.set(key, group); }
      // Keep gaps: decorations must not bridge unrelated spans.
      if (key !== previousKey) group.glyphs.push([]);
      group.glyphs[group.glyphs.length - 1].push(glyph);
    }
    previousKey = key;
  }
  return groups;
}

function pathForegroundBounds(
  ps: PaintState, glyphs: GlyphPlacement[], tb: TextBaseline,
): PaintBounds {
  if (!glyphs.length) return { x: 0, y: 0, width: 0, height: 0 };
  return glyphs.map(g => {
    const baseY = baselineLocalY(tb, g.ascent, g.descent);
    ps.glyph(g.style);
    const ink = textPaintBounds(ps.ctx, g.char, g.style, 0, baseY, g.width);
    const box = unionBounds(ink, { x: 0, y: baseY - g.ascent, width: g.width, height: g.ascent + g.descent });
    const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
    return transformBounds(box, { a: c, b: s, c: -s, d: c, e: g.x, f: g.y });
  }).reduce(unionBounds);
}

function pathPaintBounds(
  ps: PaintState, layout: LayoutOutput,
  groups = collectPathShadowGroups(layout.glyphs),
): PaintBounds {
  let bounds = pathForegroundBounds(ps, layout.glyphs, layout.textBaseline);
  for (const group of groups.values()) {
    bounds = unionBounds(bounds, shadowBounds(groupInk(ps, group, layout.textBaseline), group.shadows));
  }
  return bounds;
}

/** A shadow group's foreground ink, measured once per draw: the caller-shadow
 * bounds and the group's own shadow layer both need it. */
function groupInk(ps: PaintState, group: PathShadowGroup, tb: TextBaseline): PaintBounds {
  return group.bounds ??= pathForegroundBounds(ps, group.glyphs.flat(), tb);
}

/**
 * Draw a pre-computed layout onto a canvas context.
 *
 * Rendering passes (matching CSS painting order):
 *   1. Span backgrounds (background-color, curve-following polygons)
 *   2. Text shadows (combined glyphs and decorations, in path coordinates)
 *   3. Glyph fill + stroke (paint-order aware; gradient text via slicing)
 *   4. Text decoration (underline / line-through / overline)
 *
 * ctx state is saved+restored around the entire batch — nothing leaks.
 */
export function drawTextOnPathLayout(config: DrawTextOnPathLayoutConfig): void {
  const { layout, ctx } = config;
  if (layout.glyphs.length === 0) return;
  const tb = layout.textBaseline;
  const fontMetrics = layoutFontMetrics.get(layout);

  const foreground = (ps: PaintState, glyphs: GlyphPlacement[]) => {
    drawGlyphs(ps, glyphs, layout.textWidth, tb);
    drawDecorations(ps, glyphs, layout.textWidth, tb);
  };
  withDraw(ctx, config, 1, fontMetrics, (stateOf, pool) => {
    if (!pool) {
      const ps = stateOf(ctx);
      drawBackgrounds(ps, layout.glyphs, tb);
      foreground(ps, layout.glyphs);
      return;
    }
    const groups = collectPathShadowGroups(layout.glyphs);
    const measure = stateOf(ctx);
    withCanvasShadow(ctx, () => pathPaintBounds(measure, layout, groups), target => {
      const ps = stateOf(target);
      drawBackgrounds(ps, layout.glyphs, tb);
      for (const group of groups.values()) {
        // One piece: each tile the group spans repaints all its glyphs.
        paintTextShadows(target, [{ bounds: groupInk(measure, group, tb) }], group.shadows, mask => {
          const maskState = new PaintState(mask, 1, true, fontMetrics);
          group.glyphs.forEach(glyphs => foreground(maskState, glyphs));
        }, pool);
      }
      foreground(ps, layout.glyphs);
    }, pool);
  });
}

/** Compute layout and draw in a single call. */
export function drawTextOnPath(config: DrawTextOnPathConfig): DrawTextOnPathResult {
  const layout = layoutTextOnPath(config);
  drawTextOnPathLayout({ ...config, layout });
  return layout;
}

/**
 * A colour's canonical form, read back from `fillStyle`, so `red`, `#f00` and
 * `rgb(255, 0, 0)` group into one polygon or stroke. Cached per ctx.
 */
const colorCanon = new WeakMap<CanvasRenderingContext2D, Map<string, string>>();
function canonicalColor(ctx: CanvasRenderingContext2D, color: string): string {
  if (!color) return '';
  let perCtx = colorCanon.get(ctx);
  if (!perCtx) colorCanon.set(ctx, perCtx = new Map());
  let canon = perCtx.get(color);
  if (canon === undefined) {
    const prev = ctx.fillStyle;
    ctx.fillStyle = color;
    canon = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : color;
    ctx.fillStyle = prev;
    perCtx.set(color, canon);
  }
  return canon;
}

/** Fill each run of glyphs sharing a background colour as one curve-following polygon. */
function drawBackgrounds(
  ps: PaintState,
  glyphs: GlyphPlacement[],
  tb: TextBaseline,
): void {
  const { ctx } = ps;
  let i = 0;
  while (i < glyphs.length) {
    if (!paintsBoxBackground(glyphs[i].style)) { i++; continue; }
    const bg = glyphs[i].style.backgroundColor;
    const canon = canonicalColor(ctx, bg);
    let j = i + 1;
    while (
      j < glyphs.length &&
      paintsBoxBackground(glyphs[j].style) &&
      canonicalColor(ctx, glyphs[j].style.backgroundColor) === canon
    ) j++;
    fillGlyphPolygon(ps, glyphs.slice(i, j), bg, tb);
    i = j;
  }
}

/** A glyph's `[baseY - ascent, baseY + descent]` box in world space: tl, tr, br, bl. */
function glyphCorners(g: GlyphPlacement, tb: TextBaseline) {
  const baseY = baselineLocalY(tb, g.ascent, g.descent);
  return rotatedBox(g, baseY - g.ascent, baseY + g.descent);
}

function fillGlyphPolygon(
  ps: PaintState,
  group: GlyphPlacement[],
  fill: string,
  tb: TextBaseline,
): void {
  const { ctx } = ps;
  ps.fill(fill);
  ctx.beginPath();
  const [first] = glyphCorners(group[0], tb);
  ctx.moveTo(first.x, first.y);
  for (let i = 0; i < group.length; i++) {
    const [tl, tr] = glyphCorners(group[i], tb);
    ctx.lineTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
  }
  for (let i = group.length - 1; i >= 0; i--) {
    const [, , br, bl] = glyphCorners(group[i], tb);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
  }
  ctx.closePath();
  ctx.fill();
}

/** True when the glyph's own fill paints nothing: EITHER transparency channel suppresses it. */
function isFillTransparent(style: ResolvedStyle): boolean {
  return style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent' ||
    isTransparent(textFillColor(style));
}

/** The clip-paint declarer of a glyph, if any. */
function clipSourceOf(g: GlyphPlacement): ResolvedStyle | undefined {
  return g.clipStyle ?? (hasTextClip(g.style) ? g.style : undefined);
}

/** A gradient sliced from the declarer's fragment range, in the glyph's local frame,
 * so neighbouring glyphs stitch into one continuous gradient along the path. */
function sliceGradient(
  ctx: CanvasRenderingContext2D,
  image: string,
  g: GlyphPlacement,
  range: { start: number; width: number } | undefined,
  textWidth: number,
  baseY: number,
): CanvasGradient | null {
  const r = range ?? { start: 0, width: textWidth };
  return parseLinearGradient(ctx, image, r.start - g.pathOffset, r.width, baseY - g.ascent, g.ascent + g.descent);
}

/** The background-clip:text paint for one glyph: the declarer's gradient, else
 * its solid background-color; null when there is none. */
function clipPaintFor(
  ctx: CanvasRenderingContext2D,
  g: GlyphPlacement,
  textWidth: number,
  baseY: number,
): string | CanvasGradient | null {
  const src = clipSourceOf(g);
  if (!src) return null;
  const gradient = src.backgroundImage && src.backgroundImage !== 'none'
    ? sliceGradient(ctx, src.backgroundImage, g, g.clipRange, textWidth, baseY)
    : null;
  return gradient ?? (!isTransparent(src.backgroundColor) ? src.backgroundColor : null);
}

/** The --rt-text-stroke-image gradient for one glyph. */
function strokePaintFor(
  ctx: CanvasRenderingContext2D,
  g: GlyphPlacement,
  textWidth: number,
  baseY: number,
): CanvasGradient | null {
  const src = g.strokeImageStyle;
  return src ? sliceGradient(ctx, src.webkitTextStrokeImage, g, g.strokeImageRange, textWidth, baseY) : null;
}

/**
 * What fills this glyph, with the main renderer's precedence: the clip paint
 * when its own style declares the clip or its own fill is transparent, else
 * the solid fill; null = nothing.
 */
function effectiveFillPaint(
  ctx: CanvasRenderingContext2D,
  g: GlyphPlacement,
  textWidth: number,
  baseY: number,
): string | CanvasGradient | null {
  const usesClipPaint = hasTextClip(g.style) ||
    (g.clipStyle != null && isFillTransparent(g.style));
  if (usesClipPaint) {
    return clipPaintFor(ctx, g, textWidth, baseY);
  }
  return isFillTransparent(g.style) ? null : textFillColor(g.style);
}

function drawGlyphs(
  ps: PaintState,
  glyphs: GlyphPlacement[],
  textWidth: number,
  tb: TextBaseline,
): void {
  const { ctx } = ps;
  for (const g of glyphs) {
    // Paint state is set before the transform scope so it survives the
    // restore. textBaseline stays 'alphabetic'; fillText's y is offset instead.
    ps.glyph(g.style);
    const baseY = baselineLocalY(tb, g.ascent, g.descent);
    // A shadow mask fills every glyph: its shadow is the glyph's shape.
    const fill = effectiveFillPaint(ctx, g, textWidth, baseY) ?? (ps.coverage ? 'black' : null);
    const isStroked = g.style.webkitTextStrokeWidth > 0 && (!ps.coverage || STROKE_CASTS_TEXT_SHADOW);
    if (fill) ps.fill(fill);
    if (isStroked) ps.textStroke(g.style, strokePaintFor(ctx, g, textWidth, baseY));

    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rotation);
    const drawFill = () => { if (fill) ctx.fillText(g.char, 0, baseY); };
    const drawStroke = () => { if (isStroked) ctx.strokeText(g.char, 0, baseY); };
    if (paintOrderHasStrokeFirst(g.style.paintOrder || '')) { drawStroke(); drawFill(); }
    else { drawFill(); drawStroke(); }
    ctx.restore();
  }
}

/** A glyph's decoration entry for one line kind: the last match wins. */
function decorationFor(style: ResolvedStyle, lineKind: string): DecorationEntry | null {
  const entries = style.textDecorations;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].line === lineKind) return entries[i];
  return null;
}

/**
 * Stroke each run of glyphs sharing one decoration along the path. A
 * transparent decoration over background-clip:text glyphs paints with the
 * clip paint (Chrome clips decorations too); with no clip declarer, nothing.
 */
function drawDecorations(
  ps: PaintState,
  glyphs: GlyphPlacement[],
  textWidth: number,
  tb: TextBaseline,
): void {
  const { ctx } = ps;
  for (const lineKind of ['underline', 'line-through', 'overline'] as const) {
    let i = 0;
    while (i < glyphs.length) {
      const deco = decorationFor(glyphs[i].style, lineKind);
      if (!deco) { i++; continue; }
      const transparent = isTransparent(deco.color);
      const src = transparent ? clipSourceOf(glyphs[i]) : undefined;
      if (transparent && !src) { i++; continue; }
      // canonicalColor writes fillStyle on first sight: keep its call order.
      const canon = transparent ? '' : canonicalColor(ctx, deco.color);
      let j = i + 1;
      while (j < glyphs.length) {
        const next = decorationFor(glyphs[j].style, lineKind);
        if (
          !next ||
          (transparent ? !isTransparent(next.color) : canonicalColor(ctx, next.color) !== canon) ||
          next.style !== deco.style ||
          !sameDecorationBand(next, deco) ||
          (transparent && clipSourceOf(glyphs[j]) !== src)
        ) break;
        j++;
      }
      drawDecorationRun(ps, glyphs.slice(i, j), lineKind, deco, textWidth, tb, transparent ? null : deco.color);
      i = j;
    }
  }
}

/**
 * Local-frame y of a decoration band for one glyph. Only the underline uses
 * the declarer's descent; the others hang off the glyph's own ascent.
 */
function decorationLocalY(
  g: GlyphPlacement,
  deco: DecorationEntry,
  declarerDescent: number,
  lineWidth: number,
  lineKind: 'underline' | 'line-through' | 'overline',
  tb: TextBaseline,
): number {
  const baseY = baselineLocalY(tb, g.ascent, g.descent);
  if (lineKind === 'underline') {
    const explicitDelta = explicitUnderlineDelta(deco, lineWidth);
    return baseY + (explicitDelta !== null ? explicitDelta : declarerDescent * 0.5);
  }
  if (lineKind === 'line-through') return baseY - g.ascent * 0.3;
  return baseY - g.ascent * 0.9; // overline
}

/**
 * One decoration run. A solid, dotted or dashed `color` is one polyline, so
 * the dash phase stays continuous; double, wavy and the clip paint
 * (`color` null) draw per glyph in its rotated frame.
 */
function drawDecorationRun(
  ps: PaintState,
  group: GlyphPlacement[],
  lineKind: 'underline' | 'line-through' | 'overline',
  deco: DecorationEntry,
  textWidth: number,
  tb: TextBaseline,
  color: string | null,
): void {
  const decoStyle = deco.style || 'solid';
  const lineWidth = bandWidthFor(deco);
  if (lineWidth <= 0) return;
  const { ctx } = ps;
  const declarerDescent = ps.fontBox(deco.declarer).descent;
  const localY = (g: GlyphPlacement) => decorationLocalY(g, deco, declarerDescent, lineWidth, lineKind, tb);

  if (color !== null && decoStyle !== 'double' && decoStyle !== 'wavy') {
    ps.stroke(color, lineWidth, legacyDash(decoStyle, lineWidth));
    ctx.beginPath();
    for (let i = 0; i < group.length; i++) {
      const y = localY(group[i]);
      const [left, right] = rotatedBox(group[i], y, y);
      if (i === 0) ctx.moveTo(left.x, left.y);
      else ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
    }
    ctx.stroke();
    return;
  }
  for (const g of group) {
    // State written inside the transform scope is forgotten when it closes.
    ps.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rotation);
    const paint = color ?? clipPaintFor(ctx, g, textWidth, baselineLocalY(tb, g.ascent, g.descent));
    if (paint) drawDecorationLine(ps, 0, localY(g), g.width, lineWidth, decoStyle, paint);
    ps.restore();
  }
}
