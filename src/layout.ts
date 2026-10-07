import type { StyledNode, LayoutNode, LayoutBox, LayoutText, ResolvedStyle, LayoutLine, LayoutLineBox, DecorationEntry } from './types.js';
import {
  anonymousBlockStyle, borderBoxSize, contentBoxSize, intrinsicStyle, isTransparent, LINE_HEIGHT_MULTIPLIER,
  OVERFLOW_X, OVERFLOW_Y, resolvePercentages, resolveStylesFromCSS,
} from './css-resolver.js';
import { parseHTML } from './parse.js';
import {
  BLINK_SUPER_SUB, CANVAS_BIDI_LINE, FLOORS_LINE_BASELINE, LAYOUT_UNIT_LINE_HEIGHT, MARKER_LINE_WITHOUT_CONTENT,
  MIN_HEIGHT_END_MARGINS, SNAPS_LINE_PAINT, TRUNCATES_LINE_HEIGHT,
} from './engine.js';
import {
  bidiContextFor, BidiTextBuilder, lineLevels, mayNeedBidi, resolveBidi, visualOrder,
  type BidiContext,
} from './bidi.js';

/**
 * Everything one `buildLayoutTree` call owns, threaded down the layout
 * functions as `session`. Layout keeps NO module state of its own: a call
 * made from inside another (a `debug` callback, the caller's `measureText`)
 * gets a session of its own and cannot touch the outer one's lines, caches or
 * callback (`tests/node/reentrancy.test.ts`). Created per call and dropped
 * with it — nothing here reaches the next call.
 */
interface LayoutSession {
  /** The call's one measuring primitive (and its per-call font state). */
  readonly measurer: Measurer;
  readonly debug: ((entry: import('./types.ts').DebugEntry) => void) | undefined;
  /** One entry per committed line (inline content and list markers), unsorted. */
  readonly lines: LayoutLine[];
  /** Content-box intrinsic widths by node identity (`contentMinimum`/`contentMaximum`). */
  readonly minContent: Map<StyledNode, number>;
  readonly maxContent: Map<StyledNode, number>;
  /** The block wrapper of each bare text node in a flex container (`anonymousFlexItem`). */
  readonly anonymousFlexItems: Map<StyledNode, StyledNode>;
  /**
   * Inline formatting contexts intrinsic sizing prepared, until the layout
   * reads them (`preparedInline`, `takePreparedInline`).
   */
  readonly prepared: Map<StyledNode, PreparedInline>;
  /** Work counts for `tests/node/perf-counters.test.ts`; undefined outside it. */
  readonly stats: LayoutStats | undefined;
}

/**
 * Work no ctx call shows, counted when a test passes `stats` to
 * `buildLayoutTree` (`tests/node/perf-counters.test.ts`). Internal.
 */
export interface LayoutStats {
  /** Times an inline formatting context's text was segmented and measured. */
  tokenizePasses: number;
  /** Segments those passes produced. */
  segments: number;
  /**
   * Per-item objects the line flow hands the emit pass (`Word`), plus a
   * clamp's ellipsis. Bidi cuts inside the emit pass are not counted.
   */
  wordObjects: number;
}

// ─── Canvas font helpers ───────────────────────────────────────────────

/** The `ctx.fontKerning` value a style resolves to. */
export function canvasKerning(style: ResolvedStyle): CanvasFontKerning {
  return style.fontKerning === 'none' ? 'none' : 'normal';
}

/** Format a letter-spacing value (px) as a canvas `ctx.letterSpacing` string. */
export function formatLetterSpacing(value: number): string {
  // Negative letter-spacing is valid and narrows text — Chrome applies it per
  // character (trailing included). Clamping it to 0 measured text wider than
  // the browser renders it, causing earlier/extra line wraps. Guard against
  // non-finite values (undefined/NaN), which would produce an invalid
  // "undefinedpx"/"NaNpx" string that canvas silently ignores.
  return Number.isFinite(value) && value !== 0 ? `${value}px` : '0px';
}

/**
 * Build a canvas font string from resolved style. Not memoized: callers keep
 * the result per style object (the measurer's font state, paint's tracker),
 * and building it costs no more than the string key a memo would need.
 */
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

// Probe elements: a <div> for general use, and a <ul><li> for unordered list items.
// Firefox renders <ul><li> with bullet markers (disc/circle/square) 1.5px taller
// than other elements for the same line-height, due to the ::marker pseudo-element.
// <ol><li> items do NOT have this extra height.
let _blockProbe: HTMLDivElement | null = null;
let _ulProbeContainer: HTMLUListElement | null = null;
let _ulProbeLi: HTMLLIElement | null = null;

const BULLET_MARKERS = new Set(['disc', 'circle', 'square']);

/**
 * Measure the actual line height using a hidden DOM element.
 * Uses an actual <li> inside a <ul> when listStyleType is a bullet marker
 * (disc/circle/square) to capture Firefox's ::marker line box contribution.
 * Results are cached in `cache` (the call's measurer) per
 * font+lineHeight+probeType. The probe elements themselves are reused across
 * calls: they hold no answer, only a place to ask.
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

// ─── Measurement ───────────────────────────────────────────────────────
//
// A measured width depends on more canvas state than the font: kerning and
// letter-spacing move it too. That state used to be set by hand at each
// measuring site, and several sites set only the font, so they measured under
// whatever letter-spacing or kerning the previous run had left on the ctx — a
// line re-measured that way kept an overflowing word. `Measurer` is now the
// only layout code that writes measuring state: a measurement names the state
// it wants, and the measurer writes all of it, skipping what the ctx already
// holds.
//
// Everything here lives for ONE layout call. A caller's ctx is the measuring
// oracle (a PDF proxy, node-canvas, a test mock), and fonts can load between
// calls, so no width or metric is carried into the next call. What paint
// needs from the call's measurements rides on the result
// (`layoutFontMetrics`), never on module state another call could replace.

/**
 * The canvas state a width depends on. Interned per call by value, so every
 * style that measures the same way shares one entry — and one width cache.
 */
export interface MeasureState {
  readonly font: string;
  readonly kerning: CanvasFontKerning;
  readonly letterSpacing: string;
  /** `measureText` widths under this state, by text. */
  readonly widths: Map<string, number>;
}

type FontBox = Readonly<{ ascent: number; descent: number }>;

/**
 * The font metrics (canvas font string → ascent/descent) each result was laid
 * out with, keyed by the result: a block layout's `layoutRoot`, a
 * text-on-path layout's result object. Paint reads its decoration ascents and
 * descents from here (`PaintState.fontBox`), so a result paints on the
 * metrics its runs were placed with — whatever ctx a later `layout()`
 * measured on (a PDF proxy whose metrics differ from the screen canvas). A
 * table belongs to one call and dies with its result; it is never a cache
 * across calls. A miss (a tree the caller built) measures on the paint ctx.
 */
export const layoutFontMetrics = new WeakMap<object, FontMetricsTable>();
export type FontMetricsTable = Map<string, FontBox>;

/**
 * Which writer last wrote canvas state to A ctx (any ctx), as a number: a
 * `Measurer` or a `PaintState` takes an id from `nextCtxWriterId` and calls
 * `claimCtx` before it writes. A writer elides writes the ctx already holds —
 * but a nested layout call (a `debug` callback, the caller's own
 * `measureText`) or a public helper may write the same ctx between two of
 * its writes. Whenever another writer wrote since, the writer forgets what it
 * believed the ctx holds and writes it again. One token for all contexts: a
 * write to a different ctx only costs a redundant re-write, never a wrong
 * width. A number, not the writer itself, so the last call's measurer (its
 * width maps, its ctx) is not kept alive after the call.
 */
let lastCtxWriter = 0;
let ctxWriterIds = 0;

/** A fresh writer id for `claimCtx`. */
export function nextCtxWriterId(): number {
  return ++ctxWriterIds;
}

/**
 * Record writer `id` as the last to write ctx state. True when another
 * writer wrote since `id` last claimed: what `id` believes the ctx holds is
 * stale.
 */
export function claimCtx(id: number): boolean {
  if (lastCtxWriter === id) return false;
  lastCtxWriter = id;
  return true;
}

type TabStops = Readonly<{ interval: number; halfSpace: number }>;

/**
 * What one style's text needs from the canvas, derived once per call instead
 * of once per word. Keyed by style identity; never stored on the style.
 * Line heights and leaded boxes are indexed by `useBulletProbe` (it only
 * changes them when the DOM probes run).
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
   * Spaces carry `word-spacing` in their own measured width, so the canvas
   * must not add any: a caller's ctx (or a paint left on a reused one) may
   * hold some. Cleared here, so no entry point can measure without it.
   *
   * `fontMetrics` is where font metrics are recorded and looked up: the
   * call's own table (`layoutFontMetrics` hands it to paint).
   * `useDomMeasurements` makes line heights DOM probes (`accuracy:
   * 'balanced'`); only block layout asks for line heights.
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
      // Recorded in the call's table, which paint reads after layout.
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
   * The height a line box built from this style takes: the computed value
   * below, as the engine uses it (`multipliedLineHeight` for a number,
   * `usedLineHeight` for a length — WebKit truncates it;
   * Blink puts it on its LayoutUnit grid, `LAYOUT_UNIT_LINE_HEIGHT`). A DOM
   * probe already answers with the engine's used value.
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
   * The computed line height for a style. DOM-probed under `accuracy:
   * 'balanced'` (Firefox and Chrome differ); otherwise the CSS value, or for
   * `normal` the font bounding box, which already is the full line box. A
   * percentage `vertical-align` resolves against this, not the used value.
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
   * One box's half of a line: how far it reaches above its own baseline and
   * how far below, over its OWN line-height. This is the inline box CSS 2.1
   * §10.8 talks about — the font's content area plus its half-leading — not
   * the bare font metrics. `vertical-align: text-top` and `text-bottom` align
   * THIS box's edges, and the line box is the union of these over everything
   * on the line. Shared: callers must not mutate it.
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
   * The resolver's font-relative units for a style's font: `ch`, the advance
   * of `0`, and `ex`, the x-height — read as the ink ascent of `x`, which
   * includes the glyph's overshoot (an engine reads the font's OS/2 x-height;
   * they differ by about 1-2%). A ctx that cannot answer gets 0.5em, the CSS
   * Values 4 fallback.
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
      // The space advance is measured with letter-spacing OFF; the block's
      // spacing is added per stop instead.
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
 * The top of the line box each run was laid out on, for `paintLineSnap`.
 * Kept off the public `LayoutText` shape: it is paint bookkeeping, keyed by the
 * node's identity the way the rest of the tree is.
 */
const runLineTops = new WeakMap<LayoutText, number>();

/** Marks a LayoutText that starts a measuring run (`startsMeasuredRun`). A symbol: no public field. */
const RUN_SEAM: unique symbol = Symbol('runSeam');
type SeamFlagged = LayoutText & { [RUN_SEAM]?: true };

/**
 * Does `node` start a new measuring run although the piece before it has
 * the same style? Then paint must not batch the two into one fillText: they
 * were measured apart, and one shaped string drifts from their layout
 * positions by the kerning across the seam. Text nodes of one element share
 * its style object, so style identity alone does NOT mean "same run"
 * (`Hello<!---->World` is two). Flagged only on those rare pieces (a symbol
 * key, copied with the node), so the common path costs a missed property
 * read; a tree this layout did not produce batches by style, the old rule.
 */
export function startsMeasuredRun(node: LayoutText): boolean {
  return (node as SeamFlagged)[RUN_SEAM] === true;
}

/**
 * How far the engine moves a run's paint off its layout position
 * (`SNAPS_LINE_PAINT`): `round(lineTop) - lineTop`, the same for every run on
 * the line. 0 where the engine does not snap. A node this layout did not
 * produce (a hand-built or cloned tree) falls back to its line baseline, which
 * sits a whole number of pixels below the line top unless something on the
 * line raised it.
 */
