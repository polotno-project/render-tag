import { namedColorHex, splitTopLevel, splitTopLevelWhitespace } from './css-validate.js';
import { numberThen, resolveNumberOrLength } from './css-values.js';
import type { AnyCanvas } from './types.js';

const ANGLE = numberThen('(deg|grad|rad|turn)');
const DEGREES_PER: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const STOP_LENGTH = numberThen('(%|px)?');

/**
 * The CSS angle of a direction, or null when `part` is a color stop. A corner
 * is perpendicular to the diagonal of the neighbouring corners (CSS Images 3
 * §3.1.1): `to top right` on 200×100 is 26.57deg.
 */
function gradientAngle(part: string, width: number, height: number): number | null {
  const angle = ANGLE.exec(part);
  if (angle) return parseFloat(angle[1]) * DEGREES_PER[angle[2].toLowerCase()];
  const words = part.toLowerCase().split(/\s+/);
  if (words[0] !== 'to' || words.length < 2 || words.length > 3) return null;
  const sides = new Set(words.slice(1));
  if (sides.size !== words.length - 1) return null;
  const top = sides.has('top'), bottom = sides.has('bottom');
  const left = sides.has('left'), right = sides.has('right');
  if ((top && bottom) || (left && right) || sides.size !== +top + +bottom + +left + +right) return null;
  if (sides.size === 1) return top ? 0 : right ? 90 : bottom ? 180 : 270;
  const corner = Math.atan2(height, width) * 180 / Math.PI;
  if (top) return right ? corner : 360 - corner;
  return right ? 180 - corner : 180 + corner;
}

const LINEAR_FUNCTION = /(repeating-)?linear-gradient\(/i;
const RADIAL_FUNCTION = /(repeating-)?radial-gradient\(/i;

/** The index past a string's closing quote; `start` is its opening quote. */
function stringEnd(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length && s[i] !== quote) i += s[i] === '\\' ? 2 : 1;
  return Math.min(s.length, i + 1);
}

/**
 * `bgImage` with each quoted string and `url(…)` blanked to spaces (same
 * length, so indices carry over): a gradient name in a file path is not a call.
 */
function blankUrlsAndStrings(s: string): string {
  if (!/["']|url\(/i.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length;) {
    let end = i + 1;
    if (s[i] === '"' || s[i] === "'") {
      end = stringEnd(s, i);
    } else if (s.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(s[i - 1] ?? '')) {
      end = i + 4;
      while (end < s.length && /\s/.test(s[end])) end++;
      if (s[end] === '"' || s[end] === "'") end = stringEnd(s, end);
      while (end < s.length && s[end] !== ')') end += s[end] === '\\' ? 2 : 1;
      end = Math.min(s.length, end + 1);
    } else {
      out += s[i++];
      continue;
    }
    out += ' '.repeat(end - i);
    i = end;
  }
  return out;
}

/** The gradient `bgImage` paints: a linear one wherever it appears, else a radial one. */
export function gradientKind(bgImage: string): 'linear' | 'radial' | null {
  const calls = blankUrlsAndStrings(bgImage);
  return LINEAR_FUNCTION.test(calls) ? 'linear' : RADIAL_FUNCTION.test(calls) ? 'radial' : null;
}

/** What a gradient paints with: a canvas gradient, a pattern (`radialPaint`), or a solid colour. */
export type GradientPaint = CanvasGradient | CanvasPattern | string;

/** A CSS linear or radial gradient as a paint over the box. */
export function parseGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
  raster?: RadialRaster,
): GradientPaint | null {
  return gradientKind(bgImage) === 'radial'
    ? parseRadialGradient(ctx, bgImage, x, width, y, height, raster)
    : parseLinearGradient(ctx, bgImage, x, width, y, height);
}

/** The first `fn` call in `bgImage`: whether it repeats, and its comma-separated arguments. */
function gradientArguments(bgImage: string, fn: RegExp): { repeating: boolean; parts: string[] } | null {
  const calls = blankUrlsAndStrings(bgImage);
  const m = fn.exec(calls);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < calls.length; i++) {
    if (calls[i] === '(') depth++;
    else if (calls[i] === ')') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx === -1) return null;
  const parts = splitTopLevel(bgImage.slice(startIdx, endIdx), ',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return { repeating: m[1] !== undefined, parts };
}

/**
 * Color stops as [color, offset] with offsets as fractions of a gradient ray
 * `length` px long, fixed up per CSS Images 3 §3.4.3; null when none paints.
 * A color hint is ignored, and a repeating gradient is unrolled over [0, end].
 */
function colorStops(
  entries: string[], length: number, repeating: boolean, end = 1,
  /** Set when a stop is placed at a non-zero px length. */
  lengths?: { px: boolean },
): [string, number][] | null {
  const stops: [string, number | null][] = [];
  for (const entry of entries) {
    const tokens = splitTopLevelWhitespace(entry);
    const positions: number[] = [];
    while (tokens.length > 1) {
      const m = STOP_LENGTH.exec(tokens[tokens.length - 1]);
      if (!m || (!m[2] && parseFloat(m[1]) !== 0)) break;
      const value = parseFloat(m[1]);
      if (lengths && m[2] === 'px' && value !== 0) lengths.px = true;
      positions.unshift(m[2] === '%' ? value / 100 : length > 0 ? value / length : 0);
      tokens.pop();
    }
    // A color hint.
    if (tokens.length === 1 && STOP_LENGTH.test(tokens[0])) continue;
    if (tokens.length === 0 || positions.length > 2) continue;
    const color = tokens.join(' ');
    if (positions.length === 0) stops.push([color, null]);
    for (const position of positions) stops.push([color, position]);
  }
  if (stops.length === 0) return null;

  if (stops[0][1] === null) stops[0][1] = 0;
  if (stops[stops.length - 1][1] === null) stops[stops.length - 1][1] = 1;
  let max = -Infinity;
  for (const stop of stops) {
    if (stop[1] !== null) stop[1] = max = Math.max(max, stop[1]);
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i][1] !== null) continue;
    let j = i;
    while (stops[j][1] === null) j++;
    const from = stops[i - 1][1]!, to = stops[j][1]!;
    for (let k = i; k < j; k++) stops[k][1] = from + (to - from) * (k - i + 1) / (j - i + 1);
    i = j;
  }

  return repeating ? repeatStops(stops as [string, number][], end) : stops as [string, number][];
}

