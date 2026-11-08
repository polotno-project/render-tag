// One `buildLayoutTree` call's state and its measuring primitive. The deliberate module
// state lives here: `layoutFontMetrics`, the `claimCtx` token, the symbols.
import type { StyledNode, LayoutBox, LayoutText, LayoutLineBox, ResolvedStyle, LayoutLine } from '../types.js';
import { LINE_HEIGHT_MULTIPLIER } from '../css-resolver.js';
import { createFallbackMeasureCtx } from '../dom.js';
import { CANVAS_CEILS_FONT_BOX, CANVAS_WIDENS_SYNTHETIC_BOLD, INK_BOX_FROM_PAINT } from '../engine.js';
import { graphemes, letterSpaced, type PreparedInline } from './segment.js';

/**
 * Everything one `buildLayoutTree` call owns, threaded down as `session`. Layout keeps no
 * module state, so a nested call cannot touch the outer one (`tests/node/reentrancy.test.ts`).
 */
export interface LayoutSession {
  /** The call's one measuring primitive (and its per-call font state). */
  readonly measurer: Measurer;
  readonly debug: ((entry: import('../types.ts').DebugEntry) => void) | undefined;
  /** One entry per committed line (inline content and list markers), unsorted. */
  readonly lines: LayoutLine[];
  /** Content-box intrinsic widths by node identity (`contentSize`). */
  readonly minContent: Map<StyledNode, number>;
  readonly maxContent: Map<StyledNode, number>;
  /** The block wrapper of each bare text node in a flex container (`anonymousFlexItem`). */
  readonly anonymousFlexItems: Map<StyledNode, StyledNode>;
  /** Inline contexts intrinsic sizing prepared, until layout takes them (`takePreparedInline`). */
  readonly prepared: Map<StyledNode, PreparedInline>;
  /** The opposite-direction copy of a style a bidi piece paints with (`withDirection`). */
  readonly flippedDirection: Map<ResolvedStyle, ResolvedStyle>;
  /** Work counts for `tests/node/perf-counters.test.ts`; undefined outside it. */
  readonly stats: LayoutStats | undefined;
  /** Text units are built after layout: emit and markers write the stamps they read
   * (`LINE_BOX`, `INLINE_BLOCK`, ...). Off, runs keep the plain path's few shapes. */
  readonly units: boolean;
}

/** Work counts no ctx call shows, for `tests/node/perf-counters.test.ts`. Internal. */
export interface LayoutStats {
  /** Times an inline formatting context's text was segmented and measured. */
  tokenizePasses: number;
  /** Segments those passes produced. */
  segments: number;
  /** `Word` objects the line flow hands the emit pass, plus a clamp's ellipsis. */
  wordObjects: number;
  /** Items `gluedRunEnd` read: linear in a word split across runs, never quadratic. */
  glueSteps: number;
  /** Characters `breakGluedChain` cut such a word into: only for a word that splits. */
  chainCells: number;
}

// ── Canvas font helpers ──

/**
 * The `ctx.fontKerning` value a style resolves to: `auto` as `normal`, since Chrome's DOM
 * kerns a space its canvas `auto` leaves unkerned (Arimo " A": -5.5px at 100px).
 */
export function canvasKerning(style: ResolvedStyle): CanvasFontKerning {
  return style.fontKerning === 'none' ? 'none' : 'normal';
}

const CANVAS_TEXT_RENDERING: Record<string, CanvasTextRendering> = {
  optimizespeed: 'optimizeSpeed', geometricprecision: 'geometricPrecision',
};

/**
 * The `ctx.textRendering` value a style resolves to. Chrome's canvas `auto` skips OpenType
 * features its DOM applies at CSS `auto` (a space between Hangul words measures 106.616px
 * on canvas, 107.531px in the DOM); `optimizeLegibility` measures as the DOM does on 99.7%
 * of 11,387 strings, against 98.6% for `auto`. Firefox's canvas widths ignore the property
 * and WebKit's canvas has none.
 */
export function canvasTextRendering(style: ResolvedStyle): CanvasTextRendering {
  return CANVAS_TEXT_RENDERING[style.textRendering] ?? 'optimizeLegibility';
}

/** Format a letter-spacing value (px) as a canvas `ctx.letterSpacing` string. */
export function formatLetterSpacing(value: number): string {
  // Negative letter-spacing is valid (Chrome applies it per character); a non-finite value
  // would make a px string canvas silently ignores.
  return Number.isFinite(value) && value !== 0 ? `${value}px` : '0px';
}

