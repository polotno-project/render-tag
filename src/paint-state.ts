import type { ResolvedStyle, ShadowOptions } from './types.js';
import {
  buildCanvasFont, canvasKerning, canvasSpacing, claimCtx, formatLetterSpacing, getFontMetrics, nextCtxWriterId,
  type FontMetricsTable,
} from './layout.js';
import { parseLinearGradient } from './gradient.js';
import { ScratchPool, withoutCanvasShadow } from './shadow.js';

// Writes each ctx property only on change (a save/restore per run is a q/Q on
// a PDF proxy) and never relies on `restore` to put a value back. Another
// writer during a draw must go through the tracker, restore the value,
// `claimCtx` (as a nested `layout()` does) or be followed by `forget()` (a
// `paintTextUnit` callback). Values written inside save() are forgotten at
// restore() and written again on next use.

type Key =
  | 'font' | 'fontKerning' | 'letterSpacing' | 'wordSpacing'
  | 'textBaseline' | 'textAlign' | 'direction'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap' | 'lineDash';

type Paint = string | CanvasGradient;

const NO_DASH: readonly number[] = [];
const COVERAGE = '#000';

/** The text state a style writes, derived once per style per draw. */
interface TextState {
  readonly font: string;
  readonly kerning: CanvasFontKerning;
  /** As written: 0px for the spacing the ctx does not apply, which render-tag places. */
  readonly letterSpacing: string;
  readonly wordSpacing: string;
  readonly rtl: boolean;
  /** The spacing render-tag places itself (`spacedPieces`); null when the ctx applies it all. */
  readonly unapplied: { letter: number; word: number } | null;
  /** `PaintState.measure` results under this state. */
  widths: Map<string, number> | undefined;
}

/** Which spacings a ctx applies itself (`canvasSpacing`): one answer for every canvas of one
 * factory, so a draw's scratch canvases ask once. */
interface CanvasSupport { spacing?: { letter: boolean; word: boolean } }

export class PaintState {
  private known: Partial<Record<Key, unknown>> = {
    // Assumed: only decorations change dash or cap, and `finish()` resets them.
    lineDash: '',
    lineCap: 'butt',
  };
  private readonly scopes: Key[][] = [];
  private readonly texts = new Map<ResolvedStyle, TextState>();
  private readonly gradients = new Map<string, CanvasGradient | null>();
  private readonly writerId = nextCtxWriterId();

  /** @param deviceScale — device pixels per CSS pixel (the caller's `pixelRatio`). */
  constructor(
    readonly ctx: CanvasRenderingContext2D, readonly deviceScale = 1,
    /** A text-shadow mask: paint opaque coverage, transparent glyphs included. */
    readonly coverage = false,
    /** Layout's metrics (`layoutFontMetrics`); misses are measured on this ctx. */
    private readonly fontMetrics?: FontMetricsTable,
    private readonly support: CanvasSupport = {},
  ) {}

  fontBox(style: ResolvedStyle): { ascent: number; descent: number } {
    return this.fontMetrics?.get(this.textState(style).font) ?? getFontMetrics(this.ctx, style);
  }

  private textState(style: ResolvedStyle): TextState {
    let state = this.texts.get(style);
    if (!state) {
      const letter = style.letterSpacing || 0, word = style.wordSpacing || 0;
      // Asked before a spacing is written: asking writes both and claims the ctx.
      const applies = letter || word ? this.support.spacing ??= canvasSpacing(this.ctx) : undefined;
      const unapplied = { letter: applies?.letter === false ? letter : 0, word: applies?.word === false ? word : 0 };
      state = {
        font: buildCanvasFont(style), kerning: canvasKerning(style),
        letterSpacing: formatLetterSpacing(unapplied.letter ? 0 : letter),
        wordSpacing: `${unapplied.word ? 0 : word}px`, rtl: style.direction === 'rtl',
        unapplied: unapplied.letter || unapplied.word ? unapplied : null, widths: undefined,
      };
      this.texts.set(style, state);
    }
    return state;
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
    const t = this.textState(style);
    // Another writer touched the ctx (the spacing probe too): forget what it writes.
    if (claimCtx(this.writerId)) {
      const known = this.known;
      known.font = known.fontKerning = known.letterSpacing = known.wordSpacing = undefined;
    }
    this.set('font', t.font);
    this.set('fontKerning', t.kerning);
    this.set('letterSpacing', t.letterSpacing);
  }

  /** Width of `text` in `direction(rtl)`, under the rest of what `text(style)` wrote, once per draw. */
  measure(style: ResolvedStyle, text: string, rtl: boolean): number {
    const widths = this.textState(style).widths ??= new Map();
    const key = (rtl ? 'r' : 'l') + text;
    let width = widths.get(key);
    if (width === undefined) {
      this.direction(rtl);
      widths.set(key, width = this.ctx.measureText(text).width);
    }
    return width;
  }

  /** Everything a block run's text calls read; alignment is written for LTR too. Returns the
   * spacing the ctx does not apply itself, which render-tag places (`spacedPieces`). */
  text(style: ResolvedStyle): { letter: number; word: number } | null {
    this.font(style);
    const t = this.textState(style);
    this.set('wordSpacing', t.wordSpacing);
    this.set('textBaseline', 'alphabetic');
    this.direction(t.rtl);
    return t.unapplied;
  }

  /** Canvas's base direction, aligned so a fillText's x is its start edge. */
  direction(rtl: boolean): void {
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

  /** Forget everything: another writer (a `paintTextUnit` callback) may have written anything. */
  forget(): void {
    this.known = {};
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
  draw: (
    stateOf: (target: CanvasRenderingContext2D) => PaintState, pool: ScratchPool | null,
    /** A new tracker for a pooled canvas, reused within a draw. */
    layerState: (target: CanvasRenderingContext2D, coverage?: boolean) => PaintState,
  ) => void,
): void {
  const states = new Map<CanvasRenderingContext2D, PaintState>();
  // One factory makes every pooled canvas: they share whether they apply spacing.
  const scratch: CanvasSupport = {};
  const layerState = (target: CanvasRenderingContext2D, coverage = false) =>
    new PaintState(target, scale, coverage, fontMetrics, scratch);
  const stateOf = (target: CanvasRenderingContext2D) => {
    let ps = states.get(target);
    if (!ps) states.set(target, ps = target === ctx ? new PaintState(target, scale, false, fontMetrics) : layerState(target));
    return ps;
  };
  const pool = options.renderShadows === false ? null : new ScratchPool(ctx, options.createCanvas);
  ctx.save();
  try {
    if (pool) draw(stateOf, pool, layerState);
    else withoutCanvasShadow(ctx, () => draw(stateOf, null, layerState));
  } finally {
    pool?.dispose();
    for (const ps of states.values()) ps.finish();
    ctx.restore();
  }
}
