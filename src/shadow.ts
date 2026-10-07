import type { AnyCanvas, CanvasFactory, ResolvedStyle } from './types.js';

export interface TextShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
}

/** A CSS text-shadow list ("2px 2px 4px rgba(0,0,0,0.3), ...") as values. */
function parseTextShadows(shadow: string, currentColor: string): TextShadow[] {
  if (!shadow || shadow === 'none') return [];
  const shadows: TextShadow[] = [];
  for (const part of shadow.split(/,(?![^(]*\))/)) {
    const tokens = part.trim().match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? [];
    const lengths: number[] = [];
    let color = currentColor;
    for (const token of tokens) {
      if (/^[+-]?(?:\d*\.)?\d+(?:px)?$/.test(token)) lengths.push(parseFloat(token));
      else color = token.toLowerCase() === 'currentcolor' ? currentColor : token;
    }
    if (lengths.length < 2 || lengths.length > 3 || (lengths[2] ?? 0) < 0) continue;
    shadows.push({ offsetX: lengths[0], offsetY: lengths[1], blur: lengths[2] ?? 0, color });
  }
  return shadows;
}

/** A style's parsed shadows and their grouping key, cached in the caller's
 * per-draw map (styles may change between draws). */
export function shadowsOf(
  cache: Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>, style: ResolvedStyle,
): { shadows: TextShadow[]; key: string } {
  let entry = cache.get(style);
  if (!entry) {
    const shadows = parseTextShadows(style.textShadow, style.color);
    cache.set(style, entry = { shadows, key: JSON.stringify(shadows) });
  }
  return entry;
}

export interface PaintBounds { x: number; y: number; width: number; height: number }
type Matrix = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;
type Paint = (ctx: CanvasRenderingContext2D) => void;

/** Measure layout-owned paint independently of the caller's current drawing
 * state. A shared layout context may have been reused since layout completed. */
export function measurePaintBounds(ctx: CanvasRenderingContext2D, measure: () => PaintBounds): PaintBounds {
  ctx.save();
  ctx.textAlign = 'left'; ctx.direction = 'ltr';
  ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px'; ctx.miterLimit = 10;
  try { return measure(); }
  finally { ctx.restore(); }
}

/** Also works on drawing-command proxies whose save/restore only snapshots
 * their vector graphics state, not emulated canvas shadow properties. */
export function withoutCanvasShadow(ctx: CanvasRenderingContext2D, paint: Paint): void {
  const color = ctx.shadowColor;
  ctx.shadowColor = 'transparent';
  try { paint(ctx); }
  finally { ctx.shadowColor = color; }
}

function requireShadowContext(ctx: CanvasRenderingContext2D): void {
  if (typeof ctx.getTransform !== 'function' || typeof ctx.setTransform !== 'function' ||
      typeof ctx.drawImage !== 'function') {
    throw new Error('render-tag: shadows require a Canvas 2D context with getTransform, setTransform and drawImage. For vector adapters, set renderShadows: false and paint shadows separately.');
  }
}