/**
 * Which spacings `ctx` applies itself, asked of its own `measureText`: Safari before 18.4,
 * Chrome before 99, Firefox before 115 and node-canvas (which keeps both properties) apply
 * neither, so render-tag adds them. Leaves both at 0px.
 */
export function canvasSpacing(ctx: CanvasRenderingContext2D): { letter: boolean; word: boolean } {
  claimCtx(SPACING_PROBE);
  ctx.letterSpacing = '0px';
  ctx.wordSpacing = '0px';
  const plain = ctx.measureText('H H').width;
  ctx.letterSpacing = '10px';
  const letter = ctx.measureText('H H').width > plain;
  ctx.letterSpacing = '0px';
  ctx.wordSpacing = '10px';
  const word = ctx.measureText('H H').width > plain;
  ctx.wordSpacing = '0px';
  return { letter, word };
}

/** Build a canvas font string. Not memoized: callers keep it per style object. */
export function buildCanvasFont(style: ResolvedStyle): string {
  const parts: string[] = [];
  // CSS font shorthand order: style, variant, weight, size, family.
  if (style.fontStyle !== 'normal') parts.push(style.fontStyle);
  if (style.fontVariantCaps === 'small-caps') parts.push('small-caps');
  if (style.fontWeight !== 400) parts.push(String(style.fontWeight));
  parts.push(`${style.fontSize}px`);
  parts.push(style.fontFamily);
  return parts.join(' ');
}

export const BULLET_MARKERS = new Set(['disc', 'circle', 'square']);

// ── Measurement ──
// `Measurer` is the only layout code that writes measuring state, and it writes all of it.
// Nothing outlives one call: fonts load between calls and each ctx is its own oracle.

/** The canvas state a width depends on, interned per call by value (one width cache each). */
export interface MeasureState {
  readonly font: string;
  readonly kerning: CanvasFontKerning;
  readonly textRendering: CanvasTextRendering;
  readonly lang: string;
  readonly letterSpacing: string;
  /** `measureText` widths under this state, by text. */
  readonly widths: Map<string, number>;
  /** `Measurer.fontUnits`; shared by every percentage basis that snapshots them. */
  units: { ch: number; ex: number } | undefined;
  /** `Measurer.inkBox` results under this state, by text. */
  inks: Map<string, InkBox> | undefined;
}

type FontBox = Readonly<{ ascent: number; descent: number }>;

/** Ink extents from the pen origin, signed like `TextMetrics`' `actualBoundingBox*`. */
type InkBox = Readonly<{ ascent: number; descent: number; left: number; right: number }>;

/**
 * Font metrics each result was laid out with, keyed by the result (a `layoutRoot` or a path
 * result). Paint reads them (`PaintState.fontBox`), so a result paints on its own metrics
 * whatever ctx it is painted on; a miss measures on the paint ctx.
 */
export const layoutFontMetrics = new WeakMap<object, FontMetricsTable>();
export type FontMetricsTable = Map<string, FontBox>;

/**
 * Id of the last writer (`Measurer`, `PaintState`) to write canvas state to any ctx; a
 * writer that finds another wrote since forgets what it believed the ctx holds. A number,
 * not the writer, so the measurer is not kept alive after the call.
 */
let lastCtxWriter = 0;
let ctxWriterIds = 0;
const SPACING_PROBE = nextCtxWriterId();
const OBLIQUE_PROBE = nextCtxWriterId();
const OBLIQUE_SAMPLE = 'Hamburgefonstiv';
const BOLD_PROBE = nextCtxWriterId();

/**
 * The canvas font of `style`. `oblique <angle>` under 14deg: Chrome picks the upright face (a
 * slnt axis takes the angle) and measures it upright; a canvas that measures it apart picked
 * another face (`@napi-rs/canvas`: the italic one) and gets 'normal', the face Chrome draws.
 * `seen` keeps the answer per font for one ctx.
 */