/**
 * A CSS (repeating-)linear-gradient as a CanvasGradient over the box. Stops
 * follow CSS Images 3 §3.4.3; out-of-range stops stretch the canvas line.
 * Deviations: a color hint is ignored (linear transition), and a repeating
 * gradient is unrolled into plain stops.
 */
export function parseLinearGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): CanvasGradient | null {
  const args = gradientArguments(bgImage, LINEAR_FUNCTION);
  if (!args) return null;
  const { parts } = args;

  const direction = gradientAngle(parts[0], width, height);
  const angle = direction ?? 180; // default: to bottom
  const rad = angle * Math.PI / 180;
  const dirX = Math.sin(rad), dirY = -Math.cos(rad);
  const length = Math.abs(width * dirX) + Math.abs(height * dirY);

  const stops = colorStops(parts.slice(direction === null ? 0 : 1), length, args.repeating);
  if (!stops) return null;

  // Canvas offsets must lie in [0, 1]: map [first, last] onto the canvas line.
  const first = Math.min(0, stops[0][1]);
  const last = Math.max(1, stops[stops.length - 1][1]);
  const span = last - first;
  const x0 = x + width / 2 - dirX * length / 2;
  const y0 = y + height / 2 - dirY * length / 2;
  const gradient = ctx.createLinearGradient(
    x0 + dirX * length * first, y0 + dirY * length * first,
    x0 + dirX * length * last, y0 + dirY * length * last,
  );
  for (const [color, offset] of stops) {
    try {
      gradient.addColorStop(Math.min(1, Math.max(0, (offset - first) / span)), color);
    } catch {
      // Invalid color: keep the paintable stops.
    }
  }
  return gradient;
}

