import type { DecorationEntry } from './types.js';
import { BLINK_UNDERLINE_GAP, ENGINE } from './engine.js';
import type { PaintState } from './paint-state.js';

// Text decoration bands. The engine paints a decoration once per text fragment
// (one text node's pieces on one line): dashes fit and waves keep phase across
// its spaces, and restart at the next text node (decoration-shape-parity).

type DecorationLine = 'underline' | 'overline' | 'line-through';

/** One decoration band across one text fragment. */
export interface Band {
  line: DecorationLine;
  style: string;
  x: number;
  width: number;
  /** Top edge (Blink: unsnapped). */
  y: number;
  /** Painted thickness. */
  rows: number;
  /** Resolved float thickness. */
  thickness: number;
  fontSize: number;
  deviceScale: number;
}

const toDevice = (v: number, scale: number) => Math.floor(v * scale + 0.5) / scale;
const deviceCeil = (t: number, scale: number) => Math.max(1, Math.ceil(t * scale)) / scale;

/**
 * Band rows for a decoration entry: round(T) for an explicit thickness (0
 * hides the band), else Blink's auto max(1, floor(fontSize / 10)).
 */
export function bandWidthFor(deco: DecorationEntry): number {
  const t = deco.declarer.textDecorationThickness;
  if (t === null) return Math.max(1, Math.floor(deco.declarer.fontSize / 10));
  return t <= 0 ? 0 : Math.max(1, Math.round(t));
}

/**
 * Band-center delta below the baseline for an explicit underline offset or
 * thickness, else null. Chrome: an offset puts the band top at baseline +
 * offset; a thickness T alone puts it at baseline + ceil(T/2).
 */
export function explicitUnderlineDelta(
  deco: DecorationEntry,
  lineWidth: number,
): number | null {
  const offset = deco.declarer.textUnderlineOffset;
  if (offset !== null) return offset + lineWidth / 2;
  if (deco.declarer.textDecorationThickness !== null)
    return Math.ceil(lineWidth / 2) + lineWidth / 2;
  return null;
}

/**
 * [painted rows, resolved float], or null when a declared 0 hides the band.
 * Blink: auto fontSize / 10, painted floor; explicit T resolves to round(T).
 * WebKit: auto fontSize / 16; auto and explicit both paint ceil on the DEVICE
 * grid. Gecko: round(T) rows, the declared float. decoration-position-parity.
 */
function thicknessOf(deco: DecorationEntry, deviceScale: number): [rows: number, thickness: number] | null {
  const rows = bandWidthFor(deco);
  if (rows <= 0) return null;
  const declared = deco.declarer.textDecorationThickness;
  if (declared !== null) {
    if (ENGINE === 'blink') return [rows, rows];
    if (ENGINE === 'webkit') return [deviceCeil(declared, deviceScale), declared];
    return [rows, Math.max(1, declared)];
  }
  const size = deco.declarer.fontSize;
  if (ENGINE === 'webkit') return [deviceCeil(size / 16, deviceScale), size / 16];
  return [rows, Math.max(1, size / 10)];
}

/** Where a fragment's decorations hang: what `decorationBand` needs to know. */
interface FragmentLine {
  baseline: number;
  /** The line's own baseline when only the run was vertical-aligned. */
  underlineBaseline: number;
  fontSize: number;
  ascent: number;
  /** `paintLineSnap`. */
  snap: number;
}

/**
 * The band one entry draws over one fragment (null: nothing). Top edges:
 * - underline: Blink ceil(fontSize / 20) below the snapped baseline
 *   (SNAPS_LINE_PAINT, BLINK_UNDERLINE_GAP); WebKit max(1, ceil(fontSize / 32)) below its
 *   device-snapped baseline; explicit geometry via `explicitUnderlineDelta`.
 * - overline: Blink's bottom edge on the floored ascent row; WebKit's auto top.
 * - line-through: Blink `baseline - ascent / 3 - t / 2` (text_decoration_info.cc).
 *   WebKit reads a strikeout metric canvas cannot: 0.3025·ascent is a FIT.
 * Measured in decoration-position-parity; Gecko keeps older approximations.
 */