export function paintLineSnap(node: LayoutText): number {
  if (!SNAPS_LINE_PAINT) return 0;
  const top = runLineTops.get(node) ?? node.lineBaselineY ?? node.y;
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
 * The line box height of a UNITLESS line-height, the way the engine multiplies
 * it. Both Blink and WebKit put the font-size on the 1/64px grid first —
 * Blink rounds it, WebKit floors it — and then:
 *
 * - Blink floors the product onto the grid (14px x 1.6 is 22.390625);
 * - WebKit floors the float32 product to a whole pixel (13.6px x 1.25 is
 *   16, where floor(fround(13.6 x 1.25)) would give 17; 20 x 1.15 is 23).
 *
 * Gecko keeps the exact product. Measured in Chromium and Playwright WebKit
 * (line-baseline-parity; WebKit: 2898 of 2898 sizes x ratios x families).
 */
function multipliedLineHeight(fontSize: number, multiplier: number): number {
  if (LAYOUT_UNIT_LINE_HEIGHT) {
    // The epsilon keeps a double product one ulp under a grid line (20 x 1.15
    // is 22.999999999999996) on it, as Blink's own arithmetic does.
    return Math.floor((Math.round(fontSize * 64) / 64) * multiplier * 64 + 1e-6) / 64;
  }
  if (TRUNCATES_LINE_HEIGHT) {
    return Math.floor(Math.fround((Math.floor(fontSize * 64) / 64) * multiplier));
  }
  return fontSize * multiplier;
}

/**
 * The height a line box built from `lineHeight` (a computed CSS LENGTH, px)
 * actually takes in this engine: WebKit truncates it to a whole pixel
 * (`TRUNCATES_LINE_HEIGHT`), Blink rounds it onto its 1/64px grid
 * (`LAYOUT_UNIT_LINE_HEIGHT`), Gecko keeps it. Idempotent, so a value that
 * already is the engine's used value passes through unchanged.
 */
function usedLineHeight(lineHeight: number): number {
  if (TRUNCATES_LINE_HEIGHT) return Math.floor(Math.fround(lineHeight));
  if (LAYOUT_UNIT_LINE_HEIGHT) return Math.round(lineHeight * 64) / 64;
  return lineHeight;
}

/**
 * Baseline offset from the top of a line box, the way the engine places it:
 * the half-leading `(lineHeight - (ascent + descent)) / 2` below the line top,
 * plus the ascent — over the line-height the engine actually uses
 * (`TRUNCATES_LINE_HEIGHT`), rounded as `FLOORS_LINE_BASELINE` says. Pass the
 * computed CSS line-height; the box it heads is that engine's used
 * line-height tall (in WebKit, `Math.floor` of it).
 *
 * Public API, because this is the ONE rule every renderer that places a
 * baseline beside a render-tag canvas has to share (@polotno/svg-export, the
 * editor's list marker). Call it rather than restate it, or the two drift.
 */
export function lineBaselineOffset(lineHeight: number, ascent: number, descent: number): number {
  let halfLeading = (usedLineHeight(lineHeight) - (ascent + descent)) / 2;
  // Blink halves the leading in LayoutUnits, truncating toward zero: a
  // negative leading an odd number of 64ths short floors one pixel LOWER than
  // the exact half would (Verdana 13.6px x 1.25: 14, not 13).
  if (LAYOUT_UNIT_LINE_HEIGHT) halfLeading = Math.trunc(halfLeading * 64) / 64;
  const exact = halfLeading + ascent;
  return FLOORS_LINE_BASELINE ? Math.floor(exact) : exact;
}

/**
 * Tab-stop metrics for a block, the way Chrome sizes them. Tab stops follow
 * the BLOCK's style, not the inline run the tab sits in: the interval is
 * tab-size(8) × the block font's space advance — measured with
 * letter-spacing off — plus the block's letter- and word-spacing per stop
 * (css-text-3 §tab-size), verified against the DOM (a tab inside a bold span
 * still uses the regular-weight space). `halfSpace` carries Blink's skip
 * rule: when the next stop is closer than half a space width, the tab
 * advances to the stop after it (Font::TabWidth).
 *
 * Public API for the same reason as `lineBaselineOffset`: a renderer that
 * re-flows text beside a render-tag canvas needs identical stops. Call it
 * rather than restate it, or the two drift. Mutates ctx font state (its
 * letter- and word-spacing are put back).
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

/**
 * The vertical space an inline-block's margin box adds around its content, over
 * and above the font's own leading. Written once because the wrap pass grows
 * the line by the same six values.
 */
function inlineBlockExtra(bs: ResolvedStyle): { top: number; bottom: number } {
  return {
    top: bs.marginTop + bs.borderTopWidth + bs.paddingTop,
    bottom: bs.paddingBottom + bs.borderBottomWidth + bs.marginBottom,
  };
}

/** Transform source text before measuring it, while keeping CSS word context
 * across inline style boundaries. Runs with no transform still participate in
 * word detection: a later capitalize run must not recase the middle of a word.
 */
export function transformTextRuns<T extends {
  text: string;
  style: { textTransform: string };
  wordBoundaryBefore?: boolean;
}>(
  runs: T[],
): T[] {
  if (!runs.some(run => run.style.textTransform !== 'none')) return runs;

  let source = '';
  const offsets = runs.map(run => {
    if (run.wordBoundaryBefore) source += ' ';
    const offset = source.length;
    source += run.text;
    return offset;
  });
  const capitals = new Set<number>();
  for (const match of source.matchAll(/(^|[\s\p{P}\p{S}])(\p{L})/gu)) {
    const boundary = match[1];
    const index = match.index + boundary.length;
    // Apostrophes within a word do not start a new word; opening quotes do.
    if ((boundary === "'" || boundary === '’') &&
      /[\p{L}\p{N}]\p{M}*$/u.test(source.slice(0, index - 1))) continue;
    capitals.add(index);
  }

  return runs.map((run, runIndex) => {
    const transform = run.style.textTransform;
    const text = transform === 'uppercase' ? run.text.toUpperCase()
      : transform === 'lowercase' ? run.text.toLowerCase()
      : transform === 'capitalize'
        ? run.text.replace(/\p{L}/gu, (letter, index) =>
          capitals.has(offsets[runIndex] + index) ? letter.toUpperCase() : letter)
        : run.text;
    return { ...run, text };
  });
}

function isInline(node: StyledNode): boolean {
  if (node.tagName === '#text') return true;
  const d = node.style.display;
  return d === 'inline' || d === 'inline-block';
}

function hasOnlyInlineChildren(node: StyledNode): boolean {
  return node.children.length > 0 && node.children.every(isInline);
}

/**
 * Get font ascent and descent metrics, measured on `ctx` (nothing is cached
 * across calls: fonts load between them, and each ctx is its own oracle).
 * Layout code asks its own measurer (`session.measurer.metrics`) instead,
 * and paint the result's table (`layoutFontMetrics`).
 */
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
 * Baseline shift (canvas pixels, positive = downward) for a vertical-align
 * value, applied on top of the line baseline. Returns 0 for 'baseline' and for
 * the line-box-relative keywords 'top'/'bottom' — those need a second layout
 * pass (the box position depends on the final line box it helps size), so they
 * fall back to baseline rather than being approximated wrongly.
 *
 *  - super/sub        the engine's own rule, measured off the DOM across
 *                     8-56px × sans-serif/serif/monospace and fitting every
 *                     point to within 0.06px (LayoutUnit's 1/64). Neither
 *                     engine reads the font's metrics — the family does not
 *                     move the number.
 *  - text-top/-bottom the box's LEADED edge against the parent's CONTENT-area
 *                     edge (bare ascent/descent, no leading). Taking the box's
 *                     bare metrics instead costs 25px on a line holding both.
 *  - middle           LEADED box midpoint at parent baseline + half the x-height
 *  - <length>/<%>     raise (positive value) by the length / % of line-height
 */
function verticalAlignShift(
  va: string,
  session: LayoutSession, style: ResolvedStyle, parentStyle: ResolvedStyle,
  useBulletProbe: boolean,
): number {
  switch (va) {
    // Blink and WebKit share the fraction (Blink's inline_box_state.cc:
    // fontSize/3 + 1 for super, /5 + 1 for sub, from the PARENT box's size,
    // no font metric involved); Gecko raises by 0.34em and lowers by 0.2em.
    // Deliberately NOT Blink's LayoutUnit arithmetic (snap the size to the
    // 1/64px grid, truncate the division): that matches Chrome's DOM layout
    // rects exactly (measured, 18/18 samples 10-100px vs float's <=0.0125px
    // residual — and WebKit divides in plain float), but the shift also feeds
    // the line-box union, and quantizing it REGRESSED the sub/sup pixel
    // baselines 0.5-2% on every font variant. The screenshot is the oracle.
    case 'super':
      return BLINK_SUPER_SUB
        ? -(parentStyle.fontSize / 3 + 1) : -parentStyle.fontSize * 0.34;
    case 'sub':
      return BLINK_SUPER_SUB
        ? parentStyle.fontSize / 5 + 1 : parentStyle.fontSize * 0.2;
    // Against the PARENT's content area (CSS 2.1 §10.8.1) — its bare
    // ascent/descent, no leading. Measured against Chrome, taking the line's
    // tallest box instead of the real parent put this 14px out.
    case 'text-top': {
      const m = session.measurer;
      return m.leadedBox(style, useBulletProbe).ascent - m.metrics(parentStyle).ascent;
    }
    case 'text-bottom': {
      const m = session.measurer;
      return m.metrics(parentStyle).descent - m.leadedBox(style, useBulletProbe).descent;
    }
    // The midpoint of the LEADED box (CSS 2.1 §10.8.1 aligns "the vertical
    // midpoint of the box" — the box with its half-leading). Where the engine
    // floors the half-leading that is up to 0.5px off the content area's
    // midpoint — measured in Chrome and WebKit alike, a 30px/60px middle on an
    // 18px/2 line: DOM 34.70, content-area
    // midpoint 34.0, leaded 34.5. (The rest is x-height, approximated 0.5em.)
    case 'middle': {
      const { ascent, descent } = session.measurer.leadedBox(style, useBulletProbe);
      return -(parentStyle.fontSize * 0.25) - (descent - ascent) / 2;
    }
    default: {
      // baseline / top / bottom / '' all parseFloat to NaN → 0, which is what
      // an unshifted run wants — the line-box pass calls this for every word.
      const n = parseFloat(va);
      if (!Number.isFinite(n)) return 0;
      // A percentage resolves against the ELEMENT's own line-height (CSS 2.1
      // §10.8.1), not the line's. Measured against Chrome: the line's put the
      // box 10px out on a line whose tallest run was not this one.
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

/**
 * Two entries put the band in the same place, at the same thickness — the
 * geometry half only, so each caller keeps comparing color its own way (raw
 * here, canonicalized in the path renderer, where `red` and `#ff0000` must
 * still share one dash phase).
 *
 * Identity settles the normal case: entries ride down the tree by reference,
 * so every run under one declarer holds the same object. Two SEPARATE
 * declarers still count as equal when they would draw the same band, which
 * keeps a shaping group whole across siblings that declare the same thing.
 */
export function sameDecorationBand(a: DecorationEntry, b: DecorationEntry): boolean {
  if (a === b) return true;
  const da = a.declarer, db = b.declarer;
  return (
    da.fontSize === db.fontSize &&
    da.fontFamily === db.fontFamily &&
    da.fontWeight === db.fontWeight &&
    da.fontStyle === db.fontStyle &&
    da.fontVariantCaps === db.fontVariantCaps &&
    // The declarer's own vertical-align decides which baseline an underline
    // hangs off, so two declarers that differ there draw two bands.
    da.verticalAlign === db.verticalAlign &&
    // Explicit offset/thickness are band geometry too — two declarers that
    // differ there must not merge into one band.
    da.textUnderlineOffset === db.textUnderlineOffset &&
    da.textDecorationThickness === db.textDecorationThickness
  );
}

/** Same decoration set: entries must match pairwise, so runs whose decorations
 * would paint differently don't merge and take the first one's band. */
function sameDecorations(a: ResolvedStyle, b: ResolvedStyle): boolean {
  const da = a.textDecorations, db = b.textDecorations;
  if (da === db) return true;
  if (!da || !db || da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) {
    if (
      da[i].line !== db[i].line ||
      da[i].color !== db[i].color ||
      da[i].style !== db[i].style ||
      !sameDecorationBand(da[i], db[i])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Check if two styles have the same text rendering properties.
 */
function sameTextStyle(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.textDecorationLine === b.textDecorationLine &&
    sameDecorations(a, b) &&
    a.backgroundColor === b.backgroundColor;
}

function hasVisibleBoxStyles(style: ResolvedStyle): boolean {
  if (!isTransparent(style.backgroundColor)) return true;
  if (style.borderTopWidth > 0 && style.borderTopStyle !== 'none') return true;
  if (style.borderRightWidth > 0 && style.borderRightStyle !== 'none') return true;
  if (style.borderBottomWidth > 0 && style.borderBottomStyle !== 'none') return true;
  if (style.borderLeftWidth > 0 && style.borderLeftStyle !== 'none') return true;
  return false;
}

/** True for an element declaring `background-clip:text` with a visible
 * background (gradient image or solid color) — the fill/decorations of every
 * glyph it covers must sample that background instead of painting it as a box. */
export function hasTextClip(style: ResolvedStyle): boolean {
  return style.webkitBackgroundClip === 'text' &&
    ((!!style.backgroundImage && style.backgroundImage !== 'none') ||
      !isTransparent(style.backgroundColor));
}

export function hasStrokeImage(style: ResolvedStyle): boolean {
  return !!style.webkitTextStrokeImage && style.webkitTextStrokeImage !== 'none';
}

/** A box background painted as a box: background-clip:text clips it to glyphs instead. */
export function paintsBoxBackground(style: ResolvedStyle): boolean {
  return !isTransparent(style.backgroundColor) && style.webkitBackgroundClip !== 'text';
}

/** A run's left and right edges (an RTL run's x is its right edge). */
export function textEdges(node: LayoutText): [left: number, right: number] {
  return node.style.direction === 'rtl' ? [node.x - node.width, node.x] : [node.x, node.x + node.width];
}

// ─── Inline text run types ─────────────────────────────────────────────

interface TextRun {
  text: string;
  style: ResolvedStyle;
  /** Atomic inline-block content starts a new CSS word. */
  wordBoundaryBefore?: boolean;
  /**
   * The style of the PARENT of the element this run's style came from — what
   * `vertical-align` measures its shift against (CSS 2.1 §10.8.1). Not the
   * tallest run on the line, which is what a line-level maximum would give:
   * a 40px sibling put a sup 8px out of place.
   */
  parentStyle?: ResolvedStyle;
  /** If this run came from an inline element with visible box styles */
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box */
  boxClose?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
  /** Source element for an atomic inline-block with its own inner line flow. */
  inlineBlock?: StyledNode;
  /** Innermost inline `unicode-bidi` context (isolate/embed/override); none = the paragraph. */
  bidi?: BidiContext | null;
}

interface InlineBlockLayout {
  nodes: LayoutNode[];
  lines: LayoutLine[];
  lineBoxes: LayoutLineBox[];
  contentWidth: number;
  contentHeight: number;
  /** Last inner line's baseline, measured from the margin-box top. */
  baselineOffset: number;
  marginBoxHeight: number;
}

/**
 * One item of a committed line, as the emit pass reads it: a prepared
 * segment, or a piece the flow cut from one, materialized from the flow's
 * line table (`FlowItems.word`) once the final flow has placed it. Intrinsic
 * sizing never makes these.
 */
interface Word {
  text: string;
  width: number;
  style: ResolvedStyle;
  /** See `TextRun.parentStyle`. */
  parentStyle?: ResolvedStyle;
  isSpace: boolean;
  /** Tab character — its width is the advance to the tab stop it reached */
  isTab?: boolean;
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box (adds left padding/border) */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box (adds right padding/border) */
  boxClose?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
  inlineBlockLayout?: InlineBlockLayout;
  /** See `TextRun.bidi`. */
  bidi?: BidiContext | null;
  /** See `SEG_RUN_SEAM`. */
  runSeam?: true;
}

/** A committed line as the emit pass reads it: a `FlowLine` with its items materialized. */
interface PositionedLine {
  words: Word[];
  totalWidth: number;
  lineHeight: number;
  /** True at a forced break (preserved \n or <br>); uses text-align-last. */
  endedByHardBreak?: boolean;
}

/** True for atomic inline-block words (boxOpen && boxClose && text together). */
function isAtomicInlineBlock(w: Word): boolean {
  return !!(w.boxOpen && w.boxClose && w.text);
}

/**
 * Truncate a PositionedLine's trailing words and append "…" so the line
 * fits within maxWidth. Used by `-webkit-line-clamp` to mark the visible
 * cut-off on the Nth line.
 *
 * Trim strategy:
 *  1. Pick the style of the last NON-empty, NON-atomic-inline-block word
 *     — so the ellipsis font matches the surrounding text, not the button
 *     or pill it was sitting next to.
 *  2. Drop trailing isSpace words (genuine spaces only — box markers carry
 *     padding/border that we must keep).
 *  3. Back-trim: pop trailing non-space words until ellipsis fits. If we
 *     end up with a single text word that STILL doesn't fit, pop it too —
 *     the ellipsis stands alone rather than overflowing the container.
 *     Box-open markers earlier on the line stay; they preserve inline-box
 *     padding/border that the emit loop needs.
 *  4. Inherit boxStyle from the trailing context so inline `<span>`
 *     backgrounds/borders extend across the ellipsis.
 */
function applyEllipsisToLine(
  session: LayoutSession,
  line: PositionedLine,
  maxWidth: number,
): void {
  // 1. Find the last word whose style should drive the ellipsis.
  //    Skip empty-text markers AND atomic inline-blocks (their style is
  //    the inline-block element's, not the surrounding text).
  let styleIdx = line.words.length - 1;
  while (
    styleIdx >= 0 &&
    (line.words[styleIdx].text === '' || isAtomicInlineBlock(line.words[styleIdx]))
  ) styleIdx--;
  if (styleIdx < 0) return;
  const lastStyle = line.words[styleIdx].style;
  const boxStyle = line.words[styleIdx].boxStyle;
  // The ellipsis takes the trimmed run's style, so it has to take the parent
  // that style's vertical-align measures against too.
  const parentStyle = line.words[styleIdx].parentStyle;
  const m = session.measurer;
  const ellipsisWidth = m.width(m.stateOf(lastStyle), '…');

  // Helper: pop trailing isSpace words. Box markers (text === '' with
  // boxOpen/boxClose) are NOT popped — they carry inline-box padding the
  // emit loop relies on.
  const popTrailingSpaces = () => {
    while (
      line.words.length > 0 &&
      line.words[line.words.length - 1].isSpace
    ) {
      const r = line.words.pop()!;
      line.totalWidth -= r.width;
    }
  };

  // 2. Strip purely trailing whitespace.
  popTrailingSpaces();

  // 3. Back-trim non-space text words until the ellipsis fits.
  //    Atomic inline-blocks are non-space too; they pop along with words.
  const isTrimmableText = (w: Word) =>
    !w.isSpace && w.text !== '' && !w.boxOpen && !w.boxClose;
  while (
    line.totalWidth + ellipsisWidth > maxWidth &&
    line.words.length > 0
  ) {
    const last = line.words[line.words.length - 1];
    if (!isTrimmableText(last) && !isAtomicInlineBlock(last)) break;
    line.totalWidth -= last.width;
    line.words.pop();
    popTrailingSpaces();
  }

  // 4. Append the ellipsis. Inherit boxStyle so inline-span backgrounds /
  //    borders extend over the ellipsis.
  const ellipsisWord: Word = {
    text: '…',
    width: ellipsisWidth,
    style: lastStyle,
    parentStyle,
    isSpace: false,
    boxStyle,
  };
  line.words.push(ellipsisWord);
  if (session.stats) session.stats.wordObjects++;
  line.totalWidth += ellipsisWidth;
}

// ─── Inline layout ─────────────────────────────────────────────────────

/**
 * Collect text runs from inline children, preserving style and tracking
 * inline elements with visible backgrounds. Emits open/close markers
 * for inline boxes so padding/border can be applied.
 */
function collectTextRuns(node: StyledNode): TextRun[] {
  const runs: TextRun[] = [];

  function walk(
    n: StyledNode,
    boxStyle?: ResolvedStyle,
    clipStyle?: ResolvedStyle,
    strokeImageStyle?: ResolvedStyle,
    parentStyle?: ResolvedStyle,
    bidi: BidiContext | null = null,
  ) {
    if (n.tagName === '#text' && n.textContent) {
      // A #text node carries its parent ELEMENT's style, so the element that
      // owns any vertical-align here is that parent — and what the shift
      // measures against is ITS parent, which is the `parentStyle` handed to
      // this element's walk.
      runs.push({
        text: n.textContent, style: n.style, parentStyle, boxStyle, clipStyle, strokeImageStyle, bidi,
      });
      return;
    }
    const isInlineBlock = n.style.display === 'inline-block';
    const inline = isInline(n);
    // Inline-block always needs box treatment (padding/margin affect layout)
    const isBox = isInlineBlock || (inline && hasVisibleBoxStyles(n.style));
    const newBoxStyle = isBox ? n.style : boxStyle;
    // Track the nearest inline element declaring a background-clip:text
    // background or a --rt-text-stroke-image, so those paints reach descendant
    // runs that don't carry the (non-inheriting) properties themselves.
    const newClipStyle = inline && hasTextClip(n.style) ? n.style : clipStyle;
    const newStrokeImageStyle = inline && hasStrokeImage(n.style) ? n.style : strokeImageStyle;
    const hasHorizSpacing = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    if (isInlineBlock) {
      // Inline-block is fully atomic — the entire element (margins + padding +
      // content) wraps as one unit: one run, one segment, sized and laid out
      // from its own content (`inlineBlockContentWidth`). Its text is U+FFFC,
      // what an atomic inline is to line breaking and bidi — never its
      // content's text, whose characters would make it splittable (CJK) or
      // glue it like punctuation. Content that is no text at all is only
      // its opening edge (a line box of its own).
      const hasText = !!n.element?.textContent;
      runs.push({
        text: hasText ? '\uFFFC' : '',
        style: n.style,
        wordBoundaryBefore: true,
        parentStyle,
        boxStyle: newBoxStyle,
        clipStyle: newClipStyle,
        strokeImageStyle: newStrokeImageStyle,
        // Both edges mark it atomic; an empty one is only its opening edge.
        boxOpen: n.style,
        boxClose: hasText ? n.style : undefined,
        inlineBlock: n,
        bidi,
      });
      return;
    }

    // unicode-bidi: bidi-override (e.g. <bdo dir="rtl">) forces visual order.
    // For an RTL override, reverse both the characters of each descendant run
    // and the order of the runs, so the subtree renders right-to-left.
    const ub = n.style.unicodeBidi;
    const overrideRtl = (ub === 'bidi-override' || ub === 'isolate-override') &&
      n.style.direction === 'rtl';
    const overrideStart = runs.length;
    // The element's own bidi context (CSS Writing Modes 3 §2.4.2). An RTL
    // override's runs are reversed into visual order just below and painted
    // left to right, so to the bidi algorithm they are an LTR override.
    const childBidi = bidiContextFor(ub, overrideRtl ? 'ltr' : n.style.direction, bidi);

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style, bidi });
    }

    for (const child of n.children) {
      walk(
        child, newBoxStyle, newClipStyle, newStrokeImageStyle,
        // An element child measures against this element; a text child's
        // vertical-align belongs to this element, so it measures against what
        // this element measures against.
        child.tagName === '#text' ? parentStyle : n.style,
        childBidi,
      );
    }

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style, bidi });
    }

    if (overrideRtl && runs.length > overrideStart) {
      const seg = runs.splice(overrideStart);
      for (const r of seg) {
        if (r.text) {
          r.text = [...r.text].reverse().join('');
          // The glyphs are now in visual (reversed) order, so render them
          // left-to-right; otherwise renderText would right-anchor x and the
          // LTR emission (which set x as the left edge) would misposition them.
          r.style = { ...r.style, direction: 'ltr' };
        }
      }
      seg.reverse();
      runs.push(...seg);
    }
  }

  // The block itself is the parent every top-level run measures against.
  for (const child of node.children) {
    walk(child, undefined, undefined, undefined, node.style);
  }
  return runs;
}

/**
 * Check if text needs Intl.Segmenter for word breaking (Thai, Khmer, Lao, Myanmar).
 * These scripts don't use spaces between words.
 */
function needsSegmenter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (
      (code >= 0x0E00 && code <= 0x0E7F) ||  // Thai
      (code >= 0x0E80 && code <= 0x0EFF) ||  // Lao
      (code >= 0x1000 && code <= 0x109F) ||  // Myanmar
      (code >= 0x1780 && code <= 0x17FF)     // Khmer
    ) return true;
    if (code > 0xFFFF) i++; // skip surrogate pair
  }
  return false;
}

const segmenters: Partial<Record<'word' | 'grapheme', Intl.Segmenter>> = {};
function segmenter(granularity: 'word' | 'grapheme'): Intl.Segmenter | undefined {
  let seg = segmenters[granularity];
  if (!seg && typeof Intl !== 'undefined' && Intl.Segmenter) {
    seg = segmenters[granularity] = new Intl.Segmenter(undefined, { granularity });
  }
  return seg;
}

/**
 * How much left context a cumulative measurement keeps, in UTF-16 units.
 *
 * A piece of a run is measured as the difference of two measurements taken
 * WITH the text before it — `w(context + piece) - w(context)` — because a sum
 * of pieces measured alone loses the kerning across their edges: in Chromium
 * 3.5px over a 2,286px Arial run, mostly against the space. Taking the whole
 * run so far as the context was quadratic (a 2000-word paragraph sent 25.7M
 * characters to measureText). Once the context passes this many units it
 * restarts at the last word (`Cumulative`), or for a character split
 * (`splitSegment`) at the last character.
 *
 * Chosen from the full-corpus 1px wrap sweep in all six fonts: at 32 not one
 * width moved against the whole-run context in Chromium or WebKit. Shorter
 * contexts did move, all on RTL and fallback-font lines (Arabic with digits
 * and Hebrew in Merriweather): the engine resolves a space's font and bidi
 * level from more than its neighbours, so pairs alone are not enough there.
 */
const MEASURE_CONTEXT = 32;

/**
 * Cumulative measuring over one run. `text` is the measured context and
 * `width` its width. `word` is where the last non-space piece starts in
 * `text`: the context restarts there (or at a bracket still open before it,
 * `contextStart`), so the space after a word is always measured with that
 * word on its left — a bare `' '` resolves to the primary
 * font, but between two fallback-font words (Hebrew in Merriweather) the
 * engine sets it in the fallback, and a context of `' '` alone mis-measured
 * every RTL word after it.
 */
interface Cumulative {
  text: string;
  width: number;
  word: number;
}

/**
 * How far back an open bracket still holds the context (`contextStart`).
 * Past this the bracket is let go, so a stray "(" cannot make a paragraph's
 * measuring quadratic again.
 */
const MEASURE_BRACKET = 256;

/**
 * Where a context restart may cut `text`: at `word`, or earlier, when a
 * bracket is still open there. A bracket pair's direction (UBA N0) comes
 * from the strong type inside it and the one BEFORE the opener, and its
 * glyphs (mirrored or not, and in whose font) follow. So the context keeps
 * the opener and the word holding the nearest LETTER before it — not a digit:
 * a number takes its own type from the letter before it (UBA W7). In
 * Lobster, `)` in `<Arabic>: $42.99 (<Arabic> … ₪158.50)` measured 0.38px
 * narrower with the context cut at the last word, and that moved a wrap.
 */
function contextStart(text: string, word: number): number {
  const open: number[] = [];
  for (let i = 0; i < word; i++) {
    const c = text[i];
    if (OPEN_BRACKET.test(c)) open.push(i);
    else if (CLOSE_BRACKET.test(c)) open.pop();
  }
  if (open.length === 0) return word;
  let start = open[0];
  while (start > 0 && !LETTER.test(text[start - 1])) start--;
  while (start > 0 && text[start - 1] !== ' ') start--;
  return word - start <= MEASURE_BRACKET ? start : word;
}
const OPEN_BRACKET = /\p{Ps}/u;
const CLOSE_BRACKET = /\p{Pe}/u;
const LETTER = /\p{L}/u;

/** The width `piece` adds after what `cum` holds; appends it. */
function measureAfter(m: Measurer, state: MeasureState, cum: Cumulative, piece: string): number {
  const isSpace = piece === ' ';
  if (!isSpace && cum.word > 0 && cum.text.length > MEASURE_CONTEXT) {
    const start = contextStart(cum.text, cum.word);
    if (start > 0) {
      cum.text = cum.text.slice(start);
      cum.width = m.width(state, cum.text);
    }
  }
  const before = cum.width;
  if (!isSpace) cum.word = cum.text.length;
  cum.text += piece;
  cum.width = m.width(state, cum.text);
  return cum.width - before;
}

// ─── Prepared inline content ───────────────────────────────────────────

/** What a segment shares with its run: the run itself, one per run, referenced by index. */
type SegmentRefs = Readonly<Omit<TextRun, 'text' | 'wordBoundaryBefore'>>;

/** Collapsible or preserved whitespace; a space's width carries word-spacing. */
const SEG_SPACE = 1 << 0;
/** A preserved tab: its width is a placeholder until the flow reaches a stop. */
const SEG_TAB = 1 << 1;
/** Breaks after a soft hyphen: a visible '-' when a line ends here. */
const SEG_SOFT_HYPHEN = 1 << 2;
/**
 * No soft-wrap opportunity before this segment: it abuts the previous one
 * with no whitespace (adjacent inline spans `<span>a</span><span>b</span>`),
 * so the two are one unbreakable unit at that boundary.
 */
const SEG_NO_BREAK_BEFORE = 1 << 3;
/**
 * Starts a new measuring run right after a run of the SAME style object
 * (text nodes of one element split by a comment, an empty or hidden
 * element): the two were measured apart, so paint must not batch across the
 * seam — see `startsMeasuredRun`. Set only on those rare segments.
 */
const SEG_RUN_SEAM = 1 << 4;
/** Flags a piece cut from a segment keeps (`FlowItems.cut`); the rest come from its own text. */
const SEG_INHERITED = SEG_SPACE | SEG_TAB | SEG_SOFT_HYPHEN | SEG_NO_BREAK_BEFORE | SEG_RUN_SEAM;
/** The text is exactly `'\n'`: a forced break. */
const SEG_HARD_BREAK = 1 << 5;
/** Holds a CJK character: always broken per character (`splitSegment`). */
const SEG_CJK = 1 << 6;
/** Holds an emoji cluster: a break opportunity between clusters. */
const SEG_EMOJI = 1 << 7;
/** Punctuation that cannot start a line (`TRAILING_PUNCT`). */
const SEG_CLOSING_PUNCT = 1 << 8;
/** Punctuation that cannot end a line (`OPENING_PUNCT`). */
const SEG_OPENING_PUNCT = 1 << 9;

/** The flags a text earns on its own: forced break and kinsoku glue. */
function textFlags(text: string): number {
  if (!text) return 0;
  let flags = 0;
  if (text === '\n') flags |= SEG_HARD_BREAK;
  if (TRAILING_PUNCT.test(text)) flags |= SEG_CLOSING_PUNCT;
  if (OPENING_PUNCT.test(text)) flags |= SEG_OPENING_PUNCT;
  return flags;
}

/** Whether `splitSegment` breaks this text per character / cluster, whatever the width. */
function breakFlags(text: string): number {
  let flags = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (isCJKCode(code)) { flags |= SEG_CJK; break; }
    if (code > 0xFFFF) i++;
  }
  // Emoji only with a grapheme segmenter, so ZWJ sequences, skin tones and
  // flag pairs stay intact.
  if (segmenter('grapheme') && EMOJI_CANDIDATE.test(text) && graphemes(text).some(isEmojiCluster)) {
    flags |= SEG_EMOJI;
  }
  return flags;
}

/**
 * One inline formatting context's text, segmented and measured ONCE per
 * layout call: every pass that reads the content — min-content (a flow at
 * 0), max-content (a flow at Infinity) and the real flow at the used width —
 * reads these arrays (`preparedInline`). Width-independent by construction:
 * everything here depends on the content and the call's measurer, never on
 * a container width, so a pass may not write to it.
 *
 * Struct of arrays, one entry per segment (a word, a space, a tab, a forced
 * break, an inline box edge or an atomic inline-block); what a segment shares
 * with its run sits once in `refs`. Plain arrays, not typed ones: V8 already
 * stores these unboxed, and typed arrays measured slower (a buffer to
 * allocate and track per paragraph). Segment text is the exact string that
 * was measured and that `LayoutText.text` publishes — not a range into one
 * concatenated paragraph: the text has to be a string to be measured anyway,
 * and a slice of a concatenation may be stored two-byte where the run's own
 * string is one-byte, which nothing should risk handing to `measureText`.
 */
interface PreparedInline {
  /** Text runs the content produced (`collectTextRuns`); 0 = nothing inline at all. */
  readonly runs: number;
  readonly count: number;
  readonly text: readonly string[];
  /** Advance in the run's own measuring state, with left context (`measureAfter`). */
  readonly width: readonly number[];
  readonly flags: readonly number[];
  /** Index into `refs`. */
  readonly ref: readonly number[];
  readonly refs: readonly SegmentRefs[];
  /**
   * The segments whose width the final flow decides, not preparing: each
   * atomic inline-block (prepared at its max-content width) and each inline
   * box edge holding a percentage padding (prepared at 0). Both depend on
   * the containing block's used width (`usedSegmentWidths`).
   */
  readonly inlineBlocks: readonly number[];
  readonly percentEdges: readonly number[];
}

/** Grows the `PreparedInline` arrays while a pass appends segments. */
class SegmentBuilder implements PreparedInline {
  runs = 0;
  count = 0;
  readonly text: string[] = [];
  readonly width: number[] = [];
  readonly flags: number[] = [];
  readonly ref: number[] = [];
  readonly refs: SegmentRefs[] = [];
  readonly inlineBlocks: number[] = [];
  readonly percentEdges: number[] = [];

  addRefs(refs: SegmentRefs): number {
    this.refs.push(refs);
    return this.refs.length - 1;
  }

  push(text: string, width: number, flags: number, ref: number): void {
    this.text.push(text);
    this.width.push(width);
    // A space's text is never a forced break or punctuation.
    this.flags.push(flags & SEG_SPACE ? flags : flags | textFlags(text));
    this.ref.push(ref);
    this.count++;
  }
}