/** The first argument of a radial gradient is its configuration when it opens with one of these or a length. */
const RADIAL_CONFIG = /^(?:(?:circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|at|in)(?:\s|$)|[-+]?\.?\d)/i;
/** A math function, which only a size or a position can open with (CSS Values 4 §10). */
const MATH_FUNCTION = /^(?:-webkit-)?(?:calc|min|max|clamp|round|mod|rem|abs|sign|hypot|sqrt|pow|exp|log|sin|cos|tan|asin|acos|atan2?)\(/i;

/** Whether a radial gradient's first argument is its configuration rather than a color stop. */
function isRadialConfig(part: string): boolean {
  if (RADIAL_CONFIG.test(part)) return true;
  const tokens = splitTopLevelWhitespace(part);
  return MATH_FUNCTION.test(tokens[0]) || tokens.some((t) => t.toLowerCase() === 'at');
}

/** One `<position>` component: its axis when a keyword fixes it, and its offset into a box side. */
function positionComponent(token: string): { axis: 'x' | 'y' | null; at: (side: number) => number } | null {
  switch (token.toLowerCase()) {
    case 'left': return { axis: 'x', at: () => 0 };
    case 'right': return { axis: 'x', at: (side) => side };
    case 'top': return { axis: 'y', at: () => 0 };
    case 'bottom': return { axis: 'y', at: (side) => side };
    case 'center': return { axis: null, at: (side) => side / 2 };
  }
  const m = STOP_LENGTH.exec(token);
  if (!m || (!m[2] && parseFloat(m[1]) !== 0)) return null;
  const value = parseFloat(m[1]);
  return { axis: null, at: m[2] === '%' ? (side) => side * value / 100 : () => value };
}

/** The centre offsets for `at <position>` (one or two components), else the box centre. */
function radialCenter(tokens: string[], width: number, height: number): [number, number] {
  const center: [number, number] = [width / 2, height / 2];
  const parts = tokens.map(positionComponent);
  if (parts.some((p) => p === null)) return center;
  let [h, v] = parts as { axis: 'x' | 'y' | null; at: (side: number) => number }[];
  if (parts.length === 1) {
    return h.axis === 'y' ? [width / 2, h.at(height)] : [h.at(width), height / 2];
  }
  if (parts.length !== 2) return center;
  if (h.axis === 'y' || v.axis === 'x') [h, v] = [v, h];
  if (h.axis === 'y' || v.axis === 'x') return center;
  return [h.at(width), v.at(height)];
}

export interface RadialGradientGeometry {
  /** The centre, in the box's coordinate space. */
  cx: number;
  cy: number;
  /** The ending shape's radii; equal for a circle. */
  rx: number;
  ry: number;
  /** [color, offset], offsets as fractions of `rx` (past 1 beyond the ending shape). */
  stops: [string, number][];
  /** The box the gradient is sized over. */
  box: { x: number; y: number; width: number; height: number };
}

const EXTENTS = new Set(['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner']);
const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);
const LENGTH_TOKEN = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z%]*)$/i;

/**
 * One `<radial-size>` length in px: `percentOf` is the box side a percentage
 * reads against (NaN for a circle, which takes none). 'unresolved' for a
 * length with no basis here (font and viewport units); null when invalid.
 */
function radialLength(token: string, percentOf: number): number | 'unresolved' | null {
  const plain = LENGTH_TOKEN.exec(token);
  if (plain) {
    const value = parseFloat(plain[1]), unit = plain[2].toLowerCase();
    if (value < 0) return null;
    if (!unit) return value === 0 ? 0 : null;
    if (unit === '%') return Number.isNaN(percentOf) ? null : value * percentOf / 100;
  } else if (!MATH_FUNCTION.test(token)) {
    return null;
  }
  const typed = resolveNumberOrLength(token, { ...CHANNEL_BASIS, percent: percentOf });
  if (!typed || !Number.isFinite(typed.value) || (typed.number && typed.value !== 0)) return 'unresolved';
  // A math function clamps to the range (CSS Values 4 §10.12).
  return Math.max(0, typed.value);
}

/**
 * The ending shape's radii (CSS Images 3 §3.2.2) for a centre `ox, oy` into a
 * `width` by `height` box, from the shape and size tokens; null when invalid.
 * A length with no basis here keeps its shape at the default extent.
 */
