/**
 * Syntax checks for the values the resolver stores as strings: colors,
 * images, shadows, font families and keyword properties. A browser drops a
 * declaration whose value does not parse, so the cascaded value below it
 * survives; render-tag must too — otherwise `style="color: foo"` overrides a
 * valid sheet color with a string canvas ignores (it then paints with
 * whatever fillStyle was left over), and `display: blok` falls through every
 * `===` test in layout.
 *
 * These are GRAMMAR checks, not evaluators: a value that passes is stored as
 * written (keywords lower-cased) and resolved where it is used. They follow
 * CSS Color 4, CSS Images 4, CSS Text Decoration and CSS Fonts 4, as Blink
 * and WebKit parse them. Unsupported value syntax — `var()`, `attr()`,
 * `env()` — fails the check, so such a declaration is ignored like any other
 * invalid one.
 */
import { resolveLength, type LengthBasis } from './css-values.js';

// ─── Splitting ──────────────────────────────────────────────────────

/** Split at a top-level separator (outside parens and strings). */
export function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\') i++; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === separator && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out;
}

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
function tokens(value: string): string[] {
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

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i;
const ANGLE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:deg|rad|grad|turn)$/i;
const MATH = /^(?:calc|min|max|clamp)\(/i;

/** A basis that resolves every unit, for syntax checks only. */
const CHECK_BASIS: LengthBasis = {
  em: 16, rem: 16, percent: 1, viewport: { width: 100, height: 100 }, fontStyle: null, measure: undefined,
};
const CHECK_BASIS_NO_PERCENT: LengthBasis = { ...CHECK_BASIS, percent: NaN };

/** A `<length>` (or `<length-percentage>`), math functions included. */
export function isLength(token: string, allowPercent: boolean): boolean {
  return !Number.isNaN(resolveLength(token, allowPercent ? CHECK_BASIS : CHECK_BASIS_NO_PERCENT));
}

/** A numeric component of a color function: number, percentage, angle, `none` or math. */
function isNumeric(token: string, angle: boolean): boolean {
  const t = token.toLowerCase();
  return NUMBER.test(t) || PERCENT.test(t) || (angle && ANGLE.test(t)) || t === 'none' || MATH.test(t);
}

function isAngleOrZero(token: string): boolean {
  return ANGLE.test(token) || token === '0' || MATH.test(token);
}

// ─── Colors ─────────────────────────────────────────────────────────

/** The CSS named colors (CSS Color 4 §6.1). */
export const NAMED_COLORS = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
  'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
  'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
  'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
  'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
  'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
  'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
  'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
  'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
  'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
  'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
  'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
  'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
  'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '),
);

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
  const pct = (x: string) => PERCENT.test(x) || MATH.test(x);
  const num = (x: string) => NUMBER.test(x) || MATH.test(x);
  if (hsl) {
    if (!(num(p[0]) || ANGLE.test(p[0])) || !pct(p[1]) || !pct(p[2])) return false;
  } else if (!(p.slice(0, 3).every(num) || p.slice(0, 3).every(pct))) return false;
  return p.length === 3 || num(p[3]) || pct(p[3]);
}

/**
 * Answers of `isColor` by exact text. A pure function of the string, so it
 * may outlive a call; documents repeat a handful of colors thousands of
 * times. Bounded: cleared when full.
 */
const colorAnswers = new Map<string, boolean>();
const COLOR_ANSWERS_MAX = 512;

/** A `<color>`: keyword, hex or color function. `currentcolor` and `transparent` included. */
export function isColor(value: string): boolean {
  let answer = colorAnswers.get(value);
  if (answer === undefined) {
    answer = checkColor(value);
    if (colorAnswers.size >= COLOR_ANSWERS_MAX) colorAnswers.clear();
    colorAnswers.set(value, answer);
  }
  return answer;
}

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
        return t.length === 2 && ((isColor(t[0]) && PERCENT.test(t[1])) || (PERCENT.test(t[0]) && isColor(t[1])));
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
 * HTML's "rules for parsing a legacy colour value" (`<font color>`,
 * `bgcolor`): a named color as itself, anything else through the forgiving
 * hex mangling that turns `chucknorris` into rgb(192, 0, 0). null (the
 * attribute is ignored) for an empty value and for `transparent`.
 */
export function parseLegacyColor(value: string): string | null {
  let input = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  if (!input || input.toLowerCase() === 'transparent') return null;
  if (NAMED_COLORS.has(input.toLowerCase())) return input.toLowerCase();
  const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
  if (/^#[\da-f]{3}$/i.test(input)) {
    const d = (i: number) => parseInt(input[i], 16) * 17;
    return rgb(d(1), d(2), d(3));
  }
  // Characters outside the BMP count as "00"; the input is cut at 128.
  input = Array.from(input, (ch) => (ch.codePointAt(0)! > 0xffff ? '00' : ch)).join('');
  if (input.length > 128) input = input.slice(0, 128);
  if (input[0] === '#') input = input.slice(1);
  input = input.replace(/[^\da-f]/gi, '0');
  while (input.length === 0 || input.length % 3 !== 0) input += '0';
  let len = input.length / 3;
  let parts = [input.slice(0, len), input.slice(len, 2 * len), input.slice(2 * len)];
  if (len > 8) {
    parts = parts.map((p) => p.slice(len - 8));
    len = 8;
  }
  while (len > 2 && parts.every((p) => p[0] === '0')) {
    parts = parts.map((p) => p.slice(1));
    len--;
  }
  if (len > 2) parts = parts.map((p) => p.slice(0, 2));
  const [r, g, b] = parts.map((p) => parseInt(p, 16));
  return rgb(r, g, b);
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
    ? (t: string) => isAngleOrZero(t) || PERCENT.test(t)
    : (t: string) => isLength(t, true);
  // The first argument is the configuration unless it starts with a color.
  const hasPrelude = first.length > 0 && !isColor(first[0]);
  if (hasPrelude && !isGradientPrelude(kind, parts[0])) return false;
  return isColorStopList(hasPrelude ? parts.slice(1) : parts, position);
}