/** `[ \t\n\r\f\v]`: what collapsible white space splits on. */
function isCollapsibleSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/**
 * Segment and measure a single string into `out` by white-space mode, in one
 * pass over its characters: each piece is a `text.slice` cut where the rules
 * below allow a break.
 */
function prepareString(
  session: LayoutSession, out: SegmentBuilder, text: string, run: TextRun, ref: number,
  cumState?: Cumulative,
): void {
  const m = session.measurer;
  // Split on zero-width spaces and soft hyphens (break opportunities).
  // Pass cumulative state through so pieces are measured as one text run
  // (preserving kerning accuracy across break points).
  if (text.includes('\u200B') || text.includes('\u00AD')) {
    const parts = text.split(/(\u200B|\u00AD)/);
    // Share cumulative state across all sub-parts for accurate measurement
    const sharedState = cumState ?? { text: '', width: 0, word: 0 };
    let nextIsSoftHyphen = false;
    for (const part of parts) {
      if (part === '\u00AD') {
        nextIsSoftHyphen = true;
        continue;
      }
      if (part === '\u200B' || part === '') {
        nextIsSoftHyphen = false;
        continue;
      }
      // The segment before this part — possibly one from an earlier run.
      const prevLen = out.count;
      prepareString(session, out, part, run, ref, sharedState);
      if (nextIsSoftHyphen && prevLen > 0) {
        out.flags[prevLen - 1] |= SEG_SOFT_HYPHEN;
      }
      nextIsSoftHyphen = false;
    }
    if (nextIsSoftHyphen && out.count > 0) {
      out.flags[out.count - 1] |= SEG_SOFT_HYPHEN;
    }
    return;
  }

  // Every width below is the run's own: its font, kerning and letter-spacing.
  const state = m.stateOf(run.style);
  const n = text.length;

  // `pre-line` preserves newlines (handled by the \n pre-split in
  // prepareInline) but collapses spaces and tabs — so it goes through the
  // non-preserving branch below, same as `normal`.
  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'break-spaces';

  if (isPreserve) {
    // Space runs, single tabs, and the text between them split after
    // hyphens; each measured on its own.
    const tabStopInterval = m.width(state, ' ') * 8; // CSS default: 8 spaces
    let i = 0;
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 9) {
        // Tab width depends on the position it lands at: the flow resolves
        // it against the tab stops, this is a placeholder.
        out.push('\t', tabStopInterval, SEG_SPACE | SEG_TAB, ref);
        i++;
        continue;
      }
      let j = i + 1;
      if (code === 32) {
        while (j < n && text.charCodeAt(j) === 32) j++;
        const w = text.slice(i, j);
        out.push(w, m.width(state, w), SEG_SPACE, ref);
      } else {
        while (j < n && text.charCodeAt(j) !== 32 && text.charCodeAt(j) !== 9) j++;
        forEachHyphenPiece(text, i, j, (w) => out.push(w, m.width(state, w), breakFlags(w), ref));
      }
      i = j;
    }
    return;
  }

  // Collapsible white space separates words; inside a word there is a break
  // opportunity AFTER "?" (the URL query delimiter): Chrome wraps
  // "\u2026/q3?" | "lang=ar&\u2026" even with overflow-wrap:normal. It does
  // NOT break at "/", "&", "=", "." or ":" (verified against the browser), so
  // only "?" counts. The "?" stays with the preceding piece; a trailing "?"
  // (no follower, or a line separator after it) is left intact.
  // The second opportunity: a non-breaking space still permits a break
  // BEFORE it when the preceding character is a hyphen or a break-after one
  // (UAX #14 LB12a, `[^SP BA HY] x GL`). Measured against the DOM with
  // `aaaaaaaaaa<c>\u00A0bbbbbbbbbb` at 120px/15px Open Sans: only "-",
  // "|", "\u2013" and "\u2014" break there. Letters, "\u2026", ")", "\u00BB",
  // "?", "/" and "," all keep the NBSP glued, so the set is exactly HY
  // plus BA and nothing wider. Each piece then splits after its hyphens.
  //
  // Each piece is measured after its left context (`measureAfter`), so
  // kerning across word and space edges survives. When cumState is provided
  // (from a \u200B/\u00AD split), continue from the previous part's context.
  const cum: Cumulative = cumState ?? { text: '', width: 0, word: 0 };
  const word = (w: string) => {
    // Use Intl.Segmenter for scripts without spaces (Thai, Khmer, etc.)
    if (needsSegmenter(w)) {
      const wordSeg = segmenter('word');
      if (wordSeg) {
        for (const seg of wordSeg.segment(w)) {
          const s = seg.segment;
          out.push(s, measureAfter(m, state, cum, s), breakFlags(s), ref);
        }
        return;
      }
    }
    const width = measureAfter(m, state, cum, w);
    if (session.debug) {
      // The word measured on its own, against its cumulative delta — a
      // measurement only the debug callback reads.
      const directWidth = m.width(state, w);
      session.debug({
        type: 'measure-word',
        message: `"${w}" delta=${width.toFixed(2)} direct=${directWidth.toFixed(2)} diff=${(width - directWidth).toFixed(2)} context="${cum.text}"`,
        data: { text: w, deltaWidth: width, directWidth, contextWidth: cum.width, contextBefore: cum.width - width, font: run.style.fontFamily, fontSize: run.style.fontSize },
      });
    }
    out.push(w, width, breakFlags(w), ref);
  };
  let i = 0;
  while (i < n) {
    let j = i + 1;
    if (isCollapsibleSpace(text.charCodeAt(i))) {
      while (j < n && isCollapsibleSpace(text.charCodeAt(j))) j++;
      out.push(' ', measureAfter(m, state, cum, ' ') + (run.style.wordSpacing || 0), SEG_SPACE, ref);
      i = j;
      continue;
    }
    while (j < n && !isCollapsibleSpace(text.charCodeAt(j))) j++;
    let start = i;
    for (let q = i + 1; q < j; q++) {
      const before = text.charCodeAt(q - 1);
      const at = text.charCodeAt(q);
      if ((before === 0x3F && at !== 0x2028 && at !== 0x2029) ||
          (at === 0xA0 && (before === 0x2D || before === 0x7C || before === 0x2013 || before === 0x2014))) {
        forEachHyphenPiece(text, start, q, word);
        start = q;
      }
    }
    forEachHyphenPiece(text, start, j, word);
    i = j;
  }
}

/**
 * `text.slice(start, end)` split after CSS hyphen break opportunities,
 * keeping the hyphen. A hyphen opens one only with a
 * character before it in the same piece: a leading hyphen stays with the
 * word it starts.
 */
function forEachHyphenPiece(text: string, start: number, end: number, emit: (piece: string) => void): void {
  let from = start;
  for (let q = start + 2; q < end; q++) {
    if (text.charCodeAt(q - 1) === 0x2D) {
      emit(text.slice(from, q));
      from = q;
    }
  }
  emit(text.slice(from, end));
}

/** The first and last grapheme clusters of a non-empty text. */
function firstGrapheme(text: string): string {
  const seg = segmenter('grapheme');
  return seg ? seg.segment(text).containing(0)!.segment : String.fromCodePoint(text.codePointAt(0)!);
}
function lastGrapheme(text: string): string {
  const seg = segmenter('grapheme');
  if (seg) return seg.segment(text).containing(text.length - 1)!.segment;
  const chars = [...text];
  return chars[chars.length - 1];
}

/**
 * Segment and measure text runs: the one pass over an inline formatting
 * context's text in a layout call (`preparedInline`).
 */
function prepareInline(session: LayoutSession, runs: TextRun[]): PreparedInline {
  const out = new SegmentBuilder();
  /** The text so far ends with a zero-width space (a break opportunity). */
  let zwspBefore = false;
  /** Style of the last text run that produced segments (`markSeam`). */
  let lastTextStyle: ResolvedStyle | null = null;
  let runStart = 0;

  for (const run of transformTextRuns(runs)) {
    // Atomic inline-block: entire element (margin + padding + content) is one
    // segment, at its max-content width — its intrinsic contribution, with any
    // percentage of the line's containing block at 0. The final flow re-sizes
    // it (`usedSegmentWidths`). Must check before boxOpen/boxClose handlers
    // since atomic has both set.
    if (run.boxOpen && run.boxClose && run.text) {
      const source = run.inlineBlock!;
      out.inlineBlocks.push(out.count);
      out.push(run.text, inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), Infinity), 0, out.addRefs(run));
      continue;
    }

    // Inline box edges (padding + border). An empty inline-block lands here
    // as its opening edge only. A percentage padding is 0 here, and the final
    // flow resolves it (`usedSegmentWidths`).
    const edge = run.boxOpen ?? run.boxClose;
    if (edge) {
      const box = intrinsicStyle(edge);
      const pad = run.boxOpen ? box.paddingLeft + box.borderLeftWidth : box.paddingRight + box.borderRightWidth;
      if (pad > 0 || box !== edge) {
        if (box !== edge) out.percentEdges.push(out.count);
        out.push('', pad, 0, out.addRefs(run));
      }
      continue;
    }

    const text = run.text;
    const ref = out.addRefs(run);
    runStart = out.count;
    /**
     * Flag the first segment of this run when the previous text run had the
     * same style object: a seam between two measuring runs that paint could
     * otherwise batch (`SEG_RUN_SEAM`).
     */
    const markSeam = (startLen: number, first: boolean) => {
      if (first && run.style === lastTextStyle && out.count > startLen) out.flags[startLen] |= SEG_RUN_SEAM;
    };
    // A zero-width space at the run boundary (a `<wbr>`, or one ending the
    // previous run) is a break opportunity there; it produces no segment itself.
    const breakAtStart = zwspBefore || text.charCodeAt(0) === 0x200B;
    zwspBefore = text.charCodeAt(text.length - 1) === 0x200B || (zwspBefore && /^\u200B*$/.test(text));

    // A run boundary inside a word is no break opportunity
    // (`abutsWithoutBreak`), unless a zero-width space opens one.
    const markGlue = (startLen: number) => {
      if (!breakAtStart && abutsWithoutBreak(out, startLen)) out.flags[startLen] |= SEG_NO_BREAK_BEFORE;
    };

    // Handle explicit newlines (from <br> or pre-wrap) — always force line break
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) out.push('\n', 0, 0, ref);
        if (parts[i]) {
          const startLen = out.count;
          prepareString(session, out, parts[i], run, ref);
          markSeam(startLen, i === 0);
          markGlue(startLen);
        }
      }
    } else {
      const startLen = out.count;
      prepareString(session, out, text, run, ref);
      markSeam(startLen, true);
      markGlue(startLen);
    }
    if (out.count > runStart) lastTextStyle = run.style;
  }

  if (session.stats) {
    session.stats.tokenizePasses++;
    session.stats.segments += out.count;
  }
  out.runs = runs.length;
  return out;
}

/**
 * The prepared content of the inline formatting context `node` roots, for
 * intrinsic sizing: made once per call and kept for the passes still to
 * come — max-content, min-content, then the layout that places it.
 */
function preparedInline(session: LayoutSession, node: StyledNode): PreparedInline {
  let prepared = session.prepared.get(node);
  if (!prepared) {
    prepared = prepareInline(session, collectTextRuns(node));
    session.prepared.set(node, prepared);
  }
  return prepared;
}

/**
 * The prepared content for the layout itself, the last pass to read it: it
 * leaves the session, so a long document does not hold every paragraph's
 * segments until the call ends. A block nothing sized is never kept.
 */
function takePreparedInline(session: LayoutSession, node: StyledNode): PreparedInline {
  const prepared = session.prepared.get(node);
  if (!prepared) return prepareInline(session, collectTextRuns(node));
  session.prepared.delete(node);
  return prepared;
}

function isCJKCode(code: number): boolean {
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
    (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols
    (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
    (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul
    (code >= 0xFF00 && code <= 0xFFEF) ||   // Fullwidth
    (code >= 0x20000 && code <= 0x2A6DF)    // CJK Extension B
  );
}

/** Split into grapheme clusters; code points when Intl.Segmenter is unavailable. */
export function graphemes(text: string): string[] {
  const seg = segmenter('grapheme');
  if (!seg) return [...text];
  const out: string[] = [];
  for (const s of seg.segment(text)) out.push(s.segment);
  return out;
}

const EMOJI_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/**
 * Exactly the characters `isEmojiCluster` can answer `true` for: something in
 * the emoji planes (regional-indicator flags included), a ZWJ, or a VS16. A
 * word without one of these cannot contain an emoji cluster, so this skips
 * grapheme segmentation for the overwhelming majority of words.
 */
const EMOJI_CANDIDATE = /[\u{1F000}-\u{10FFFF}\u200D\uFE0F]/u;
/**
 * Is this grapheme cluster an emoji that creates a line-break opportunity?
 * Restricted to emoji-presentation clusters (emoji planes, regional-indicator
 * flags, and ZWJ/VS16 sequences) so plain text symbols like ©/®/™ — which are
 * Extended_Pictographic but render as text and do NOT break — are excluded.
 */
function isEmojiCluster(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f000) return true; // emoji planes (incl. regional indicators)
  }
  if (s.includes('\u200D') || s.includes('\uFE0F')) {
    return EMOJI_PICTOGRAPHIC.test(s); // ZWJ sequence or VS16 emoji presentation
  }
  return false;
}

// ─── Line flow ─────────────────────────────────────────────────────────

/**
 * What one flow places on lines, by index: the prepared segments first
 * (`0 … prepared.count - 1`), then the pieces this flow cuts from them —
 * per-character CJK/emoji and break-word pieces, glued-chain fragments, a
 * soft hyphen's visible '-', a tab at its stop. A flow never writes to the
 * prepared arrays, so every pass over one `PreparedInline` starts from the
 * same content.
 */
class FlowItems {
  private readonly base: number;
  private readonly pieceText: string[] = [];
  private readonly pieceWidth: number[] = [];
  private readonly pieceFlags: number[] = [];
  private readonly pieceRefs: SegmentRefs[] = [];
  /** The segment a piece was cut from (its inline-block), or -1. */
  private readonly pieceSource: number[] = [];
  private textOnlyRefs: Map<SegmentRefs, SegmentRefs> | undefined;

  /**
   * `refs` stands in for `prepared.refs` (min-content neutralizes
   * `overflow-wrap`), and `widths` for `prepared.width` (an inline-block's
   * width is its laid-out box, a percentage padding its used value:
   * `usedSegmentWidths`).
   */
  constructor(
    readonly prepared: PreparedInline,
    private readonly refsTable: readonly SegmentRefs[] = prepared.refs,
    private readonly widths: readonly number[] = prepared.width,
    private readonly inlineBlocks?: ReadonlyMap<number, InlineBlockLayout>,
  ) {
    this.base = prepared.count;
  }

  text(i: number): string {
    return i < this.base ? this.prepared.text[i] : this.pieceText[i - this.base];
  }

  /**
   * Item `i`'s text for debug entries: an atomic inline reads as its
   * content's text — its segment is U+FFFC, which only line breaking and
   * bidi should see.
   */
  debugText(i: number): string {
    const inlineBlock = this.refs(i).inlineBlock;
    return inlineBlock ? inlineBlock.element?.textContent ?? '' : this.text(i);
  }

  width(i: number): number {
    return i < this.base ? this.widths[i] : this.pieceWidth[i - this.base];
  }

  flags(i: number): number {
    return i < this.base ? this.prepared.flags[i] : this.pieceFlags[i - this.base];
  }

  refs(i: number): SegmentRefs {
    return i < this.base ? this.refsTable[this.prepared.ref[i]] : this.pieceRefs[i - this.base];
  }

  inlineBlockLayout(i: number): InlineBlockLayout | undefined {
    if (!this.inlineBlocks) return undefined;
    return this.inlineBlocks.get(i < this.base ? i : this.pieceSource[i - this.base]);
  }

  /** A piece of item `from`: its flags, refs and inline-block, a text and width of its own. */
  cut(from: number, text: string, width: number): number {
    return this.add(text, width, this.flags(from) & SEG_INHERITED, this.refs(from),
      from < this.base ? from : this.pieceSource[from - this.base]);
  }

  /**
   * New text continuing item `from`'s run but not its box: the visible
   * hyphen of a soft-hyphen break, a fragment of a broken glued chain. They
   * keep the style and declarers, never the inline box edges.
   */
  textOf(from: SegmentRefs, text: string, width: number): number {
    this.textOnlyRefs ??= new Map();
    let refs = this.textOnlyRefs.get(from);
    if (!refs) {
      refs = {
        style: from.style,
        parentStyle: from.parentStyle,
        clipStyle: from.clipStyle,
        strokeImageStyle: from.strokeImageStyle,
        bidi: from.bidi,
      };
      this.textOnlyRefs.set(from, refs);
    }
    return this.add(text, width, 0, refs, -1);
  }

  /** Item `i` as the emit pass reads it. */
  word(i: number): Word {
    const refs = this.refs(i);
    const flags = this.flags(i);
    return {
      text: this.text(i),
      width: this.width(i),
      style: refs.style,
      parentStyle: refs.parentStyle,
      isSpace: (flags & SEG_SPACE) !== 0,
      isTab: (flags & SEG_TAB) !== 0,
      boxStyle: refs.boxStyle,
      boxOpen: refs.boxOpen,
      boxClose: refs.boxClose,
      clipStyle: refs.clipStyle,
      strokeImageStyle: refs.strokeImageStyle,
      inlineBlockLayout: this.inlineBlockLayout(i),
      bidi: refs.bidi,
      runSeam: (flags & SEG_RUN_SEAM) !== 0 ? true : undefined,
    };
  }

  private add(text: string, width: number, flags: number, refs: SegmentRefs, source: number): number {
    this.pieceText.push(text);
    this.pieceWidth.push(width);
    this.pieceFlags.push(flags | textFlags(text));
    this.pieceRefs.push(refs);
    this.pieceSource.push(source);
    return this.base + this.pieceText.length - 1;
  }
}

/** A line one flow committed: its items (`FlowItems` indices) in order. */
interface FlowLine {
  items: number[];
  totalWidth: number;
  lineHeight: number;
  /** True at a forced break (preserved \n or <br>); uses text-align-last. */
  endedByHardBreak?: boolean;
}

/**
 * The one canvas state every glyph on these items is measured under — only
 * then can the line be re-measured as a single string. `'mixed'` when the
 * glyphs need more than one, `null` when the line holds no glyph at all.
 * Compared on the interned `MeasureState`, i.e. on what the canvas is
 * actually set to, not on the raw declarations — `font-kerning: auto` and
 * `normal` are one state. Spaces do not count; the re-measure keeps their
 * own widths where they differ.
 */
function lineMeasureState(
  m: Measurer, items: FlowItems, line: readonly number[], next: number,
): MeasureState | null | 'mixed' {
  let shared: MeasureState | null = null;
  for (let k = 0; k <= line.length; k++) {
    const i = k < line.length ? line[k] : next;
    // An inline-block is a box, not glyphs in any state.
    if (!items.text(i) || (items.flags(i) & SEG_SPACE) || items.refs(i).inlineBlock) continue;
    const state = m.stateOf(items.refs(i).style);
    if (shared && state !== shared) return 'mixed';
    shared = state;
  }
  return shared;
}

/**
 * Break segment `index` into character-level pieces if it contains CJK/emoji,
 * or if overflow-wrap: break-word is set and it is too wide. `null` when it
 * stays whole — the common case, decided from the prepared flags without
 * touching the text.
 *
 * `emergency` distinguishes the two reasons. CJK and emoji carry their own
 * break opportunities, so those splits are ordinary and fill the current line.
 * `overflow-wrap: break-word` is a last resort, and the caller has to know
 * which of the two it got.
 */
function splitSegment(
  session: LayoutSession,
  items: FlowItems,
  index: number,
  contentWidth: number,
): { texts: string[]; widths: number[]; emergency: boolean } | null {
  const flags = items.flags(index);
  const style = items.refs(index).style;
  // CJK always breaks at character level; emoji form their own break
  // opportunities (a run of emoji wraps between clusters).
  const hasCJK = (flags & SEG_CJK) !== 0;
  const hasEmoji = (flags & SEG_EMOJI) !== 0;

  // Check if the segment needs break-word splitting — when it won't fit on a fresh line
  const needsBreak = items.width(index) > contentWidth &&
    (style.overflowWrap === 'break-word' || style.wordBreak === 'break-all');

  if (!hasCJK && !hasEmoji && !needsBreak) return null;

  // `overflow-wrap: break-word` is the last-resort split; CJK/emoji breaks are
  // ordinary opportunities that behave nothing like it at the line edge.
  // `word-break: break-all` genuinely allows a break anywhere, so it is not an
  // emergency either.
  const emergency = needsBreak && !hasCJK && !hasEmoji &&
    style.wordBreak !== 'break-all';

  // Split into characters, each measured after its left context like the
  // tokenizer's pieces (`MEASURE_CONTEXT`): measuring each char alone ignores
  // kerning, and the sum of individual widths diverges from the true string
  // width over many characters. Positions below (`measuredWidth`,
  // `currentStartWidth`) are offsets in the context's coordinates, so a
  // context restart shifts them together. Break points use THIS segment's
  // state, whatever run was measured last.
  const m = session.measurer;
  const state = m.stateOf(style);
  const text = items.text(index);
  // When the segment contains emoji, iterate by GRAPHEME cluster so multi-codepoint
  // emoji (ZWJ families, skin tones, flags) are never split mid-cluster.
  const chars = hasEmoji ? graphemes(text) : [...text];
  const texts: string[] = [];
  const widths: number[] = [];
  const piece = (t: string, w: number) => {
    texts.push(t);
    widths.push(w);
  };

  let current = '';
  let currentWidth = 0;
  let measuredText = '';
  let measuredWidth = 0;
  let currentStartWidth = 0;
  let previous = '';

  for (const char of chars) {
    if (measuredText.length > MEASURE_CONTEXT && previous) {
      const restart = m.width(state, previous);
      currentStartWidth -= measuredWidth - restart;
      measuredText = previous;
      measuredWidth = restart;
    }
    previous = char;
    const nextMeasuredText = measuredText + char;
    const nextMeasuredWidth = m.width(state, nextMeasuredText);
    const charWidth = nextMeasuredWidth - measuredWidth;

    // Emoji clusters and CJK characters each get their own piece — a break
    // opportunity between them, matching the browser line breaker.
    if ((hasEmoji && isEmojiCluster(char)) || isCJKCode(char.codePointAt(0)!)) {
      if (current) {
        piece(current, currentWidth);
        current = '';
        currentWidth = 0;
      }
      piece(char, charWidth);
      currentStartWidth = nextMeasuredWidth;
      measuredText = nextMeasuredText;
      measuredWidth = nextMeasuredWidth;
      continue;
    }

    // Use cumulative measurement: measure the growing string, not individual chars
    const candidateText = current + char;
    const candidateWidth = nextMeasuredWidth - currentStartWidth;

    // For break-word: break when adding this char would exceed container
    if (needsBreak && candidateWidth > contentWidth && current) {
      piece(current, currentWidth);
      current = char;
      currentWidth = charWidth;
      currentStartWidth = measuredWidth;
      measuredText = nextMeasuredText;
      measuredWidth = nextMeasuredWidth;
      continue;
    }

    current = candidateText;
    currentWidth = candidateWidth;
    measuredText = nextMeasuredText;
    measuredWidth = nextMeasuredWidth;
  }

  if (current) piece(current, currentWidth);

  return { texts, widths, emergency };
}

