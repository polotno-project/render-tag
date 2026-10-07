import type { DecorationEntry } from './types.js';
import { BLINK_UNDERLINE_GAP, ENGINE } from './engine.js';
import type { PaintState } from './paint-state.js';

// ─── Text decoration bands ─────────────────────────────────────────────
//
// The engine paints a decoration once per TEXT FRAGMENT — one text node's
// pieces, contiguous on one line (Blink's text fragment item; WebKit's text
// box) — not once per word, and not once per declaring element: a dash
// pattern fits, and a wave keeps its phase, across the spaces inside a
// fragment, and both restart at the next text node even under the same
// declarer (`<u>aa <b>bb</b> cc</u>` is three bands; measured in both
// engines, tests/decoration-shape-parity.test.ts). render.ts groups the runs;
// this file decides where each band sits and what it looks like.
//
// Every rule below was measured off the engine's own DOM raster
// (Chromium and Playwright WebKit, five pinned fonts, 10-64px) and, for
// Blink, matches its source (decoration_line_painter.cc,
// text_decoration_info.cc, styled_stroke_data.cc). Gecko is unmeasured — it
// keeps render-tag's older shapes and positions (`drawDecorationLine`).

type DecorationLine = 'underline' | 'overline' | 'line-through';

/** One decoration band across one text fragment. */
export interface Band {
  line: DecorationLine;
  /** solid | double | dotted | dashed | wavy */
  style: string;
  /** The fragment's left edge and width — the band's extent. */
  x: number;
  width: number;
  /**
   * The top edge of the (first) band. For Blink this is its unsnapped rect
   * origin — it snaps a solid band with floor(y + 0.5) itself, and centers a
   * dash or a wave off the raw value. Elsewhere it is the painted top.
   */
  y: number;
  /** Painted thickness, whole pixels. */
  rows: number;
  /** The engine's resolved thickness (a float) that sizes waves and dashes. */
  thickness: number;
  /** The decorating box's font size (WebKit sizes its wave from it). */
  fontSize: number;
  /** Device pixels per CSS pixel (`PaintState.deviceScale`). */
  deviceScale: number;
}

/** Round to the nearest device pixel. */
const toDevice = (v: number, scale: number) => Math.floor(v * scale + 0.5) / scale;

/**
 * The band width for one decoration entry: the declarer's explicit
 * text-decoration-thickness when set (Chrome draws round(T) rows; a declared
 * 0 hides the band — callers skip on 0), else the auto thickness from the
 * declarer's font size. Shared by both renderers. Blink's auto thickness is
 * max(1, floor(fontSize / 10)) rows (measured across 6 fonts x 16-64px).
 */
export function bandWidthFor(deco: DecorationEntry): number {
  const t = deco.declarer.textDecorationThickness;
  if (t === null) return Math.max(1, Math.floor(deco.declarer.fontSize / 10));
  return t <= 0 ? 0 : Math.max(1, Math.round(t));
}

/**
 * Band-center delta below the baseline for EXPLICIT underline geometry, or
 * null for auto (each renderer keeps its own auto formula). Chrome-measured:
 * an explicit offset puts the band TOP at baseline + offset; auto offset
 * with an explicit thickness T puts it at baseline + ceil(T/2) — measured
 * exactly for T ∈ {1, 3, 4, 5, 8, 10}.
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
 * The engine's thickness as [painted rows, resolved float], or null when a
 * declared 0 hides the band.
 *
 * - Blink: auto is fontSize / 10 (at least 1), painted max(1, floor(t))
 *   rows; the float sizes dashes and waves.
 * - WebKit: auto is fontSize / 16, painted ceil(t) DEVICE pixels (570 of
 *   570 bands at DPR 1 and 570 of 570 at DPR 2, five fonts, 10-64px) —
 *   1.5 CSS px for a 20px font at DPR 2.
 * - An explicit thickness T: Blink resolves it to round(T) (at least 1),
 *   which both paints and positions the band — a 1.5px or 6.4px
 *   line-through sits where a 2px or 6px one does. WebKit rounds T UP on
 *   the device grid exactly like its auto thickness (6.4px paints 7 rows at
 *   DPR 1, 13 at DPR 2). Measured: Open Sans, Roboto, Playfair Display at
 *   16/32/48px, T 1-10px, DPR 1 and 2 (decoration-position-parity).
 *   Gecko keeps round(T) rows and the declared float.
 */
