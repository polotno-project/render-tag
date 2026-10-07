// ─── CSS linear-gradient → CanvasGradient ────────────────────────────────

/** Split on commas (or whitespace) that are not inside parentheses. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && separator.test(ch)) {
      if (i > start) parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.length > start) parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const ANGLE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)$/i;
const DEGREES_PER: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const STOP_LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|px)?$/i;

/**
 * The CSS angle of a `linear-gradient` direction, or null when `part` is not
 * one (it is then the first color stop). A corner keyword depends on the
 * box: the gradient line is perpendicular to the diagonal joining the two
 * NEIGHBOURING corners (CSS Images 3, §3.1.1), so `to top right` on a
 * 200×100 box is 26.57deg, not 45deg.
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

/**
 * Parse a CSS linear-gradient into a canvas CanvasGradient spanning the box
 * (x, y, width, height), the gradient's painting area.
 *
 * Color stops follow CSS Images 3 §3.4.3: a stop with no position sits
 * evenly between its positioned neighbours (the first defaults to 0%, the
 * last to 100%); a position before an earlier one is raised to it; a stop
 * with two positions is two stops. Positions are % or px of the gradient
 * line. Canvas only takes offsets in [0, 1], so stops outside 0-100% stretch
 * the canvas gradient line over their whole range instead of being dropped
 * (the canvas pads past either end exactly like CSS does). A color hint is
 * IGNORED: the transition stays linear between its neighbouring stops, with
 * its midpoint halfway, wherever the hint puts it (canvas cannot reproduce
 * the hint's curve without parsing colors to mix them).
 *
 * `repeating-linear-gradient` tiles its stop list along the gradient line,
 * one period = last position - first position, unrolled into plain stops
 * over the painted span (CSS Images 3 §3.5).
 */
export function parseLinearGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): CanvasGradient | null {
  // Extract content inside linear-gradient(...) handling nested parens
  const startIdx = bgImage.indexOf('linear-gradient(');
  if (startIdx === -1) return null;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx + 16; i < bgImage.length; i++) {
    if (bgImage[i] === '(') depth++;
    else if (bgImage[i] === ')') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx === -1) return null;
  const repeating = bgImage.slice(Math.max(0, startIdx - 10), startIdx) === 'repeating-';
  const parts = splitTopLevel(bgImage.slice(startIdx + 16, endIdx), /,/);
  if (parts.length === 0) return null;

  const direction = gradientAngle(parts[0], width, height);
  const angle = direction ?? 180; // default: to bottom
  const rad = angle * Math.PI / 180;
  const dirX = Math.sin(rad), dirY = -Math.cos(rad);
  const length = Math.abs(width * dirX) + Math.abs(height * dirY);

  // Stops as [color, offset | null], offsets as fractions of the line.
  const stops: [string, number | null][] = [];
  for (const entry of parts.slice(direction === null ? 0 : 1)) {
    const tokens = splitTopLevel(entry, /\s/);
    const positions: number[] = [];
    // Trailing lengths are positions (a unitless one only as `0`).
    while (tokens.length > 1) {
      const m = STOP_LENGTH.exec(tokens[tokens.length - 1]);
      if (!m || (!m[2] && parseFloat(m[1]) !== 0)) break;
      const value = parseFloat(m[1]);
      positions.unshift(m[2] === '%' ? value / 100 : length > 0 ? value / length : 0);
      tokens.pop();
    }
    // A lone length is a color hint: ignored (see above).
    if (tokens.length === 1 && STOP_LENGTH.test(tokens[0])) continue;
    if (tokens.length === 0 || positions.length > 2) continue;
    const color = tokens.join(' ');
    if (positions.length === 0) stops.push([color, null]);
    for (const position of positions) stops.push([color, position]);
  }
  if (stops.length === 0) return null;

  // Fix up the positions: first/last default, monotonic, then even spacing.
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

  if (repeating) {
    const tiled = repeatStops(stops as [string, number][]);
    if (!tiled) return null;
    stops.splice(0, stops.length, ...tiled);
  }

  // Canvas offsets must lie in [0, 1]: map [first, last] onto the canvas line.
  const first = Math.min(0, stops[0][1]!);
  const last = Math.max(1, stops[stops.length - 1][1]!);
  const span = last - first;
  const x0 = x + width / 2 - dirX * length / 2;
  const y0 = y + height / 2 - dirY * length / 2;
  const gradient = ctx.createLinearGradient(
    x0 + dirX * length * first, y0 + dirY * length * first,
    x0 + dirX * length * last, y0 + dirY * length * last,
  );
  for (const [color, offset] of stops) {
    try {
      gradient.addColorStop(Math.min(1, Math.max(0, (offset! - first) / span)), color);
    } catch {
      // An invalid color: the browser drops the whole declaration; we keep
      // the stops we can paint.
    }
  }
  return gradient;
}

/** At most this many stops after unrolling: a sub-pixel period would
 * otherwise ask for one stop per pixel of a long line, and the browser
 * paints such a gradient as its average color anyway. */
const MAX_REPEATED_STOPS = 4096;

/**
 * A repeating gradient's stops tiled over the gradient line [0, 1], or null
 * when the period is too small to unroll. A zero period paints the last
 * stop's color everywhere (CSS Images 3 §3.5: the average color, which for
 * coincident stops is the last one painted).
 */
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
    // Monotonic: a tile's first stop must not round below the previous
    // tile's last, or the canvas sorts it in front and the seam inverts.
    for (const [color, offset] of stops) tiled.push([color, previous = Math.max(previous, offset + k * period)]);
  }
  return tiled;
}