// ─── Break opportunities ───────────────────────────────────────────────

/** Punctuation that cannot start a line — stays with the preceding word. */
const TRAILING_PUNCT = /^[,.\;:!?\)\]\}'"»›」』】〕〉》”、。・！），：；？၊-၏។-៖៘-៚]+$/;
/** Punctuation that cannot end a line — stays with the following word. */
const OPENING_PUNCT = /^[\(\[\{«‹“‘「『【〔〈《（]+$/;

/**
 * Whether the text run starting at segment `at` abuts the text before it with
 * no soft-wrap opportunity between them: adjacent inline elements with no
 * whitespace (`<span>E</span>xperience`) continue one word. This is where
 * `SEG_NO_BREAK_BEFORE` comes from; `breakBefore` is what the flow reads.
 * The preceding segment must be actual text — not a space, newline, empty
 * box-padding marker, or box edge — so a whitespace/padding boundary still
 * allows a break.
 */
function abutsWithoutBreak(out: SegmentBuilder, at: number): boolean {
  if (at >= out.count || at === 0) return false;
  const first = out.text[at];
  if ((out.flags[at] & SEG_SPACE) || !first || first === '\n') return false;
  const prev = out.text[at - 1];
  const prevRefs = out.refs[out.ref[at - 1]];
  if (
    (out.flags[at - 1] & SEG_SPACE) || !prev.trim() ||
    prevRefs.boxOpen || prevRefs.boxClose
  ) return false;
  // CJK, emoji and segmenter-driven scripts (Thai/Khmer/…) have break
  // opportunities between characters regardless of element boundaries, so
  // an element edge between them is NOT a no-break point. Only glue when
  // both sides are ordinary (Latin-like) text with no intrinsic break.
  // Take the boundary characters as GRAPHEME clusters — indexing by code
  // unit reads past the end of a surrogate pair, and indexing by code point
  // splits VS16 emoji (❤️ = U+2764 U+FE0F) so the cluster reads as non-emoji.
  const firstChar = firstGrapheme(first);
  const prevChar = lastGrapheme(prev);
  return !(
    isCJKCode(firstChar.codePointAt(0)!) || isCJKCode(prevChar.codePointAt(0)!) ||
    isEmojiCluster(firstChar) || isEmojiCluster(prevChar) ||
    needsSegmenter(first) || needsSegmenter(prev)
  );
}

/**
 * What the boundary BEFORE a flow item allows — the one answer to "may a
 * line start here?" that every breaking decision in the flow reads (the
 * glued tail, the glued chain, the fit test, the kinsoku of split pieces):
 *
 * - `'space'`: white space or a forced break; never inside a glued unit.
 * - `'continues'`: the item continues a word across an inline run boundary
 *   (`SEG_NO_BREAK_BEFORE`, from `abutsWithoutBreak`).
 * - `'glued'`: punctuation that cannot start a line (`TRAILING_PUNCT`), or
 *   an inline box's closing edge — its right padding/border belongs with
 *   the content before it.
 * - `'allowed'`: an ordinary break opportunity.
 *
 * `splitPiece` is a piece after the first of a segment the flow split (CJK,
 * emoji, break-word): that split is itself the opportunity, so the
 * segment's run-boundary glue stays with its first piece. A closer still
 * glues.
 */
type BreakBefore = 'space' | 'continues' | 'glued' | 'allowed';

function breakBefore(items: FlowItems, i: number, splitPiece = false): BreakBefore {
  const flags = items.flags(i);
  if (flags & (SEG_SPACE | SEG_HARD_BREAK)) return 'space';
  const text = items.text(i);
  if (text && !splitPiece && (flags & SEG_NO_BREAK_BEFORE)) return 'continues';
  if (flags & SEG_CLOSING_PUNCT) return 'glued';
  if (!text && items.refs(i).boxClose) return 'glued';
  return 'allowed';
}

/** No line may start at an item of this class. */
function cannotStartLine(cls: BreakBefore): boolean {
  return cls === 'continues' || cls === 'glued';
}

// ─── Glue: what must share a line ──────────────────────────────────────

/**
 * Total width of the content directly after segment `from` that cannot start
 * a line (`breakBefore`): trailing punctuation (",.)]}…"), an inline span's
 * right padding/border (empty boxClose markers), and a word continuation
 * abutting across a run boundary — one word split across two inline spans
 * with different font sizes. The browser includes all of it when deciding
 * whether the preceding word fits, so the unit wraps together: if "Music
 * Experie" doesn't leave room for the glued "nce", the whole word wraps as
 * one. Stops at whitespace or the next breakable segment.
 */
function gluedRunWidth(items: FlowItems, from: number): number {
  const count = items.prepared.count;
  let total = 0;
  for (let index = from; index < count; index++) {
    if (!cannotStartLine(breakBefore(items, index))) break;
    total += items.width(index);
  }
  return total;
}

/**
 * The glued width that rides on split piece `piece` (of `pieceEnd`): a
 * trailing-punctuation piece produced by character splitting still belongs
 * to the preceding character. Include it before deciding whether that
 * character fits; appending it afterward can overflow the line (`…습니다.`
 * must wrap as `다.`, never leave a hanging period). The segment's own glued
 * tail (`gluedRunWidth`) rides on its last piece.
 */
function trailingGlueWidth(items: FlowItems, piece: number, pieceEnd: number, gluedTailWidth: number): number {
  let tail = piece === pieceEnd - 1 ? gluedTailWidth : 0;
  for (let trailing = piece + 1; trailing < pieceEnd; trailing++) {
    if (breakBefore(items, trailing, true) !== 'glued') break;
    tail += items.width(trailing);
    if (trailing === pieceEnd - 1) tail += gluedTailWidth;
  }
  return tail;
}

/**
 * The width after piece `piece` (of segment `segment`) that must share its
 * line because no line may END at the piece: opening punctuation
 * (`OPENING_PUNCT`) and an inline box's opening edge. Leading inline
 * padding/border (an empty boxOpen marker) must not be stranded at the end
 * of a line — it belongs with the span's following content (CSS applies
 * padding-left at the box's start), so the two wrap together and the left
 * padding lands on the new line with the content.
 */
function headGlueWidth(
  flow: LineFlow, segment: number, piece: number, isLastPiece: boolean, gluedTailWidth: number,
): number {
  const items = flow.items;
  const count = items.prepared.count;
  let headExtra = 0;
  const isOpener = (items.flags(piece) & SEG_OPENING_PUNCT) !== 0;
  if (isOpener && !isLastPiece) {
    // An opener stranded mid-word by the per-character CJK split glues to
    // its NEXT PIECE, not the next word: Chrome never ends a line with
    // 「 or （ (measured: 水x5 + opener + 水x7 at width
    // 100 — the DOM wraps the opener down with its following character).
    // The segment-level branch below reads the next segment and finds
    // nothing mid-word, which left the bracket dangling at end of line.
    headExtra = items.width(piece + 1);
  } else if ((!items.text(piece) && items.refs(piece).boxOpen) ||
      (isOpener && gluedTailWidth === 0)) {
    let nextIndex = segment + 1;
    // Opening punctuation can be followed by an inline box edge before
    // its first glyph: `(<span>word</span>)`. Keep both the edge and that
    // first breakable glyph on the same line as the punctuation.
    while (nextIndex < count && !items.text(nextIndex) && items.refs(nextIndex).boxOpen) {
      headExtra += items.width(nextIndex);
      nextIndex++;
    }
    const nextText = nextIndex < count ? items.text(nextIndex) : '';
    if (nextText && !flow.isSpace(nextIndex)) {
      // Only the next segment's first BREAKABLE unit must stay with the
      // leading padding — the whole word for unbreakable Latin, but just
      // the first character for CJK / break-word (which wrap per
      // character). Using the whole word here would over-wrap a long CJK
      // run that follows padding.
      const split = nextText.length > 1 ? splitSegment(flow.session, items, nextIndex, flow.budget()) : null;
      headExtra += split ? split.widths[0] : items.width(nextIndex);
      if (!split || split.texts.length === 1) {
        // The first word's own inseparable tail is part of the same unit:
        // `(<span>p50</span>,` may break before `(` or after the comma,
        // never between the word, closing edge, and comma.
        headExtra += gluedRunWidth(items, nextIndex + 1);
      }
    }
  }
  return headExtra;
}

// ─── The line breaker ──────────────────────────────────────────────────

/**
 * One flow's line state: the lines committed so far and the one being
 * filled. The phases of `flowLines` read and grow it.
 */
class LineFlow {
  readonly lines: FlowLine[] = [];
  line: FlowLine;
  /** At the start of content, or right after a forced break. */
  afterHardBreak = true;
  readonly m: Measurer;
  /** No soft wrapping at all: everything up to a forced break is one line. */
  readonly noWrap: boolean;
  /**
   * `pre`, `pre-wrap`, and `break-spaces` preserve author whitespace
   * (leading and trailing); the others collapse it.
   */
  readonly preservesWhitespace: boolean;
  private readonly isPreWrap: boolean;

  constructor(
    readonly session: LayoutSession,
    readonly items: FlowItems,
    readonly contentWidth: number,
    private readonly whiteSpace: string,
    readonly useBulletProbe: boolean,
    private readonly textIndent: number,
    private readonly tabMetrics: TabStops | undefined,
    private readonly strutLineHeight: number,
  ) {
    this.m = session.measurer;
    this.line = this.newLine();
    this.noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
    this.isPreWrap = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';
    this.preservesWhitespace =
      whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';
  }

  /**
   * Every line box starts at the block's own "strut" height (its font +
   * line-height), so a line whose only content is a SMALLER inline font is
   * still at least the block's line-height tall — matching CSS. See callers.
   */
  private newLine(): FlowLine {
    return { items: [], totalWidth: 0, lineHeight: this.strutLineHeight };
  }

  /** Where the current line starts: text-indent offsets the first line only. */
  private lineStart(): number {
    return this.lines.length === 0 ? this.textIndent : 0;
  }

  /** The width the current line may fill. */
  budget(): number {
    return this.contentWidth - this.lineStart();
  }

  isSpace(i: number): boolean {
    return (this.items.flags(i) & SEG_SPACE) !== 0;
  }

  /** The current line's last item is a space (false on an empty line). */
  endsWithSpace(): boolean {
    const line = this.line.items;
    return line.length > 0 && this.isSpace(line[line.length - 1]);
  }

  /**
   * The current line holds an item whose flags masked by `mask` equal
   * `value`. A plain loop, not `some` with a closure: a closure over a
   * local makes V8 allocate a context on every call of the function that
   * holds it, and these run per piece.
   */
  holds(mask: number, value: number): boolean {
    for (const i of this.line.items) if ((this.items.flags(i) & mask) === value) return true;
    return false;
  }

  /** The current line's text, for debug entries (`FlowItems.debugText`). */
  text(): string {
    let text = '';
    for (const i of this.line.items) text += this.items.debugText(i);
    return text;
  }

  /** Add item `i` to the current line at `width`. */
  place(i: number, width: number, lineHeight: number): void {
    this.line.items.push(i);
    this.line.totalWidth += width;
    this.line.lineHeight = Math.max(this.line.lineHeight, lineHeight);
  }

  /**
   * Tab: advance to the next tab stop (stops measured from the content
   * edge). Chrome rule: when the next stop is closer than half a space
   * width, skip to the following stop (Blink Font::TabWidth). The tab
   * placed is a piece of its own: its width is where THIS flow put it.
   */
  placeTab(tab: number, lineHeight: number): void {
    const interval = this.tabMetrics?.interval || this.items.width(tab);
    const halfSpace = this.tabMetrics?.halfSpace ?? 0;
    const currentPos = this.lineStart() + this.line.totalWidth;
    let advance = interval - (currentPos % interval);
    if (advance < halfSpace) advance += interval;
    this.place(this.items.cut(tab, this.items.text(tab), advance), advance, lineHeight);
  }

  /** Commit the current line and start the next. */
  commit(isSoftWrap = false): void {
    const items = this.items;
    const current = this.line;
    const line = current.items;
    const hadWords = line.length > 0;
    // Trim trailing spaces. `break-spaces` preserves them even at soft wraps;
    // `pre`/`pre-wrap` preserve them at hard breaks and end-of-content but not
    // at soft wraps (per CSS Text 3 §4.1.1).
    const preserveTrailing = this.whiteSpace === 'break-spaces'
      || (this.preservesWhitespace && !isSoftWrap);
    if (!preserveTrailing) {
      while (line.length > 0 && this.isSpace(line[line.length - 1])) {
        current.totalWidth -= items.width(line[line.length - 1]);
        line.pop();
      }
    }
    // Soft hyphen: if this is a soft wrap and the last item has a soft-hyphen
    // break, append a visible '-' since the word is being broken here.
    if (isSoftWrap && line.length > 0) {
      const last = line[line.length - 1];
      if (items.flags(last) & SEG_SOFT_HYPHEN) {
        const refs = items.refs(last);
        const hyphenWidth = softHyphenAdvance(this.m, refs.style);
        // The visible hyphen continues the broken word, so it keeps the
        // word's clip/stroke-image declarer (else it paints transparent).
        line.push(items.textOf(refs, '-', hyphenWidth));
        current.totalWidth += hyphenWidth;
      }
    }
    // In pre-wrap mode, space-only lines still need height (they are content)
    if (line.length > 0 || (hadWords && this.isPreWrap)) {
      if (this.session.debug) {
        const text = this.text();
        this.session.debug({
          type: 'line-commit',
          message: `Line ${this.lines.length}: "${text}" width=${current.totalWidth.toFixed(2)} / ${this.contentWidth}`,
          data: { lineIndex: this.lines.length, text, totalWidth: current.totalWidth, contentWidth: this.contentWidth },
        });
      }
      this.lines.push(current);
    }
    this.line = this.newLine();
  }

  /** Take a soft-wrap opportunity: the content that follows starts a new line. */
  wrap(): void {
    this.commit(true);
    this.afterHardBreak = false;
  }

  /** A forced break (preserved \n or <br>); an empty line still stands at `lineHeight`. */
  forcedBreak(lineHeight: number): void {
    if (this.line.items.length === 0) {
      this.line.lineHeight = Math.max(this.line.lineHeight, lineHeight);
      this.line.endedByHardBreak = true;
      this.lines.push(this.line);
      this.line = this.newLine();
    } else {
      this.line.endedByHardBreak = true;
      this.commit();
    }
    this.afterHardBreak = true;
  }
}

/**
 * The visible '-' a soft-hyphen break draws, in the broken word's own
 * measuring state.
 */
function softHyphenAdvance(m: Measurer, style: ResolvedStyle): number {
  return m.width(m.stateOf(style), '-');
}

/** Item `i`'s demand on its line's height. */
function itemLineHeight(flow: LineFlow, i: number): number {
  const refs = flow.items.refs(i);
  let lineHeight = flow.m.lineHeight(refs.style, flow.useBulletProbe);
  // Inline-block elements expand line height with their vertical padding+margin
  const inlineBlockLayout = flow.items.inlineBlockLayout(i);
  if (inlineBlockLayout) {
    lineHeight = Math.max(lineHeight, inlineBlockLayout.marginBoxHeight);
  } else if (refs.boxStyle && refs.boxStyle.display === 'inline-block') {
    // Clamped at 0: negative margins shrink the margin box, but the original
    // `Math.max(h, h + extra)` never let them shrink the LINE, and nothing
    // here is measuring a case that says they should.
    const extra = inlineBlockExtra(refs.boxStyle);
    lineHeight += Math.max(0, extra.top + extra.bottom);
  }
  return lineHeight;
}

/**
 * Flow prepared segments into lines that fit within contentWidth — the ONE
 * line breaker: the real layout runs it at the used width, min-content at 0
 * (every soft-wrap opportunity taken) and max-content at Infinity (forced
 * breaks only).
 *
 * Phases, each the one home of its rules: break classification
 * (`breakBefore`), glue (`gluedRunWidth`, `trailingGlueWidth`,
 * `headGlueWidth`), splitting (`splitSegment`), words across run boundaries
 * (`breakGluedChain`), the fit decision (`placePiece`, `knifeEdgeOverflows`) and
 * line commit (`LineFlow`).
 */
function flowLines(
  session: LayoutSession,
  items: FlowItems,
  contentWidth: number,
  whiteSpace: string,
  useBulletProbe = false,
  textIndent = 0,
  tabMetrics?: TabStops,
  strutLineHeight = 0,
): FlowLine[] {
  const flow = new LineFlow(
    session, items, contentWidth, whiteSpace, useBulletProbe, textIndent, tabMetrics, strutLineHeight);
  const count = items.prepared.count;
  for (let i = 0; i < count; i++) {
    const lineHeight = itemLineHeight(flow, i);
    if (items.flags(i) & SEG_HARD_BREAK) {
      flow.forcedBreak(lineHeight);
      continue;
    }
    // No wrapping mode — everything on one line
    if (flow.noWrap) {
      flow.place(i, items.width(i), lineHeight);
      continue;
    }
    const chainEnd = gluedChainEnd(items, i);
    if (chainEnd > i && breakGluedChain(flow, i, chainEnd)) {
      i = chainEnd;
      continue;
    }
    placeSegment(flow, i, lineHeight);
  }
  flow.commit();
  return flow.lines;
}

/**
 * The last segment of the glued chain that starts at segment `start`, or
 * `start` when none does: one word split across adjacent inline runs (e.g.
 * <span>E</span>xperience, a font-size change mid-word, or
 * <span>wel</span>l-being), its pieces after the first each continuing it
 * (`breakBefore` → `'continues'`).
 */
function gluedChainEnd(items: FlowItems, start: number): number {
  const cls = breakBefore(items, start);
  if (cls === 'space' || cls === 'continues' || !items.text(start)) return start;
  const refs = items.refs(start);
  if (refs.boxOpen || refs.boxClose) return start;
  const count = items.prepared.count;
  let end = start;
  while (end + 1 < count && breakBefore(items, end + 1) === 'continues') end++;
  return end;
}

/**
 * Breaking a word that is split across a run boundary (`gluedChainEnd`).
 * Per-segment break logic can't see the whole word, so its internal break
 * opportunities — hyphens, and break-word char points — are lost and the
 * unit overflows the edge. Break the chain `start..end` across the run
 * boundaries like the browser. False when the chain needs no breaking here:
 * the caller then flows `start` as an ordinary segment.
 */
function breakGluedChain(flow: LineFlow, start: number, end: number): boolean {
  const { items, m } = flow;
  const startStyle = items.refs(start).style;
  const breakWord = startStyle.overflowWrap === 'break-word' || startStyle.wordBreak === 'break-all';
  let combined = 0;
  for (let j = start; j <= end; j++) combined += items.width(j);
  // Flatten the chain into characters, each with its segment's refs
  // (per-run style retained). The refs carry the run's clip/stroke-image
  // declarer too, else a break-word split drops it and a gradient/stroke
  // fragment paints nothing (the inherited transparent fill has no clip
  // box to reveal). `parentStyle` rides along for the same reason:
  // dropping it made a split `vertical-align` run measure its shift
  // against the block instead of its real parent, 8px out on a narrow
  // break-word line.
  type Cell = { ch: string; refs: SegmentRefs };
  const cells: Cell[] = [];
  for (let j = start; j <= end; j++) {
    const refs = items.refs(j);
    for (const ch of items.text(j)) cells.push({ ch, refs });
  }
  const combinedText = cells.map((c) => c.ch).join('');
  // Hyphen break opportunities (same rule as the single-word hyphen path).
  const segTexts: string[] = [];
  if (combinedText) forEachHyphenPiece(combinedText, 0, combinedText.length, (p) => segTexts.push(p));
  const hyphenMode = segTexts.length > 1;
  const fitsLine = flow.line.totalWidth + combined <= flow.budget();
  // A hyphen is an ordinary break opportunity — intervene whenever the
  // unit doesn't fit the remaining space. break-word is last-resort —
  // only when the unit can't fit a full line at all (otherwise the normal
  // flow + glued-tail fit check correctly wraps it whole to a fresh line).
  const enter = !fitsLine && (hyphenMode || (breakWord && combined > flow.budget()));
  if (!enter) return false;

  // Atomic units for breaking: hyphen segments, else the whole chain.
  const segs: Cell[][] = [];
  let ci = 0;
  for (const st of segTexts) {
    const len = [...st].length;
    segs.push(cells.slice(ci, ci + len));
    ci += len;
  }
  // Place a segment's cells onto the current line, splitting same-style
  // runs into pieces. When `chars` is set, wrap at the line edge between
  // characters (break-word); otherwise place atomically (it may overflow
  // its own line, e.g. a hyphen prefix wider than the container).
  const placeCells = (cs: Cell[], chars: boolean) => {
    let i = 0;
    while (i < cs.length) {
      // The declarers are 1:1 with the style run (same source
      // segment), so the refs at the run start cover every piece below.
      const refs = cs[i].refs;
      const st = refs.style;
      const state = m.stateOf(st);
      const lh = m.lineHeight(st, flow.useBulletProbe);
      let cur = '';
      let curW = 0;
      while (i < cs.length && cs[i].refs.style === st) {
        const ch = cs[i].ch;
        const candW = m.width(state, cur + ch);
        if (chars && flow.line.totalWidth + candW > flow.budget() &&
            (flow.line.items.length > 0 || cur)) {
          if (cur) flow.place(items.textOf(refs, cur, curW), curW, lh);
          flow.wrap();
          cur = ch;
          curW = m.width(state, ch);
        } else {
          cur += ch;
          curW = candW;
        }
        i++;
      }
      if (cur) {
        flow.place(items.textOf(refs, cur, curW), curW, lh);
        flow.afterHardBreak = false;
      }
    }
  };
  const measureSeg = (cs: Cell[]) => {
    let w = 0;
    let i = 0;
    while (i < cs.length) {
      const st = cs[i].refs.style;
      let txt = '';
      while (i < cs.length && cs[i].refs.style === st) { txt += cs[i].ch; i++; }
      w += m.width(m.stateOf(st), txt);
    }
    return w;
  };
  // Pure break-word (no hyphen) is last-resort: move the whole word to a
  // fresh line first (using the preceding space), then break it there.
  if (!hyphenMode && flow.line.items.length > 0) flow.wrap();
  for (const seg of segs) {
    const segW = measureSeg(seg);
    if (flow.line.items.length > 0 && flow.line.totalWidth + segW > flow.budget()) flow.wrap();
    // Char-break a segment only when break-word and it can't fit a line.
    placeCells(seg, breakWord && segW > flow.budget());
  }
  return true;
}

/**
 * Flow one segment: cut it into pieces when it breaks per character or
 * cluster (`splitSegment` — CJK, emoji, break-word), then place each piece.
 */
function placeSegment(flow: LineFlow, segment: number, lineHeight: number): void {
  const items = flow.items;
  // The pieces are a run of consecutive items: the segment itself, or what
  // it was cut into.
  let pieceStart = segment;
  let pieceEnd = segment + 1;
  let emergency = false;
  if (!flow.isSpace(segment) && items.text(segment).length > 1) {
    const split = splitSegment(flow.session, items, segment, flow.budget());
    if (split) {
      emergency = split.emergency;
      for (let k = 0; k < split.texts.length; k++) {
        const piece = items.cut(segment, split.texts[k], split.widths[k]);
        if (k === 0) pieceStart = piece;
        pieceEnd = piece + 1;
      }
      if (split.texts.length === 0) pieceEnd = pieceStart;
    }
  }

  // An emergency break is one taken inside a word that cannot fit on a fresh
  // line. Native layout first takes the ordinary whitespace opportunity
  // before that word; it does not pack the first emergency fragment into
  // space left by the preceding word. Every other kind of split — CJK,
  // emoji, hyphens, break-all — is a normal opportunity and fills first.
  if (emergency && flow.holds(SEG_SPACE, 0)) flow.wrap();

  const gluedTailWidth = gluedRunWidth(items, segment + 1);
  for (let piece = pieceStart; piece < pieceEnd; piece++) {
    placePiece(flow, segment, piece, pieceStart, pieceEnd, gluedTailWidth, lineHeight);
  }
}

/**
 * The fit decision for one piece of `segment`: wrap first when it, and
 * everything that must share its line (`trailingGlueWidth`,
 * `headGlueWidth`, a soft hyphen's '-'), overflows — unless no line may
 * start at it (`breakBefore`) — then place it.
 */
function placePiece(
  flow: LineFlow, segment: number, piece: number, pieceStart: number, pieceEnd: number,
  gluedTailWidth: number, lineHeight: number,
): void {
  const { items, m, session } = flow;
  const pieceFlags = items.flags(piece);
  const isLastPiece = piece === pieceEnd - 1;
  const tail = trailingGlueWidth(items, piece, pieceEnd, gluedTailWidth);
  // Trailing punctuation (e.g. comma after </span>), a closing box edge and
  // a word continuation across a run boundary do not wrap independently —
  // browsers keep them with the preceding word, unless a space separates
  // them.
  const glued = cannotStartLine(breakBefore(items, piece, piece !== pieceStart)) &&
    flow.line.items.length > 0 && !flow.endsWithSpace();
  const headExtra = headGlueWidth(flow, segment, piece, isLastPiece, gluedTailWidth);

  // A soft-hyphen break point draws a visible '-' when the line breaks
  // right after this piece. Chrome only allows a break there if the prefix
  // PLUS the hyphen fits, so reserve the hyphen advance in the overflow
  // test — otherwise we pack one extra segment and the appended hyphen
  // overflows the line (breaking one segment later than the browser).
  let shReserve = 0;
  if (pieceFlags & SEG_SOFT_HYPHEN) {
    shReserve = softHyphenAdvance(m, items.refs(piece).style);
  }

  const pieceWidth = items.width(piece);
  const candidateLineWidth = flow.line.totalWidth + pieceWidth +
    shReserve + tail + headExtra;

  // Would this piece overflow?
  if (!(pieceFlags & SEG_SPACE) && !glued && flow.line.items.length > 0) {
    const overflow = candidateLineWidth - flow.budget();
    // Under 1px over, the summed advances may be wrong: re-measure.
    if (overflow > 0 && (overflow >= 1 || knifeEdgeOverflows(flow, piece, tail, headExtra))) {
      if (session.debug) {
        const lineText = flow.text();
        const pieceText = items.debugText(piece);
        session.debug({
          type: 'line-wrap',
          message: `"${pieceText}" overflow=${overflow.toFixed(2)} wrap=true lineWidth=${flow.line.totalWidth.toFixed(2)} pieceWidth=${pieceWidth.toFixed(2)} contentWidth=${flow.contentWidth}  line="${lineText}"`,
          data: { text: pieceText, overflow, lineWidth: flow.line.totalWidth, pieceWidth, contentWidth: flow.contentWidth, lineText },
        });
      }
      flow.wrap();
    }
  }

  // Skip leading spaces at the start of a line. Preserving modes
  // (pre/pre-wrap/break-spaces) keep them after hard breaks; collapsing
  // modes (normal/nowrap/pre-line) drop them in all cases.
  if ((pieceFlags & SEG_SPACE) && flow.line.items.length === 0
      && (!flow.afterHardBreak || !flow.preservesWhitespace)) return;

  if (pieceFlags & SEG_TAB) {
    flow.placeTab(piece, lineHeight);
  } else {
    flow.place(piece, pieceWidth, lineHeight);
  }
  if (!(pieceFlags & SEG_SPACE)) flow.afterHardBreak = false;
}

/**
 * Whether the current line plus `piece`, whose summed advances overflow the
 * budget by under 1px, really overflows. The knife-edge rule lives here.
 *
 * Word-by-word delta accumulation may not be what one string measures.
 * Re-measure the full candidate line as a single string and let that
 * decide. Only works for lines whose glyphs share one measuring state;
 * any other line trusts the sum.
 *
 * Over the edge only. A sum UNDER the edge is trusted: re-measuring in
 * both directions moved wraps both ways across the 1px sweeps — the
 * one string drops the last glyph's kern against the space after it,
 * which Blink keeps (the space hangs). Modelling the line ends is
 * fidelity work, not this.
 */
function knifeEdgeOverflows(flow: LineFlow, piece: number, tail: number, headExtra: number): boolean {
  const { items, m } = flow;
  // A preserved tab's advance is position-dependent (tab stops), but
  // measureText('\t') reports a flat control advance — the one-string
  // re-measure would under-count the line by most of a tab stop and
  // falsely keep the overflowing word. Cumulative widths already carry
  // the true tab advance, so trust them on tab lines. (The piece itself
  // is never a tab here: tabs are spaces, and the fit test requires
  // a non-space piece.)
  if (flow.holds(SEG_TAB, SEG_TAB)) return true;
  const lineState = lineMeasureState(m, items, flow.line.items, piece);
  if (lineState === 'mixed') return true;
  // Re-measured under the state every glyph on it shares — ALL of it.
  // Setting only the font measured with the letter-spacing of
  // whichever run came last, and kept lines that overflow.
  const state = lineState ?? m.stateOf(items.refs(piece).style);
  // Empty-text items carry non-glyph advance (inline padding/border
  // markers) that the measured text misses, and an
  // atomic inline-block is a box whose width no string measures —
  // add them back so padded inline spans aren't under-measured. A
  // space set in ANOTHER state (`<b style="font-size:.7em"> </b>`)
  // keeps its own width too: at the line's size it reads wider than
  // it is. The text either side of it is measured as separate strings.
  let textWidth = 0;
  let markerWidth = 0;
  let text = '';
  const lineItems = flow.line.items;
  for (let k = 0; k <= lineItems.length; k++) {
    const i = k < lineItems.length ? lineItems[k] : piece;
    const itemText = items.text(i);
    if (!itemText || items.refs(i).inlineBlock) {
      markerWidth += items.width(i);
    } else if (flow.isSpace(i) && m.stateOf(items.refs(i).style) !== state) {
      if (text) textWidth += m.width(state, text);
      text = '';
      markerWidth += items.width(i);
    } else {
      text += itemText;
      if (flow.isSpace(i)) markerWidth += items.refs(i).style.wordSpacing;
    }
  }
  if (items.flags(piece) & SEG_SOFT_HYPHEN) text += '-';
  if (text) textWidth += m.width(state, text);
  const fullWidth = textWidth + markerWidth + tail + headExtra;
  // Allow only a hair of sub-pixel overflow. A broader tolerance fixes
  // isolated knife-edges but packs extra words in ordinary paragraphs.
  return fullWidth > flow.budget() + 0.02;
}

/**
 * The widest line of a flow — what an intrinsic size is. The first line
 * stands `textIndent` further in (the flow narrowed its budget by it, but
 * its `totalWidth` is the content alone).
 */
function widestLine(lines: readonly FlowLine[], textIndent: number): number {
  return lines.reduce(
    (widest, line, index) => Math.max(widest, index === 0 ? line.totalWidth + textIndent : line.totalWidth), 0);
}

/**
 * Shared line budget for `-webkit-line-clamp` on a block container whose
 * text lives in block descendants (Chrome legacy `-webkit-box` semantics:
 * line boxes are counted across ALL descendants; the Nth line gets an
 * ellipsis and everything after it is dropped). Created in layoutBlock at
 * the clamped element and threaded through descendant layout calls.
 *
 * Known limitation: when the budget runs out exactly at a paragraph
 * boundary (Nth line is a paragraph's last line), following content is
 * dropped but the already-emitted Nth line gets no ellipsis — its layout
 * nodes were positioned before we learned more content follows.
 */
interface LineClampState {
  /** Line boxes still allowed before the cut. */
  remaining: number;
  /** Truncation point reached — all subsequent content is dropped. */
  exhausted: boolean;
}

/**
 * The final flow's widths for the segments preparing could not size
 * (`PreparedInline.inlineBlocks`, `.percentEdges`), at `containingWidth`,
 * the used width of the line's containing block — and each inline-block laid
 * out at its width: its box takes its own width or shrinks to fit its content
 * (`inlineBlockContentWidth`), its content's percentages resolve against that
 * content box, and the emit pass draws what it laid out. Undefined when every
 * prepared width stands.
 */
function usedSegmentWidths(
  session: LayoutSession,
  prepared: PreparedInline,
  containingWidth: number,
  useBulletProbe: boolean,
): { widths: number[]; layouts: Map<number, InlineBlockLayout> | undefined } | undefined {
  if (prepared.inlineBlocks.length === 0 && prepared.percentEdges.length === 0) return undefined;
  const widths = prepared.width.slice();
  for (const i of prepared.percentEdges) {
    const refs = prepared.refs[prepared.ref[i]];
    widths[i] = refs.boxOpen
      ? refs.boxOpen.paddingLeft + refs.boxOpen.borderLeftWidth
      : refs.boxClose!.paddingRight + refs.boxClose!.borderRightWidth;
  }
  let layouts: Map<number, InlineBlockLayout> | undefined;
  for (const i of prepared.inlineBlocks) {
    const source = prepared.refs[prepared.ref[i]].inlineBlock!;
    const s = source.style;
    const margins = horizontalMargins(s);
    const frame = horizontalFrame(s);
    const contentWidth = inlineBlockContentWidth(
      session, source, s, Math.max(0, containingWidth - margins - frame));
    // The source node IS the inner root: the inline formatting context reads
    // only font, whiteSpace, direction, text-align/indent and line-clamp off
    // it. Its box properties are applied here, by the caller, so there is
    // nothing to zero out first.
    resolvePercentages(s, contentWidth, true);
    resolveChildPercentages(source, contentWidth);
    const inner = layoutInlineContent(session, source, 0, 0, contentWidth, useBulletProbe);
    const contentHeight = inner.height || session.measurer.lineHeight(s, useBulletProbe);
    const lastBaseline = inner.lines.at(-1)?.y ??
      session.measurer.leadedBox(s, useBulletProbe).ascent;
    const extra = inlineBlockExtra(s);
    const baselineOffset = extra.top + lastBaseline;
    const marginBoxHeight = extra.top + contentHeight + extra.bottom;
    widths[i] = margins + frame + contentWidth;
    (layouts ??= new Map()).set(i, {
      nodes: inner.nodes,
      lines: inner.lines,
      lineBoxes: inner.lineBoxes,
      contentWidth,
      contentHeight,
      baselineOffset,
      marginBoxHeight,
    });
  }
  return { widths, layouts };
}

/**
 * Re-resolve the percentages of `node`'s children against `cbWidth`, their
 * containing block's width as layout settled it (`resolvePercentages`) —
 * before anything reads them. Inline boxes pass the block's width through to
 * their own children; a block or an inline-block resolves its children when
 * it is laid out. A text node shares its parent's style and is skipped.
 */
function resolveChildPercentages(node: StyledNode, cbWidth: number): void {
  for (const child of node.children) {
    if (child.tagName === '#text') continue;
    resolvePercentages(child.style, cbWidth);
    const display = child.style.display;
    if (display === 'inline' || display === 'contents') resolveChildPercentages(child, cbWidth);
  }
}

// ─── Bidi reordering ───────────────────────────────────────────────────

/**
 * Per committed line, per word, the word's UAX #9 levels after L1 (`null` for
 * a padding marker) — or `null` for a line that needs no reordering. `null`
 * overall for a paragraph with nothing right-to-left in it, which costs one
 * scan: every plain LTR paragraph keeps its word-by-word emission untouched.
 *
 * Levels are resolved over the WHOLE paragraph, not per line: a neutral at a
 * line end, or a number after a wrapped Arabic word (W2/W7), takes its type
 * from text on another line. A forced break separates paragraphs; an atomic
 * inline is one U+FFFC (CSS Writing Modes 3 §2.4.2).
 */
function resolveLineBidi(
  lines: PositionedLine[], rtl: boolean,
): Array<Array<Uint8Array | null> | null> | null {
  let needed = rtl;
  for (let i = 0; !needed && i < lines.length; i++) {
    for (const w of lines[i].words) {
      let rtlContext = false;
      for (let c = w.bidi; c && !rtlContext; c = c.parent) rtlContext = mayNeedBidi(c.open);
      if (rtlContext || mayNeedBidi(w.text)) { needed = true; break; }
    }
  }
  if (!needed) return null;

  const builder = new BidiTextBuilder();
  const starts = lines.map((line) => {
    const at = line.words.map((w) => w.text === ''
      ? -1
      : builder.push(isAtomicInlineBlock(w) ? '\uFFFC' : w.text, w.bidi ?? null));
    if (line.endedByHardBreak) builder.paragraphBreak();
    return at;
  });
  builder.enter(null);
  const par = resolveBidi(builder.text, rtl ? 1 : 0);

  return lines.map((line, li) => {
    const at = starts[li];
    const lengthOf = (k: number) => isAtomicInlineBlock(line.words[k]) ? 1 : line.words[k].text.length;
    let first = -1;
    let end = -1;
    at.forEach((start, k) => {
      if (start < 0) return;
      if (first < 0) first = start;
      end = start + lengthOf(k);
    });
    if (first < 0) return null;
    const levels = lineLevels(par, first, end);
    if (!rtl && levels.every((level) => level === 0)) return null;
    return at.map((start, k) => start < 0
      ? null
      : levels.subarray(start - first, start - first + lengthOf(k)));
  });
}

/** `style` with `direction` set; one shared copy per style, so pieces of a run batch by identity. */
const directionCopies = {
  ltr: new WeakMap<ResolvedStyle, ResolvedStyle>(),
  rtl: new WeakMap<ResolvedStyle, ResolvedStyle>(),
};
function withDirection(style: ResolvedStyle, direction: 'ltr' | 'rtl'): ResolvedStyle {
  if (style.direction === direction) return style;
  let copy = directionCopies[direction].get(style);
  if (!copy) {
    copy = { ...style, direction };
    directionCopies[direction].set(style, copy);
  }
  return copy;
}

/** Can two visually adjacent pieces of one level paint as ONE fillText? */
function sameBidiRun(a: Word, b: Word): boolean {
  if (a.boxStyle !== b.boxStyle || a.clipStyle !== b.clipStyle ||
    a.strokeImageStyle !== b.strokeImageStyle || a.parentStyle !== b.parentStyle) return false;
  const p = a.style;
  const q = b.style;
  return p === q || (sameTextStyle(p, q) &&
    p.letterSpacing === q.letterSpacing && p.wordSpacing === q.wordSpacing &&
    p.verticalAlign === q.verticalAlign && p.textShadow === q.textShadow &&
    p.webkitTextStrokeWidth === q.webkitTextStrokeWidth &&
    p.webkitTextStrokeColor === q.webkitTextStrokeColor);
}

/**
 * A line in ONE paint (style, box, declarers and bidi context all shared; no
 * padding, atomic inline, tab or justification) as a single run in the
 * paragraph direction — the engine's Canvas then shapes the whole line as its
 * layout does (`CANVAS_BIDI_LINE`). Only when Canvas, resolving the line's
 * text on its own, reaches the levels the paragraph gave it: a line whose
 * neutrals or numbers take their type from another line (W2/W7, N1 across a
 * soft wrap) goes through the ordered runs instead. `null` otherwise.
 */
function singlePaintLine(
  words: Word[],
  wordLevels: Array<Uint8Array | null>,
  paragraphLevel: 0 | 1,
  justifying: boolean,
): { words: Word[]; levels: number[]; keys: number[] } | null {
  if (words.length === 0 || justifying) return null;
  const first = words[0];
  for (const w of words) {
    if (w.text === '' || w.isTab || isAtomicInlineBlock(w) || w.inlineBlockLayout ||
      w.bidi !== first.bidi || !sameBidiRun(first, w)) return null;
  }
  const text = words.map((w) => w.text).join('');
  const own = resolveBidi(text, paragraphLevel);
  const ownLevels = lineLevels(own, 0, text.length);
  let at = 0;
  for (let k = 0; k < words.length; k++) {
    const lv = wordLevels[k]!;
    for (let i = 0; i < lv.length; i++) if (lv[i] !== ownLevels[at + i]) return null;
    at += lv.length;
  }
  return {
    words: [{ ...first, text, width: words.reduce((sum, w) => sum + w.width, 0), isSpace: false }],
    levels: [paragraphLevel],
    keys: [0],
  };
}

/**
 * One line's words as level-uniform pieces in VISUAL order (UAX #9 L2), each
 * with its level.
 *
 * - A word whose characters resolve to different levels (`abc:` before RTL
 *   text, `(123)` in Arabic) is cut where the level changes; the pieces share
 *   the word's flow width in proportion to their own measure.
 * - Padding markers are not characters: content is reordered without them,
 *   then each box's open marker (it carries padding-LEFT) goes before the
 *   visually leftmost piece of that box and its close marker after the
 *   rightmost — the physical edges, whatever the box's content direction.
 * - Visually adjacent pieces of one non-zero level and one paint merge into a
 *   single run (one fillText, so Canvas shapes and kerns it as the engine
 *   does); its logical text is its pieces right to left at an odd level, and
 *   its width the sum of their flow advances. Level-0 (LTR paragraph) words
 *   are never merged, so LTR stays word-granular.
 * - `keys` give each output piece its logical position (the first item it
 *   holds), so the caller can emit nodes in document order.
 */
function bidiLineItems(
  m: Measurer,
  words: Word[],
  wordLevels: Array<Uint8Array | null>,
  paragraphLevel: 0 | 1,
  justifying: boolean,
): { words: Word[]; levels: number[]; keys: number[] } {
  const single = CANVAS_BIDI_LINE && singlePaintLine(words, wordLevels, paragraphLevel, justifying);
  if (single) return single;

  const items: Word[] = [];
  const levels: number[] = [];
  words.forEach((word, k) => {
    const lv = wordLevels[k];
    if (!lv) {
      items.push(word);
      levels.push(-1); // a marker: resolved below
      return;
    }
    let start = 0;
    const cuts: Array<[number, number]> = [];
    for (let i = 1; i <= lv.length; i++) {
      if (i === lv.length || lv[i] !== lv[start]) {
        cuts.push([start, i]);
        start = i;
      }
    }
    if (cuts.length === 1 || isAtomicInlineBlock(word)) {
      items.push(word);
      levels.push(lv[0]);
      return;
    }
    const state = m.stateOf(word.style);
    const measured = cuts.map(([a, b]) => m.width(state, word.text.slice(a, b)));
    const sum = measured.reduce((x, y) => x + y, 0);
    cuts.forEach(([a, b], i) => {
      items.push({
        ...word,
        text: word.text.slice(a, b),
        width: sum > 0 ? word.width * measured[i] / sum : 0,
      });
      levels.push(lv[a]);
    });
  });

  // Content in visual order; padding markers are put back afterwards at the
  // VISUAL edges of their box's content. A marker is not a character, and
  // letting it ride on a neighbour's level moved it inside the box whenever a
  // deeper level was reversed (`<code>render()</code>` in Arabic: the open
  // padding landed between "()" and "render").
  const content: number[] = [];
  items.forEach((_, i) => { if (levels[i] >= 0) content.push(i); });
  const order = visualOrder(content.map((i) => levels[i]));
  const visualPos = new Map<number, number>(); // item index → visual slot
  order.forEach((k, v) => visualPos.set(content[k], v));
  const before: number[][] = order.map(() => []);
  const after: number[][] = order.map(() => []);
  const trailing: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (levels[i] >= 0) continue;
    const marker = items[i];
    const closing = !!marker.boxClose && !marker.boxOpen;
    // The box's content on this line: between the marker and its partner
    // (or the line edge when the partner is on another line).
    let from = i + 1;
    let to = items.length;
    if (closing) {
      from = 0;
      to = i;
      for (let j = i - 1; j >= 0; j--) {
        if (levels[j] < 0 && items[j].boxOpen === marker.boxClose && !items[j].boxClose) { from = j + 1; break; }
      }
    } else if (marker.boxOpen) {
      for (let j = i + 1; j < items.length; j++) {
        if (levels[j] < 0 && items[j].boxClose === marker.boxOpen && !items[j].boxOpen) { to = j; break; }
      }
    } else {
      to = from + 1; // an inline-block's margin: it belongs to the next item
    }
    const slots: number[] = [];
    for (let j = from; j < to; j++) {
      const v = visualPos.get(j);
      if (v !== undefined) slots.push(v);
    }
    if (slots.length > 0) {
      if (closing) after[Math.max(...slots)].push(i);
      else before[Math.min(...slots)].push(i);
      continue;
    }
    // An empty box: stay beside the logically nearest content.
    let near: number | undefined;
    for (let j = i + 1; near === undefined && j < items.length; j++) near = visualPos.get(j);
    if (near !== undefined) before[near].push(i);
    else {
      for (let j = i - 1; near === undefined && j >= 0; j--) near = visualPos.get(j);
      if (near !== undefined) after[near].push(i);
      else trailing.push(i);
    }
  }
  // Item indices (logical order) in visual order.
  const sequence: number[] = [];
  order.forEach((k, v) => sequence.push(...before[v], content[k], ...after[v]));
  sequence.push(...trailing);
  const visual = sequence.map((i) => items[i]);
  const visualLevels = sequence.map((i) => levels[i] >= 0 ? levels[i] : paragraphLevel);

  const mergeable = (w: Word) => w.text !== '' && !w.isTab && !isAtomicInlineBlock(w) &&
    !(justifying && w.isSpace);
  const outWords: Word[] = [];
  const outLevels: number[] = [];
  const outKeys: number[] = [];
  for (let i = 0; i < visual.length;) {
    const level = visualLevels[i];
    let j = i + 1;
    if (level > 0 && mergeable(visual[i])) {
      while (j < visual.length && visualLevels[j] === level && mergeable(visual[j]) &&
        sameBidiRun(visual[i], visual[j])) j++;
    }
    if (j === i + 1) {
      outWords.push(visual[i]);
    } else {
      const run = visual.slice(i, j);
      if (level % 2) run.reverse(); // back to logical order
      outWords.push({
        ...run[0],
        text: run.map((w) => w.text).join(''),
        // The flow's own advances, not a fresh measure of the joined text:
        // they were taken with the text before them as context (kerning,
        // and the font a fallback-script space resolves to), so the run
        // ends where the wrap decision and the DOM put it.
        width: run.reduce((sum, w) => sum + w.width, 0),
        isSpace: run.every((w) => w.isSpace),
      });
    }
    outLevels.push(level);
    outKeys.push(Math.min(...sequence.slice(i, j)));
    i = j;
  }
  return { words: outWords, levels: outLevels, keys: outKeys };
}

/**
 * What laying out one inline formatting context produces, and what every
 * line of it shares. `layoutInlineContent` makes one; the per-line phases
 * (`emitLine` and what it calls) append to it.
 */
interface InlineEmit {
  readonly session: LayoutSession;
  readonly m: Measurer;
  readonly useBulletProbe: boolean;
  /**
   * The block's style. The block strut also participates in the line's
   * baseline, not just its height: inline content aligns to the block-font
   * baseline, so a line whose only content is a SMALLER inline font sits on
   * the strut baseline (lower in the box), not centered in it. Each line's
   * ascent/descent is seeded with the block font's metrics so the baseline
   * lands where the DOM puts it. The block is also the parent of any run
   * with no inline ancestor.
   */
  readonly blockStyle: ResolvedStyle;
  readonly x: number;
  readonly contentWidth: number;
  readonly textIndent: number;
  readonly isRTL: boolean;
  /** Physical alignment (start/end resolved) of ordinary lines… */
  readonly textAlign: string;
  /** …and of the last line and lines ending at a forced break. */
  readonly textAlignLast: string;
  readonly nodes: LayoutNode[];
  readonly lines: LayoutLine[];
  readonly lineBoxes: LayoutLineBox[];
  /**
   * Text nodes covered by an inline element declaring background-clip:text
   * (clipRuns) or --rt-text-stroke-image (strokeImageRuns), mapped to that
   * declaring element's style. A post-pass turns each per-line run of
   * same-declarer nodes into a fragment-spanning paint box.
   */
  readonly clipRuns: Map<LayoutText, ResolvedStyle>;
  readonly strokeImageRuns: Map<LayoutText, ResolvedStyle>;
}

/**
 * Layout inline content: text wrapping + positioning using pure canvas measurement.
 * Returns layout nodes and the total height consumed.
 *
 * Phases: flow (`flowInlineLines`), line clamp (`clampLines`), then per line
 * (`emitLine`) horizontal alignment, the line box (`lineBoxExtent`), bidi
 * reordering, inline backgrounds (`emitInlineBackgrounds`) and text
 * (`emitLineText`); last, the paint fragments (`assignInlineFragmentBoxes`).
 */
function layoutInlineContent(
  session: LayoutSession,
  node: StyledNode,
  x: number,
  y: number,
  contentWidth: number,
  useBulletProbe = false,
  clamp?: LineClampState,
): { nodes: LayoutNode[]; height: number; lines: LayoutLine[]; lineBoxes: LayoutLineBox[] } {
  if (clamp && (clamp.exhausted || clamp.remaining <= 0)) {
    // An ancestor's clamp already used its line budget — drop this content.
    clamp.exhausted = true;
    return { nodes: [], height: 0, lines: [], lineBoxes: [] };
  }
  const prepared = takePreparedInline(session, node);
  if (prepared.runs === 0 && !node.children.some(createsLineBox)) {
    return { nodes: [], height: 0, lines: [], lineBoxes: [] };
  }

  const lines = flowInlineLines(session, node, prepared, contentWidth, useBulletProbe);
  clampLines(session, node.style, lines, contentWidth, clamp);

  const style = node.style;
  const isRTL = style.direction === 'rtl';
  const resolveDir = (a: string) => {
    if (a === 'start') return isRTL ? 'right' : 'left';
    if (a === 'end') return isRTL ? 'left' : 'right';
    return a;
  };
  const textAlign = resolveDir(style.textAlign);
  // text-align-last: 'auto' inherits from text-align except when text-align is
  // 'justify', then defaults to 'start' (CSS Text 3 §7.2).
  let textAlignLast = style.textAlignLast || 'auto';
  if (textAlignLast === 'auto') {
    textAlignLast = style.textAlign === 'justify' ? (isRTL ? 'right' : 'left') : textAlign;
  } else {
    textAlignLast = resolveDir(textAlignLast);
  }
  const out: InlineEmit = {
    session,
    m: session.measurer,
    useBulletProbe,
    blockStyle: style,
    x,
    contentWidth,
    textIndent: style.textIndent || 0,
    isRTL,
    textAlign,
    textAlignLast,
    nodes: [],
    lines: [],
    lineBoxes: [],
    clipRuns: new Map(),
    strokeImageRuns: new Map(),
  };

  const bidiLines = resolveLineBidi(lines, isRTL);
  let curY = y;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    curY += emitLine(out, lines[lineIdx], lineIdx === 0, lineIdx === lines.length - 1,
      bidiLines?.[lineIdx], curY);
  }

  assignInlineFragmentBoxes(session, out.nodes, out.clipRuns, (node, s, box) => {
    node.clip = {
      image: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : undefined,
      color: !isTransparent(s.backgroundColor) ? s.backgroundColor : undefined,
      ...box,
    };
  });
  assignInlineFragmentBoxes(session, out.nodes, out.strokeImageRuns, (node, s, box) => {
    node.strokeImage = { image: s.webkitTextStrokeImage, ...box };
  });

  return { nodes: out.nodes, height: curY - y, lines: out.lines, lineBoxes: out.lineBoxes };
}

/**
 * The final flow of `prepared` at `contentWidth`, its lines materialized for
 * the emit pass: inline-blocks laid out first (their widths are what the
 * flow places), then `flowLines` under the block's indent, tab stops and
 * strut.
 */
function flowInlineLines(
  session: LayoutSession,
  node: StyledNode,
  prepared: PreparedInline,
  contentWidth: number,
  useBulletProbe: boolean,
): PositionedLine[] {
  const m = session.measurer;
  const used = usedSegmentWidths(session, prepared, contentWidth, useBulletProbe);
  const textIndent = node.style.textIndent || 0;
  const tabMetrics = m.tabStops(node.style);
  // The block's own font + line-height set the strut: the minimum height of
  // every line box, even a line holding only smaller inline content.
  const strutLineHeight = m.lineHeight(node.style, useBulletProbe);
  const items = new FlowItems(prepared, prepared.refs, used?.widths, used?.layouts);
  // The emit pass reads each placed item as a `Word`.
  const lines: PositionedLine[] = flowLines(
    session, items, contentWidth, node.style.whiteSpace, useBulletProbe, textIndent, tabMetrics, strutLineHeight,
  ).map((line) => ({
    words: line.items.map((i) => items.word(i)),
    totalWidth: line.totalWidth,
    lineHeight: line.lineHeight,
    endedByHardBreak: line.endedByHardBreak,
  }));
  if (session.stats) for (const line of lines) session.stats.wordObjects += line.words.length;
  // Content with no words can still make a line box (an empty inline with
  // inline-axis padding, an empty inline-block): it stands at the strut.
  if (lines.length === 0 && node.children.some(createsLineBox)) {
    lines.push({ words: [], totalWidth: 0, lineHeight: strutLineHeight });
  }
  return lines;
}

/**
 * `-webkit-line-clamp` / `line-clamp`: truncate to N lines and append a
 * CSS-style ellipsis ("…") to the Nth line, back-trimming trailing words
 * until the ellipsis fits within contentWidth. The budget comes from an
 * ancestor's shared clamp state when one is active (clamp on a block
 * container with block children), else from this element's own style.
 */
function clampLines(
  session: LayoutSession,
  style: ResolvedStyle,
  lines: PositionedLine[],
  contentWidth: number,
  clamp: LineClampState | undefined,
): void {
  const clampN = clamp ? clamp.remaining : style.lineClamp;
  if (clampN > 0 && lines.length > clampN) {
    lines.length = clampN;
    const lastLine = lines[clampN - 1];
    // First line has reduced width because of text-indent; a cut on this
    // element's first line (effective budget of 1) hits it.
    const lineMaxForEllipsis = contentWidth - (clampN === 1 ? (style.textIndent || 0) : 0);
    applyEllipsisToLine(session, lastLine, lineMaxForEllipsis);
    // The ellipsis replaces the original ending. Alignment already treats
    // this as the last visible line; it is not a source hard break.
    lastLine.endedByHardBreak = false;
    if (clamp) {
      clamp.remaining = 0;
      clamp.exhausted = true;
    }
  } else if (clamp) {
    clamp.remaining -= lines.length;
  }
}

/**
 * The left edge of a line `lineMaxWidth` wide (after the first line's
 * indent) under `align`.
 *
 * When the line overflows its container, browsers fall back to start
 * alignment (per CSS Text 3 §7.1) instead of pushing the line outside
 * the box. Common trigger: wide letter-spacing on text that doesn't
 * wrap at letter boundaries (no break-word/break-all), where centering
 * would put glyphs at negative x. Sub-pixel tolerance avoids switching
 * to start for rounding noise on lines that visually fit.
 * Start edge differs by direction. LTR lines start at the left (x+indent).
 * RTL lines are anchored at the right, inset from the content's right edge
 * by text-indent — and lineMaxWidth already subtracts indent, so the RTL
 * right edge is x+lineMaxWidth. `align` here is physically resolved
 * (start/end → left/right), so RTL with align==='left' (explicit left, or
 * end) correctly falls through to left alignment.
 */
function alignedLineStart(
  out: InlineEmit, totalWidth: number, align: string, indent: number, lineMaxWidth: number,
): number {
  const { x, isRTL } = out;
  const overflows = totalWidth > lineMaxWidth + 0.5;
  let curX = x + indent;
  if (overflows) {
    // Overflow fallback: pin to the start edge (CSS Text 3 §7.1).
    curX = isRTL ? x + lineMaxWidth - totalWidth : x + indent;
  } else if (align === 'center') {
    curX = x + indent + (lineMaxWidth - totalWidth) / 2;
  } else if (align === 'right') {
    curX = (isRTL ? x + lineMaxWidth : x + indent + lineMaxWidth) - totalWidth;
  } else if (align === 'justify' && isRTL) {
    // RTL justify: anchor the right edge at the inset start; spaces expand left.
    curX = x + lineMaxWidth - totalWidth;
  }
  return curX;
}

/**
 * Lay out one committed line at `y`: its nodes, its `LayoutLine` and its
 * line box. Returns the line's height.
 */
function emitLine(
  out: InlineEmit,
  line: PositionedLine,
  isFirstLine: boolean,
  isLastLine: boolean,
  wordLevels: Array<Uint8Array | null> | null | undefined,
  y: number,
): number {
  // Per-line alignment: lines ending at a forced break or the last line
  // use text-align-last; all others use text-align (CSS Text 3 §7.1, §7.2).
  const useLast = isLastLine || line.endedByHardBreak;
  const align = useLast ? out.textAlignLast : out.textAlign;

  // text-indent narrows the first line's available width.
  const indent = isFirstLine ? out.textIndent : 0;
  const lineMaxWidth = out.contentWidth - indent;

  // Justify: expand spaces to fill the line.
  let justifyExtraPerSpace = 0;
  if (align === 'justify' && line.totalWidth < lineMaxWidth) {
    const spaceCount = line.words.filter(w => w.isSpace).length;
    if (spaceCount > 0) {
      justifyExtraPerSpace = (lineMaxWidth - line.totalWidth) / spaceCount;
    }
  }

  // text-align, with first-line indent baked in.
  let curX = alignedLineStart(out, line.totalWidth, align, indent, lineMaxWidth);
  // Snapshot the line's left edge before LTR emission advances curX.
  const lineLeftX = curX;

  if (line.words.length === 0) {
    out.lineBoxes.push({
      x: lineLeftX, y, width: 0, height: line.lineHeight,
      endedByHardBreak: !!line.endedByHardBreak,
    });
    return line.lineHeight;
  }

  // Inline background boxes and text are emitted after baseline computation
  // (below) so that emitInlineBox can use line-level metrics for alignment.
  const extent = lineBoxExtent(out, line.words);
  const lineBoxHeight = extent.ascent + extent.descent;
  const lineBaselineY = y + extent.ascent;

  // Bidi: the line's words cut into level-uniform pieces in VISUAL order
  // (UAX #9 L2), so both passes below walk the line left to right whatever
  // its direction. A plain LTR line keeps its own words.
  let emitWords = line.words;
  let emitLevels: number[] | null = null;
  let emitKeys: number[] | null = null;
  if (wordLevels) {
    ({ words: emitWords, levels: emitLevels, keys: emitKeys } = bidiLineItems(
      out.m, line.words, wordLevels, out.isRTL ? 1 : 0, justifyExtraPerSpace > 0));
    if (out.isRTL) {
      // An RTL line is anchored at its right edge (curX + totalWidth); its
      // pieces may measure a little differently from the words they came from.
      let total = 0;
      for (const w of emitWords) total += w.width + (w.isSpace ? justifyExtraPerSpace : 0);
      curX = curX + line.totalWidth - total;
    }
  }

  // Inline background boxes before text.
  emitInlineBackgrounds(out, emitWords, curX, lineBaselineY, justifyExtraPerSpace);
  emitLineText(out, emitWords, emitLevels, emitKeys, curX, y, lineBaselineY, justifyExtraPerSpace);

  // Emit a public LayoutLine record for this committed line.
  // bounds.width: justified lines fill lineMaxWidth (spaces expanded);
  // others use the measured words width.
  const lineWidth =
    align === 'justify' && justifyExtraPerSpace > 0
      ? lineMaxWidth
      : line.totalWidth;
  const emittedLine: LayoutLine = {
    y: Math.round(lineBaselineY),
    // An inline-block's earlier rows were emitted as their own lines above,
    // so this line carries only its LAST row — every glyph appears once,
    // in order.
    // An inline-block whose content laid out no line (whitespace only) adds
    // nothing: its segment's U+FFFC is line breaking's, never text.
    text: line.words.map((word) =>
      word.inlineBlockLayout?.lines.at(-1)?.text ?? (isAtomicInlineBlock(word) ? '' : word.text)).join(''),
    bounds: {
      x: lineLeftX,
      // The line box starts at y — this is the CSS line box, which
      // `lineBoxExtent` grew to cover every box on the line. Ink can still
      // overflow it (an ascender under `line-height: 1`), exactly as it
      // does in the DOM; a caller that clips must allow for that.
      y,
      width: lineWidth,
      height: lineBoxHeight,
    },
  };
  out.lines.push(emittedLine);
  out.lineBoxes.push({ ...emittedLine.bounds, endedByHardBreak: !!line.endedByHardBreak });
  return lineBoxHeight;
}

/**
 * The line box's ascent and descent above and below its baseline.
 *
 * The line box is the union of every box on it — strut, run, shifted run,
 * inline-block — each carrying its own leading over its own line-height:
 *   lineAscent = max(ascent - shift), lineDescent = max(descent + shift).
 * One font, one line-height and no shift collapse that back to the plain
 * half-leading every single-style line already had.
 */
function lineBoxExtent(out: InlineEmit, words: readonly Word[]): { ascent: number; descent: number } {
  const { m, session, useBulletProbe, blockStyle } = out;
  const strutBox = m.leadedBox(blockStyle, useBulletProbe);
  let lineAscent = strutBox.ascent;
  let lineDescent = strutBox.descent;
  for (const word of words) {
    if (word.text === '') continue;
    // A wrapper element with no text of its own — `<span lh:3><span>x</span>`
    // — never becomes a Word, but it is still a box on the line and still
    // brings its own line-height. Its run children carry it as `parentStyle`,
    // so take it from there, AT ITS OWN SHIFT: added unshifted, a wrapper
    // that carries a vertical-align and direct text enters the union twice
    // at two different places, and the line spans both (measured 60px where
    // the DOM has 40). With the shift it is idempotent — a wrapper with
    // direct text contributes the identical box through its own run.
    // A shift moves the box, not the line's baseline: positive is downward,
    // so it lifts the box's demand on the ascent side and adds to the
    // descent one.
    if (word.parentStyle) {
      const parentBox = m.leadedBox(word.parentStyle, useBulletProbe);
      const shift = verticalAlignShift(
        word.parentStyle.verticalAlign, session, word.parentStyle, blockStyle, useBulletProbe);
      if (parentBox.ascent - shift > lineAscent) lineAscent = parentBox.ascent - shift;
      if (parentBox.descent + shift > lineDescent) lineDescent = parentBox.descent + shift;
    }
    const own = m.leadedBox(word.style, useBulletProbe);
    let ascent = own.ascent;
    let descent = own.descent;
    // An inline-block joins the line as an ATOMIC box: its own content
    // baseline with its margin box stacked around it. It takes the extra
    // space, but no shift — the emit pass puts its content on the line
    // baseline and does not honour vertical-align on it, so shifting the box
    // here would grow the line one way while the paint went the other.
    const atomic = word.boxStyle?.display === 'inline-block' ? word.boxStyle : null;
    if (word.inlineBlockLayout) {
      const ib = word.inlineBlockLayout;
      ascent = ib.baselineOffset;
      descent = ib.marginBoxHeight - ib.baselineOffset;
    } else if (atomic) {
      const extra = inlineBlockExtra(atomic);
      ascent += extra.top;
      descent += extra.bottom;
    }
    const shift = atomic ? 0 : wordBaselineShift(out, word);
    if (ascent - shift > lineAscent) lineAscent = ascent - shift;
    if (descent + shift > lineDescent) lineDescent = descent + shift;
  }
  return { ascent: lineAscent, descent: lineDescent };
}

/** `word`'s vertical-align shift off the line's baseline (0 unless it shifts). */
function wordBaselineShift(out: InlineEmit, word: Word): number {
  const va = word.style.verticalAlign;
  return isShiftedVAlign(va)
    ? verticalAlignShift(va, out.session, word.style, word.parentStyle ?? out.blockStyle, out.useBulletProbe)
    : 0;
}

/**
 * Emit an inline background box hanging off the line's baseline. Uses the
 * line's baseline (not the box's own font) so the box aligns with its text.
 */
function emitInlineBox(
  out: InlineEmit, style: ResolvedStyle, bx: number, bw: number, lineBaselineY: number, textWord?: Word,
): void {
  // The box's OWN font decides its height, not the line's largest. An
  // inline-block's content box is its LINE-HEIGHT, though, not the bare
  // font metrics — measured against Chrome, bare metrics put it at
  // y=6 h=29 where the DOM has y=4 h=33.2.
  const { ascent: boxAscent, descent: boxDescent } =
    style.display === 'inline-block'
      ? out.m.leadedBox(style, out.useBulletProbe)
      : out.m.metrics(style);
  const padTop = style.paddingTop + style.borderTopWidth;
  const padBottom = style.paddingBottom + style.borderBottomWidth;
  const boxHeight = boxAscent + boxDescent + padTop + padBottom;
  // Every inline box hangs off the line's baseline, an inline-block too:
  // its content is emitted on that baseline, so a box pinned to the line
  // TOP instead detached from its own glyphs as soon as something taller
  // shared the line — measured, a background at y 4..33 around text whose
  // baseline was 46.
  let baselineY = lineBaselineY;
  // A vertical-align that moves the glyphs moves their band with them: the
  // shift comes from the SAME call, on the SAME word, as the text emit
  // (`wordBaselineShift`), so box and glyphs cannot drift apart. Computed
  // independently they did — the band painted at the unshifted baseline
  // under super/sub'd text. Inline-block stays put: the emit pass does not
  // honour vertical-align on it (see `lineBoxExtent`).
  if (textWord && style.display !== 'inline-block') {
    if (isShiftedVAlign(textWord.style.verticalAlign)) {
      baselineY += wordBaselineShift(out, textWord);
    }
  }
  const boxY = baselineY - boxAscent - padTop;
  out.nodes.push({
    type: 'box', style, x: bx, y: boxY, width: bw, height: boxHeight,
    tagName: 'span', children: [],
  });
}

/**
 * The line's inline background boxes, left to right from `startX`: one per
 * run of words sharing a box style (emitted only when the run holds text),
 * and one per atomic inline-block.
 */
function emitInlineBackgrounds(
  out: InlineEmit, words: readonly Word[], startX: number, lineBaselineY: number, justifyExtraPerSpace: number,
): void {
  let scanX = startX;
  let boxStartX = scanX;
  let currentBoxStyle: ResolvedStyle | undefined;
  // First text word of the open box group — its presence decides whether
  // the group's band is emitted at all, and its style pair decides where
  // the band's baseline sits (the same pair the text emit shifts by).
  let boxTextWord: Word | undefined;

  for (const word of words) {
    if (word.boxOpen && word.boxClose && word.text) {
      if (currentBoxStyle) {
        if (boxTextWord) emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
        currentBoxStyle = undefined;
        boxTextWord = undefined;
      }
      const s = word.style;
      const boxX = scanX + s.marginLeft;
      if (word.inlineBlockLayout) {
        const ib = word.inlineBlockLayout;
        const boxY = lineBaselineY - ib.baselineOffset + s.marginTop;
        out.nodes.push({
          type: 'box', style: s, x: boxX,
          y: boxY,
          width: s.borderLeftWidth + s.paddingLeft + ib.contentWidth +
            s.paddingRight + s.borderRightWidth,
          height: s.borderTopWidth + s.paddingTop + ib.contentHeight +
            s.paddingBottom + s.borderBottomWidth,
          tagName: 'span', children: [],
          lineBoxes: ib.lineBoxes.map(line => ({
            ...line,
            x: line.x + boxX + s.borderLeftWidth + s.paddingLeft,
            y: line.y + boxY + s.borderTopWidth + s.paddingTop,
          })),
        });
      } else {
        const textWidth = word.width - horizontalMargins(s) - horizontalFrame(s);
        const boxW = s.borderLeftWidth + s.paddingLeft + textWidth +
          s.paddingRight + s.borderRightWidth;
        emitInlineBox(out, s, boxX, boxW, lineBaselineY, word);
      }
      boxTextWord = undefined;
      scanX += word.width;
      continue;
    }

    if (word.boxStyle !== currentBoxStyle) {
      if (currentBoxStyle && boxTextWord) {
        emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
      }
      currentBoxStyle = word.boxStyle;
      boxStartX = scanX;
      boxTextWord = undefined;
    }
    if (word.text && !word.isSpace) boxTextWord ??= word;
    scanX += word.width + (word.isSpace ? justifyExtraPerSpace : 0);
  }
  if (currentBoxStyle && boxTextWord) {
    emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
  }
}

/** Record a text node's line top, run seam and paint declarers for the passes after layout. */
function registerTextNode(out: InlineEmit, node: LayoutText, word: Word, lineTop: number): void {
  out.nodes.push(node);
  runLineTops.set(node, lineTop);
  if (word.runSeam) (node as SeamFlagged)[RUN_SEAM] = true;
  if (word.clipStyle) out.clipRuns.set(node, word.clipStyle);
  if (word.strokeImageStyle) out.strokeImageRuns.set(node, word.strokeImageStyle);
}

/**
 * The line's text nodes, placed left to right from `startX`. A bidi line's
 * nodes are then put back in LOGICAL order (`keys`): layoutRoot keeps
 * document order, as every consumer walking it (and the geometry oracle)
 * expects.
 */
function emitLineText(
  out: InlineEmit,
  words: readonly Word[],
  levels: number[] | null,
  keys: number[] | null,
  startX: number,
  lineTop: number,
  lineBaselineY: number,
  justifyExtraPerSpace: number,
): void {
  const results = out.nodes;
  let curX = startX;
  const textStart = results.length;
  const nodeKeys: number[] = [];
  const keyNodes = (key: number) => {
    while (textStart + nodeKeys.length < results.length) nodeKeys.push(key);
  };
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    if (keys && wordIndex > 0) keyNodes(keys[wordIndex - 1]);
    const word = words[wordIndex];
    if (word.text === '') {
      curX += word.width;
      continue;
    }

    // Atomic inline-block: position text inside the box (after margin + padding)
    if (word.boxOpen && word.boxClose) {
      const s = word.style;
      const textX = curX + s.marginLeft + s.borderLeftWidth + s.paddingLeft;
      if (word.inlineBlockLayout) {
        const ib = word.inlineBlockLayout;
        const contentY = lineBaselineY - ib.baselineOffset + s.marginTop +
          s.borderTopWidth + s.paddingTop;
        emitInlineBlockContent(out, ib, textX, contentY);
        curX += word.width;
        continue;
      }
      const textWidth = out.m.width(out.m.stateOf(word.style), word.text);
      registerTextNode(out, {
        type: 'text',
        text: word.text,
        // An RTL run is anchored at its right edge (renderText's textAlign).
        x: word.style.direction === 'rtl' ? textX + textWidth : textX,
        y: lineBaselineY,
        width: textWidth,
        style: word.style,
      }, word, lineTop);
      curX += word.width;
      continue;
    }

    // Adjust baseline for vertical-align
    let baselineY = lineBaselineY;
    if (isShiftedVAlign(word.style.verticalAlign)) baselineY += wordBaselineShift(out, word);
    const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);
    // A bidi piece paints in its level's direction; an RTL one is anchored
    // at its right edge (renderText's textAlign).
    const rtlPiece = levels !== null && levels[wordIndex] % 2 === 1;

    registerTextNode(out, {
      type: 'text',
      text: word.text,
      x: rtlPiece ? curX + effectiveWidth : curX,
      y: baselineY,
      width: effectiveWidth,
      // Paint direction is the bidi LEVEL's, never the inherited CSS
      // `direction`: `<span style="direction:rtl">` (unicode-bidi: normal)
      // over LTR words reorders nothing, and painting them right-anchored
      // at their left edge drew them a run-width too far left.
      style: withDirection(word.style, rtlPiece ? 'rtl' : 'ltr'),
      // Only when vertical-align moved this run off the line — an
      // underline from an unshifted declarer still hangs off the line.
      ...(baselineY !== lineBaselineY ? { lineBaselineY } : {}),
    }, word, lineTop);

    curX += effectiveWidth;
  }
  if (keys && words.length > 0) {
    keyNodes(keys[words.length - 1]);
    const placed = results.splice(textStart).map((node, i) => ({ node, key: nodeKeys[i] }));
    placed.sort((a, b) => a.key - b.key); // stable: an inline-block keeps its inner order
    for (const { node } of placed) results.push(node);
  }
}

