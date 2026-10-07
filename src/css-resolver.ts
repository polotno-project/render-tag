import type { BorderRadius, DecorationEntry, ResolvedStyle, StyledNode } from './types.js';
import { INTEGER_PERCENT_LINE_HEIGHT } from './engine.js';
import { bidiClass } from './bidi.js';
import { parseDeclarationList, parseStylesheet } from './css-syntax.js';
import { SelectorMatcher, parseSelectorList, type ElementContext, type ParsedSelector } from './css-selectors.js';
import {
  FONT_SIZE_KEYWORDS, LEGACY_FONT_SIZES, resolveFontSize, resolveFontWeight, resolveLength, resolveNumberOrLength,
  type FontUnits, type LengthBasis, type Viewport,
} from './css-values.js';
import {
  BORDER_STYLES, KEYWORDS, backgroundClip, display, fontStyle, isColor, isFontFamilyList, isImageList,
  MATH, isImage, isTextShadow, listStyleType, paintOrder, parseLegacyColor, splitTopLevel,
  splitTopLevelWhitespace, textDecorationLine, textTransform, verticalAlign,
} from './css-validate.js';

// Node.TEXT_NODE / Node.ELEMENT_NODE without the ambient `Node` global
// (unavailable in non-browser environments).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function isTransparent(color: string): boolean {
  if (!color) return true;
  const value = color.trim().toLowerCase();
  if (!value || value === 'transparent' || /^#(?:[\da-f]{3}0|[\da-f]{6}00)$/.test(value)) return true;
  // Legacy comma alpha and modern slash alpha. Only resolve literal alpha;
  // computed expressions such as color-mix() need a CSS colour evaluator.
  const alpha = value.match(/^(?:rgba?|hsla?)\([^,()]+,[^,()]+,[^,()]+,\s*([^,()\s]+)\s*\)$/)?.[1]
    ?? value.match(/^[a-z-]+\([^()]*\/\s*([^()\s]+)\s*\)$/)?.[1];
  return alpha !== undefined && Number(alpha.replace(/%$/, '')) <= 0;
}

/** A shorthand's longhand, or one declaration as the cascade applies it. */
interface Longhand {
  property: string;
  value: string;
}

/** A declaration with its importance, as a rule or `style=""` carries it. */
interface Declaration extends Longhand {
  important: boolean;
}

/**
 * Options of one resolve call. The resolver itself touches no ctx: viewport
 * units and font-relative units come from what the caller passes here.
 */
export interface ResolveOptions {
  /**
   * The layout viewport for vw/vh/vmin/vmax. Without one (text on a path has
   * none) a viewport unit is invalid and its declaration is ignored.
   */
  viewport?: Viewport;
  /**
   * Measures `ch` (advance of `0`) and `ex` (x-height) for a style's font.
   * Called only when such a unit occurs. Without it both are 0.5em, the
   * CSS Values 4 fallback for a font whose metrics are unknown.
   */
  fontUnits?: (style: ResolvedStyle) => FontUnits;
}

// ─── Style Resolution ────────────────────────────────────────────────

/**
 * The resolver's private per-style fields, under SYMBOL keys. A symbol-keyed
 * own property is copied by every spread layout makes (`{ ...style,
 * direction }`) and declared in `defaultStyle()`'s literal (one hidden class
 * for all styles), yet it is not a public field: `Object.keys`, `for…in` and
 * JSON never show it (tests/node/public-exports.test.ts). String keys could
 * have only one of those: always declared (enumerable on every public style)
 * or added on demand (a hidden-class change per style, measured at +10%
 * layout time on perf50).
 */
/** Unitless line-height multiplier; children re-resolve it (see types.ts). */
export const LINE_HEIGHT_MULTIPLIER: unique symbol = Symbol('lineHeightMultiplier');
/** Percentage text-underline-offset; children re-resolve it. */
export const UNDERLINE_OFFSET_PCT: unique symbol = Symbol('underlineOffsetPct');
/** `overflow-x`/`-y`, read only to find BFC roots (`establishesBfc`). */
export const OVERFLOW_X: unique symbol = Symbol('overflowX');
export const OVERFLOW_Y: unique symbol = Symbol('overflowY');
/** `box-sizing`: 'border-box', or undefined for the initial `content-box` (`borderBoxSize`). */
const BOX_SIZING: unique symbol = Symbol('boxSizing');
/** The containing-block percentages behind this style's lengths (`resolvePercentages`). */
const PERCENT_LENGTHS: unique symbol = Symbol('percentLengths');

interface PrivateStyleFields {
  [LINE_HEIGHT_MULTIPLIER]: number | undefined;
  [UNDERLINE_OFFSET_PCT]: number | undefined;
  [OVERFLOW_X]: string | undefined;
  [OVERFLOW_Y]: string | undefined;
  [BOX_SIZING]: string | undefined;
  [PERCENT_LENGTHS]: PercentLengths | undefined;
}

/**
 * The ResolvedStyle fields a percentage of a WIDTH can set: the containing
 * block's width, except for the `OWN_PERCENT_FIELDS`.
 */
type PercentField =
  | 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'
  | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft'
  | 'width' | 'minWidth' | 'flexBasis' | 'gap' | 'textIndent';
const PERCENT_FIELDS: ReadonlySet<string> = new Set<PercentField>([
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'width', 'minWidth', 'flexBasis', 'gap', 'textIndent',
]);
/**
 * Percentages of the box's OWN content width, not its containing block's:
 * `text-indent` (CSS Text 3 §8.1: the block container's own inner inline
 * size) and a flex container's `gap` (CSS Box Alignment 3 §8.3: its content
 * box). Measured in Chromium and WebKit: `width:300px; text-indent:10%`
 * indents 30px inside a 400px parent, and `gap:10%` there is 30px. An
 * inherited `text-indent` inherits the PERCENTAGE (its computed value), so
 * it resolves against the inheriting block (`inheritPercentages`).
 * `resolveOwnPercentages` resolves them once the box's width is known.
 */
const OWN_PERCENT_FIELDS: ReadonlySet<PercentField> = new Set<PercentField>(['textIndent', 'gap']);

/**
 * The side table behind a style's percentage lengths. The resolver threads a
 * containing-block width down the tree (`cbWidth`), exact for block flow;
 * where layout decides the width instead — a flex item, a table cell, a
 * shrink-to-fit inline-block — it re-resolves the declarations kept here
 * against the width it settled on (`resolvePercentages`), and intrinsic
 * sizing reads them with the percentage at 0 (`intrinsicStyle`). Only a
 * style that declared a percentage has one.
 */
interface PercentLengths {
  /** What the declarations resolved against, the percentage aside: a snapshot of the element's basis. */
  readonly basis: LengthBasis;
  /**
   * Field → the (physical) declaration that set it, value as written — and,
   * for one inherited from an ancestor, the basis of the element that
   * declared it (its `em` is that element's).
   */
  readonly entries: Map<PercentField, PercentEntry>;
  /** The containing-block width the fields hold values for. */
  cb: number;
  /** The own content width the `OWN_PERCENT_FIELDS` hold values for. */
  own?: number;
  /** `intrinsicStyle`'s copy, and the style it was made for. */
  intrinsic?: ResolvedStyle;
  intrinsicFor?: ResolvedStyle;
}

type PercentEntry = readonly [property: string, value: string, basis?: LengthBasis];

type InternalStyle = ResolvedStyle & PrivateStyleFields;

/**
 * Default values for all ResolvedStyle properties, the private (symbol-keyed)
 * ones included, in one literal: all styles then share one hidden class, so
 * the resolver's and layout's property reads stay monomorphic.
 */
function defaultStyle(): ResolvedStyle {
  const style = {
    // Browsers default unstyled text to the UA serif font (Times). Match it so
    // HTML without an explicit font-family wraps/positions like the browser.
    fontFamily: 'serif',
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    fontVariantCaps: 'normal',
    color: 'rgb(0, 0, 0)',
    textAlign: 'start',
    textAlignLast: 'auto',
    textIndent: 0,
    textTransform: 'none',
    textDecorationLine: 'none',
    textDecorationStyle: 'solid',
    textDecorationColor: 'rgb(0, 0, 0)',
    textDecorations: [],
    textUnderlineOffset: null,
    textDecorationThickness: null,
    textShadow: 'none',
    webkitTextStrokeWidth: 0,
    webkitTextStrokeColor: '',
    webkitTextStrokeImage: 'none',
    webkitTextFillColor: '',
    paintOrder: 'normal',
    strokeLinejoin: 'round',
    webkitBackgroundClip: '',
    backgroundImage: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    fontKerning: 'auto',
    lineHeight: 0,
    verticalAlign: 'baseline',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    unicodeBidi: 'normal',
    direction: 'ltr',
    // CSS's initial value; the UA table makes block elements blocks.
    display: 'inline',
    width: 0,
    minWidth: null,
    minHeight: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: 0,
    borderTopColor: 'rgb(0, 0, 0)',
    borderTopStyle: 'none',
    borderRightWidth: 0,
    borderRightColor: 'rgb(0, 0, 0)',
    borderRightStyle: 'none',
    borderBottomWidth: 0,
    borderBottomColor: 'rgb(0, 0, 0)',
    borderBottomStyle: 'none',
    borderLeftWidth: 0,
    borderLeftColor: 'rgb(0, 0, 0)',
    borderLeftStyle: 'none',
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomLeftRadius: 0,
    flexDirection: 'row',
    gap: 0,
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: null,
    listStyleType: 'disc',
    lineClamp: 0,
  } as InternalStyle;
  // Assigned, not written as computed keys: a literal with computed keys
  // loses V8's fast literal path (defaultStyle went from 1% to 12% of resolve
  // time). Always the same six, in the same order, so the shape is shared.
  style[LINE_HEIGHT_MULTIPLIER] = undefined;
  style[UNDERLINE_OFFSET_PCT] = undefined;
  style[OVERFLOW_X] = undefined;
  style[OVERFLOW_Y] = undefined;
  style[BOX_SIZING] = undefined;
  style[PERCENT_LENGTHS] = undefined;
  return style;
}

/**
 * The HTML UA stylesheet, as far as render-tag renders it. An element not
 * listed here gets CSS's initial `display: inline` — unknown and custom
 * elements, `<label>`, `<abbr>`, `<time>`, ... — so only real block elements
 * break lines.
 *
 * Encoding (resolved per element in `resolveElement`): a `fontSize` below 10
 * is a multiple of the parent's size, a negative margin is a multiple of the
 * element's own em.
 */
const BLOCK: Partial<ResolvedStyle> = { display: 'block' };
const HIDDEN: Partial<ResolvedStyle> = { display: 'none' };
const BLOCK_MARGINS: Partial<ResolvedStyle> = { display: 'block', marginTop: -1, marginBottom: -1 };
const LIST: Partial<ResolvedStyle> = { display: 'block', listStyleType: 'disc', marginTop: -1, marginBottom: -1 };
const PRE: Partial<ResolvedStyle> = { display: 'block', whiteSpace: 'pre', fontFamily: 'monospace', marginTop: -1, marginBottom: -1 };
const MONOSPACE: Partial<ResolvedStyle> = { fontFamily: 'monospace' };
const ITALIC: Partial<ResolvedStyle> = { fontStyle: 'italic' };
const BOLD: Partial<ResolvedStyle> = { fontWeight: 700 };
const UNDERLINE: Partial<ResolvedStyle> = { textDecorationLine: 'underline' };
const LINE_THROUGH: Partial<ResolvedStyle> = { textDecorationLine: 'line-through' };