export function canvasFont(ctx: CanvasRenderingContext2D, style: ResolvedStyle, seen: Map<string, string>): string {
  const font = buildCanvasFont(style);
  const angle = /^oblique (-?[\d.]+)deg$/.exec(style.fontStyle)?.[1];
  if (angle === undefined || !(Math.abs(parseFloat(angle)) < 14)) return font;
  let answer = seen.get(font);
  if (answer === undefined) {
    // Leaves the font as found: a paint may probe between setting its font and drawing.
    claimCtx(OBLIQUE_PROBE);
    const before = ctx.font;
    const upright = buildCanvasFont({ ...style, fontStyle: 'normal' });
    ctx.font = upright;
    const width = ctx.measureText(OBLIQUE_SAMPLE).width;
    ctx.font = font;
    answer = ctx.measureText(OBLIQUE_SAMPLE).width === width ? font : upright;
    ctx.font = before;
    seen.set(font, answer);
  }
  return answer;
}

/**
 * What the canvas adds to each glyph of `style` for a synthetic bold (`CANVAS_WIDENS_SYNTHETIC_BOLD`),
 * else 0: a weight the family lacks widens every glyph alike ("iiiiiiii" and "WWWWWWWW" by the
 * same), a real bold face does not. `seen` keeps the answer per font for one ctx.
 */
export function syntheticBoldWidening(ctx: CanvasRenderingContext2D, style: ResolvedStyle, seen: Map<string, number>): number {
  if (!CANVAS_WIDENS_SYNTHETIC_BOLD || style.fontWeight < 600) return 0;
  const font = buildCanvasFont(style);
  let widening = seen.get(font);
  if (widening === undefined) {
    // Leaves the font as found: a paint may probe between setting its font and drawing.
    claimCtx(BOLD_PROBE);
    const before = ctx.font;
    const regular = buildCanvasFont({ ...style, fontWeight: 400 });
    const added = (sample: string) => {
      ctx.font = font;
      const bold = ctx.measureText(sample).width;
      ctx.font = regular;
      return bold - ctx.measureText(sample).width;
    };
    const narrow = added('iiiiiiii');
    widening = narrow > 0 && Math.abs(narrow - added('WWWWWWWW')) < 0.05 ? narrow / 8 : 0;
    ctx.font = before;
    seen.set(font, widening);
  }
  return widening;
}

/** A fresh writer id for `claimCtx`. */
export function nextCtxWriterId(): number {
  return ++ctxWriterIds;
}

/** Claim the ctx for writer `id`: true when another writer wrote since (its belief is stale). */
export function claimCtx(id: number): boolean {
  if (lastCtxWriter === id) return false;
  lastCtxWriter = id;
  return true;
}

export type TabStops = Readonly<{ interval: number; halfSpace: number }>;

/**
 * What one style's text needs from the canvas, derived once per call and keyed by style
 * identity.
 */
interface FontState {
  readonly measure: MeasureState;
  metrics: FontBox | undefined;
  computedLineHeight: number | undefined;
  usedLineHeight: number | undefined;
  box: FontBox | undefined;
  tabStops: TabStops | undefined;
}

export class Measurer {
  /** What this measurer last wrote to the ctx; null = unknown. */
  private current: MeasureState | null = null;
  private readonly states = new Map<string, MeasureState>();
  private readonly fonts = new Map<ResolvedStyle, FontState>();
  /** This measurer's `claimCtx` id. */
  private readonly writerId = nextCtxWriterId();
  /** The canvas `inkBox` paints on. */
  private readback: CanvasRenderingContext2D | undefined;
  /** Whether the ctx applies `letterSpacing` itself, asked once a width needs it. */
  private appliesLetterSpacing: boolean | undefined;
  /** `canvasFont`'s and `syntheticBoldWidening`'s answers for this ctx. */
  private readonly canvasFonts = new Map<string, string>();
  private readonly boldWidenings = new Map<string, number>();