export function unionBounds(a: PaintBounds, b: PaintBounds): PaintBounds {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function transformBounds(bounds: PaintBounds, m: Matrix): PaintBounds {
  const xs: number[] = [], ys: number[] = [];
  for (const x of [bounds.x, bounds.x + bounds.width]) {
    for (const y of [bounds.y, bounds.y + bounds.height]) {
      xs.push(m.a * x + m.c * y + m.e);
      ys.push(m.b * x + m.d * y + m.f);
    }
  }
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Conservative ink bounds with the same context state used to paint the text.
 * These include negative bearings, joins and decorations, not just line boxes. */
export function textPaintBounds(
  ctx: CanvasRenderingContext2D, text: string, style: ResolvedStyle,
  x: number, y: number, width: number, rightAligned = false,
): PaintBounds {
  const metrics = ctx.measureText(text);
  const stroke = style.webkitTextStrokeWidth / 2 *
    (style.strokeLinejoin === 'miter' ? ctx.miterLimit : 1);
  let pad = 2 + stroke;
  for (const deco of style.textDecorations) {
    const thickness = deco.declarer.textDecorationThickness ?? Math.max(1, deco.declarer.fontSize / 15);
    pad = Math.max(pad, 2 + stroke + Math.abs(deco.declarer.textUnderlineOffset ?? deco.declarer.fontSize * 0.2) + thickness * 4);
  }
  // TextMetrics already accounts for alignment/direction relative to (x, y).
  // Keep the layout advance too: decoration geometry uses it independently.
  const left = Math.min(rightAligned ? -width : 0, -(metrics.actualBoundingBoxLeft || 0));
  const right = Math.max(rightAligned ? 0 : width, metrics.actualBoundingBoxRight || 0);
  const ascent = Math.max(style.fontSize, metrics.actualBoundingBoxAscent || 0);
  const descent = Math.max(style.fontSize * 0.5, metrics.actualBoundingBoxDescent || 0);
  // WebKit can omit synthetic italics from TextMetrics. Its painter shears by
  // 14 degrees (WebCore/FontCascade.h::syntheticObliqueAngle). Canvas does not
  // expose whether a face was synthesized, so conservatively allow that shear.
  const skew = /^(italic|oblique)\b/.test(style.fontStyle) ? Math.tan(14 * Math.PI / 180) : 0;
  return { x: x + left - pad - descent * skew, y: y - ascent - pad,
    width: right - left + pad * 2 + (ascent + descent) * skew, height: ascent + descent + pad * 2 };
}

export function shadowBounds(bounds: PaintBounds, shadows: TextShadow[]): PaintBounds {
  let result = bounds;
  for (const shadow of shadows) {
    const pad = blurPad(shadow.blur);
    result = unionBounds(result, {
      x: bounds.x + shadow.offsetX - pad, y: bounds.y + shadow.offsetY - pad,
      width: bounds.width + pad * 2, height: bounds.height + pad * 2,
    });
  }
  return result;
}

function makeCanvas(ctx: CanvasRenderingContext2D, width: number, height: number, createCanvas?: CanvasFactory): AnyCanvas {
  let canvas: AnyCanvas;
  if (createCanvas) canvas = createCanvas(width, height);
  else if (ctx.canvas.ownerDocument) canvas = ctx.canvas.ownerDocument.createElement('canvas');
  else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else throw new Error('render-tag: shadows require a scratch canvas — provide createCanvas in non-browser environments.');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas): CanvasRenderingContext2D {
  const target = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!target) throw new Error('render-tag: createCanvas must provide a 2D canvas.');
  return target;
}

/**
 * The scratch canvases of one draw. Two kinds, by where a canvas goes:
 *
 * - A canvas `drawImage`d onto the caller's ctx is `handed()` out fresh and
 *   never touched again: a vector adapter may embed it asynchronously
 *   (README, PDF adapter contract), so reusing or resizing it after the
 *   `drawImage` could change what the adapter reads.
 * - A canvas only ever drawn into ANOTHER scratch canvas (a shadow mask, the
 *   caller-shadow source) is `acquire()`d from the pool, `release()`d as soon
 *   as its image is cast, reused by the next request it can hold, and freed
 *   (0×0) by `dispose()` when the draw ends.
 *
 * A pooled canvas may be larger than the request; it is cleared whole on
 * reuse, and the request's region starts at (0, 0). It is always drawn
 * whole — the rest is transparent and casts nothing — because WebKit drops
 * the shadow of a source-rect `drawImage` whose destination lies entirely
 * off-surface (measured: no shadow at all), and casting is exactly that.
 */
export class ScratchPool {
  private readonly owned: AnyCanvas[] = [];
  private readonly idle: AnyCanvas[] = [];

  constructor(private readonly ctx: CanvasRenderingContext2D, private readonly createCanvas?: CanvasFactory) {}

  acquire(width: number, height: number): AnyCanvas {
    let pick = -1;
    for (let i = 0; i < this.idle.length; i++) {
      const c = this.idle[i];
      if (c.width >= width && c.height >= height &&
        (pick < 0 || c.width * c.height < this.idle[pick].width * this.idle[pick].height)) pick = i;
    }
    if (pick >= 0) {
      const canvas = this.idle.splice(pick, 1)[0];
      const target = context2d(canvas);
      if (typeof target.reset === 'function') target.reset();
      else {
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.clearRect(0, 0, canvas.width, canvas.height);
      }
      return canvas;
    }
    const grown = this.idle.pop();
    if (grown) {
      // Resizing reallocates, clears and resets the state.
      grown.width = Math.max(grown.width, width);
      grown.height = Math.max(grown.height, height);
      return grown;
    }
    const canvas = makeCanvas(this.ctx, width, height, this.createCanvas);
    this.owned.push(canvas);
    return canvas;
  }

  release(canvas: AnyCanvas): void {
    this.idle.push(canvas);
  }

  handed(width: number, height: number): AnyCanvas {
    return makeCanvas(this.ctx, width, height, this.createCanvas);
  }

  /** Is `ctx` one of this pool's canvases? A drawImage onto it is consumed
   * synchronously, so its source is scratch, not handed out. */
  owns(ctx: CanvasRenderingContext2D): boolean {
    return this.owned.includes(ctx.canvas as AnyCanvas);
  }

  dispose(): void {
    for (const canvas of this.owned) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.owned.length = 0;
    this.idle.length = 0;
  }
}

/** Point `target` at the caller's drawing state, with `matrix` moved so
 * device pixel (x, y) lands on the target's origin. Destination opacity,
 * clipping, filters and blending apply when painting the effect image and
 * foreground, not while collecting shadow coverage. */
function prepareLayer(
  target: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, matrix: Matrix, x: number, y: number,
): void {
  for (const key of ['font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering',
    'letterSpacing', 'wordSpacing', 'textAlign', 'textBaseline', 'direction',
    'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
    'fillStyle', 'strokeStyle', 'imageSmoothingEnabled', 'imageSmoothingQuality'] as const) {
    if (key in ctx) (target as any)[key] = ctx[key];
  }
  target.setLineDash(ctx.getLineDash());
  target.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
}

/** Whole device pixels covering `device`, plus one pixel of antialiasing room. */
function pixelBox(device: PaintBounds): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(device.x) - 1, y = Math.floor(device.y) - 1;
  return {
    x, y,
    width: Math.max(1, Math.ceil(device.x + device.width) - x + 1),
    height: Math.max(1, Math.ceil(device.y + device.height) - y + 1),
  };
}