const TAG_DEFAULTS: Record<string, Partial<ResolvedStyle>> = {
  strong: BOLD,
  b: BOLD,
  em: ITALIC,
  i: ITALIC,
  cite: ITALIC,
  var: ITALIC,
  dfn: ITALIC,
  u: UNDERLINE,
  ins: UNDERLINE,
  s: LINE_THROUGH,
  strike: LINE_THROUGH,
  del: LINE_THROUGH,
  sub: { verticalAlign: 'sub', fontSize: 0.83 },
  sup: { verticalAlign: 'super', fontSize: 0.83 },
  // `font-size: smaller` / `larger`: the parent's size over / times 1.2.
  small: { fontSize: 1 / 1.2 },
  big: { fontSize: 1.2 },
  mark: { backgroundColor: 'yellow', color: 'black' },
  nobr: { whiteSpace: 'nowrap' },
  code: MONOSPACE,
  kbd: MONOSPACE,
  samp: MONOSPACE,
  tt: MONOSPACE,
  // The HTML rendering rules (and Blink/WebKit's computed style) give <bdo>
  // `isolate-override`, not `bidi-override`.
  bdo: { unicodeBidi: 'isolate-override' },
  bdi: { unicodeBidi: 'isolate' },

  html: BLOCK, body: BLOCK, div: BLOCK, article: BLOCK, aside: BLOCK, footer: BLOCK, header: BLOCK,
  hgroup: BLOCK, main: BLOCK, nav: BLOCK, search: BLOCK, section: BLOCK, figcaption: BLOCK, form: BLOCK,
  dialog: BLOCK, legend: BLOCK, fieldset: BLOCK, details: BLOCK, summary: BLOCK, dt: BLOCK, optgroup: BLOCK,
  // Table internals stay plain blocks: layout reads rows through them.
  thead: BLOCK, tbody: BLOCK, tfoot: BLOCK, caption: BLOCK, colgroup: BLOCK, col: BLOCK,
  address: { display: 'block', fontStyle: 'italic' },
  center: { display: 'block', textAlign: 'center' },
  p: BLOCK_MARGINS,
  dl: BLOCK_MARGINS,
  dd: BLOCK, // + margin-inline-start: 40px, set with the list paddings
  figure: { display: 'block', marginTop: -1, marginBottom: -1, marginLeft: 40, marginRight: 40 },
  h1: { display: 'block', fontSize: 2, fontWeight: 700, marginTop: -0.67, marginBottom: -0.67 },
  h2: { display: 'block', fontSize: 1.5, fontWeight: 700, marginTop: -0.83, marginBottom: -0.83 },
  h3: { display: 'block', fontSize: 1.17, fontWeight: 700, marginTop: -1, marginBottom: -1 },
  h4: { display: 'block', fontSize: 1, fontWeight: 700, marginTop: -1.33, marginBottom: -1.33 },
  h5: { display: 'block', fontSize: 0.83, fontWeight: 700, marginTop: -1.67, marginBottom: -1.67 },
  h6: { display: 'block', fontSize: 0.67, fontWeight: 700, marginTop: -2.33, marginBottom: -2.33 },
  ul: LIST,
  menu: LIST,
  dir: LIST,
  ol: { display: 'block', listStyleType: 'decimal', marginTop: -1, marginBottom: -1 },
  li: { display: 'list-item' },
  blockquote: { display: 'block', marginTop: -1, marginBottom: -1, marginLeft: 40, marginRight: 40 },
  pre: PRE,
  listing: PRE,
  xmp: PRE,
  plaintext: PRE,
  table: { display: 'table' },
  tr: { display: 'table-row' },
  td: { display: 'table-cell' },
  th: { display: 'table-cell', fontWeight: 700 },
  hr: {
    display: 'block',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: 'gray',
    marginTop: -0.5,
    marginBottom: -0.5,
  },
  // Never rendered.
  head: HIDDEN, title: HIDDEN, meta: HIDDEN, link: HIDDEN, base: HIDDEN, template: HIDDEN,
  noembed: HIDDEN, noframes: HIDDEN, param: HIDDEN, rp: HIDDEN, datalist: HIDDEN, area: HIDDEN,
};

/** The UA `display` of a tag: `inline` unless the UA sheet says otherwise. */
function uaDisplay(tag: string): string {
  return TAG_DEFAULTS[tag]?.display ?? 'inline';
}

/**
 * TAG_DEFAULTS minus fontSize (resolved first, separately), as
 * [field, css property, value] — the kebab-case name precomputed once.
 */
const TAG_DEFAULT_ENTRIES: Record<string, [string, string, unknown][]> = {};
for (const [tag, def] of Object.entries(TAG_DEFAULTS)) {
  TAG_DEFAULT_ENTRIES[tag] = Object.entries(def)
    .filter(([key]) => key !== 'fontSize')
    .map(([key, val]) => [key, key.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), val]);
}

/**
 * The presentational hints of `<font color size face>`: author-level
 * declarations with zero specificity, before every stylesheet rule.
 */
function fontHints(el: Element): Declaration[] {
  const out: Declaration[] = [];
  const color = parseLegacyColor(el.getAttribute('color') ?? '');
  if (color) out.push({ property: 'color', value: color, important: false });
  const face = el.getAttribute('face');
  if (face) out.push({ property: 'font-family', value: face, important: false });
  // HTML "rules for parsing a legacy font size": [+-]digits, relative to 3, clamped to 1-7.
  const size = /^\s*([+-]?)(\d+)/.exec(el.getAttribute('size') ?? '');
  if (size) {
    const n = parseInt(size[2], 10);
    const value = size[1] === '+' ? 3 + n : size[1] === '-' ? 3 - n : n;
    const px = LEGACY_FONT_SIZES[Math.min(7, Math.max(1, value)) - 1];
    out.push({ property: 'font-size', value: `${px}px`, important: false });
  }
  return out;
}

/**
 * Resolve `paint-order` to whether stroke is painted before fill.
 * Per CSS spec, missing tokens append in order: fill, stroke, markers.
 * So `stroke` alone implies `stroke fill markers` (stroke first).
 */
export function paintOrderHasStrokeFirst(paintOrder: string): boolean {
  const v = paintOrder.trim().toLowerCase();
  if (!v || v === 'normal') return false;
  const tokens = v.split(/\s+/).filter(t => t === 'fill' || t === 'stroke');
  const strokeIdx = tokens.indexOf('stroke');
  const fillIdx = tokens.indexOf('fill');
  if (strokeIdx === -1) return false;
  if (fillIdx === -1) return true;
  return strokeIdx < fillIdx;
}

function flexLonghands(grow: string, shrink: string, basis: string): Longhand[] {
  return [
    { property: 'flex-grow', value: grow },
    { property: 'flex-shrink', value: shrink },
    { property: 'flex-basis', value: basis },
  ];
}

/**
 * Expand shorthand properties into individual ones.
 * E.g., margin: 10px 20px → marginTop/Right/Bottom/Left
 */
export function expandShorthand(property: string, value: string): Longhand[] {
  if (property === 'margin' || property === 'padding') {
    const parts = value.trim().split(/\s+/);
    let top: string, right: string, bottom: string, left: string;
    if (parts.length === 1) {
      top = right = bottom = left = parts[0];
    } else if (parts.length === 2) {
      top = bottom = parts[0];
      right = left = parts[1];
    } else if (parts.length === 3) {
      top = parts[0]; right = left = parts[1]; bottom = parts[2];
    } else {
      top = parts[0]; right = parts[1]; bottom = parts[2]; left = parts[3];
    }
    return [
      { property: `${property}-top`, value: top },
      { property: `${property}-right`, value: right },
      { property: `${property}-bottom`, value: bottom },
      { property: `${property}-left`, value: left },
    ];
  }

  if (property === 'border' || property === 'border-top' || property === 'border-right' ||
      property === 'border-bottom' || property === 'border-left') {
    // Split at paren-depth 0: `rgb(29, 78, 216)` is one token, and the
    // browser rewrites even hex colors to that form when the shorthand comes
    // from a style="" attribute. A plain whitespace split truncated the color
    // to `rgb(29,`, which canvas silently drops — the border then painted
    // with whatever strokeStyle was left over from the previous box.
    // Each of width, style and color at most once, in any order; anything
    // else makes the whole declaration invalid. Unnamed parts reset.
    let width = '', style = '', color = '';
    for (const p of splitTopLevelWhitespace(value.trim())) {
      const lower = p.toLowerCase();
      if (!width && (/^[+-]?(?:\d|\.\d)/.test(p) || MATH.test(p) || lower in BORDER_WIDTH_KEYWORDS)) width = p;
      else if (!style && BORDER_STYLES.has(lower)) style = lower;
      else if (!color && isColor(p)) color = p;
      else return [];
    }
    if (!width && !style && !color) return [];
    width ||= 'medium';
    style ||= 'none';
    color ||= 'currentcolor';
    const result: Longhand[] = [];
    const sides = property === 'border'
      ? ['top', 'right', 'bottom', 'left']
      : [property.replace('border-', '')];
    for (const side of sides) {
      result.push({ property: `border-${side}-width`, value: width });
      result.push({ property: `border-${side}-style`, value: style });
      result.push({ property: `border-${side}-color`, value: color });
    }
    return result;
  }

  if (property === 'border-width' || property === 'border-style' || property === 'border-color') {
    // 1-4 values, top/right/bottom/left like margin; colors keep their spaces.
    const [top, right = top, bottom = top, left = right] = splitTopLevelWhitespace(value.trim());
    const kind = property.slice('border-'.length);
    return [
      { property: `border-top-${kind}`, value: top },
      { property: `border-right-${kind}`, value: right },
      { property: `border-bottom-${kind}`, value: bottom },
      { property: `border-left-${kind}`, value: left },
    ];
  }

  if (property === 'font') return expandFont(value);
  if (property === 'background') return expandBackground(value);

  if (property === 'border-radius') {
    // 1-4 values assign corners as TL, TR, BR, BL (css-backgrounds §4.5).
    // Elliptical `4px / 2px` keeps only the horizontal radii: BorderRadius
    // stores ONE component per corner, so an independent vertical set has
    // nowhere to live. (A bare percentage still paints elliptically — the
    // renderer resolves it against each axis.)
    const parts = value.split('/')[0].trim().split(/\s+/);
    const [tl, tr = tl, br = tl, bl = tr] = parts;
    return [
      { property: 'border-top-left-radius', value: tl },
      { property: 'border-top-right-radius', value: tr },
      { property: 'border-bottom-right-radius', value: br },
      { property: 'border-bottom-left-radius', value: bl },
    ];
  }

  if (property === 'list-style') {
    // `<position> || <image> || <type>`: only the type reaches ResolvedStyle.
    // A `none` with no other type is the type (`list-style: none`); one
    // beside a type is the image. Unnamed parts reset (the type to disc).
    let type = '';
    let nones = 0;
    for (const p of splitTopLevelWhitespace(value.trim())) {
      const lower = p.toLowerCase();
      if (lower === 'none') nones++;
      else if (lower === 'inside' || lower === 'outside' || isImage(p)) continue;
      else if (!type && listStyleType(p) !== null) type = p;
      else return [];
    }
    if (nones > (type ? 1 : 2)) return [];
    return [{ property: 'list-style-type', value: type || (nones > 0 ? 'none' : 'disc') }];
  }

  if (property === 'text-decoration') {
    // `<line> || <style> || <color> || <thickness>` (css-text-decor-4). The
    // shorthand RESETS every longhand it does not name — line to none, style
    // to solid, color to currentcolor, thickness to auto — and a token none
    // of them accepts makes the whole declaration invalid.
    const v = value.trim();
    // `inherit` stays `none`: textDecorationLine holds the propagated UNION
    // of lines, so copying it would declare every ancestor's line again.
    if (v.toLowerCase() === 'inherit') {
      return [
        { property: 'text-decoration-line', value: 'none' },
        { property: 'text-decoration-thickness', value: 'auto' },
      ];
    }
    if (/^(?:initial|unset|revert|revert-layer)$/i.test(v)) {
      return ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness']
        .map(property => ({ property, value: v }));
    }
    const lines: string[] = [];
    let style = '', color = '', thickness = '', none = false;
    for (const p of splitTopLevelWhitespace(v)) {
      const lower = p.toLowerCase();
      if (lower === 'none' && !none && lines.length === 0) none = true;
      else if (!none && (lower === 'underline' || lower === 'overline' || lower === 'line-through' || lower === 'blink') &&
          !lines.includes(lower)) lines.push(lower);
      else if (!style && KEYWORDS['text-decoration-style'].has(lower)) style = lower;
      else if (!thickness && (lower === 'auto' || lower === 'from-font' || /^[\d.+-]/.test(p) || MATH.test(p))) thickness = p;
      else if (!color && isColor(p)) color = p;
      else return [];
    }
    return [
      { property: 'text-decoration-line', value: lines.length > 0 ? lines.join(' ') : 'none' },
      { property: 'text-decoration-style', value: style || 'solid' },
      { property: 'text-decoration-color', value: color || 'currentcolor' },
      { property: 'text-decoration-thickness', value: thickness || 'auto' },
    ];
  }

  if (property === '-webkit-text-stroke') {
    // -webkit-text-stroke: 1px #1e40af → width + color
    // Split on whitespace at paren-depth 0 so colors with internal spaces
    // (rgb(255, 255, 255), color(srgb 1 0 0), …) survive intact.
    let width = '', color = '';
    for (const p of splitTopLevelWhitespace(value.trim())) {
      if (!width && (/^[+-]?(?:\d|\.\d)/.test(p) || MATH.test(p) || p.toLowerCase() in BORDER_WIDTH_KEYWORDS)) width = p;
      else if (!color && isColor(p)) color = p;
      else return [];
    }
    if (!width && !color) return [];
    width ||= '0';
    color ||= 'currentcolor';
    return [
      { property: '-webkit-text-stroke-width', value: width },
      { property: '-webkit-text-stroke-color', value: color },
    ];
  }

  if (property === 'flex') {
    // The basis is what the shorthand is really for: `flex: 1` is `1 1 0%`,
    // so the item ignores its own content width, while `flex-grow: 1` alone
    // leaves the basis `auto` and grows from the content width instead.
    const keyword = value.trim().toLowerCase();
    if (keyword === 'none') return flexLonghands('0', '0', 'auto');
    if (keyword === 'auto') return flexLonghands('1', '1', 'auto');
    if (keyword === 'initial') return flexLonghands('0', '1', 'auto');
    const numbers: string[] = [];
    let basis = '';
    for (const part of value.trim().split(/\s+/)) {
      if (!basis && numbers.length < 2 && /^\d*\.?\d+$/.test(part)) numbers.push(part);
      else basis = part;
    }
    if (numbers.length === 0 && !basis) return [];
    return flexLonghands(
      numbers[0] ?? '1',
      numbers[1] ?? '1',
      basis || (numbers.length > 0 ? '0' : 'auto'),
    );
  }

  if (property === 'border-collapse' || property === 'border-spacing') {
    // Ignored — table-specific properties we don't handle
    return [];
  }

  return [{ property, value }];
}

