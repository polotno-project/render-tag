import type { AnyCanvas, CanvasFactory, ResolvedStyle } from './types.js';

export interface TextShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
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
    // Canvas shadowBlur is twice sigma. Four sigma plus antialiasing room.
    const pad = Math.ceil(shadow.blur * 2) + 2;
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

function layer(
  ctx: CanvasRenderingContext2D, bounds: PaintBounds, matrix: Matrix,
  paint: Paint, createCanvas?: CanvasFactory,
) {
  const device = transformBounds(bounds, matrix);
  const x = Math.floor(device.x) - 1, y = Math.floor(device.y) - 1;
  const width = Math.max(1, Math.ceil(device.x + device.width) - x + 1);
  const height = Math.max(1, Math.ceil(device.y + device.height) - y + 1);
  const canvas = makeCanvas(ctx, width, height, createCanvas);
  const target = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!target) throw new Error('render-tag: createCanvas must provide a 2D canvas.');
  // Preserve drawing state that may affect source geometry. Destination
  // opacity, clipping, filters and blending apply when painting the effect
  // image and foreground, not while collecting shadow coverage.
  for (const key of ['font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering',
    'letterSpacing', 'wordSpacing', 'textAlign', 'textBaseline', 'direction',
    'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
    'fillStyle', 'strokeStyle', 'imageSmoothingEnabled', 'imageSmoothingQuality'] as const) {
    if (key in ctx) (target as any)[key] = ctx[key];
  }
  target.setLineDash(ctx.getLineDash());
  target.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
  paint(target);
  return { canvas, x, y };
}

/** Produce just the shadow. Moving the caster entirely off-surface preserves
 * shadow beneath translucent foreground; subtracting the caster would erase it. */
function shadowImage(
  ctx: CanvasRenderingContext2D, source: AnyCanvas, blur: number, color: string,
  createCanvas?: CanvasFactory,
) {
  const pad = Math.ceil(blur * 2) + 2;
  const canvas = makeCanvas(ctx, source.width + pad * 2, source.height + pad * 2, createCanvas);
  const target = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!target) throw new Error('render-tag: createCanvas must provide a 2D canvas.');
  const displacement = canvas.width + source.width;
  target.shadowColor = color;
  target.shadowBlur = blur;
  target.shadowOffsetX = displacement;
  // An unscaled image avoids both WebKit's gradient-shadow corruption and
  // Node canvas backends that drop shadows of scaled off-surface images.
  target.drawImage(source, pad - displacement, pad);
  return { canvas, pad };
}

/** Cast the caller's shadow from the completed rendering, then paint foreground
 * commands directly. This retains vector text and per-paint opacity/blending. */
export function withCanvasShadow(
  ctx: CanvasRenderingContext2D, bounds: () => PaintBounds, paint: Paint,
  createCanvas?: CanvasFactory,
): void {
  const color = ctx.shadowColor;
  const hasShadow = color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)' &&
    color !== '#00000000' && (ctx.shadowBlur > 0 || ctx.shadowOffsetX !== 0 || ctx.shadowOffsetY !== 0);
  if (!hasShadow) { paint(ctx); return; }
  requireShadowContext(ctx);
  const source = layer(ctx, bounds(), ctx.getTransform(), paint, createCanvas);
  const shadow = shadowImage(ctx, source.canvas, ctx.shadowBlur, color, createCanvas);
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = 'transparent';
    ctx.drawImage(shadow.canvas, source.x - shadow.pad + ctx.shadowOffsetX,
      source.y - shadow.pad + ctx.shadowOffsetY);
  } finally {
    ctx.restore();
    // A drawing-command proxy may not save its emulated shadow properties.
    ctx.shadowColor = color;
  }
  withoutCanvasShadow(ctx, paint);
}

/** Paint only the shadows of a text group; its foreground is painted once by
 * the caller, after every shadow group. CSS lengths live in layout coordinates. */
export function paintTextShadows(
  ctx: CanvasRenderingContext2D, bounds: PaintBounds, shadows: TextShadow[],
  paint: Paint, createCanvas?: CanvasFactory,
): void {
  if (!shadows.length) return;
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
  const source = layer(ctx, bounds, uniform ? m : { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }, paint, createCanvas);
  ctx.save();
  try {
    if (uniform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = shadows.length - 1; i >= 0; i--) {
      const shadow = shadows[i];
      const { canvas, pad } = shadowImage(ctx, source.canvas, shadow.blur * scale, shadow.color, createCanvas);
      if (uniform) {
        ctx.drawImage(canvas, source.x - pad + m.a * shadow.offsetX + m.c * shadow.offsetY,
          source.y - pad + m.b * shadow.offsetX + m.d * shadow.offsetY);
      } else {
        ctx.drawImage(canvas,
          (source.x - pad) / scale + shadow.offsetX,
          (source.y - pad) / scale + shadow.offsetY,
          canvas.width / scale, canvas.height / scale);
      }
    }
  } finally { ctx.restore(); }
}
