/**
 * render-tag/path — draw rich text along an SVG path on a 2D canvas, in the
 * same HTML/CSS dialect as the main renderer (see README).
 *
 *   drawTextOnPath({ html: '<b>Hello</b> world', path: 'M0,50 Q200,0 400,50', ctx });
 *   // or: drawTextOnPathLayout({ layout: layoutTextOnPath({ html, path }), ctx });
 */

import type { ShadowOptions, ResolvedStyle } from '../types.js';
import { isTransparent } from '../css-resolver.js';
import { hasTextClip, paintsBoxBackground, styleTree, layoutFontMetrics, type FontMetricsTable } from '../layout.js';
import { glyphPaints, paintGlyphs } from '../render.js';
import { fragmentBands, paintBand, type Band, type Pen } from '../decoration.js';
import { parseLinearGradient } from '../gradient.js';
import { PaintState, withDraw } from '../paint-state.js';
import { paintTextShadows, shadowBounds, shadowsOf, textPaintBounds, transformBounds, unionBounds, withCanvasShadow, lazyPaintBounds, type PaintBounds, type TextShadow } from '../shadow.js';
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
  /** Where the path runs relative to the text (default `'alphabetic'`;
   * `'middle'` centers text on the path). Also affects `bounds`. */
  textBaseline?: TextBaseline;
  /** Measurement context; an offscreen canvas when omitted. */
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
 * Glyph placements for rich text along a path, without drawing. Text never
 * wraps: it flows along the path as one line. The caller's ctx is restored.
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
    const paintBounds = lazyPaintBounds(measureCtx,
      (ctx) => pathPaintBounds(new PaintState(ctx, 1, false, fontMetrics), new Map(), result));
    const layout: TextOnPathLayout = {
      ...result,
      get paintBounds() { return paintBounds(); },
    };
    layoutFontMetrics.set(layout, fontMetrics);
    return layout;
  } finally {
    if (!ownsCtx) measureCtx.restore();
  }
}

/** One shadow-casting glyph; `paintTextShadows` culls pieces per tile. */
interface GlyphPiece {
  bounds: PaintBounds;
  glyph: GlyphPlacement;
  /** Its contiguous span: decorations paint per span so the dash phase holds. */
  span: GlyphPlacement[];
}

interface PathShadowGroup {
  spans: GlyphPlacement[][];
  shadows: TextShadow[];
  pieces?: GlyphPiece[];
}

/** Local glyph ink by style and text, measured once per draw. */
type InkCache = Map<ResolvedStyle, Map<string, PaintBounds>>;

function collectPathShadowGroups(glyphs: GlyphPlacement[]): Map<string, PathShadowGroup> {
  const groups = new Map<string, PathShadowGroup>();
  const parsed = new Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>();
  let previousKey = '';
  for (const glyph of glyphs) {
    const { shadows, key: json } = shadowsOf(parsed, glyph.style);
    const key = shadows.length ? json : '';
    if (key) {
      let group = groups.get(key);
      if (!group) { group = { spans: [], shadows }; groups.set(key, group); }
      // Keep gaps: decorations must not bridge unrelated spans.
      if (key !== previousKey) group.spans.push([]);
      group.spans[group.spans.length - 1].push(glyph);
    }
    previousKey = key;
  }
  return groups;
}

/** A glyph's painted box in world space. */
function glyphBounds(ps: PaintState, cache: InkCache, g: GlyphPlacement, tb: TextBaseline): PaintBounds {
  let byText = cache.get(g.style);
  if (!byText) cache.set(g.style, byText = new Map());
  // The last glyph's width lacks its trailing letter-space.
  const key = g.width + ' ' + g.char;
  let local = byText.get(key);
  if (!local) {
    const baseY = baselineLocalY(tb, g.ascent, g.descent);
    ps.glyph(g.style);
    const ink = textPaintBounds(ps.ctx, g.char, g.style, 0, baseY, g.width);
    local = unionBounds(ink, { x: 0, y: baseY - g.ascent, width: g.width, height: g.ascent + g.descent });
    byText.set(key, local);
  }
  const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
  return transformBounds(local, { a: c, b: s, c: -s, d: c, e: g.x, f: g.y });
}

function pathForegroundBounds(
  ps: PaintState, cache: InkCache, glyphs: GlyphPlacement[], tb: TextBaseline,
): PaintBounds {
  if (!glyphs.length) return { x: 0, y: 0, width: 0, height: 0 };
  let bounds = glyphBounds(ps, cache, glyphs[0], tb);
  for (let i = 1; i < glyphs.length; i++) bounds = unionBounds(bounds, glyphBounds(ps, cache, glyphs[i], tb));
  return bounds;
}