/** `thin`/`medium`/`thick` border widths, as Blink, WebKit and Gecko size them. */
const BORDER_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

const FONT_STYLES = new Set(['normal', 'italic', 'oblique']);
const FONT_WEIGHTS = new Set(['bold', 'bolder', 'lighter']);
const FONT_STRETCHES = new Set([
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
]);
const isFontSizeKeyword = (v: string) => Object.hasOwn(FONT_SIZE_KEYWORDS, v) || v === 'larger' || v === 'smaller';

/**
 * The `font` shorthand (CSS Fonts 4 §2.8):
 * `[ style || variant-caps || weight || stretch ]? size [ / line-height ]? family`.
 * It RESETS every sub-property it does not name — line-height to normal,
 * weight to 400 and so on — so an inherited value never survives it. Without
 * a size and a family the declaration is invalid and ignored, as is a system
 * font keyword (`caption`, `menu`, ...), which canvas cannot name.
 */
function expandFont(value: string): Longhand[] {
  const v = value.trim();
  if (/^(?:inherit|initial|unset|revert)$/i.test(v)) {
    return ['font-style', 'font-variant-caps', 'font-weight', 'font-size', 'line-height', 'font-family']
      .map(property => ({ property, value: v }));
  }
  let fontStyle = 'normal', variant = 'normal', weight = 'normal';
  // Whitespace-separated tokens at paren depth 0, with where each starts.
  const re = /(?:[^\s(]|\([^)]*\))+/g;
  let m: RegExpExecArray | null;
  let prefixTokens = 0;
  while ((m = re.exec(v)) !== null) {
    const token = m[0];
    const lower = token.toLowerCase();
    if (prefixTokens < 4) {
      // `normal` resets whichever of the four it lands on; all are normal already.
      if (lower === 'normal') { prefixTokens++; continue; }
      if (FONT_STYLES.has(lower)) { fontStyle = lower; prefixTokens++; continue; }
      if (lower === 'small-caps') { variant = lower; prefixTokens++; continue; }
      if (FONT_WEIGHTS.has(lower) || /^\d+(?:\.\d+)?$/.test(token)) { weight = lower; prefixTokens++; continue; }
      if (FONT_STRETCHES.has(lower)) { prefixTokens++; continue; }
    }
    // The size, optionally glued to `/line-height` or followed by `/ lh`.
    const slash = token.indexOf('/');
    const size = slash === -1 ? token : token.slice(0, slash);
    if (!size || !(/^[+]?(?:\d|\.\d)/.test(size) || isFontSizeKeyword(size.toLowerCase()) ||
        MATH.test(size))) return [];
    let rest = v.slice(m.index + (slash === -1 ? token.length : slash)).trim();
    let lineHeight = 'normal';
    if (rest.startsWith('/')) {
      rest = rest.slice(1).trim();
      const lh = /^(?:[^\s(]|\([^)]*\))+/.exec(rest);
      if (!lh) return [];
      lineHeight = lh[0];
      rest = rest.slice(lh[0].length).trim();
    }
    if (!rest) return [];
    return [
      { property: 'font-style', value: fontStyle },
      { property: 'font-variant-caps', value: variant },
      { property: 'font-weight', value: weight },
      { property: 'font-size', value: size },
      { property: 'line-height', value: lineHeight },
      { property: 'font-family', value: rest },
    ];
  }
  return [];
}

/** `background-repeat`/`-attachment`/`-position`/`-size` keywords: parsed past, not rendered. */
const BACKGROUND_KEYWORDS = new Set([
  'repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round', 'scroll', 'fixed', 'local',
  'left', 'right', 'top', 'bottom', 'center', 'auto', 'cover', 'contain', '/',
]);
const BACKGROUND_BOXES = new Set(['border-box', 'padding-box', 'content-box', 'text']);

/**
 * The `background` shorthand. It RESETS every longhand it does not name, so
 * `background: none` is transparent (not a color called "none") and a color
 * alone clears an earlier image. Only the color, the image list and the clip
 * reach ResolvedStyle; positions, sizes and repeats are parsed past. The
 * color may only come in the final layer; a token nothing accepts makes the
 * whole declaration invalid.
 */
function expandBackground(value: string): Longhand[] {
  const v = value.trim();
  if (/^(?:inherit|initial|unset|revert)$/i.test(v)) {
    return ['background-color', 'background-image', 'background-clip'].map(property => ({ property, value: v }));
  }
  let color = 'transparent';
  let colorSeen = false;
  let clip = 'border-box';
  const images: string[] = [];
  const layers = splitTopLevel(v, ',');
  for (let li = 0; li < layers.length; li++) {
    let image = 'none';
    const boxes: string[] = [];
    for (const token of splitTopLevelWhitespace(layers[li])) {
      const lower = token.toLowerCase();
      if (lower === 'none' || isImage(token)) {
        image = lower === 'none' ? 'none' : token;
      } else if (BACKGROUND_BOXES.has(lower)) {
        boxes.push(lower);
      } else if (BACKGROUND_KEYWORDS.has(lower) || /^[+-]?(?:\d|\.\d)/.test(token) || MATH.test(token) ||
          /^\//.test(token)) {
        // position / size / repeat / attachment — not rendered
      } else if (li === layers.length - 1 && !colorSeen && isColor(token)) {
        color = token;
        colorSeen = true;
      } else {
        return [];
      }
    }
    images.push(image);
    // One box sets origin and clip; with two, the second is the clip.
    if (li === layers.length - 1 && boxes.length > 0) clip = boxes[boxes.length - 1];
  }
  return [
    { property: 'background-color', value: color },
    { property: 'background-image', value: images.every(i => i === 'none') ? 'none' : images.join(', ') },
    { property: 'background-clip', value: clip },
  ];
}

/** Normalize the (case-insensitive) currentColor keyword to '', the canonical unset value. */
function normalizeCurrentColor(value: string): string {
  const v = value.trim();
  return v.toLowerCase() === 'currentcolor' ? '' : v;
}

const FONT_VARIANT_CAPS = new Set([
  'normal', 'small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps',
]);

/** Properties the cascade resolves FIRST: everything else may measure the font (em, ch, ex). */
const FONT_PROPERTIES = new Set(['font-size', 'font-family', 'font-weight', 'font-style', 'font-variant', 'font-variant-caps']);

/**
 * Apply a font declaration. Relative sizes and weights resolve against the
 * PARENT (`parentBasis`: em/%/ch/ex of the parent's font). Returns false for
 * an invalid value, which the cascade then ignores.
 */
function applyFontDeclaration(
  style: ResolvedStyle,
  property: string,
  value: string,
  parent: ResolvedStyle,
  parentBasis: LengthBasis,
): boolean {
  switch (property) {
    case 'font-family':
      if (!isFontFamilyList(value)) return false;
      style.fontFamily = value.trim();
      return true;
    case 'font-size': {
      const px = resolveFontSize(value, parent.fontSize, parentBasis);
      if (Number.isNaN(px)) return false;
      style.fontSize = px;
      return true;
    }
    case 'font-weight': {
      const weight = resolveFontWeight(value, parent.fontWeight);
      if (Number.isNaN(weight)) return false;
      style.fontWeight = weight;
      return true;
    }
    case 'font-style': {
      const v = fontStyle(value);
      if (v === null) return false;
      style.fontStyle = v;
      return true;
    }
    // Canvas only renders the `small-caps` variant; map anything containing it
    // (incl. the font-variant shorthand) to small-caps, else normal.
    case 'font-variant-caps':
      if (!FONT_VARIANT_CAPS.has(value.trim().toLowerCase())) return false;
      style.fontVariantCaps = value.trim().toLowerCase() === 'small-caps' ? 'small-caps' : 'normal';
      return true;
    case 'font-variant':
      style.fontVariantCaps = /\bsmall-caps\b/i.test(value) ? 'small-caps' : 'normal';
      return true;
  }
  return false;
}

/**
 * The ResolvedStyle fields each property writes, for the CSS-wide keywords.
 * A logical property maps through the direction (`physical`).
 */
const PROPERTY_FIELDS: Record<string, readonly (keyof InternalStyle)[]> = {
  'font-family': ['fontFamily'], 'font-size': ['fontSize'], 'font-weight': ['fontWeight'],
  'font-style': ['fontStyle'], 'font-variant-caps': ['fontVariantCaps'], color: ['color'],
  'text-align': ['textAlign'], 'text-align-last': ['textAlignLast'], 'text-indent': ['textIndent'],
  'text-transform': ['textTransform'], 'white-space': ['whiteSpace'], 'word-break': ['wordBreak'],
  'overflow-wrap': ['overflowWrap'], direction: ['direction'], 'letter-spacing': ['letterSpacing'],
  'word-spacing': ['wordSpacing'], 'line-height': ['lineHeight', LINE_HEIGHT_MULTIPLIER],
  'text-shadow': ['textShadow'], 'font-kerning': ['fontKerning'], 'list-style-type': ['listStyleType'],
  'vertical-align': ['verticalAlign'], 'text-underline-offset': ['textUnderlineOffset', UNDERLINE_OFFSET_PCT],
  'paint-order': ['paintOrder'], 'stroke-linejoin': ['strokeLinejoin'],
  '-webkit-text-stroke-width': ['webkitTextStrokeWidth'], '-webkit-text-stroke-color': ['webkitTextStrokeColor'],
  '-webkit-text-fill-color': ['webkitTextFillColor'],
  'text-decoration-line': ['textDecorationLine'], 'text-decoration-style': ['textDecorationStyle'],
  'text-decoration-color': ['textDecorationColor'], 'text-decoration-thickness': ['textDecorationThickness'],
  '--rt-text-stroke-image': ['webkitTextStrokeImage'], 'background-clip': ['webkitBackgroundClip'],
  'background-image': ['backgroundImage'], 'background-color': ['backgroundColor'],
  'line-clamp': ['lineClamp'], '-webkit-line-clamp': ['lineClamp'], 'unicode-bidi': ['unicodeBidi'],
  display: ['display'], width: ['width'], 'min-width': ['minWidth'], 'min-height': ['minHeight'],
  overflow: [OVERFLOW_X, OVERFLOW_Y], 'overflow-x': [OVERFLOW_X], 'overflow-y': [OVERFLOW_Y],
  'padding-top': ['paddingTop'], 'padding-right': ['paddingRight'], 'padding-bottom': ['paddingBottom'],
  'padding-left': ['paddingLeft'], 'margin-top': ['marginTop'], 'margin-right': ['marginRight'],
  'margin-bottom': ['marginBottom'], 'margin-left': ['marginLeft'],
  'border-top-width': ['borderTopWidth'], 'border-top-color': ['borderTopColor'], 'border-top-style': ['borderTopStyle'],
  'border-right-width': ['borderRightWidth'], 'border-right-color': ['borderRightColor'], 'border-right-style': ['borderRightStyle'],
  'border-bottom-width': ['borderBottomWidth'], 'border-bottom-color': ['borderBottomColor'], 'border-bottom-style': ['borderBottomStyle'],
  'border-left-width': ['borderLeftWidth'], 'border-left-color': ['borderLeftColor'], 'border-left-style': ['borderLeftStyle'],
  'border-top-left-radius': ['borderTopLeftRadius'], 'border-top-right-radius': ['borderTopRightRadius'],
  'border-bottom-right-radius': ['borderBottomRightRadius'], 'border-bottom-left-radius': ['borderBottomLeftRadius'],
  'flex-direction': ['flexDirection'], gap: ['gap'], 'flex-grow': ['flexGrow'], 'flex-shrink': ['flexShrink'],
  'flex-basis': ['flexBasis'], 'box-sizing': [BOX_SIZING],
};

/** The properties render-tag inherits (see `inheritFont` and `inheritFrom`). */
const INHERITED_PROPERTIES = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-caps', 'color', 'text-align',
  'text-align-last', 'text-indent', 'text-transform', 'white-space', 'word-break', 'overflow-wrap',
  'direction', 'letter-spacing', 'word-spacing', 'line-height', 'text-shadow', 'font-kerning',
  'list-style-type', 'vertical-align', 'text-underline-offset', 'paint-order', 'stroke-linejoin',
  '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-text-fill-color',
]);