/** Rasterize `paint` over `bounds` into a pooled canvas; release it after use. */
function layer(
  ctx: CanvasRenderingContext2D, bounds: PaintBounds, matrix: Matrix, paint: Paint, pool: ScratchPool,
) {
  const { x, y, width, height } = pixelBox(transformBounds(bounds, matrix));
  const canvas = pool.acquire(width, height);
  const target = context2d(canvas);
  prepareLayer(target, ctx, matrix, x, y);
  paint(target);
  return { canvas, x, y, width, height };
}

/** Canvas shadowBlur is twice sigma. Four sigma plus antialiasing room. */
function blurPad(blur: number): number {
  return Math.ceil(blur * 2) + 2;
}

/**
 * Cast `source`'s shadow into `target` with the source's origin at (x, y),
 * without the source itself: the source is drawn entirely off-surface and
 * only its shadow lands. Moving the caster away preserves shadow beneath
 * translucent foreground; subtracting the caster would erase it. The image
 * is unscaled, which avoids both WebKit's gradient-shadow corruption and Node
 * canvas backends that drop shadows of scaled off-surface images.
 *
 * Needs x <= the target's width (both callers satisfy it). The displacement
 * is the smallest that keeps the source off any such target: WebKit's blur
 * moves by a few levels with the offset's magnitude (measured: adding the
 * blur pad to it shifted a 16px blur by up to 7/255).
 */