function radialRadii(tokens: string[], ox: number, oy: number, width: number, height: number): [number, number] | null {
  let shape: string | null = null, extent: string | null = null;
  const lengths: string[] = [];
  let lengthsEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === 'circle' || t === 'ellipse') {
      if (shape) return null;
      shape = t;
    } else if (EXTENTS.has(t)) {
      if (extent) return null;
      extent = t;
    } else {
      // The lengths are one run of tokens.
      if (lengths.length && lengthsEnd !== i - 1) return null;
      lengths.push(tokens[i]);
      lengthsEnd = i;
    }
  }
  if ((extent && lengths.length) || lengths.length > 2) return null;
  const circle = shape ? shape === 'circle' : lengths.length === 1;
  if (lengths.length && lengths.length !== (circle ? 1 : 2)) return null;
  if (lengths.length) {
    const sizes = circle ? [radialLength(lengths[0], NaN)] : [radialLength(lengths[0], width), radialLength(lengths[1], height)];
    if (sizes.includes(null)) return null;
    if (!sizes.includes('unresolved')) {
      const [rx, ry = rx] = sizes as number[];
      return [rx, ry];
    }
  }
  const h = [Math.abs(ox), Math.abs(width - ox)], v = [Math.abs(oy), Math.abs(height - oy)];
  const closest = extent === 'closest-side' || extent === 'closest-corner';
  const sx = closest ? Math.min(...h) : Math.max(...h), sy = closest ? Math.min(...v) : Math.max(...v);
  const corner = extent === null || extent.endsWith('corner');
  if (circle) {
    const r = corner ? Math.hypot(sx, sy) : closest ? Math.min(sx, sy) : Math.max(sx, sy);
    return [r, r];
  }
  // An ellipse through the corner keeps the aspect ratio of its sides: √2 times them.
  return corner ? [sx * Math.SQRT2, sy * Math.SQRT2] : [sx, sy];
}

/** `tokens` without its `in <colorspace> [<hue> hue]`, which may lead or trail the rest. */
function withoutInterpolation(tokens: string[]): string[] {
  const at = tokens.findIndex((t) => t.toLowerCase() === 'in');
  if (at === -1) return tokens;
  const hue = HUE_METHODS.has(tokens[at + 2]?.toLowerCase()) && tokens[at + 3]?.toLowerCase() === 'hue';
  return [...tokens.slice(0, at), ...tokens.slice(at + (hue ? 4 : 2))];
}

/**
 * A CSS (repeating-)radial-gradient over the box (CSS Images 3 §3.2): its
 * ending shape, a circle or an ellipse sized by its extent keyword
 * (`farthest-corner` by default) or its lengths, centred at its `at` position
 * (`%` of the box, `px` from its corner, keywords; the centre when absent).
 * Null when it is invalid or no stop paints.
 */
export function radialGradientGeometry(
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): RadialGradientGeometry | null {
  const args = gradientArguments(bgImage, RADIAL_FUNCTION);
  if (!args) return null;
  const { parts } = args;
  const config = isRadialConfig(parts[0]) ? withoutInterpolation(splitTopLevelWhitespace(parts[0])) : null;
  let position: string[] = [], size: string[] = config ?? [];
  if (config) {
    const at = config.findIndex((t) => t.toLowerCase() === 'at');
    if (at !== -1) [size, position] = [config.slice(0, at), config.slice(at + 1)];
  }
  const [ox, oy] = position.length ? radialCenter(position, width, height) : [width / 2, height / 2];
  const radii = radialRadii(size, ox, oy, width, height);
  if (!radii) return null;
  const [rx, ry] = radii;
  const entries = parts.slice(config ? 1 : 0);
  const box = { x, y, width, height };
  if (!(rx > 0 && ry > 0)) {
    // A zero-size shape is one colour, as Chrome paints it: the last stop, or for a
    // repeating one whose percentages collapse onto the zero ray, the average.
    const lengths = { px: false };
    const flat = colorStops(entries, 1, false, 1, lengths);
    if (!flat) return null;
    const color = (args.repeating && !lengths.px ? averageColor(flat) : null) ?? flat[flat.length - 1][0];
    return { cx: x + ox, cy: y + oy, rx, ry, stops: [[color, 0]], box };
  }
  // A repeating gradient tiles out to the farthest corner, in radii.
  const reach = Math.hypot(Math.max(Math.abs(ox), Math.abs(width - ox)) / rx, Math.max(Math.abs(oy), Math.abs(height - oy)) / ry);
  const stops = colorStops(entries, rx, args.repeating, Math.max(1, reach));
  if (!stops) return null;
  return { cx: x + ox, cy: y + oy, rx, ry, stops: stopsFromCentre(stops), box };
}