/** Move a laid-out inline node — and everything it carries — by (dx, dy). */
function translateInlineNode(layoutNode: LayoutNode, dx: number, dy: number): void {
  layoutNode.x += dx;
  layoutNode.y += dy;
  if (layoutNode.type === 'text') {
    if (layoutNode.lineBaselineY !== undefined) layoutNode.lineBaselineY += dy;
    const lineTop = runLineTops.get(layoutNode);
    if (lineTop !== undefined) runLineTops.set(layoutNode, lineTop + dy);
    if (layoutNode.clip) {
      layoutNode.clip.x += dx;
      layoutNode.clip.y += dy;
    }
    if (layoutNode.strokeImage) {
      layoutNode.strokeImage.x += dx;
      layoutNode.strokeImage.y += dy;
    }
  } else {
    for (const line of layoutNode.lineBoxes ?? []) {
      line.x += dx;
      line.y += dy;
    }
    for (const child of layoutNode.children) translateInlineNode(child, dx, dy);
  }
}

/**
 * An inline-block's own layout, placed with its content box at
 * (textX, contentY). Its rows before the last become lines of their own; the
 * last row is the text of the outer line it sits on (`emitLine`).
 */
function emitInlineBlockContent(out: InlineEmit, ib: InlineBlockLayout, textX: number, contentY: number): void {
  for (const innerNode of ib.nodes) {
    translateInlineNode(innerNode, textX, contentY);
    out.nodes.push(innerNode);
  }
  for (const innerLine of ib.lines.slice(0, -1)) {
    out.lines.push({
      y: Math.round(innerLine.y + contentY),
      text: innerLine.text,
      bounds: {
        x: innerLine.bounds.x + textX,
        y: innerLine.bounds.y + contentY,
        width: innerLine.bounds.width,
        height: innerLine.bounds.height,
      },
    });
  }
}