function thicknessOf(deco: DecorationEntry, deviceScale: number): [rows: number, thickness: number] | null {
  const rows = bandWidthFor(deco);
  if (rows <= 0) return null;
  const declared = deco.declarer.textDecorationThickness;
  const webkit = (t: number) => Math.max(1, Math.ceil(t * deviceScale)) / deviceScale;
  if (declared !== null) {
    if (ENGINE === 'blink') return [rows, rows];
    if (ENGINE === 'webkit') return [webkit(declared), declared];
    return [rows, Math.max(1, declared)];
  }
  const size = deco.declarer.fontSize;
  if (ENGINE === 'webkit') return [webkit(size / 16), size / 16];
  return [rows, Math.max(1, size / 10)];
}

/** WebKit's AUTO thickness on the device grid: its overline and its
 * auto-offset underline keep the auto band's geometry whatever the declared
 * thickness. */
function webkitAutoRows(fontSize: number, deviceScale: number): number {
  return Math.max(1, Math.ceil(fontSize / 16 * deviceScale)) / deviceScale;
}

/** Where a fragment's decorations hang: what `decorationBand` needs to know. */
interface FragmentLine {
  /** The painted baseline of the crossed text. */
  baseline: number;
  /** The baseline an underline hangs off (the line's own when the run was
   * shifted by vertical-align and the declarer was not). */
  underlineBaseline: number;
  /** The crossed text's font size and ascent (overline and line-through). */
  fontSize: number;
  ascent: number;
  /** How far the line was moved to paint (`paintLineSnap`). */
  snap: number;
}

