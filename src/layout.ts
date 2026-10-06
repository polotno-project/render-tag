import type { StyledNode, LayoutNode, LayoutBox, LayoutText, ResolvedStyle, LayoutLine, LayoutLineBox, DecorationEntry } from './types.js';
import { isTransparent } from './css-resolver.js';
import { IS_GECKO, IS_SAFARI } from './engine.js';
export { INTEGER_PERCENT_LINE_HEIGHT } from './engine.js';
import {
  bidiContextFor, BidiTextBuilder, lineLevels, mayNeedBidi, resolveBidi, visualOrder,
  type BidiContext,
} from './bidi.js';

// Module-level flag controlling DOM measurement usage.
// Set by buildLayoutTree() based on the useDomMeasurements option.
let _useDomMeasurements = true;
let _debug: ((entry: import('./types.ts').DebugEntry) => void) | undefined;

// Lines emitted during layout. Reset at the start of buildLayoutTree();
// layoutInlineContent appends one entry per committed line.
let _lines: LayoutLine[] = [];
const _minContentCache = new Map<StyledNode, number>();
const _maxContentCache = new Map<StyledNode, number>();

/**
 * The one canvas state every glyph on this line is measured under — only then
 * can the line be re-measured as a single string. `'mixed'` when the glyphs
 * need more than one, `null` when the line holds no glyph at all. Compared on
 * the interned `MeasureState`, i.e. on what the canvas is actually set to, not
 * on the raw declarations — `font-kerning: auto` and `normal` are one state.
 * Spaces do not count; the re-measure keeps their own widths where they differ.
 */
function lineMeasureState(m: Measurer, words: Word[]): MeasureState | null | 'mixed' {
  let shared: MeasureState | null = null;
  for (const w of words) {
    if (!w.text || w.isSpace) continue;
    const state = m.stateOf(w.style);
    if (shared && state !== shared) return 'mixed';
    shared = state;
  }
  return shared;
}

// ─── Canvas font helpers ───────────────────────────────────────────────

/**
 * Set canvas font and kerning from resolved style.
 */
export function applyFont(ctx: CanvasRenderingContext2D, style: ResolvedStyle): void {
  ctx.font = buildCanvasFont(style);
  ctx.fontKerning = canvasKerning(style);
}

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
 * Build a canvas font string from resolved style. Results are cached.
 */
const _fontStringCache = new Map<string, string>();
export function buildCanvasFont(style: ResolvedStyle): string {
  const key = `${style.fontStyle}|${style.fontVariantCaps}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}`;
  const cached = _fontStringCache.get(key);
  if (cached) return cached;
  const parts: string[] = [];
  // CSS font shorthand order: style, variant, weight, size, family.
  if (style.fontStyle !== 'normal') parts.push(style.fontStyle);
  if (style.fontVariantCaps === 'small-caps') parts.push('small-caps');
  if (style.fontWeight !== 400) parts.push(String(style.fontWeight));
  parts.push(`${style.fontSize}px`);
  parts.push(style.fontFamily);
  const result = parts.join(' ');
  _fontStringCache.set(key, result);
  return result;
}

/**
 * Cache for DOM-measured line heights.
 * Key: "font|lineHeight|probeType" → actual pixel height from the browser.
 */
const _lineHeightCache = new Map<string, number>();

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
 * Results are cached per font+lineHeight+probeType combination.
 */