/** Initial values. Colors whose initial value is `currentcolor` say so, for the fix-ups to resolve. */
const INITIAL: Readonly<InternalStyle> = Object.freeze({
  ...(defaultStyle() as InternalStyle),
  textDecorationColor: 'currentcolor',
  borderTopColor: 'currentcolor',
  borderRightColor: 'currentcolor',
  borderBottomColor: 'currentcolor',
  borderLeftColor: 'currentcolor',
});

const LOGICAL_PROPERTIES: Record<string, [ltr: string, rtl: string]> = {
  'padding-inline-start': ['padding-left', 'padding-right'],
  'padding-inline-end': ['padding-right', 'padding-left'],
  'margin-inline-start': ['margin-left', 'margin-right'],
  'margin-inline-end': ['margin-right', 'margin-left'],
};

/**
 * The CSS-wide keyword a declaration's value is, or null. `revert` and
 * `revert-layer` act as `unset` (render-tag does not keep the UA's value
 * apart). `color: currentcolor` is the inherited color.
 */
function cssWideKeyword(property: string, value: string): string | null {
  // Every keyword starts with c, i, r or u: most values are rejected without
  // allocating (values arrive trimmed; a padded one takes the slow path).
  const first = value.charCodeAt(0) | 0x20;
  if (first !== 0x63 && first !== 0x69 && first !== 0x72 && first !== 0x75 && first !== 0x20) return null;
  const v = value.trim().toLowerCase();
  if (v === 'inherit' || v === 'initial' || v === 'unset') return v;
  if (v === 'revert' || v === 'revert-layer') return 'unset';
  if (v === 'currentcolor' && property === 'color') return 'inherit';
  return null;
}

/**
 * Apply a CSS-wide keyword. An inherited property that inherits is simply
 * left unset, so `inheritFont`/`inheritFrom` copy it (and re-resolve a
 * unitless line-height for this element's font). Returns the canonical
 * property, or null when render-tag does not know it.
 */
function applyKeyword(
  style: ResolvedStyle,
  parent: ResolvedStyle,
  property: string,
  keyword: string,
  setProps: Set<string>,
  direction: string,
  concrete: CurrentColorTable,
): string | null {
  const logical = LOGICAL_PROPERTIES[property];
  const prop = logical ? logical[direction === 'rtl' ? 1 : 0] : (PROP_ALIASES[property] || property);
  const fields = PROPERTY_FIELDS[prop];
  if (!fields) return null;
  const inherited = INHERITED_PROPERTIES.has(prop);
  if (inherited && keyword !== 'initial') {
    setProps.delete(prop);
    return prop;
  }
  const source = (keyword === 'inherit' ? parent : INITIAL) as InternalStyle;
  for (const field of fields) (style as any)[field] = source[field];
  // A parent's currentcolor computed value is the keyword, not its color:
  // the child resolves it against its own color.
  if (keyword === 'inherit' && CURRENTCOLOR_FIELDS.has(fields[0]) && !concrete.get(parent)?.has(fields[0])) {
    (style as any)[fields[0]] = 'currentcolor';
  }
  setProps.add(prop);
  return prop;
}

/** Color fields whose initial value is `currentcolor`, resolved per element after the cascade, with their property. */
const CURRENTCOLOR_PROPERTIES: readonly [keyof InternalStyle, string][] = [
  ['textDecorationColor', 'text-decoration-color'], ['borderTopColor', 'border-top-color'],
  ['borderRightColor', 'border-right-color'], ['borderBottomColor', 'border-bottom-color'],
  ['borderLeftColor', 'border-left-color'],
];
const CURRENTCOLOR_FIELDS = new Set(CURRENTCOLOR_PROPERTIES.map(([field]) => field));

/**
 * Per resolve call: which CURRENTCOLOR_FIELDS of a style hold a concrete
 * color rather than a resolved `currentcolor`. Absent = all currentcolor.
 * (A side table, not a style field: it is only read for `inherit`.)
 */
type CurrentColorTable = Map<ResolvedStyle, Set<keyof InternalStyle>>;

/** What phase-2 declarations of one element resolve against. */
interface DeclarationEnv {
  /** em = the element's own font-size; `percent` is set per property. */
  b: LengthBasis;
  containerWidth: number;
  /** The parent's direction: logical properties map through it. */
  direction: string;
  /** Set when the declaration just applied read a percentage of `containerWidth` (`cbLengthOf`). */
  percent: boolean;
}

/** A `<length-percentage>` with `percentBase` as 100%; NaN when invalid. */
function lengthOf(value: string, env: DeclarationEnv, percentBase: number): number {
  env.b.percent = percentBase;
  return resolveLength(value, env.b);
}

/**
 * A `<length-percentage>` of the containing block's width. A percentage is
 * flagged (`env.percent`) so the declaration is kept for layout to resolve
 * again once it knows the width it actually uses (`PercentLengths`).
 */
function cbLengthOf(value: string, env: DeclarationEnv): number {
  if (value.includes('%')) env.percent = true;
  return lengthOf(value, env, env.containerWidth);
}

/** Atomic inline-level boxes: their content is a formatting context of its own. */
const ATOMIC_INLINE = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table', '-webkit-inline-box']);

/**
 * Record the cascade's latest word on a containing-block-relative field:
 * `value` when the declaration that set it used a percentage, null when a
 * later one (or a CSS-wide keyword) replaced it with a fixed length.
 * `env.b` (the element's basis, re-aimed per element) is copied on first use.
 */
function trackPercent(
  style: ResolvedStyle, property: string, value: string | null, env: DeclarationEnv, cbWidth: number,
): void {
  const direction = env.direction;
  const logical = LOGICAL_PROPERTIES[property];
  const physical = logical ? logical[direction === 'rtl' ? 1 : 0] : property;
  const field = PROPERTY_FIELDS[physical]?.[0];
  if (field === undefined || !PERCENT_FIELDS.has(field as string)) return;
  const internal = style as InternalStyle;
  let table = internal[PERCENT_LENGTHS];
  if (value === null) {
    table?.entries.delete(field as PercentField);
    return;
  }
  if (!table) {
    table = internal[PERCENT_LENGTHS] = { basis: { ...env.b }, entries: new Map(), cb: cbWidth };
  }
  table.entries.set(field as PercentField, [physical, value]);
}

/**
 * Re-resolve `style`'s percentage lengths against `cbWidth`, the width layout
 * gave its containing block, and write the used values into the style. A
 * no-op for a style with no percentage, or already at that width (the
 * resolver's own width included, so block flow never moves). True when a
 * value changed.
 */
export function resolvePercentages(style: ResolvedStyle, cbWidth: number): boolean {
  const table = (style as InternalStyle)[PERCENT_LENGTHS];
  if (!table || table.cb === cbWidth || table.entries.size === 0) return false;
  table.cb = cbWidth;
  return applyPercentEntries(style, table, cbWidth, false);
}

/**
 * Resolve `style`'s percentages of its OWN content width
 * (`OWN_PERCENT_FIELDS`: text-indent, gap) against `contentWidth`, the width
 * its content box settled on. A no-op without one, or at the same width.
 */
export function resolveOwnPercentages(style: ResolvedStyle, contentWidth: number): void {
  const table = (style as InternalStyle)[PERCENT_LENGTHS];
  if (!table || table.own === contentWidth || table.entries.size === 0) return;
  table.own = contentWidth;
  applyPercentEntries(style, table, contentWidth, true);
}

/** Re-apply the cb-relative (`own` false) or own-width entries at `width`; true when a value changed. */
function applyPercentEntries(style: ResolvedStyle, table: PercentLengths, width: number, own: boolean): boolean {
  let changed = false;
  const env: DeclarationEnv = { b: { ...table.basis }, containerWidth: width, direction: 'ltr', percent: false };
  for (const [field, [property, value, basis]] of table.entries) {
    if (OWN_PERCENT_FIELDS.has(field) !== own) continue;
    env.b = { ...(basis ?? table.basis) };
    const before = style[field];
    applyDeclaration(style, property, value, env);
    if (style[field] !== before) changed = true;
  }
  return changed;
}

/**
 * Carry the parent's percentage `text-indent` into `child`, which inherits
 * it (`setProps` has no text-indent of its own): the computed value is the
 * percentage, and it resolves against the CHILD's content width
 * (`resolveOwnPercentages`), not as the parent's px.
 */
function inheritPercentages(child: ResolvedStyle, parent: ResolvedStyle, cbWidth: number): void {
  const parentTable = (parent as InternalStyle)[PERCENT_LENGTHS];
  const entry = parentTable?.entries.get('textIndent');
  if (!entry) return;
  const inherited: PercentEntry = [entry[0], entry[1], entry[2] ?? parentTable!.basis];
  const internal = child as InternalStyle;
  let table = internal[PERCENT_LENGTHS];
  if (!table) table = internal[PERCENT_LENGTHS] = { basis: inherited[2]!, entries: new Map(), cb: cbWidth };
  table.entries.set('textIndent', inherited);
}

/**
 * `style` as intrinsic sizing reads it: a percentage of the containing block
 * is CYCLIC there — that block's width is what is being computed — so it
 * counts as 0, and a percentage width, min-width or flex-basis as `auto`
 * (CSS Sizing 3 §5.2.1; Blink and WebKit measured: a 20% padding inside an
 * inline-block adds nothing to its width, then resolves against it). The
 * style itself when it has no percentage.
 */
export function intrinsicStyle(style: ResolvedStyle): ResolvedStyle {
  const table = (style as InternalStyle)[PERCENT_LENGTHS];
  if (!table || table.entries.size === 0) return style;
  if (table.intrinsicFor === style) return table.intrinsic!;
  const copy = { ...style } as InternalStyle;
  const env: DeclarationEnv = { b: { ...table.basis }, containerWidth: 0, direction: 'ltr', percent: false };
  for (const [field, [property, value, basis]] of table.entries) {
    if (field === 'width') copy.width = 0;
    else if (field === 'minWidth') copy.minWidth = null;
    else if (field === 'flexBasis') copy.flexBasis = null;
    else {
      env.b = { ...(basis ?? table.basis) };
      applyDeclaration(copy, property, value, env);
    }
  }
  table.intrinsicFor = style;
  table.intrinsic = copy;
  return copy;
}

/**
 * The border-box size a `width`, `min-width`, `min-height` or `flex-basis`
 * of `size` px gives under `box-sizing` (CSS Box Sizing 3): `content-box`
 * adds `frame` (padding + border on that axis); `border-box` includes it, and
 * never shrinks the box below it.
 */
export function borderBoxSize(style: ResolvedStyle, size: number, frame: number): number {
  return isBorderBox(style) ? Math.max(size, frame) : size + frame;
}

/** The content-box size the same declaration gives: `borderBoxSize` without the frame. */
export function contentBoxSize(style: ResolvedStyle, size: number, frame: number): number {
  return isBorderBox(style) ? Math.max(0, size - frame) : size;
}

/**
 * The style of an anonymous block box inside an element styled `style`
 * (CSS 2.1 §9.2.1.1): what it inherits, and every other property at its
 * initial value — no margins, padding, border, background or sizes of its
 * own, and no percentages to re-resolve.
 */
export function anonymousBlockStyle(style: ResolvedStyle): ResolvedStyle {
  const anonymous = { ...style } as InternalStyle;
  for (const [property, fields] of Object.entries(PROPERTY_FIELDS)) {
    // Decorations propagate into the anonymous box's text: keep them whole
    // (`textDecorations` and its `textDecorationLine` union go together).
    if (INHERITED_PROPERTIES.has(property) || property.startsWith('text-decoration')) continue;
    for (const field of fields) (anonymous as any)[field] = INITIAL[field];
  }
  // Initial currentcolor, resolved as the resolver resolves every style's.
  for (const [field] of CURRENTCOLOR_PROPERTIES) (anonymous as any)[field] = anonymous.color;
  anonymous.display = 'block';
  anonymous[PERCENT_LENGTHS] = undefined;
  // It inherits text-indent, a percentage included, of its own width.
  inheritPercentages(anonymous, style, NaN);
  return anonymous;
}

/** `box-sizing: border-box`. */
function isBorderBox(style: ResolvedStyle): boolean {
  return (style as InternalStyle)[BOX_SIZING] === 'border-box';
}

/** A non-negative border/stroke width (keywords allowed, no percentages). */
function widthOf(value: string, env: DeclarationEnv): number {
  const keyword = BORDER_WIDTH_KEYWORDS[value.trim().toLowerCase()];
  if (keyword !== undefined) return keyword;
  const px = lengthOf(value, env, NaN);
  return px >= 0 ? px : NaN;
}