export function decorationBand(
  deco: DecorationEntry, at: FragmentLine, x: number, width: number, deviceScale = 1,
): Band | null {
  const thickness = thicknessOf(deco, deviceScale);
  if (!thickness || width <= 0) return null;
  const [rows, t] = thickness;
  const line = deco.line as DecorationLine;
  const style = deco.style || 'solid';
  const fontSize = deco.declarer.fontSize;
  const engine = ENGINE;
  let y: number;
  if (line === 'underline') {
    // WebKit keeps its auto position under an explicit thickness.
    const explicit = engine === 'webkit' && deco.declarer.textUnderlineOffset === null
      ? null : explicitUnderlineDelta(deco, rows);
    if (explicit !== null) y = Math.round(at.underlineBaseline + explicit - rows / 2);
    else if (engine === 'webkit') {
      y = toDevice(at.underlineBaseline, deviceScale) + Math.max(1, Math.ceil(fontSize / 16 / 2));
    }
    else if (BLINK_UNDERLINE_GAP) y = Math.round(at.underlineBaseline + Math.ceil(fontSize / 20));
    else y = Math.round(at.underlineBaseline + fontSize * 0.105 - 0.2 - rows / 2);
    // Blink places the underline before the line's paint snap (OffsetFromDecoratingBox).
    if (engine === 'blink') y -= at.snap;
  } else if (line === 'overline') {
    // WebKit: a declared thickness keeps the auto band's bottom edge.
    y = engine === 'webkit'
      ? toDevice(at.baseline, deviceScale) - Math.round(at.ascent) + deviceCeil(fontSize / 16, deviceScale) - rows
      : Math.floor(at.baseline - at.ascent) - rows;
  } else if (line === 'line-through') {
    y = engine === 'blink' ? at.baseline - at.ascent / 3 - t / 2
      : engine === 'webkit'
        ? Math.ceil((toDevice(at.baseline, deviceScale) - 0.3025 * at.ascent - t / 2) * deviceScale) / deviceScale
        : Math.round(at.baseline - at.fontSize * 0.33 - rows / 2);
  } else {
    return null;
  }
  return { line, style, x, width, y, rows, thickness: t, fontSize, deviceScale };
}

export const paintBand: (ps: PaintState, band: Band, color: string | CanvasGradient) => void =
  ENGINE === 'blink' ? blinkBand : ENGINE === 'webkit' ? webkitBand
    : (ps, b, c) => drawDecorationLine(ps, b.x, b.y + b.rows / 2, b.width, b.rows, b.style, c);

/** A horizontal stroke `rows` thick whose top edge is `top`. */
function rule(ps: PaintState, x0: number, x1: number, top: number, rows: number, color: string | CanvasGradient) {
  ps.stroke(color, rows);
  ps.ctx.beginPath();
  ps.ctx.moveTo(x0, top + rows / 2);
  ps.ctx.lineTo(x1, top + rows / 2);
  ps.ctx.stroke();
}

// ─── Blink ──────────────────────────────────────────────────────────────

/**
 * Blink's `SelectBestDashGap` (styled_stroke_data.cc): the gap closest to
 * `gap` that puts a whole dash at both ends of an open path.
 */
function bestDashGap(length: number, dash: number, gap: number): number {
  const minDashes = Math.floor((length + gap) / (dash + gap));
  const maxDashes = minDashes + 1;
  const minGap = (length - minDashes * dash) / (minDashes - 1);
  const maxGap = (length - maxDashes * dash) / (maxDashes - 1);
  return maxGap <= 0 || Math.abs(minGap - gap) < Math.abs(maxGap - gap) ? minGap : maxGap;
}

/**
 * Blink's dash for a `length`-px path, w = round(thickness) (decoration_line_painter.cc
 * `DashEffectFromStrokeStyle`); null is solid. dashed: 3w/2w below 3px, 2w/w
 * from 3px, gap fitted. dotted: square w/w up to 3px (unfitted), round above.
 */
function blinkDash(style: string, width: number, length: number): { dash: number[]; cap: CanvasLineCap } | null {
  if (style === 'dashed' || width <= 3) {
    let dash = width, gap = width;
    if (style === 'dashed') {
      dash *= width >= 3 ? 2 : 3;
      gap *= width >= 3 ? 1 : 2;
    }
    if (length <= dash * 2) return null;
    const pair = 2 * dash + gap;
    if (length <= pair) {
      const k = length / pair;
      return { dash: [dash * k, gap * k], cap: 'butt' };
    }
    return { dash: [dash, style === 'dashed' ? bestDashGap(length, dash, gap) : gap], cap: 'butt' };
  }
  const perDot = width * 2;
  if (length < perDot) return { dash: [0, perDot], cap: 'round' };
  // Blink's epsilon keeps the last dot from rounding off the end.
  return { dash: [0, bestDashGap(length, width, width) + width - 1e-2], cap: 'round' };
}