function castShadow(
  target: CanvasRenderingContext2D, source: AnyCanvas, x: number, y: number, blur: number, color: string,
): void {
  const displacement = target.canvas.width + source.width;
  target.shadowColor = color;
  target.shadowBlur = blur;
  target.shadowOffsetX = displacement;
  target.shadowOffsetY = 0;
  target.drawImage(source, x - displacement, y);
}

/** Cast the caller's shadow from the completed rendering, then paint foreground
 * commands directly. This retains vector text and per-paint opacity/blending. */
export function withCanvasShadow(
  ctx: CanvasRenderingContext2D, bounds: () => PaintBounds, paint: Paint, pool: ScratchPool,
): void {
  const color = ctx.shadowColor;
  const hasShadow = color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)' &&
    color !== '#00000000' && (ctx.shadowBlur > 0 || ctx.shadowOffsetX !== 0 || ctx.shadowOffsetY !== 0);
  if (!hasShadow) { paint(ctx); return; }
  requireShadowContext(ctx);
  const source = layer(ctx, bounds(), ctx.getTransform(), paint, pool);
  const pad = blurPad(ctx.shadowBlur);
  const shadow = pool.handed(source.width + pad * 2, source.height + pad * 2);
  const target = context2d(shadow);
  castShadow(target, source.canvas, pad, pad, ctx.shadowBlur, color);
  pool.release(source.canvas);
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = 'transparent';
    ctx.drawImage(shadow, source.x - pad + ctx.shadowOffsetX, source.y - pad + ctx.shadowOffsetY);
  } finally {
    ctx.restore();
    // A drawing-command proxy may not save its emulated shadow properties.
    ctx.shadowColor = color;
  }
  withoutCanvasShadow(ctx, paint);
}

/** A tile's image covers about this many pixels: enough rows that the blur
 * margin each tile repaints stays small, few enough that the pooled mask is
 * a few MB instead of a whole document (50 paragraphs at DPR 2: 1173×6990). */
const TILE_PIXELS = 1 << 20;

/** A piece of a shadow group: its ink in layout coordinates. */
export interface ShadowPiece { bounds: PaintBounds }

/**
 * Paint only the shadows of a text group; its foreground is painted once by
 * the caller, after every shadow group. CSS lengths live in layout coordinates.
 *
 * The group's pieces are rasterized into ONE coverage mask and every shadow
 * value is cast from it, so overlapping glyphs cast one shadow, not two. The
 * shadows of all values land in one image per tile (painted last value
 * first, so the first is on top) and that image is `drawImage`d once.
 *
 * Under a uniform transform the image is cut into horizontal tiles. A tile's
 * pixels depend only on the mask within the blur margin of its rows, so each
 * tile rasterizes just the pieces in that window, into a pooled mask — the
 * same pixels as one whole-group mask, at a fraction of the memory, and a
 * window holding no piece costs nothing. Tiles sit on whole device pixels and
 * are drawn unscaled, so they abut exactly; a nonuniform transform draws its
 * image scaled, where tile seams would filter, so it keeps one tile.
 *
 * `paint` draws the pieces it is given onto the mask, whose transform maps
 * layout coordinates.
 */
