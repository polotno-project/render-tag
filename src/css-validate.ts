// Grammar checks (not evaluators) for values the resolver stores as strings:
// colors, images, shadows, font families, keywords — per CSS Color 4, Images 4,
// Text Decoration, Fonts 4 as Blink/WebKit parse them. An invalid value (incl.
// `var()`/`attr()`/`env()`) drops the declaration, so the cascaded value survives.
import { memoized, NUMBER, numberThen, PERCENTAGE, resolveLength, type LengthBasis } from './css-values.js';
import { splitTopLevel } from './css-syntax.js';

export { splitTopLevel };

// ─── Splitting ──────────────────────────────────────────────────────

/** Split on whitespace, but only at paren-depth 0 — keeps `rgb(1, 2, 3)` intact. */
export function splitTopLevelWhitespace(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; }
    else if (depth === 0 && /\s/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Whitespace-separated tokens at depth 0, with a top-level `/` as its own token. */
export function tokens(value: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevelWhitespace(value)) {
    if (part.includes('/') && !part.includes('(')) {
      part.split(/(\/)/).forEach((t) => { if (t) out.push(t); });
    } else out.push(part);
  }
  return out;
}

/** `name(args)` as a whole function token, or null. The final `)` must close the first `(`. */
function functionToken(value: string): { name: string; args: string } | null {
  const m = /^([a-z-]+)\(/i.exec(value);
  if (!m || !value.endsWith(')')) return null;
  let depth = 0;
  let quote = '';
  for (let i = m[0].length - 1; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\') i++; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0 && i !== value.length - 1) return null;
  }
  if (depth !== 0 || quote) return null;
  return { name: m[1].toLowerCase(), args: value.slice(m[0].length, -1) };
}

// ─── Numbers, lengths, angles ───────────────────────────────────────

const ANGLE = numberThen('(?:deg|rad|grad|turn)');
export const MATH = /^(?:calc|min|max|clamp)\(/i;

/** A basis that resolves every unit, for syntax checks only (the resolver's shorthand checks copy it). */
export const CHECK_BASIS: LengthBasis = {
  em: 16, rem: 16, percent: 1, viewport: { width: 100, height: 100 }, fontStyle: null, measure: undefined,
};
const CHECK_BASIS_NO_PERCENT: LengthBasis = { ...CHECK_BASIS, percent: NaN };

/** A `<length>` (or `<length-percentage>`), math functions included. */
function isLength(token: string, allowPercent: boolean): boolean {
  return !Number.isNaN(resolveLength(token, allowPercent ? CHECK_BASIS : CHECK_BASIS_NO_PERCENT));
}

/** A numeric component of a color function: number, percentage, angle, `none` or math. */
function isNumeric(token: string, angle: boolean): boolean {
  const t = token.toLowerCase();
  return NUMBER.test(t) || PERCENTAGE.test(t) || (angle && ANGLE.test(t)) || t === 'none' || MATH.test(t);
}

function isAngleOrZero(token: string): boolean {
  return ANGLE.test(token) || token === '0' || MATH.test(token);
}

// ─── Colors ─────────────────────────────────────────────────────────

/** The CSS named colors (CSS Color 4 §6.1), as rrggbb. */
const NAMED_COLORS = new Map(
  ('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc ' +
  'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a ' +
  'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 ' +
  'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b ' +
  'darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b ' +
  'darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
  'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f ' +
  'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 ' +
  'dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 ' +
  'fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 ' +
  'green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c ' +
  'indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 ' +
  'lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 ' +
  'lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a ' +
  'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
  'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff ' +
  'maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db ' +
  'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc ' +
  'mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 ' +
  'navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 ' +
  'orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee ' +
  'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd ' +
  'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 ' +
  'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d ' +
  'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
  'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
  'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
  'yellowgreen:9acd32').split(' ').map((pair) => pair.split(':') as [string, string]),
);

/** A named color's rrggbb, if `name` (lowercase) is one. */
export function namedColorHex(name: string): string | undefined {
  return NAMED_COLORS.get(name);
}

/** System colors (CSS Color 4 §6.2), including the deprecated ones browsers still parse. */
const SYSTEM_COLORS = new Set(
  ('accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field ' +
  'fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext ' +
  'visitedtext activeborder activecaption appworkspace background buttonhighlight buttonshadow ' +
  'captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext ' +
  'scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window ' +
  'windowframe windowtext').split(' '),
);

const COLOR_SPACES = new Set([
  'srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65',
]);
const INTERPOLATION_SPACES = new Set([...COLOR_SPACES, 'hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch']);
const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);

/** `in <space> [<hue-method> hue]` tokens (a color-mix or gradient interpolation method). */
function isInterpolation(parts: string[]): boolean {
  if (parts[0]?.toLowerCase() !== 'in' || !INTERPOLATION_SPACES.has(parts[1]?.toLowerCase())) return false;
  if (parts.length === 2) return true;
  return parts.length === 4 && HUE_METHODS.has(parts[2].toLowerCase()) && parts[3].toLowerCase() === 'hue';
}

/** Space-separated channels, then optional `/ alpha` (CSS Color 4 modern syntax). */
function isModernChannels(args: string, channels: number, angleAt: number): boolean {
  const t = tokens(args.trim());
  const slash = t.indexOf('/');
  const comps = slash === -1 ? t : t.slice(0, slash);
  if (comps.length !== channels) return false;
  if (!comps.every((c, i) => isNumeric(c, i === angleAt))) return false;
  if (slash === -1) return true;
  return t.length === slash + 2 && isNumeric(t[slash + 1], false);
}

/** Comma-separated legacy `rgb()`/`hsl()` arguments. */
function isLegacyChannels(parts: string[], hsl: boolean): boolean {
  if (parts.length !== 3 && parts.length !== 4) return false;
  const p = parts.map((x) => x.trim().toLowerCase());
  if (p.some((x) => x === 'none' || x === '')) return false;
  const pct = (x: string) => PERCENTAGE.test(x) || MATH.test(x);
  const num = (x: string) => NUMBER.test(x) || MATH.test(x);
  if (hsl) {
    if (!(num(p[0]) || ANGLE.test(p[0])) || !pct(p[1]) || !pct(p[2])) return false;
  } else if (!(p.slice(0, 3).every(num) || p.slice(0, 3).every(pct))) return false;
  return p.length === 3 || num(p[3]) || pct(p[3]);
}

/**
 * A `<color>`: keyword, hex or color function. `currentcolor` and `transparent`
 * included. Memoized: documents repeat a handful of colors thousands of times.
 */
export const isColor: (value: string) => boolean = memoized(checkColor);

function checkColor(value: string): boolean {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (NAMED_COLORS.has(lower) || SYSTEM_COLORS.has(lower) || lower === 'transparent' || lower === 'currentcolor') {
    return true;
  }
  if (lower[0] === '#') return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(lower);
  const fn = functionToken(v);
  if (!fn || /\b(?:var|attr|env)\(/i.test(fn.args)) return false;
  const args = fn.args.trim();
  // Relative color syntax (`rgb(from red r g b)`): the origin must be a
  // color; its channel expressions are not checked further.
  if (/^from\s/i.test(args)) {
    const rest = splitTopLevelWhitespace(args);
    return rest.length >= 2 && isColor(rest[1]);
  }
  switch (fn.name) {
    case 'rgb': case 'rgba': case 'hsl': case 'hsla': {
      const hsl = fn.name[0] === 'h';
      const commas = splitTopLevel(args, ',');
      return commas.length > 1 ? isLegacyChannels(commas, hsl) : isModernChannels(args, 3, hsl ? 0 : -1);
    }
    case 'hwb': return isModernChannels(args, 3, 0);
    case 'lab': case 'oklab': return isModernChannels(args, 3, -1);
    case 'lch': case 'oklch': return isModernChannels(args, 3, 2);
    case 'color': {
      const t = splitTopLevelWhitespace(args);
      return t.length > 0 && (COLOR_SPACES.has(t[0].toLowerCase()) || t[0].startsWith('--')) &&
        isModernChannels(t.slice(1).join(' '), 3, -1);
    }
    case 'color-mix': {
      const parts = splitTopLevel(args, ',');
      if (parts.length !== 3 || !isInterpolation(splitTopLevelWhitespace(parts[0]))) return false;
      return parts.slice(1).every((part) => {
        const t = splitTopLevelWhitespace(part);
        if (t.length === 1) return isColor(t[0]);
        return t.length === 2 && ((isColor(t[0]) && PERCENTAGE.test(t[1])) || (PERCENTAGE.test(t[0]) && isColor(t[1])));
      });
    }
    case 'light-dark': {
      const parts = splitTopLevel(args, ',');
      return parts.length === 2 && parts.every((p) => isColor(p));
    }
  }
  return false;
}

/**
 * `<font color>`: a named or hex color as written, a bare 6-digit hex as `#rrggbb` (what
 * editors write); null (the attribute is ignored) for anything else, `transparent` included.
 * HTML's forgiving hex mangling of other values (`chucknorris`) is not followed.
 */
export function parseLegacyColor(value: string): string | null {
  const v = value.trim();
  if (/^[\da-f]{6}$/i.test(v)) return `#${v}`;
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v) || NAMED_COLORS.has(v.toLowerCase()) ? v : null;
}

// ─── Images ─────────────────────────────────────────────────────────

/** Color stops (and hints) of a gradient: at least two stops, a hint only between stops. */
function isColorStopList(parts: string[], position: (t: string) => boolean): boolean {
  let stops = 0;
  let previousWasHint = true; // a list may not start with a hint
  for (let i = 0; i < parts.length; i++) {
    const t = splitTopLevelWhitespace(parts[i].trim());
    if (t.length === 1 && position(t[0])) {
      if (previousWasHint || i === parts.length - 1) return false;
      previousWasHint = true;
      continue;
    }
    if (t.length === 0 || t.length > 3 || !isColor(t[0]) || !t.slice(1).every(position)) return false;
    stops++;
    previousWasHint = false;
  }
  return stops >= 2;
}

const SIDES = new Set(['left', 'right', 'top', 'bottom']);
const RADIAL_WORDS = new Set([
  'circle', 'ellipse', 'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner',
  'at', 'left', 'right', 'top', 'bottom', 'center',
]);

/** The configuration argument of a gradient (before its color stops). */
function isGradientPrelude(kind: string, part: string): boolean {
  let t = splitTopLevelWhitespace(part.trim());
  // An interpolation method may lead or trail the rest.
  const inAt = t.findIndex((x) => x.toLowerCase() === 'in');
  if (inAt !== -1) {
    const end = HUE_METHODS.has(t[inAt + 2]?.toLowerCase()) ? inAt + 4 : inAt + 2;
    if (!isInterpolation(t.slice(inAt, end))) return false;
    t = [...t.slice(0, inAt), ...t.slice(end)];
    if (t.length === 0) return true;
  }
  const lower = t.map((x) => x.toLowerCase());
  if (kind === 'linear') {
    if (lower.length === 1 && isAngleOrZero(lower[0])) return true;
    return lower[0] === 'to' && (lower.length === 2 || lower.length === 3) &&
      lower.slice(1).every((x) => SIDES.has(x)) &&
      (lower.length === 2 || (['left', 'right'].includes(lower[1]) !== ['left', 'right'].includes(lower[2])));
  }
  if (kind === 'radial') return lower.every((x) => RADIAL_WORDS.has(x) || isLength(x, true));
  // conic: `from <angle>`, `at <position>`
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === 'from') { if (!isAngleOrZero(lower[++i] ?? '')) return false; continue; }
    if (!(lower[i] === 'at' || RADIAL_WORDS.has(lower[i]) || isLength(lower[i], true))) return false;
  }
  return true;
}

