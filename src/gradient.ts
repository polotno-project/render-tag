import { splitTopLevel, splitTopLevelWhitespace } from './css-validate.js';
import { numberThen } from './css-values.js';

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

/** The gradient `bgImage` paints: a linear one wherever it appears, else a radial one. */
export function gradientKind(bgImage: string): 'linear' | 'radial' | null {
  return LINEAR_FUNCTION.test(bgImage) ? 'linear' : RADIAL_FUNCTION.test(bgImage) ? 'radial' : null;
}

/** A CSS linear or radial gradient as a CanvasGradient over the box. */
export function parseGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): CanvasGradient | null {
  return gradientKind(bgImage) === 'radial'
    ? parseRadialGradient(ctx, bgImage, x, width, y, height)
    : parseLinearGradient(ctx, bgImage, x, width, y, height);
}

/** The first `fn` call in `bgImage`: whether it repeats, and its comma-separated arguments. */
function gradientArguments(bgImage: string, fn: RegExp): { repeating: boolean; parts: string[] } | null {
  const m = fn.exec(bgImage);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < bgImage.length; i++) {
    if (bgImage[i] === '(') depth++;
    else if (bgImage[i] === ')') {
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
 * A color hint is ignored, and a repeating gradient is unrolled over [0, 1].
 */
function colorStops(entries: string[], length: number, repeating: boolean): [string, number][] | null {
  const stops: [string, number | null][] = [];
  for (const entry of entries) {
    const tokens = splitTopLevelWhitespace(entry);
    const positions: number[] = [];
    while (tokens.length > 1) {
      const m = STOP_LENGTH.exec(tokens[tokens.length - 1]);
      if (!m || (!m[2] && parseFloat(m[1]) !== 0)) break;
      const value = parseFloat(m[1]);
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

  return repeating ? repeatStops(stops as [string, number][]) : stops as [string, number][];
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
  /** The distance from the centre to the farthest box corner. */
  r: number;
  /** [color, offset], offsets as fractions of `r` (past 1 beyond the circle). */
  stops: [string, number][];
}

/**
 * A CSS (repeating-)radial-gradient over the box, read as Polotno draws it:
 * always a circle with CSS's default `farthest-corner` extent, centred at its
 * `at` position (`%` of the box, `px` from its corner, keywords; the centre
 * when absent). The shape and size are ignored, so `ellipse`, explicit sizes
 * and the other extent keywords paint that same circle.
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
  const config = RADIAL_CONFIG.test(parts[0]) ? splitTopLevelWhitespace(parts[0]) : null;
  let position: string[] = [];
  if (config) {
    const at = config.findIndex((t) => t.toLowerCase() === 'at');
    if (at !== -1) {
      const end = config.findIndex((t, i) => i > at && t.toLowerCase() === 'in');
      position = config.slice(at + 1, end === -1 ? undefined : end);
    }
  }
  const [ox, oy] = position.length ? radialCenter(position, width, height) : [width / 2, height / 2];
  const r = Math.hypot(Math.max(ox, width - ox), Math.max(oy, height - oy));
  const stops = colorStops(parts.slice(config ? 1 : 0), r, args.repeating);
  if (!stops) return null;
  return { cx: x + ox, cy: y + oy, r, stops };
}

/**
 * A radial gradient's circle as a CanvasGradient centred at (cx, cy). Stops
 * past the circle widen the canvas circle; a stop before the centre clamps
 * to it (a canvas ray starts there).
 */
export function radialCanvasGradient(
  ctx: CanvasRenderingContext2D,
  { stops, r }: RadialGradientGeometry,
  cx: number,
  cy: number,
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

/** A CSS (repeating-)radial-gradient as a CanvasGradient over the box (`radialGradientGeometry`). */
export function parseRadialGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): CanvasGradient | null {
  const geometry = radialGradientGeometry(bgImage, x, width, y, height);
  return geometry && radialCanvasGradient(ctx, geometry, geometry.cx, geometry.cy);
}

/** Unrolled-stop cap: a sub-pixel period would need a stop per pixel. */
const MAX_REPEATED_STOPS = 4096;

/** Stops tiled over [0, 1], or null when the period is too small. A zero
 * period paints the last stop's color (CSS Images 3 §3.5). */
function repeatStops(stops: [string, number][]): [string, number][] | null {
  const start = stops[0][1], period = stops[stops.length - 1][1] - start;
  if (!(period > 0)) {
    const color = stops[stops.length - 1][0];
    return [[color, 0], [color, 1]];
  }
  const from = Math.floor(-start / period), to = Math.ceil((1 - start) / period);
  if ((to - from) * stops.length > MAX_REPEATED_STOPS) return null;
  const tiled: [string, number][] = [];
  let previous = -Infinity;
  for (let k = from; k < to; k++) {
    // Monotonic, or rounding inverts a tile seam.
    for (const [color, offset] of stops) tiled.push([color, previous = Math.max(previous, offset + k * period)]);
  }
  return tiled;
}