  /**
   * Clears the ctx's word-spacing: spaces carry it in their own measured width.
   * `fontMetrics` is the call's table (`layoutFontMetrics`).
   */
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    private readonly fontMetrics: FontMetricsTable,
  ) {
    const spacing = ctx as CanvasRenderingContext2D & { wordSpacing?: string };
    if (spacing.wordSpacing && spacing.wordSpacing !== '0px') spacing.wordSpacing = '0px';
  }

  /** A style's own measuring state: its font, kerning, text rendering, language and letter-spacing. */
  stateOf(style: ResolvedStyle): MeasureState {
    return this.font(style).measure;
  }

  /**
   * Width of `text` under `state`, measured once per call. On a ctx that ignores
   * `letterSpacing` (`canvasSpacing`), plus the spacing per `letterSpaced`.
   */
  width(state: MeasureState, text: string): number {
    let width = state.widths.get(text);
    if (width === undefined) {
      const spacing = parseFloat(state.letterSpacing);
      // Asked before measuring: asking writes the ctx's spacing.
      const added = spacing && !(this.appliesLetterSpacing ??= canvasSpacing(this.ctx).letter)
        ? spacing * letterSpaced(graphemes(text)).filter(Boolean).length : 0;
      width = this.measureText(state, text).width + added;
      state.widths.set(text, width);
    }
    return width;
  }

  /** Uncached, for ink metrics: its `width` is not `width`'s on a ctx that ignores letterSpacing. */
  private measureText(state: MeasureState, text: string): TextMetrics {
    this.use(state);
    return this.ctx.measureText(text);
  }

  /**
   * The ink extents of `text` under `state`, once per call. Where `measureText`'s box is not
   * the painted ink (`INK_BOX_FROM_PAINT`), they are read off the painted text.
   */
  inkBox(state: MeasureState, text: string): InkBox {
    const inks = state.inks ??= new Map();
    let ink = inks.get(text);
    if (!ink) {
      const m = this.measureText(state, text);
      ink = {
        ascent: m.actualBoundingBoxAscent ?? 0,
        descent: m.actualBoundingBoxDescent ?? 0,
        left: m.actualBoundingBoxLeft ?? 0,
        right: m.actualBoundingBoxRight ?? m.width,
      };
      if (INK_BOX_FROM_PAINT) {
        // Null once the canvas memory cap is hit (iOS).
        const readback = this.readback ??= createFallbackMeasureCtx(true);
        if (readback) ink = paintedInkBox(readback, state, text, ink) ?? ink;
      }
      inks.set(text, ink);
    }
    return ink;
  }

  /** The font's ascent and descent (font bounding box). */
  metrics(style: ResolvedStyle): FontBox {
    const fs = this.font(style);
    if (!fs.metrics) {
      const font = fs.measure.font;
      let metrics = this.fontMetrics.get(font);
      if (!metrics) {
        const at = (size: number) => size === style.fontSize ? fs.measure
          : this.intern(buildCanvasFont({ ...style, fontSize: size }), 'normal', canvasTextRendering(style), style.lang, '0px');
        metrics = chromeFontBox(style.fontSize, (size) => fontBox(this.measureText(at(size), 'M')));
        this.fontMetrics.set(font, metrics);
      }
      fs.metrics = metrics;
    }
    return fs.metrics;
  }

  /**
   * The used height of a line box from this style: `multipliedLineHeight` for a number,
   * `usedLineHeight` for a length.
   */
  lineHeight(style: ResolvedStyle): number {
    const fs = this.font(style);
    if (fs.usedLineHeight !== undefined) return fs.usedLineHeight;
    const multiplier = lineHeightMultiplier(style);
    return fs.usedLineHeight = multiplier !== undefined
      ? multipliedLineHeight(style.fontSize, multiplier)
      : usedLineHeight(this.computedLineHeight(style));
  }

  /**
   * The computed line height: the CSS value, or for `normal` the font bounding box. A
   * percentage `vertical-align` resolves against this.
   */
  computedLineHeight(style: ResolvedStyle): number {
    const fs = this.font(style);
    let lineHeight = fs.computedLineHeight;
    if (lineHeight === undefined) {
      if (hasLineHeight(style)) {
        lineHeight = style.lineHeight;
      } else {
        const { ascent, descent } = this.metrics(style);
        lineHeight = ascent + descent;
      }
      fs.computedLineHeight = lineHeight;
    }
    return lineHeight;
  }

  /**
   * One box's half of a line over its OWN line-height: content area plus half-leading (CSS 2.1
   * §10.8). `text-top`/`text-bottom` align these edges. Shared: do not mutate.
   */
  leadedBox(style: ResolvedStyle): FontBox {
    const fs = this.font(style);
    let box = fs.box;
    if (!box) {
      const { ascent, descent } = this.metrics(style);
      const lineHeight = this.lineHeight(style);
      const boxAscent = lineBaselineOffset(lineHeight, ascent, descent);
      box = fs.box = { ascent: boxAscent, descent: lineHeight - boxAscent };
    }
    return box;
  }

  /**
   * `ch` (advance of `0`) and `ex` (ink ascent of `x`, ~1-2% over the OS/2 x-height) for the
   * resolver; 0.5em when the ctx cannot answer (CSS Values 4).
   */
  fontUnits(style: ResolvedStyle): { ch: number; ex: number } {
    const state = this.intern(canvasFont(this.ctx, style, this.canvasFonts), 'normal', canvasTextRendering(style),
      style.lang, '0px');
    if (!state.units) {
      const ch = this.width(state, '0');
      const ex = this.measureText(state, 'x').actualBoundingBoxAscent;
      const half = style.fontSize / 2;
      state.units = { ch: ch > 0 ? ch : half, ex: ex > 0 ? ex : half };
    }
    return state.units;
  }

  /** See `tabStopMetrics`. */
  tabStops(style: ResolvedStyle): TabStops {
    const fs = this.font(style);
    if (!fs.tabStops) {
      // Measured with letter-spacing off; the block's spacing is added per stop.
      const { font, kerning, textRendering, lang } = fs.measure;
      const spaceless = this.intern(font, kerning, textRendering, lang, '0px');
      const spaceWidth = this.width(spaceless, ' ');
      fs.tabStops = {
        interval: (spaceWidth + (style.letterSpacing || 0) + (style.wordSpacing || 0)) * 8,
        halfSpace: spaceWidth / 2,
      };
    }
    return fs.tabStops;
  }

  private font(style: ResolvedStyle): FontState {
    let fs = this.fonts.get(style);
    if (!fs) {
      // A synthetic bold measures on the regular face's advances, as Chrome lays it out.
      const measured = syntheticBoldWidening(this.ctx, style, this.boldWidenings) ? { ...style, fontWeight: 400 } : style;
      fs = {
        measure: this.intern(canvasFont(this.ctx, measured, this.canvasFonts), canvasKerning(style),
          canvasTextRendering(style), style.lang, formatLetterSpacing(style.letterSpacing)),
        metrics: undefined,
        computedLineHeight: undefined,
        usedLineHeight: undefined,
        box: undefined,
        tabStops: undefined,
      };
      this.fonts.set(style, fs);
    }
    return fs;
  }

  private intern(
    font: string, kerning: CanvasFontKerning, textRendering: CanvasTextRendering, lang: string, letterSpacing: string,
  ): MeasureState {
    const key = font + '\0' + kerning + '\0' + textRendering + '\0' + lang + '\0' + letterSpacing;
    let state = this.states.get(key);
    if (!state) {
      state = {
        font, kerning, textRendering, lang, letterSpacing, widths: new Map(), units: undefined, inks: undefined,
      };
      this.states.set(key, state);
    }
    return state;
  }

  /** Write `state` to the ctx — all of it, but only what differs. */
  private use(state: MeasureState): void {
    if (claimCtx(this.writerId)) this.current = null;
    if (this.current === state) return;
    writeMeasureState(this.ctx, state, this.current);
    this.current = state;
  }
}