/**
 * Stops before the centre cut at it: a canvas ray starts at the centre, so
 * the colour CSS shows there is interpolated between the stops either side
 * (`red -100%, blue 100%` opens half way). A colour this cannot mix keeps
 * its stop, which the canvas clamps to the centre.
 */
function stopsFromCentre(stops: [string, number][]): [string, number][] {
  const i = stops.findIndex(([, offset]) => offset >= 0);
  if (i === 0) return stops;
  if (i === -1) return [[stops[stops.length - 1][0], 0]];
  const [before, from] = stops[i - 1], [after, to] = stops[i];
  const color = to === 0 ? after : mixColors(before, after, -from / (to - from));
  return color === null ? stops : [[color, 0], ...stops.slice(i)];
}

/**
 * `a` and `b` mixed at `t` in premultiplied sRGB, as CSS interpolates legacy
 * colours; null when either is another kind. A missing (`none`) component
 * takes the other colour's (CSS Color 4 §12.2).
 */
function mixColors(a: string, b: string, t: number): string | null {
  const from = srgba(a), to = srgba(b);
  if (!from || !to) return null;
  const carry = (x: typeof from, y: typeof from) => x.rgba.map((v, k) => (x.missing[k] ? y.rgba[k] : v));
  const p = carry(from, to), q = carry(to, from);
  const alpha = p[3] + (q[3] - p[3]) * t;
  if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
  const channel = (k: number) =>
    Math.round(Math.min(255, Math.max(0, (p[k] * p[3] + (q[k] * q[3] - p[k] * p[3]) * t) / alpha)));
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${+alpha.toFixed(4)})`;
}

/**
 * The average colour of stops spread over one period, mixed premultiplied as
 * CSS interpolates (CSS Images 3 §3.5); null when the period is empty or a
 * colour is another kind.
 */
function averageColor(stops: [string, number][]): string | null {
  const first = stops[0][1], span = stops[stops.length - 1][1] - first;
  if (!(span > 0)) return null;
  const colors = stops.map(([color]) => srgba(color));
  if (colors.some((c) => c === null)) return null;
  const premultiplied = colors.map((c) => { const [r, g, b, a] = c!.rgba; return [r * a, g * a, b * a, a]; });
  const sum = [0, 0, 0, 0];
  for (let i = 1; i < stops.length; i++) {
    const weight = (stops[i][1] - stops[i - 1][1]) / span / 2;
    for (let k = 0; k < 4; k++) sum[k] += weight * (premultiplied[i - 1][k] + premultiplied[i][k]);
  }
  const alpha = sum[3];
  if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
  const channel = (k: number) => Math.round(Math.min(255, Math.max(0, sum[k] / alpha)));
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${+alpha.toFixed(4)})`;
}

/** What a colour channel's math function resolves against: no font, no viewport. */
const CHANNEL_BASIS = { em: NaN, rem: NaN, viewport: null, fontStyle: null, measure: undefined };

/**
 * One colour channel: a number, or a percentage of `percentOf`, either one
 * possibly a math function (`calc(255 / 2)`); NaN for anything else.
 */
function channelValue(t: string, percentOf: number): number {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%?)$/.exec(t);
  if (m) return parseFloat(m[1]) * (m[2] ? percentOf / 100 : 1);
  if (!MATH_FUNCTION.test(t)) return NaN;
  const typed = resolveNumberOrLength(t, { ...CHANNEL_BASIS, percent: percentOf });
  if (!typed) return NaN;
  if (typed.number) return typed.value;
  // A percentage, not a length: it has no value once `%` has none.
  return resolveNumberOrLength(t, { ...CHANNEL_BASIS, percent: NaN }) ? NaN : typed.value;
}

/**
 * A hex, named, `transparent`, rgb() or hsl() colour as [r, g, b] 0–255 and
 * alpha 0–1, with which of them are missing (`none`); null for any other.
 * Only rgb()'s channels and alpha carry over when missing; an hsl() `none`
 * is 0, its channels being none of sRGB's.
 */