/**
 * The band one decoration entry draws over one fragment, or null when it
 * paints nothing.
 *
 * WebKit hangs every band off its baseline snapped to a DEVICE pixel
 * (CLAUDE.md "Paint is not layout"), on the grid the caller's `pixelRatio`
 * declares (`PaintState.deviceScale`).
 *
 * Positions (top edge of the band):
 * - underline, Blink: half the auto thickness, rounded up, below the snapped
 *   baseline (`ceil(fontSize / 20)`, see CLAUDE.md "Paint is not layout").
 *   WebKit: `max(1, ceil(t / 2))` below the baseline, t = fontSize / 16
 *   (190 of 190 bands), an explicit thickness included. An explicit offset
 *   (and, in Blink, an explicit thickness): `explicitUnderlineDelta`.
 * - overline, Blink: its bottom edge on the floored ascent row. WebKit: the
 *   AUTO band's top on the ascent row (190 of 190); a declared thickness
 *   keeps that band's bottom edge and grows up.
 * - line-through, Blink: `baseline - ascent / 3 - t / 2`, snapped with
 *   floor(y + 0.5) — text_decoration_info.cc's `2 * ascent / 3 - t / 2`
 *   below the text top (190 of 190 bands: five fonts, 10-64px, two
 *   line-heights). WebKit reads the font's strikeout metric, which canvas
 *   cannot: `baseline - 0.3025 · ascent - t / 2`, rounded UP to a device
 *   pixel, is a FIT, not its rule — exact for 168 of 190 bands at DPR 1 and
 *   142 of 190 at DPR 2, the rest one device pixel off (the 0.33em formula
 *   Gecko keeps was exact for 34 of 190 at DPR 1 and up to 4px off).
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
    // WebKit keeps its auto position under an explicit THICKNESS (the band
    // grows down from it); only an explicit offset moves it.
    const explicit = engine === 'webkit' && deco.declarer.textUnderlineOffset === null
      ? null : explicitUnderlineDelta(deco, rows);
    if (explicit !== null) y = Math.round(at.underlineBaseline + explicit - rows / 2);
    else if (engine === 'webkit') {
      y = toDevice(at.underlineBaseline, deviceScale) + Math.max(1, Math.ceil(fontSize / 16 / 2));
    }
    else if (BLINK_UNDERLINE_GAP) y = Math.round(at.underlineBaseline + Math.ceil(fontSize / 20));
    // Gecko: a Chrome-tuned approximation from before the line snap.
    else y = Math.round(at.underlineBaseline + fontSize * 0.105 - 0.2 - rows / 2);
    // Blink computes the underline in the decorating box's layout
    // coordinates, before the line's paint snap (`OffsetFromDecoratingBox`):
    // its rect is the snapped band moved back by the snap. That half-pixel
    // decides a double's gap and a dash's row on a line whose top was at .5
    // (measured: 25px under a 12.5px padding).
    if (engine === 'blink') y -= at.snap;
  } else if (line === 'overline') {
    // WebKit: the AUTO band's top is the ascent row; a thicker or thinner
    // declared band keeps the auto band's bottom edge and grows up from it.
    y = engine === 'webkit'
      ? toDevice(at.baseline, deviceScale) - Math.round(at.ascent) + webkitAutoRows(fontSize, deviceScale) - rows
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

/** Paint one band. */
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
 * The dash Blink strokes a dotted or dashed decoration with, for a path of
 * `length` whole pixels and a dash width of `width` = round(thickness)
 * (`DashEffectFromStrokeStyle`). Null is a solid line.
 * - dashed: dashes of 3w and gaps of 2w below 3px, 2w and w from 3px; the
 *   gap is stretched so the pattern starts and ends on a whole dash.
 * - dotted up to 3px: square dots, w on and w off, NOT fitted (it ends on
 *   whatever part of a dot the length reaches).
 * - dotted above 3px: round dots (zero-length dashes, round caps), fitted.
 * A path too short for the pattern draws one or two scaled dashes, or solid.
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
    // The second band is the first moved t + 1 down (up, for an overline;
    // floor(t + 1), for a line-through) and snapped on its own — so its gap
    // depends on the first band's sub-pixel origin (exact on two fonts at
    // 12-64px and explicit 1-10px; decoration-shape-parity, DPR 1 and 2).
    const offset = line === 'line-through' ? Math.floor(t + 1) : line === 'overline' ? -(t + 1) : t + 1;
    rule(ps, x, x + width, Math.floor(y + offset + 0.5), rows, color);
    return;
  }
  if (style === 'dotted' || style === 'dashed') {
    // `DrawLineAsStroke`: whole-pixel endpoints (truncated), the line on
    // floor(y + max(t/2, 0.5)), half a pixel lower for an odd dash width,
    // stroked at the unrounded thickness.
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
    // `MakeWave`: half-pixel wavelength and control-point distance. The wave
    // sits t + 1 below an underline's rect (above an overline's; on a
    // line-through's). Blink paints it from a cached tile whose origin lands
    // on a whole DEVICE pixel: the tile's top is the floored top of the
    // path's bounds (control points included, plus half the stroke), and the
    // centerline sits half a CSS pixel into it. The tile starts its cycle on
    // the rounded fragment left edge and is clipped to the fragment.
    // Measured: the centerline lands within 0.06px of this in 7 of 7 sizes.
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
 * WebKit (Playwright WebKit DOM raster):
 * - double: a second band of the same thickness one band-width below the
 *   first — below for all three lines, the overline included.
 * - dotted: square dots, `rows` on and `rows` off; dashed: 2·rows on and
 *   2·rows off. Neither is fitted; both start at the fragment's left edge,
 *   on a whole pixel.
 * - wavy: a cubic per 2·step with step = fontSize / 4.5 and control points
 *   fontSize · 1.5 / 16 off the axis, both stretched by the same amount so
 *   whole steps fill the fragment; the axis sits a pixel below the band top
 *   (1.5 for an odd band; two pixels higher for an overline).
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
      // Stretch both so whole steps fill the fragment.
      const adjustment = (width - steps * step) / steps;
      step += adjustment;
      cp += adjustment;
    }
    // An overline's wave sits two pixels higher than an underline's; a
    // line-through's 1.5px higher (a FIT over the fitted strike: its rows
    // land 1-2px off either way, measured at DPR 1 and 2).
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

/**
 * render-tag's original decoration shapes, centered on `y`: two half-width
 * lines for `double`, an untuned quadratic wave, and fixed dash patterns.
 * The text-on-path renderer (per glyph) and the Gecko branch still draw
 * these; neither has been measured against its engine.
 */
export function drawDecorationLine(
  ps: PaintState,
  x: number,
  y: number,
  width: number,
  lineWidth: number,
  decoStyle: string,
  color: string | CanvasGradient,
): void {
  // Snap the stroke center so the band edges land on the pixel grid.
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
    // solid, dotted, dashed
    ps.stroke(color, lineWidth,
      decoStyle === 'dotted' ? [lineWidth, lineWidth * 2]
        : decoStyle === 'dashed' ? [lineWidth * 3, lineWidth * 2]
          : undefined);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  }
}
