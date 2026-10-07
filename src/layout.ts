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
 * Everything one `buildLayoutTree` call owns, threaded down as `session`. Layout keeps no
 * module state, so a nested call cannot touch the outer one (`tests/node/reentrancy.test.ts`).
 */
interface LayoutSession {
  /** The call's one measuring primitive (and its per-call font state). */
  readonly measurer: Measurer;
  readonly debug: ((entry: import('./types.ts').DebugEntry) => void) | undefined;
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

const BULLET_MARKERS = new Set(['disc', 'circle', 'square']);

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

type TabStops = Readonly<{ interval: number; halfSpace: number }>;

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

/** Each run's line-box top, for `paintLineSnap`; kept off the public `LayoutText` shape. */
const runLineTops = new WeakMap<LayoutText, number>();

/** Marks a LayoutText that starts a measuring run (`startsMeasuredRun`). A symbol: no public field. */
const RUN_SEAM: unique symbol = Symbol('runSeam');
type SeamFlagged = LayoutText & { [RUN_SEAM]?: true };

/**
 * True when `node` starts a new measuring run after a piece of the same style
 * (`Hello<!---->World`): paint must not batch the two into one fillText. A tree this
 * layout did not produce batches by style.
 */
export function startsMeasuredRun(node: LayoutText): boolean {
  return (node as SeamFlagged)[RUN_SEAM] === true;
}

/**
 * The engine's paint offset for a run's line (`SNAPS_LINE_PAINT`): `round(lineTop) - lineTop`,
 * else 0. A node this layout did not produce uses its baseline as the line top.
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
  return fontSize * multiplier;
}

/**
 * The used height of a computed line-height LENGTH: WebKit truncates it to whole px, Blink
 * rounds it to 1/64px, Gecko keeps it. Idempotent.
 */
function usedLineHeight(lineHeight: number): number {
  if (TRUNCATES_LINE_HEIGHT) return Math.floor(Math.fround(lineHeight));
  if (LAYOUT_UNIT_LINE_HEIGHT) return Math.round(lineHeight * 64) / 64;
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
function inlineBlockExtra(bs: ResolvedStyle): { top: number; bottom: number } {
  return {
    top: bs.marginTop + bs.borderTopWidth + bs.paddingTop,
    bottom: bs.paddingBottom + bs.borderBottomWidth + bs.marginBottom,
  };
}

/**
 * Apply text-transform per run, keeping CSS word context across style boundaries: a later
 * capitalize run must not recase the middle of a word.
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
function verticalAlignShift(
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

/**
 * Two entries draw the same band (geometry only; callers compare color their own way).
 * Identity settles the normal case; separate declarers of the same band still match, which
 * keeps a shaping group whole across siblings.
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
    // The declarer's vertical-align picks the baseline an underline hangs off.
    da.verticalAlign === db.verticalAlign &&
    // Explicit offset and thickness are band geometry too.
    da.textUnderlineOffset === db.textUnderlineOffset &&
    da.textDecorationThickness === db.textDecorationThickness
  );
}

function hasVisibleBoxStyles(style: ResolvedStyle): boolean {
  if (!isTransparent(style.backgroundColor)) return true;
  if (style.borderTopWidth > 0 && style.borderTopStyle !== 'none') return true;
  if (style.borderRightWidth > 0 && style.borderRightStyle !== 'none') return true;
  if (style.borderBottomWidth > 0 && style.borderBottomStyle !== 'none') return true;
  if (style.borderLeftWidth > 0 && style.borderLeftStyle !== 'none') return true;
  return false;
}

/** `background-clip:text` with a visible background (gradient or color): the glyphs it
 * covers sample that background instead of painting it as a box. */
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

// ── Inline text run types ──

interface TextRun {
  text: string;
  style: ResolvedStyle;
  /** Atomic inline-block content starts a new CSS word. */
  wordBoundaryBefore?: boolean;
  /**
   * The style of the parent of this run's element: what `vertical-align` shifts against
   * (CSS 2.1 §10.8.1), not the tallest run on the line.
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

/** One item of a committed line as the emit pass reads it (`FlowItems.word`). */
interface Word {
  text: string;
  width: number;
  refs: SegmentRefs;
  isSpace: boolean;
  /** Tab character — its width is the advance to the tab stop it reached */
  isTab?: boolean;
  inlineBlockLayout?: InlineBlockLayout;
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
  return !!(w.refs.boxOpen && w.refs.boxClose && w.text);
}

/**
 * `-webkit-line-clamp` cut-off: trim trailing spaces and text (atomic inline-blocks
 * included) until "…" fits, then append it in the last text word's style and box.
 */
function applyEllipsisToLine(
  session: LayoutSession,
  line: PositionedLine,
  maxWidth: number,
): void {
  const words = line.words;
  let styleIdx = words.length - 1;
  while (styleIdx >= 0 && (words[styleIdx].text === '' || isAtomicInlineBlock(words[styleIdx]))) styleIdx--;
  if (styleIdx < 0) return;
  const { style, parentStyle, boxStyle } = words[styleIdx].refs;
  const m = session.measurer;
  const width = m.width(m.stateOf(style), '…');
  const pop = () => { line.totalWidth -= words.pop()!.width; };
  const popSpaces = () => { while (words.length && words[words.length - 1].isSpace) pop(); };
  popSpaces();
  // Only text runs and atomic inline-blocks carry text; box-edge markers are ''.
  while (line.totalWidth + width > maxWidth && words.length && words[words.length - 1].text) {
    pop();
    popSpaces();
  }
  words.push({ text: '…', width, refs: { style, parentStyle, boxStyle }, isSpace: false });
  if (session.stats) session.stats.wordObjects++;
  line.totalWidth += width;
}

// ── Inline layout ──

/**
 * Collect text runs from inline children, with open/close markers for inline boxes and the
 * nearest paint declarers (`clipStyle`, `strokeImageStyle`).
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
      // A #text node carries its parent element's style, so its vertical-align shifts against
      // that element's parent: `parentStyle`.
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
    // Nearest clip / stroke-image declarer: those properties do not inherit.
    const newClipStyle = inline && hasTextClip(n.style) ? n.style : clipStyle;
    const newStrokeImageStyle = inline && hasStrokeImage(n.style) ? n.style : strokeImageStyle;
    const hasHorizSpacing = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    if (isInlineBlock) {
      // An inline-block is one atomic run, sized from its own content. Its text is U+FFFC, what
      // an atomic inline is to line breaking and bidi; empty content is only its opening edge.
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

    // An RTL bidi-override reverses each descendant run's characters and the runs' order.
    const ub = n.style.unicodeBidi;
    const overrideRtl = (ub === 'bidi-override' || ub === 'isolate-override') &&
      n.style.direction === 'rtl';
    const overrideStart = runs.length;
    // The element's bidi context (CSS Writing Modes 3 §2.4.2); a reversed RTL override is an
    // LTR override to the bidi algorithm.
    const childBidi = bidiContextFor(ub, overrideRtl ? 'ltr' : n.style.direction, bidi);

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style, bidi });
    }

    for (const child of n.children) {
      walk(
        child, newBoxStyle, newClipStyle, newStrokeImageStyle,
        // A text child's vertical-align belongs to this element, so it shifts against this
        // element's parent.
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
          // Now in visual order: paint left to right.
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

/** Text in a script without spaces between words (Thai, Khmer, Lao, Myanmar). */
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
 * A piece is measured as `w(context + piece) - w(context)`, so kerning across its edges
 * survives. 32 UTF-16 units: no wrap moved against whole-run context in the 1px sweeps.
 * Past it the context restarts at the last word, never at a space.
 */
const MEASURE_CONTEXT = 32;

interface Cumulative {
  text: string;
  width: number;
  word: number;
}

/** How far back an open bracket holds the context; a stray "(" cannot go quadratic. */
const MEASURE_BRACKET = 256;

/**
 * Where a context restart may cut `text`: at `word`, or earlier at a still-open bracket
 * and the word with the nearest letter before it: a pair takes its direction from the
 * type before the opener (UBA N0), and a number takes its type from a letter (W7).
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

// ── Prepared inline content ──

/** What a segment shares with its run: the run itself, one per run, referenced by index. */
type SegmentRefs = Readonly<Omit<TextRun, 'text' | 'wordBoundaryBefore'>>;

/** Collapsible or preserved whitespace; a space's width carries word-spacing. */
const SEG_SPACE = 1 << 0;
/** A preserved tab: its width is a placeholder until the flow reaches a stop. */
const SEG_TAB = 1 << 1;
/** Breaks after a soft hyphen: a visible '-' when a line ends here. */
const SEG_SOFT_HYPHEN = 1 << 2;
/**
 * No soft-wrap opportunity before this segment: it abuts the previous one with no
 * whitespace (`<span>a</span><span>b</span>`).
 */
const SEG_NO_BREAK_BEFORE = 1 << 3;
/** A new measuring run right after one of the same style object (`startsMeasuredRun`). */
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
 * One inline formatting context's text, segmented and measured once per call and read by
 * every pass (min-content, max-content, the real flow); no pass writes to it. Struct of
 * arrays, one entry per segment; what a segment shares with its run sits once in `refs`.
 * Segment text is the exact measured string, never a slice of a concatenation.
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
   * Segments whose width the final flow decides: atomic inline-blocks (prepared at
   * max-content) and edges with percentage padding (prepared at 0). `usedSegmentWidths`.
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

/** Segment and measure one string into `out` by white-space mode. */
function prepareString(
  session: LayoutSession, out: SegmentBuilder, text: string, run: TextRun, ref: number,
  cumState?: Cumulative,
): void {
  const m = session.measurer;
  // Zero-width spaces and soft hyphens are break opportunities; the parts share one context.
  if (text.includes('\u200B') || text.includes('\u00AD')) {
    const parts = text.split(/(\u200B|\u00AD)/);
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

  const state = m.stateOf(run.style);
  const n = text.length;

  // `pre-line` collapses spaces and tabs (its newlines were split off in prepareInline).
  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'break-spaces';

  if (isPreserve) {
    // Space runs, single tabs and the text between them, split after hyphens.
    const tabStopInterval = m.width(state, ' ') * 8; // CSS default: 8 spaces
    let i = 0;
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 9) {
        // A placeholder: the flow resolves a tab against the tab stops.
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

  // A word breaks after "?" (Chrome wraps URLs at the query; not at / & = . :), and before an
  // NBSP only after a hyphen or break-after char (UAX #14 LB12a; measured: - | \u2013 \u2014).
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
      // Measured alone for the debug callback only.
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
 * `text.slice(start, end)` split after hyphens, keeping the hyphen; a leading hyphen stays
 * with its word.
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

/** Segment and measure text runs: the one pass over an inline context's text per call. */
function prepareInline(session: LayoutSession, runs: TextRun[]): PreparedInline {
  const out = new SegmentBuilder();
  /** The text so far ends with a zero-width space (a break opportunity). */
  let zwspBefore = false;
  /** Style of the last text run that produced segments (`markSeam`). */
  let lastTextStyle: ResolvedStyle | null = null;
  let runStart = 0;

  for (const run of transformTextRuns(runs)) {
    // Atomic inline-block: one segment at its max-content width, re-sized by the final flow
    // (`usedSegmentWidths`). Checked before the box edges: it has both.
    if (run.boxOpen && run.boxClose && run.text) {
      const source = run.inlineBlock!;
      out.inlineBlocks.push(out.count);
      out.push(run.text, inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), Infinity), 0, out.addRefs(run));
      continue;
    }

    // Inline box edge (padding + border), or an empty inline-block's opening edge. A
    // percentage padding is 0 until `usedSegmentWidths`.
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
    /** Flag a seam when the previous text run had the same style object (`SEG_RUN_SEAM`). */
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

/** The prepared content of `node`'s inline context for intrinsic sizing, made once per call. */
function preparedInline(session: LayoutSession, node: StyledNode): PreparedInline {
  let prepared = session.prepared.get(node);
  if (!prepared) {
    prepared = prepareInline(session, collectTextRuns(node));
    session.prepared.set(node, prepared);
  }
  return prepared;
}

/**
 * The prepared content for the layout, its last reader: taken off the session so a long
 * document does not hold every paragraph's segments.
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
/** The characters `isEmojiCluster` can be true for: a cheap check before segmenting. */
const EMOJI_CANDIDATE = /[\u{1F000}-\u{10FFFF}\u200D\uFE0F]/u;
/**
 * An emoji cluster that is a break opportunity: emoji presentation only, so text symbols
 * like ©/®/™ (Extended_Pictographic, but no break) are excluded.
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

// ── Line flow ──

/**
 * What one flow places on lines, by index: the prepared segments, then the pieces this
 * flow cuts from them. A flow never writes to the prepared arrays.
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
   * `refs` and `widths` stand in for the prepared ones (min-content neutralizes
   * `overflow-wrap`; `usedSegmentWidths` sizes inline-blocks and percentage padding).
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

  /** Item `i`'s text for debug entries: an atomic inline reads as its content, not U+FFFC. */
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
   * New text continuing item `from`'s run but not its box (a soft hyphen's '-', a glued
   * chain fragment): style and declarers, never box edges.
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
    const flags = this.flags(i);
    return {
      text: this.text(i),
      width: this.width(i),
      refs: this.refs(i),
      isSpace: (flags & SEG_SPACE) !== 0,
      isTab: (flags & SEG_TAB) !== 0,
      inlineBlockLayout: this.inlineBlockLayout(i),
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
 * The one measuring state every glyph on these items shares, so the line can be
 * re-measured as one string; `'mixed'` otherwise, `null` with no glyph. Spaces do not count.
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
 * Break segment `index` into character pieces if it holds CJK/emoji, or if break-word
 * applies and it is too wide; `null` when it stays whole. `emergency` marks the break-word
 * last resort, which the caller treats unlike ordinary CJK/emoji opportunities.
 */
function splitSegment(
  session: LayoutSession,
  items: FlowItems,
  index: number,
  contentWidth: number,
): { texts: string[]; widths: number[]; emergency: boolean } | null {
  const flags = items.flags(index);
  const style = items.refs(index).style;
  const hasCJK = (flags & SEG_CJK) !== 0;
  const hasEmoji = (flags & SEG_EMOJI) !== 0;

  const needsBreak = items.width(index) > contentWidth &&
    (style.overflowWrap === 'break-word' || style.wordBreak === 'break-all');

  if (!hasCJK && !hasEmoji && !needsBreak) return null;

  // break-word is the last resort; CJK/emoji and `word-break: break-all` are ordinary
  // opportunities.
  const emergency = needsBreak && !hasCJK && !hasEmoji &&
    style.wordBreak !== 'break-all';

  // Each character is measured after its left context (`MEASURE_CONTEXT`); positions below
  // are in the context's coordinates, so a restart shifts them together.
  const m = session.measurer;
  const state = m.stateOf(style);
  const text = items.text(index);
  // By grapheme when emoji are present, so clusters never split.
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

    // Each emoji cluster and CJK character is a piece of its own: a break opportunity.
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

    const candidateText = current + char;
    const candidateWidth = nextMeasuredWidth - currentStartWidth;

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

// ── Break opportunities ──

/** Punctuation that cannot start a line — stays with the preceding word. */
const TRAILING_PUNCT = /^[,.\;:!?\)\]\}'"»›」』】〕〉》”、。・！），：；？၊-၏។-៖៘-៚]+$/;
/** Punctuation that cannot end a line — stays with the following word. */
const OPENING_PUNCT = /^[\(\[\{«‹“‘「『【〔〈《（]+$/;

/**
 * Whether the run at segment `at` continues the text before it with no break opportunity
 * (`<span>E</span>xperience`): the source of `SEG_NO_BREAK_BEFORE`.
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
  // Glue only ordinary text: CJK, emoji and segmenter scripts break at any element edge.
  // Graphemes, not code units or points: a VS16 emoji (❤️ = U+2764 U+FE0F) must read as emoji.
  const firstChar = firstGrapheme(first);
  const prevChar = lastGrapheme(prev);
  return !(
    isCJKCode(firstChar.codePointAt(0)!) || isCJKCode(prevChar.codePointAt(0)!) ||
    isEmojiCluster(firstChar) || isEmojiCluster(prevChar) ||
    needsSegmenter(first) || needsSegmenter(prev)
  );
}

/**
 * What the boundary BEFORE a flow item allows; every breaking decision reads it.
 * - `'space'`: white space or a forced break.
 * - `'continues'`: a word continuing across a run boundary (`SEG_NO_BREAK_BEFORE`).
 * - `'glued'`: closing punctuation (`TRAILING_PUNCT`) or an inline box's closing edge.
 * - `'allowed'`: an ordinary break opportunity.
 * `splitPiece`: a piece after the first of a split segment. The split is the opportunity,
 * so run-boundary glue stays on the first piece; a closer still glues.
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

// ── Glue: what must share a line ──

/**
 * Width of what follows segment `from` that cannot start a line (`breakBefore`): closing
 * punctuation, a closing box edge, a word continued across runs. It wraps with the word
 * before it ("Music Experie" + "nce" wraps whole).
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
 * The glued width riding on split piece `piece`: a closing-punctuation piece belongs to the
 * character before it (`…습니다.` wraps as `다.`). The segment's own tail rides on its last.
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
 * The width after piece `piece` that must share its line because no line may END there:
 * opening punctuation and an inline box's opening edge (padding-left goes with the content).
 */
function headGlueWidth(
  flow: LineFlow, segment: number, piece: number, isLastPiece: boolean, gluedTailWidth: number,
): number {
  const items = flow.items;
  const count = items.prepared.count;
  let headExtra = 0;
  const isOpener = (items.flags(piece) & SEG_OPENING_PUNCT) !== 0;
  if (isOpener && !isLastPiece) {
    // A CJK opener split mid-word glues to its next piece: Chrome never ends a line with
    // 「 or （ (measured).
    headExtra = items.width(piece + 1);
  } else if ((!items.text(piece) && items.refs(piece).boxOpen) ||
      (isOpener && gluedTailWidth === 0)) {
    let nextIndex = segment + 1;
    // An opener may be followed by box edges before its first glyph: `(<span>word</span>)`.
    while (nextIndex < count && !items.text(nextIndex) && items.refs(nextIndex).boxOpen) {
      headExtra += items.width(nextIndex);
      nextIndex++;
    }
    const nextText = nextIndex < count ? items.text(nextIndex) : '';
    if (nextText && !flow.isSpace(nextIndex)) {
      // Only the next segment's first BREAKABLE unit stays with the padding: the whole word, or
      // one character for CJK / break-word.
      const split = nextText.length > 1 ? splitSegment(flow.session, items, nextIndex, flow.budget()) : null;
      headExtra += split ? split.widths[0] : items.width(nextIndex);
      if (!split || split.texts.length === 1) {
        // Plus the word's own tail: `(<span>p50</span>,` never breaks inside word, edge and comma.
        headExtra += gluedRunWidth(items, nextIndex + 1);
      }
    }
  }
  return headExtra;
}

// ── The line breaker ──

/** One flow's line state: the committed lines and the one being filled. */
class LineFlow {
  readonly lines: FlowLine[] = [];
  line: FlowLine;
  /** At the start of content, or right after a forced break. */
  afterHardBreak = true;
  readonly m: Measurer;
  /** No soft wrapping at all: everything up to a forced break is one line. */
  readonly noWrap: boolean;
  /** `pre`, `pre-wrap` and `break-spaces` preserve leading and trailing white space. */
  readonly preservesWhitespace: boolean;
  private readonly keepsSpaceOnlyLines: boolean;

  constructor(
    readonly session: LayoutSession,
    readonly items: FlowItems,
    readonly contentWidth: number,
    private readonly whiteSpace: string,
    readonly useBulletProbe: boolean,
    private readonly textIndent: number,
    private readonly tabMetrics?: TabStops,
    private readonly strutLineHeight = 0,
  ) {
    this.m = session.measurer;
    this.line = this.newLine();
    this.noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
    this.keepsSpaceOnlyLines = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';
    this.preservesWhitespace =
      whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';
  }

  /** A line starts at the block's strut height: never shorter than its line-height. */
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
   * The current line holds an item whose `flags & mask` equals `value`. A loop, not `some`:
   * a closure here makes V8 allocate a context per call.
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
   * Advance to the next tab stop; a stop closer than half a space is skipped (Blink
   * Font::TabWidth). The tab placed is a piece of its own, at this flow's width.
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
    // Trim trailing spaces: `break-spaces` keeps them; `pre`/`pre-wrap` keep them except at
    // soft wraps (CSS Text 3 §4.1.1).
    const preserveTrailing = this.whiteSpace === 'break-spaces'
      || (this.preservesWhitespace && !isSoftWrap);
    if (!preserveTrailing) {
      while (line.length > 0 && this.isSpace(line[line.length - 1])) {
        current.totalWidth -= items.width(line[line.length - 1]);
        line.pop();
      }
    }
    // A soft wrap at a soft hyphen appends a visible '-'.
    if (isSoftWrap && line.length > 0) {
      const last = line[line.length - 1];
      if (items.flags(last) & SEG_SOFT_HYPHEN) {
        const refs = items.refs(last);
        const hyphenWidth = softHyphenAdvance(this.m, refs.style);
        // The '-' keeps the word's clip/stroke-image declarer, else it paints transparent.
        line.push(items.textOf(refs, '-', hyphenWidth));
        current.totalWidth += hyphenWidth;
      }
    }
    // In pre-wrap mode, space-only lines still need height (they are content)
    if (line.length > 0 || (hadWords && this.keepsSpaceOnlyLines)) {
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

/** The visible '-' of a soft-hyphen break, in the word's own measuring state. */
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
    // Clamped at 0: negative margins shrink the box, never the line.
    const extra = inlineBlockExtra(refs.boxStyle);
    lineHeight += Math.max(0, extra.top + extra.bottom);
  }
  return lineHeight;
}

/**
 * The ONE line breaker: the layout runs it at the used width, min-content at 0 and
 * max-content at Infinity. Phases: `breakBefore`, glue, `splitSegment`, `breakGluedChain`,
 * `placePiece` / `knifeEdgeOverflows`, then `LineFlow` commits.
 */
function flowLines(flow: LineFlow): FlowLine[] {
  const items = flow.items;
  const count = items.prepared.count;
  for (let i = 0; i < count; i++) {
    const lineHeight = itemLineHeight(flow, i);
    if (items.flags(i) & SEG_HARD_BREAK) {
      flow.forcedBreak(lineHeight);
      continue;
    }
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
 * The last segment of the glued chain starting at `start` (one word across runs:
 * `<span>E</span>xperience`, `<span>wel</span>l-being`), or `start` when none.
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
 * Break a word split across runs (`gluedChainEnd`) at its hyphens or break-word points,
 * which per-segment logic cannot see. False when it needs no breaking here.
 */
function breakGluedChain(flow: LineFlow, start: number, end: number): boolean {
  const { items, m } = flow;
  const startStyle = items.refs(start).style;
  const breakWord = startStyle.overflowWrap === 'break-word' || startStyle.wordBreak === 'break-all';
  let combined = 0;
  for (let j = start; j <= end; j++) combined += items.width(j);
  // Flatten into characters, each keeping its segment's refs: style, paint declarers and
  // `parentStyle` (a split vertical-align run must shift against its real parent).
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
  // A hyphen breaks whenever the unit does not fit; break-word only when it cannot fit a
  // whole line.
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
  // Place cells, splitting same-style runs into pieces: `chars` wraps between characters
  // (break-word), else the segment is placed atomically and may overflow.
  const placeCells = (cs: Cell[], chars: boolean) => {
    let i = 0;
    while (i < cs.length) {
      // Refs are 1:1 with the style run, so the run start's cover every piece.
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
  // Pure break-word is a last resort: wrap the whole word to a fresh line first.
  if (!hyphenMode && flow.line.items.length > 0) flow.wrap();
  for (const seg of segs) {
    const segW = measureSeg(seg);
    if (flow.line.items.length > 0 && flow.line.totalWidth + segW > flow.budget()) flow.wrap();
    // Char-break a segment only when break-word and it can't fit a line.
    placeCells(seg, breakWord && segW > flow.budget());
  }
  return true;
}

/** Flow one segment: split it if it breaks per character (`splitSegment`), place each piece. */
function placeSegment(flow: LineFlow, segment: number, lineHeight: number): void {
  const items = flow.items;
  // The pieces are consecutive items: the segment itself, or its cuts.
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

  // Before an emergency (break-word) split, take the whitespace opportunity first, as native
  // layout does; ordinary splits fill the current line.
  if (emergency && flow.holds(SEG_SPACE, 0)) flow.wrap();

  const gluedTailWidth = gluedRunWidth(items, segment + 1);
  for (let piece = pieceStart; piece < pieceEnd; piece++) {
    placePiece(flow, segment, piece, pieceStart, pieceEnd, gluedTailWidth, lineHeight);
  }
}

/**
 * The fit decision for one piece: wrap when it plus everything that must share its line
 * overflows (unless no line may start at it), then place it.
 */
function placePiece(
  flow: LineFlow, segment: number, piece: number, pieceStart: number, pieceEnd: number,
  gluedTailWidth: number, lineHeight: number,
): void {
  const { items, m, session } = flow;
  const pieceFlags = items.flags(piece);
  const isLastPiece = piece === pieceEnd - 1;
  const tail = trailingGlueWidth(items, piece, pieceEnd, gluedTailWidth);
  // Closing punctuation, a closing edge and a word continuation stay with the word before.
  const glued = cannotStartLine(breakBefore(items, piece, piece !== pieceStart)) &&
    flow.line.items.length > 0 && !flow.endsWithSpace();
  const headExtra = headGlueWidth(flow, segment, piece, isLastPiece, gluedTailWidth);

  // Chrome breaks at a soft hyphen only if the prefix PLUS its '-' fits: reserve it.
  let shReserve = 0;
  if (pieceFlags & SEG_SOFT_HYPHEN) {
    shReserve = softHyphenAdvance(m, items.refs(piece).style);
  }

  const pieceWidth = items.width(piece);
  const candidateLineWidth = flow.line.totalWidth + pieceWidth +
    shReserve + tail + headExtra;

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

  // Leading spaces are dropped, except preserved ones after a hard break.
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
 * Whether a line whose summed advances overflow by under 1px really does: re-measure it
 * as one string when its glyphs share one state. Only over the edge; a sum under it is
 * trusted (one string drops the kern against the hanging space Blink keeps).
 */
function knifeEdgeOverflows(flow: LineFlow, piece: number, tail: number, headExtra: number): boolean {
  const { items, m } = flow;
  // A tab's advance depends on its stop, which measureText('\t') ignores: trust the sum.
  if (flow.holds(SEG_TAB, SEG_TAB)) return true;
  const lineState = lineMeasureState(m, items, flow.line.items, piece);
  if (lineState === 'mixed') return true;
  // Under the full state every glyph shares, letter-spacing included.
  const state = lineState ?? m.stateOf(items.refs(piece).style);
  // Add back what the string misses: box-edge markers, atomic inline-blocks, and spaces set
  // in another state (`<b style="font-size:.7em"> </b>`).
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
  // Only a hair of sub-pixel overflow: a broader tolerance packs extra words.
  return fullWidth > flow.budget() + 0.02;
}

/** The widest line of a flow, the first standing `textIndent` further in. */
function widestLine(lines: readonly FlowLine[], textIndent: number): number {
  return lines.reduce(
    (widest, line, index) => Math.max(widest, index === 0 ? line.totalWidth + textIndent : line.totalWidth), 0);
}

/**
 * `-webkit-line-clamp` line budget shared across block descendants (Chrome legacy
 * `-webkit-box`). Known gap: a budget spent exactly at a paragraph end drops what follows
 * without an ellipsis.
 */
interface LineClampState {
  /** Line boxes still allowed before the cut. */
  remaining: number;
  /** Truncation point reached — all subsequent content is dropped. */
  exhausted: boolean;
}

/** True (and marks it exhausted) once a clamp has no lines left. */
function clampSpent(clamp: LineClampState | undefined): boolean {
  if (!clamp || !(clamp.exhausted || clamp.remaining <= 0)) return false;
  clamp.exhausted = true;
  return true;
}

/**
 * The final flow's widths for segments preparing could not size (inline-blocks,
 * percentage edges) at `containingWidth`, each inline-block laid out at its width.
 * Undefined when every prepared width stands.
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
    // The source node is the inner root; its box properties are applied here.
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
 * Re-resolve `node`'s children's percentages against `cbWidth`. Inline boxes pass it on to
 * their children; blocks and inline-blocks resolve their own when laid out.
 */
function resolveChildPercentages(node: StyledNode, cbWidth: number): void {
  for (const child of node.children) {
    if (child.tagName === '#text') continue;
    resolvePercentages(child.style, cbWidth);
    const display = child.style.display;
    if (display === 'inline' || display === 'contents') resolveChildPercentages(child, cbWidth);
  }
}

// ── Bidi reordering ──

/**
 * Per line, per word, UAX #9 levels after L1 (`null` for a padding marker or a line that
 * needs none; `null` overall for a paragraph without RTL). Resolved over the whole
 * paragraph, as W2/W7 look across lines; an atomic inline is one U+FFFC.
 */
function resolveLineBidi(
  lines: PositionedLine[], rtl: boolean,
): Array<Array<Uint8Array | null> | null> | null {
  let needed = rtl;
  for (let i = 0; !needed && i < lines.length; i++) {
    for (const w of lines[i].words) {
      let rtlContext = false;
      for (let c = w.refs.bidi; c && !rtlContext; c = c.parent) rtlContext = mayNeedBidi(c.open);
      if (rtlContext || mayNeedBidi(w.text)) { needed = true; break; }
    }
  }
  if (!needed) return null;

  const builder = new BidiTextBuilder();
  const starts = lines.map((line) => {
    const at = line.words.map((w) => w.text === ''
      ? -1
      : builder.push(isAtomicInlineBlock(w) ? '\uFFFC' : w.text, w.refs.bidi ?? null));
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
function withDirection(session: LayoutSession, style: ResolvedStyle, direction: 'ltr' | 'rtl'): ResolvedStyle {
  if (style.direction === direction) return style;
  let copy = session.flippedDirection.get(style);
  if (!copy) session.flippedDirection.set(style, copy = { ...style, direction });
  return copy;
}

/** Can two visually adjacent pieces of one level paint as ONE fillText? */
function sameBidiRun(a: Word, b: Word): boolean {
  if (a.refs.boxStyle !== b.refs.boxStyle || a.refs.clipStyle !== b.refs.clipStyle ||
    a.refs.strokeImageStyle !== b.refs.strokeImageStyle || a.refs.parentStyle !== b.refs.parentStyle) return false;
  const p = a.refs.style;
  const q = b.refs.style;
  if (p === q) return true;
  if (p.fontFamily !== q.fontFamily || p.fontSize !== q.fontSize || p.fontWeight !== q.fontWeight ||
    p.fontStyle !== q.fontStyle || p.color !== q.color || p.textDecorationLine !== q.textDecorationLine) return false;
  // Decorations that would paint differently must not merge into one band.
  const da = p.textDecorations, db = q.textDecorations;
  if (da !== db) {
    if (!da || !db || da.length !== db.length) return false;
    for (let i = 0; i < da.length; i++) {
      if (da[i].line !== db[i].line || da[i].color !== db[i].color || da[i].style !== db[i].style ||
        !sameDecorationBand(da[i], db[i])) return false;
    }
  }
  return p.backgroundColor === q.backgroundColor &&
    p.letterSpacing === q.letterSpacing && p.wordSpacing === q.wordSpacing &&
    p.verticalAlign === q.verticalAlign && p.textShadow === q.textShadow &&
    p.webkitTextStrokeWidth === q.webkitTextStrokeWidth &&
    p.webkitTextStrokeColor === q.webkitTextStrokeColor;
}

/**
 * A line in ONE paint as a single run in the paragraph direction, so Canvas shapes it as
 * layout does (`CANVAS_BIDI_LINE`), only when Canvas alone reaches the paragraph's
 * levels for it (not when W2/W7/N1 reach across a wrap). `null` otherwise.
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
      w.refs.bidi !== first.refs.bidi || !sameBidiRun(first, w)) return null;
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
 * One line's words as level-uniform pieces in VISUAL order (UAX #9 L2). A word with mixed
 * levels is cut, sharing its width by measure. Padding markers go at the visual edges of
 * their box's content. Adjacent pieces of one non-zero level and paint merge into one run
 * (one fillText); level-0 words never merge. `keys` give each piece its logical position.
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
    const state = m.stateOf(word.refs.style);
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

  // Markers are not characters: reorder the content alone, then put each marker at its
  // box's visual edge (`<code>render()</code>` in Arabic).
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
    const closing = !!marker.refs.boxClose && !marker.refs.boxOpen;
    // The box's content on this line: between the marker and its partner
    // (or the line edge when the partner is on another line).
    let from = i + 1;
    let to = items.length;
    if (closing) {
      from = 0;
      to = i;
      for (let j = i - 1; j >= 0; j--) {
        if (levels[j] < 0 && items[j].refs.boxOpen === marker.refs.boxClose && !items[j].refs.boxClose) { from = j + 1; break; }
      }
    } else if (marker.refs.boxOpen) {
      for (let j = i + 1; j < items.length; j++) {
        if (levels[j] < 0 && items[j].refs.boxClose === marker.refs.boxOpen && !items[j].refs.boxOpen) { to = j; break; }
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
        // The flow's own advances (measured with context), not a fresh measure of the joined text.
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

/** One inline context's layout output and the state its lines share (`emitLine` appends). */
interface InlineEmit {
  readonly session: LayoutSession;
  readonly useBulletProbe: boolean;
  /**
   * The block's style: its strut seeds every line's height AND baseline, so small inline
   * text sits on the block-font baseline. Also the parent of runs with no inline ancestor.
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
   * Text nodes under a clip / stroke-image declarer, to its style (`assignInlineFragmentBoxes`).
   */
  readonly clipRuns: Map<LayoutText, ResolvedStyle>;
  readonly strokeImageRuns: Map<LayoutText, ResolvedStyle>;
}

/**
 * Lay out inline content: `flowInlineLines`, `clampLines`, `emitLine` per line, then
 * `assignInlineFragmentBoxes`.
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
  // An ancestor's clamp already used its line budget — drop this content.
  if (clampSpent(clamp)) {
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

/** The final flow of `prepared` at `contentWidth`, inline-blocks laid out first. */
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
  // The block's strut: the minimum height of every line box.
  const strutLineHeight = m.lineHeight(node.style, useBulletProbe);
  const items = new FlowItems(prepared, prepared.refs, used?.widths, used?.layouts);
  const lines: PositionedLine[] = flowLines(new LineFlow(
    session, items, contentWidth, node.style.whiteSpace, useBulletProbe, textIndent, tabMetrics, strutLineHeight,
  )).map((line) => ({
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
 * `-webkit-line-clamp`: keep N lines and end the Nth with "…". The budget is an
 * ancestor's shared clamp when one is active, else this element's own.
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
    // A first-line cut also loses the text-indent.
    const lineMaxForEllipsis = contentWidth - (clampN === 1 ? (style.textIndent || 0) : 0);
    applyEllipsisToLine(session, lastLine, lineMaxForEllipsis);
    // The ellipsis ends the line; it is not a source hard break.
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
 * The left edge of a line under physical `align`. A line overflowing its container falls
 * back to its start edge (CSS Text 3 §7.1), with sub-pixel tolerance; an RTL start is the
 * right edge, `x + lineMaxWidth` (which already excludes the indent).
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

/** Lay out one committed line at `y`: nodes, `LayoutLine` and line box. Returns its height. */
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

  const indent = isFirstLine ? out.textIndent : 0;
  const lineMaxWidth = out.contentWidth - indent;

  let justifyExtraPerSpace = 0;
  if (align === 'justify' && line.totalWidth < lineMaxWidth) {
    const spaceCount = line.words.filter(w => w.isSpace).length;
    if (spaceCount > 0) {
      justifyExtraPerSpace = (lineMaxWidth - line.totalWidth) / spaceCount;
    }
  }

  let curX = alignedLineStart(out, line.totalWidth, align, indent, lineMaxWidth);
  const lineLeftX = curX;

  if (line.words.length === 0) {
    out.lineBoxes.push({
      x: lineLeftX, y, width: 0, height: line.lineHeight,
      endedByHardBreak: !!line.endedByHardBreak,
    });
    return line.lineHeight;
  }

  const extent = lineBoxExtent(out, line.words);
  const lineBoxHeight = extent.ascent + extent.descent;
  const lineBaselineY = y + extent.ascent;

  // Bidi: level-uniform pieces in visual order, so both passes walk left to right.
  let emitWords = line.words;
  let emitLevels: number[] | null = null;
  let emitKeys: number[] | null = null;
  if (wordLevels) {
    ({ words: emitWords, levels: emitLevels, keys: emitKeys } = bidiLineItems(
      out.session.measurer, line.words, wordLevels, out.isRTL ? 1 : 0, justifyExtraPerSpace > 0));
    if (out.isRTL) {
      // An RTL line is anchored at its right edge; its pieces may measure differently.
      let total = 0;
      for (const w of emitWords) total += w.width + (w.isSpace ? justifyExtraPerSpace : 0);
      curX = curX + line.totalWidth - total;
    }
  }

  emitInlineBackgrounds(out, emitWords, curX, lineBaselineY, justifyExtraPerSpace);
  emitLineText(out, emitWords, emitLevels, emitKeys, curX, y, lineBaselineY, justifyExtraPerSpace);

  // Justified lines fill lineMaxWidth.
  const lineWidth =
    align === 'justify' && justifyExtraPerSpace > 0
      ? lineMaxWidth
      : line.totalWidth;
  const emittedLine: LayoutLine = {
    y: Math.round(lineBaselineY),
    // An inline-block contributes only its LAST row (earlier rows are lines of their own), and
    // nothing when it laid out no line.
    text: line.words.map((word) =>
      word.inlineBlockLayout?.lines.at(-1)?.text ?? (isAtomicInlineBlock(word) ? '' : word.text)).join(''),
    bounds: {
      x: lineLeftX,
      // The CSS line box; ink may overflow it, as in the DOM.
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
 * The line box's ascent and descent: the union of every box on it (strut, runs, shifted
 * runs, inline-blocks), each with its own leading: max(ascent - shift), max(descent + shift).
 */
function lineBoxExtent(out: InlineEmit, words: readonly Word[]): { ascent: number; descent: number } {
  const { session, useBulletProbe, blockStyle } = out;
  const m = session.measurer;
  const strutBox = m.leadedBox(blockStyle, useBulletProbe);
  let lineAscent = strutBox.ascent;
  let lineDescent = strutBox.descent;
  for (const word of words) {
    if (word.text === '') continue;
    // A wrapper with no text of its own is still a box with its own line-height; its children
    // carry it as `parentStyle`. Added at its own shift, so it matches the box a direct-text
    // run of it brings. Positive shift is downward.
    if (word.refs.parentStyle) {
      const parentBox = m.leadedBox(word.refs.parentStyle, useBulletProbe);
      const shift = verticalAlignShift(
        word.refs.parentStyle.verticalAlign, session, word.refs.parentStyle, blockStyle, useBulletProbe);
      if (parentBox.ascent - shift > lineAscent) lineAscent = parentBox.ascent - shift;
      if (parentBox.descent + shift > lineDescent) lineDescent = parentBox.descent + shift;
    }
    const own = m.leadedBox(word.refs.style, useBulletProbe);
    let ascent = own.ascent;
    let descent = own.descent;
    // An inline-block is an atomic box: its baseline with its margin box around it, unshifted,
    // as the emit pass ignores its vertical-align.
    const atomic = word.refs.boxStyle?.display === 'inline-block' ? word.refs.boxStyle : null;
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
  const va = word.refs.style.verticalAlign;
  return isShiftedVAlign(va)
    ? verticalAlignShift(va, out.session, word.refs.style, word.refs.parentStyle ?? out.blockStyle, out.useBulletProbe)
    : 0;
}

/** Emit an inline background box hanging off the line's baseline. */
function emitInlineBox(
  out: InlineEmit, style: ResolvedStyle, bx: number, bw: number, lineBaselineY: number, textWord?: Word,
): void {
  // Height from the box's OWN font; an inline-block's content box is its line-height.
  const { ascent: boxAscent, descent: boxDescent } =
    style.display === 'inline-block'
      ? out.session.measurer.leadedBox(style, out.useBulletProbe)
      : out.session.measurer.metrics(style);
  const padTop = style.paddingTop + style.borderTopWidth;
  const padBottom = style.paddingBottom + style.borderBottomWidth;
  const boxHeight = boxAscent + boxDescent + padTop + padBottom;
  // Every box hangs off the line's baseline, inline-blocks too, so it stays with its glyphs.
  let baselineY = lineBaselineY;
  // A shifted run's band moves by the same `wordBaselineShift` as its glyphs (not an
  // inline-block's: its vertical-align is ignored).
  if (textWord && style.display !== 'inline-block') {
    if (isShiftedVAlign(textWord.refs.style.verticalAlign)) {
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
 * The line's inline background boxes from `startX`: one per run of words sharing a box
 * style (when it holds text), one per atomic inline-block.
 */
function emitInlineBackgrounds(
  out: InlineEmit, words: readonly Word[], startX: number, lineBaselineY: number, justifyExtraPerSpace: number,
): void {
  let scanX = startX;
  let boxStartX = scanX;
  let currentBoxStyle: ResolvedStyle | undefined;
  // The open box group's first text word: decides whether its band is emitted and where.
  let boxTextWord: Word | undefined;

  for (const word of words) {
    if (word.refs.boxOpen && word.refs.boxClose && word.text) {
      if (currentBoxStyle) {
        if (boxTextWord) emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
        currentBoxStyle = undefined;
        boxTextWord = undefined;
      }
      const s = word.refs.style;
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

    if (word.refs.boxStyle !== currentBoxStyle) {
      if (currentBoxStyle && boxTextWord) {
        emitInlineBox(out, currentBoxStyle, boxStartX, scanX - boxStartX, lineBaselineY, boxTextWord);
      }
      currentBoxStyle = word.refs.boxStyle;
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
  if (word.refs.clipStyle) out.clipRuns.set(node, word.refs.clipStyle);
  if (word.refs.strokeImageStyle) out.strokeImageRuns.set(node, word.refs.strokeImageStyle);
}

/**
 * The line's text nodes, left to right from `startX`; a bidi line's are put back in
 * logical order (`keys`), the document order consumers expect.
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
    if (word.refs.boxOpen && word.refs.boxClose) {
      const s = word.refs.style;
      const textX = curX + s.marginLeft + s.borderLeftWidth + s.paddingLeft;
      if (word.inlineBlockLayout) {
        const ib = word.inlineBlockLayout;
        const contentY = lineBaselineY - ib.baselineOffset + s.marginTop +
          s.borderTopWidth + s.paddingTop;
        emitInlineBlockContent(out, ib, textX, contentY);
        curX += word.width;
        continue;
      }
      const m = out.session.measurer;
      const textWidth = m.width(m.stateOf(word.refs.style), word.text);
      registerTextNode(out, {
        type: 'text',
        text: word.text,
        // An RTL run is anchored at its right edge (`PaintState.text` sets textAlign).
        x: word.refs.style.direction === 'rtl' ? textX + textWidth : textX,
        y: lineBaselineY,
        width: textWidth,
        style: word.refs.style,
      }, word, lineTop);
      curX += word.width;
      continue;
    }

    let baselineY = lineBaselineY;
    if (isShiftedVAlign(word.refs.style.verticalAlign)) baselineY += wordBaselineShift(out, word);
    const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);
    // A bidi piece paints in its level's direction; an RTL one is anchored
    // at its right edge (`PaintState.text` sets textAlign).
    const rtlPiece = levels !== null && levels[wordIndex] % 2 === 1;

    registerTextNode(out, {
      type: 'text',
      text: word.text,
      x: rtlPiece ? curX + effectiveWidth : curX,
      y: baselineY,
      width: effectiveWidth,
      // Paint direction is the bidi LEVEL's, never the CSS `direction` (unicode-bidi: normal
      // reorders nothing).
      style: withDirection(out.session, word.refs.style, rtlPiece ? 'rtl' : 'ltr'),
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

/** An inline-block's layout at (textX, contentY); rows before the last become lines. */
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
 * Give each run under an inline paint declarer (background-clip:text, stroke image) a
 * paint box spanning the declarer's fragment on its line. A wrap starts a new fragment
 * (box-decoration-break: clone; Chrome's default `slice` would continue it).
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

// ── Block layout ──

/**
 * Adjoining vertical margins (CSS 2.1 §8.3.1): the largest positive plus the most negative,
 * which pairwise folding misses (10, -5, 20 is 15).
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
 * Whether the box roots a block formatting context (its margins never collapse with its
 * children's). Flex items, table cells and the root are told so by their caller.
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
 * Whitespace that collapses away (no line box). A newline reaching layout is always a
 * forced break, so it makes one.
 */
function isCollapsibleWhitespace(node: StyledNode): boolean {
  if (node.tagName !== '#text') return false;
  const ws = node.style.whiteSpace;
  const text = node.textContent ?? '';
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return text === '';
  return /^[ \t\f]*$/.test(text);
}

/**
 * Whether inline content makes a line box (CSS 2.1 §9.4.2): text, preserved white space, an
 * atomic inline, or an inline with inline-axis margin/border/padding. An empty `<span>` does not.
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
 * A block whose top and bottom margins adjoin: no line box, padding, border or min-height,
 * and every in-flow child collapses through too.
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
 * Every margin adjoining this block's top: its own and, unless padding, border or a BFC
 * intervene, its first in-flow child's, recursively.
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
 * Lay out a block and its children. `y` is the border-box top (the caller resolved the
 * margins above, `leadingStrut`); margins leaving the bottom return as `marginBottomOut`.
 * `bfcRoot`: a BFC root by position (the root, a flex item, a table cell).
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

  // `-webkit-line-clamp` here starts a line budget shared with descendants (Chrome legacy
  // -webkit-box); an ancestor's clamp wins.
  if (!clamp && style.lineClamp > 0) {
    clamp = { remaining: style.lineClamp, exhausted: false };
  }

  const borderTop = style.borderTopWidth;
  const borderBottom = style.borderBottomWidth;
  const padTop = style.paddingTop;
  const padBottom = style.paddingBottom;
  const boxX = x + style.marginLeft;
  // An explicit width sizes the box `box-sizing` names; otherwise the box fills the width.
  let boxWidth: number;
  let contentWidth: number;
  if (style.width > 0) {
    const frame = horizontalFrame(style);
    boxWidth = borderBoxSize(style, style.width, frame);
    contentWidth = contentBoxSize(style, style.width, frame);
  } else {
    boxWidth = availableWidth - style.marginLeft - style.marginRight;
    contentWidth = Math.max(0, boxWidth - style.borderLeftWidth - style.borderRightWidth - style.paddingLeft - style.paddingRight);
  }
  const contentX = boxX + style.borderLeftWidth + style.paddingLeft;
  // Its own text-indent/gap and its children's percentages, against the
  // width just settled.
  resolvePercentages(style, contentWidth, true);
  resolveChildPercentages(node, contentWidth);
  const minHeight = style.minHeight > 0
    ? borderBoxSize(style, style.minHeight, borderTop + padTop + padBottom + borderBottom)
    : 0;

  const contentStartY = y + borderTop + padTop;
  const ownMarginOut = withMargin(NO_MARGIN, style.marginBottom);
  const bulletProbe = BULLET_MARKERS.has(style.listStyleType);

  const box: LayoutBox = {
    type: 'box',
    style,
    x: boxX,
    y,
    width: boxWidth,
    height: 0, // computed below
    tagName: node.tagName,
    children: [],
    listMarker: node.listMarker,
  };

  if (style.display === 'flex' || style.display === 'table') {
    const result = (style.display === 'flex' ? layoutFlex : layoutTable)(session, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: ownMarginOut };
  }

  // An empty block has no line boxes, except a list item's outside marker (Chrome, WebKit).
  if (node.children.length === 0) {
    const markerLine = hasMarkerLine(node)
      ? session.measurer.lineHeight(style, bulletProbe)
      : 0;
    box.height = borderTop + padTop + markerLine + padBottom + borderBottom;
    if (minHeight > 0) box.height = Math.max(box.height, minHeight);
    return { box, height: box.height, marginBottomOut: ownMarginOut };
  }

  if (hasOnlyInlineChildren(node)) {
    const { nodes, height, lines, lineBoxes } = layoutInlineContent(
      session, node, contentX, contentStartY, contentWidth, node.tagName === 'li' && bulletProbe, clamp);
    session.lines.push(...lines);
    box.children = nodes;
    box.lineBoxes = lineBoxes;
    box.height = borderTop + padTop + height + padBottom + borderBottom;
  } else {
    // Stack block children, collapsing margins (CSS 2.1 §8.3.1).
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

      // Line-clamp spent: drop everything below the cut, its trailing margin too.
      if (clampSpent(clamp)) {
        pending = NO_MARGIN;
        break;
      }

      if (isInline(child)) {
        const inlineChildren: StyledNode[] = [child];
        while (ci + 1 < node.children.length && isInline(node.children[ci + 1])) inlineChildren.push(node.children[++ci]);
        // Content that makes no line box (collapsible whitespace, an empty
        // inline), so margins keep collapsing across it.
        if (!inlineChildren.some(createsLineBox)) continue;

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
        const { nodes, height, lines, lineBoxes } = layoutInlineContent(
          session, inlineGroup, contentX, curY, contentWidth, node.tagName === 'li' && bulletProbe, clamp);
        session.lines.push(...lines);
        box.children.push(...nodes);
        (box.lineBoxes ??= []).push(...lineBoxes);
        curY += height;
        continue;
      }

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
    let marginBottomOut = ownMarginOut;
    let contentEnd = curY - contentStartY;
    // A list item with nothing in flow but its marker (MARKER_LINE_WITHOUT_CONTENT).
    if (atTop && hasVisibleMarker(node)) {
      if (!bfcRoot && bottomAdjoinsChildren(style)) pending = throughStrut;
      if (MARKER_LINE_WITHOUT_CONTENT) {
        contentEnd = Math.max(contentEnd,
          session.measurer.lineHeight(style, bulletProbe));
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
  return { box, height: box.height, marginBottomOut: ownMarginOut };
}

// ── Table layout ──

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

  const rowCells = rows.map(r => r.children.filter(c => c.tagName === 'td' || c.tagName === 'th'));
  const colCount = Math.max(...rowCells.map(cells => cells.length));
  if (colCount === 0) return { children, height: 0 };

  // Equal column widths (simple approach)
  const colWidth = contentWidth / colCount;

  let curY = contentY;

  for (const cells of rowCells) {
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

// ── Flex layout ──

/**
 * Bare text in a flex container is an anonymous flex item, built once per text node (the
 * content-size caches key by identity). It inherits the container's style with every box
 * property at its initial value.
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
 * A flex container's items: a bare text node counts only with actual text, the same answer
 * for sizing and layout.
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

/** Min- or max-content width of an inline context: the real flow at 0 or at Infinity. */
function inlineContentSize(session: LayoutSession, node: StyledNode, max: boolean): number {
  const prepared = preparedInline(session, node);
  let refs = prepared.refs;
  let widths: number[] | undefined;
  if (!max) {
    // CSS ignores `overflow-wrap:break-word` for min-content. One copy per
    // source style: font state is keyed by style identity, and runs must glue.
    const breaksWords = (r: SegmentRefs) =>
      r.style.overflowWrap === 'break-word' && r.style.wordBreak !== 'break-all';
    if (refs.some(breaksWords)) {
      const neutralized = new Map<ResolvedStyle, ResolvedStyle>();
      refs = refs.map((r) => {
        if (!breaksWords(r)) return r;
        let style = neutralized.get(r.style);
        if (!style) neutralized.set(r.style, style = { ...r.style, overflowWrap: 'normal' });
        return { ...r, style };
      });
    }
    // Prepared inline-blocks stand at max-content.
    for (const i of prepared.inlineBlocks) {
      const source = prepared.refs[prepared.ref[i]].inlineBlock!;
      widths ??= prepared.width.slice();
      widths[i] = inlineBlockOuterWidth(session, source, intrinsicStyle(source.style), 0);
    }
  }
  const textIndent = intrinsicStyle(node.style).textIndent;
  return widestLine(flowLines(new LineFlow(
    session, new FlowItems(prepared, refs, widths), max ? Infinity : 0, node.style.whiteSpace, false, textIndent)), textIndent);
}

/**
 * Min- or max-content width of `node`'s content box, memoized per call. Percentages inside
 * are cyclic, so descendants read `intrinsicStyle`.
 */
function contentSize(session: LayoutSession, node: StyledNode, max: boolean): number {
  const memo = max ? session.maxContent : session.minContent;
  const memoized = memo.get(node);
  if (memoized !== undefined) return memoized;
  const contribution = max ? maximumContribution : minimumContribution;
  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = inlineContentSize(session, node, max);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(session, node);
    for (const child of children) content += contribution(session, child, intrinsicStyle(child.style));
    content += intrinsicStyle(node.style).gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, contribution(session, child, intrinsicStyle(child.style)));
      }
    }
  }
  memo.set(node, content);
  return content;
}

/**
 * Min-content contribution of `node` as a margin-box width, its box read from `style`
 * (`node.style` for a flex item, else `intrinsicStyle`).
 */
function minimumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  const frame = horizontalFrame(style);

  // An explicit min-width disables the flex automatic min-content size.
  if (style.minWidth !== null) {
    return margins + borderBoxSize(style, style.minWidth, frame);
  }

  let borderBox = frame + contentSize(session, node, false);
  // A definite width caps the automatic minimum size in the flex algorithm.
  if (style.width > 0) borderBox = Math.min(borderBox, borderBoxSize(style, style.width, frame));
  return margins + borderBox;
}

/** Max-content contribution of `node`, in the same outer currency (see `minimumContribution`). */
function maximumContribution(session: LayoutSession, node: StyledNode, style: ResolvedStyle): number {
  const margins = horizontalMargins(style);
  // A definite width IS the max-content size.
  if (style.width > 0) return margins + borderBoxSize(style, style.width, horizontalFrame(style));
  return margins + horizontalFrame(style) + contentSize(session, node, true);
}

/**
 * An inline-block's content width with `available` px left: its own width, else
 * shrink-to-fit (CSS 2.1 §10.3.9), floored at min-width. At 0 / Infinity that is min- /
 * max-content, so sizing and the final flow ask the same question.
 */
function inlineBlockContentWidth(
  session: LayoutSession, node: StyledNode, style: ResolvedStyle, available: number,
): number {
  const frame = horizontalFrame(style);
  // An inline-block's content is ONE inline flow, block children included, sized by it.
  const inlineOnly = hasOnlyInlineChildren(node);
  let width = style.width > 0
    ? contentBoxSize(style, style.width, frame)
    : Math.min(
      inlineOnly ? contentSize(session, node, true) : inlineContentSize(session, node, true),
      Math.max(inlineOnly ? contentSize(session, node, false) : inlineContentSize(session, node, false), available),
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
 * Flex base size as an outer width: `flex-basis` (sizing the `box-sizing` box), or for
 * `auto` the item's max-content. `flex: 1` makes it 0, so grow factors alone split the row.
 */
function flexBaseSize(session: LayoutSession, node: StyledNode): number {
  return node.style.flexBasis !== null
    ? horizontalMargins(node.style) + borderBoxSize(node.style, node.style.flexBasis, horizontalFrame(node.style))
    : maximumContribution(session, node, node.style);
}

/**
 * Flexible length resolution over outer widths (CSS Flexbox §9.7): each pass shares the
 * free space and freezes items under their automatic minimum, until none is clamped.
 * flex-parity.
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
    const totalGaps = gap * (flexChildren.length - 1);
    const available = Math.max(0, contentWidth - totalGaps);
    // If the minima themselves do not fit, they overflow the container exactly
    // as native flex items with min-width:auto do.
    const widths = resolveFlexibleLengths(
      flexChildren.map((child) => child.style),
      flexChildren.map((child) => flexBaseSize(session, child)),
      flexChildren.map((child) => minimumContribution(session, child, child.style)),
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

// ── List marker layout ──

/** Add list marker to a layout box if applicable. */
function addListMarker(
  session: LayoutSession,
  box: LayoutBox,
  node: StyledNode,
): void {
  if (!node.listMarker) return;
  // `::marker { content: none }` suppresses the marker.
  if (node.markerHidden) return;

  const style = node.style;
  // `markerStyle` holds only the fields `::marker` rules changed.
  const ms = node.markerStyle;
  const markerStyleObj: ResolvedStyle = ms ? { ...style, ...ms } : style;

  // The marker measures in its own style, as it is painted.
  const m = session.measurer;
  const markerState = m.stateOf(markerStyleObj);
  // ascent + descent is the li's line-height by construction, so one call
  // gives both the marker's baseline and the box it reports.
  const strut = m.leadedBox(style);
  const baselineY = box.y + style.borderTopWidth + style.paddingTop + strut.ascent;

  const markerWidth = m.width(markerState, node.listMarker);
  const isRTL = style.direction === 'rtl';
  const isBullet = BULLET_MARKERS.has(style.listStyleType);
  // Marker gap, matching Chrome: a bullet's ink ends 7px + ascent/3 before the content,
  // centered ascent/3 above the baseline; a text marker ("1.") is one space advance away.
  // `::marker` padding-inline-end overrides the gap.
  const explicitGap = isRTL ? ms?.paddingLeft : ms?.paddingRight;

  let markerX: number;
  let markerY = baselineY;
  let markerDirection = 'ltr';
  // What the glyph is DRAWN with: numbers at the li font, bullets scaled (below).
  let markerDrawStyle: ResolvedStyle = markerStyleObj;
  let markerDrawWidth = markerWidth;
  const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
  const boxRightEdge = box.x + box.width;
  if (isBullet) {
    const { ascent } = m.metrics(markerStyleObj);
    const ink = m.measureText(markerState, node.listMarker);
    // Blink's marker unit (a 2/3-ascent box, half-filled): disc diameter, gap and centering.
    const markerUnit = ascent / 3;
    const gap = explicitGap !== undefined ? explicitGap : 7 + markerUnit;
    // Chrome paints a SYNTHETIC disc, larger than the font's '•' (Roboto ~0.22em vs ~0.31em):
    // scale the glyph so its ink height is markerUnit, keeping it a text node.
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
      // RTL: marker right of the li; a numbered one paints RTL (".1") with x as its right edge.
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

  // Publish the marker as a LayoutLine too, merged with its item's text by baseline.
  // bounds.width is the scaled glyph ADVANCE, not its ink.
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

// ── Main entry ──

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

/** Build the layout tree from the styled tree with canvas measurement only. */
export function buildLayoutTree(
  ctx: CanvasRenderingContext2D,
  styledTree: StyledNode,
  containerWidth: number,
  useDomMeasurements: boolean,
  debug?: (entry: import('./types.ts').DebugEntry) => void,
  stats?: LayoutStats,
): { root: LayoutBox; height: number; lines: LayoutLine[] } {
  // Everything starts empty with the call: fonts may have loaded since the last one.
  const fontMetrics: FontMetricsTable = new Map();
  const session: LayoutSession = {
    measurer: new Measurer(ctx, fontMetrics, useDomMeasurements),
    debug,
    lines: [],
    minContent: new Map(),
    maxContent: new Map(),
    anonymousFlexItems: new Map(),
    prepared: new Map(),
    flippedDirection: new Map(),
    stats,
  };
  // The styledTree root is our container div — layout its children as a block flow
  const { box, height } = layoutBlock(session, styledTree, 0, 0, containerWidth, undefined, true);

  addListMarkersRecursive(session, box, styledTree);

  // By baseline, then left edge: cross-cell content merges in reading order, markers first.
  const sorted = session.lines.sort((a, b) =>
    (a.y - b.y) || (a.bounds.x - b.bounds.x)
  );
  const lines: LayoutLine[] = [];
  for (const candidate of sorted) {
    const last = lines[lines.length - 1];
    // Two baselines are one row within half the SHORTER line's height, as the DOM reference
    // groups (`overlap / minH`); max() or the candidate alone leaks across rows.
    const tolerance = Math.min(last?.bounds.height ?? Infinity,
      candidate.bounds.height) * 0.5;
    if (last && Math.abs(candidate.y - last.y) < tolerance) {
      // Cross-cell merge: separate with a space unless either side has one.
      const needsSep = last.text.length > 0 && candidate.text.length > 0 &&
        !/\s$/.test(last.text) && !/^\s/.test(candidate.text);
      last.text += (needsSep ? ' ' : '') + candidate.text;
      // Carry the baseline forward so the next comparison uses the group's running edge.
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

  // box.children may hold extra text/inline nodes: walk both in parallel.
  let boxChildIdx = 0;
  for (const styledChild of node.children) {
    if (isInline(styledChild)) {
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