/** Write `state` to `ctx`: what differs from `prev`, or all of it. */
function writeMeasureState(ctx: CanvasRenderingContext2D, state: MeasureState, prev: MeasureState | null): void {
  if (prev?.font !== state.font) ctx.font = state.font;
  if (prev?.kerning !== state.kerning) ctx.fontKerning = state.kerning;
  if (prev?.textRendering !== state.textRendering) ctx.textRendering = state.textRendering;
  // Not in TypeScript's DOM types yet (Chrome, Firefox); a ctx without it keeps an expando.
  if (prev?.lang !== state.lang) (ctx as CanvasRenderingContext2D & { lang?: string }).lang = state.lang;
  if (prev?.letterSpacing !== state.letterSpacing) ctx.letterSpacing = state.letterSpacing;
}

/**
 * Device pixels `paintedInkBox` gives the longer side of the box it reads. Each edge is
 * where coverage crosses one half, interpolated between pixels: at 256 within 0.8% of a
 * 512px read (WebKit's antialiased edges sit ~0.6px outside the outline), for a quarter
 * of the readback.
 */
const INK_PROBE_PIXELS = 256;
/** CSS px `paintedInkBox` reads around the measured box: Gecko's is ~1px off the ink. */
const INK_PROBE_MARGIN = 2;

/**
 * The ink extents of `text` read off its paint on `ctx`, around `measured` (`measureText`'s
 * box, within `INK_PROBE_MARGIN` of the ink). Null when the pixels show no ink inside the
 * margin.
 */