/**
 * Give each text run covered by an inline paint declarer (background-clip:text
 * background, --rt-text-stroke-image) a paint box spanning the declaring
 * element's fragment on its line.
 *
 * Browsers paint the declaring element's background over its inline fragment
 * (the run of glyphs it covers on one line) and clip it to the text; with
 * `background-size:100% 100%` the gradient fills that fragment box. Consecutive
 * text nodes sharing the same declaring element (same style object) on the
 * same baseline form one fragment; a wrap to the next line starts a new one
 * (box-decoration-break:clone semantics — Chrome's default `slice` continues
 * the gradient across line fragments; accepted approximation), and unlike a
 * per-run gradient it never restarts per word.
 */
function assignInlineFragmentBoxes(
  session: LayoutSession,
  results: LayoutNode[],
  runs: Map<LayoutText, ResolvedStyle>,
  assign: (
    node: LayoutText,
    declarer: ResolvedStyle,
    box: { x: number; y: number; width: number; height: number },
  ) => void,
): void {
  if (runs.size === 0) return;
  for (let i = 0; i < results.length;) {
    const first = results[i];
    const declarer = first.type === 'text' ? runs.get(first) : undefined;
    if (!declarer) { i++; continue; }
    let j = i;
    let left = Infinity, right = -Infinity;
    while (j < results.length) {
      const n = results[j];
      if (n.type !== 'text' || runs.get(n) !== declarer || n.y !== first.y) break;
      const [l, r] = textEdges(n);
      if (l < left) left = l;
      if (r > right) right = r;
      j++;
    }
    const { ascent, descent } = session.measurer.metrics(declarer);
    const box = {
      x: left,
      y: first.y - ascent,
      width: right - left,
      height: ascent + descent,
    };
    for (let k = i; k < j; k++) assign(results[k] as LayoutText, declarer, box);
    i = j;
  }
}

