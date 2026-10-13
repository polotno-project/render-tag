// One `buildLayoutTree` call's state and its measuring primitive. The deliberate module
// state lives here: `layoutFontMetrics`, the `claimCtx` token, the DOM probes, the symbols.
import type { StyledNode, LayoutText, ResolvedStyle, LayoutLine } from '../types.js';
import { LINE_HEIGHT_MULTIPLIER } from '../css-resolver.js';
import {
  APP_UNIT_LINE_HEIGHT, BLINK_SUPER_SUB, FLOORS_LINE_BASELINE, LAYOUT_UNIT_LINE_HEIGHT, SNAPS_LINE_PAINT,
  TRUNCATES_LINE_HEIGHT,
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
}

/** Work counts no ctx call shows, for `tests/node/perf-counters.test.ts`. Internal. */
export interface LayoutStats {
  /** Times an inline formatting context's text was segmented and measured. */
  tokenizePasses: number;
  /** Segments those passes produced. */
  segments: number;
  /** `Word` objects the line flow hands the emit pass, plus a clamp's ellipsis. */
  wordObjects: number;
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

// Probes: a <div>, and a <ul><li> for bullet items, which Firefox's ::marker makes 1.5px
// taller (<ol> items are unaffected).
let _blockProbe: HTMLDivElement | null = null;
let _ulProbeContainer: HTMLUListElement | null = null;
let _ulProbeLi: HTMLLIElement | null = null;

export const BULLET_MARKERS = new Set(['disc', 'circle', 'square']);

/**
 * DOM-probed line height (`accuracy: 'balanced'`), cached in `cache` per font, line-height
 * and probe. The probe elements are reused across calls; they hold no answer.
 */
function measureDomLineHeight(
  cache: Map<string, number>, font: string, lineHeight: string, useBulletProbe = false,
): number {
  const key = `${font}|${lineHeight}|${useBulletProbe ? 'ul-li' : 'block'}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (typeof document === 'undefined' || !document.body) {
    throw new Error(
      "render-tag: accuracy 'balanced' requires a browser DOM for line-height probes; use the default 'performance' mode in non-browser environments."
    );
  }

  let probe: HTMLElement;
  if (useBulletProbe) {
    if (!_ulProbeContainer) {
      _ulProbeContainer = document.createElement('ul');
      _ulProbeContainer.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;visibility:hidden;padding:0;margin:0;border:0;list-style:disc;';
      _ulProbeLi = document.createElement('li');
      _ulProbeLi.style.cssText = 'white-space:nowrap;padding:0;margin:0;border:0;';
      _ulProbeLi.textContent = 'Mg';
      _ulProbeContainer.appendChild(_ulProbeLi);
      document.body.appendChild(_ulProbeContainer);
    }
    probe = _ulProbeLi!;
  } else {
    if (!_blockProbe) {
      _blockProbe = document.createElement('div');
      _blockProbe.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;padding:0;margin:0;border:0;';
      _blockProbe.textContent = 'Mg';
      document.body.appendChild(_blockProbe);
    }
    probe = _blockProbe;
  }

  probe.style.font = font;
  probe.style.lineHeight = lineHeight;
  const height = probe.getBoundingClientRect().height;

  cache.set(key, height);
  return height;
}

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
}

type FontBox = Readonly<{ ascent: number; descent: number }>;

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
 * identity. Line heights and leaded boxes are indexed by `useBulletProbe`.
 */
interface FontState {
  readonly measure: MeasureState;
  metrics: FontBox | undefined;
  readonly lineHeights: [number | undefined, number | undefined];
  readonly boxes: [FontBox | undefined, FontBox | undefined];
  tabStops: TabStops | undefined;
}

export class Measurer {
  /** What this measurer last wrote to the ctx; null = unknown. */
  private current: MeasureState | null = null;
  private readonly states = new Map<string, MeasureState>();
  private readonly fonts = new Map<ResolvedStyle, FontState>();
  /** DOM-probed line heights (`accuracy: 'balanced'`), by font|line-height|probe. */
  private readonly domLineHeights = new Map<string, number>();
  /** This measurer's `claimCtx` id. */
  private readonly writerId = nextCtxWriterId();

  /**
   * Clears the ctx's word-spacing: spaces carry it in their own measured width.
   * `fontMetrics` is the call's table (`layoutFontMetrics`); `useDomMeasurements` makes line
   * heights DOM probes (`accuracy: 'balanced'`).
   */
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    private readonly fontMetrics: FontMetricsTable,
    private readonly useDomMeasurements = false,
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
   * `usedLineHeight` for a length. A DOM probe already answers with the used value.
   */
  lineHeight(style: ResolvedStyle, useBulletProbe = false): number {
    const computed = this.computedLineHeight(style, useBulletProbe);
    const multiplier = lineHeightMultiplier(style);
    if (multiplier !== undefined && !this.useDomMeasurements) {
      return multipliedLineHeight(style.fontSize, multiplier);
    }
    return usedLineHeight(computed);
  }

  /**
   * The computed line height: DOM-probed under `accuracy: 'balanced'`, else the CSS value, or
   * for `normal` the font bounding box. A percentage `vertical-align` resolves against this.
   */
  computedLineHeight(style: ResolvedStyle, useBulletProbe = false): number {
    const fs = this.font(style);
    const slot = useBulletProbe && this.useDomMeasurements ? 1 : 0;
    let lineHeight = fs.lineHeights[slot];
    if (lineHeight === undefined) {
      if (this.useDomMeasurements) {
        lineHeight = measureDomLineHeight(this.domLineHeights,
          fs.measure.font, hasLineHeight(style) ? `${style.lineHeight}px` : 'normal', slot === 1);
      } else if (hasLineHeight(style)) {
        lineHeight = style.lineHeight;
      } else {
        const { ascent, descent } = this.metrics(style);
        lineHeight = ascent + descent;
      }
      fs.lineHeights[slot] = lineHeight;
    }
    return lineHeight;
  }

  /**
   * One box's half of a line over its OWN line-height: content area plus half-leading (CSS 2.1
   * §10.8). `text-top`/`text-bottom` align these edges. Shared: do not mutate.
   */
  leadedBox(style: ResolvedStyle, useBulletProbe = false): FontBox {
    const fs = this.font(style);
    const slot = useBulletProbe && this.useDomMeasurements ? 1 : 0;
    let box = fs.boxes[slot];
    if (!box) {
      const { ascent, descent } = this.metrics(style);
      const lineHeight = this.lineHeight(style, useBulletProbe);
      const boxAscent = lineBaselineOffset(lineHeight, ascent, descent);
      box = fs.boxes[slot] = { ascent: boxAscent, descent: lineHeight - boxAscent };
    }
    return box;
  }

  /**
   * `ch` (advance of `0`) and `ex` (ink ascent of `x`, ~1-2% over the OS/2 x-height) for the
   * resolver; 0.5em when the ctx cannot answer (CSS Values 4).
   */
  fontUnits(style: ResolvedStyle): { ch: number; ex: number } {
    const state = this.intern(buildCanvasFont(style), 'normal', '0px');
    const ch = this.width(state, '0');
    const ex = this.measureText(state, 'x').actualBoundingBoxAscent;
    const half = style.fontSize / 2;
    return { ch: ch > 0 ? ch : half, ex: ex > 0 ? ex : half };
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
        lineHeights: [undefined, undefined],
        boxes: [undefined, undefined],
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
      state = { font, kerning, letterSpacing, widths: new Map() };
      this.states.set(key, state);
    }
    return state;
  }

  /** Write `state` to the ctx — all of it, but only what differs. */
  private use(state: MeasureState): void {
    if (claimCtx(this.writerId)) this.current = null;
    const prev = this.current;
    if (prev === state) return;
    const ctx = this.ctx;
    if (prev?.font !== state.font) ctx.font = state.font;
    if (prev?.kerning !== state.kerning) ctx.fontKerning = state.kerning;
    if (prev?.letterSpacing !== state.letterSpacing) ctx.letterSpacing = state.letterSpacing;
    this.current = state;
  }
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
export type PrivateText = LayoutText & { [LINE_TOP]?: number; [RUN_SEAM]?: true };

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
  useBulletProbe: boolean,
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
      return m.leadedBox(style, useBulletProbe).ascent - m.metrics(parentStyle).ascent;
    }
    case 'text-bottom': {
      const m = session.measurer;
      return m.metrics(parentStyle).descent - m.leadedBox(style, useBulletProbe).descent;
    }
    // The LEADED box's midpoint (CSS 2.1 §10.8.1); with a floored half-leading that is up to
    // 0.5px off the content area's (measured in Chrome and WebKit). x-height ~ 0.5em.
    case 'middle': {
      const { ascent, descent } = session.measurer.leadedBox(style, useBulletProbe);
      return -(parentStyle.fontSize * 0.25) - (descent - ascent) / 2;
    }
    default: {
      // baseline / top / bottom / '' parse to NaN: no shift.
      const n = parseFloat(va);
      if (!Number.isFinite(n)) return 0;
      // A percentage resolves against the ELEMENT's own line-height (CSS 2.1 §10.8.1).
      return va.endsWith('%')
        ? -(n / 100) * session.measurer.computedLineHeight(style, useBulletProbe)
        : -n;
    }
  }
}

/** True when a vertical-align value moves content off the baseline. */
export function isShiftedVAlign(va: string): boolean {
  return va !== 'baseline' && va !== 'top' && va !== 'bottom' && va !== '';
}
