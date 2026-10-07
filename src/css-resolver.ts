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

// No ambient `Node` global outside browsers.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function isTransparent(color: string): boolean {
  if (!color) return true;
  const value = color.trim().toLowerCase();
  if (!value || value === 'transparent' || /^#(?:[\da-f]{3}0|[\da-f]{6}00)$/.test(value)) return true;
  // Literal comma or slash alpha only; color-mix() and the like are not evaluated.
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

/** Options of one resolve call; the resolver itself touches no ctx. */
export interface ResolveOptions {
  /** Viewport for vw/vh/vmin/vmax; without one, viewport units are invalid. */
  viewport?: Viewport;
  /** Measures `ch`/`ex` for a style's font, on demand; without it both are 0.5em. */
  fontUnits?: (style: ResolvedStyle) => FontUnits;
}

// ─── Style Resolution ────────────────────────────────────────────────

// Private per-style fields under SYMBOL keys: copied by spreads and declared in
// defaultStyle's literal (one hidden class), yet hidden from Object.keys/JSON
// (tests/node/public-exports.test.ts).
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

/** Fields a width percentage can set: of the containing block, except `OWN_PERCENT_FIELDS`. */
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
 * Percentages of the box's OWN content width (CSS Text 3 §8.1, Box Alignment 3 §8.3);
 * an inherited text-indent inherits the percentage (`inheritPercentages`).
 */
const OWN_PERCENT_FIELDS: ReadonlySet<PercentField> = new Set<PercentField>(['textIndent', 'gap']);

/**
 * Declarations behind a style's percentages, kept so layout can re-resolve them
 * where it decides the width (flex item, table cell, inline-block). Only on styles
 * that declared a percentage.
 */
interface PercentLengths {
  readonly basis: LengthBasis; // the element's basis, percentage aside
  readonly entries: Map<PercentField, PercentEntry>; // inherited entries carry the declarer's basis
  cb: number; // containing-block width the fields hold values for
  own?: number; // own content width the OWN_PERCENT_FIELDS hold values for
  intrinsic?: ResolvedStyle; // intrinsicStyle's cached copy, for intrinsicFor
  intrinsicFor?: ResolvedStyle;
}

type PercentEntry = readonly [property: string, value: string, basis?: LengthBasis];

type InternalStyle = ResolvedStyle & PrivateStyleFields;

/** Defaults for every field, private ones included, so all styles share one hidden class. */
function defaultStyle(): ResolvedStyle {
  const style = {
    // The UA default font is serif (Times).
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
  // Assigned, not computed keys: those lose V8's fast literal path.
  style[LINE_HEIGHT_MULTIPLIER] = undefined;
  style[UNDERLINE_OFFSET_PCT] = undefined;
  style[OVERFLOW_X] = undefined;
  style[OVERFLOW_Y] = undefined;
  style[BOX_SIZING] = undefined;
  style[PERCENT_LENGTHS] = undefined;
  return style;
}

/**
 * The HTML UA stylesheet as far as render-tag renders it; unlisted tags are inline.
 * A `fontSize` below 10 is a multiple of the parent's size, a negative margin of own em.
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
  small: { fontSize: 1 / 1.2 },
  big: { fontSize: 1.2 },
  mark: { backgroundColor: 'yellow', color: 'black' },
  nobr: { whiteSpace: 'nowrap' },
  code: MONOSPACE,
  kbd: MONOSPACE,
  samp: MONOSPACE,
  tt: MONOSPACE,
  // HTML rendering rules (and Blink/WebKit) give <bdo> isolate-override, not bidi-override.
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

/** Does a whitespace-only text node beside `n` sit in an inline flow (`walkNode`)? */
function isInlineSibling(n: Node | null): boolean {
  if (!n || n.nodeType !== ELEMENT_NODE) return n?.nodeType === TEXT_NODE;
  const d = uaDisplay((n as Element).tagName.toLowerCase());
  return d === 'inline' || d === 'inline-block';
}

/** TAG_DEFAULTS minus fontSize (resolved first), as [field, css property, value]. */
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

/** Is stroke painted before fill? Missing tokens append as fill, stroke, markers. */
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

/** Expand a shorthand into its longhands. */
export function expandShorthand(property: string, value: string): Longhand[] {
  if (property === 'word-wrap') return [{ property: 'overflow-wrap', value }];
  if (property === '-webkit-background-clip') return [{ property: 'background-clip', value }];
  // Canvas only renders `small-caps`.
  if (property === 'font-variant') {
    const caps = cssWideKeyword(property, value) ? value : /\bsmall-caps\b/i.test(value) ? 'small-caps' : 'normal';
    return [{ property: 'font-variant-caps', value: caps }];
  }
  if (property === 'margin' || property === 'padding') {
    return fourSides(value.trim().split(/\s+/)).map((v, i) => ({ property: `${property}-${SIDES[i]}`, value: v }));
  }

  if (property === 'border' || property === 'border-top' || property === 'border-right' ||
      property === 'border-bottom' || property === 'border-left') {
    // Width, style and color at most once each, any order; unnamed parts reset.
    let width = '', style = '', color = '';
    for (const p of splitTopLevelWhitespace(value.trim())) {
      const lower = p.toLowerCase();
      if (!width && isWidthToken(p)) width = p;
      else if (!style && BORDER_STYLES.has(lower)) style = lower;
      else if (!color && isColor(p)) color = p;
      else return [];
    }
    if (!width && !style && !color) return [];
    width ||= 'medium';
    style ||= 'none';
    color ||= 'currentcolor';
    const result: Longhand[] = [];
    const sides = property === 'border' ? SIDES : [property.replace('border-', '')];
    for (const side of sides) {
      result.push({ property: `border-${side}-width`, value: width });
      result.push({ property: `border-${side}-style`, value: style });
      result.push({ property: `border-${side}-color`, value: color });
    }
    return result;
  }

  if (property === 'border-width' || property === 'border-style' || property === 'border-color') {
    // Colors keep their spaces.
    const kind = property.slice('border-'.length);
    return fourSides(splitTopLevelWhitespace(value.trim()))
      .map((v, i) => ({ property: `border-${SIDES[i]}-${kind}`, value: v }));
  }

  if (property === 'font') return expandFont(value);
  if (property === 'background') return expandBackground(value);

  if (property === 'border-radius') {
    // TL, TR, BR, BL; of `4px / 2px` only the horizontal radii are kept (one per corner).
    return fourSides(value.split('/')[0].trim().split(/\s+/))
      .map((v, i) => ({ property: `border-${CORNERS[i]}-radius`, value: v }));
  }

  if (property === 'list-style') {
    // Only the type is kept. A lone `none` is the type; beside a type it is the image.
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
    // `<line> || <style> || <color> || <thickness>`; unnamed longhands reset.
    // `inherit` stays `none`: textDecorationLine is the propagated union of lines.
    const v = value.trim();
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
    let width = '', color = '';
    for (const p of splitTopLevelWhitespace(value.trim())) {
      if (!width && isWidthToken(p)) width = p;
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
    // `flex: 1` is `1 1 0%`: unlike bare `flex-grow: 1`, it drops the content-width basis.
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
    return [];
  }

  return [{ property, value }];
}

/** `thin`/`medium`/`thick` border widths, as Blink, WebKit and Gecko size them. */
const BORDER_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const isWidthToken = (p: string) =>
  /^[+-]?(?:\d|\.\d)/.test(p) || MATH.test(p) || p.toLowerCase() in BORDER_WIDTH_KEYWORDS;

const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
/** 1-4 box values as top/right/bottom/left (or TL/TR/BR/BL). */
function fourSides(parts: string[]): string[] {
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

const FONT_STYLES = new Set(['normal', 'italic', 'oblique']);
const FONT_WEIGHTS = new Set(['bold', 'bolder', 'lighter']);
const FONT_STRETCHES = new Set([
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
]);
const isFontSizeKeyword = (v: string) => Object.hasOwn(FONT_SIZE_KEYWORDS, v) || v === 'larger' || v === 'smaller';

/**
 * `font` (CSS Fonts 4 §2.8): resets every unnamed sub-property; needs a size and a
 * family. System font keywords are invalid (canvas cannot name them).
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
 * `background`: resets every unnamed longhand. Only color (final layer only), images
 * and clip are kept; positions, sizes and repeats are parsed past.
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
        // not rendered
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

const FONT_VARIANT_CAPS = new Set([
  'normal', 'small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps',
]);

/** Properties the cascade resolves FIRST: everything else may measure the font (em, ch, ex). */
const FONT_PROPERTIES = new Set(['font-size', 'font-family', 'font-weight', 'font-style', 'font-variant-caps']);

/** Apply a font declaration; relative values use the PARENT's font. False when invalid. */
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
    // Canvas only renders `small-caps`.
    case 'font-variant-caps':
      if (!FONT_VARIANT_CAPS.has(value.trim().toLowerCase())) return false;
      style.fontVariantCaps = value.trim().toLowerCase() === 'small-caps' ? 'small-caps' : 'normal';
      return true;
  }
  return false;
}

/** The ResolvedStyle fields each (physical) property writes. */
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

/** `property`, a logical one mapped through the parent's `direction`. */
function physical(property: string, direction: string): string {
  const logical = LOGICAL_PROPERTIES[property];
  return logical ? logical[direction === 'rtl' ? 1 : 0] : property;
}

/** The CSS-wide keyword a value is, or null. `revert(-layer)` acts as `unset`; `color: currentcolor` as `inherit`. */
function cssWideKeyword(property: string, value: string): string | null {
  // Every keyword starts with c, i, r or u: reject most values without allocating.
  const first = value.charCodeAt(0) | 0x20;
  if (first !== 0x63 && first !== 0x69 && first !== 0x72 && first !== 0x75 && first !== 0x20) return null;
  const v = value.trim().toLowerCase();
  if (v === 'inherit' || v === 'initial' || v === 'unset') return v;
  if (v === 'revert' || v === 'revert-layer') return 'unset';
  if (v === 'currentcolor' && property === 'color') return 'inherit';
  return null;
}

/**
 * Apply a CSS-wide keyword; an inherited property is just left unset for
 * `inheritFont`/`inheritFrom` to copy. Null for an unknown property.
 */
function applyKeyword(
  style: ResolvedStyle,
  parent: ResolvedStyle,
  prop: string,
  keyword: string,
  setProps: Set<string>,
  concrete: CurrentColorTable,
): string | null {
  const fields = PROPERTY_FIELDS[prop];
  if (!fields) return null;
  const inherited = INHERITED_PROPERTIES.has(prop);
  if (inherited && keyword !== 'initial') {
    setProps.delete(prop);
    return prop;
  }
  const source = (keyword === 'inherit' ? parent : INITIAL) as InternalStyle;
  for (const field of fields) (style as any)[field] = source[field];
  // An inherited currentcolor is the keyword, resolved against the child's color.
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

/** Per resolve call: which CURRENTCOLOR_FIELDS of a style hold a concrete color (absent = none). */
type CurrentColorTable = Map<ResolvedStyle, Set<keyof InternalStyle>>;

/** What phase-2 declarations of one element resolve against. */
interface DeclarationEnv {
  /** em = the element's own font-size; `percent` is set per property. */
  b: LengthBasis;
  containerWidth: number;
  /** Set when the declaration just applied read a percentage of `containerWidth` (`cbLengthOf`). */
  percent: boolean;
}

/** A `<length-percentage>` with `percentBase` as 100%; NaN when invalid. */
function lengthOf(value: string, env: DeclarationEnv, percentBase: number): number {
  env.b.percent = percentBase;
  return resolveLength(value, env.b);
}

/** A `<length-percentage>` of the containing block's width; flags a percentage for `PercentLengths`. */
function cbLengthOf(value: string, env: DeclarationEnv): number {
  if (value.includes('%')) env.percent = true;
  return lengthOf(value, env, env.containerWidth);
}

/** Atomic inline-level boxes: their content is a formatting context of its own. */
const ATOMIC_INLINE = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table', '-webkit-inline-box']);

/** Record a percent field's latest declaration (`value`), or forget it (null: a fixed length won). */
function trackPercent(
  style: ResolvedStyle, property: string, value: string | null, env: DeclarationEnv, cbWidth: number,
): void {
  const internal = style as InternalStyle;
  let table = internal[PERCENT_LENGTHS];
  if (value === null && !table) return;
  const field = PROPERTY_FIELDS[property]?.[0];
  if (field === undefined || !PERCENT_FIELDS.has(field as string)) return;
  if (value === null) {
    table!.entries.delete(field as PercentField);
    return;
  }
  if (!table) {
    table = internal[PERCENT_LENGTHS] = { basis: { ...env.b }, entries: new Map(), cb: cbWidth };
  }
  table.entries.set(field as PercentField, [property, value]);
}

/**
 * Re-resolve `style`'s percentages against the containing block `width`, or (`own`)
 * the box's own content width for `OWN_PERCENT_FIELDS`. No-op when already at it.
 */
export function resolvePercentages(style: ResolvedStyle, width: number, own = false): void {
  const table = (style as InternalStyle)[PERCENT_LENGTHS];
  if (!table || (own ? table.own : table.cb) === width || table.entries.size === 0) return;
  if (own) table.own = width;
  else table.cb = width;
  const env: DeclarationEnv = { b: table.basis, containerWidth: width, percent: false };
  for (const [field, [property, value, basis]] of table.entries) {
    if (OWN_PERCENT_FIELDS.has(field) !== own) continue;
    env.b = { ...(basis ?? table.basis) };
    applyDeclaration(style, property, value, env);
  }
}

/** An inherited percentage text-indent resolves against the CHILD's own width. */
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
 * `style` for intrinsic sizing: cyclic percentages count as 0, and a percentage
 * width/min-width/flex-basis as `auto` (CSS Sizing 3 §5.2.1, Blink and WebKit).
 */
export function intrinsicStyle(style: ResolvedStyle): ResolvedStyle {
  const table = (style as InternalStyle)[PERCENT_LENGTHS];
  if (!table || table.entries.size === 0) return style;
  if (table.intrinsicFor === style) return table.intrinsic!;
  const copy = { ...style } as InternalStyle;
  const env: DeclarationEnv = { b: { ...table.basis }, containerWidth: 0, percent: false };
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

/** Border-box size of a `size` px width/min-width/min-height/flex-basis under `box-sizing`; `frame` = padding + border. */
export function borderBoxSize(style: ResolvedStyle, size: number, frame: number): number {
  return isBorderBox(style) ? Math.max(size, frame) : size + frame;
}

/** The content-box size the same declaration gives: `borderBoxSize` without the frame. */
export function contentBoxSize(style: ResolvedStyle, size: number, frame: number): number {
  return isBorderBox(style) ? Math.max(0, size - frame) : size;
}

/** An anonymous block box's style (CSS 2.1 §9.2.1.1): inherited properties, all else initial. */
export function anonymousBlockStyle(style: ResolvedStyle): ResolvedStyle {
  const anonymous = { ...style } as InternalStyle;
  for (const [property, fields] of Object.entries(PROPERTY_FIELDS)) {
    // Decorations propagate into the anonymous box's text.
    if (INHERITED_PROPERTIES.has(property) || property.startsWith('text-decoration')) continue;
    for (const field of fields) (anonymous as any)[field] = INITIAL[field];
  }
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

/**
 * A (non-font) property's value parser: the value to store in its field
 * (`PROPERTY_FIELDS`), or null/NaN when the declaration is invalid.
 */
type Parser = (value: string, env: DeclarationEnv, style: ResolvedStyle) => unknown;

const keywordOf = (property: string): Parser => {
  const allowed = KEYWORDS[property];
  return value => {
    const v = value.trim().toLowerCase();
    return allowed.has(v) ? v : null;
  };
};
/** A color, as written (canvas parses it). */
const color: Parser = value => (isColor(value) ? value.trim() : null);
/** A color whose `currentcolor` stays '' so it resolves against each element's own color at render time. */
const colorOrCurrent: Parser = value => {
  if (!isColor(value)) return null;
  const v = value.trim();
  return v.toLowerCase() === 'currentcolor' ? '' : v;
};
const noneOr = (valid: (value: string) => boolean): Parser => value =>
  valid(value) ? (value.trim().toLowerCase() === 'none' ? 'none' : value.trim()) : null;
/** A non-negative border/stroke width (keywords allowed, no percentages). */
const lineWidth: Parser = (value, env) => {
  const keyword = BORDER_WIDTH_KEYWORDS[value.trim().toLowerCase()];
  if (keyword !== undefined) return keyword;
  const px = lengthOf(value, env, NaN);
  return px >= 0 ? px : NaN;
};
/** Percentages are of the element's own font-size (CSS Text 4; Blink, WebKit). */
const spacing: Parser = (value, env, style) =>
  value.trim().toLowerCase() === 'normal' ? 0 : lengthOf(value, env, style.fontSize);
/** `none`, `auto` and a non-positive integer all mean no clamp (0). */
const lineClamp: Parser = value => {
  const v = value.trim().toLowerCase();
  const n = v === 'none' || v === 'auto' ? 0 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** A non-negative <number>. */
const flexFactor: Parser = value =>
  /^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? parseFloat(value) : NaN;

const PARSERS: Record<string, Parser> = {
  __proto__: null,
  color, 'text-decoration-color': color, 'background-color': color,
  '-webkit-text-stroke-color': colorOrCurrent, '-webkit-text-fill-color': colorOrCurrent,
  'text-indent': (value, env) => cbLengthOf(value, env),
  'text-transform': textTransform,
  'text-decoration-line': textDecorationLine,
  'text-shadow': noneOr(isTextShadow),
  'background-image': noneOr(isImageList),
  '-webkit-text-stroke-width': lineWidth,
  // A custom property: a browser drops an unknown real property whenever it
  // re-serializes a style (contenteditable, el.style writes).
  '--rt-text-stroke-image': value => value.trim(),
  'paint-order': paintOrder,
  'background-clip': backgroundClip,
  'letter-spacing': spacing, 'word-spacing': spacing,
  'line-clamp': lineClamp, '-webkit-line-clamp': lineClamp,
  'vertical-align': verticalAlign,
  display,
  'list-style-type': listStyleType,
  width: (value, env) => {
    const v = value.trim();
    if (v.toLowerCase() === 'auto') return 0;
    const px = cbLengthOf(v, env);
    return px >= 0 ? px : NaN;
  },
  // A percentage is of the containing block's HEIGHT, never definite here:
  // it computes to none (CSS 2.1 §10.7).
  'min-height': (value, env) => {
    const v = value.trim();
    if (v.toLowerCase() === 'auto' || v.includes('%')) return 0;
    const px = lengthOf(v, env, NaN);
    return px >= 0 ? px : NaN;
  },
  gap: (value, env) => {
    // `gap: <row> <column>`: flex rows use the row gap, the first.
    const v = value.trim();
    const first = MATH.test(v) ? v : v.split(/\s+/)[0];
    return first.toLowerCase() === 'normal' ? 0 : cbLengthOf(first, env);
  },
  'flex-grow': flexFactor, 'flex-shrink': flexFactor,
} as Record<string, Parser>;
for (const property in KEYWORDS) PARSERS[property] = keywordOf(property);
PARSERS['box-sizing'] = value => {
  const v = value.trim().toLowerCase();
  return v === 'border-box' ? v : v === 'content-box' ? undefined : null;
};
for (const side of SIDES) {
  PARSERS[`padding-${side}`] = (value, env) => {
    const px = cbLengthOf(value, env);
    return px >= 0 ? px : NaN;
  };
  // No auto margins: `auto` is 0.
  PARSERS[`margin-${side}`] = (value, env) => (value.trim().toLowerCase() === 'auto' ? 0 : cbLengthOf(value, env));
  PARSERS[`border-${side}-width`] = lineWidth;
  PARSERS[`border-${side}-color`] = color;
}
// Percentages (of the border box) stay symbolic until paint; a second component is ignored.
for (const corner of CORNERS) {
  PARSERS[`border-${corner}-radius`] = (value, env) => {
    const v = MATH.test(value.trim()) ? value.trim() : value.trim().split(/\s+/)[0];
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
      const pct = parseFloat(v);
      return pct > 0 ? { pct } : 0;
    }
    const px = lengthOf(v, env, NaN);
    return Number.isNaN(px) ? null : Math.max(0, px);
  };
}

/** Apply a (non-font) declaration. False when invalid: the cascaded value then survives. */
function applyDeclaration(style: ResolvedStyle, property: string, value: string, env: DeclarationEnv): boolean {
  const parse = PARSERS[property];
  if (parse) {
    const v = parse(value, env, style);
    if (v === null || Number.isNaN(v)) return false;
    (style as any)[PROPERTY_FIELDS[property][0]] = v;
    return true;
  }
  const internal = style as InternalStyle;
  const fontSize = style.fontSize;
  switch (property) {
    case 'text-underline-offset': {
      // A % is also kept in UNDERLINE_OFFSET_PCT for children to re-resolve.
      const v = value.trim();
      let pct: number | undefined;
      if (v.toLowerCase() === 'auto') style.textUnderlineOffset = null;
      else if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
        pct = parseFloat(v);
        style.textUnderlineOffset = (pct / 100) * fontSize;
      } else {
        const px = lengthOf(v, env, fontSize);
        if (Number.isNaN(px)) return false;
        style.textUnderlineOffset = px;
      }
      internal[UNDERLINE_OFFSET_PCT] = pct;
      return true;
    }
    case 'text-decoration-thickness': {
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
    case 'line-height': {
      const v = value.trim();
      if (v.toLowerCase() === 'normal') {
        internal[LINE_HEIGHT_MULTIPLIER] = undefined;
        style.lineHeight = 0; // 0 signals "normal"
        return true;
      }
      let lineHeight: number;
      let multiplier: number | undefined;
      if (/^[+]?(?:\d+\.?\d*|\.\d+)%$/.test(v)) {
        // Of the own font size, inherited as that px value. Blink and WebKit
        // use an INTEGER percentage (INTEGER_PERCENT_LINE_HEIGHT).
        const num = parseFloat(v);
        lineHeight = ((INTEGER_PERCENT_LINE_HEIGHT ? Math.trunc(num) : num) / 100) * fontSize;
      } else {
        env.b.percent = fontSize;
        const t = resolveNumberOrLength(v, env.b);
        if (!t || t.value < 0) return false;
        // A number is a multiplier that children re-compute for their font size.
        if (t.number) multiplier = t.value;
        lineHeight = t.number ? t.value * fontSize : t.value;
      }
      style.lineHeight = lineHeight;
      // A real zero (`lineHeight: 0` means normal) is carried as the multiplier 0.
      internal[LINE_HEIGHT_MULTIPLIER] = lineHeight === 0 ? 0 : multiplier;
      return true;
    }
    case 'min-width':
    case 'flex-basis': {
      const v = value.trim();
      const lower = v.toLowerCase();
      const field = property === 'min-width' ? 'minWidth' : 'flexBasis';
      if (lower === 'auto' || (lower === 'content' && field === 'flexBasis')) {
        style[field] = null;
        return true;
      }
      const px = cbLengthOf(v, env);
      if (!(px >= 0)) return false;
      style[field] = px;
      return true;
    }
    // Only read to find BFC roots (`establishesBfc`); render-tag does not clip.
    case 'overflow': {
      const [x, y = x, extra] = value.trim().toLowerCase().split(/\s+/);
      const allowed = KEYWORDS['overflow-x'];
      if (extra !== undefined || !allowed.has(x) || !allowed.has(y)) return false;
      internal[OVERFLOW_X] = x;
      internal[OVERFLOW_Y] = y;
      return true;
    }
  }
  return false;
}

/** Inherit the font properties, before any other declaration measures the font. */
function inheritFont(child: ResolvedStyle, parent: ResolvedStyle, setProps: Set<string>): void {
  if (!setProps.has('font-size')) child.fontSize = parent.fontSize;
  if (!setProps.has('font-family')) child.fontFamily = parent.fontFamily;
  if (!setProps.has('font-weight')) child.fontWeight = parent.fontWeight;
  if (!setProps.has('font-style')) child.fontStyle = parent.fontStyle;
  if (!setProps.has('font-variant-caps')) child.fontVariantCaps = parent.fontVariantCaps;
}

// Unrolled per field: a keyed copy over a table is megamorphic (was a quarter of resolve time).
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
    // A percentage re-resolves against the child's font size (Chrome-measured).
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
 * Index rules by their rightmost compound's id, else first class, else tag (root
 * compounds go to `universal`). Shared between calls and never written afterwards.
 * Not frozen (too slow); tests/node/determinism.test.ts gates the isolation.
 */
function buildRuleIndex(css: string): RuleIndex {
  const byId = new Map<string, ProcessedRule[]>();
  const byClass = new Map<string, ProcessedRule[]>();
  const byTag = new Map<string, ProcessedRule[]>();
  const universal: ProcessedRule[] = [];
  let orderBase = 0;
  let cost = 0;

  for (const rule of parseStylesheet(css)) {
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
 * Rule indexes of recent stylesheets, by exact text: the index is a pure function
 * of the css text. A sheet is admitted on its second sighting (one-off indexes
 * became old-generation garbage, +70 µs per call). Bounded by sheets, key chars and
 * index cost; cost is the memory bound (an index retains ~85x its text).
 * Gated by tests/node/determinism.test.ts.
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
    // Most recently used last (Map insertion order).
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

const BULLETS: Record<string, string> = { __proto__: null, disc: '•', circle: '○', square: '■' } as Record<string, string>;

/** Format an integer using a numbered CSS list-style-type. */
function formatListMarker(n: number, type: string): string {
  switch (type) {
    case 'decimal-leading-zero':
      return `${n < 10 && n >= 0 ? '0' + n : n}.`;
    case 'lower-roman': return `${toRoman(n).toLowerCase()}.`;
    case 'upper-roman': return `${toRoman(n)}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${toAlpha(n).toLowerCase()}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${toAlpha(n)}.`;
    default: return `${n}.`;
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

/** The `::marker` fields layout reads (`addListMarker`), in shorthand expansion order. */
const MARKER_FIELDS: readonly (keyof ResolvedStyle)[] = [
  'paddingRight', 'paddingLeft', 'fontStyle', 'fontWeight', 'fontSize', 'fontFamily', 'color', 'letterSpacing',
];

/** Each `<li>`'s ordinal in its list, by list element; built once per list per call. */
type ListOrdinals = Map<Element, Map<Element, number>>;

/** The ordinal of every `<li>` child of `list`, honoring <ol start>, <ol reversed> and <li value>. */
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

/** A <li>'s marker text, honoring list-style-type, <ol start>, <ol reversed> and <li value>. */
function getListMarker(el: Element, listStyleType: string, ordinals: ListOrdinals): string | undefined {
  if (el.tagName.toLowerCase() !== 'li') return undefined;
  if (listStyleType === 'none') return '';
  const bullet = BULLETS[listStyleType];
  if (bullet !== undefined) return bullet;
  const parent = el.parentElement;
  if (!parent) {
    const v = parseInt(el.getAttribute('value') ?? '', 10);
    return formatListMarker(Number.isNaN(v) ? 1 : v, listStyleType);
  }
  const parentTag = parent.tagName.toLowerCase();
  if (parentTag !== 'ol' && parentTag !== 'ul') return undefined;
  return formatListMarker(listOrdinals(parent, ordinals).get(el)!, listStyleType);
}

const NO_DECLARATIONS: readonly Declaration[] = Object.freeze([]);

/**
 * `style=""` as longhands, read from the attribute (not the CSSOM's re-serialized
 * cssText) so no DOM implementation rewrites a value first.
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
 * `dir="auto"`: the first strong character's direction (UAX #9 P2/P3), skipping
 * `[dir]`, `<bdi>` and non-rendered text; null keeps the parent's direction.
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

/** `<q>` marks by nesting depth: Blink/WebKit `quotes: auto` with no language. `lang` is not supported. */
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
 * An element's declarations in ascending precedence (CSS Cascade 4) into `out`:
 * hints, normal rules, `style=""`, then the same for `!important`. Returns the count.
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
  // Shares its parent's style object: nothing downstream writes to a style.
  return { element: null, tagName: '#text', style, children: [], textContent: text };
}

/** Resolve styles for a DOM tree (never inserted into the document): cascade and inheritance. */
export function resolveStylesFromCSS(
  fragment: DocumentFragment,
  css: string,
  containerWidth: number,
  options: ResolveOptions = {},
): StyledNode {
  const ruleIndex = ruleIndexFor(css);
  const viewport = options.viewport ?? null;
  const measureUnits = options.fontUnits;

  // A single root element, from the fragment's own document (no ambient DOM needed).
  const container = fragment.ownerDocument!.createElement('div');
  container.appendChild(fragment);

  const ordinals: ListOrdinals = new Map();
  const matcher = new SelectorMatcher();
  const concreteColors: CurrentColorTable = new Map();
  /** What `rem` resolves against: the root's font-size once it is known, the initial 16px before. */
  let rootFontSize = 16;

  /** Lengths against `style`'s font; one object re-aimed per use (an element finishes before its children). */
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
  const env: DeclarationEnv = { b: basis, containerWidth, percent: false };
  /** Scratch for `cascadeOrder`, reused by every element. */
  const order: Declaration[] = [];
  const orderInline: boolean[] = [];

  /** The root font-size (`rem`) as `html`/`:root` rules alone set it; the container is also `body`. */
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

  /** `cbWidth`: the containing block width that percentages resolve against. */
  function resolveElement(
    el: Element,
    parentStyle: ResolvedStyle,
    parentCtx: ElementContext | null,
    cbWidth: number,
  ): StyledNode {
    const tag = el.tagName.toLowerCase();
    const ctx = matcher.context(el, parentCtx);

    const style = defaultStyle();
    const setProps = new Set<string>();

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
    // `:any-link`: LinkText is #0000ee in Blink, WebKit and Gecko.
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
      if (keyword) applyKeyword(style, parentStyle, d.property, keyword, setProps, concreteColors);
      else if (applyFontDeclaration(style, d.property, d.value, parentStyle, basisFor(parentStyle, parentStyle.fontSize))) {
        setProps.add(d.property);
      }
    }
    inheritFont(style, parentStyle, setProps);
    if (parentCtx === null) rootFontSize = htmlFontSize(matched);
    const elemFontSize = style.fontSize;

    // --- Step 3: everything else, against the element's final font ---
    if (tagDef) {
      if (style.marginTop < 0) style.marginTop = Math.abs(style.marginTop) * elemFontSize;
      if (style.marginBottom < 0) style.marginBottom = Math.abs(style.marginBottom) * elemFontSize;

      const rtl = parentStyle.direction === 'rtl';
      if (tag === 'ul' || tag === 'ol' || tag === 'menu' || tag === 'dir') {
        style[rtl ? 'paddingRight' : 'paddingLeft'] = 40;
      } else if (tag === 'dd') {
        style[rtl ? 'marginRight' : 'marginLeft'] = 40;
      }
    }

    // Logical properties resolve through the parent's direction.
    basisFor(style, cbWidth);
    env.containerWidth = cbWidth;
    let widthFromSheet = false;
    for (let i = 0; i < count; i++) {
      const d = order[i];
      if (FONT_PROPERTIES.has(d.property)) continue;
      const property = physical(d.property, parentStyle.direction);
      const keyword = cssWideKeyword(property, d.value);
      if (keyword) {
        applyKeyword(style, parentStyle, property, keyword, setProps, concreteColors);
        trackPercent(style, property, null, env, cbWidth);
      } else {
        env.percent = false;
        if (!applyDeclaration(style, property, d.value, env)) continue;
        setProps.add(property);
        trackPercent(style, property, env.percent ? d.value : null, env, cbWidth);
      }
      if (d.property === 'width') widthFromSheet = !orderInline[i];
    }

    // Only an inline-style width is kept.
    if (widthFromSheet) {
      style.width = 0;
      (style as InternalStyle)[PERCENT_LENGTHS]?.entries.delete('width');
    }

    const dirAttr = el.getAttribute('dir')?.trim().toLowerCase();
    if (dirAttr === 'ltr' || dirAttr === 'rtl' || dirAttr === 'auto') {
      style.direction = dirAttr === 'auto'
        ? autoDirection(el) ?? parentStyle.direction
        : dirAttr;
      setProps.add('direction');
      // UA sheet: `[dir]` isolates (Blink/WebKit); <bdo>'s override and author values win.
      if (!setProps.has('unicode-bidi') && style.unicodeBidi === 'normal') {
        style.unicodeBidi = 'isolate';
      }
    }

    inheritFrom(style, parentStyle, setProps);
    if (!setProps.has('text-indent')) inheritPercentages(style, parentStyle, cbWidth);

    // A none/hidden border style computes to width 0 (CSS Backgrounds 3).
    if (style.borderTopStyle === 'none' || style.borderTopStyle === 'hidden') style.borderTopWidth = 0;
    if (style.borderRightStyle === 'none' || style.borderRightStyle === 'hidden') style.borderRightWidth = 0;
    if (style.borderBottomStyle === 'none' || style.borderBottomStyle === 'hidden') style.borderBottomWidth = 0;
    if (style.borderLeftStyle === 'none' || style.borderLeftStyle === 'hidden') style.borderLeftWidth = 0;

    // currentcolor defaults. An automatic decoration color is the visible stroke color,
    // else the fill color, else `color` — resolved on the declarer so descendants agree.
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

    // Decorations propagate visually: each keeps its declarer's color/style, ancestors'
    // first so own ones paint on top. `textDecorationLine` is the union of lines.
    const ownEntries: DecorationEntry[] = [];
    if (style.textDecorationLine && style.textDecorationLine !== 'none') {
      for (const d of style.textDecorationLine.split(/\s+/)) {
        if (d && d !== 'none') {
          ownEntries.push({
            line: d,
            color: style.textDecorationColor,
            style: style.textDecorationStyle,
            declarer: style,
          });
        }
      }
    }
    // No ancestor decoration reaches an atomic inline's content (CSS Text Decoration 3 §2.1).
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

    const marker = getListMarker(el, style.listStyleType, ordinals);

    // `::marker` (only on `<li>`): the MARKER_FIELDS its rules change, and a hidden flag.
    let markerStyle: Partial<ResolvedStyle> | undefined;
    let markerHidden = false;
    if (tag === 'li' && matchedMarker.length > 0) {
      if (matchedMarker.length > 1) matchedMarker.sort(byCascadeOrder);

      const scratch = { ...style } as ResolvedStyle;
      const markerCount = cascadeOrder(NO_DECLARATIONS, matchedMarker, NO_DECLARATIONS, order, orderInline);
      for (let i = 0; i < markerCount; i++) {
        const m = order[i];
        // `content: none` or `''` hides the marker.
        if (m.property === 'content') {
          const v = m.value.trim().toLowerCase();
          if (v === 'none' || v === '""' || v === "''" || v === 'normal') {
            markerHidden = (v === 'none' || v === '""' || v === "''");
          }
          continue;
        }
        // The marker starts as a copy of the <li>: inherit/unset change nothing.
        if (cssWideKeyword(m.property, m.value)) continue;
        if (FONT_PROPERTIES.has(m.property)) {
          applyFontDeclaration(scratch, m.property, m.value, style, basisFor(style, style.fontSize));
        } else {
          basisFor(style, cbWidth);
          env.containerWidth = cbWidth;
          applyDeclaration(scratch, physical(m.property, parentStyle.direction), m.value, env);
        }
      }
      for (const k of MARKER_FIELDS) if (scratch[k] !== style[k]) (markerStyle ??= {} as any)[k] = scratch[k];
    }

    // Children resolve against this content box (an inline box passes its container's through).
    const childCb = style.display === 'inline' || style.display === 'contents'
      ? cbWidth
      : style.width > 0
        ? contentBoxSize(style, style.width,
          style.borderLeftWidth + style.paddingLeft + style.paddingRight + style.borderRightWidth)
        : Math.max(0, cbWidth - style.marginLeft - style.marginRight -
          style.borderLeftWidth - style.borderRightWidth - style.paddingLeft - style.paddingRight);
    resolvePercentages(style, childCb, true);
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

      const ws = parentStyle.whiteSpace;
      const pre = ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line';
      if (!pre && text.trim() === '' && !text.includes('\u00A0')) {
        // Dropped between blocks, or with a newline unless between two inline siblings (Chrome).
        const prev = node.previousSibling;
        const next = node.nextSibling;
        const prevInline = isInlineSibling(prev);
        const nextInline = isInlineSibling(next);
        if ((prev && next && !prevInline && !nextInline) ||
            (text.includes('\n') && !(prevInline && nextInline))) return null;
      }

      // CSS Text 3 §4.1.1: outside pre/pre-wrap/pre-line/break-spaces a newline is a space.
      return textNode(pre || ws === 'break-spaces' ? text : text.replace(/[\n\r]/g, ' '), parentStyle);
    }

    if (node.nodeType !== ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return null;

    if (tag === 'br') return textNode('\n', parentStyle);
    // <wbr> renders as a zero-width space.
    if (tag === 'wbr') return textNode('\u200B', parentStyle);

    const resolved = resolveElement(el, parentStyle, parentCtx, cbWidth);
    return resolved.style.display === 'none' ? null : resolved;
  }

  const rootStyle = defaultStyle();
  return resolveElement(container, rootStyle, null, containerWidth);
}