function srgba(color: string): { rgba: number[]; missing: boolean[] } | null {
  const c = color.trim().toLowerCase();
  if (c === 'transparent') return { rgba: [0, 0, 0, 0], missing: [false, false, false, false] };
  let hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(c)?.[1] ?? namedColorHex(c);
  if (hex) {
    if (hex.length <= 4) hex = [...hex].map((h) => h + h).join('');
    const n = (k: number) => parseInt(hex!.slice(2 * k, 2 * k + 2), 16);
    return { rgba: [n(0), n(1), n(2), hex.length === 8 ? n(3) / 255 : 1], missing: [false, false, false, false] };
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(c);
  if (!fn) return null;
  let channels: string[], alpha: string | undefined;
  if (splitTopLevel(fn[2], ',').length > 1) {
    [channels, alpha] = [splitTopLevel(fn[2], ',').map((t) => t.trim()), undefined];
    if (channels.length === 4) alpha = channels.pop();
  } else {
    const [main, slash, ...rest] = splitTopLevel(fn[2], '/');
    if (rest.length) return null;
    [channels, alpha] = [splitTopLevelWhitespace(main.trim()), slash?.trim()];
  }
  if (channels.length !== 3) return null;
  const isRgb = fn[1][0] === 'r';
  const missing = [...channels.map((t) => isRgb && t === 'none'), alpha === 'none'];
  const number = (t: string, percentOf: number) => (t === 'none' ? 0 : channelValue(t, percentOf));
  const a = alpha === undefined ? 1 : Math.min(1, Math.max(0, number(alpha, 1)));
  let rgb: number[];
  if (isRgb) {
    rgb = channels.map((t) => number(t, 255));
  } else {
    const hue = /^([-+]?[\d.]+(?:e[-+]?\d+)?)(deg|grad|rad|turn)?$/.exec(channels[0]);
    const h = channels[0] === 'none' ? 0 : hue ? parseFloat(hue[1]) * DEGREES_PER[hue[2] ?? 'deg'] : channelValue(channels[0], NaN);
    const s = Math.min(1, Math.max(0, number(channels[1], 100) / 100));
    const l = Math.min(1, Math.max(0, number(channels[2], 100) / 100));
    // CSS Color 4 §7.1 hslToRgb.
    const f = (n: number) => {
      const k = ((n + h / 30) % 12 + 12) % 12, chroma = s * Math.min(l, 1 - l);
      return 255 * (l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    rgb = [f(0), f(8), f(4)];
  }
  if (![...rgb, a].every(Number.isFinite)) return null;
  return { rgba: [...rgb.map((v) => Math.min(255, Math.max(0, v))), a], missing };
}

/** A 2D affine map, as `DOMMatrix2DInit` fills it. */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** What a raster ctx lends an elliptical gradient's pattern. */
export interface RadialRaster {
  /** Device pixels per layout pixel. */
  scale: number;
  /** A scratch canvas, or null when there is none. */
  canvas(width: number, height: number): AnyCanvas | null;
  /** The pattern images built so far, by geometry. */
  images?: Map<RadialGradientGeometry, { canvas: AnyCanvas; scale: number; x: number; y: number }>;
}

/** The pattern image's longest side: a huge box is sampled coarser. */
const MAX_PATTERN_SIDE = 4096;

/**
 * A radial gradient's stops as a canvas circle of radius `r` at (cx, cy).
 * Stops past the shape widen the circle; one still before the centre
 * (`stopsFromCentre` could not mix it) clamps to it.
 */
function circleGradient(
  ctx: CanvasRenderingContext2D, stops: [string, number][], cx: number, cy: number, r: number,
): CanvasGradient {
  const last = Math.max(1, stops[stops.length - 1][1]);
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * last);
  for (const [color, offset] of stops) {
    try {
      gradient.addColorStop(Math.min(1, Math.max(0, offset / last)), color);
    } catch {
      // Invalid color: keep the paintable stops.
    }
  }
  return gradient;
}

/** Whether `ctx` is its canvas's own 2D context: a raster canvas, not a proxy. */
function isRasterContext(ctx: CanvasRenderingContext2D): boolean {
  const canvas = ctx.canvas as { getContext?: (id: '2d') => unknown } | undefined;
  return typeof canvas?.getContext === 'function' && canvas.getContext('2d') === ctx;
}

/**
 * The ellipse painted into a scratch canvas over its box, plus half the
 * box's height around it for glyph overhang, as a pattern placed by `frame`.
 */
function ellipsePattern(
  ctx: CanvasRenderingContext2D, g: RadialGradientGeometry, frame: Affine, raster: RadialRaster,
): CanvasPattern | null {
  if (typeof ctx.createPattern !== 'function') return null;
  let image = raster.images?.get(g);
  if (!image) {
    const margin = g.box.height / 2;
    const x = g.box.x - margin, y = g.box.y - margin;
    const width = g.box.width + 2 * margin, height = g.box.height + 2 * margin;
    const scale = Math.min(raster.scale, MAX_PATTERN_SIDE / width, MAX_PATTERN_SIDE / height);
    if (!(scale > 0)) return null;
    const canvas = raster.canvas(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
    const target = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
    if (!canvas || !target) return null;
    const k = g.ry / g.rx;
    target.setTransform(scale, 0, 0, scale * k, (g.cx - x) * scale, (g.cy - y) * scale);
    target.fillStyle = circleGradient(target, g.stops, 0, 0, g.rx);
    target.fillRect(x - g.cx, (y - g.cy) / k, width, height / k);
    image = { canvas, scale, x, y };
    raster.images?.set(g, image);
  }
  const pattern = ctx.createPattern(image.canvas as CanvasImageSource, 'no-repeat');
  if (!pattern || typeof pattern.setTransform !== 'function') return null;
  const s = 1 / image.scale;
  pattern.setTransform(multiply(frame, { a: s, b: 0, c: 0, d: s, e: image.x, f: image.y }));
  return pattern;
}

/**
 * The paint for a radial gradient, `frame` mapping its box's space into the
 * ctx's (a glyph's frame on a path). A circle is a canvas radial gradient. An
 * ellipse is one at the origin placed by its own `setTransform` where the
 * ctx's gradients have one (a vector adapter: SVG `gradientTransform`, a PDF
 * pattern matrix), a pattern on a raster ctx given `raster`, else the circle
 * of its horizontal radius. A zero-size shape paints its one colour.
 */
export function radialPaint(
  ctx: CanvasRenderingContext2D, g: RadialGradientGeometry, frame: Affine = IDENTITY, raster?: RadialRaster,
): GradientPaint {
  const { stops, rx, ry } = g;
  if (!(rx > 0 && ry > 0)) return stops[stops.length - 1][0];
  const cx = frame.a * g.cx + frame.c * g.cy + frame.e, cy = frame.b * g.cx + frame.d * g.cy + frame.f;
  if (rx === ry) return circleGradient(ctx, stops, cx, cy, rx);
  const gradient = circleGradient(ctx, stops, 0, 0, rx);
  const placed = gradient as CanvasGradient & { setTransform?: (m: Affine) => void };
  if (typeof placed.setTransform === 'function') {
    placed.setTransform(multiply(frame, { a: 1, b: 0, c: 0, d: ry / rx, e: g.cx, f: g.cy }));
    return gradient;
  }
  const pattern = raster && isRasterContext(ctx) ? ellipsePattern(ctx, g, frame, raster) : null;
  return pattern ?? circleGradient(ctx, stops, cx, cy, rx);
}

/** A CSS (repeating-)radial-gradient as a paint over the box (`radialGradientGeometry`, `radialPaint`). */
export function parseRadialGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
  raster?: RadialRaster,
): GradientPaint | null {
  const geometry = radialGradientGeometry(bgImage, x, width, y, height);
  return geometry && radialPaint(ctx, geometry, undefined, raster);
}

/** Unrolled-stop cap: a sub-pixel period would need a stop per pixel. */
const MAX_REPEATED_STOPS = 4096;

/** Stops tiled over [0, end], or null when the period is too small. A zero
 * period paints the last stop's color (CSS Images 3 §3.5). */
function repeatStops(stops: [string, number][], end: number): [string, number][] | null {
  const start = stops[0][1], period = stops[stops.length - 1][1] - start;
  if (!(period > 0)) {
    const color = stops[stops.length - 1][0];
    return [[color, 0], [color, 1]];
  }
  const from = Math.floor(-start / period), to = Math.ceil((end - start) / period);
  if ((to - from) * stops.length > MAX_REPEATED_STOPS) return null;
  const tiled: [string, number][] = [];
  let previous = -Infinity;
  for (let k = from; k < to; k++) {
    // Monotonic, or rounding inverts a tile seam.
    for (const [color, offset] of stops) tiled.push([color, previous = Math.max(previous, offset + k * period)]);
  }
  return tiled;
}