/** `margin`: a length-percentage of the containing block's width; `auto` is 0 here (no auto margins). */
function marginOf(value: string, env: DeclarationEnv): number {
  return value.trim().toLowerCase() === 'auto' ? 0 : cbLengthOf(value, env);
}

/** `padding`: a non-negative length-percentage of the containing block's width. */
function paddingOf(value: string, env: DeclarationEnv): number {
  const px = cbLengthOf(value, env);
  return px >= 0 ? px : NaN;
}

/**
 * A border-radius value: px, or `{ pct }` resolved at paint; negatives stay
 * 0, and a second (elliptical) component on a longhand is ignored.
 */
function borderRadiusValue(value: string, env: DeclarationEnv): BorderRadius | null {
  const v = MATH.test(value.trim()) ? value.trim() : value.trim().split(/\s+/)[0];
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
    const pct = parseFloat(v);
    return pct > 0 ? { pct } : 0;
  }
  const px = lengthOf(v, env, NaN);
  return Number.isNaN(px) ? null : Math.max(0, px);
}

/**
 * Apply a (non-font) CSS declaration to a ResolvedStyle, resolving units.
 * Returns false when the value is invalid: the declaration is then ignored,
 * as a browser ignores it, instead of overwriting the cascaded value.
 */
function applyDeclaration(style: ResolvedStyle, property: string, value: string, env: DeclarationEnv): boolean {
  const fontSize = style.fontSize;
  /** Assign a numeric result unless it is invalid. */
  const set = <K extends keyof ResolvedStyle>(key: K, px: number): boolean => {
    if (Number.isNaN(px)) return false;
    (style as unknown as Record<K, number>)[key] = px;
    return true;
  };
  /** Assign a validated string (keyword lower-cased by its check) unless it is null. */
  const str = <K extends keyof InternalStyle>(key: K, v: string | null): boolean => {
    if (v === null) return false;
    (style as unknown as Record<K, string>)[key] = v;
    return true;
  };
  /** A single keyword from the property's KEYWORDS set, lower-cased, or null. */
  const keyword = (): string | null => {
    const v = value.trim().toLowerCase();
    return KEYWORDS[property].has(v) ? v : null;
  };
  /** A color, as written (canvas parses it), or null. */
  const color = (): string | null => (isColor(value) ? value.trim() : null);

  switch (property) {
    case 'color': return str('color', color());
    case 'text-align': return str('textAlign', keyword());
    case 'text-align-last': return str('textAlignLast', keyword());
    case 'text-indent': return set('textIndent', cbLengthOf(value, env));
    case 'text-transform': return str('textTransform', textTransform(value));
    case 'text-decoration-line': return str('textDecorationLine', textDecorationLine(value));
    case 'text-decoration-style': return str('textDecorationStyle', keyword());
    case 'text-decoration-color': return str('textDecorationColor', color());
    case 'text-underline-offset': {
      // px value or null for `auto`; the UNDERLINE_OFFSET_PCT shadow lets
      // inheritFrom re-resolve a % per child (see the field doc in types.ts).
      // `= undefined` rather than `delete`: same semantics for the only
      // consumer (`!== undefined`), keeps the object's hidden class.
      const v = value.trim();
      if (v.toLowerCase() === 'auto') {
        (style as InternalStyle)[UNDERLINE_OFFSET_PCT] = undefined;
        style.textUnderlineOffset = null;
        return true;
      }
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
        const num = parseFloat(v);
        style.textUnderlineOffset = (num / 100) * fontSize;
        (style as InternalStyle)[UNDERLINE_OFFSET_PCT] = num;
        return true;
      }
      const px = lengthOf(v, env, fontSize);
      if (Number.isNaN(px)) return false;
      (style as InternalStyle)[UNDERLINE_OFFSET_PCT] = undefined;
      style.textUnderlineOffset = px;
      return true;
    }
    case 'text-decoration-thickness': {
      // px value or null for `auto`/`from-font` (see the field doc in
      // types.ts). A % resolves against the element's own font size.
      const v = value.trim();
      const lower = v.toLowerCase();
      if (lower === 'auto' || lower === 'from-font') {
        style.textDecorationThickness = null;
        return true;
      }
      const px = lengthOf(v, env, fontSize);
      if (Number.isNaN(px)) return false;
      style.textDecorationThickness = px;
      return true;
    }
    case 'text-shadow': return str('textShadow', isTextShadow(value) ? (value.trim().toLowerCase() === 'none' ? 'none' : value.trim()) : null);
    case '-webkit-text-stroke-width': return set('webkitTextStrokeWidth', widthOf(value, env));
    // '' is the canonical currentColor for these two: it must survive
    // inheritance as a keyword and resolve against each element's own
    // color at render time, so it is never eagerly resolved here.
    case '-webkit-text-stroke-color': return isColor(value) && str('webkitTextStrokeColor', normalizeCurrentColor(value));
    // A CSS custom property (not a real -webkit- property): a browser drops an
    // unknown real property whenever it re-serializes a style (contenteditable,
    // el.style writes), so html that passed through an editor would lose it.
    case '--rt-text-stroke-image': style.webkitTextStrokeImage = value.trim(); return true;
    case '-webkit-text-fill-color': return isColor(value) && str('webkitTextFillColor', normalizeCurrentColor(value));
    case 'paint-order': return str('paintOrder', paintOrder(value));
    case 'stroke-linejoin': return str('strokeLinejoin', keyword());
    case '-webkit-background-clip':
    case 'background-clip': return str('webkitBackgroundClip', backgroundClip(value));
    case 'background-image':
      return str('backgroundImage', isImageList(value) ? (value.trim().toLowerCase() === 'none' ? 'none' : value.trim()) : null);
    // Percentages are of the element's own font-size (CSS Text 4; Blink, WebKit).
    case 'letter-spacing':
      return set('letterSpacing', value.trim().toLowerCase() === 'normal' ? 0 : lengthOf(value, env, fontSize));
    case 'word-spacing':
      return set('wordSpacing', value.trim().toLowerCase() === 'normal' ? 0 : lengthOf(value, env, fontSize));
    case 'font-kerning': return str('fontKerning', keyword());
    case 'line-height': {
      const v = value.trim();
      const internal = style as InternalStyle;
      if (v.toLowerCase() === 'normal') {
        internal[LINE_HEIGHT_MULTIPLIER] = undefined;
        style.lineHeight = 0; // 0 signals "normal"
        return true;
      }
      let lineHeight: number;
      let multiplier: number | undefined;
      if (/^[+]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
        // Percentage — computed against the element's own font size and
        // inherited as that computed value (no multiplier for children).
        // Blink and WebKit use an INTEGER percentage (INTEGER_PERCENT_LINE_HEIGHT).
        const num = parseFloat(v);
        lineHeight = ((INTEGER_PERCENT_LINE_HEIGHT ? Math.trunc(num) : num) / 100) * fontSize;
      } else {
        env.b.percent = fontSize;
        const t = resolveNumberOrLength(v, env.b);
        if (!t || t.value < 0) return false;
        // A number is a multiplier: computed for this element's font size,
        // and children re-compute it for theirs.
        if (t.number) multiplier = t.value;
        lineHeight = t.number ? t.value * fontSize : t.value;
      }
      style.lineHeight = lineHeight;
      // `lineHeight: 0` means `normal`, so a real zero line-height (any unit)
      // is carried as the multiplier 0 — which also inherits as 0.
      internal[LINE_HEIGHT_MULTIPLIER] = lineHeight === 0 ? 0 : multiplier;
      return true;
    }
    case '-webkit-line-clamp':
    case 'line-clamp': {
      // Spec accepts `none` / `auto` / positive integer. We map both
      // `none` and `auto` to 0 (no clamp); a non-positive integer also
      // means no clamp. Otherwise store the integer.
      const v = value.trim().toLowerCase();
      if (v === 'none' || v === 'auto') {
        style.lineClamp = 0;
      } else {
        const n = parseInt(v, 10);
        style.lineClamp = Number.isFinite(n) && n > 0 ? n : 0;
      }
      return true;
    }
    case 'vertical-align': return str('verticalAlign', verticalAlign(value));
    case 'white-space': return str('whiteSpace', keyword());
    case 'word-break': return str('wordBreak', keyword());
    case 'overflow-wrap':
    case 'word-wrap': return str('overflowWrap', keyword());
    case 'direction': return str('direction', keyword());
    case 'unicode-bidi': return str('unicodeBidi', keyword());

    // Box model
    case 'display': return str('display', display(value));
    case 'box-sizing': {
      const v = keyword();
      if (v === null) return false;
      (style as InternalStyle)[BOX_SIZING] = v === 'border-box' ? v : undefined;
      return true;
    }
    case 'width': {
      const v = value.trim();
      if (v.toLowerCase() === 'auto') { style.width = 0; return true; }
      const px = cbLengthOf(v, env);
      return px >= 0 ? set('width', px) : false;
    }
    case 'min-width': {
      const v = value.trim();
      if (v.toLowerCase() === 'auto') { style.minWidth = null; return true; }
      const px = cbLengthOf(v, env);
      if (!(px >= 0)) return false;
      style.minWidth = px;
      return true;
    }
    // A percentage resolves against the containing block's HEIGHT, which is
    // never definite here (no box has a height): it computes to none (CSS 2.1
    // §10.7), not to a share of the width.
    case 'min-height': {
      const v = value.trim();
      if (v.toLowerCase() === 'auto' || /%/.test(v)) { style.minHeight = 0; return true; }
      const px = lengthOf(v, env, NaN);
      return px >= 0 ? set('minHeight', px) : false;
    }
    // Only read to find block formatting context roots (`establishesBfc`);
    // render-tag does not clip. Private, like LINE_HEIGHT_MULTIPLIER.
    case 'overflow': {
      const [x, y = x, extra] = value.trim().toLowerCase().split(/\s+/);
      const allowed = KEYWORDS['overflow-x'];
      if (extra !== undefined || !allowed.has(x) || !allowed.has(y)) return false;
      (style as InternalStyle)[OVERFLOW_X] = x;
      (style as InternalStyle)[OVERFLOW_Y] = y;
      return true;
    }
    case 'overflow-x': return str(OVERFLOW_X, keyword());
    case 'overflow-y': return str(OVERFLOW_Y, keyword());
    case 'padding-top': return set('paddingTop', paddingOf(value, env));
    case 'padding-right': return set('paddingRight', paddingOf(value, env));
    case 'padding-bottom': return set('paddingBottom', paddingOf(value, env));
    case 'padding-left': return set('paddingLeft', paddingOf(value, env));
    case 'margin-top': return set('marginTop', marginOf(value, env));
    case 'margin-right': return set('marginRight', marginOf(value, env));
    case 'margin-bottom': return set('marginBottom', marginOf(value, env));
    case 'margin-left': return set('marginLeft', marginOf(value, env));
    case 'background-color': return str('backgroundColor', color());

    // Logical properties → physical (based on direction)
    case 'padding-inline-start':
      return set(env.direction === 'rtl' ? 'paddingRight' : 'paddingLeft', paddingOf(value, env));
    case 'padding-inline-end':
      return set(env.direction === 'rtl' ? 'paddingLeft' : 'paddingRight', paddingOf(value, env));
    case 'margin-inline-start':
      return set(env.direction === 'rtl' ? 'marginRight' : 'marginLeft', marginOf(value, env));
    case 'margin-inline-end':
      return set(env.direction === 'rtl' ? 'marginLeft' : 'marginRight', marginOf(value, env));

    // Border
    case 'border-top-width': return set('borderTopWidth', widthOf(value, env));
    case 'border-top-color': return str('borderTopColor', color());
    case 'border-top-style': return str('borderTopStyle', keyword());
    case 'border-right-width': return set('borderRightWidth', widthOf(value, env));
    case 'border-right-color': return str('borderRightColor', color());
    case 'border-right-style': return str('borderRightStyle', keyword());
    case 'border-bottom-width': return set('borderBottomWidth', widthOf(value, env));
    case 'border-bottom-color': return str('borderBottomColor', color());
    case 'border-bottom-style': return str('borderBottomStyle', keyword());
    case 'border-left-width': return set('borderLeftWidth', widthOf(value, env));
    case 'border-left-color': return str('borderLeftColor', color());
    case 'border-left-style': return str('borderLeftStyle', keyword());

    // Border radius. Percentages resolve against the border box's own size,
    // unknown until paint, so they stay symbolic here (see BorderRadius).
    case 'border-top-left-radius':
    case 'border-top-right-radius':
    case 'border-bottom-right-radius':
    case 'border-bottom-left-radius': {
      const radius = borderRadiusValue(value, env);
      if (radius === null) return false;
      if (property === 'border-top-left-radius') style.borderTopLeftRadius = radius;
      else if (property === 'border-top-right-radius') style.borderTopRightRadius = radius;
      else if (property === 'border-bottom-right-radius') style.borderBottomRightRadius = radius;
      else style.borderBottomLeftRadius = radius;
      return true;
    }

    // Flex
    case 'flex-direction': return str('flexDirection', keyword());
    case 'gap': {
      const v = value.trim();
      // `gap: <row> <column>`: the row gap is first; flex rows use one gap.
      const first = MATH.test(v) ? v : v.split(/\s+/)[0];
      return set('gap', first.toLowerCase() === 'normal' ? 0 : cbLengthOf(first, env));
    }
    // A non-negative <number>; anything else is invalid.
    case 'flex-grow':
    case 'flex-shrink': {
      const n = /^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? parseFloat(value) : NaN;
      return set(property === 'flex-grow' ? 'flexGrow' : 'flexShrink', n);
    }
    case 'flex-basis': {
      const v = value.trim();
      const lower = v.toLowerCase();
      if (lower === 'auto' || lower === 'content') { style.flexBasis = null; return true; }
      const px = cbLengthOf(v, env);
      if (!(px >= 0)) return false;
      style.flexBasis = px;
      return true;
    }

    // List
    case 'list-style-type': return str('listStyleType', listStyleType(value));
  }
  // Unknown or ignored properties (position, opacity, transform, ...).
  return false;
}