function paintedInkBox(
  ctx: CanvasRenderingContext2D,
  state: MeasureState,
  text: string,
  measured: InkBox,
): InkBox | null {
  // How far the read area reaches from the pen origin.
  const reachLeft = Math.max(measured.left, 0) + INK_PROBE_MARGIN;
  const reachRight = Math.max(measured.right, 0) + INK_PROBE_MARGIN;
  const reachUp = Math.max(measured.ascent, 0) + INK_PROBE_MARGIN;
  const reachDown = Math.max(measured.descent, 0) + INK_PROBE_MARGIN;
  const scale = INK_PROBE_PIXELS / Math.max(reachLeft + reachRight, reachUp + reachDown);
  const originX = Math.ceil(reachLeft * scale);
  const originY = Math.ceil(reachUp * scale);
  // Resizing clears the canvas and resets its state.
  ctx.canvas.width = originX + Math.ceil(reachRight * scale);
  ctx.canvas.height = originY + Math.ceil(reachDown * scale);
  writeMeasureState(ctx, state, null);
  ctx.setTransform(scale, 0, 0, scale, originX, originY);
  ctx.fillText(text, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  // WebKit caps the memory of live canvases, collected or not.
  ctx.canvas.width = ctx.canvas.height = 0;
  // The most covered pixel of each column and row.
  const columns = new Uint8Array(width);
  const rows = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > columns[x]) columns[x] = alpha;
      if (alpha > rows[y]) rows[y] = alpha;
    }
  }
  const left = halfCoverEdge(columns, 1), right = halfCoverEdge(columns, -1);
  const top = halfCoverEdge(rows, 1), bottom = halfCoverEdge(rows, -1);
  // Ink at the edge is clipped, or the readback is not the paint (Firefox's fingerprinting
  // protection reads opaque white).
  if (left === null || right === null || top === null || bottom === null || right <= left ||
    columns[0] >= 128 || columns[width - 1] >= 128 || rows[0] >= 128 || rows[height - 1] >= 128) return null;
  return {
    ascent: (originY - top!) / scale,
    descent: (bottom! - originY) / scale,
    left: (originX - left) / scale,
    right: (right - originX) / scale,
  };
}

/** Where coverage first crosses one half walking in from the start (`step` 1) or the end
 * (`step` -1), interpolated between pixels; null with no such pixel. */
function halfCoverEdge(coverage: Uint8Array, step: 1 | -1): number | null {
  const n = coverage.length;
  for (let k = 0; k < n; k++) {
    const i = step === 1 ? k : n - 1 - k;
    if (coverage[i] < 128) continue;
    const outside = coverage[i - step] ?? 0;
    const t = (coverage[i] - 127.5) / (coverage[i] - outside || 1);
    return step === 1 ? i + 0.5 - t : i + 0.5 + t;
  }
  return null;
}

/** Large enough that the canvas's whole-px font box is exact to 1/2000em (under 0.01px at a
 * text size), small enough for every canvas: Firefox's font box stops growing past 2000px
 * (Arimo: 1811 / 424 at 2000px and at 4000px), Chrome clamps a font at 10000px. */
const EXACT_PROBE_SIZE = 2000;

/**
 * The ascent and descent Chrome lays text out on, from the font box `measure` reads at a size:
 * each rounded to a whole px (Blink's SimpleFontData), as Chrome's and WebKit's canvases report
 * them. Firefox's ceils them (`CANVAS_CEILS_FONT_BOX`): read there at EXACT_PROBE_SIZE, where
 * whole-px rounding is negligible, and scaled to `fontSize` before rounding.
 */
function chromeFontBox(fontSize: number, measure: (size: number) => FontBox): FontBox {
  const size = CANVAS_CEILS_FONT_BOX ? EXACT_PROBE_SIZE : fontSize;
  const box = measure(size);
  return { ascent: Math.round(box.ascent * fontSize / size), descent: Math.round(box.descent * fontSize / size) };
}

/** A font's ascent and descent, from any TextMetrics measured in it. */
function fontBox(m: TextMetrics): FontBox {
  return {
    ascent: m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent,
    descent: m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent,
  };
}

/**
 * Each run's line-box top, for `paintLineSnap`. A symbol key, off the public `LayoutText`
 * shape; a WeakMap entry per run made GC 40% of a long document's layout.
 */