// ─── Block layout ──────────────────────────────────────────────────────

/**
 * A set of adjoining vertical margins (CSS 2.1 §8.3.1). However many margins
 * collapse together, the result is the largest positive one plus the most
 * negative one — which pairwise folding does not give once three margins of
 * mixed sign meet (10, -5, 20 is 15, not 20).
 */
interface MarginStrut { positive: number; negative: number }

const NO_MARGIN: MarginStrut = { positive: 0, negative: 0 };

function withMargin(strut: MarginStrut, margin: number): MarginStrut {
  return {
    positive: Math.max(strut.positive, margin),
    negative: Math.min(strut.negative, margin),
  };
}

function joinStruts(a: MarginStrut, b: MarginStrut): MarginStrut {
  return {
    positive: Math.max(a.positive, b.positive),
    negative: Math.min(a.negative, b.negative),
  };
}

function strutSize(strut: MarginStrut): number {
  return strut.positive + strut.negative;
}

/**
 * Does this box establish a block formatting context of its own? A BFC root's
 * margins never collapse with its children's. Flex items, table cells and the
 * layout root are BFC roots by position and are told so by their caller.
 */
function establishesBfc(style: ResolvedStyle): boolean {
  const d = style.display;
  if (d !== 'block' && d !== 'list-item') return true; // flex, table, flow-root, ...
  // `overflow` (either axis) other than visible/clip. Private resolver fields.
  const { [OVERFLOW_X]: x, [OVERFLOW_Y]: y } = style as { [OVERFLOW_X]?: string; [OVERFLOW_Y]?: string };
  const scrolls = (v: string | undefined) => v === 'hidden' || v === 'auto' || v === 'scroll';
  return scrolls(x) || scrolls(y);
}

/**
 * Whitespace that collapses away and so produces no line box. A newline that
 * reaches layout is always a forced break — `<br>` becomes a `'\n'` text node,
 * and the resolver already turned source newlines into spaces where they
 * collapse — so it makes a line box.
 */
function isCollapsibleWhitespace(node: StyledNode): boolean {
  if (node.tagName !== '#text') return false;
  const ws = node.style.whiteSpace;
  const text = node.textContent ?? '';
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return text === '';
  return /^[ \t\f]*$/.test(text);
}

/**
 * Does this inline content make a line box? CSS 2.1 §9.4.2: a line box with
 * no text, no preserved white space, no atomic inline and no inline element
 * with a non-zero inline-axis margin, border or padding is treated as zero
 * height — for margin collapsing, as if it did not exist. An empty `<span>`
 * makes none; `<span style="padding:0 3px">` or an empty inline-block does
 * (measured, Chromium and WebKit: a 20px line box).
 */
function createsLineBox(node: StyledNode): boolean {
  if (node.tagName === '#text') return !isCollapsibleWhitespace(node);
  const s = node.style;
  if (s.display !== 'inline') return true; // an atomic inline
  if (s.marginLeft !== 0 || s.marginRight !== 0 || s.paddingLeft !== 0 ||
      s.paddingRight !== 0 || s.borderLeftWidth !== 0 || s.borderRightWidth !== 0) {
    return true;
  }
  return node.children.some(createsLineBox);
}

/** A list item whose marker is painted: the marker is content of its own. */
function hasVisibleMarker(node: StyledNode): boolean {
  return node.style.display === 'list-item' && !!node.listMarker && !node.markerHidden;
}

/** An empty list item still holds a line box: its marker's. */
function hasMarkerLine(node: StyledNode): boolean {
  return hasVisibleMarker(node) && node.children.length === 0;
}

/** A block's top margin adjoins its first in-flow child's. */
function topAdjoinsChildren(style: ResolvedStyle): boolean {
  return !establishesBfc(style) && style.paddingTop === 0 && style.borderTopWidth === 0;
}

/** A block's bottom margin can adjoin its last in-flow child's. */
function bottomAdjoinsChildren(style: ResolvedStyle): boolean {
  return !establishesBfc(style) && style.paddingBottom === 0 &&
    style.borderBottomWidth === 0;
}

/**
 * A block whose top and bottom margins adjoin each other: no line box, no
 * padding, border or min-height, and every in-flow child collapses through
 * too. Its margins join the run of margins around it.
 */
function collapsesThrough(node: StyledNode): boolean {
  const s = node.style;
  if (establishesBfc(s) || hasVisibleMarker(node) || s.paddingTop !== 0 || s.paddingBottom !== 0 ||
      s.borderTopWidth !== 0 || s.borderBottomWidth !== 0 || s.minHeight > 0) {
    return false;
  }
  return node.children.every((child) =>
    isInline(child) ? !createsLineBox(child) : collapsesThrough(child));
}

/**
 * Every margin that adjoins this block's top margin: its own, and — unless
 * padding, border or a BFC separates them — its first in-flow child's,
 * recursively, continuing past children that collapse through.
 */
function leadingStrut(node: StyledNode, strut: MarginStrut = NO_MARGIN): MarginStrut {
  strut = withMargin(strut, node.style.marginTop);
  if (!topAdjoinsChildren(node.style)) return strut;
  for (const child of node.children) {
    if (isInline(child)) {
      if (!createsLineBox(child)) continue;
      return strut;
    }
    strut = leadingStrut(child, strut);
    if (!collapsesThrough(child)) return strut;
    strut = withMargin(strut, child.style.marginBottom);
  }
  return strut;
}

/**
 * Layout a block-level element and all its children.
 *
 * `y` is the border-box top: the caller has already resolved the margins
 * above it (`leadingStrut`). Returns the border-box height and the margins
 * that leave through the bottom edge (`marginBottomOut`) for the caller to
 * collapse with whatever follows. `bfcRoot` marks a box that is a block
 * formatting context root by position (the layout root, a flex item, a table
 * cell), so its margins never collapse with its children's.
 */
function layoutBlock(
  session: LayoutSession,
  node: StyledNode,
  x: number,
  y: number,
  availableWidth: number,
  clamp?: LineClampState,
  bfcRoot = false,
): { box: LayoutBox; height: number; marginBottomOut: MarginStrut } {
  const style = node.style;

  // `-webkit-line-clamp` on a block container: start a shared line budget
  // here and thread it through descendant layout so the count spans block
  // children (Chrome legacy -webkit-box semantics). An ancestor's active
  // clamp wins over a nested one.
  if (!clamp && style.lineClamp > 0) {
    clamp = { remaining: style.lineClamp, exhausted: false };
  }

  // Box model
  const marginLeft = style.marginLeft;
  const marginRight = style.marginRight;
  const borderLeft = style.borderLeftWidth;
  const borderRight = style.borderRightWidth;
  const borderTop = style.borderTopWidth;
  const borderBottom = style.borderBottomWidth;
  const padLeft = style.paddingLeft;
  const padRight = style.paddingRight;
  const padTop = style.paddingTop;
  const padBottom = style.paddingBottom;

  const boxX = x + marginLeft;
  // An explicit width sizes the box `box-sizing` names (content-box, the
  // initial value, unless the style says border-box); otherwise the box
  // fills the available width.
  let boxWidth: number;
  let contentWidth: number;
  if (style.width > 0) {
    const frame = horizontalFrame(style);
    boxWidth = borderBoxSize(style, style.width, frame);
    contentWidth = contentBoxSize(style, style.width, frame);
  } else {
    boxWidth = availableWidth - marginLeft - marginRight;
    contentWidth = Math.max(0, boxWidth - borderLeft - borderRight - padLeft - padRight);
  }
  const contentX = boxX + borderLeft + padLeft;
  // Its own text-indent/gap and its children's percentages, against the
  // width just settled.
  resolvePercentages(style, contentWidth, true);
  resolveChildPercentages(node, contentWidth);
  const minHeight = style.minHeight > 0
    ? borderBoxSize(style, style.minHeight, borderTop + padTop + padBottom + borderBottom)
    : 0;

  const boxY = y;
  const contentStartY = boxY + borderTop + padTop;

  const box: LayoutBox = {
    type: 'box',
    style,
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: 0, // computed below
    tagName: node.tagName,
    children: [],
    listMarker: node.listMarker,
  };

  // Flex layout
  if (style.display === 'flex') {
    const result = layoutFlex(session, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Table layout
  if (style.display === 'table') {
    const result = layoutTable(session, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Empty block elements: zero content height (CSS spec — no line boxes created).
  // Only min-height or padding/border contribute to height — except a list
  // item's outside marker, which makes a line box of its own (Chrome, WebKit).
  if (node.children.length === 0) {
    const markerLine = hasMarkerLine(node)
      ? session.measurer.lineHeight(style, BULLET_MARKERS.has(style.listStyleType))
      : 0;
    box.height = borderTop + padTop + markerLine + padBottom + borderBottom;
    if (minHeight > 0) box.height = Math.max(box.height, minHeight);
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Layout children
  if (hasOnlyInlineChildren(node)) {
    // Inline formatting context
    const bulletProbe = node.tagName === 'li' && BULLET_MARKERS.has(style.listStyleType);
    const { nodes, height, lines, lineBoxes } = layoutInlineContent(session, node, contentX, contentStartY, contentWidth, bulletProbe, clamp);
    session.lines.push(...lines);
    box.children = nodes;
    box.lineBoxes = lineBoxes;
    box.height = borderTop + padTop + height + padBottom + borderBottom;
  } else {
    // Block formatting context — stack children vertically, collapsing the
    // margins between them (CSS 2.1 §8.3.1).
    let curY = contentStartY;
    // Margins collapsed so far and not yet placed: a previous child's bottom
    // margins plus any child that collapsed through since.
    let pending = NO_MARGIN;
    // While no content separates them, the children's top margins adjoin this
    // box's own. The caller folded those into this box's position
    // (`leadingStrut`), so such a child sits at the content top.
    let atTop = !bfcRoot && topAdjoinsChildren(style);
    // The margins of children that collapsed through while `atTop`: they
    // adjoin this box's top, and — when nothing else is in flow — its bottom.
    let throughStrut = NO_MARGIN;

    for (let ci = 0; ci < node.children.length; ci++) {
      const child = node.children[ci];

      // Line-clamp budget exhausted — everything below the cut is dropped,
      // including the margin trailing the cut line.
      if (clamp && (clamp.exhausted || clamp.remaining <= 0)) {
        clamp.exhausted = true;
        pending = NO_MARGIN;
        break;
      }

      if (child.tagName === '#text' || isInline(child)) {
        // Collect ALL consecutive inline/text children into one group
        const inlineChildren: StyledNode[] = [child];
        while (ci + 1 < node.children.length) {
          const next = node.children[ci + 1];
          if (next.tagName === '#text' || isInline(next)) {
            inlineChildren.push(next);
            ci++;
          } else {
            break;
          }
        }
        // Content that makes no line box (collapsible whitespace, an empty
        // inline), so margins keep collapsing across it.
        if (!inlineChildren.some(createsLineBox)) continue;

        // Apply pending margin before inline content
        if (!atTop) curY += strutSize(pending);
        pending = NO_MARGIN;
        atTop = false;

        const inlineGroup: StyledNode = {
          element: null,
          tagName: 'div',
          style: { ...node.style, display: 'block', marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0 },
          children: inlineChildren,
          textContent: null,
        };
        const bulletProbe2 = node.tagName === 'li' && BULLET_MARKERS.has(style.listStyleType);
        const { nodes, height, lines, lineBoxes } = layoutInlineContent(session, inlineGroup, contentX, curY, contentWidth, bulletProbe2, clamp);
        session.lines.push(...lines);
        box.children.push(...nodes);
        (box.lineBoxes ??= []).push(...lineBoxes);
        curY += height;
        continue;
      }

      // Block child
      const top = leadingStrut(child);
      if (collapsesThrough(child)) {
        // Its top and bottom margins adjoin: they join the pending run. Its
        // border box sits where it would with a bottom border (§8.3.1) — or
        // at this box's top when its margins collapse with this box's.
        const childY = atTop ? curY : curY + strutSize(joinStruts(pending, top));
        const { box: childBox } = layoutBlock(session, child, contentX, childY, contentWidth, clamp);
        box.children.push(childBox);
        if (!atTop) pending = withMargin(joinStruts(pending, top), child.style.marginBottom);
        else throughStrut = withMargin(joinStruts(throughStrut, top), child.style.marginBottom);
        continue;
      }

      const childY = atTop ? curY : curY + strutSize(joinStruts(pending, top));
      atTop = false;
      const { box: childBox, height: childHeight, marginBottomOut } = layoutBlock(
        session, child, contentX, childY, contentWidth, clamp,
      );
      box.children.push(childBox);
      curY = childY + childHeight;
      // A child truncated by line-clamp clips its trailing margin too.
      pending = clamp?.exhausted ? NO_MARGIN : marginBottomOut;
    }

    // The last child's bottom margins leave through this box's bottom edge
    // unless padding, border or a BFC holds them inside (the layout root
    // holds them: it defines the content height). What a min-height does
    // here is an engine rule: MIN_HEIGHT_END_MARGINS.
    let marginBottomOut = withMargin(NO_MARGIN, style.marginBottom);
    let contentEnd = curY - contentStartY;
    // A list item with nothing in flow but its marker (MARKER_LINE_WITHOUT_CONTENT).
    if (atTop && hasVisibleMarker(node)) {
      if (!bfcRoot && bottomAdjoinsChildren(style)) pending = throughStrut;
      if (MARKER_LINE_WITHOUT_CONTENT) {
        contentEnd = Math.max(contentEnd,
          session.measurer.lineHeight(style, BULLET_MARKERS.has(style.listStyleType)));
      }
    }
    const raisesBox = style.minHeight > 0 &&
      contentBoxSize(style, style.minHeight, borderTop + padTop + padBottom + borderBottom) > Math.max(0, contentEnd);
    if (!bfcRoot && bottomAdjoinsChildren(style) &&
        !(MIN_HEIGHT_END_MARGINS === 'contain' && style.minHeight > 0)) {
      if (MIN_HEIGHT_END_MARGINS === 'collapse' || !raisesBox) {
        marginBottomOut = withMargin(pending, style.marginBottom);
      }
    } else {
      contentEnd += strutSize(pending);
    }
    contentEnd = Math.max(0, contentEnd);
    box.height = borderTop + padTop + contentEnd + padBottom + borderBottom;
    if (minHeight > 0) box.height = Math.max(box.height, minHeight);
    return { box, height: box.height, marginBottomOut };
  }

  if (minHeight > 0) box.height = Math.max(box.height, minHeight);
  return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
}

// ─── Table layout ──────────────────────────────────────────────────────

function layoutTable(
  session: LayoutSession,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const children: LayoutNode[] = [];

  // Collect rows from thead, tbody, tfoot, or direct tr children
  const rows: StyledNode[] = [];
  for (const child of node.children) {
    if (child.tagName === 'tr') {
      rows.push(child);
    } else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) {
      for (const grandchild of child.children) {
        if (grandchild.tagName === 'tr') rows.push(grandchild);
      }
    }
  }

  if (rows.length === 0) return { children, height: 0 };

  // Determine column count from first row
  const colCount = Math.max(...rows.map(r => r.children.filter(c => c.tagName === 'td' || c.tagName === 'th').length));
  if (colCount === 0) return { children, height: 0 };

  // Equal column widths (simple approach)
  const colWidth = contentWidth / colCount;

  let curY = contentY;

  for (const row of rows) {
    const cells = row.children.filter(c => c.tagName === 'td' || c.tagName === 'th');
    let maxCellHeight = 0;
    const cellBoxes: LayoutBox[] = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cellX = contentX + i * colWidth;

      const { box: cellBox, height: cellHeight } = layoutBlock(session, cell, cellX, curY, colWidth, undefined, true);
      cellBoxes.push(cellBox);
      maxCellHeight = Math.max(maxCellHeight, cellHeight);
    }

    // Normalize cell heights to the tallest cell in the row
    for (const cellBox of cellBoxes) {
      cellBox.height = maxCellHeight;
      children.push(cellBox);
    }

    curY += maxCellHeight;
  }

  return { children, height: curY - contentY };
}

// ─── Flex layout ───────────────────────────────────────────────────────

/**
 * Bare text in a flex container is an anonymous flex item: a block box of its
 * own, sized and placed like any other. Built once per text node, because the
 * min- and max-content caches are keyed by node identity and sizing must ask
 * about the very node the layout places.
 *
 * Its style is the container's (a text node shares its parent's) with every
 * box property at its initial value: an anonymous box inherits, it does not
 * copy the container's margins, padding, border, background or sizes — with
 * them it drew the container's border a second time around the text, and
 * indented the text by the container's padding twice.
 */
function anonymousFlexItem(session: LayoutSession, text: StyledNode): StyledNode {
  let wrapper = session.anonymousFlexItems.get(text);
  if (!wrapper) {
    wrapper = {
      element: null,
      tagName: 'div',
      style: anonymousBlockStyle(text.style),
      children: [text],
      textContent: null,
    };
    session.anonymousFlexItems.set(text, wrapper);
  }
  return wrapper;
}

/**
 * The children a flex container lays out. A bare text node is an anonymous
 * flex item only when it has actual text — and min-content sizing has to agree
 * with the layout about that, or an item is frozen at the wrong minimum.
 */
function flexItems(session: LayoutSession, node: StyledNode): StyledNode[] {
  return node.children
    .filter((child) => child.tagName !== '#text' || child.textContent?.trim())
    .map((child) => child.tagName === '#text' ? anonymousFlexItem(session, child) : child);
}

function isFlexRow(style: ResolvedStyle): boolean {
  return style.flexDirection === 'row' || style.flexDirection === '';
}

function horizontalFrame(style: ResolvedStyle): number {
  return style.borderLeftWidth + style.paddingLeft +
    style.paddingRight + style.borderRightWidth;
}

function horizontalMargins(style: ResolvedStyle): number {
  return style.marginLeft + style.marginRight;
}

/**
 * Minimum width of one inline formatting context. This is the longest unit
 * between normal soft-wrap opportunities: the actual line flow, over the
 * same prepared segments, at a width nothing fits in. An inline-block
 * there is at ITS min-content width (`inlineBlockContentWidth` at 0) — what
 * the final flow gives it at that width.
 */
function minimumInlineContentWidth(
  session: LayoutSession,
  node: StyledNode,
): number {
  // `overflow-wrap:break-word` is deliberately ignored for min-content sizing
  // by CSS. CJK/emoji and `word-break:break-all` still contribute their
  // smallest legal pieces, so run the real line flow with only that
  // last-resort mode disabled — at a width nothing fits in, every soft-wrap
  // opportunity is taken and each line IS one unbreakable unit.
  // One copy per source style, not per segment: font state is cached by
  // style identity, and runs of one style must stay one style to glue.
  const prepared = preparedInline(session, node);
  const breaksWords = (refs: SegmentRefs) =>
    refs.style.overflowWrap === 'break-word' && refs.style.wordBreak !== 'break-all';
  let refs = prepared.refs;
  if (refs.some(breaksWords)) {
    const neutralized = new Map<ResolvedStyle, ResolvedStyle>();
    refs = refs.map((r) => {
      if (!breaksWords(r)) return r;
      let style = neutralized.get(r.style);
      if (!style) neutralized.set(r.style, style = { ...r.style, overflowWrap: 'normal' });
      return { ...r, style };
    });
  }
  let widths: number[] | undefined;
  for (const i of prepared.inlineBlocks) {
    const source = prepared.refs[prepared.ref[i]].inlineBlock!;
    widths ??= prepared.width.slice();
    widths[i] = inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), 0);
  }
  const textIndent = intrinsicStyle(node.style).textIndent;
  return widestLine(flowLines(
    session, new FlowItems(prepared, refs, widths), 0, node.style.whiteSpace, false, textIndent), textIndent);
}

/**
 * Min-content width of `node`'s CONTENT box. Inside a size being computed,
 * every percentage of it is cyclic, so descendants are read through
 * `intrinsicStyle`.
 *
 * Memoized for the call (`session.minContent`): a nested flex row asks for
 * the minimum of its whole subtree, and so does every flex row above it,
 * which otherwise costs O(depth x nodes). The answer depends only on the
 * subtree and the font state, and the session ends with the call.
 */
function contentMinimum(session: LayoutSession, node: StyledNode): number {
  const memoized = session.minContent.get(node);
  if (memoized !== undefined) return memoized;
  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = minimumInlineContentWidth(session, node);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(session, node);
    content = children.reduce(
      (sum, child) => sum + minimumContribution(session, child, intrinsicStyle(child.style)), 0) +
      intrinsicStyle(node.style).gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, minimumContribution(session, child, intrinsicStyle(child.style)));
      }
    }
  }
  session.minContent.set(node, content);
  return content;
}