function measureDomLineHeight(font: string, lineHeight: string, useBulletProbe = false): number {
  const key = `${font}|${lineHeight}|${useBulletProbe ? 'ul-li' : 'block'}`;
  const cached = _lineHeightCache.get(key);
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

  _lineHeightCache.set(key, height);
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
// calls, so no width or metric is carried into the next call.

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

  /**
   * Spaces carry `word-spacing` in their own measured width, so the canvas
   * must not add any: a caller's ctx (or a paint left on a reused one) may
   * hold some. Cleared here, so no entry point can measure without it.
   */
  constructor(readonly ctx: CanvasRenderingContext2D) {
    const spacing = ctx as CanvasRenderingContext2D & { wordSpacing?: string };
    if (spacing.wordSpacing && spacing.wordSpacing !== '0px') spacing.wordSpacing = '0px';
  }

  /** Something other than this measurer may have set the ctx. */
  invalidate(): void {
    this.current = null;
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
      // Shared with `getFontMetrics`, which paint calls after layout.
      const font = fs.measure.font;
      let metrics = _fontMetricsCache.get(font);
      if (!metrics) {
        metrics = fontBox(this.measureText(fs.measure, 'M'));
        _fontMetricsCache.set(font, metrics);
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
    if (multiplier !== undefined && !_useDomMeasurements) {
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
    const slot = useBulletProbe && _useDomMeasurements ? 1 : 0;
    let lineHeight = fs.lineHeights[slot];
    if (lineHeight === undefined) {
      if (_useDomMeasurements) {
        lineHeight = measureDomLineHeight(
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
    const slot = useBulletProbe && _useDomMeasurements ? 1 : 0;
    let box = fs.boxes[slot];
    if (!box) {
      const { ascent, descent } = this.metrics(style);
      const lineHeight = this.lineHeight(style, useBulletProbe);
      const boxAscent = lineBaselineOffset(lineHeight, ascent, descent);
      box = fs.boxes[slot] = { ascent: boxAscent, descent: lineHeight - boxAscent };
    }
    return box;
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
    const prev = this.current;
    if (prev === state) return;
    const ctx = this.ctx;
    if (prev?.font !== state.font) ctx.font = state.font;
    if (prev?.kerning !== state.kerning) ctx.fontKerning = state.kerning;
    if (prev?.letterSpacing !== state.letterSpacing) ctx.letterSpacing = state.letterSpacing;
    this.current = state;
  }
}

/** The measurer of the layout call in progress. */
let _measurer: Measurer | null = null;

/**
 * The running layout call's measurer. Layout code only ever runs inside
 * `buildLayoutTree`; anything else measuring through here would get no
 * per-call cache and no idea of the ctx's state, so it throws instead.
 * (The public helpers `getFontMetrics` and `tabStopMetrics` have their own
 * path for a call outside layout.)
 */
function measurerFor(ctx: CanvasRenderingContext2D): Measurer {
  if (_measurer?.ctx !== ctx) throw new Error('render-tag: layout measured outside its layout call');
  return _measurer;
}

/** A font's ascent and descent, from any TextMetrics measured in it. */
function fontBox(m: TextMetrics): FontBox {
  return {
    ascent: m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent,
    descent: m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent,
  };
}

/** Blink (and server-side rendering, whose documented target is Blink) can
 * paint ordinary LTR words as one shaped source run without moving its DOM
 * raster. Gecko and WebKit keep the established word paint path. */
export const BLINK_TEXT_RUN_SHAPING = !IS_GECKO && !IS_SAFARI;

/**
 * True where one `fillText` of a whole bidi line paints it in the order and at
 * the advances the engine's own layout gives it, so a line in ONE paint can
 * stay one run (`bidiLineItems`). Blink: measured exact (Mixed LTR and RTL,
 * Multi-script single paragraph — every token at dx 0 against the DOM).
 * WebKit: not — the same single-run lines scored 6-16% against WebKit's DOM
 * and 0.00 once split into ordered level runs. Gecko keeps the single run it
 * always had; its Canvas runs the full UBA too, but that is not measured here.
 */
export const CANVAS_BIDI_LINE = !IS_SAFARI;

/**
 * True where the engine floors a line's baseline onto a whole CSS pixel.
 *
 * Blink does (`FontHeight::AddLeading`), and so does WebKit — over the
 * line-height it has already truncated (`TRUNCATES_LINE_HEIGHT`). Gecko lays
 * the exact half-leading out. An older corpus run gave Safari the exact value
 * because the floor ALONE lost there (214 wins against 223 losses): it was
 * tried over the untruncated line-height. Floor and truncation together match
 * WebKit's DOM (measured in Playwright WebKit, 1,768 of
 * 1,768 configurations: eight families, 8-56px, seventeen line-heights; the
 * system monospace is off by its own canvas metrics — see CLAUDE.md).
 */
export const FLOORS_LINE_BASELINE = !IS_GECKO;

/**
 * `super` and `sub` are engine constants, not CSS. Blink and WebKit share
 * theirs (`fontSize/3 + 1`, `fontSize/5 + 1`); Gecko raises by 0.34em and
 * lowers by 0.20em. A SEPARATE question from the rounding above — the two
 * flags happen to select the same engines today, which is no reason to read
 * one for the other.
 */
export const BLINK_SUPER_SUB = !IS_GECKO;

/**
 * True where the engine lays a line box out at a WHOLE-pixel line-height.
 *
 * WebKit alone does: it floors the computed line-height, a float32 product —
 * 16px x 1.6 is a 25px line, 20px x 1.15 is 23 (the double product is a hair
 * under), 23.99999px is 23. Blink keeps the fraction (on its 1/64px grid) and
 * so does Gecko. A unitless number floors the font-size to 1/64px before it
 * multiplies (`multipliedLineHeight`): 13.6px x 1.25 is 16, not 17.
 * Exact, render-tag drifted 0.4-0.8px further down per line in
 * WebKit — about 83% of that lane's pixel residual. A separate question from
 * the floor above — Blink floors the baseline and keeps the line-height — so
 * never gate one on the other. A percentage `vertical-align` still resolves
 * against the exact value (measured: 50% of 25.6px moves 12.796875).
 */
export const TRUNCATES_LINE_HEIGHT = IS_SAFARI;

/**
 * True where the engine PAINTS each line box at a whole CSS pixel while its
 * layout stays fractional. Blink does: it rounds the line box's top
 * (`Math.round`, half up) and keeps every offset inside the line — the
 * baseline, a `vertical-align` shift — as laid out. Layout numbers are not
 * moved (the DOM's own layout baseline stays fractional; render-tag matches it
 * to ~0.01px), so this is a PAINT rule: see `paintLineSnap`.
 *
 * Measured against Chromium's DOM raster over fractional line tops (k/16 px),
 * six fonts, DPR 1, 2 and 3: a plain line matches pixel for pixel in 576 of
 * 576 configurations, at every DPR — so it is a CSS-pixel rule, not a device
 * pixel one (a canvas already lands `fillText` on a device pixel, which is why
 * DPR 1 looked right before). `super`/`sub`/length shifts follow the LINE's
 * snap, not their own: rounding each run's baseline instead puts `sub` and a
 * -2.7px shift a pixel off, and was worse than no snap at all for `super` at
 * DPR 2-3. Text in an inline-block snaps by its own inner line box.
 *
 * WebKit does NOT do this: it rounds the baseline to a DEVICE pixel (192 of
 * 192 at DPR 1 and 2, 176 of 192 at DPR 3), which needs the device scale at
 * paint time and is not modelled. Gecko keeps the unsnapped paint; UNVERIFIED
 * (Firefox cannot be measured here).
 */
export const SNAPS_LINE_PAINT = !IS_GECKO && !IS_SAFARI;

/**
 * Blink's auto underline position, measured from the SNAPPED baseline above:
 * the band's top edge sits `ceil(fontSize / 20)` px below it — half the auto
 * thickness (`fontSize / 10`) rounded up, the same rule an explicit
 * `text-decoration-thickness: T` follows (`ceil(T / 2)`). Font-independent:
 * 672 of 672 bands (six pinned fonts, 8-72px, DPR 1 and 2, fractional line
 * tops) and 198 of 198 across eleven system families up to 160px. WebKit's
 * gap is not this (1-3px, font-dependent); WebKit and Gecko keep the 0.105em
 * approximation.
 */
export const BLINK_UNDERLINE_GAP = !IS_GECKO && !IS_SAFARI;

/**
 * The top of the line box each run was laid out on, for `paintLineSnap`.
 * Kept off the public `LayoutText` shape: it is paint bookkeeping, keyed by the
 * node's identity the way the rest of the tree is.
 */
const runLineTops = new WeakMap<LayoutText, number>();

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

/**
 * What a min-height does to the margins leaving a block through its bottom
 * edge from its last child (measured with `margin-collapse-parity`):
 *
 * - `'drop'` (Blink): a min-height at or below the content height changes
 *   nothing. One that RAISES the box ends the run, and those margins are
 *   lost — neither added inside the box nor passed out (`min-height:30px`
 *   over a 20px line with a 16px child margin: the box is 30px, and the next
 *   sibling sits only its own margin below).
 * - `'collapse'` (WebKit): CSS 2.1 §8.3.1 to the letter — the condition is an
 *   'auto' height, and min-height is not part of it; the margins always pass
 *   out (`min-height:80px`, 40px child margin: next sibling 40px below).
 * - `'contain'` (Gecko): any nonzero min-height keeps the margins inside the
 *   box. render-tag's rule before the general collapse landed — kept because
 *   Firefox cannot be measured here; UNVERIFIED.
 */
/**
 * A list item whose children all collapse through (`<li><div style="margin:
 * 10px 0"></div></li>`) is not empty: its outside marker is content. Both
 * engines keep the children's margins adjoining the item's top AND bottom
 * (they do not join each other); Blink then gives the item the marker's line
 * box (20px at a 20px line-height), WebKit gives it no height. Measured in
 * Chromium and Playwright WebKit (margin-collapse-parity). Gecko gets
 * WebKit's answer, which is render-tag's rule from before the general
 * collapse; UNVERIFIED.
 */
export const MARKER_LINE_WITHOUT_CONTENT = !IS_GECKO && !IS_SAFARI;

export const MIN_HEIGHT_END_MARGINS: 'drop' | 'collapse' | 'contain' =
  IS_GECKO ? 'contain' : IS_SAFARI ? 'collapse' : 'drop';

/**
 * True where the engine lays a line-height out on its 1/64px grid: Blink's
 * LayoutUnit. Measured over 60+ font-size x line-height pairs in Chromium's
 * DOM (line pitch over 64 lines):
 *
 * - a NUMBER rounds the font-size onto the grid, multiplies, and rounds the
 *   product DOWN: 14px x 1.6 is a 22.390625px line, not 22.4; 15.31px x 1.15
 *   is 17.609375;
 * - a LENGTH (px, em, %) rounds to the NEAREST grid line: 22.4px is 22.40625
 *   (a percentage is an integer percentage first: INTEGER_PERCENT_LINE_HEIGHT);
 * - the half-leading is halved in LayoutUnits, truncating toward zero, before
 *   the baseline floor (`lineBaselineOffset`): Verdana 13.6px x 1.25 has its
 *   baseline at 14, where flooring the exact half gives 13.
 *
 * Exact, render-tag drifted ~0.01px a line from the DOM — invisible until
 * `SNAPS_LINE_PAINT` rounds every line top, where 45 lines of it move a line
 * across the rounding point (Long document: 3.2% -> 0). WebKit's whole-pixel
 * truncation (`TRUNCATES_LINE_HEIGHT`) is a separate rule of a separate
 * engine. Gecko lays out on its own 1/60px grid, not modelled (UNVERIFIED).
 */
export const LAYOUT_UNIT_LINE_HEIGHT = !IS_GECKO && !IS_SAFARI;

/** Not `normal`: a length, or zero (carried as the multiplier 0; css-resolver). */
function hasLineHeight(style: ResolvedStyle): boolean {
  return style.lineHeight > 0 || lineHeightMultiplier(style) === 0;
}

/** The line-height multiplier of a unitless `line-height` (css-resolver). */
function lineHeightMultiplier(style: ResolvedStyle): number | undefined {
  return (style as { _lineHeightMultiplier?: number })._lineHeightMultiplier;
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
  if (_measurer?.ctx === ctx) return { ..._measurer.tabStops(style) };
  const spacing = ctx as CanvasRenderingContext2D & { wordSpacing?: string };
  const prevLetterSpacing = ctx.letterSpacing;
  const prevWordSpacing = spacing.wordSpacing;
  const stops = new Measurer(ctx).tabStops(style);
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
 * Get font ascent and descent metrics. Results are cached per font string.
 * Inside a layout call, the call's own measurer answers.
 */
const _fontMetricsCache = new Map<string, { ascent: number; descent: number }>();
export function getFontMetrics(ctx: CanvasRenderingContext2D, style: ResolvedStyle): { ascent: number; descent: number } {
  if (_measurer?.ctx === ctx) return _measurer.metrics(style);
  const font = buildCanvasFont(style);
  const cached = _fontMetricsCache.get(font);
  if (cached) return cached;
  // Outside layout (paint, path decorations, the public API) the caller owns
  // the ctx's font: a measurement must not move it, or a cache miss would
  // leave different state behind than a hit.
  const prev = ctx.font;
  ctx.font = font;
  const result = fontBox(ctx.measureText('M'));
  ctx.font = prev;
  _fontMetricsCache.set(font, result);
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
  ctx: CanvasRenderingContext2D, style: ResolvedStyle, parentStyle: ResolvedStyle,
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
      const m = measurerFor(ctx);
      return m.leadedBox(style, useBulletProbe).ascent - m.metrics(parentStyle).ascent;
    }
    case 'text-bottom': {
      const m = measurerFor(ctx);
      return m.metrics(parentStyle).descent - m.leadedBox(style, useBulletProbe).descent;
    }
    // The midpoint of the LEADED box (CSS 2.1 §10.8.1 aligns "the vertical
    // midpoint of the box" — the box with its half-leading). Where the engine
    // floors the half-leading that is up to 0.5px off the content area's
    // midpoint — measured in Chrome and WebKit alike, a 30px/60px middle on an
    // 18px/2 line: DOM 34.70, content-area
    // midpoint 34.0, leaded 34.5. (The rest is x-height, approximated 0.5em.)
    case 'middle': {
      const { ascent, descent } = measurerFor(ctx).leadedBox(style, useBulletProbe);
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
        ? -(n / 100) * measurerFor(ctx).computedLineHeight(style, useBulletProbe)
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

interface Word {
  text: string;
  width: number;
  style: ResolvedStyle;
  /** See `TextRun.parentStyle`. */
  parentStyle?: ResolvedStyle;
  isSpace: boolean;
  /** Tab character — width computed dynamically based on position */
  isTab?: boolean;
  /** Word came from soft-hyphen split — show '-' if this word ends a line */
  isSoftHyphenBreak?: boolean;
  /**
   * No soft-wrap opportunity before this word: it abuts the previous word with
   * no whitespace (e.g. adjacent inline spans `<span>a</span><span>b</span>`),
   * so the browser treats them as one unbreakable unit at that boundary.
   */
  noBreakBefore?: boolean;
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box (adds left padding/border) */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box (adds right padding/border) */
  boxClose?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
  inlineBlock?: StyledNode;
  inlineBlockLayout?: InlineBlockLayout;
  /** See `TextRun.bidi`. */
  bidi?: BidiContext | null;
}

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
  ctx: CanvasRenderingContext2D,
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
  const m = measurerFor(ctx);
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
    // Inline-block always needs box treatment (padding/margin affect layout)
    const isBox = isInlineBlock || (isInline(n) && hasVisibleBoxStyles(n.style));
    const newBoxStyle = isBox ? n.style : boxStyle;
    // Track the nearest inline element declaring a background-clip:text
    // background or a --rt-text-stroke-image, so those paints reach descendant
    // runs that don't carry the (non-inheriting) properties themselves.
    const newClipStyle = isInline(n) && hasTextClip(n.style) ? n.style : clipStyle;
    const newStrokeImageStyle =
      isInline(n) && n.style.webkitTextStrokeImage && n.style.webkitTextStrokeImage !== 'none'
        ? n.style : strokeImageStyle;
    const hasHorizSpacing = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    if (isInlineBlock) {
      // Inline-block is fully atomic — the entire element (margins + padding + text)
      // wraps as one unit. We emit a single "atomic" TextRun with a special marker
      // so the tokenizer creates one non-splittable word with the full box width.
      const allText = n.element?.textContent || '';
      runs.push({
        text: allText,
        style: n.style,
        wordBoundaryBefore: true,
        parentStyle,
        boxStyle: newBoxStyle,
        clipStyle: newClipStyle,
        strokeImageStyle: newStrokeImageStyle,
        // Store the full box info for atomic inline-block handling
        boxOpen: n.style,  // signals this is a boxed element
        boxClose: n.style,
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
        child, isBox ? newBoxStyle : boxStyle, newClipStyle, newStrokeImageStyle,
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

let _segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter) return _segmenter;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return _segmenter;
  }
  return null;
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
 * (`breakWordIfNeeded`) at the last character.
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

/**
 * Tokenize a single string into words based on whitespace mode.
 */
function tokenizeString(m: Measurer, text: string, run: TextRun, allWords: Word[], cumState?: Cumulative): void {
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
      const prevLen = allWords.length;
      tokenizeString(m, part, run, allWords, sharedState);
      if (nextIsSoftHyphen && prevLen > 0) {
        allWords[prevLen - 1].isSoftHyphenBreak = true;
      }
      nextIsSoftHyphen = false;
    }
    if (nextIsSoftHyphen && allWords.length > 0) {
      allWords[allWords.length - 1].isSoftHyphenBreak = true;
    }
    return;
  }

  // Every width below is the run's own: its font, kerning and letter-spacing.
  const state = m.stateOf(run.style);

  // `pre-line` preserves newlines (handled by the \n pre-split in
  // tokenizeRuns) but collapses spaces and tabs — so it goes through the
  // non-preserving branch below, same as `normal`.
  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'break-spaces';

  if (isPreserve) {
    // Split on spaces and tabs, keeping delimiters
    const words = text
      .split(/( +|\t)/)
      .flatMap((word) => /^( +|\t)$/.test(word) ? [word] : splitHyphenated(word));
    const tabStopInterval = m.width(state, ' ') * 8; // CSS default: 8 spaces
    for (const w of words) {
      if (w === '') continue;
      if (w === '\t') {
        // Tab width depends on current position — mark it for dynamic calculation
        allWords.push({
          text: '\t',
          width: tabStopInterval, // placeholder — recalculated in flowWordsIntoLines
          style: run.style,
          parentStyle: run.parentStyle,
          isSpace: true,
          isTab: true,
          boxStyle: run.boxStyle,
          clipStyle: run.clipStyle,
          strokeImageStyle: run.strokeImageStyle,
          bidi: run.bidi,
        });
        continue;
      }
      const isSpace = /^ +$/.test(w);
      allWords.push({
        text: w,
        width: m.width(state, w),
        style: run.style,
        parentStyle: run.parentStyle,
        isSpace,
        boxStyle: run.boxStyle,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
        bidi: run.bidi,
      });
    }
  } else {
    // Split on whitespace but NOT on non-breaking spaces (\u00A0).
    // Then add a break opportunity AFTER "?" inside an otherwise-unbreakable
    // token (the URL query delimiter): Chrome wraps "\u2026/q3?" | "lang=ar&\u2026"
    // even with overflow-wrap:normal. It does NOT break at "/", "&", "=", "."
    // or ":" (verified against the browser), so only "?" is split here. The
    // "?" stays with the preceding fragment; a trailing "?" (no follower) is
    // left intact. Fragments measure cumulatively so kerning stays accurate.
    // The second alternative: a non-breaking space still permits a break
    // BEFORE it when the preceding character is a hyphen or a break-after one
    // (UAX #14 LB12a, `[^SP BA HY] x GL`). Measured against the DOM with
    // `aaaaaaaaaa<c>\u00A0bbbbbbbbbb` at 120px/15px Open Sans: only "-",
    // "|", "\u2013" and "\u2014" break there. Letters, "\u2026", ")", "\u00BB",
    // "?", "/" and "," all keep the NBSP glued, so the set is exactly HY
    // plus BA and nothing wider.
    const words = text
      .split(/([ \t\n\r\f\v]+)/)
      .flatMap((w) =>
        /^[ \t\n\r\f\v]+$/.test(w)
          ? [w]
          : w.split(/(?<=\?)(?=.)|(?<=[-|\u2013\u2014])(?=\u00A0)/),
      )
      .flatMap((word) =>
        /^[ \t\n\r\f\v]+$/.test(word) ? [word] : splitHyphenated(word),
      );

    // Measure each piece after its left context (`measureAfter`), so kerning
    // across word and space edges survives. When cumState is provided (from
    // a \u200B/\u00AD split), continue from the previous part's context.
    const cum: Cumulative = cumState ?? { text: '', width: 0, word: 0 };

    for (const w of words) {
      if (w === '') continue;
      const isSpace = /^[ \t\n\r\f\v]+$/.test(w);

      if (isSpace) {
        const spaceWidth = measureAfter(m, state, cum, ' ') + (run.style.wordSpacing || 0);
        allWords.push({
          text: ' ',
          width: spaceWidth,
          style: run.style,
          parentStyle: run.parentStyle,
          isSpace: true,
          boxStyle: run.boxStyle,
          clipStyle: run.clipStyle,
          strokeImageStyle: run.strokeImageStyle,
          bidi: run.bidi,
        });
        continue;
      }

      // Use Intl.Segmenter for scripts without spaces (Thai, Khmer, etc.)
      if (needsSegmenter(w)) {
        const segmenter = getSegmenter();
        if (segmenter) {
          for (const seg of segmenter.segment(w)) {
            const s = seg.segment;
            allWords.push({
              text: s,
              width: measureAfter(m, state, cum, s),
              style: run.style,
              parentStyle: run.parentStyle,
              isSpace: false,
              boxStyle: run.boxStyle,
              clipStyle: run.clipStyle,
              strokeImageStyle: run.strokeImageStyle,
              bidi: run.bidi,
            });
          }
          continue;
        }
      }

      const width = measureAfter(m, state, cum, w);
      if (_debug) {
        // The word measured on its own, against its cumulative delta — a
        // measurement only the debug callback reads.
        const directWidth = m.width(state, w);
        _debug({
          type: 'measure-word',
          message: `"${w}" delta=${width.toFixed(2)} direct=${directWidth.toFixed(2)} diff=${(width - directWidth).toFixed(2)} context="${cum.text}"`,
          data: { text: w, deltaWidth: width, directWidth, contextWidth: cum.width, contextBefore: cum.width - width, font: run.style.fontFamily, fontSize: run.style.fontSize },
        });
      }
      allWords.push({
        text: w,
        width,
        style: run.style,
        parentStyle: run.parentStyle,
        isSpace: false,
        boxStyle: run.boxStyle,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
        bidi: run.bidi,
      });
    }
  }
}

/**
 * Tokenize text runs into words for line wrapping.
 */
function tokenizeRuns(ctx: CanvasRenderingContext2D, runs: TextRun[]): Word[] {
  const m = measurerFor(ctx);
  const allWords: Word[] = [];

  for (const run of transformTextRuns(runs)) {
    // Handle inline-block margins (empty text, no boxOpen/boxClose)
    if (run.text === '' && !run.boxOpen && !run.boxClose) {
      const margin = run.style.display === 'inline-block'
        ? (run.style.marginLeft || run.style.marginRight || 0)
        : 0;
      if (margin > 0) {
        allWords.push({ text: '', width: margin, style: run.style, isSpace: false, boxStyle: run.boxStyle });
      }
      continue;
    }

    // Atomic inline-block: entire element (margin + padding + text) is one word
    // Must check before boxOpen/boxClose handlers since atomic has both set.
    if (run.boxOpen && run.boxClose && run.text) {
      const text = run.text;
      const s = run.style;
      const textWidth = m.width(m.stateOf(s), text);
      const totalWidth = s.marginLeft + s.borderLeftWidth + s.paddingLeft +
        textWidth + s.paddingRight + s.borderRightWidth + s.marginRight;
      allWords.push({
        text,
        width: totalWidth,
        style: run.style,
        parentStyle: run.parentStyle,
        isSpace: false,
        boxStyle: run.boxStyle,
        boxOpen: run.boxOpen,
        boxClose: run.boxClose,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
        bidi: run.bidi,
        inlineBlock: run.inlineBlock,
      });
      continue;
    }

    // Handle inline box open/close markers (padding)
    if (run.boxOpen) {
      const pad = run.boxOpen.paddingLeft + run.boxOpen.borderLeftWidth;
      if (pad > 0) {
        allWords.push({ text: '', width: pad, style: run.style, isSpace: false, boxStyle: run.boxStyle, boxOpen: run.boxOpen, bidi: run.bidi });
      }
      continue;
    }
    if (run.boxClose) {
      const pad = run.boxClose.paddingRight + run.boxClose.borderRightWidth;
      if (pad > 0) {
        allWords.push({ text: '', width: pad, style: run.style, isSpace: false, boxStyle: run.boxStyle, boxClose: run.boxClose, bidi: run.bidi });
      }
      continue;
    }

    const text = run.text;

    // Mark the first word produced from `startLen` as having no soft-wrap
    // opportunity before it when it directly abuts real text from a previous
    // run (adjacent inline elements with no whitespace between them). The
    // preceding word must be actual text — not a space, newline, empty
    // box-padding marker, or box edge — so a whitespace/padding boundary still
    // allows a break.
    const markGlue = (startLen: number) => {
      const first = allWords[startLen];
      if (!first || first.isSpace || !first.text || first.text === '\n') return;
      const prev = allWords[startLen - 1];
      if (
        !prev || prev.isSpace || !prev.text.trim() ||
        prev.boxOpen || prev.boxClose
      ) return;
      // CJK, emoji and segmenter-driven scripts (Thai/Khmer/…) have break
      // opportunities between characters regardless of element boundaries, so
      // an element edge between them is NOT a no-break point. Only glue when
      // both sides are ordinary (Latin-like) text with no intrinsic break.
      // Take the boundary characters as GRAPHEME clusters — indexing by code
      // unit reads past the end of a surrogate pair, and indexing by code point
      // splits VS16 emoji (❤️ = U+2764 U+FE0F) so the cluster reads as non-emoji.
      const firstChar = graphemes(first.text)[0];
      const prevClusters = graphemes(prev.text);
      const prevChar = prevClusters[prevClusters.length - 1];
      if (
        isCJK(firstChar) || isCJK(prevChar) ||
        isEmojiCluster(firstChar) || isEmojiCluster(prevChar) ||
        needsSegmenter(first.text) || needsSegmenter(prev.text)
      ) return;
      first.noBreakBefore = true;
    };

    // Handle explicit newlines (from <br> or pre-wrap) — always force line break
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          allWords.push({ text: '\n', width: 0, style: run.style, isSpace: false, boxStyle: run.boxStyle });
        }
        if (parts[i]) {
          const startLen = allWords.length;
          tokenizeString(m, parts[i], run, allWords);
          markGlue(startLen);
        }
      }
    } else {
      const startLen = allWords.length;
      tokenizeString(m, text, run, allWords);
      markGlue(startLen);
    }
  }

  return allWords;
}

/**
 * Check if a character is CJK (Chinese/Japanese/Korean) — these wrap at character level.
 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0) || 0;
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

let _graphemeSegmenter: Intl.Segmenter | undefined;
function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (_graphemeSegmenter) return _graphemeSegmenter;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    _graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return _graphemeSegmenter;
  }
  return null;
}

/**
 * Split into grapheme clusters — falls back to code points when
 * Intl.Segmenter is unavailable.
 */
function graphemes(text: string): string[] {
  const seg = getGraphemeSegmenter();
  return seg ? [...seg.segment(text)].map((s) => s.segment) : [...text];
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

/**
 * Split after CSS hyphen break opportunities, preserving the hyphen. The
 * two-character lookbehind cannot match at index 1, which is what keeps a
 * leading hyphen attached to the word it starts.
 */
function splitHyphenated(text: string): string[] {
  return text.split(/(?<=[^]-)/).filter(Boolean);
}

/**
 * Break a word into character-level pieces if it contains CJK/emoji or if
 * overflow-wrap: break-word is set and the word is too wide.
 *
 * `emergency` distinguishes the two reasons. CJK and emoji carry their own
 * break opportunities, so those splits are ordinary and fill the current line.
 * `overflow-wrap: break-word` is a last resort, and the caller has to know
 * which of the two it got.
 */
function breakWordIfNeeded(
  ctx: CanvasRenderingContext2D,
  word: Word,
  contentWidth: number,
  currentLineWidth: number,
): { pieces: Word[]; emergency: boolean } {
  // Check if word has CJK characters — always break at character level
  const hasCJK = [...word.text].some(isCJK);

  // Emoji form their own break opportunities (a run of emoji wraps between
  // clusters). Only meaningful when a grapheme segmenter is available so ZWJ
  // sequences / skin-tone / flag pairs stay intact.
  const segmenter = getGraphemeSegmenter();
  const hasEmoji = !!segmenter && EMOJI_CANDIDATE.test(word.text) &&
    graphemes(word.text).some(isEmojiCluster);

  // Check if word needs break-word splitting — when it won't fit on a fresh line
  const needsBreak = word.width > contentWidth &&
    (word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all');

  if (!hasCJK && !hasEmoji && !needsBreak) return { pieces: [word], emergency: false };

  // `overflow-wrap: break-word` is the last-resort split; CJK/emoji breaks are
  // ordinary opportunities that behave nothing like it at the line edge.
  // `word-break: break-all` genuinely allows a break anywhere, so it is not an
  // emergency either.
  const emergency = needsBreak && !hasCJK && !hasEmoji &&
    word.style.wordBreak !== 'break-all';

  // Split into characters, each measured after its left context like the
  // tokenizer's pieces (`MEASURE_CONTEXT`): measuring each char alone ignores
  // kerning, and the sum of individual widths diverges from the true string
  // width over many characters. Positions below (`measuredWidth`,
  // `currentStartWidth`) are offsets in the context's coordinates, so a
  // context restart shifts them together. Break points use THIS word's state,
  // whatever run was measured last.
  const m = measurerFor(ctx);
  const state = m.stateOf(word.style);
  // When the word contains emoji, iterate by GRAPHEME cluster so multi-codepoint
  // emoji (ZWJ families, skin tones, flags) are never split mid-cluster.
  const chars = hasEmoji ? graphemes(word.text) : [...word.text];
  const pieces: Word[] = [];

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

    // Emoji clusters each get their own word — a break opportunity between
    // adjacent emoji, matching the browser line breaker.
    if (hasEmoji && isEmojiCluster(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      pieces.push({ ...word, text: char, width: charWidth });
      currentStartWidth = nextMeasuredWidth;
      measuredText = nextMeasuredText;
      measuredWidth = nextMeasuredWidth;
      continue;
    }

    // CJK chars always get their own word for wrapping
    if (isCJK(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      pieces.push({ ...word, text: char, width: charWidth });
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
      pieces.push({ ...word, text: current, width: currentWidth });
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

  if (current) {
    pieces.push({ ...word, text: current, width: currentWidth });
  }

  return { pieces, emergency };
}

/** Punctuation that cannot start a line — stays with the preceding word. */
const TRAILING_PUNCT = /^[,.\;:!?\)\]\}'"»›」』】〕〉》”、。・！），：；？၊-၏។-៖៘-៚]+$/;
/** Punctuation that cannot end a line — stays with the following word. */
const OPENING_PUNCT = /^[\(\[\{«‹“‘「『【〔〈《（]+$/;

/**
 * Total width of the content directly after `from` that cannot start a line:
 * trailing punctuation (",.)]}…"), an inline span's right padding/border
 * (empty boxClose markers), and a word continuation abutting across a run
 * boundary with no soft-wrap opportunity (`noBreakBefore` — one word split
 * across two inline spans with different font sizes). The browser includes all
 * of it when deciding whether the preceding word fits, so the unit wraps
 * together: if "Music Experie" doesn't leave room for the glued "nce", the
 * whole word wraps as one. Stops at whitespace or the next breakable word.
 */
function gluedRunWidth(words: Word[], from: number): number {
  let total = 0;
  for (let index = from; index < words.length; index++) {
    const next = words[index];
    if (next.isSpace || next.text === '\n') break;
    const isPunctuation = !!next.text && TRAILING_PUNCT.test(next.text);
    const isClosingEdge = !next.text && !!next.boxClose;
    const isContinuation = !!next.text && !!next.noBreakBefore;
    if (!isPunctuation && !isClosingEdge && !isContinuation) break;
    total += next.width;
  }
  return total;
}

/**
 * Flow words into lines that fit within contentWidth.
 * Handles: word wrapping, nowrap, break-word, CJK character wrapping.
 */
function flowWordsIntoLines(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  contentWidth: number,
  whiteSpace: string,
  useBulletProbe = false,
  textIndent = 0,
  tabMetrics?: { interval: number; halfSpace: number },
  strutLineHeight = 0,
): PositionedLine[] {
  const m = measurerFor(ctx);
  const lines: PositionedLine[] = [];
  // Every line box starts at the block's own "strut" height (its font +
  // line-height), so a line whose only content is a SMALLER inline font is
  // still at least the block's line-height tall — matching CSS. See callers.
  const newLine = (): PositionedLine => ({
    words: [],
    totalWidth: 0,
    lineHeight: strutLineHeight,
  });
  let currentLine: PositionedLine = newLine();
  const noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
  // text-indent reduces the first line's width budget; subsequent lines use full width.
  const effWidth = () => contentWidth - (lines.length === 0 ? textIndent : 0);

  const isPreWrap = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';
  // `pre`, `pre-wrap`, and `break-spaces` preserve author whitespace
  // (leading and trailing); the others collapse it.
  const preservesWhitespace =
    whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';

  function pushLine(isSoftWrap = false) {
    const hadWords = currentLine.words.length > 0;
    // Trim trailing spaces. `break-spaces` preserves them even at soft wraps;
    // `pre`/`pre-wrap` preserve them at hard breaks and end-of-content but not
    // at soft wraps (per CSS Text 3 §4.1.1).
    const preserveTrailing = whiteSpace === 'break-spaces'
      || (preservesWhitespace && !isSoftWrap);
    if (!preserveTrailing) {
      while (currentLine.words.length > 0 && currentLine.words[currentLine.words.length - 1].isSpace) {
        currentLine.totalWidth -= currentLine.words[currentLine.words.length - 1].width;
        currentLine.words.pop();
      }
    }
    // Soft hyphen: if this is a soft wrap and the last word has a soft-hyphen
    // break, append a visible '-' since the word is being broken here.
    if (isSoftWrap && currentLine.words.length > 0) {
      const lastWord = currentLine.words[currentLine.words.length - 1];
      if (lastWord.isSoftHyphenBreak) {
        const hyphenWidth = m.width(m.stateOf(lastWord.style), '-');
        currentLine.words.push({
          text: '-',
          width: hyphenWidth,
          style: lastWord.style,
          parentStyle: lastWord.parentStyle,
          isSpace: false,
          // The visible hyphen continues the broken word, so it inherits the
          // word's clip/stroke-image declarer (else it paints transparent).
          clipStyle: lastWord.clipStyle,
          strokeImageStyle: lastWord.strokeImageStyle,
          bidi: lastWord.bidi,
        });
        currentLine.totalWidth += hyphenWidth;
      }
    }
    // In pre-wrap mode, space-only lines still need height (they are content)
    if (currentLine.words.length > 0 || (hadWords && isPreWrap)) {
      if (_debug) {
        const text = currentLine.words.map(w => w.text).join('');
        _debug({
          type: 'line-commit',
          message: `Line ${lines.length}: "${text}" width=${currentLine.totalWidth.toFixed(2)} / ${contentWidth}`,
          data: { lineIndex: lines.length, text, totalWidth: currentLine.totalWidth, contentWidth },
        });
      }
      lines.push(currentLine);
    }
    currentLine = newLine();
  }

  let afterHardBreak = true; // start of content is like after a hard break

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex];
    let wordLineHeight = m.lineHeight(word.style, useBulletProbe);
    // Inline-block elements expand line height with their vertical padding+margin
    if (word.inlineBlockLayout) {
      wordLineHeight = Math.max(wordLineHeight, word.inlineBlockLayout.marginBoxHeight);
    } else if (word.boxStyle && word.boxStyle.display === 'inline-block') {
      // Clamped at 0: negative margins shrink the margin box, but the original
      // `Math.max(h, h + extra)` never let them shrink the LINE, and nothing
      // here is measuring a case that says they should.
      const extra = inlineBlockExtra(word.boxStyle);
      wordLineHeight += Math.max(0, extra.top + extra.bottom);
    }

    if (word.text === '\n') {
      if (currentLine.words.length === 0) {
        currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
        currentLine.endedByHardBreak = true;
        lines.push(currentLine);
        currentLine = newLine();
      } else {
        currentLine.endedByHardBreak = true;
        pushLine();
      }
      afterHardBreak = true;
      continue;
    }

    // No wrapping mode — everything on one line
    if (noWrap) {
      currentLine.words.push(word);
      currentLine.totalWidth += word.width;
      currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
      continue;
    }

    // Breaking a word that is split across a run boundary. A single word split
    // across adjacent inline runs (e.g. <span>E</span>xperience, a font-size
    // change mid-word, or <span>wel</span>l-being) is several Words glued by
    // `noBreakBefore`. Per-word break logic can't see the whole word, so its
    // internal break opportunities — hyphens, and break-word char points — are
    // lost and the unit overflows the edge. Detect the maximal glued chain
    // starting here and break it across the run boundaries like the browser.
    if (!word.isSpace && word.text && !word.noBreakBefore && !word.boxOpen && !word.boxClose) {
      let end = wordIndex;
      while (end + 1 < words.length) {
        const nx = words[end + 1];
        if (!nx.text || nx.isSpace || nx.boxOpen || nx.boxClose || !nx.noBreakBefore) break;
        end++;
      }
      if (end > wordIndex) {
        const breakWord = word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all';
        let combined = 0;
        for (let j = wordIndex; j <= end; j++) combined += words[j].width;
        // Flatten the chain into styled characters (per-run style retained).
        // Carry the run's clip/stroke-image declarer too, else a break-word
        // split drops it and a gradient/stroke fragment paints nothing (the
        // inherited transparent fill has no clip box to reveal).
        // `parentStyle` rides along for the same reason: dropping it made a
        // split `vertical-align` run measure its shift against the block
        // instead of its real parent, 8px out on a narrow break-word line.
        type Cell = {
          ch: string;
          style: ResolvedStyle;
          parentStyle?: ResolvedStyle;
          clipStyle?: ResolvedStyle;
          strokeImageStyle?: ResolvedStyle;
          bidi?: BidiContext | null;
        };
        const cells: Cell[] = [];
        for (let j = wordIndex; j <= end; j++)
          for (const ch of [...words[j].text])
            cells.push({
              ch,
              style: words[j].style,
              parentStyle: words[j].parentStyle,
              clipStyle: words[j].clipStyle,
              strokeImageStyle: words[j].strokeImageStyle,
              bidi: words[j].bidi,
            });
        const combinedText = cells.map((c) => c.ch).join('');
        // Hyphen break opportunities (same rule as the single-word hyphen path).
        const segTexts = splitHyphenated(combinedText);
        const hyphenMode = segTexts.length > 1;
        const fitsLine = currentLine.totalWidth + combined <= effWidth();
        // A hyphen is an ordinary break opportunity — intervene whenever the
        // unit doesn't fit the remaining space. break-word is last-resort —
        // only when the unit can't fit a full line at all (otherwise the normal
        // flow + glued-tail fit check correctly wraps it whole to a fresh line).
        const enter = !fitsLine && (hyphenMode || (breakWord && combined > effWidth()));
        if (enter) {
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
              const st = cs[i].style;
              // clip/stroke declarer is 1:1 with the style run (same source
              // word), so capturing it at the run start covers every push below.
              const clipStyle = cs[i].clipStyle;
              const strokeImageStyle = cs[i].strokeImageStyle;
              const bidi = cs[i].bidi;
              const parentStyle = cs[i].parentStyle;
              const state = m.stateOf(st);
              const lh = m.lineHeight(st, useBulletProbe);
              const run: { ch: string; style: ResolvedStyle }[] = [];
              let cur = '';
              let curW = 0;
              while (i < cs.length && cs[i].style === st) {
                const ch = cs[i].ch;
                const candW = m.width(state, cur + ch);
                if (chars && currentLine.totalWidth + candW > effWidth() &&
                    (currentLine.words.length > 0 || cur)) {
                  if (cur) {
                    currentLine.words.push({ text: cur, width: curW, style: st, isSpace: false, parentStyle, clipStyle, strokeImageStyle, bidi });
                    currentLine.totalWidth += curW;
                    currentLine.lineHeight = Math.max(currentLine.lineHeight, lh);
                  }
                  pushLine(true);
                  afterHardBreak = false;
                  cur = ch;
                  curW = m.width(state, ch);
                } else {
                  cur += ch;
                  curW = candW;
                }
                i++;
              }
              if (cur) {
                currentLine.words.push({ text: cur, width: curW, style: st, isSpace: false, parentStyle, clipStyle, strokeImageStyle, bidi });
                currentLine.totalWidth += curW;
                currentLine.lineHeight = Math.max(currentLine.lineHeight, lh);
                afterHardBreak = false;
              }
            }
          };
          const measureSeg = (cs: Cell[]) => {
            let w = 0;
            let i = 0;
            while (i < cs.length) {
              const st = cs[i].style;
              let txt = '';
              while (i < cs.length && cs[i].style === st) { txt += cs[i].ch; i++; }
              w += m.width(m.stateOf(st), txt);
            }
            return w;
          };
          // Pure break-word (no hyphen) is last-resort: move the whole word to a
          // fresh line first (using the preceding space), then break it there.
          if (!hyphenMode && currentLine.words.length > 0) {
            pushLine(true);
            afterHardBreak = false;
          }
          for (const seg of segs) {
            const segW = measureSeg(seg);
            if (currentLine.words.length > 0 && currentLine.totalWidth + segW > effWidth()) {
              pushLine(true);
              afterHardBreak = false;
            }
            // Char-break a segment only when break-word and it can't fit a line.
            placeCells(seg, breakWord && segW > effWidth());
          }
          wordIndex = end;
          continue;
        }
      }
    }

    // Break long words / CJK characters if needed
    const broken = (!word.isSpace && word.text.length > 1)
      ? breakWordIfNeeded(ctx, word, effWidth(), currentLine.totalWidth)
      : { pieces: [word], emergency: false };
    const pieces = broken.pieces;

    // An emergency break is one taken inside a word that cannot fit on a fresh
    // line. Native layout first takes the ordinary whitespace opportunity
    // before that word; it does not pack the first emergency fragment into
    // space left by the preceding word. Every other kind of split — CJK,
    // emoji, hyphens, break-all — is a normal opportunity and fills first.
    if (broken.emergency && currentLine.words.some((lineWord) => !lineWord.isSpace)) {
      pushLine(true);
      afterHardBreak = false;
    }

    const gluedTailWidth = gluedRunWidth(words, wordIndex + 1);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
      const piece = pieces[pieceIndex];
      const isLastPiece = pieceIndex === pieces.length - 1;
      // A trailing-punctuation piece produced by character splitting still
      // belongs to the preceding character. Include it before deciding
      // whether that character fits; appending it afterward can overflow the
      // line (`…습니다.` must wrap as `다.`, never leave a hanging period).
      let tail = isLastPiece ? gluedTailWidth : 0;
      for (let tailIndex = pieceIndex + 1; tailIndex < pieces.length; tailIndex++) {
        const trailing = pieces[tailIndex];
        if (!trailing.text || !TRAILING_PUNCT.test(trailing.text)) break;
        tail += trailing.width;
        if (tailIndex === pieces.length - 1) tail += gluedTailWidth;
      }
      // Trailing punctuation (e.g. comma after </span>) should not wrap
      // independently — browsers keep it with the preceding word.
      const isTrailingPunct = !piece.isSpace && piece.text.length > 0 &&
        TRAILING_PUNCT.test(piece.text) &&
        currentLine.words.length > 0 &&
        !currentLine.words[currentLine.words.length - 1].isSpace;

      // A word that abuts the previous run with no whitespace has no soft-wrap
      // opportunity before it — keep it with the preceding word like trailing
      // punctuation. Only the FIRST piece carries the flag; a break-word split
      // inside the word may still wrap mid-word.
      const isGlued = currentLine.words.length > 0 &&
        !currentLine.words[currentLine.words.length - 1].isSpace &&
        ((piece === pieces[0] && piece.noBreakBefore) ||
          (!piece.text && !!piece.boxClose));

      // Leading inline padding/border (an empty boxOpen marker) must not be
      // stranded at the end of a line — it belongs with the span's following
      // content (CSS applies padding-left at the box's start). Include the next
      // content word's width in this marker's fit test so the two wrap together
      // and the left padding lands on the new line with the content.
      let headExtra = 0;
      const isOpener = OPENING_PUNCT.test(piece.text);
      if (isOpener && !isLastPiece) {
        // An opener stranded mid-word by the per-character CJK split glues to
        // its NEXT PIECE, not the next word: Chrome never ends a line with
        // \u300C or \uFF08 (measured: \u6C34x5 + opener + \u6C34x7 at width
        // 100 — the DOM wraps the opener down with its following character).
        // The word-level branch below reads words[wordIndex + 1] and finds
        // nothing mid-word, which left the bracket dangling at end of line.
        headExtra = pieces[pieceIndex + 1].width;
      } else if ((!piece.text && piece.boxOpen) ||
          (isOpener && gluedTailWidth === 0)) {
        let nextIndex = wordIndex + 1;
        // Opening punctuation can be followed by an inline box edge before
        // its first glyph: `(<span>word</span>)`. Keep both the edge and that
        // first breakable glyph on the same line as the punctuation.
        while (nextIndex < words.length && !words[nextIndex].text && words[nextIndex].boxOpen) {
          headExtra += words[nextIndex].width;
          nextIndex++;
        }
        const next = words[nextIndex];
        if (next && !next.isSpace && next.text) {
          // Only the next word's first BREAKABLE unit must stay with the leading
          // padding — the whole word for unbreakable Latin, but just the first
          // character for CJK / break-word (which wrap per character). Using the
          // whole word here would over-wrap a long CJK run that follows padding.
          const np = next.text.length > 1
            ? breakWordIfNeeded(ctx, next, effWidth(), 0).pieces
            : [next];
          headExtra += np[0].width;
          if (np.length === 1) {
            // The first word's own inseparable tail is part of the same unit:
            // `(<span>p50</span>,` may break before `(` or after the comma,
            // never between the word, closing edge, and comma.
            headExtra += gluedRunWidth(words, nextIndex + 1);
          }
        }
      }

      // A soft-hyphen break point draws a visible '-' when the line breaks
      // right after this piece. Chrome only allows a break there if the prefix
      // PLUS the hyphen fits, so reserve the hyphen advance in the overflow
      // test — otherwise we pack one extra segment and the appended hyphen
      // overflows the line (breaking one segment later than the browser).
      let shReserve = 0;
      if (piece.isSoftHyphenBreak) {
        shReserve = m.width(m.stateOf(piece.style), '-');
      }

      const candidateLineWidth = currentLine.totalWidth + piece.width +
        shReserve + tail + headExtra;

      // Would this piece overflow?
      if (!piece.isSpace && !isTrailingPunct && !isGlued && currentLine.words.length > 0) {
        const overflow = candidateLineWidth - effWidth();

        // For borderline overflows (< 1px), word-by-word delta accumulation
        // may not be what one string measures. Re-measure the full candidate
        // line as a single string and let that decide. Only works for lines
        // whose glyphs share one measuring state.
        //
        // Over the edge only. A sum UNDER the edge is trusted: re-measuring in
        // both directions moved wraps both ways across the 1px sweeps — the
        // one string drops the last glyph's kern against the space after it,
        // which Blink keeps (the space hangs). Modelling the line ends is
        // fidelity work, not this.
        let reallyOverflows = overflow > 0;
        // A preserved tab's advance is position-dependent (tab stops), but
        // measureText('\t') reports a flat control advance — the one-string
        // re-measure would under-count the line by most of a tab stop and
        // falsely keep the overflowing word. Cumulative widths already carry
        // the true tab advance, so trust them on tab lines. (The piece itself
        // is never a tab here: tab words are spaces, and this branch requires
        // a non-space piece.)
        const remeasure = overflow > 0 && overflow < 1 &&
          !currentLine.words.some((lineWord) => lineWord.isTab);
        const lineState = remeasure
          ? lineMeasureState(m, [...currentLine.words, piece]) : undefined;
        if (lineState !== undefined && lineState !== 'mixed') {
          // Re-measured under the state every glyph on it shares — ALL of it.
          // Setting only the font measured with the letter-spacing of
          // whichever run came last, and kept lines that overflow.
          const state = lineState ?? m.stateOf(piece.style);
          // Empty-text words carry non-glyph advance (inline padding/border
          // markers, inline-block margins) that the measured text misses —
          // add them back so padded inline spans aren't under-measured. A
          // space set in ANOTHER state (`<b style="font-size:.7em"> </b>`)
          // keeps its own width too: at the line's size it reads wider than
          // it is. The text either side of it is measured as separate strings.
          let textWidth = 0;
          let markerWidth = 0;
          let text = '';
          for (const w of [...currentLine.words, piece]) {
            if (!w.text) {
              markerWidth += w.width;
            } else if (w.isSpace && m.stateOf(w.style) !== state) {
              if (text) textWidth += m.width(state, text);
              text = '';
              markerWidth += w.width;
            } else {
              text += w.text;
              if (w.isSpace) markerWidth += w.style.wordSpacing;
            }
          }
          if (piece.isSoftHyphenBreak) text += '-';
          if (text) textWidth += m.width(state, text);
          const fullWidth = textWidth + markerWidth + tail + headExtra;
          // Allow only a hair of sub-pixel overflow. A broader tolerance fixes
          // isolated knife-edges but packs extra words in ordinary paragraphs.
          reallyOverflows = fullWidth > effWidth() + 0.02;
        }

        if (reallyOverflows) {
          if (_debug) {
            const lineText = currentLine.words.map(w => w.text).join('');
            _debug({
              type: 'line-wrap',
              message: `"${piece.text}" overflow=${overflow.toFixed(2)} wrap=true lineWidth=${currentLine.totalWidth.toFixed(2)} pieceWidth=${piece.width.toFixed(2)} contentWidth=${contentWidth}  line="${lineText}"`,
              data: { text: piece.text, overflow, lineWidth: currentLine.totalWidth, pieceWidth: piece.width, contentWidth, lineText },
            });
          }
          pushLine(true);
          afterHardBreak = false;
        }
      }

      // Skip leading spaces at the start of a line. Preserving modes
      // (pre/pre-wrap/break-spaces) keep them after hard breaks; collapsing
      // modes (normal/nowrap/pre-line) drop them in all cases.
      if (piece.isSpace && currentLine.words.length === 0
          && (!afterHardBreak || !preservesWhitespace)) continue;

      // Tab: advance to the next tab stop (stops measured from the content
      // edge). Chrome rule: when the next stop is closer than half a space
      // width, skip to the following stop (Blink Font::TabWidth).
      let pieceWidth = piece.width;
      if (piece.isTab) {
        const interval = tabMetrics?.interval || piece.width;
        const halfSpace = tabMetrics?.halfSpace ?? 0;
        const currentPos = (lines.length === 0 ? textIndent : 0) + currentLine.totalWidth;
        let advance = interval - (currentPos % interval);
        if (advance < halfSpace) advance += interval;
        pieceWidth = advance;
        piece.width = pieceWidth;
      }

      currentLine.words.push(piece);
      currentLine.totalWidth += pieceWidth;
      currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
      if (!piece.isSpace) afterHardBreak = false;
    }
  }
  pushLine();
  return lines;
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

function prepareInlineBlocks(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  containingWidth: number,
  useBulletProbe: boolean,
): void {
  for (const word of words) {
    const source = word.inlineBlock;
    if (!source) continue;
    const s = source.style;
    const margins = horizontalMargins(s);
    const frame = horizontalFrame(s);
    const preferredContent = Math.max(0, word.width - margins - frame);
    // The source node IS the inner root: the inline formatting context reads
    // only font, whiteSpace, direction, text-align/indent and line-clamp off
    // it. Its box properties are applied here, by the caller, so there is
    // nothing to zero out first.
    const availableContent = Math.max(0, containingWidth - margins - frame);
    let contentWidth = s.width > 0
      ? Math.max(0, s.width - frame)
      : Math.min(
        preferredContent,
        Math.max(minimumInlineContentWidth(ctx, source), availableContent),
      );
    if (s.minWidth !== null) {
      contentWidth = Math.max(contentWidth, Math.max(0, s.minWidth - frame));
    }

    const inner = layoutInlineContent(ctx, source, 0, 0, contentWidth, useBulletProbe);
    const contentHeight = inner.height || measurerFor(ctx).lineHeight(s, useBulletProbe);
    const lastBaseline = inner.lines.at(-1)?.y ??
      measurerFor(ctx).leadedBox(s, useBulletProbe).ascent;
    const extra = inlineBlockExtra(s);
    const baselineOffset = extra.top + lastBaseline;
    const marginBoxHeight = extra.top + contentHeight + extra.bottom;
    word.width = margins + frame + contentWidth;
    word.inlineBlockLayout = {
      nodes: inner.nodes,
      lines: inner.lines,
      lineBoxes: inner.lineBoxes,
      contentWidth,
      contentHeight,
      baselineOffset,
      marginBoxHeight,
    };
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
 * Layout inline content: text wrapping + positioning using pure canvas measurement.
 * Returns layout nodes and the total height consumed.
 */
function layoutInlineContent(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  x: number,
  y: number,
  contentWidth: number,
  useBulletProbe = false,
  clamp?: LineClampState,
): { nodes: LayoutNode[]; height: number; lines: LayoutLine[]; lineBoxes: LayoutLineBox[] } {
  const m = measurerFor(ctx);
  const results: LayoutNode[] = [];
  const emittedLines: LayoutLine[] = [];
  const lineBoxes: LayoutLineBox[] = [];
  // Text nodes covered by an inline element declaring background-clip:text
  // (clipRuns) or --rt-text-stroke-image (strokeImageRuns), mapped to that
  // declaring element's style. A post-pass turns each per-line run of
  // same-declarer nodes into a fragment-spanning paint box.
  const clipRuns = new Map<LayoutText, ResolvedStyle>();
  const strokeImageRuns = new Map<LayoutText, ResolvedStyle>();
  if (clamp && (clamp.exhausted || clamp.remaining <= 0)) {
    // An ancestor's clamp already used its line budget — drop this content.
    clamp.exhausted = true;
    return { nodes: results, height: 0, lines: emittedLines, lineBoxes };
  }
  const runs = collectTextRuns(node);
  if (runs.length === 0 && !node.children.some(createsLineBox)) {
    return { nodes: results, height: 0, lines: emittedLines, lineBoxes };
  }

  const words = tokenizeRuns(ctx, runs);
  prepareInlineBlocks(ctx, words, contentWidth, useBulletProbe);
  const textIndent = node.style.textIndent || 0;
  const tabMetrics = m.tabStops(node.style);
  // The block's own font + line-height set the strut: the minimum height of
  // every line box, even a line holding only smaller inline content.
  const strutLineHeight = m.lineHeight(node.style, useBulletProbe);
  const lines = flowWordsIntoLines(ctx, words, contentWidth, node.style.whiteSpace, useBulletProbe, textIndent, tabMetrics, strutLineHeight);
  // Content with no words can still make a line box (an empty inline with
  // inline-axis padding, an empty inline-block): it stands at the strut.
  if (lines.length === 0 && node.children.some(createsLineBox)) {
    lines.push({ words: [], totalWidth: 0, lineHeight: strutLineHeight });
  }

  // `-webkit-line-clamp` / `line-clamp`: truncate to N lines and append a
  // CSS-style ellipsis ("…") to the Nth line, back-trimming trailing words
  // until the ellipsis fits within contentWidth. The budget comes from an
  // ancestor's shared clamp state when one is active (clamp on a block
  // container with block children), else from this element's own style.
  const clampN = clamp ? clamp.remaining : node.style.lineClamp;
  if (clampN > 0 && lines.length > clampN) {
    lines.length = clampN;
    const lastLine = lines[clampN - 1];
    // First line has reduced width because of text-indent; a cut on this
    // element's first line (effective budget of 1) hits it.
    const lineMaxForEllipsis = contentWidth - (clampN === 1 ? textIndent : 0);
    applyEllipsisToLine(ctx, lastLine, lineMaxForEllipsis);
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

  const isRTL = node.style.direction === 'rtl';
  const bidiLines = resolveLineBidi(lines, isRTL);
  const resolveDir = (a: string) => {
    if (a === 'start') return isRTL ? 'right' : 'left';
    if (a === 'end') return isRTL ? 'left' : 'right';
    return a;
  };
  let textAlign = resolveDir(node.style.textAlign);
  // text-align-last: 'auto' inherits from text-align except when text-align is
  // 'justify', then defaults to 'start' (CSS Text 3 §7.2).
  let textAlignLast = node.style.textAlignLast || 'auto';
  if (textAlignLast === 'auto') {
    textAlignLast = node.style.textAlign === 'justify' ? (isRTL ? 'right' : 'left') : textAlign;
  } else {
    textAlignLast = resolveDir(textAlignLast);
  }

  // The block strut also participates in the line's baseline, not just its
  // height: inline content aligns to the block-font baseline, so a line whose
  // only content is a SMALLER inline font sits on the strut baseline (lower in
  // the box), not centered in it. Seed each line's ascent/descent with the
  // block font's metrics so the baseline lands where the DOM puts it.
  // The block is the parent of any run with no inline ancestor, and the emit
  // loop shadows `node` with the LayoutText it builds.
  const blockStyle = node.style;

  let curY = y;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    const isLastLine = lineIdx === lines.length - 1;
    const isFirstLine = lineIdx === 0;

    // Per-line alignment: lines ending at a forced break or the last line
    // use text-align-last; all others use text-align (CSS Text 3 §7.1, §7.2).
    const useLast = isLastLine || line.endedByHardBreak;
    const align = useLast ? textAlignLast : textAlign;

    // text-indent narrows the first line's available width.
    const indent = isFirstLine ? textIndent : 0;
    const lineMaxWidth = contentWidth - indent;

    // Justify: expand spaces to fill the line.
    let justifyExtraPerSpace = 0;
    if (align === 'justify' && line.totalWidth < lineMaxWidth) {
      const spaceCount = line.words.filter(w => w.isSpace).length;
      if (spaceCount > 0) {
        justifyExtraPerSpace = (lineMaxWidth - line.totalWidth) / spaceCount;
      }
    }

    // text-align (with first-line indent baked into curX).
    // When the line overflows its container, browsers fall back to start
    // alignment (per CSS Text 3 §7.1) instead of pushing the line outside
    // the box. Common trigger: wide letter-spacing on text that doesn't
    // wrap at letter boundaries (no break-word/break-all), where centering
    // would put glyphs at negative x. Sub-pixel tolerance avoids switching
    // to start for rounding noise on lines that visually fit.
    // Start edge differs by direction. LTR lines start at the left (x+indent).
    // RTL lines are anchored at the right, inset from the content's right edge
    // by text-indent — and lineMaxWidth already subtracts indent, so the RTL
    // right edge is x+lineMaxWidth. `align` here is physically resolved
    // (start/end → left/right via resolveDir), so RTL with align==='left'
    // (explicit left, or end) correctly falls through to left alignment.
    const overflows = line.totalWidth > lineMaxWidth + 0.5;
    let curX = x + indent;
    if (overflows) {
      // Overflow fallback: pin to the start edge (CSS Text 3 §7.1).
      curX = isRTL ? x + lineMaxWidth - line.totalWidth : x + indent;
    } else if (align === 'center') {
      curX = x + indent + (lineMaxWidth - line.totalWidth) / 2;
    } else if (align === 'right') {
      curX = (isRTL ? x + lineMaxWidth : x + indent + lineMaxWidth) - line.totalWidth;
    } else if (align === 'justify' && isRTL) {
      // RTL justify: anchor the right edge at the inset start; spaces expand left.
      curX = x + lineMaxWidth - line.totalWidth;
    }
    // Snapshot the line's left edge before LTR emission advances curX.
    const lineLeftX = curX;

    if (line.words.length === 0) {
      lineBoxes.push({
        x: lineLeftX, y: curY, width: 0, height: line.lineHeight,
        endedByHardBreak: !!line.endedByHardBreak,
      });
      curY += line.lineHeight;
      continue;
    }

    // Inline background boxes and text are emitted after baseline computation
    // (below) so that emitInlineBox can use line-level metrics for alignment.

    // The line box is the union of every box on it — strut, run, shifted run,
    // inline-block — each carrying its own leading over its own line-height:
    //   lineAscent = max(ascent - shift), lineDescent = max(descent + shift).
    // One font, one line-height and no shift collapse that back to the plain
    // half-leading every single-style line already had.
    const strutBox = m.leadedBox(node.style, useBulletProbe);
    let lineAscent = strutBox.ascent;
    let lineDescent = strutBox.descent;
    // A shift moves the box, not the line's baseline: positive is downward, so
    // it lifts the box's demand on the ascent side and adds to the descent one.
    const grow = (ascent: number, descent: number, shift: number) => {
      if (ascent - shift > lineAscent) lineAscent = ascent - shift;
      if (descent + shift > lineDescent) lineDescent = descent + shift;
    };
    for (const word of line.words) {
      if (word.text === '') continue;
      // A wrapper element with no text of its own — `<span lh:3><span>x</span>`
      // — never becomes a Word, but it is still a box on the line and still
      // brings its own line-height. Its run children carry it as `parentStyle`,
      // so take it from there, AT ITS OWN SHIFT: added unshifted, a wrapper
      // that carries a vertical-align and direct text enters the union twice
      // at two different places, and the line spans both (measured 60px where
      // the DOM has 40). With the shift it is idempotent — a wrapper with
      // direct text contributes the identical box through its own run.
      if (word.parentStyle) {
        const parentBox = m.leadedBox(word.parentStyle, useBulletProbe);
        grow(
          parentBox.ascent, parentBox.descent,
          verticalAlignShift(
            word.parentStyle.verticalAlign, ctx, word.parentStyle, blockStyle, useBulletProbe),
        );
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
      grow(ascent, descent, atomic ? 0 : verticalAlignShift(
        word.style.verticalAlign, ctx, word.style,
        word.parentStyle ?? blockStyle, useBulletProbe));
    }
    const lineBoxHeight = lineAscent + lineDescent;
    const lineBaselineY = curY + lineAscent;

    // Emit inline background box using line-level baseline for vertical alignment.
    // Uses the line's ascent/descent (not the box's own font) so box aligns with text.
    const emitInlineBox = (
      style: ResolvedStyle, bx: number, bw: number, textWord?: Word,
    ) => {
      // The box's OWN font decides its height, not the line's largest. An
      // inline-block's content box is its LINE-HEIGHT, though, not the bare
      // font metrics — measured against Chrome, bare metrics put it at
      // y=6 h=29 where the DOM has y=4 h=33.2.
      const { ascent: boxAscent, descent: boxDescent } =
        style.display === 'inline-block'
          ? m.leadedBox(style, useBulletProbe)
          : m.metrics(style);
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
      // below, so box and glyphs cannot drift apart. Computed independently
      // they did — the band painted at the unshifted baseline under super/
      // sub'd text. Inline-block stays put: the emit pass does not honour
      // vertical-align on it (see the line-box union above).
      if (textWord && style.display !== 'inline-block') {
        const va = textWord.style.verticalAlign;
        if (isShiftedVAlign(va)) {
          baselineY += verticalAlignShift(
            va, ctx, textWord.style, textWord.parentStyle ?? blockStyle, useBulletProbe);
        }
      }
      const boxY = baselineY - boxAscent - padTop;
      results.push({
        type: 'box', style, x: bx, y: boxY, width: bw, height: boxHeight,
        tagName: 'span', children: [],
      });
    };

    // Bidi: the line's words cut into level-uniform pieces in VISUAL order
    // (UAX #9 L2), so both passes below walk the line left to right whatever
    // its direction. A plain LTR line keeps its own words.
    let emitWords = line.words;
    let emitLevels: number[] | null = null;
    let emitKeys: number[] | null = null;
    const wordLevels = bidiLines?.[lineIdx];
    if (wordLevels) {
      ({ words: emitWords, levels: emitLevels, keys: emitKeys } = bidiLineItems(
        m, line.words, wordLevels, isRTL ? 1 : 0, justifyExtraPerSpace > 0));
      if (isRTL) {
        // An RTL line is anchored at its right edge (curX + totalWidth); its
        // pieces may measure a little differently from the words they came from.
        let total = 0;
        for (const w of emitWords) total += w.width + (w.isSpace ? justifyExtraPerSpace : 0);
        curX = curX + line.totalWidth - total;
      }
    }

    // Emit inline background boxes (Pass 1) before text.
    {
      let scanX = curX;
      let boxStartX = scanX;
      let currentBoxStyle: ResolvedStyle | undefined;
      // First text word of the open box group — its presence decides whether
      // the group's band is emitted at all, and its style pair decides where
      // the band's baseline sits (the same pair the text emit shifts by).
      let boxTextWord: Word | undefined;

      for (const word of emitWords) {
        if (word.boxOpen && word.boxClose && word.text) {
          if (currentBoxStyle) {
            if (boxTextWord) emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX, boxTextWord);
            currentBoxStyle = undefined;
            boxTextWord = undefined;
          }
          const s = word.style;
          const boxX = scanX + s.marginLeft;
          if (word.inlineBlockLayout) {
            const ib = word.inlineBlockLayout;
            const boxY = lineBaselineY - ib.baselineOffset + s.marginTop;
            results.push({
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
            emitInlineBox(s, boxX, boxW, word);
          }
          boxTextWord = undefined;
          scanX += word.width;
          continue;
        }

        if (word.boxStyle !== currentBoxStyle) {
          if (currentBoxStyle && boxTextWord) {
            emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX, boxTextWord);
          }
          currentBoxStyle = word.boxStyle;
          boxStartX = scanX;
          boxTextWord = undefined;
        }
        if (word.text && !word.isSpace) boxTextWord ??= word;
        scanX += word.width + (word.isSpace ? justifyExtraPerSpace : 0);
      }
      if (currentBoxStyle && boxTextWord) {
        emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX, boxTextWord);
      }
    }

    // Emit text nodes, placed left to right. A bidi line's nodes are then put
    // back in LOGICAL order (`emitKeys`): layoutRoot keeps document order, as
    // every consumer walking it (and the geometry oracle) expects.
    const textStart = results.length;
    const nodeKeys: number[] = [];
    const keyNodes = (key: number) => {
      while (textStart + nodeKeys.length < results.length) nodeKeys.push(key);
    };
    for (let wordIndex = 0; wordIndex < emitWords.length; wordIndex++) {
      if (emitKeys && wordIndex > 0) keyNodes(emitKeys[wordIndex - 1]);
      const word = emitWords[wordIndex];
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
          const move = (layoutNode: LayoutNode): void => {
            layoutNode.x += textX;
            layoutNode.y += contentY;
            if (layoutNode.type === 'text') {
              if (layoutNode.lineBaselineY !== undefined) layoutNode.lineBaselineY += contentY;
              const lineTop = runLineTops.get(layoutNode);
              if (lineTop !== undefined) runLineTops.set(layoutNode, lineTop + contentY);
              if (layoutNode.clip) {
                layoutNode.clip.x += textX;
                layoutNode.clip.y += contentY;
              }
              if (layoutNode.strokeImage) {
                layoutNode.strokeImage.x += textX;
                layoutNode.strokeImage.y += contentY;
              }
            } else {
              for (const line of layoutNode.lineBoxes ?? []) {
                line.x += textX;
                line.y += contentY;
              }
              for (const child of layoutNode.children) move(child);
            }
          };
          for (const innerNode of ib.nodes) {
            move(innerNode);
            results.push(innerNode);
          }
          for (const innerLine of ib.lines.slice(0, -1)) {
            const translated: LayoutLine = {
              y: Math.round(innerLine.y + contentY),
              text: innerLine.text,
              bounds: {
                x: innerLine.bounds.x + textX,
                y: innerLine.bounds.y + contentY,
                width: innerLine.bounds.width,
                height: innerLine.bounds.height,
              },
            };
            emittedLines.push(translated);
          }
          curX += word.width;
          continue;
        }
        const textWidth = m.width(m.stateOf(word.style), word.text);
        const node: LayoutText = {
          type: 'text',
          text: word.text,
          // An RTL run is anchored at its right edge (renderText's textAlign).
          x: word.style.direction === 'rtl' ? textX + textWidth : textX,
          y: lineBaselineY,
          width: textWidth,
          style: word.style,
        };
        results.push(node);
        runLineTops.set(node, curY);
        if (word.clipStyle) clipRuns.set(node, word.clipStyle);
        if (word.strokeImageStyle) strokeImageRuns.set(node, word.strokeImageStyle);
        curX += word.width;
        continue;
      }

      // Adjust baseline for vertical-align
      let baselineY = lineBaselineY;
      const va = word.style.verticalAlign;
      if (isShiftedVAlign(va)) {
        baselineY += verticalAlignShift(
          va, ctx, word.style, word.parentStyle ?? blockStyle, useBulletProbe);
      }
      const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);
      // A bidi piece paints in its level's direction; an RTL one is anchored
      // at its right edge (renderText's textAlign).
      const rtlPiece = emitLevels !== null && emitLevels[wordIndex] % 2 === 1;

      const node: LayoutText = {
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
      };
      results.push(node);
      runLineTops.set(node, curY);
      if (word.clipStyle) clipRuns.set(node, word.clipStyle);
      if (word.strokeImageStyle) strokeImageRuns.set(node, word.strokeImageStyle);

      curX += effectiveWidth;
    }
    if (emitKeys && emitWords.length > 0) {
      keyNodes(emitKeys[emitWords.length - 1]);
      const placed = results.splice(textStart).map((node, i) => ({ node, key: nodeKeys[i] }));
      placed.sort((a, b) => a.key - b.key); // stable: an inline-block keeps its inner order
      for (const { node } of placed) results.push(node);
    }

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
      text: line.words.map((word) =>
        word.inlineBlockLayout?.lines.at(-1)?.text ?? word.text).join(''),
      bounds: {
        x: lineLeftX,
        // The line box starts at curY — this is the CSS line box, which
        // `lineAscent`/`lineDescent` grew to cover every box on the line. Ink
        // can still overflow it (an ascender under `line-height: 1`), exactly
        // as it does in the DOM; a caller that clips must allow for that.
        y: curY,
        width: lineWidth,
        height: lineBoxHeight,
      },
    };
    emittedLines.push(emittedLine);
    lineBoxes.push({ ...emittedLine.bounds, endedByHardBreak: !!line.endedByHardBreak });

    curY += lineBoxHeight;
  }

  assignInlineFragmentBoxes(ctx, results, clipRuns, (node, s, box) => {
    node.clip = {
      image: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : undefined,
      color: !isTransparent(s.backgroundColor) ? s.backgroundColor : undefined,
      ...box,
    };
  });
  assignInlineFragmentBoxes(ctx, results, strokeImageRuns, (node, s, box) => {
    node.strokeImage = { image: s.webkitTextStrokeImage, ...box };
  });

  return { nodes: results, height: curY - y, lines: emittedLines, lineBoxes };
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
  ctx: CanvasRenderingContext2D,
  results: LayoutNode[],
  runs: Map<LayoutText, ResolvedStyle>,
  assign: (
    node: LayoutText,
    declarer: ResolvedStyle,
    box: { x: number; y: number; width: number; height: number },
  ) => void,
): void {
  if (runs.size === 0) return;
  const edges = (n: LayoutText) =>
    n.style.direction === 'rtl'
      ? { left: n.x - n.width, right: n.x }  // RTL x is the right edge
      : { left: n.x, right: n.x + n.width };
  for (let i = 0; i < results.length;) {
    const first = results[i];
    const declarer = first.type === 'text' ? runs.get(first) : undefined;
    if (!declarer) { i++; continue; }
    let j = i;
    let left = Infinity, right = -Infinity;
    while (j < results.length) {
      const n = results[j];
      if (n.type !== 'text' || runs.get(n) !== declarer || n.y !== first.y) break;
      const e = edges(n);
      if (e.left < left) left = e.left;
      if (e.right > right) right = e.right;
      j++;
    }
    const { ascent, descent } = measurerFor(ctx).metrics(declarer);
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
  const { _overflowX: x, _overflowY: y } = style as { _overflowX?: string; _overflowY?: string };
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
  ctx: CanvasRenderingContext2D,
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
  // If element has explicit width, use it; otherwise fill available width
  const boxWidth = (style.width > 0)
    ? style.width
    : availableWidth - marginLeft - marginRight;
  const contentX = boxX + borderLeft + padLeft;
  const contentWidth = Math.max(0, boxWidth - borderLeft - borderRight - padLeft - padRight);

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
    const result = layoutFlex(ctx, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Table layout
  if (style.display === 'table') {
    const result = layoutTable(ctx, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Empty block elements: zero content height (CSS spec — no line boxes created).
  // Only min-height or padding/border contribute to height — except a list
  // item's outside marker, which makes a line box of its own (Chrome, WebKit).
  if (node.children.length === 0) {
    const markerLine = hasMarkerLine(node)
      ? _measurer!.lineHeight(style, BULLET_MARKERS.has(style.listStyleType))
      : 0;
    box.height = borderTop + padTop + markerLine + padBottom + borderBottom;
    if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
    return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
  }

  // Layout children
  if (hasOnlyInlineChildren(node)) {
    // Inline formatting context
    const bulletProbe = node.tagName === 'li' && BULLET_MARKERS.has(style.listStyleType);
    const { nodes, height, lines, lineBoxes } = layoutInlineContent(ctx, node, contentX, contentStartY, contentWidth, bulletProbe, clamp);
    _lines.push(...lines);
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
        const { nodes, height, lines, lineBoxes } = layoutInlineContent(ctx, inlineGroup, contentX, curY, contentWidth, bulletProbe2, clamp);
        _lines.push(...lines);
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
        const { box: childBox } = layoutBlock(ctx, child, contentX, childY, contentWidth, clamp);
        box.children.push(childBox);
        if (!atTop) pending = withMargin(joinStruts(pending, top), child.style.marginBottom);
        else throughStrut = withMargin(joinStruts(throughStrut, top), child.style.marginBottom);
        continue;
      }

      const childY = atTop ? curY : curY + strutSize(joinStruts(pending, top));
      atTop = false;
      const { box: childBox, height: childHeight, marginBottomOut } = layoutBlock(
        ctx, child, contentX, childY, contentWidth, clamp,
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
          _measurer!.lineHeight(style, BULLET_MARKERS.has(style.listStyleType)));
      }
    }
    const raisesBox = style.minHeight > Math.max(0, contentEnd);
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
    if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
    return { box, height: box.height, marginBottomOut };
  }

  if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
  return { box, height: box.height, marginBottomOut: withMargin(NO_MARGIN, style.marginBottom) };
}

// ─── Table layout ──────────────────────────────────────────────────────

function layoutTable(
  ctx: CanvasRenderingContext2D,
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

      const { box: cellBox, height: cellHeight } = layoutBlock(ctx, cell, cellX, curY, colWidth, undefined, true);
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

const _anonymousFlexItems = new WeakMap<StyledNode, StyledNode>();

/**
 * Bare text in a flex container is an anonymous flex item: a block box of its
 * own, sized and placed like any other. Built once per text node, because the
 * min- and max-content caches are keyed by node identity and sizing must ask
 * about the very node the layout places.
 */
function anonymousFlexItem(text: StyledNode): StyledNode {
  let wrapper = _anonymousFlexItems.get(text);
  if (!wrapper) {
    wrapper = {
      element: null,
      tagName: 'div',
      style: { ...text.style, display: 'block' },
      children: [text],
      textContent: null,
    };
    _anonymousFlexItems.set(text, wrapper);
  }
  return wrapper;
}

/**
 * The children a flex container lays out. A bare text node is an anonymous
 * flex item only when it has actual text — and min-content sizing has to agree
 * with the layout about that, or an item is frozen at the wrong minimum.
 */
function flexItems(node: StyledNode): StyledNode[] {
  return node.children
    .filter((child) => child.tagName !== '#text' || child.textContent?.trim())
    .map((child) => child.tagName === '#text' ? anonymousFlexItem(child) : child);
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
 * between normal soft-wrap opportunities, measured with the same canvas
 * context and tokenization as the actual line flow.
 */
function minimumInlineContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  // `overflow-wrap:break-word` is deliberately ignored for min-content sizing
  // by CSS. CJK/emoji and `word-break:break-all` still contribute their
  // smallest legal pieces, so run the real line flow with only that
  // last-resort mode disabled — at a width nothing fits in, every soft-wrap
  // opportunity is taken and each line IS one unbreakable unit.
  // One copy per source style, not per word: font state is cached by style
  // identity, and runs of one style must stay one style to glue.
  const neutralized = new Map<ResolvedStyle, ResolvedStyle>();
  const words = tokenizeRuns(ctx, collectTextRuns(node)).map((word) => {
    if (word.style.overflowWrap !== 'break-word' || word.style.wordBreak === 'break-all') return word;
    let style = neutralized.get(word.style);
    if (!style) neutralized.set(word.style, style = { ...word.style, overflowWrap: 'normal' });
    return { ...word, style };
  });
  const lines = flowWordsIntoLines(ctx, words, 0, node.style.whiteSpace);
  return lines.reduce((widest, line) => Math.max(widest, line.totalWidth), 0);
}

/**
 * Min-content contribution of a flex item, including its horizontal frame.
 *
 * Memoized for the render: a nested flex row asks for the minimum of its whole
 * subtree, and so does every flex row above it, which otherwise costs
 * O(depth x nodes). The answer depends only on the subtree and the font state,
 * and `buildLayoutTree` clears the cache alongside the measurement caches.
 */
function minimumContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  const memoized = _minContentCache.get(node);
  if (memoized !== undefined) return memoized;
  const computed = computeMinimumContentWidth(ctx, node);
  _minContentCache.set(node, computed);
  return computed;
}

function computeMinimumContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  const margins = horizontalMargins(node.style);
  const frame = horizontalFrame(node.style);

  // An explicit min-width disables the flex automatic min-content size.
  if (node.style.minWidth !== null) {
    return margins + Math.max(frame, node.style.minWidth);
  }

  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = minimumInlineContentWidth(ctx, node);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(node);
    content = children.reduce((sum, child) => sum + minimumContentWidth(ctx, child), 0) +
      node.style.gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, minimumContentWidth(ctx, child));
      }
    }
  }

  let borderBox = frame + content;
  // A definite width caps the automatic minimum size in the flex algorithm.
  if (node.style.width > 0) borderBox = Math.min(borderBox, node.style.width);
  return margins + borderBox;
}

