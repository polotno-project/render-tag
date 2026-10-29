// One `buildLayoutTree` call's state and its measuring primitive. The deliberate module
// state lives here: `layoutFontMetrics`, the `claimCtx` token, the symbols.
import type { StyledNode, LayoutBox, LayoutText, LayoutLineBox, ResolvedStyle, LayoutLine } from '../types.js';
import { LINE_HEIGHT_MULTIPLIER } from '../css-resolver.js';
import { createFallbackMeasureCtx } from '../dom.js';
import {
  APP_UNIT_LINE_HEIGHT, BLINK_SUPER_SUB, FLOORS_LINE_BASELINE, INK_BOX_FROM_PAINT, LAYOUT_UNIT_LINE_HEIGHT,
  SNAPS_LINE_PAINT, TRUNCATES_LINE_HEIGHT,
} from '../engine.js';
import type { PreparedInline } from './segment.js';

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
  /** Items `gluedRunWidth` read: linear in a word split across runs, never quadratic. */
  glueSteps: number;
  /** Characters `breakGluedChain` cut such a word into: only for a word that splits. */
  chainCells: number;
}

// ── Canvas font helpers ──

/** The `ctx.fontKerning` value a style resolves to. */
export function canvasKerning(style: ResolvedStyle): CanvasFontKerning {
  return style.fontKerning === 'none' ? 'none' : 'normal';
}