/** One `<image>`: url(), a gradient, or another image function (checked for balance only). */
function isImage(value: string): boolean {
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

/** One image of the `background` shorthand (a function token). */
export function isImageToken(token: string): boolean {
  return isImage(token);
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

/** `font-family`: a comma list of strings (an empty one included, as Blink parses it) or identifier sequences. */
export function isFontFamilyList(value: string): boolean {
  return splitTopLevel(value, ',').every((item) => {
    const v = item.trim();
    if (/^(['"])[\s\S]*\1$/.test(v)) return v.length >= 2;
    const words = v.split(/\s+/);
    return words[0] !== '' && words.every((w) => FAMILY_IDENT.test(w)) &&
      !(words.length === 1 && NOT_FAMILY_NAMES.has(words[0].toLowerCase()));
  });
}

// ─── Keywords ───────────────────────────────────────────────────────

const set = (words: string) => new Set(words.split(' '));

/** Single-keyword properties: the values a browser accepts. */
export const KEYWORDS: Record<string, Set<string>> = {
  'text-align': set('start end left right center justify match-parent -webkit-left -webkit-right -webkit-center'),
  'text-align-last': set('auto start end left right center justify match-parent'),
  'text-decoration-style': set('solid double dotted dashed wavy'),
  'font-kerning': set('auto normal none'),
  'white-space': set('normal pre nowrap pre-wrap pre-line break-spaces'),
  'word-break': set('normal break-all keep-all break-word auto-phrase'),
  'overflow-wrap': set('normal break-word anywhere'),
  'word-wrap': set('normal break-word anywhere'),
  direction: set('ltr rtl'),
  'unicode-bidi': set('normal embed isolate bidi-override isolate-override plaintext -webkit-isolate -webkit-isolate-override -webkit-plaintext'),
  'stroke-linejoin': set('miter round bevel miter-clip arcs'),
  'flex-direction': set('row row-reverse column column-reverse'),
  'overflow-x': set('visible hidden clip scroll auto overlay'),
  'overflow-y': set('visible hidden clip scroll auto overlay'),
  'border-top-style': set('none hidden dotted dashed solid double groove ridge inset outset'),
  'border-right-style': set('none hidden dotted dashed solid double groove ridge inset outset'),
  'border-bottom-style': set('none hidden dotted dashed solid double groove ridge inset outset'),
  'border-left-style': set('none hidden dotted dashed solid double groove ridge inset outset'),
};

export const BORDER_STYLES = KEYWORDS['border-top-style'];

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
  const layers = splitTopLevel(value.toLowerCase(), ',').map((l) => l.trim());
  return layers.every((l) => BACKGROUND_CLIP.has(l)) ? layers.join(', ') : null;
}

const DISPLAY_SINGLE = set(
  'none contents block inline inline-block flex inline-flex grid inline-grid flow-root list-item ' +
  'table inline-table table-row-group table-header-group table-footer-group table-row table-cell ' +
  'table-column-group table-column table-caption ruby ruby-text math -webkit-box -webkit-inline-box',
);
const DISPLAY_OUTER = set('block inline run-in');
const DISPLAY_INNER = set('flow flow-root table flex grid ruby');
/** The legacy keyword a two-value `display` serializes to (CSS Display 3 §2.1). */
const DISPLAY_LEGACY: Record<string, string> = {
  'block flow': 'block', 'block flow-root': 'flow-root', 'inline flow': 'inline', 'inline flow-root': 'inline-block',
  'block flex': 'flex', 'inline flex': 'inline-flex', 'block grid': 'grid', 'inline grid': 'inline-grid',
  'block table': 'table', 'inline table': 'inline-table', 'inline ruby': 'ruby',
  'block flow list-item': 'list-item',
};

/** `display`, lower-cased and with multi-keyword forms in their legacy spelling; or null. */
export function display(value: string): string | null {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1) return DISPLAY_SINGLE.has(words[0]) ? words[0] : null;
  if (words.length > 3 || new Set(words).size !== words.length) return null;
  let outer = '', inner = '', listItem = false;
  for (const w of words) {
    if (w === 'list-item') listItem = true;
    else if (DISPLAY_OUTER.has(w) && !outer) outer = w;
    else if (DISPLAY_INNER.has(w) && !inner) inner = w;
    else return null;
  }
  // A list item's inner display is flow or flow-root only.
  if (listItem && inner && inner !== 'flow' && inner !== 'flow-root') return null;
  outer ||= inner === 'ruby' ? 'inline' : 'block';
  inner ||= 'flow';
  const canonical = listItem ? `${outer} ${inner} list-item` : `${outer} ${inner}`;
  return DISPLAY_LEGACY[canonical] ?? canonical;
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

/** Is `token` a list-style-type value (for the `list-style` shorthand)? */
export function isListStyleType(token: string): boolean {
  return listStyleType(token) !== null;
}
