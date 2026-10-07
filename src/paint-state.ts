import type { ResolvedStyle } from './types.js';
import { buildCanvasFont, canvasKerning, formatLetterSpacing } from './layout.js';
import { parseLinearGradient } from './gradient.js';

// ─── Paint state ──────────────────────────────────────────────────────
//
// Paint used to wrap every text run in `save` → font, baseline, kerning,
// spacing → `restore`: 3,675 pairs for a large document, and on a PDF proxy
// each pair is a q/Q in the content stream. `PaintState` instead writes each
// property only when the value changes, and never relies on `restore` to put
// one back — some drawing-command proxies do not snapshot every property
// (shadow.ts), so every value an operation reads is written for it.
//
// A tracker starts knowing nothing about its ctx (the caller's, or a reused
// one, holds whatever it holds), so its first write of each property always
// happens. Anything else that writes a tracked property on the same ctx
// during a draw must either go through the tracker or put the value back,
// as `getFontMetrics` does.
//
// `save()`/`restore()` are for a transform or clip scope that genuinely needs
// them. A value written inside the scope is forgotten when it closes: the ctx
// may or may not have rolled it back, so the next use writes it again.

type Key =
  | 'font' | 'fontKerning' | 'letterSpacing' | 'wordSpacing'
  | 'textBaseline' | 'textAlign' | 'direction'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap' | 'lineDash';

type Paint = string | CanvasGradient;

const NO_DASH: readonly number[] = [];
/** What a coverage mask paints with. */
const COVERAGE = '#000';

export class PaintState {
  private readonly known: Partial<Record<Key, unknown>> = {
    // The one assumed value. Paint has always stroked borders and text
    // strokes under the caller's dash, which is solid unless the caller set
    // one; assuming it keeps `setLineDash` off contexts that never see a
    // dashed band. Only decorations set a dash, and `finish()` clears it.
    lineDash: '',
    // Assumed the same way: only a round-dotted decoration changes the cap.
    lineCap: 'butt',
  };
  private readonly scopes: Key[][] = [];
  private readonly fonts = new Map<ResolvedStyle, string>();
  private readonly gradients = new Map<string, CanvasGradient | null>();

  /**
   * @param deviceScale — device pixels per CSS pixel on this ctx, as the
   * caller's `pixelRatio` declares it (paint cannot ask a proxy for its
   * transform). WebKit rounds a decoration's thickness on this grid.
   */
  constructor(
    readonly ctx: CanvasRenderingContext2D, readonly deviceScale = 1,
    /**
     * A text-shadow mask: every fill and stroke paints opaque black. The
     * engines cast a text-shadow from the glyphs' SHAPE in the shadow's own
     * color — a transparent or 40%-alpha fill still casts a full shadow
     * (tests/text-shadow-coverage.test.ts) — so the mask records coverage,
     * not color, and the paint sites fill a transparent glyph here too.
     */
    readonly coverage = false,
  ) {}

  private set(key: Key, value: unknown): void {
    if (this.known[key] === value) return;
    (this.ctx as unknown as Record<string, unknown>)[key] = value;
    this.known[key] = value;
    if (this.scopes.length) this.scopes[this.scopes.length - 1].push(key);
  }

  /**
   * The state a width depends on — font, kerning, letter-spacing — from the
   * same helpers `Measurer` measures with, so paint cannot drift from the
   * measurement that placed the text.
   */
  font(style: ResolvedStyle): void {
    let font = this.fonts.get(style);
    if (font === undefined) this.fonts.set(style, font = buildCanvasFont(style));
    this.set('font', font);
    this.set('fontKerning', canvasKerning(style));
    this.set('letterSpacing', formatLetterSpacing(style.letterSpacing));
  }

  /**
   * Everything a block text run's fillText/strokeText/measureText reads.
   * Alignment and direction are written for LTR too: `node.x` is the run's
   * left edge (its right edge under RTL), whatever the caller's ctx says.
   */
  text(style: ResolvedStyle): void {
    this.font(style);
    // Written even at 0: layout measured spaces with their word-spacing
    // already in their width.
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

  /** A box border or decoration band: mitered, butt-capped, solid unless
   * `dash` says so. */
  stroke(
    paint: Paint, lineWidth: number, dash: readonly number[] = NO_DASH,
    cap: CanvasLineCap = 'butt',
  ): void {
    this.set('strokeStyle', this.coverage ? COVERAGE : paint);
    this.set('lineWidth', lineWidth);
    this.set('lineJoin', 'miter');
    this.set('lineCap', cap);
    this.dash(dash);
  }

  /**
   * One `CanvasGradient` per CSS gradient and paint box on this ctx: every
   * run of a fragment (and every fragment of a declarer on one line) shares
   * the object, so a PDF proxy emits one shading, not one per word. Per ctx,
   * because a gradient made by one context is not a paint on another.
   */
  linearGradient(image: string, x: number, width: number, y: number, height: number): CanvasGradient | null {
    const key = `${x},${y},${width},${height} ${image}`;
    let gradient = this.gradients.get(key);
    if (gradient === undefined) {
      this.gradients.set(key, gradient = parseLinearGradient(this.ctx, image, x, width, y, height));
    }
    return gradient;
  }

  /**
   * -webkit-text-stroke. A gradient stroke (--rt-text-stroke-image,
   * pre-resolved) wins over the solid stroke color, mirroring how a
   * background-clip:text gradient wins over `color` for the fill.
   */
  textStroke(style: ResolvedStyle, strokeGradient?: CanvasGradient | null): void {
    this.set('strokeStyle', this.coverage ? COVERAGE : strokeGradient || style.webkitTextStrokeColor || style.color);
    this.set('lineWidth', style.webkitTextStrokeWidth);
    const join = style.strokeLinejoin;
    this.set('lineJoin', join === 'miter' || join === 'bevel' ? join : 'round');
    this.set('lineCap', 'butt');
    this.dash(NO_DASH);
  }

  private dash(segments: readonly number[]): void {
    const key = segments.join(',');
    if (this.known.lineDash === key) return;
    this.ctx.setLineDash(segments as number[]);
    this.known.lineDash = key;
    if (this.scopes.length) this.scopes[this.scopes.length - 1].push('lineDash');
  }

  save(): void {
    this.ctx.save();
    this.scopes.push([]);
  }

  restore(): void {
    this.ctx.restore();
    for (const key of this.scopes.pop() ?? []) delete this.known[key];
  }

  /** Leave no dash or round cap behind for a ctx whose restore would not
   * clear it. */
  finish(): void {
    if (this.known.lineDash !== '') this.dash(NO_DASH);
    if (this.known.lineCap !== 'butt') this.set('lineCap', 'butt');
  }
}