/** A group's glyphs as shadow pieces, measured once per draw. */
function groupPieces(ps: PaintState, cache: InkCache, group: PathShadowGroup, tb: TextBaseline): GlyphPiece[] {
  return group.pieces ??= group.spans.flatMap(span =>
    span.map(glyph => ({ bounds: glyphBounds(ps, cache, glyph, tb), glyph, span })));
}

function pathPaintBounds(
  ps: PaintState, cache: InkCache, layout: LayoutOutput,
  groups = collectPathShadowGroups(layout.glyphs),
): PaintBounds {
  const tb = layout.textBaseline;
  let bounds = pathForegroundBounds(ps, cache, layout.glyphs, tb);
  for (const group of groups.values()) {
    const ink = groupPieces(ps, cache, group, tb).map(p => p.bounds).reduce(unionBounds);
    bounds = unionBounds(bounds, shadowBounds(ink, group.shadows));
  }
  return bounds;
}

/** Draw a layout: backgrounds, text shadows, glyphs, decorations; ctx is restored. */
export function drawTextOnPathLayout(config: DrawTextOnPathLayoutConfig): void {
  const { layout, ctx } = config;
  if (layout.glyphs.length === 0) return;
  const tb = layout.textBaseline;
  const fontMetrics = layoutFontMetrics.get(layout);

  const cache: InkCache = new Map();
  withDraw(ctx, config, 1, fontMetrics, (stateOf, pool, layerState) => {
    if (!pool) {
      const ps = stateOf(ctx);
      drawBackgrounds(ps, layout.glyphs, tb);
      paintRuns(ps, layout.glyphs, layout.textWidth, tb);
      return;
    }
    const groups = collectPathShadowGroups(layout.glyphs);
    const measure = stateOf(ctx);
    withCanvasShadow(ctx, () => pathPaintBounds(measure, cache, layout, groups), target => {
      const ps = stateOf(target);
      drawBackgrounds(ps, layout.glyphs, tb);
      for (const group of groups.values()) {
        paintTextShadows(target, groupPieces(measure, cache, group, tb), group.shadows, (mask, inside) => {
          // The tile's glyphs only; a decorated span whole, so its dash phase holds.
          const maskState = layerState(mask, true);
          const visible = new Set(inside.map(p => p.glyph));
          for (const span of new Set(inside.map(p => p.span))) paintRuns(maskState, span, layout.textWidth, tb, visible);
        }, pool);
      }
      paintRuns(ps, layout.glyphs, layout.textWidth, tb);
    }, pool);
  });
}

/** Compute layout and draw in a single call. */
export function drawTextOnPath(config: DrawTextOnPathConfig): DrawTextOnPathResult {
  const layout = layoutTextOnPath(config);
  drawTextOnPathLayout({ ...config, layout });
  return layout;
}

/** A colour's canonical `fillStyle` form, so `red` and `#f00` group together. Bounded: cleared when full. */
const colorCanon = new WeakMap<CanvasRenderingContext2D, Map<string, string>>();
const COLOR_CANON_MAX = 512;
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
    if (perCtx.size >= COLOR_CANON_MAX) perCtx.clear();
    perCtx.set(color, canon);
  }
  return canon;
}

/** The caller's transform, or null on a ctx that cannot report it (then save/translate/rotate/restore per glyph). */
function frameBase(ctx: CanvasRenderingContext2D): DOMMatrix | null {
  return typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
}

/** Enter glyph `g`'s frame: one setTransform, composed as translate then rotate. */
function enterFrame(ps: PaintState, base: DOMMatrix | null, g: GlyphPlacement): void {
  const { ctx } = ps;
  if (!base) { ps.save(); ctx.translate(g.x, g.y); ctx.rotate(g.rotation); return; }
  const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
  ctx.setTransform(
    base.a * c + base.c * s, base.b * c + base.d * s,
    base.a * -s + base.c * c, base.b * -s + base.d * c,
    base.a * g.x + base.c * g.y + base.e, base.b * g.x + base.d * g.y + base.f);
}