/**
 * Maximum width of one inline formatting context: the widest stretch between
 * FORCED breaks. That is the same line flow every other caller uses, run at a
 * width nothing can exceed — max-content does not get its own break rules.
 */
function maximumInlineContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  const words = tokenizeRuns(ctx, collectTextRuns(node));
  const lines = flowWordsIntoLines(ctx, words, Infinity, node.style.whiteSpace);
  return lines.reduce((widest, line) => Math.max(widest, line.totalWidth), 0);
}

/**
 * Max-content contribution of a flex item, including its horizontal frame and
 * margins — the same outer currency `minimumContentWidth` reports and
 * `layoutBlock` takes as its available width.
 *
 * Memoized for the same reason the minimum is: every flex row above an item
 * asks for its whole subtree.
 */
function maximumContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  const memoized = _maxContentCache.get(node);
  if (memoized !== undefined) return memoized;
  const computed = computeMaximumContentWidth(ctx, node);
  _maxContentCache.set(node, computed);
  return computed;
}

function computeMaximumContentWidth(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
): number {
  const margins = horizontalMargins(node.style);
  // A definite width IS the max-content size.
  if (node.style.width > 0) return margins + node.style.width;

  let content = 0;
  if (hasOnlyInlineChildren(node)) {
    content = maximumInlineContentWidth(ctx, node);
  } else if (node.style.display === 'flex' && isFlexRow(node.style)) {
    const children = flexItems(node);
    content = children.reduce((sum, child) => sum + maximumContentWidth(ctx, child), 0) +
      node.style.gap * Math.max(0, children.length - 1);
  } else {
    for (const child of node.children) {
      if (child.tagName !== '#text') {
        content = Math.max(content, maximumContentWidth(ctx, child));
      }
    }
  }
  return margins + horizontalFrame(node.style) + content;
}