export const LINE_TOP: unique symbol = Symbol('lineTop');
/** Marks a LayoutText that starts a measuring run (`startsMeasuredRun`). A symbol: no public field. */
export const RUN_SEAM: unique symbol = Symbol('runSeam');
/** A list marker run's own line box (`addListMarker`): text units keep it out of the words. */
export const LIST_MARKER: unique symbol = Symbol('listMarker');
/** Marks a run whose text ends with a line-clamp's '…' (`applyEllipsisToLine`). */
export const CLAMP_ELLIPSIS: unique symbol = Symbol('clampEllipsis');
/** An inline-block's content run: its outermost box and that box's line (emit). */
export const INLINE_BLOCK: unique symbol = Symbol('inlineBlock');
/** A run's line box, by identity (emit). */
export const LINE_BOX: unique symbol = Symbol('lineBox');
/** A single-paint bidi run's own levels (`singlePaintLine`) when any differs from the paragraph's,
 * which it paints in. Unstamped, a run is one level in its `style.direction`. */
export const RUN_LEVELS: unique symbol = Symbol('runLevels');
export type PrivateText = LayoutText & {
  [LINE_TOP]?: number; [RUN_SEAM]?: true; [LIST_MARKER]?: PrivateLineBox; [CLAMP_ELLIPSIS]?: true;
  [INLINE_BLOCK]?: { box: LayoutBox; line: LayoutLineBox }; [LINE_BOX]?: LayoutLineBox;
  [RUN_LEVELS]?: Uint8Array;
};
/** A run's text-unit pieces (`buildTextUnits`), set only on a layout made with text units. */
export const RUN_PIECES: unique symbol = Symbol('runPieces');
/** Marks a line box whose soft wrap consumed white space: the words on either side are two. */
export const SPACE_WRAP: unique symbol = Symbol('spaceWrap');
/** A line box's baseline. */
export const LINE_BASELINE: unique symbol = Symbol('lineBaseline');
export type PrivateLineBox = LayoutLineBox & { [SPACE_WRAP]?: true; [LINE_BASELINE]?: number };

/** True when `node` starts at a `SEG_RUN_SEAM`; a tree this layout did not produce batches by style. */
export function startsMeasuredRun(node: LayoutText): boolean {
  return (node as PrivateText)[RUN_SEAM] === true;
}

/**
 * A run's line paint offset, `round(lineTop) - lineTop`: Chrome paints each line box at a
 * whole CSS pixel (round half up of its top) while layout stays fractional.
 * line-paint-snap-parity. A node this layout did not produce uses its baseline as the line top.
 */
export function paintLineSnap(node: LayoutText): number {
  const top = (node as PrivateText)[LINE_TOP] ?? node.lineBaselineY ?? node.y;
  return Math.round(top) - top;
}

/** Not `normal`: a length, or zero (carried as the multiplier 0; css-resolver). */
function hasLineHeight(style: ResolvedStyle): boolean {
  return style.lineHeight > 0 || lineHeightMultiplier(style) === 0;
}

/** The line-height multiplier of a unitless `line-height` (css-resolver). */
function lineHeightMultiplier(style: ResolvedStyle): number | undefined {
  return (style as { [LINE_HEIGHT_MULTIPLIER]?: number })[LINE_HEIGHT_MULTIPLIER];
}

/**
 * Line box height of a UNITLESS line-height, as Blink lays it on its 1/64px LayoutUnit grid:
 * the font-size rounded onto the grid, the product floored onto it in double (14px x 1.6 =
 * 22.390625). line-baseline-parity.
 */
function multipliedLineHeight(fontSize: number, multiplier: number): number {
  // The epsilon keeps 20 x 1.15 (22.999999999999996) on its grid line, as Blink does.
  return Math.floor((Math.round(fontSize * 64) / 64) * multiplier * 64 + 1e-6) / 64;
}

/** The used height of a computed line-height LENGTH: Blink rounds it to 1/64px. Idempotent. */
function usedLineHeight(lineHeight: number): number {
  return Math.round(lineHeight * 64) / 64;
}

/**
 * Baseline offset from a line box's top, as Blink places it: the half-leading over the used
 * line-height, halved in LayoutUnits truncating toward zero (Verdana 13.6px x 1.25: 14, not
 * 13), plus the ascent, floored to a whole CSS pixel. Pass the computed line-height. Public:
 * renderers placing a baseline beside a render-tag canvas call it rather than restate it.
 */
export function lineBaselineOffset(lineHeight: number, ascent: number, descent: number): number {
  const halfLeading = Math.trunc((usedLineHeight(lineHeight) - (ascent + descent)) / 2 * 64) / 64;
  return Math.floor(halfLeading + ascent);
}