/** Back to the caller's transform after the last glyph. */
function exitFrames(ctx: CanvasRenderingContext2D, base: DOMMatrix | null): void {
  if (base) ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
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

function drawGlyphs(
  ps: PaintState,
  glyphs: GlyphPlacement[],
  textWidth: number,
  tb: TextBaseline,
): void {
  const { ctx } = ps;
  const base = frameBase(ctx);
  for (const g of glyphs) {
    ps.glyph(g.style);
    const baseY = baselineLocalY(tb, g.ascent, g.descent);
    const paints = glyphPaints(ps, g.style, clipPaintFor(ctx, g, textWidth, baseY), strokePaintFor(ctx, g, textWidth, baseY));
    enterFrame(ps, base, g);
    paintGlyphs(ps, g.style, [{ text: g.char, x: 0 }], baseY, paints);
    if (!base) ps.restore();
  }
  exitFrames(ctx, base);
}

/**
 * Lands a straight band's run-local points on a run's glyph frames: x runs
 * along the glyphs, each covering its natural width; y is each glyph's own.
 * A line bends at every glyph joint, so one stroke carries its dash pattern
 * along the curve.
 */
class BentPen implements Pen {
  private x = 0;
  private y = 0;
  /** Each glyph's start along the run. */
  private readonly starts: number[];

  constructor(private readonly ctx: CanvasRenderingContext2D, private readonly run: GlyphPlacement[]) {
    this.starts = run.map(g => g.pathOffset - run[0].pathOffset);
  }

  /** The glyph whose span holds x; the end glyphs extend past the run. */
  private glyphAt(x: number): number {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  private point(x: number, y: number, i = this.glyphAt(x)): [number, number] {
    const g = this.run[i];
    const lx = x - this.starts[i];
    const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
    return [g.x + c * lx - s * y, g.y + s * lx + c * y];
  }

  moveTo(x: number, y: number): void {
    this.ctx.moveTo(...this.point(x, y));
    this.x = x; this.y = y;
  }

  lineTo(x: number, y: number): void {
    const from = this.glyphAt(this.x), to = this.glyphAt(x);
    const step = to > from ? 1 : -1;
    for (let i = from; i !== to; i += step) {
      // The joint, in the frame of the glyph being entered.
      const next = step > 0 ? i + 1 : i;
      const jx = this.starts[next];
      const jy = this.y + (y - this.y) * (jx - this.x) / (x - this.x);
      this.ctx.lineTo(...this.point(jx, jy, next));
    }
    this.ctx.lineTo(...this.point(x, y, to));
    this.x = x; this.y = y;
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.ctx.bezierCurveTo(...this.point(c1x, c1y), ...this.point(c2x, c2y), ...this.point(x, y));
    this.x = x; this.y = y;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ctx.quadraticCurveTo(...this.point(cx, cy), ...this.point(x, y));
    this.x = x; this.y = y;
  }
}

/**
 * One band over a run: a colored band is one stroke bent along the run; a
 * transparent one shows the clip paint, a gradient in each glyph's frame, so
 * it paints each glyph's slice there.
 */
function paintRunBand(
  ps: PaintState, run: GlyphPlacement[], band: Band, color: string, textWidth: number, tb: TextBaseline,
): void {
  if (!isTransparent(color)) {
    paintBand(ps, band, color, new BentPen(ps.ctx, run));
    return;
  }
  const { ctx } = ps;
  const base = frameBase(ctx);
  for (const g of run) {
    const paint = clipPaintFor(ctx, g, textWidth, baselineLocalY(tb, g.ascent, g.descent));
    if (!paint) continue;
    enterFrame(ps, base, g);
    ps.save();
    ctx.beginPath();
    ctx.rect(0, band.y - band.fontSize, g.width, 2 * band.fontSize + band.rows);
    ctx.clip();
    paintBand(ps, { ...band, x: run[0].pathOffset - g.pathOffset }, paint);
    ps.restore();
    if (!base) ps.restore();
  }
  exitFrames(ctx, base);
}

/**
 * Paint each same-style run (one text node's glyphs: the fragment) in engine
 * order: under/overlines, glyphs, line-throughs. `visible` narrows the glyphs
 * painted (a shadow tile); bands always span the run.
 */
function paintRuns(
  ps: PaintState, glyphs: GlyphPlacement[], textWidth: number, tb: TextBaseline, visible?: Set<GlyphPlacement>,
): void {
  for (let i = 0; i < glyphs.length;) {
    const { style } = glyphs[i];
    let j = i + 1;
    while (j < glyphs.length && glyphs[j].style === style) j++;
    const run = glyphs.slice(i, j);
    i = j;
    let bands: { band: Band; deco: { color: string } }[] = [];
    if (style.textDecorations.length) {
      const head = run[0], tail = run[run.length - 1];
      const baseY = baselineLocalY(tb, head.ascent, head.descent);
      bands = fragmentBands(ps, style, 0, tail.pathOffset + tail.width - head.pathOffset, baseY, 0);
    }
    for (const b of bands) if (b.band.line !== 'line-through') paintRunBand(ps, run, b.band, b.deco.color, textWidth, tb);
    drawGlyphs(ps, visible ? run.filter(g => visible.has(g)) : run, textWidth, tb);
    for (const b of bands) if (b.band.line === 'line-through') paintRunBand(ps, run, b.band, b.deco.color, textWidth, tb);
  }
}