/**
 * Flex base size of one item, as an outer width. `flex-basis: auto` (the
 * initial value, and what `flex-grow: 1` on its own leaves in place) resolves
 * against the item's own content; `flex: 1` sets it to 0 so the item's content
 * stops mattering and the row splits by grow factor alone.
 */
function flexBaseSize(ctx: CanvasRenderingContext2D, node: StyledNode): number {
  return node.style.flexBasis !== null
    ? horizontalMargins(node.style) + node.style.flexBasis
    : maximumContentWidth(ctx, node);
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
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const style = node.style;
  const gap = style.gap;
  const children: LayoutNode[] = [];

  const flexChildren = flexItems(node);
  if (flexChildren.length === 0) return { children, height: 0 };

  if (isFlexRow(style)) {
    // Row layout
    const totalGaps = gap * (flexChildren.length - 1);
    const available = Math.max(0, contentWidth - totalGaps);
    // If the minima themselves do not fit, they overflow the container exactly
    // as native flex items with min-width:auto do.
    const widths = resolveFlexibleLengths(
      flexChildren.map((child) => child.style),
      flexChildren.map((child) => flexBaseSize(ctx, child)),
      flexChildren.map((child) => minimumContentWidth(ctx, child)),
      available,
    );

    let curX = contentX;
    let maxHeight = 0;

    for (let index = 0; index < flexChildren.length; index++) {
      const child = flexChildren[index];
      const childWidth = widths[index];

      const { box, height } = layoutBlock(ctx, child, curX, contentY, childWidth, undefined, true);
      children.push(box);
      maxHeight = Math.max(maxHeight, height);
      curX += childWidth + gap;
    }

    return { children, height: maxHeight };
  }

  // Column layout (fallback)
  let curY = contentY;
  for (const child of flexChildren) {
    const { box, height } = layoutBlock(ctx, child, contentX, curY, contentWidth, undefined, true);
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
  ctx: CanvasRenderingContext2D,
  box: LayoutBox,
  node: StyledNode,
): void {
  if (!node.listMarker) return;
  // `::marker { content: none }` suppresses the marker entirely —
  // canonical CSS behavior, matches the DOM reference.
  if (node.markerHidden) return;

  const style = node.style;
  // Marker style = li style with explicit `::marker` overrides applied on top.
  // `markerStyle` holds only keys explicitly set by `::marker` rules, so a
  // missing key falls back to the li style. A present key (incl. 0) wins.
  const ms = node.markerStyle;
  const markerStyleObj: ResolvedStyle = ms ? { ...style, ...ms } : style;

  // The marker measures in its own style — letter-spacing and kerning too,
  // as it is painted, not in whatever the li's last run left on the ctx.
  const m = measurerFor(ctx);
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
  _lines.push({
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

/**
 * Build the layout tree from the styled tree using pure canvas measurement.
 * No DOM measurements used — all positions computed from CSS values + canvas.measureText.
 */
export function buildLayoutTree(
  ctx: CanvasRenderingContext2D,
  styledTree: StyledNode,
  containerWidth: number,
  useDomMeasurements = true,
  debug?: (entry: import('./types.ts').DebugEntry) => void,
): { root: LayoutBox; height: number; lines: LayoutLine[] } {
  _useDomMeasurements = useDomMeasurements;
  _debug = debug;

  // Clear caches — fonts may have loaded since last call
  _lineHeightCache.clear();
  _fontMetricsCache.clear();
  _fontStringCache.clear();
  _minContentCache.clear();
  _maxContentCache.clear();
  _lines = [];

  // A fresh measurer per call: its widths, font states and its idea of what
  // the ctx holds all start empty, since the caller may have touched the ctx.
  const outer = _measurer;
  _measurer = new Measurer(ctx);
  let box: LayoutBox;
  let height: number;
  try {
    // The styledTree root is our container div — layout its children as a block flow
    ({ box, height } = layoutBlock(ctx, styledTree, 0, 0, containerWidth, undefined, true));

    // Add list markers post-layout
    addListMarkersRecursive(ctx, box, styledTree);
  } finally {
    // A call made from inside another (a debug callback) hands the ctx back
    // in a state the outer measurer did not write.
    _measurer = outer;
    outer?.invalidate();
  }

  // Sort by baseline y, then by left edge so cross-cell content merges in
  // reading order (LTR). List markers sit at smaller x than their content
  // and so come first, producing "• Item" rather than "Item •".
  const sorted = _lines.slice().sort((a, b) =>
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
  return { root: box, height, lines };
}

function addListMarkersRecursive(
  ctx: CanvasRenderingContext2D,
  box: LayoutBox,
  node: StyledNode,
): void {
  addListMarker(ctx, box, node);

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
        addListMarkersRecursive(ctx, layoutChild, styledChild);
        boxChildIdx++;
        break;
      }
      boxChildIdx++;
    }
  }
}