/** Format a letter-spacing value (px) as a canvas `ctx.letterSpacing` string. */
export function formatLetterSpacing(value: number): string {
  // Negative letter-spacing is valid (Chrome applies it per character); a non-finite value
  // would make a px string canvas silently ignores.
  return Number.isFinite(value) && value !== 0 ? `${value}px` : '0px';
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

  /** A style's own measuring state: its font, kerning and letter-spacing. */
  stateOf(style: ResolvedStyle): MeasureState {
    return this.font(style).measure;
  }

  /** Width of `text` under `state`, measured once per call. */
  width(state: MeasureState, text: string): number {
    let width = state.widths.get(text);
    if (width === undefined) {
      width = this.measureText(state, text).width;
      state.widths.set(text, width);
    }
    return width;
  }

  /** Uncached — for one-off strings and ink metrics. */
  measureText(state: MeasureState, text: string): TextMetrics {
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
        metrics = fontBox(this.measureText(fs.measure, 'M'));
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
    const state = this.intern(buildCanvasFont(style), 'normal', '0px');
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
      const spaceless = this.intern(fs.measure.font, fs.measure.kerning, '0px');
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
      fs = {
        measure: this.intern(
          buildCanvasFont(style), canvasKerning(style), formatLetterSpacing(style.letterSpacing)),
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

  private intern(font: string, kerning: CanvasFontKerning, letterSpacing: string): MeasureState {
    const key = font + '\0' + kerning + '\0' + letterSpacing;
    let state = this.states.get(key);
    if (!state) {
      state = { font, kerning, letterSpacing, widths: new Map(), units: undefined, inks: undefined };
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
  if (prev?.letterSpacing !== state.letterSpacing) ctx.letterSpacing = state.letterSpacing;
}

/**
 * Device pixels `paintedInkBox` gives the longer side of the box it reads. WebKit's
 * antialiased edges sit ~0.6px outside the outline: at 256 a Roboto `•` read 1.1% tall,
 * at 512 within 0.2% of its outline (0.56ms a probe).
 */
const INK_PROBE_PIXELS = 512;
/** CSS px `paintedInkBox` reads around the measured box: Gecko's is ~1px off the ink. */
const INK_PROBE_MARGIN = 2;

/**
 * The ink extents of `text` read off its paint on `ctx`, around `measured` (`measureText`'s
 * box, within `INK_PROBE_MARGIN` of the ink). A pixel at least half covered is ink. Null
 * when the pixels show no ink inside the margin.
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
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      if (x < left) left = x;
      if (x >= right) right = x + 1;
      if (y < top) top = y;
      bottom = y + 1;
    }
  }
  // Ink at the edge is clipped, or the readback is not the paint (Firefox's fingerprinting
  // protection reads opaque white).
  if (right <= left || left === 0 || top === 0 || right === width || bottom === height) return null;
  return {
    ascent: (originY - top) / scale,
    descent: (bottom - originY) / scale,
    left: (originX - left) / scale,
    right: (right - originX) / scale,
  };
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

/**
 * True when `node` starts a new measuring run after a piece of the same style
 * (`Hello<!---->World`): paint must not batch the two into one fillText. A tree this
 * layout did not produce batches by style.
 */
export function startsMeasuredRun(node: LayoutText): boolean {
  return (node as PrivateText)[RUN_SEAM] === true;
}

/**
 * The engine's paint offset for a run's line (`SNAPS_LINE_PAINT`): `round(lineTop) - lineTop`,
 * else 0. A node this layout did not produce uses its baseline as the line top.
 */
export function paintLineSnap(node: LayoutText): number {
  if (!SNAPS_LINE_PAINT) return 0;
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
 * Line box height of a UNITLESS line-height. Both put the font-size on the 1/64px grid
 * (Blink rounds, WebKit floors); Blink then floors the product onto the grid (14px x 1.6 =
 * 22.390625), WebKit the float32 product to a whole px (13.6px x 1.25 = 16). Gecko keeps
 * the exact product. line-baseline-parity.
 */
function multipliedLineHeight(fontSize: number, multiplier: number): number {
  if (LAYOUT_UNIT_LINE_HEIGHT) {
    // The epsilon keeps 20 x 1.15 (22.999999999999996) on its grid line, as Blink does.
    return Math.floor((Math.round(fontSize * 64) / 64) * multiplier * 64 + 1e-6) / 64;
  }
  if (TRUNCATES_LINE_HEIGHT) {
    return Math.floor(Math.fround((Math.floor(fontSize * 64) / 64) * multiplier));
  }
  if (APP_UNIT_LINE_HEIGHT) return Math.round(fontSize * multiplier * 60) / 60;
  return fontSize * multiplier;
}

/**
 * The used height of a computed line-height LENGTH: WebKit truncates it to whole px, Blink
 * rounds it to 1/64px, Gecko to 1/60px. Idempotent.
 */
function usedLineHeight(lineHeight: number): number {
  if (TRUNCATES_LINE_HEIGHT) return Math.floor(Math.fround(lineHeight));
  if (LAYOUT_UNIT_LINE_HEIGHT) return Math.round(lineHeight * 64) / 64;
  if (APP_UNIT_LINE_HEIGHT) return Math.round(lineHeight * 60) / 60;
  return lineHeight;
}

/**
 * Baseline offset from a line box's top: the half-leading over the engine's used
 * line-height plus the ascent, rounded per engine. Pass the computed line-height. Public:
 * renderers placing a baseline beside a render-tag canvas call it rather than restate it.
 */
export function lineBaselineOffset(lineHeight: number, ascent: number, descent: number): number {
  let halfLeading = (usedLineHeight(lineHeight) - (ascent + descent)) / 2;
  // Blink halves the leading in LayoutUnits, truncating toward zero (Verdana 13.6px x 1.25:
  // 14, not 13).
  if (LAYOUT_UNIT_LINE_HEIGHT) halfLeading = Math.trunc(halfLeading * 64) / 64;
  const exact = halfLeading + ascent;
  return FLOORS_LINE_BASELINE ? Math.floor(exact) : exact;
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

/** Font ascent and descent measured on `ctx`; never cached, as fonts load between calls. */
export function getFontMetrics(ctx: CanvasRenderingContext2D, style: ResolvedStyle): { ascent: number; descent: number } {
  // Outside layout (paint, path decorations, the public API) the caller owns
  // the ctx's font: a measurement must not move it.
  const prev = ctx.font;
  ctx.font = buildCanvasFont(style);
  const result = fontBox(ctx.measureText('M'));
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
    // Blink/WebKit: fontSize/3 + 1 (super), /5 + 1 (sub) of the PARENT size; Gecko 0.34em/0.2em.
    // Plain float, not Blink's LayoutUnit math: quantizing regressed the sub/sup pixel baselines.
    case 'super':
      return BLINK_SUPER_SUB
        ? -(parentStyle.fontSize / 3 + 1) : -parentStyle.fontSize * 0.34;
    case 'sub':
      return BLINK_SUPER_SUB
        ? parentStyle.fontSize / 5 + 1 : parentStyle.fontSize * 0.2;
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