/**
 * Min-content contribution of `node` as an outer (margin-box) width, its own
 * box read from `style`: `node.style` for a flex item, whose percentages
 * resolve against the container, or `intrinsicStyle` inside a size being
 * computed.
 */
function minimumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  const frame = horizontalFrame(style);

  // An explicit min-width disables the flex automatic min-content size.
  if (style.minWidth !== null) {
    return margins + borderBoxSize(style, style.minWidth, frame);
  }

  let borderBox = frame + contentMinimum(session, node);
  // A definite width caps the automatic minimum size in the flex algorithm.
  if (style.width > 0) borderBox = Math.min(borderBox, borderBoxSize(style, style.width, frame));
  return margins + borderBox;
}

/** Min-content contribution of a flex item, including its horizontal frame and margins. */
function minimumContentWidth(session: LayoutSession, node: StyledNode): number {
  return minimumContribution(session, node, node.style);
}

/**
 * Maximum width of one inline formatting context: the widest stretch between
 * FORCED breaks. That is the same line flow every other caller uses, run at a
 * width nothing can exceed — max-content does not get its own break rules.
 * Prepared inline-blocks already stand at their max-content width.
 */
function maximumInlineContentWidth(
  session: LayoutSession,
  node: StyledNode,
): number {
  const prepared = preparedInline(session, node);
  const textIndent = intrinsicStyle(node.style).textIndent;
  return widestLine(flowLines(
    session, new FlowItems(prepared), Infinity, node.style.whiteSpace, false, textIndent), textIndent);
}

/** Max-content width of `node`'s CONTENT box; memoized like `contentMinimum`. */
function contentMaximum(session: LayoutSession, node: StyledNode): number {
  const memoized = session.maxContent.get(node);
  if (memoized !== undefined) return memoized;
  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = maximumInlineContentWidth(session, node);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(session, node);
    content = children.reduce(
      (sum, child) => sum + maximumContribution(session, child, intrinsicStyle(child.style)), 0) +
      intrinsicStyle(node.style).gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, maximumContribution(session, child, intrinsicStyle(child.style)));
      }
    }
  }
  session.maxContent.set(node, content);
  return content;
}

/**
 * Max-content contribution of `node` — the same outer currency
 * `minimumContribution` reports and `layoutBlock` takes as its available
 * width — its own box read from `style` (see there).
 */
function maximumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  // A definite width IS the max-content size.
  if (style.width > 0) return margins + borderBoxSize(style, style.width, horizontalFrame(style));
  return margins + horizontalFrame(style) + contentMaximum(session, node);
}

/** Max-content contribution of a flex item. */
function maximumContentWidth(session: LayoutSession, node: StyledNode): number {
  return maximumContribution(session, node, node.style);
}

/**
 * An inline-block's content-box width when `available` px are left for its
 * content: its own width (by `box-sizing`), else shrink-to-fit,
 * min(max(min-content, available), max-content) (CSS 2.1 §10.3.9) — floored
 * at its min-width. At 0 that is its min-content width and at Infinity its
 * max-content width, so intrinsic sizing and the final flow ask the same
 * question. Its box is read from `style` (`node.style`, or `intrinsicStyle`).
 */
function inlineBlockContentWidth(
  session: LayoutSession, node: StyledNode, style: ResolvedStyle, available: number,
): number {
  const frame = horizontalFrame(style);
  // Block children inside an inline-block are not laid out as blocks: its
  // content is ONE inline flow (`layoutInlineContent` of the node), and it is
  // sized by that same flow — never by a block layout it does not get.
  const inlineOnly = hasOnlyInlineChildren(node);
  let width = style.width > 0
    ? contentBoxSize(style, style.width, frame)
    : Math.min(
      inlineOnly ? contentMaximum(session, node) : maximumInlineContentWidth(session, node),
      Math.max(inlineOnly ? contentMinimum(session, node) : minimumInlineContentWidth(session, node), available),
    );
  if (style.minWidth !== null) width = Math.max(width, contentBoxSize(style, style.minWidth, frame));
  return width;
}

/** An inline-block's margin box at `containingWidth`: what one line item of it takes. */
function inlineBlockOuterWidth(
  session: LayoutSession, node: StyledNode, style: ResolvedStyle, containingWidth: number,
): number {
  const margins = horizontalMargins(style);
  const frame = horizontalFrame(style);
  return margins + frame +
    inlineBlockContentWidth(session, node, style, Math.max(0, containingWidth - margins - frame));
}

/**
 * Flex base size of one item, as an outer width. `flex-basis: auto` (the
 * initial value, and what `flex-grow: 1` on its own leaves in place) resolves
 * against the item's own content; `flex: 1` sets it to 0 so the item's content
 * stops mattering and the row splits by grow factor alone. A flex-basis sizes
 * the box `box-sizing` names, like a width.
 */
function flexBaseSize(session: LayoutSession, node: StyledNode): number {
  return node.style.flexBasis !== null
    ? horizontalMargins(node.style) + borderBoxSize(node.style, node.style.flexBasis, horizontalFrame(node.style))
    : maximumContentWidth(session, node);
}

/**
 * CSS flexible length resolution (CSS Flexbox §9.7) over outer widths.
 *
 * Grow or shrink is decided once, for the whole line, by whether the items'
 * hypothetical sizes fit. Each pass distributes the space the unfrozen items
 * are still free to take, then freezes every item that landed under its
 * automatic minimum — freeing one item changes every other item's share, so
 * the pass repeats until nothing new is clamped.
 */
function resolveFlexibleLengths(
  styles: ResolvedStyle[],
  bases: number[],
  minimums: number[],
  available: number,
): number[] {
  const sizes = bases.map((base, index) => Math.max(base, minimums[index]));
  const growing = sizes.reduce((sum, size) => sum + size, 0) < available;
  const factor = (index: number) =>
    growing ? styles[index].flexGrow : styles[index].flexShrink;
  const frozen = sizes.map((size, index) =>
    factor(index) === 0 || (!growing && bases[index] < size));

  for (;;) {
    const unfrozen = sizes.map((_, index) => index).filter((index) => !frozen[index]);
    if (unfrozen.length === 0) break;
    const used = sizes.reduce(
      (sum, size, index) => sum + (frozen[index] ? size : bases[index]),
      0,
    );
    const remaining = available - used;
    // Shrinking is weighted by base size, so a big item gives up more than a
    // small one at the same shrink factor; growing is not.
    const weights = unfrozen.map((index) =>
      growing ? styles[index].flexGrow : styles[index].flexShrink * bases[index]);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    if (weightSum <= 0) break;
    unfrozen.forEach((index, slot) => {
      sizes[index] = bases[index] + remaining * weights[slot] / weightSum;
    });
    const violators = unfrozen.filter((index) => sizes[index] < minimums[index]);
    if (violators.length === 0) break;
    for (const index of violators) {
      sizes[index] = minimums[index];
      frozen[index] = true;
    }
  }
  return sizes;
}

function layoutFlex(
  session: LayoutSession,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const style = node.style;
  const gap = style.gap;
  const children: LayoutNode[] = [];

  const flexChildren = flexItems(session, node);
  if (flexChildren.length === 0) return { children, height: 0 };

  if (isFlexRow(style)) {
    // Row layout
    const totalGaps = gap * (flexChildren.length - 1);
    const available = Math.max(0, contentWidth - totalGaps);
    // If the minima themselves do not fit, they overflow the container exactly
    // as native flex items with min-width:auto do.
    const widths = resolveFlexibleLengths(
      flexChildren.map((child) => child.style),
      flexChildren.map((child) => flexBaseSize(session, child)),
      flexChildren.map((child) => minimumContentWidth(session, child)),
      available,
    );

    let curX = contentX;
    let maxHeight = 0;

    for (let index = 0; index < flexChildren.length; index++) {
      const child = flexChildren[index];
      const childWidth = widths[index];

      const { box, height } = layoutBlock(session, child, curX, contentY, childWidth, undefined, true);
      children.push(box);
      maxHeight = Math.max(maxHeight, height);
      curX += childWidth + gap;
    }

    return { children, height: maxHeight };
  }

  // Column layout (fallback)
  let curY = contentY;
  for (const child of flexChildren) {
    const { box, height } = layoutBlock(session, child, contentX, curY, contentWidth, undefined, true);
    children.push(box);
    curY += height + gap;
  }
  return { children, height: curY - contentY };
}

// ─── List marker layout ────────────────────────────────────────────────

/**
 * Add list marker to a layout box if applicable.
 */
function addListMarker(
  session: LayoutSession,
  box: LayoutBox,
  node: StyledNode,
): void {
  if (!node.listMarker) return;
  // `::marker { content: none }` suppresses the marker entirely —
  // canonical CSS behavior, matches the DOM reference.
  if (node.markerHidden) return;

  const style = node.style;
  // `markerStyle` holds only the fields `::marker` rules changed.
  const ms = node.markerStyle;
  const markerStyleObj: ResolvedStyle = ms ? { ...style, ...ms } : style;

  // The marker measures in its own style — letter-spacing and kerning too,
  // as it is painted, not in whatever the li's last run left on the ctx.
  const m = session.measurer;
  const markerState = m.stateOf(markerStyleObj);
  // ascent + descent is the li's line-height by construction, so one call
  // gives both the marker's baseline and the box it reports.
  const strut = m.leadedBox(style);
  const baselineY = box.y + style.borderTopWidth + style.paddingTop + strut.ascent;

  const markerWidth = m.width(markerState, node.listMarker);
  const isRTL = style.direction === 'rtl';
  const isBullet = BULLET_MARKERS.has(style.listStyleType);
  // Gap between marker and content, matching Chrome (measured empirically):
  // - bullets: Chrome paints a symbol (diameter ascent/3) whose ink ends
  //   7px + ascent/3 before the content edge, centered ascent/3 above the
  //   baseline. We keep the glyph but position its ink to land there.
  // - text markers ("1."): Chrome's marker text carries a ". " suffix, so
  //   the gap is one space advance and the baseline is the line baseline.
  // `::marker { padding-inline-end: <length> }` overrides the gap — we honor
  // the direction-resolved physical padding (paddingRight in LTR, paddingLeft
  // in RTL) when explicitly set on the marker.
  const explicitGap = isRTL ? ms?.paddingLeft : ms?.paddingRight;

  let markerX: number;
  let markerY = baselineY;
  let markerDirection = 'ltr';
  // Style/width the marker glyph is actually DRAWN with. Numbers draw at the
  // li font (unchanged); bullets scale up (see below), so keep these separate.
  let markerDrawStyle: ResolvedStyle = markerStyleObj;
  let markerDrawWidth = markerWidth;
  const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
  const boxRightEdge = box.x + box.width;
  if (isBullet) {
    const { ascent } = m.metrics(markerStyleObj);
    const ink = m.measureText(markerState, node.listMarker);
    // Blink's marker unit: the disc DIAMETER, the variable part of the gap, and
    // the vertical centering all key off this one value (a 2/3·ascent marker
    // box with a half-filling disc → ascent/3). Named once so tuning one keeps
    // the trio in sync.
    const markerUnit = ascent / 3;
    const gap = explicitGap !== undefined ? explicitGap : 7 + markerUnit;
    // Chrome paints bullet symbols (disc/circle/square) as a SYNTHETIC shape of
    // that diameter, NOT the font's smaller '•'/'○'/'■' glyph (Roboto's '•' ink
    // is ~0.22em vs Chrome's ~0.31em disc). Match it by scaling the glyph so its
    // ink height equals markerUnit. Keeping the marker a text node means fill /
    // stroke / shadow / gradient still apply exactly as before.
    const inkH = (ink.actualBoundingBoxAscent ?? 0) + (ink.actualBoundingBoxDescent ?? 0);
    const scale = inkH > 0 ? markerUnit / inkH : 1;
    const inkRight = (ink.actualBoundingBoxRight ?? markerWidth) * scale;
    const inkLeft = (ink.actualBoundingBoxLeft ?? 0) * scale;
    const glyphInkCenter =
      (((ink.actualBoundingBoxAscent ?? 0) - (ink.actualBoundingBoxDescent ?? 0)) / 2) * scale;
    if (isRTL) {
      // actualBoundingBoxLeft is positive when ink extends left of origin
      markerX = boxRightEdge + gap + inkLeft;
    } else {
      markerX = contentStartX - gap - inkRight;
    }
    markerY = baselineY - markerUnit + glyphInkCenter;
    markerDrawStyle = { ...markerStyleObj, fontSize: markerStyleObj.fontSize * scale };
    markerDrawWidth = markerWidth * scale;
  } else {
    const gap = explicitGap !== undefined
      ? explicitGap
      : m.width(markerState, ' ');
    if (isRTL) {
      // RTL: marker in the parent's right padding area (outside the li box).
      // Numbered markers ("1.") need RTL direction to display as ".1".
      // With textAlign='right', x is the right edge — so add markerWidth.
      const isNumbered = /\d/.test(node.listMarker);
      if (isNumbered) {
        markerDirection = 'rtl';
        markerX = boxRightEdge + gap + markerWidth;
      } else {
        markerX = boxRightEdge + gap;
      }
    } else {
      // LTR: marker in the parent's left padding area (outside the li box).
      markerX = contentStartX - markerWidth - gap;
    }
  }

  const marker: LayoutText = {
    type: 'text',
    text: node.listMarker,
    x: markerX,
    y: markerY,
    width: markerDrawWidth,
    style: { ...markerDrawStyle, textDecorationLine: 'none', textDecorations: [], fontWeight: ms?.fontWeight ?? 400, fontStyle: ms?.fontStyle ?? 'normal', direction: markerDirection },
  };
  // The marker sits on the item's first line, whose top is the content top.
  runLineTops.set(marker, box.y + style.borderTopWidth + style.paddingTop);
  box.children.unshift(marker);

  // Also publish the marker through the LayoutLine stream so result.lines
  // sees the bullet/number alongside the item text. Markers are added AFTER
  // inline content is laid out, so they don't go through layoutInlineContent.
  // The buildLayoutTree sort+merge step picks up the marker by its baseline.
  // RTL numbered markers store their right edge in markerX (textAlign trick).
  // bounds.width is the (scaled) glyph ADVANCE, not its ink extent — same
  // convention as numbered markers; the ink right edge itself is pinned to
  // contentStart - gap above.
  const markerLeftX = markerDirection === 'rtl' ? markerX - markerDrawWidth : markerX;
  session.lines.push({
    y: Math.round(baselineY),
    text: node.listMarker,
    bounds: {
      x: markerLeftX,
      y: box.y + style.borderTopWidth + style.paddingTop,
      width: markerDrawWidth,
      height: strut.ascent + strut.descent,
    },
  });
}

// ─── Main entry ────────────────────────────────────────────────────────

/** Parse `html` and resolve its styles; ch/ex measure on `ctx` only when used. */
export function styleTree(
  html: string, ctx: CanvasRenderingContext2D, width: number,
  viewport?: { width: number; height: number },
): StyledNode {
  const { fragment, css } = parseHTML(html);
  let unitMeasurer: Measurer | undefined;
  return resolveStylesFromCSS(fragment, css, width, {
    viewport,
    fontUnits: (style) => (unitMeasurer ??= new Measurer(ctx, new Map())).fontUnits(style),
  });
}

/**
 * Build the layout tree from the styled tree using pure canvas measurement.
 * No DOM measurements used — all positions computed from CSS values + canvas.measureText.
 */
export function buildLayoutTree(
  ctx: CanvasRenderingContext2D,
  styledTree: StyledNode,
  containerWidth: number,
  useDomMeasurements: boolean,
  debug?: (entry: import('./types.ts').DebugEntry) => void,
  stats?: LayoutStats,
): { root: LayoutBox; height: number; lines: LayoutLine[] } {
  // Everything starts empty with the call and ends with it — fonts may have
  // loaded since the last one. A fresh measurer also has no idea what the
  // ctx holds: the caller may have touched it. The font metrics table
  // outlives the call on the result alone (`layoutFontMetrics`).
  const fontMetrics: FontMetricsTable = new Map();
  const session: LayoutSession = {
    measurer: new Measurer(ctx, fontMetrics, useDomMeasurements),
    debug,
    lines: [],
    minContent: new Map(),
    maxContent: new Map(),
    anonymousFlexItems: new Map(),
    prepared: new Map(),
    stats,
  };
  // The styledTree root is our container div — layout its children as a block flow
  const { box, height } = layoutBlock(session, styledTree, 0, 0, containerWidth, undefined, true);

  // Add list markers post-layout
  addListMarkersRecursive(session, box, styledTree);

  // Sort by baseline y, then by left edge so cross-cell content merges in
  // reading order (LTR). List markers sit at smaller x than their content
  // and so come first, producing "• Item" rather than "Item •".
  const sorted = session.lines.sort((a, b) =>
    (a.y - b.y) || (a.bounds.x - b.bounds.x)
  );
  const lines: LayoutLine[] = [];
  for (const candidate of sorted) {
    const last = lines[lines.length - 1];
    // How far apart two baselines can sit and still be one visual row is
    // bounded by the SHORTER of the two rows — the same rule the native DOM
    // reference groups word rects by (`overlap / minH`). Using max() leaks
    // across rows in tight multi-column layouts, and using the candidate's own
    // height alone lets a line box that contains a tall atomic inline-block
    // swallow the row above it.
    const tolerance = Math.min(last?.bounds.height ?? Infinity,
      candidate.bounds.height) * 0.5;
    if (last && Math.abs(candidate.y - last.y) < tolerance) {
      // Cross-cell merge: insert a space separator so the text stays
      // readable when N cells of a table row collapse into one LayoutLine.
      // Skip if either side already has a boundary space.
      const needsSep = last.text.length > 0 && candidate.text.length > 0 &&
        !/\s$/.test(last.text) && !/^\s/.test(candidate.text);
      last.text += (needsSep ? ' ' : '') + candidate.text;
      // Carry baseline forward so the next comparison uses the running
      // edge of the group, not the stale first element's baseline.
      last.y = Math.max(last.y, candidate.y);
      const x1 = Math.min(last.bounds.x, candidate.bounds.x);
      const y1 = Math.min(last.bounds.y, candidate.bounds.y);
      const x2 = Math.max(last.bounds.x + last.bounds.width, candidate.bounds.x + candidate.bounds.width);
      const y2 = Math.max(last.bounds.y + last.bounds.height, candidate.bounds.y + candidate.bounds.height);
      last.bounds = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else {
      lines.push({ y: candidate.y, text: candidate.text, bounds: { ...candidate.bounds } });
    }
  }
  layoutFontMetrics.set(box, fontMetrics);
  return { root: box, height, lines };
}

function addListMarkersRecursive(
  session: LayoutSession,
  box: LayoutBox,
  node: StyledNode,
): void {
  addListMarker(session, box, node);

  // Match children — box.children may have extra text/inline nodes,
  // so we correlate by walking both in parallel
  let boxChildIdx = 0;
  for (const styledChild of node.children) {
    if (styledChild.tagName === '#text' || isInline(styledChild)) {
      continue;
    }
    // Find the matching LayoutBox
    while (boxChildIdx < box.children.length) {
      const layoutChild = box.children[boxChildIdx];
      if (layoutChild.type === 'box' && layoutChild.tagName === styledChild.tagName) {
        addListMarkersRecursive(session, layoutChild, styledChild);
        boxChildIdx++;
        break;
      }
      boxChildIdx++;
    }
  }
}