export function paintTextShadows<T extends ShadowPiece>(
  ctx: CanvasRenderingContext2D, pieces: readonly T[], shadows: TextShadow[],
  paint: (mask: CanvasRenderingContext2D, pieces: readonly T[]) => void, pool: ScratchPool,
): void {
  if (!shadows.length || !pieces.length) return;
  requireShadowContext(ctx);
  const m = ctx.getTransform();
  // Largest singular value: enough samples under rotation, scale and shear.
  const sum = m.a * m.a + m.b * m.b + m.c * m.c + m.d * m.d;
  const determinant = m.a * m.d - m.b * m.c;
  const uniform = Math.abs(m.a * m.a + m.b * m.b - m.c * m.c - m.d * m.d) < 1e-8 &&
    Math.abs(m.a * m.c + m.b * m.d) < 1e-8;
  const scale = uniform ? Math.hypot(m.a, m.b) :
    Math.max(1, Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * determinant * determinant))) / 2));
  if (scale === 0) return;
  // Uniform transforms can rasterize directly in device space, retaining the
  // foreground's glyph hinting. Nonuniform transforms need a local-space blur
  // that stretches/shears along with the text.
  const space: Matrix = uniform ? m : { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
  // Each value in mask space: its offset (scaled and rotated with the text),
  // its blur and the margin that blur reaches.
  const casts = shadows.map(shadow => ({
    dx: space.a * shadow.offsetX + space.c * shadow.offsetY,
    dy: space.b * shadow.offsetX + space.d * shadow.offsetY,
    blur: shadow.blur * scale, pad: blurPad(shadow.blur * scale), color: shadow.color,
  }));
  // Image pixels reach this far from the mask's (relative extents).
  const left = Math.floor(Math.min(...casts.map(c => c.dx - c.pad)));
  const right = Math.ceil(Math.max(...casts.map(c => c.dx + c.pad)));
  const top = Math.floor(Math.min(...casts.map(c => c.dy - c.pad)));
  const bottom = Math.ceil(Math.max(...casts.map(c => c.dy + c.pad)));

  const boxes = pieces.map(piece => transformBounds(piece.bounds, space));
  const all = pixelBox(boxes.reduce(unionBounds));
  const imageTop = all.y + top, imageBottom = all.y + all.height + bottom;
  const rows = uniform
    ? Math.max(64, Math.floor(TILE_PIXELS / (all.width + right - left)))
    : imageBottom - imageTop;

  ctx.save();
  try {
    if (uniform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let tileTop = imageTop; tileTop < imageBottom; tileTop += rows) {
      const tileBottom = Math.min(imageBottom, tileTop + rows);
      // Mask rows whose shadow can reach this tile.
      const windowTop = tileTop - bottom, windowBottom = tileBottom - top;
      const inside: T[] = [];
      let ink: PaintBounds | undefined;
      boxes.forEach((box, i) => {
        if (box.y >= windowBottom || box.y + box.height <= windowTop) return;
        inside.push(pieces[i]);
        ink = ink ? unionBounds(ink, box) : box;
      });
      if (!ink) continue;
      const area = pixelBox(ink);
      const maskTop = Math.max(area.y, windowTop);
      const maskBottom = Math.min(area.y + area.height, windowBottom);
      const y0 = Math.max(tileTop, maskTop + top), y1 = Math.min(tileBottom, maskBottom + bottom);
      if (maskBottom <= maskTop || y1 <= y0) continue;
      const maskHeight = maskBottom - maskTop;

      const mask = pool.acquire(area.width, maskHeight);
      const target = context2d(mask);
      prepareLayer(target, ctx, space, area.x, maskTop);
      paint(target, inside);

      const x0 = area.x + left;
      // Onto the caller's ctx the image is handed out; onto a pooled canvas
      // (the caller-shadow source layer) it is scratch like the mask.
      const scratchImage = pool.owns(ctx);
      const image = scratchImage
        ? pool.acquire(area.width + right - left, y1 - y0)
        : pool.handed(area.width + right - left, y1 - y0);
      const out = context2d(image);
      out.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
      if ('imageSmoothingQuality' in ctx) out.imageSmoothingQuality = ctx.imageSmoothingQuality;
      // Last value first: the first shadow is painted on top. A fractional
      // offset moves the mask, not the blurred image — both are linear
      // filters, so resampling before the blur equals resampling after.
      for (let i = casts.length - 1; i >= 0; i--) {
        const cast = casts[i];
        castShadow(out, mask, area.x - x0 + cast.dx, maskTop - y0 + cast.dy, cast.blur, cast.color);
      }
      pool.release(mask);
      if (uniform) ctx.drawImage(image, x0, y0);
      else ctx.drawImage(image, x0 / scale, y0 / scale, image.width / scale, image.height / scale);
      if (scratchImage) pool.release(image);
    }
  } finally { ctx.restore(); }
}
