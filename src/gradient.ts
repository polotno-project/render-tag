import { HUE_METHODS, MATH, isColor, namedColorHex, splitTopLevel, splitTopLevelWhitespace } from './css-validate.js';
import { memoized, nullProto, numberThen, resolveNumberOrLength } from './css-values.js';
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

/** A layer that is a gradient call; a prefixed linear one is read by the standard grammar. */
const GRADIENT_CALL = /^(?:(?:-\w+-)?(repeating-)?(linear)|(repeating-)?(radial))-gradient\(/i;

interface GradientCall {
  kind: 'linear' | 'radial';
  repeating: boolean;
  /** Its comma-separated arguments. */
  parts: string[];
}

/** The topmost layer of `bgImage` that is a gradient call: CSS paints the first layer over the rest. */
const gradientCall = memoized((bgImage: string): GradientCall | null => {
  for (const layer of splitTopLevel(bgImage, ',')) {
    const call = layer.trim();
    const m = GRADIENT_CALL.exec(call);
    if (!m) continue;
    let depth = 0, end = -1;
    for (let i = m[0].length; i < call.length && end === -1; i++) {
      if (call[i] === '(') depth++;
      else if (call[i] === ')' && depth-- === 0) end = i;
    }
    if (end === -1) return null;
    const parts = splitTopLevel(call.slice(m[0].length, end), ',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return { kind: m[2] ? 'linear' : 'radial', repeating: (m[1] ?? m[3]) !== undefined, parts };
  }
  return null;
});

/** The gradient `bgImage` paints. */
export function gradientKind(bgImage: string): 'linear' | 'radial' | null {
  return gradientCall(bgImage)?.kind ?? null;
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
      const position = stopPosition(tokens[tokens.length - 1], length, lengths);
      if (position === null) break;
      positions.unshift(position);
      tokens.pop();
    }
    // A color hint.
    if (tokens.length === 1 && stopPosition(tokens[0], length) !== null) continue;
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

/** A stop's position as a fraction of a ray `length` px long; null when `token` is not one. */
function stopPosition(token: string, length: number, lengths?: { px: boolean }): number | null {
  const m = STOP_LENGTH.exec(token);
  if (m && !m[2] && parseFloat(m[1]) !== 0) return null;
  if (m?.[2] === '%') return parseFloat(m[1]) / 100;
  const px = m ? parseFloat(m[1]) : lengthPercentage(token, length);
  if (px === null) return null;
  if (lengths && px !== 0) lengths.px = true;
  return length > 0 ? px / length : 0;
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
  const args = gradientCall(bgImage);
  if (args?.kind !== 'linear') return null;
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

const LENGTH_TOKEN = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z%]*)$/i;
/** What a length here resolves against: its font and viewport units are px already (`gradientLengthsInPx`). */
const NO_FONT = { em: NaN, rem: NaN, viewport: null, fontStyle: null, measure: undefined };

/**
 * A `<length-percentage>` in px: `percentOf` is what a percentage reads
 * against (NaN where it takes none); null when invalid.
 */
function lengthPercentage(token: string, percentOf: number): number | null {
  const plain = LENGTH_TOKEN.exec(token);
  if (plain) {
    if (!plain[2]) return parseFloat(plain[1]) === 0 ? 0 : null;
    if (plain[2] === '%' && Number.isNaN(percentOf)) return null;
  } else if (!MATH.test(token)) {
    return null;
  }
  const typed = resolveNumberOrLength(token, { ...NO_FONT, percent: percentOf });
  return !typed || !Number.isFinite(typed.value) || (typed.number && typed.value !== 0) ? null : typed.value;
}

const HORIZONTAL: Record<string, number> = nullProto({ left: 0, center: 0.5, right: 1 });
const VERTICAL: Record<string, number> = nullProto({ top: 0, center: 0.5, bottom: 1 });

/**
 * The centre for `at <position>` (CSS Values 4 §9): one or two components,
 * or two edges each with an offset. Null when invalid.
 */
function radialCenter(tokens: string[], width: number, height: number): [number, number] | null {
  let t = tokens.map((token) => token.toLowerCase());
  /** A keyword of `words` or a length, along a side. */
  const along = (token: string, side: number, words: Record<string, number>) =>
    token in words ? words[token] * side : lengthPercentage(token, side);
  let x: number | null = null, y: number | null = null;
  if (t.length === 1) {
    [x, y] = t[0] in VERTICAL && t[0] !== 'center' ? [width / 2, along(t[0], height, VERTICAL)] : [along(t[0], width, HORIZONTAL), height / 2];
  } else if (t.length === 2) {
    // Two keywords come in either order; a length fixes it.
    const vertical = (token: string) => token === 'top' || token === 'bottom';
    const horizontal = (token: string) => token === 'left' || token === 'right';
    if ((vertical(t[0]) && t[1] in HORIZONTAL) || (horizontal(t[1]) && t[0] in VERTICAL)) t = [t[1], t[0]];
    [x, y] = [along(t[0], width, HORIZONTAL), along(t[1], height, VERTICAL)];
  } else if (t.length === 4) {
    if (t[0] in VERTICAL) t = [t[2], t[3], t[0], t[1]];
    const from = (edge: string, offset: string, side: number, words: Record<string, number>) => {
      const length = edge in words && edge !== 'center' ? lengthPercentage(offset, side) : null;
      return length === null ? null : words[edge] ? side - length : length;
    };
    [x, y] = [from(t[0], t[1], width, HORIZONTAL), from(t[2], t[3], height, VERTICAL)];
  }
  return x === null || y === null ? null : [x, y];
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

/** One `<radial-size>` length (`lengthPercentage`), which is never negative. */
function radialLength(token: string, percentOf: number): number | null {
  const px = lengthPercentage(token, percentOf);
  if (px === null || px >= 0) return px;
  // A math function clamps to the range (CSS Values 4 §10.12).
  return MATH.test(token) ? 0 : null;
}

/**
 * The ending shape's radii (CSS Images 3 §3.2.2) for a centre `ox, oy` into a
 * `width` by `height` box, from the shape and size tokens; null when invalid.
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
    const [rx, ry = rx] = sizes as number[];
    return [rx, ry];
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
  const args = gradientCall(bgImage);
  if (args?.kind !== 'radial') return null;
  const { parts } = args;
  // The first argument is the configuration unless it starts with a color.
  const first = splitTopLevelWhitespace(parts[0]);
  const config = isColor(first[0]) ? null : withoutInterpolation(first);
  let size: string[] = config ?? [], center: [number, number] | null = [width / 2, height / 2];
  const at = size.findIndex((t) => t.toLowerCase() === 'at');
  if (at !== -1) {
    center = radialCenter(size.slice(at + 1), width, height);
    size = size.slice(0, at);
  }
  if (!center) return null;
  const [ox, oy] = center;
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

/**
 * One colour channel: a number, or a percentage of `percentOf`, either one
 * possibly a math function (`calc(255 / 2)`); NaN for anything else.
 */
function channelValue(t: string, percentOf: number): number {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%?)$/.exec(t);
  if (m) return parseFloat(m[1]) * (m[2] ? percentOf / 100 : 1);
  if (!MATH.test(t)) return NaN;
  const typed = resolveNumberOrLength(t, { ...NO_FONT, percent: percentOf });
  if (!typed) return NaN;
  if (typed.number) return typed.value;
  // A percentage, not a length: it has no value once `%` has none.
  return resolveNumberOrLength(t, { ...NO_FONT, percent: NaN }) ? NaN : typed.value;
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
  /** Device pixels per layout pixel, read when an image is built. */
  scale(): number;
  /** A scratch canvas, or null when there is none. */
  canvas(width: number, height: number): AnyCanvas | null;
  /** The pattern images built so far, by geometry; null where none could be. */
  images: Map<RadialGradientGeometry, { canvas: AnyCanvas; place: Affine } | null>;
}

/** The pattern image's longest side: a huge box is sampled coarser. */
const MAX_PATTERN_SIDE = 4096;
/** Layout px the image reaches past the box for glyph overhang and stroke; ink further out is not painted. */
const PATTERN_OVERHANG = 128;

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
export function isRasterContext(ctx: CanvasRenderingContext2D): boolean {
  const canvas = ctx.canvas as { getContext?: (id: '2d') => unknown } | undefined;
  return typeof canvas?.getContext === 'function' && canvas.getContext('2d') === ctx;
}

/** The ellipse painted once into a scratch canvas, over its box and the overhang around it. */
function ellipseImage(g: RadialGradientGeometry, raster: RadialRaster): { canvas: AnyCanvas; place: Affine } | null {
  const margin = Math.min(g.box.height / 2, PATTERN_OVERHANG);
  const x = g.box.x - margin, y = g.box.y - margin;
  const width = g.box.width + 2 * margin, height = g.box.height + 2 * margin;
  const scale = Math.min(raster.scale(), MAX_PATTERN_SIDE / width, MAX_PATTERN_SIDE / height);
  if (!(scale > 0)) return null;
  const canvas = raster.canvas(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
  const target = canvas?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !target) return null;
  const k = g.ry / g.rx;
  target.setTransform(scale, 0, 0, scale * k, (g.cx - x) * scale, (g.cy - y) * scale);
  target.fillStyle = circleGradient(target, g.stops, 0, 0, g.rx);
  target.fillRect(x - g.cx, (y - g.cy) / k, width, height / k);
  return { canvas, place: { a: 1 / scale, b: 0, c: 0, d: 1 / scale, e: x, f: y } };
}

/** The ellipse as a pattern of its image, placed by `frame`; null where the ctx or its canvases make none. */
function ellipsePattern(
  ctx: CanvasRenderingContext2D, g: RadialGradientGeometry, frame: Affine, raster: RadialRaster,
): CanvasPattern | null {
  if (typeof ctx.createPattern !== 'function') return null;
  let image = raster.images.get(g);
  if (image === undefined) raster.images.set(g, image = ellipseImage(g, raster));
  const pattern = image && ctx.createPattern(image.canvas as CanvasImageSource, 'no-repeat');
  if (!pattern || typeof pattern.setTransform !== 'function') return null;
  pattern.setTransform(multiply(frame, image!.place));
  return pattern;
}

/**
 * The paint for a radial gradient, `frame` mapping its box's space into the
 * ctx's (a glyph's frame on a path). A circle is a canvas radial gradient. An
 * ellipse is a pattern on a raster ctx (`raster`); elsewhere the circle of its
 * horizontal radius at its centre, handed the map onto the ellipse through
 * `setTransform` where the ctx's gradients have one (a vector adapter: SVG
 * `gradientTransform`, a PDF pattern matrix). A zero-size shape paints its
 * one colour, and a ctx with no `createRadialGradient` the first stop's.
 */
export function radialPaint(
  ctx: CanvasRenderingContext2D, g: RadialGradientGeometry, frame: Affine = IDENTITY, raster?: RadialRaster,
): GradientPaint {
  const { stops, rx, ry } = g;
  if (!(rx > 0 && ry > 0)) return stops[stops.length - 1][0];
  // An adapter written before radial gradients: its first colour, not a throw.
  if (typeof ctx.createRadialGradient !== 'function') return stops[0][0];
  const pattern = rx !== ry && raster ? ellipsePattern(ctx, g, frame, raster) : null;
  if (pattern) return pattern;
  const cx = frame.a * g.cx + frame.c * g.cy + frame.e, cy = frame.b * g.cx + frame.d * g.cy + frame.f;
  const gradient = circleGradient(ctx, stops, cx, cy, rx) as CanvasGradient & { setTransform?: (m: Affine) => void };
  if (rx !== ry && typeof gradient.setTransform === 'function') {
    const squash = multiply(frame, { a: 1, b: 0, c: 0, d: ry / rx, e: g.cx, f: g.cy });
    gradient.setTransform(multiply(squash, { ...IDENTITY, e: -cx, f: -cy }));
  }
  return gradient;
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