/**
 * The inherited font properties, resolved before any other declaration (so
 * em, ch and ex see the element's final font): font-family, font-weight,
 * font-style, font-variant-caps. (font-size is resolved with them.)
 */
function inheritFont(child: ResolvedStyle, parent: ResolvedStyle, setProps: Set<string>): void {
  if (!setProps.has('font-size')) child.fontSize = parent.fontSize;
  if (!setProps.has('font-family')) child.fontFamily = parent.fontFamily;
  if (!setProps.has('font-weight')) child.fontWeight = parent.fontWeight;
  if (!setProps.has('font-style')) child.fontStyle = parent.fontStyle;
  if (!setProps.has('font-variant-caps')) child.fontVariantCaps = parent.fontVariantCaps;
}

/**
 * Inherit properties from parent style to child style for properties
 * not explicitly set (tracked via setProps). The inherited properties
 * (the font ones are inherited earlier, by `inheritFont`):
 *
 *   color, text-align, text-align-last, text-indent,
 *   text-transform, white-space, word-break, overflow-wrap, direction,
 *   letter-spacing, word-spacing, line-height, text-shadow, font-kerning,
 *   list-style-type, vertical-align, text-underline-offset, paint-order,
 *   stroke-linejoin, -webkit-text-stroke-width, -webkit-text-stroke-color,
 *   -webkit-text-fill-color.
 *
 * Written out field by field rather than looped over a key table: a keyed
 * `child[key] = parent[key]` over ~26 names is megamorphic and was a quarter
 * of all resolve time.
 *
 * A CSS-wide `inherit`/`unset` never reaches a field: `applyKeyword` leaves
 * the property unset, so it is copied here like any other.
 */
function inheritFrom(child: ResolvedStyle, parent: ResolvedStyle, setProps: Set<string>): void {
  const c = child as InternalStyle, p = parent as InternalStyle;
  if (!setProps.has('color')) c.color = p.color;
  if (!setProps.has('text-align')) c.textAlign = p.textAlign;
  if (!setProps.has('text-align-last')) c.textAlignLast = p.textAlignLast;
  if (!setProps.has('text-indent')) c.textIndent = p.textIndent;
  if (!setProps.has('text-transform')) c.textTransform = p.textTransform;
  if (!setProps.has('white-space')) c.whiteSpace = p.whiteSpace;
  if (!setProps.has('word-break')) c.wordBreak = p.wordBreak;
  if (!setProps.has('overflow-wrap')) c.overflowWrap = p.overflowWrap;
  if (!setProps.has('direction')) c.direction = p.direction;
  if (!setProps.has('letter-spacing')) c.letterSpacing = p.letterSpacing;
  if (!setProps.has('word-spacing')) c.wordSpacing = p.wordSpacing;
  if (!setProps.has('line-height')) {
    // Unitless line-height: re-compute relative to child's font-size
    const multiplier = p[LINE_HEIGHT_MULTIPLIER];
    if (multiplier !== undefined) {
      c.lineHeight = multiplier * c.fontSize;
      c[LINE_HEIGHT_MULTIPLIER] = multiplier;
    } else {
      c.lineHeight = p.lineHeight;
    }
  }
  if (!setProps.has('text-shadow')) c.textShadow = p.textShadow;
  if (!setProps.has('font-kerning')) c.fontKerning = p.fontKerning;
  if (!setProps.has('list-style-type')) c.listStyleType = p.listStyleType;
  if (!setProps.has('vertical-align')) c.verticalAlign = p.verticalAlign;
  if (!setProps.has('text-underline-offset')) {
    // Percentage offset: re-resolve against the child's own font size
    // (Chrome-measured), same pattern as the line-height multiplier.
    const pct = p[UNDERLINE_OFFSET_PCT];
    if (pct !== undefined) {
      c.textUnderlineOffset = (pct / 100) * c.fontSize;
      c[UNDERLINE_OFFSET_PCT] = pct;
    } else {
      c.textUnderlineOffset = p.textUnderlineOffset;
    }
  }
  if (!setProps.has('paint-order')) c.paintOrder = p.paintOrder;
  if (!setProps.has('stroke-linejoin')) c.strokeLinejoin = p.strokeLinejoin;
  if (!setProps.has('-webkit-text-stroke-width')) c.webkitTextStrokeWidth = p.webkitTextStrokeWidth;
  if (!setProps.has('-webkit-text-stroke-color')) c.webkitTextStrokeColor = p.webkitTextStrokeColor;
  if (!setProps.has('-webkit-text-fill-color')) c.webkitTextFillColor = p.webkitTextFillColor;
}

// ─── Main resolver ───────────────────────────────────────────────────

/** A pre-processed rule entry with parsed selector and pre-expanded declarations */
interface ProcessedRule {
  selector: ParsedSelector;
  declarations: Declaration[];
  /** Global order for cascade sorting */
  orderBase: number;
}

interface RuleIndex {
  byId: Map<string, ProcessedRule[]>;
  byClass: Map<string, ProcessedRule[]>;
  byTag: Map<string, ProcessedRule[]>;
  /** Rules whose rightmost compound has no id, class or plain tag. */
  universal: ProcessedRule[];
  /** Retained size, in entries + declarations: what the rule cache budgets. */
  cost: number;
}

function addTo(map: Map<string, ProcessedRule[]>, key: string, rule: ProcessedRule): void {
  const list = map.get(key);
  if (list) list.push(rule);
  else map.set(key, [rule]);
}

/**
 * Build an index of processed rules, each in ONE bucket by its rightmost
 * compound's most selective part: id, else first class, else tag (an
 * html/body/:root compound targets the root and goes to `universal`).
 * The index is shared between calls (see `ruleIndexFor`): nothing reachable
 * from it is ever written after this returns, and nothing from it reaches a
 * result — the cascade copies declaration strings out. (Not frozen: freezing
 * ~1k objects cost a quarter of a cold build. tests/node/determinism.test.ts
 * gates the isolation instead.)
 */
function buildRuleIndex(css: string): RuleIndex {
  const byId = new Map<string, ProcessedRule[]>();
  const byClass = new Map<string, ProcessedRule[]>();
  const byTag = new Map<string, ProcessedRule[]>();
  const universal: ProcessedRule[] = [];
  let orderBase = 0;
  let cost = 0;

  for (const rule of parseStylesheet(css)) {
    // Pre-expand declarations once
    const expandedDecls: Declaration[] = [];
    for (const decl of rule.declarations) {
      for (const exp of expandShorthand(decl.property, decl.value)) {
        expandedDecls.push({ property: exp.property, value: exp.value, important: decl.important });
      }
    }

    const selectors = parseSelectorList(rule.prelude);
    if (selectors.length > 0) cost += expandedDecls.length;
    for (const selector of selectors) {
      cost++;
      const entry: ProcessedRule = { selector, declarations: expandedDecls, orderBase: orderBase++ };
      const rm = selector.compounds[0];
      if (rm.id !== null) addTo(byId, rm.id, entry);
      else if (rm.classes.length > 0) addTo(byClass, rm.classes[0], entry);
      else if (rm.tag && !rm.rootAlias) addTo(byTag, rm.tag, entry);
      else universal.push(entry);
    }
  }

  return { byId, byClass, byTag, universal, cost };
}

/** Cascade order within one importance: specificity, then source order. */
function byCascadeOrder(a: ProcessedRule, b: ProcessedRule): number {
  return a.selector.spec - b.selector.spec || a.orderBase - b.orderBase;
}

/**
 * Rule indexes of the most recently used stylesheets, by their exact text.
 *
 * Safe to keep across calls because the index is a pure function of the css
 * string: it reads no ctx, font or DOM state, and nothing in it is mutable or
 * reaches a LayoutResult (declarations are copied out as strings). It pays off
 * in fit loops and re-renders, which resolve the same sheet many times.
 *
 * A sheet's index is admitted on the SECOND sighting of its text (the first
 * only records the key): a one-off sheet then never retains an index, whose
 * ~1k objects would otherwise be promoted and collected as old-generation
 * garbage — measured at +70 µs per call on a stream of distinct 300-rule
 * sheets.
 *
 * Bounded three ways, so memory cannot grow with use: at most
 * RULE_CACHE_ENTRIES sheets, RULE_CACHE_CHARS characters of key text (the key
 * is retained) and RULE_CACHE_COST index entries + declarations in total. The
 * last is the one that bounds the heap: an index is far bigger than its key
 * (a selector-heavy sheet retains ~85x its text; one unit costs ~0.3-0.55 KB).
 * Measured with `node --expose-gc` filling the budget with distinct sheets of
 * long selector chains, of plain selector lists, and of many declarations,
 * the cache retains at most ~5.6 MB (it was ~86 MB under the key-chars bound
 * alone). A sheet whose own index is over the budget is never cached; a
 * 300-rule sheet costs ~1,200.
 */
const RULE_CACHE_ENTRIES = 16;
const RULE_CACHE_CHARS = 1 << 20;
const RULE_CACHE_COST = 10_000;
const ruleCache = new Map<string, RuleIndex | null>();
let ruleCacheChars = 0;
let ruleCacheCost = 0;

function forget(key: string): void {
  const index = ruleCache.get(key);
  ruleCache.delete(key);
  ruleCacheChars -= key.length;
  if (index) ruleCacheCost -= index.cost;
}

function ruleIndexFor(css: string): RuleIndex {
  if (ruleCache.has(css)) {
    const cached = ruleCache.get(css)!;
    const index = cached ?? buildRuleIndex(css);
    forget(css);
    if (index.cost > RULE_CACHE_COST) return index; // too big to keep: never cached
    // Most recently used last: Map keeps insertion order.
    ruleCache.set(css, index);
    ruleCacheChars += css.length;
    ruleCacheCost += index.cost;
    evictRuleCache();
    return index;
  }
  if (css.length <= RULE_CACHE_CHARS) {
    ruleCache.set(css, null);
    ruleCacheChars += css.length;
    evictRuleCache();
  }
  return buildRuleIndex(css);
}

/** Drop least recently used sheets until every bound holds. */
function evictRuleCache(): void {
  for (const key of ruleCache.keys()) {
    if (ruleCache.size <= RULE_CACHE_ENTRIES && ruleCacheChars <= RULE_CACHE_CHARS &&
        ruleCacheCost <= RULE_CACHE_COST) break;
    forget(key);
  }
}

/** Format an integer using a CSS list-style-type. */
function formatListMarker(n: number, type: string): string {
  switch (type) {
    case 'disc': return '•';
    case 'circle': return '○';
    case 'square': return '■';
    case 'none': return '';
    case 'decimal-leading-zero':
      return `${n < 10 && n >= 0 ? '0' + n : n}.`;
    case 'lower-roman': return `${toRoman(n).toLowerCase()}.`;
    case 'upper-roman': return `${toRoman(n)}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${toAlpha(n).toLowerCase()}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${toAlpha(n)}.`;
    case 'decimal':
    default:
      return `${n}.`;
  }
}

function toRoman(n: number): string {
  if (n < 1 || n > 3999) return `${n}`;
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of map) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}