/** The parameter at which Blink's wave cubic (x: 0, λ/2, λ/2, λ) reaches `x`. */
function waveParameterAt(x: number, wavelength: number): number {
  if (x <= 0) return 0;
  if (x >= wavelength) return 1;
  // X(s) = λ(1.5 s(1 - s) + s³) is strictly increasing: bisect.
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const s = (lo + hi) / 2;
    if (wavelength * (1.5 * s * (1 - s) + s * s * s) < x) lo = s; else hi = s;
  }
  return (lo + hi) / 2;
}

type Point = [number, number];

/** The part of the cubic `p` between parameters s0 and s1 (de Casteljau). */
function subCubic(p: Point[], s0: number, s1: number): Point[] {
  const split = (q: Point[], s: number): [Point[], Point[]] => {
    const lerp = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
    const a = lerp(q[0], q[1]), b = lerp(q[1], q[2]), c = lerp(q[2], q[3]);
    const d = lerp(a, b), e = lerp(b, c), f = lerp(d, e);
    return [[q[0], a, d, f], [f, e, c, q[3]]];
  };
  let q = p;
  if (s1 < 1) q = split(q, s1)[0];
  if (s0 > 0) q = split(q, s0 / s1)[1];
  return q;
}

/**
 * Append a wave on `axis` over [x0, x1]: one cubic per `wavelength`, each
 * starting on the axis toward +`cp` (downward) at `anchor + k·wavelength` —
 * Blink's `WavyCenterlinePath`. The cycles cut by x0 and x1 are split there
 * (Blink clips its tile to the fragment), so no clip path is needed.
 */
function wavePath(
  ctx: CanvasRenderingContext2D, x0: number, x1: number, anchor: number,
  axis: number, wavelength: number, cp: number,
) {
  let start = anchor + Math.floor((x0 - anchor) / wavelength) * wavelength;
  let first = true;
  for (; start < x1 - 1e-9; start += wavelength) {
    const cycle: Point[] = [[start, axis], [start + wavelength / 2, axis + cp],
      [start + wavelength / 2, axis - cp], [start + wavelength, axis]];
    const s0 = waveParameterAt(x0 - start, wavelength);
    const s1 = waveParameterAt(x1 - start, wavelength);
    if (s1 <= s0) continue;
    const [p0, p1, p2, p3] = subCubic(cycle, s0, s1);
    if (first) { ctx.moveTo(p0[0], p0[1]); first = false; }
    ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  }
}

function blinkBand(ps: PaintState, band: Band, color: string | CanvasGradient) {
  const { ctx } = ps;
  const { line, style, x, width, y, rows, thickness: t } = band;
  // Solid and double bands are rects snapped on y only (`SnapYAxis`).
  const top = Math.floor(y + 0.5);
  if (style === 'double') {
    rule(ps, x, x + width, top, rows, color);
    // The second band is moved t + 1 and snapped on its own.
    const offset = line === 'line-through' ? Math.floor(t + 1) : line === 'overline' ? -(t + 1) : t + 1;
    rule(ps, x, x + width, Math.floor(y + offset + 0.5), rows, color);
    return;
  }
  if (style === 'dotted' || style === 'dashed') {
    // `DrawLineAsStroke`: truncated endpoints, stroked at the unrounded thickness.
    const w = Math.round(t);
    let x0 = Math.trunc(x), x1 = Math.trunc(x + width);
    const mid = Math.floor(y + Math.max(t / 2, 0.5)) + (w % 2 ? 0.5 : 0);
    const pattern = blinkDash(style, w, x1 - x0);
    // Round dots overhang their endpoints by a radius: Blink moves both in.
    if (pattern?.cap === 'round') { x0 += w / 2; x1 -= w / 2; }
    ps.stroke(color, t, pattern?.dash, pattern?.cap);
    ctx.beginPath();
    ctx.moveTo(x0, mid);
    ctx.lineTo(x1, mid);
    ctx.stroke();
    return;
  }
  if (style === 'wavy') {
    // `MakeWave`: painted from a cached tile whose origin lands on a device pixel.
    const k = Math.max(1, t);
    const wavelength = 1 + 2 * Math.round(2 * k + 0.5);
    const cp = 0.5 + Math.round(3 * k + 0.5);
    const offset = line === 'underline' ? t + 1 : line === 'overline' ? -(t + 1) : 0;
    const tileTop = Math.floor(0.5 - cp - t / 2);
    const axis = toDevice(y + offset + tileTop, band.deviceScale) + 0.5 - tileTop;
    ps.stroke(color, t);
    ctx.beginPath();
    wavePath(ctx, x, x + width, toDevice(x, band.deviceScale), axis, wavelength, cp);
    ctx.stroke();
    return;
  }
  rule(ps, x, x + width, top, rows, color);
}

