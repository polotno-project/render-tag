import type { DecorationEntry, ResolvedStyle } from './types.js';
import { isShiftedVAlign } from './layout.js';
import type { PaintState } from './paint-state.js';

// Text decoration bands. The engine paints a decoration once per text fragment
// (one text node's pieces on one line): dashes fit and waves keep phase across
// its spaces, and restart at the next text node (decoration-shape-parity).

type DecorationLine = 'underline' | 'overline' | 'line-through';

/** Where a band's path points land: the ctx itself for a straight fragment;
 * text on a path bends them along its glyph frames. */
export type Pen = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'quadraticCurveTo'>;

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

/** Where a fragment's decorations hang: what `decorationBand` needs to know. */
interface FragmentLine {
  baseline: number;
  /** The line's own baseline when only the run was vertical-aligned. */
  underlineBaseline: number;
  ascent: number;
  /** `paintLineSnap`. */
  snap: number;
}

/**
 * The band one entry draws over one fragment (null: nothing), Blink's geometry. Top edges:
 * - underline: ceil(fontSize / 20) below the snapped baseline (`paintLineSnap`); explicit
 *   geometry via `explicitUnderlineDelta`.
 * - overline: the bottom edge on the floored ascent row.
 * - line-through: `baseline - ascent / 3 - t / 2` (text_decoration_info.cc).
 * decoration-position-parity.
 */
export function decorationBand(
  deco: DecorationEntry, at: FragmentLine, x: number, width: number, deviceScale = 1,
): Band | null {
  const rows = bandWidthFor(deco);
  if (rows <= 0 || width <= 0) return null;
  const fontSize = deco.declarer.fontSize;
  const t = deco.declarer.textDecorationThickness !== null ? rows : Math.max(1, fontSize / 10);
  const line = deco.line as DecorationLine;
  const style = deco.style || 'solid';
  let y: number;
  if (line === 'underline') {
    const explicit = explicitUnderlineDelta(deco, rows);
    y = explicit !== null
      ? Math.round(at.underlineBaseline + explicit - rows / 2)
      : Math.round(at.underlineBaseline + Math.ceil(fontSize / 20));
    // Placed before the line's paint snap (OffsetFromDecoratingBox).
    y -= at.snap;
  } else if (line === 'overline') {
    y = Math.floor(at.baseline - at.ascent) - rows;
  } else if (line === 'line-through') {
    y = at.baseline - at.ascent / 3 - t / 2;
  } else {
    return null;
  }
  return { line, style, x, width, y, rows, thickness: t, fontSize, deviceScale };
}

/**
 * A fragment's decoration bands with their entries, ancestors' first (the
 * caller colors each; a transparent entry shows the clip paint). Thickness
 * and the underline's baseline come from the declarer (one flat band, even
 * over a `super` child it does not own); the overline and line-through
 * follow the fragment's own ascent. `lineBaseline` is the line's baseline
 * when only the run was vertical-aligned. tests/decorating-box-geometry.test.ts.
 */
export function fragmentBands(
  ps: Pick<PaintState, 'fontBox' | 'deviceScale'>, style: ResolvedStyle, x: number, width: number,
  baseline: number, snap: number, lineBaseline?: number,
): { band: Band; deco: DecorationEntry }[] {
  let ascent: number | undefined;
  const bands: { band: Band; deco: DecorationEntry }[] = [];
  for (const deco of style.textDecorations) {
    const underlineBaseline =
      lineBaseline !== undefined && !isShiftedVAlign(deco.declarer.verticalAlign) ? lineBaseline : baseline;
    if (deco.line !== 'underline') ascent ??= ps.fontBox(style).ascent;
    const band = decorationBand(deco, {
      baseline, underlineBaseline, ascent: ascent ?? 0, snap,
    }, x, width, ps.deviceScale);
    if (band) bands.push({ band, deco });
  }
  return bands;
}

/** A horizontal stroke `rows` thick whose top edge is `top`. */
function rule(ps: PaintState, x0: number, x1: number, top: number, rows: number, color: string | CanvasGradient, pen: Pen) {
  ps.stroke(color, rows);
  ps.ctx.beginPath();
  pen.moveTo(x0, top + rows / 2);
  pen.lineTo(x1, top + rows / 2);
  ps.ctx.stroke();
}

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
  // Up to two dot widths hold one dot (at exactly two, the fitted gap divides by zero).
  const perDot = width * 2;
  if (length <= perDot) return { dash: [0, perDot], cap: 'round' };
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
  pen: Pen, x0: number, x1: number, anchor: number,
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
    if (first) { pen.moveTo(p0[0], p0[1]); first = false; }
    pen.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  }
}

/** How far a double band's second line sits from its first: t + 1, away from the text. */
function doubleOffset({ line, thickness: t }: Band): number {
  return line === 'line-through' ? Math.floor(t + 1) : line === 'overline' ? -(t + 1) : t + 1;
}

/** A wavy band's axis offset from its top, control point and wavelength (`MakeWave`). */
function waveOf({ line, thickness: t }: Band) {
  const k = Math.max(1, t);
  return {
    offset: line === 'underline' ? t + 1 : line === 'overline' ? -(t + 1) : 0,
    cp: 0.5 + Math.round(3 * k + 0.5),
    wavelength: 1 + 2 * Math.round(2 * k + 0.5),
  };
}

/** Top and bottom of what `paintBand` paints for `band`, 1px past each for any device pixel. A
 * wave's cubic, control points at ±cp, peaks at cp·√3/6. */
export function bandSpan(band: Band): readonly [number, number] {
  const { style, y, rows, thickness: t } = band;
  let top = y, bottom = y + rows;
  if (style === 'double') {
    const offset = doubleOffset(band);
    [top, bottom] = [Math.min(y, y + offset), Math.max(y, y + offset) + rows];
  } else if (style === 'wavy') {
    const { offset, cp } = waveOf(band);
    const reach = cp * Math.sqrt(3) / 6 + t / 2;
    [top, bottom] = [y + offset + 0.5 - reach, y + offset + 0.5 + reach];
  } else if (style === 'dotted' || style === 'dashed') {
    bottom = y + Math.max(t, 1) + 0.5;
  }
  return [top - 1, bottom + 1];
}

export function paintBand(ps: PaintState, band: Band, color: string | CanvasGradient, pen: Pen = ps.ctx) {
  const { ctx } = ps;
  const { style, x, width, y, rows, thickness: t } = band;
  // Solid and double bands are rects snapped on y only (`SnapYAxis`).
  const top = Math.floor(y + 0.5);
  if (style === 'double') {
    rule(ps, x, x + width, top, rows, color, pen);
    // The second band is moved t + 1 and snapped on its own.
    rule(ps, x, x + width, Math.floor(y + doubleOffset(band) + 0.5), rows, color, pen);
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
    pen.moveTo(x0, mid);
    pen.lineTo(x1, mid);
    ctx.stroke();
    return;
  }
  if (style === 'wavy') {
    // `MakeWave`: painted from a cached tile whose origin lands on a device pixel.
    const { offset, cp, wavelength } = waveOf(band);
    const tileTop = Math.floor(0.5 - cp - t / 2);
    const axis = toDevice(y + offset + tileTop, band.deviceScale) + 0.5 - tileTop;
    ps.stroke(color, t);
    ctx.beginPath();
    wavePath(pen, x, x + width, toDevice(x, band.deviceScale), axis, wavelength, cp);
    ctx.stroke();
    return;
  }
  rule(ps, x, x + width, top, rows, color, pen);
}