function toAlpha(n: number): string {
  if (n < 1) return `${n}`;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Each `<li>`'s ordinal in its list, by list element; built once per list per call. */
type ListOrdinals = Map<Element, Map<Element, number>>;

/**
 * The ordinal of every `<li>` child of `list`, honoring <ol start>,
 * <ol reversed> and <li value>. One pass per list: counting from the first
 * item again for each `<li>` made a 4,000-item list take 1.2s.
 */
function listOrdinals(list: Element, cache: ListOrdinals): Map<Element, number> {
  let ordinals = cache.get(list);
  if (!ordinals) {
    const liItems = Array.from(list.children).filter(c => c.tagName.toLowerCase() === 'li');
    const startAttr = list.getAttribute('start');
    const reversed = list.hasAttribute('reversed');
    const start = startAttr ? parseInt(startAttr, 10) : (reversed ? liItems.length : 1);
    const step = reversed ? -1 : 1;
    ordinals = new Map();
    let n = start;
    for (const item of liItems) {
      const valueAttr = item.getAttribute('value');
      if (valueAttr) {
        const v = parseInt(valueAttr, 10);
        if (!Number.isNaN(v)) n = v;
      }
      ordinals.set(item, n);
      n += step;
    }
    cache.set(list, ordinals);
  }
  return ordinals;
}

/**
 * Detect list marker text for a <li> element based on tree position,
 * honoring list-style-type, <ol start>, <ol reversed>, and <li value>.
 */
function getListMarker(el: Element, listStyleType: string, ordinals: ListOrdinals): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'li') return undefined;
  if (listStyleType === 'none') return '';

  const parent = el.parentElement;
  const parentTag = parent?.tagName.toLowerCase();

  // Bullet markers: independent of position.
  if (listStyleType === 'disc' || listStyleType === 'circle' || listStyleType === 'square') {
    return formatListMarker(0, listStyleType);
  }

  // Numbered markers: compute index from siblings + ol attributes + li value.
  if (parentTag === 'ol' || parentTag === 'ul' || !parent) {
    let n: number;
    if (parent) {
      // `el` is an <li> child of `parent`, so the pass over it numbered `el`.
      n = listOrdinals(parent, ordinals).get(el)!;
    } else {
      const v = parseInt(el.getAttribute('value') ?? '', 10);
      n = Number.isNaN(v) ? 1 : v;
    }
    return formatListMarker(n, listStyleType || 'decimal');
  }

  return undefined;
}

const NO_DECLARATIONS: readonly Declaration[] = Object.freeze([]);

/**
 * The element's `style=""` declarations as longhands, read from the attribute
 * itself (not the CSSOM's re-serialized `style.cssText`), parsed ONCE by the
 * shared tokenizer and expanded once. The attribute is the same string in
 * every DOM — browser, linkedom, jsdom — so no environment rewrites, expands
 * or drops a value before render-tag sees it.
 */
function inlineDeclarations(el: Element): readonly Declaration[] {
  const attr = el.getAttribute('style');
  if (!attr) return NO_DECLARATIONS;
  const out: Declaration[] = [];
  for (const decl of parseDeclarationList(attr)) {
    for (const longhand of expandShorthand(decl.property, decl.value)) {
      out.push({ property: longhand.property, value: longhand.value, important: decl.important });
    }
  }
  return out;
}

/**
 * `dir="auto"`: the direction of the first strong character in the element's
 * text (HTML "auto directionality", UAX #9 P2/P3), skipping descendants that
 * set their own direction (`[dir]`, `<bdi>`) and non-rendered text. null when
 * there is none; the element then keeps its parent's direction. Measured in
 * Chromium and WebKit: `<p dir="auto">שלום world 123</p>` is an RTL paragraph.
 */
function autoDirection(el: Element): 'ltr' | 'rtl' | null {
  for (const child of el.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      for (const ch of child.textContent ?? '') {
        const cls = bidiClass(ch.codePointAt(0)!);
        if (cls === 'L') return 'ltr';
        if (cls === 'R' || cls === 'AL') return 'rtl';
      }
    } else if (child.nodeType === ELEMENT_NODE) {
      const e = child as Element;
      const tag = e.tagName.toLowerCase();
      if (tag === 'bdi' || tag === 'script' || tag === 'style' || tag === 'textarea' ||
          e.hasAttribute('dir')) continue;
      const found = autoDirection(e);
      if (found) return found;
    }
  }
  return null;
}

/** Property aliases: CSS name → canonical name for setProps tracking. */
const PROP_ALIASES: Record<string, string> = {
  'word-wrap': 'overflow-wrap',
  'font-variant': 'font-variant-caps',
  '-webkit-background-clip': 'background-clip',
};

/**
 * `<q>`'s quotation marks by nesting depth: `quotes: auto` for an element
 * with no language, as Blink and WebKit render it (English curly quotes).
 * Language-specific quotes (`lang="fr"`) and the `quotes` property are not
 * supported.
 */
const QUOTES: readonly [string, string][] = [['“', '”'], ['‘', '’']];

/** Rules of `rules` that match `ctx`, sorted into element and `::marker` lists. */
function collectMatches(
  rules: ProcessedRule[] | undefined,
  matcher: SelectorMatcher,
  ctx: ElementContext,
  matched: ProcessedRule[],
  matchedMarker: ProcessedRule[],
): void {
  if (!rules) return;
  for (const rule of rules) {
    if (matcher.matches(rule.selector, ctx)) {
      (rule.selector.pseudoElement === 'marker' ? matchedMarker : matched).push(rule);
    }
  }
}

/**
 * An element's declarations in ascending cascade precedence (CSS Cascade 4),
 * into `out` (reused; `inlineFrom` marks where `style=""` ones start in each
 * importance): presentational hints, then normal declarations by
 * specificity and order with `style=""` above every rule, then `!important`
 * ones, where `style=""` again wins. Later entries win. Returns `out.length`.
 */
function cascadeOrder(
  hints: readonly Declaration[],
  matched: readonly ProcessedRule[],
  inline: readonly Declaration[],
  out: Declaration[],
  isInline: boolean[],
): number {
  let n = 0;
  for (const d of hints) { out[n] = d; isInline[n++] = false; }
  for (const rule of matched) for (const d of rule.declarations) if (!d.important) { out[n] = d; isInline[n++] = false; }
  for (const d of inline) if (!d.important) { out[n] = d; isInline[n++] = true; }
  for (const rule of matched) for (const d of rule.declarations) if (d.important) { out[n] = d; isInline[n++] = false; }
  for (const d of inline) if (d.important) { out[n] = d; isInline[n++] = true; }
  return n;
}

function textNode(text: string, style: ResolvedStyle): StyledNode {
  // A text node matches no rule and declares nothing: its style IS its
  // parent element's, so it shares the object rather than copying it
  // (41% of a styled tree's heap). Nothing downstream writes to a style.
  return { element: null, tagName: '#text', style, children: [], textContent: text };
}

/**
 * Resolve styles for a DOM tree without inserting into the document.
 * Parses CSS rules, matches selectors, resolves cascade + inheritance.
 */