/**
 * Tab stops for a block, as Chrome sizes them: tab-size(8) x the BLOCK font's space
 * advance (letter-spacing off) plus its letter- and word-spacing per stop. `halfSpace`: a
 * stop closer than half a space is skipped (Blink Font::TabWidth). Public, like
 * `lineBaselineOffset`: call it rather than restate it. Sets the ctx font; restores spacing.
 */
export function tabStopMetrics(
  ctx: CanvasRenderingContext2D,
  style: ResolvedStyle,
): { interval: number; halfSpace: number } {
  const spacing = ctx as CanvasRenderingContext2D & { wordSpacing?: string };
  const prevLetterSpacing = ctx.letterSpacing;
  const prevWordSpacing = spacing.wordSpacing;
  const stops = new Measurer(ctx, new Map()).tabStops(style);
  ctx.letterSpacing = prevLetterSpacing;
  if (prevWordSpacing !== undefined) spacing.wordSpacing = prevWordSpacing;
  return { ...stops };
}

/** The vertical space an inline-block's margin box adds around its content. */
export function inlineBlockExtra(bs: ResolvedStyle): { top: number; bottom: number } {
  return {
    top: bs.marginTop + bs.borderTopWidth + bs.paddingTop,
    bottom: bs.paddingBottom + bs.borderBottomWidth + bs.marginBottom,
  };
}

/**
 * The font ascent and descent layout uses (`chromeFontBox`), measured on `ctx`; never cached,
 * as fonts load between calls.
 */
export function getFontMetrics(ctx: CanvasRenderingContext2D, style: ResolvedStyle): { ascent: number; descent: number } {
  // Outside layout (paint, path decorations, the public API) the caller owns
  // the ctx's font: a measurement must not move it.
  const prev = ctx.font;
  const result = chromeFontBox(style.fontSize, (size) => {
    ctx.font = buildCanvasFont({ ...style, fontSize: size });
    return fontBox(ctx.measureText('M'));
  });
  ctx.font = prev;
  return result;
}

/**
 * Baseline shift (positive = down) for a vertical-align value; 0 for baseline and for
 * `top`/`bottom`, which would need a second pass.
 * - super/sub: the engine's rule, fit to the DOM within 0.06px over 8-56px and three families.
 * - text-top/-bottom: the box's LEADED edge against the parent's CONTENT-area edge (no
 *   leading); the bare box metrics cost 25px on a line holding both.
 * - middle: the leaded midpoint at parent baseline + half the x-height; length/% raises.
 */
export function verticalAlignShift(
  va: string,
  session: LayoutSession, style: ResolvedStyle, parentStyle: ResolvedStyle,
): number {
  switch (va) {
    // Blink: fontSize/3 + 1 (super), /5 + 1 (sub) of the PARENT size (WebKit too; Gecko 0.34em /
    // 0.2em). Plain float, not Blink's LayoutUnit math: quantizing regressed the sub/sup baselines.
    case 'super':
      return -(parentStyle.fontSize / 3 + 1);
    case 'sub':
      return parentStyle.fontSize / 5 + 1;
    // Against the PARENT's content area (CSS 2.1 §10.8.1), not the line's tallest box.
    case 'text-top': {
      const m = session.measurer;
      return m.leadedBox(style).ascent - m.metrics(parentStyle).ascent;
    }
    case 'text-bottom': {
      const m = session.measurer;
      return m.metrics(parentStyle).descent - m.leadedBox(style).descent;
    }
    // The LEADED box's midpoint (CSS 2.1 §10.8.1); with a floored half-leading that is up to
    // 0.5px off the content area's (measured in Chrome and WebKit). x-height ~ 0.5em.
    case 'middle': {
      const { ascent, descent } = session.measurer.leadedBox(style);
      return -(parentStyle.fontSize * 0.25) - (descent - ascent) / 2;
    }
    default: {
      // baseline / top / bottom / '' parse to NaN: no shift.
      const n = parseFloat(va);
      if (!Number.isFinite(n)) return 0;
      // A percentage resolves against the ELEMENT's own line-height (CSS 2.1 §10.8.1).
      return va.endsWith('%')
        ? -(n / 100) * session.measurer.computedLineHeight(style)
        : -n;
    }
  }
}

/** True when a vertical-align value moves content off the baseline. */
export function isShiftedVAlign(va: string): boolean {
  return va !== 'baseline' && va !== 'top' && va !== 'bottom' && va !== '';
}
