import type { ResolvedStyle, ShadowOptions } from './types.js';
import {
  buildCanvasFont, canvasKerning, claimCtx, formatLetterSpacing, getFontMetrics, nextCtxWriterId,
  type FontMetricsTable,
} from './layout.js';
import { parseLinearGradient } from './gradient.js';
import { ScratchPool, withoutCanvasShadow } from './shadow.js';

// Writes each ctx property only on change (a save/restore per run is a q/Q on
// a PDF proxy) and never relies on `restore` to put a value back. Another
// writer during a draw must go through the tracker, restore the value, or
// `claimCtx` (as a nested `layout()` does). Values written inside save() are
// forgotten at restore() and written again on next use.

type Key =
  | 'font' | 'fontKerning' | 'letterSpacing' | 'wordSpacing'
  | 'textBaseline' | 'textAlign' | 'direction'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap' | 'lineDash';

type Paint = string | CanvasGradient;

const NO_DASH: readonly number[] = [];
const COVERAGE = '#000';

export class PaintState {
  private readonly known: Partial<Record<Key, unknown>> = {
    // Assumed: only decorations change dash or cap, and `finish()` resets them.
    lineDash: '',
    lineCap: 'butt',
  };
  private readonly scopes: Key[][] = [];
  private readonly fonts = new Map<ResolvedStyle, string>();
  private readonly gradients = new Map<string, CanvasGradient | null>();
  private readonly writerId = nextCtxWriterId();

  /** @param deviceScale — device pixels per CSS pixel (the caller's `pixelRatio`). */
  constructor(
    readonly ctx: CanvasRenderingContext2D, readonly deviceScale = 1,
    /** A text-shadow mask: paint opaque coverage, transparent glyphs included. */
    readonly coverage = false,
    /** Layout's metrics (`layoutFontMetrics`); misses are measured on this ctx. */
    private readonly fontMetrics?: FontMetricsTable,
  ) {}

  fontBox(style: ResolvedStyle): { ascent: number; descent: number } {
    return this.fontMetrics?.get(this.fontOf(style)) ?? getFontMetrics(this.ctx, style);
  }

  private fontOf(style: ResolvedStyle): string {
    let font = this.fonts.get(style);
    if (font === undefined) this.fonts.set(style, font = buildCanvasFont(style));
    return font;
  }

  private set(key: Key, value: unknown): void {
    if (this.known[key] === value) return;
    (this.ctx as unknown as Record<string, unknown>)[key] = value;
    this.remember(key, value);
  }

  private remember(key: Key, value: unknown): void {
    this.known[key] = value;
    if (this.scopes.length) this.scopes[this.scopes.length - 1].push(key);
  }

  /** Width-affecting state, from the same helpers `Measurer` uses. */
  font(style: ResolvedStyle): void {
    // Another writer touched the ctx: forget what it writes.
    if (claimCtx(this.writerId)) {
      const known = this.known;
      known.font = known.fontKerning = known.letterSpacing = known.wordSpacing = undefined;
    }
    this.set('font', this.fontOf(style));
    this.set('fontKerning', canvasKerning(style));
    this.set('letterSpacing', formatLetterSpacing(style.letterSpacing));
  }

  /** Everything a block run's text calls read; alignment is written for LTR too. */
  text(style: ResolvedStyle): void {
    this.font(style);
    this.set('wordSpacing', `${style.wordSpacing || 0}px`);
    this.set('textBaseline', 'alphabetic');
    const rtl = style.direction === 'rtl';
    this.set('direction', rtl ? 'rtl' : 'ltr');
    this.set('textAlign', rtl ? 'right' : 'left');
  }

  /** Path glyphs: placed at their own origin, baseline handled by the caller. */
  glyph(style: ResolvedStyle): void {
    this.font(style);
    this.set('textBaseline', 'alphabetic');
  }

  fill(paint: Paint): void {
    this.set('fillStyle', this.coverage ? COVERAGE : paint);
  }

  stroke(
    paint: Paint, lineWidth: number, dash: readonly number[] = NO_DASH,
    cap: CanvasLineCap = 'butt', join: CanvasLineJoin = 'miter',
  ): void {
    this.set('strokeStyle', this.coverage ? COVERAGE : paint);
    this.set('lineWidth', lineWidth);
    this.set('lineJoin', join);
    this.set('lineCap', cap);
    this.dash(dash);
  }

  /** One gradient per CSS gradient and box on this ctx, so a PDF proxy emits
   * one shading per fragment, not per word. */
  linearGradient(image: string, x: number, width: number, y: number, height: number): CanvasGradient | null {
    const key = `${x},${y},${width},${height} ${image}`;
    let gradient = this.gradients.get(key);
    if (gradient === undefined) {
      this.gradients.set(key, gradient = parseLinearGradient(this.ctx, image, x, width, y, height));
    }
    return gradient;
  }

  /** -webkit-text-stroke; a --rt-text-stroke-image gradient wins over the color. */
  textStroke(style: ResolvedStyle, strokeGradient?: CanvasGradient | null): void {
    const join = style.strokeLinejoin;
    this.stroke(strokeGradient || style.webkitTextStrokeColor || style.color, style.webkitTextStrokeWidth,
      NO_DASH, 'butt', join === 'miter' || join === 'bevel' ? join : 'round');
  }

  private dash(segments: readonly number[]): void {
    const key = segments.join(',');
    if (this.known.lineDash === key) return;
    this.ctx.setLineDash(segments as number[]);
    this.remember('lineDash', key);
  }

  save(): void {
    this.ctx.save();
    this.scopes.push([]);
  }

  restore(): void {
    this.ctx.restore();
    for (const key of this.scopes.pop() ?? []) delete this.known[key];
  }

  /** Reset dash and cap for a ctx whose restore may not. */
  finish(): void {
    if (this.known.lineDash !== '') this.dash(NO_DASH);
    if (this.known.lineCap !== 'butt') this.set('lineCap', 'butt');
  }
}

/** One draw: a tracker per target ctx inside one save/restore. `pool` is null
 * under `renderShadows: false`, which also clears the caller's canvas shadow. */
export function withDraw(
  ctx: CanvasRenderingContext2D, options: ShadowOptions, scale: number,
  fontMetrics: FontMetricsTable | undefined,
  draw: (stateOf: (target: CanvasRenderingContext2D) => PaintState, pool: ScratchPool | null) => void,
): void {
  const states = new Map<CanvasRenderingContext2D, PaintState>();
  const stateOf = (target: CanvasRenderingContext2D) => {
    let ps = states.get(target);
    if (!ps) states.set(target, ps = new PaintState(target, scale, false, fontMetrics));
    return ps;
  };
  const pool = options.renderShadows === false ? null : new ScratchPool(ctx, options.createCanvas);
  ctx.save();
  try {
    if (pool) draw(stateOf, pool);
    else withoutCanvasShadow(ctx, () => draw(stateOf, null));
  } finally {
    pool?.dispose();
    for (const ps of states.values()) ps.finish();
    ctx.restore();
  }
}