export function resolveStylesFromCSS(
  fragment: DocumentFragment,
  css: string,
  containerWidth: number,
  options: ResolveOptions = {},
): StyledNode {
  const ruleIndex = ruleIndexFor(css);
  const viewport = options.viewport ?? null;
  const measureUnits = options.fontUnits;

  // Wrap fragment in a container div so resolveElement has a single root
  // Element. Created from the fragment's own document so no ambient DOM is
  // required (the tree is never inserted into the live document).
  const container = fragment.ownerDocument!.createElement('div');
  container.appendChild(fragment);

  const ordinals: ListOrdinals = new Map();
  const matcher = new SelectorMatcher();
  const concreteColors: CurrentColorTable = new Map();
  /** What `rem` resolves against: the root's font-size once it is known, the initial 16px before. */
  let rootFontSize = 16;

  /**
   * Lengths against `style`'s font (em, ch, ex). ONE object per call, re-aimed
   * per use: an element finishes its cascade before its children start.
   */
  const basis: LengthBasis = {
    em: 16, rem: 16, percent: NaN, viewport, fontStyle: null, measure: measureUnits,
  };
  function basisFor(style: ResolvedStyle, percent: number): LengthBasis {
    basis.em = style.fontSize;
    basis.rem = rootFontSize;
    basis.percent = percent;
    basis.fontStyle = style;
    return basis;
  }
  const env: DeclarationEnv = { b: basis, containerWidth, direction: 'ltr', percent: false };
  /** Scratch for `cascadeOrder`, reused by every element. */
  const order: Declaration[] = [];
  const orderInline: boolean[] = [];

  /**
   * The root's font-size as `html`/`:root` rules alone set it: what `rem`
   * means. The root container also stands for `body`, whose font-size is
   * not the root font-size.
   */
  function htmlFontSize(matched: readonly ProcessedRule[]): number {
    const base: LengthBasis = { em: 16, rem: 16, percent: 16, viewport, fontStyle: null, measure: undefined };
    let size = 16;
    const visit = (important: boolean) => {
      for (const rule of matched) {
        if (rule.selector.rootKind !== 'html') continue;
        for (const d of rule.declarations) {
          if (d.important !== important || d.property !== 'font-size') continue;
          const px = resolveFontSize(d.value, 16, base);
          if (!Number.isNaN(px)) size = px;
        }
      }
    };
    visit(false);
    visit(true);
    return size;
  }

  /**
   * `cbWidth`: the width of the element's containing block, which its
   * percentages (margin, padding, width, text-indent, ...) resolve against.
   */
  function resolveElement(
    el: Element,
    parentStyle: ResolvedStyle,
    parentCtx: ElementContext | null,
    cbWidth: number,
  ): StyledNode {
    const tag = el.tagName.toLowerCase();
    const ctx = matcher.context(el, parentCtx);

    // Start with defaults
    const style = defaultStyle();

    // Track which properties are explicitly set (tag defaults, CSS rules, inline styles)
    const setProps = new Set<string>();

    // Matching rules, in cascade order. Each rule sits in one index bucket.
    const matched: ProcessedRule[] = [];
    const matchedMarker: ProcessedRule[] = [];
    if (ruleIndex.byId.size > 0) {
      const id = el.getAttribute('id');
      if (id) collectMatches(ruleIndex.byId.get(id), matcher, ctx, matched, matchedMarker);
    }
    for (const cls of ctx.classes) collectMatches(ruleIndex.byClass.get(cls), matcher, ctx, matched, matchedMarker);
    collectMatches(ruleIndex.byTag.get(tag), matcher, ctx, matched, matchedMarker);
    collectMatches(ruleIndex.universal, matcher, ctx, matched, matchedMarker);
    if (matched.length > 1) matched.sort(byCascadeOrder);
    const hints = tag === 'font' ? fontHints(el) : NO_DECLARATIONS;
    const inline = inlineDeclarations(el);

    // --- Step 1: the UA stylesheet (tag defaults) ---
    const tagDef = TAG_DEFAULTS[tag];
    if (tagDef?.fontSize !== undefined) {
      const val = tagDef.fontSize as number;
      style.fontSize = val < 10 ? val * parentStyle.fontSize : val;
      setProps.add('font-size');
    }
    if (tagDef) {
      for (const [key, cssKey, val] of TAG_DEFAULT_ENTRIES[tag]) {
        (style as any)[key] = val;
        setProps.add(cssKey);
      }
    }
    // HTML's UA sheet: `[hidden] { display: none }` (an author display wins).
    if (el.hasAttribute('hidden')) style.display = 'none';
    // `:any-link { color: LinkText; text-decoration: underline }` — LinkText
    // is #0000ee in Blink, WebKit and Gecko.
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
      style.color = '#0000ee';
      style.textDecorationLine = 'underline';
      setProps.add('color');
      setProps.add('text-decoration-line');
    }

    // --- Step 2: the font, before anything that measures it (em, ch, ex) ---
    const count = cascadeOrder(hints, matched, inline, order, orderInline);
    for (let i = 0; i < count; i++) {
      const d = order[i];
      if (!FONT_PROPERTIES.has(d.property)) continue;
      const keyword = cssWideKeyword(d.property, d.value);
      if (keyword) applyKeyword(style, parentStyle, d.property, keyword, setProps, parentStyle.direction, concreteColors);
      else if (applyFontDeclaration(style, d.property, d.value, parentStyle, basisFor(parentStyle, parentStyle.fontSize))) {
        setProps.add(PROP_ALIASES[d.property] || d.property);
      }
    }
    inheritFont(style, parentStyle, setProps);
    if (parentCtx === null) rootFontSize = htmlFontSize(matched);
    const elemFontSize = style.fontSize;

    // --- Step 3: everything else, against the element's final font ---

    if (tagDef) {
      // Resolve negative margin values (em multipliers from tag defaults)
      if (style.marginTop < 0) style.marginTop = Math.abs(style.marginTop) * elemFontSize;
      if (style.marginBottom < 0) style.marginBottom = Math.abs(style.marginBottom) * elemFontSize;

      // Default padding-inline-start for lists, margin-inline-start for
      // <dd> (direction-aware).
      const rtl = parentStyle.direction === 'rtl';
      if (tag === 'ul' || tag === 'ol' || tag === 'menu' || tag === 'dir') {
        style[rtl ? 'paddingRight' : 'paddingLeft'] = 40;
        setProps.add(rtl ? 'padding-right' : 'padding-left');
      } else if (tag === 'dd') {
        style[rtl ? 'marginRight' : 'marginLeft'] = 40;
      }
    }

    // Logical properties resolve through the parent's direction.
    basisFor(style, cbWidth);
    env.containerWidth = cbWidth;
    env.direction = parentStyle.direction;
    let widthFromSheet = false;
    for (let i = 0; i < count; i++) {
      const d = order[i];
      if (FONT_PROPERTIES.has(d.property)) continue;
      const keyword = cssWideKeyword(d.property, d.value);
      if (keyword) {
        applyKeyword(style, parentStyle, d.property, keyword, setProps, env.direction, concreteColors);
        trackPercent(style, d.property, null, env, cbWidth);
      } else {
        env.percent = false;
        if (!applyDeclaration(style, d.property, d.value, env)) continue;
        setProps.add(PROP_ALIASES[d.property] || d.property);
        trackPercent(style, d.property, env.percent ? d.value : null, env, cbWidth);
      }
      if (d.property === 'width') widthFromSheet = !orderInline[i];
    }

    // Only keep explicit width from inline styles (match DOM resolver behavior)
    if (widthFromSheet) {
      style.width = 0;
      (style as InternalStyle)[PERCENT_LENGTHS]?.entries.delete('width');
    }

    // Handle `dir` attribute
    const dirAttr = el.getAttribute('dir')?.trim().toLowerCase();
    if (dirAttr === 'ltr' || dirAttr === 'rtl' || dirAttr === 'auto') {
      style.direction = dirAttr === 'auto'
        ? autoDirection(el) ?? parentStyle.direction
        : dirAttr;
      setProps.add('direction');
      // HTML's UA sheet: any element with `dir` isolates its content
      // (Blink and WebKit compute `isolate` for span[dir]; <bdo> keeps its
      // own override). An author `unicode-bidi` still wins.
      if (!setProps.has('unicode-bidi') && style.unicodeBidi === 'normal') {
        style.unicodeBidi = 'isolate';
      }
    }

    // Inherit from parent for properties not explicitly set
    inheritFrom(style, parentStyle, setProps);
    if (!setProps.has('text-indent')) inheritPercentages(style, parentStyle, cbWidth);

    // A border whose style is none or hidden computes to width 0 (CSS
    // Backgrounds 3): `border-top: 3px none red` takes no space and does not
    // stop a margin collapse.
    if (style.borderTopStyle === 'none' || style.borderTopStyle === 'hidden') style.borderTopWidth = 0;
    if (style.borderRightStyle === 'none' || style.borderRightStyle === 'hidden') style.borderRightWidth = 0;
    if (style.borderBottomStyle === 'none' || style.borderBottomStyle === 'hidden') style.borderBottomWidth = 0;
    if (style.borderLeftStyle === 'none' || style.borderLeftStyle === 'hidden') style.borderLeftWidth = 0;

    // Auto-set currentColor defaults (browser default behavior).
    // An automatic HTML decoration uses the text stroke color when a visible
    // stroke is enabled, otherwise the text fill color, falling back to `color`.
    // This selects the band's paint; it does not outline or widen the band.
    // Resolve it on the declarer so descendant runs and path text agree.
    for (const [field, prop] of CURRENTCOLOR_PROPERTIES) {
      if (setProps.has(prop) && String((style as InternalStyle)[field]).toLowerCase() !== 'currentcolor') {
        let set = concreteColors.get(style);
        if (!set) concreteColors.set(style, set = new Set());
        set.add(field);
      }
    }
    if (!setProps.has('text-decoration-color') || style.textDecorationColor.toLowerCase() === 'currentcolor') {
      const strokeColor = style.webkitTextStrokeColor || style.color;
      style.textDecorationColor = style.webkitTextStrokeWidth > 0 && !isTransparent(strokeColor)
        ? strokeColor
        : style.webkitTextFillColor || style.color;
    }
    // An unset border color is currentColor; so is the keyword, in any case.
    if (!setProps.has('border-top-color') || style.borderTopColor.toLowerCase() === 'currentcolor') style.borderTopColor = style.color;
    if (!setProps.has('border-right-color') || style.borderRightColor.toLowerCase() === 'currentcolor') style.borderRightColor = style.color;
    if (!setProps.has('border-bottom-color') || style.borderBottomColor.toLowerCase() === 'currentcolor') style.borderBottomColor = style.color;
    if (!setProps.has('border-left-color') || style.borderLeftColor.toLowerCase() === 'currentcolor') style.borderLeftColor = style.color;
    if (style.backgroundColor.toLowerCase() === 'currentcolor') style.backgroundColor = style.color;

    // Handle text-decoration inheritance (propagates visually, not via normal
    // inheritance). Each decoration keeps the color/style of the element that
    // DECLARED it (Chrome: a parent's red underline stays red across a blue
    // child <s>): ancestor entries ride along in `textDecorations`, own
    // entries are appended after them so they paint on top.
    // `textDecorationLine` stays the union of lines for cheap checks.
    const ownEntries: DecorationEntry[] = [];
    if (style.textDecorationLine && style.textDecorationLine !== 'none') {
      for (const d of style.textDecorationLine.split(/\s+/)) {
        if (d && d !== 'none') {
          ownEntries.push({
            line: d,
            color: style.textDecorationColor,
            style: style.textDecorationStyle,
            // This element is the decorating box for every descendant the
            // entry rides down to.
            declarer: style,
          });
        }
      }
    }
    // An atomic inline (inline-block, inline-flex, ...) is a box of its own:
    // no ancestor's decoration reaches its content (CSS Text Decoration 3
    // §2.1), and the ancestor's band leaves a gap where it sits — both
    // engines, measured (tests/decoration-shape-parity.test.ts).
    const atomic = ATOMIC_INLINE.has(style.display);
    style.textDecorations = parentStyle.textDecorations.length && !atomic
      ? [...parentStyle.textDecorations, ...ownEntries]
      : ownEntries;
    const decoSet = new Set(style.textDecorationLine.split(/\s+/).filter(d => d && d !== 'none'));
    if (!atomic && parentStyle.textDecorationLine && parentStyle.textDecorationLine !== 'none') {
      for (const d of parentStyle.textDecorationLine.split(/\s+/)) {
        if (d && d !== 'none') decoSet.add(d);
      }
    }
    if (decoSet.size > 0) {
      style.textDecorationLine = [...decoSet].join(' ');
    }

    // List marker
    const marker = getListMarker(el, style.listStyleType, ordinals);

    // Resolve `::marker` rules into a Partial<ResolvedStyle> override and a
    // hidden flag. We only do this for `<li>` because `::marker` only applies
    // to elements with `display: list-item` (in our model, just `<li>`).
    // The override records ONLY the keys actually written by marker
    // declarations, so the layout consumer can distinguish "user set padding
    // to 0" from "no rule".
    let markerStyle: Partial<ResolvedStyle> | undefined;
    let markerHidden = false;
    if (tag === 'li' && matchedMarker.length > 0) {
      if (matchedMarker.length > 1) matchedMarker.sort(byCascadeOrder);

      // Apply to a scratch style cloned from the resolved <li> style, then
      // copy out the keys that changed. Whitelist the physical fields we
      // actually consume in addListMarker — adding more later is a one-line
      // change once the layout side reads them.
      const TRACKED: (keyof ResolvedStyle)[] = [
        'paddingLeft', 'paddingRight',
        'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
        'color', 'letterSpacing',
      ];
      const scratch = { ...style } as ResolvedStyle;
      const touched = new Set<keyof ResolvedStyle>();
      const markerCount = cascadeOrder(NO_DECLARATIONS, matchedMarker, NO_DECLARATIONS, order, orderInline);
      for (let i = 0; i < markerCount; i++) {
        const m = order[i];
        // `content: none` (and `content: ''`) suppresses the marker entirely,
        // matching DOM `::marker` behavior. `content` isn't part of
        // ResolvedStyle, so we handle it inline.
        if (m.property === 'content') {
          const v = m.value.trim().toLowerCase();
          if (v === 'none' || v === '""' || v === "''" || v === 'normal') {
            // 'normal' is the initial value — no override
            markerHidden = (v === 'none' || v === '""' || v === "''");
          }
          continue;
        }
        // The marker starts as a copy of the <li>: inherit/unset change nothing.
        if (cssWideKeyword(m.property, m.value)) continue;
        const before = TRACKED.map(k => scratch[k]);
        if (FONT_PROPERTIES.has(m.property)) {
          applyFontDeclaration(scratch, m.property, m.value, style, basisFor(style, style.fontSize));
        } else {
          basisFor(style, cbWidth);
          env.containerWidth = cbWidth;
          applyDeclaration(scratch, m.property, m.value, env);
        }
        TRACKED.forEach((k, j) => {
          if (scratch[k] !== before[j]) touched.add(k);
        });
      }
      if (touched.size > 0) {
        markerStyle = {};
        for (const k of touched) (markerStyle as any)[k] = scratch[k];
      }
    }

    // Walk children, against this element's content box — or, for an
    // inline box, against the block container's, which it passes through.
    // `box-sizing` decides which box an explicit width sizes. An inline-block
    // or a flex item gets its width from layout, which re-resolves its
    // children's percentages against it (`resolvePercentages`).
    const childCb = style.display === 'inline' || style.display === 'contents'
      ? cbWidth
      : style.width > 0
        ? contentBoxSize(style, style.width,
          style.borderLeftWidth + style.paddingLeft + style.paddingRight + style.borderRightWidth)
        : Math.max(0, cbWidth - style.marginLeft - style.marginRight -
          style.borderLeftWidth - style.borderRightWidth - style.paddingLeft - style.paddingRight);
    // text-indent and gap percentages: of this box's own content width.
    resolveOwnPercentages(style, childCb);
    const children: StyledNode[] = [];
    for (const child of el.childNodes) {
      const childNode = walkNode(child, style, ctx, childCb);
      if (childNode) children.push(childNode);
    }
    if (tag === 'q') {
      // `q::before { content: open-quote }` / `::after { content: close-quote }`.
      let depth = 0;
      for (let a = parentCtx; a; a = a.parent) if (a.tagName === 'q') depth++;
      const [open, close] = QUOTES[depth % 2];
      children.unshift(textNode(open, style));
      children.push(textNode(close, style));
    }

    return {
      element: el,
      tagName: tag,
      style,
      children,
      textContent: null,
      listMarker: marker,
      markerStyle,
      markerHidden: markerHidden || undefined,
    };
  }

  function walkNode(
    node: Node,
    parentStyle: ResolvedStyle,
    parentCtx: ElementContext | null,
    cbWidth: number,
  ): StyledNode | null {
    if (node.nodeType === TEXT_NODE) {
      const text = node.textContent;
      if (!text) return null;

      if (text.trim() === '' && !text.includes('\u00A0')) {
        const ws = parentStyle.whiteSpace;
        const prev = node.previousSibling;
        const next = node.nextSibling;
        const isInlineSibling = (n: Node | null) => {
          if (!n || n.nodeType !== ELEMENT_NODE) return n?.nodeType === TEXT_NODE;
          const d = uaDisplay((n as Element).tagName.toLowerCase());
          return d === 'inline' || d === 'inline-block';
        };

        const prevInline = isInlineSibling(prev);
        const nextInline = isInlineSibling(next);
        if (prev && next && !prevInline && !nextInline) {
          if (ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line') {
            // Keep
          } else {
            return null;
          }
        }

        if (ws !== 'pre' && ws !== 'pre-wrap' && ws !== 'pre-line') {
          // Between two INLINE siblings Chrome collapses '</span>\n  <span>'
          // to a single space that consumes line width; dropping the node
          // painted the spans flush and packed lines the DOM wraps. Only a
          // gap touching a block boundary (or the container edge) vanishes.
          if (text.includes('\n') && !(prevInline && nextInline)) return null;
        }
      }

      // CSS Text 3 §4.1.1: in `normal` and `nowrap`, a source newline is
      // collapsed to a single space (no forced break). Only `pre`,
      // `pre-wrap`, `pre-line`, and `break-spaces` preserve newlines.
      // <br>-derived text nodes are created separately below with `\n`
      // and are not touched here, so they keep forcing breaks.
      const ws = parentStyle.whiteSpace;
      let normalizedText = text;
      if (ws !== 'pre' && ws !== 'pre-wrap' && ws !== 'pre-line' && ws !== 'break-spaces') {
        normalizedText = text.replace(/[\n\r]/g, ' ');
      }
      return textNode(normalizedText, parentStyle);
    }

    if (node.nodeType !== ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return null;

    // <br> → text node with newline
    if (tag === 'br') return textNode('\n', parentStyle);
    // <wbr> is a line break opportunity: HTML renders it as a zero-width space.
    if (tag === 'wbr') return textNode('\u200B', parentStyle);

    const resolved = resolveElement(el, parentStyle, parentCtx, cbWidth);
    // display:none generates no box: no text, no margins, no line box.
    return resolved.style.display === 'none' ? null : resolved;
  }

  const rootStyle = defaultStyle();
  return resolveElement(container, rootStyle, null, containerWidth);
}