// ─── WebKit ─────────────────────────────────────────────────────────────

/**
 * WebKit: double adds a band one band-width below (overline too); dotted
 * rows/rows and dashed 2·rows/2·rows, unfitted; wavy: a cubic per 2·step,
 * step = fontSize / 4.5, stretched so whole steps fill the fragment.
 */
function webkitBand(ps: PaintState, band: Band, color: string | CanvasGradient) {
  const { ctx } = ps;
  const { style, x, width, y: top, rows } = band;
  if (style === 'double') {
    rule(ps, x, x + width, top, rows, color);
    rule(ps, x, x + width, top + 2 * rows, rows, color);
    return;
  }
  if (style === 'dotted' || style === 'dashed') {
    const on = style === 'dotted' ? rows : 2 * rows;
    ps.stroke(color, rows, [on, on]);
    ctx.beginPath();
    ctx.moveTo(toDevice(x, band.deviceScale), top + rows / 2);
    ctx.lineTo(x + width, top + rows / 2);
    ctx.stroke();
    return;
  }
  if (style === 'wavy') {
    let step = band.fontSize / 4.5;
    let cp = band.fontSize * 1.5 / 16;
    const steps = Math.floor(width / step);
    if (steps > 0) {
      const adjustment = (width - steps * step) / steps;
      step += adjustment;
      cp += adjustment;
    }
    // Overline 2px higher, line-through 1.5px (a FIT).
    const raise = band.line === 'overline' ? 2 : band.line === 'line-through' ? 1.5 : 0;
    const axis = top + 1 + (rows % 2 ? 0.5 : 0) - raise;
    ps.stroke(color, band.thickness);
    ctx.beginPath();
    ctx.moveTo(x, axis);
    for (let at = x; at + 2 * step <= x + width + 1e-6; at += 2 * step) {
      ctx.bezierCurveTo(at + step, axis + cp, at + step, axis - cp, at + 2 * step, axis);
    }
    ctx.stroke();
    return;
  }
  rule(ps, x, x + width, top, rows, color);
}

// ─── Gecko (unmeasured) ─────────────────────────────────────────────────

/** The unmeasured dash pattern of `drawDecorationLine`; undefined = solid. */
export function legacyDash(style: string, w: number): number[] | undefined {
  return style === 'dotted' ? [w, w * 2] : style === 'dashed' ? [w * 3, w * 2] : undefined;
}

/** Unmeasured decoration shapes centered on `y`, for Gecko and text-on-path. */
export function drawDecorationLine(
  ps: PaintState,
  x: number,
  y: number,
  width: number,
  lineWidth: number,
  decoStyle: string,
  color: string | CanvasGradient,
): void {
  y = Math.round(y - lineWidth / 2) + lineWidth / 2;
  const { ctx } = ps;

  if (decoStyle === 'double') {
    const gap = Math.max(lineWidth, 2);
    ps.stroke(color, Math.max(0.5, lineWidth * 0.5));
    ctx.beginPath();
    ctx.moveTo(x, y - gap / 2);
    ctx.lineTo(x + width, y - gap / 2);
    ctx.moveTo(x, y + gap / 2);
    ctx.lineTo(x + width, y + gap / 2);
    ctx.stroke();
  } else if (decoStyle === 'wavy') {
    const amplitude = Math.max(1.5, lineWidth);
    const wavelength = amplitude * 4;
    ps.stroke(color, lineWidth);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let cx = x; cx < x + width; cx += wavelength) {
      ctx.quadraticCurveTo(cx + wavelength / 4, y - amplitude, cx + wavelength / 2, y);
      ctx.quadraticCurveTo(cx + wavelength * 3 / 4, y + amplitude, cx + wavelength, y);
    }
    ctx.stroke();
  } else {
    ps.stroke(color, lineWidth, legacyDash(decoStyle, lineWidth));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  }
}