function isGradient(kind: string, args: string): boolean {
  const parts = splitTopLevel(args, ',');
  const first = splitTopLevelWhitespace(parts[0].trim());
  const position = kind === 'conic'
    ? (t: string) => isAngleOrZero(t) || PERCENTAGE.test(t)
    : (t: string) => isLength(t, true);
  // The first argument is the configuration unless it starts with a color.
  const hasPrelude = first.length > 0 && !isColor(first[0]);
  if (hasPrelude && !isGradientPrelude(kind, parts[0])) return false;
  return isColorStopList(hasPrelude ? parts.slice(1) : parts, position);
}

/** One `<image>`: url(), a gradient, or another image function (checked for balance only). */
export function isImage(value: string): boolean {
  const v = value.trim();
  const fn = functionToken(v);
  if (!fn || /\b(?:var|attr|env)\(/i.test(fn.args)) return false;
  const m = /^(?:repeating-)?(linear|radial|conic)-gradient$/.exec(fn.name);
  if (m) return isGradient(m[1], fn.args);
  return fn.name === 'url' || fn.name === 'image-set' || fn.name === '-webkit-image-set' ||
    fn.name === 'cross-fade' || fn.name === '-webkit-cross-fade' || fn.name === 'image' ||
    fn.name === 'paint' || fn.name === 'element' ||
    // The prefixed legacy gradients Blink and WebKit still parse.
    /^-webkit-(?:repeating-)?(?:linear|radial)-gradient$|^-webkit-gradient$/.test(fn.name);
}

/** `background-image`: `none` or a comma list of images. */
export function isImageList(value: string): boolean {
  if (value.trim().toLowerCase() === 'none') return true;
  return splitTopLevel(value, ',').every((layer) => {
    const v = layer.trim();
    return v.toLowerCase() === 'none' || isImage(v);
  });
}

// ─── Shadows, fonts ─────────────────────────────────────────────────

/** `text-shadow`: `none` or a comma list of `<color>? && <length>{2,3}` (blur ≥ 0). */
export function isTextShadow(value: string): boolean {
  if (value.trim().toLowerCase() === 'none') return true;
  return splitTopLevel(value, ',').every((item) => {
    const t = splitTopLevelWhitespace(item.trim());
    let lengths = 0;
    let colors = 0;
    let lengthRun = false;
    let runs = 0;
    for (const token of t) {
      if (isLength(token, false)) {
        if (!lengthRun) runs++;
        lengthRun = true;
        lengths++;
        if (lengths === 3 && resolveLength(token, CHECK_BASIS_NO_PERCENT) < 0) return false;
      } else {
        lengthRun = false;
        if (!isColor(token)) return false;
        colors++;
      }
    }
    return runs === 1 && (lengths === 2 || lengths === 3) && colors <= 1;
  });
}

const FAMILY_IDENT = /^-?(?:[a-z_\u0080-￿]|\\.)(?:[\w\u0080-￿-]|\\.)*$/i;
const NOT_FAMILY_NAMES = new Set(['inherit', 'initial', 'unset', 'default', 'revert', 'revert-layer']);

/**
 * `font-family`: a comma list of strings (an empty one included, as Blink
 * parses it) or identifier sequences. Memoized: every element re-checks its
 * matched declaration.
 */
export const isFontFamilyList: (value: string) => boolean = memoized((value) =>
  splitTopLevel(value, ',').every((item) => {
    const v = item.trim();
    if (/^(['"])[\s\S]*\1$/.test(v)) return v.length >= 2;
    const words = v.split(/\s+/);
    return words[0] !== '' && words.every((w) => FAMILY_IDENT.test(w)) &&
      !(words.length === 1 && NOT_FAMILY_NAMES.has(words[0].toLowerCase()));
  }));

// ─── Keywords ───────────────────────────────────────────────────────

const set = (words: string) => new Set(words.split(' '));

const OVERFLOW = set('visible hidden clip scroll auto overlay');
export const BORDER_STYLES = set('none hidden dotted dashed solid double groove ridge inset outset');

/** Single-keyword properties: the values a browser accepts. */
export const KEYWORDS: Record<string, Set<string>> = {
  'text-align': set('start end left right center justify match-parent -webkit-left -webkit-right -webkit-center'),
  'text-align-last': set('auto start end left right center justify match-parent'),
  'text-decoration-style': set('solid double dotted dashed wavy'),
  'font-kerning': set('auto normal none'),
  'text-rendering': set('auto optimizespeed optimizelegibility geometricprecision'),
  'white-space': set('normal pre nowrap pre-wrap pre-line break-spaces'),
  'word-break': set('normal break-all keep-all break-word auto-phrase'),
  'overflow-wrap': set('normal break-word anywhere'),
  direction: set('ltr rtl'),
  'unicode-bidi': set('normal embed isolate bidi-override isolate-override plaintext -webkit-isolate -webkit-isolate-override -webkit-plaintext'),
  'stroke-linejoin': set('miter round bevel miter-clip arcs'),
  'flex-direction': set('row row-reverse column column-reverse'),
  'overflow-x': OVERFLOW,
  'overflow-y': OVERFLOW,
  'border-top-style': BORDER_STYLES,
  'border-right-style': BORDER_STYLES,
  'border-bottom-style': BORDER_STYLES,
  'border-left-style': BORDER_STYLES,
};

const VERTICAL_ALIGN = set('baseline sub super text-top text-bottom middle top bottom');

/** `vertical-align`, lower-cased, or null: a keyword or a length-percentage. */
export function verticalAlign(value: string): string | null {
  const v = value.trim().toLowerCase();
  return VERTICAL_ALIGN.has(v) || isLength(v, true) ? v : null;
}

/** `font-style`, lower-cased, or null: normal, italic, or oblique with an optional angle. */
export function fontStyle(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (v === 'normal' || v === 'italic' || v === 'oblique') return v;
  const m = /^oblique ([^ ]+)$/.exec(v);
  return m && ANGLE.test(m[1]) ? v : null;
}

/** A space-separated set of distinct keywords from `allowed` (at least one), lower-cased; or null. */
function keywordSet(value: string, allowed: Set<string>): string | null {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 0 || words[0] === '' || new Set(words).size !== words.length) return null;
  return words.every((w) => allowed.has(w)) ? words.join(' ') : null;
}

const DECORATION_LINES = set('underline overline line-through blink');

/** `text-decoration-line`: `none` or distinct line keywords, lower-cased; or null. */
export function textDecorationLine(value: string): string | null {
  const v = value.trim().toLowerCase();
  return v === 'none' ? v : keywordSet(v, DECORATION_LINES);
}

const PAINT_ORDER = set('fill stroke markers');
/** `paint-order`: `normal` or distinct fill/stroke/markers, lower-cased; or null. */
export function paintOrder(value: string): string | null {
  const v = value.trim().toLowerCase();
  return v === 'normal' ? v : keywordSet(v, PAINT_ORDER);
}

/** `text-transform`: `none`, or one case keyword with full-width / full-size-kana; or null. */
export function textTransform(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === 'none') return v;
  const words = keywordSet(v, set('capitalize uppercase lowercase full-width full-size-kana'));
  if (!words) return null;
  const cases = words.split(' ').filter((w) => w === 'capitalize' || w === 'uppercase' || w === 'lowercase');
  return cases.length <= 1 ? words : null;
}

const BACKGROUND_CLIP = set('border-box padding-box content-box text border-area');
/** `background-clip`: a comma list of boxes, lower-cased; or null. */
export function backgroundClip(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v.includes(',')) return BACKGROUND_CLIP.has(v) ? v : null;
  const layers = v.split(',').map((l) => l.trim());
  return layers.every((l) => BACKGROUND_CLIP.has(l)) ? layers.join(', ') : null;
}

const DISPLAY_SINGLE = set(
  'none contents block inline inline-block flex inline-flex grid inline-grid flow-root list-item ' +
  'table inline-table table-row-group table-header-group table-footer-group table-row table-cell ' +
  'table-column-group table-column table-caption ruby ruby-text math -webkit-box -webkit-inline-box',
);
/** `display`, lower-cased; only the single-keyword forms. */
export function display(value: string): string | null {
  const v = value.trim().toLowerCase();
  return DISPLAY_SINGLE.has(v) ? v : null;
}

const LIST_STYLE_PREDEFINED = set(
  'disc circle square disclosure-open disclosure-closed decimal decimal-leading-zero lower-roman upper-roman ' +
  'lower-greek lower-alpha lower-latin upper-alpha upper-latin arabic-indic armenian bengali cambodian ' +
  'cjk-decimal cjk-earthly-branch cjk-heavenly-stem cjk-ideographic devanagari ethiopic-numeric georgian ' +
  'gujarati gurmukhi hebrew hiragana hiragana-iroha japanese-formal japanese-informal kannada katakana ' +
  'katakana-iroha khmer korean-hangul-formal korean-hanja-formal korean-hanja-informal lao lower-armenian ' +
  'malayalam mongolian myanmar oriya persian simp-chinese-formal simp-chinese-informal tamil telugu thai ' +
  'tibetan trad-chinese-formal trad-chinese-informal upper-armenian none',
);

/**
 * `list-style-type`: a predefined counter style (lower-cased), another
 * identifier (a custom counter style, kept as written), a string or
 * `symbols()`; null otherwise.
 */
export function listStyleType(value: string): string | null {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (LIST_STYLE_PREDEFINED.has(lower)) return lower;
  if (/^(['"])[\s\S]*\1$/.test(v)) return v;
  if (functionToken(v)?.name === 'symbols') return v;
  return FAMILY_IDENT.test(v) && !NOT_FAMILY_NAMES.has(lower) ? v : null;
}

