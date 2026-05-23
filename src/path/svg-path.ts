/**
 * Minimal SVG path 'd' attribute parser + arc-length tabulation.
 * Supports: M m L l H h V v C c S s Q q T t A a Z z.
 *
 * Curves are sampled uniformly in parameter space and the cumulative
 * arc-length is tabulated. `getPointAtLength` binary-searches that table
 * and lerps between adjacent samples. Accuracy is "good enough for visual
 * rendering" — not for hit-testing or precise length math.
 */

export interface Point {
  x: number;
  y: number;
}

export interface PathLike {
  length: number;
  /** Returns the (x, y) on the path at arc length `t`, or null if `t` is out of range. */
  getPointAtLength(t: number): Point | null;
}

type Seg =
  | { type: 'L'; x0: number; y0: number; x1: number; y1: number }
  | {
      type: 'C';
      x0: number; y0: number;
      c1x: number; c1y: number;
      c2x: number; c2y: number;
      x1: number; y1: number;
    }
  | {
      type: 'Q';
      x0: number; y0: number;
      cx: number; cy: number;
      x1: number; y1: number;
    }
  | {
      type: 'A';
      x0: number; y0: number;
      rx: number; ry: number;
      xAxisRotation: number;
      largeArc: boolean;
      sweep: boolean;
      x1: number; y1: number;
    };

// ─── Tokenizer ─────────────────────────────────────────────────────────

const COMMAND_RE = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUMBER_RE = /-?(?:\d+\.\d+|\d+\.|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

/** Split a path string into a sequence of (command, args) tuples. */
function tokenize(d: string): { cmd: string; args: number[] }[] {
  const out: { cmd: string; args: number[] }[] = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i];
    if (COMMAND_RE.test(c)) {
      // Slice until the next command
      let j = i + 1;
      while (j < d.length && !COMMAND_RE.test(d[j])) j++;
      const argString = d.slice(i + 1, j);
      const args: number[] = [];
      let m: RegExpExecArray | null;
      NUMBER_RE.lastIndex = 0;
      while ((m = NUMBER_RE.exec(argString))) args.push(Number(m[0]));
      out.push({ cmd: c, args });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

// ─── Normalize to absolute segments ───────────────────────────────────

/**
 * Parse path data into an array of normalized absolute-coordinate segments.
 * Drops moveTo commands (they don't draw); inserts a closing line for Z.
 */
export function parsePathData(d: string): Seg[] {
  const tokens = tokenize(d);
  const segs: Seg[] = [];

  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  // Last cubic control reflection point (for S/s)
  let lastCubicCtrl: { x: number; y: number } | null = null;
  // Last quadratic control reflection point (for T/t)
  let lastQuadCtrl: { x: number; y: number } | null = null;

  for (const tok of tokens) {
    const cmd = tok.cmd;
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const a = tok.args;

    // Helpers
    const ax = (v: number) => (rel ? cx + v : v);
    const ay = (v: number) => (rel ? cy + v : v);

    let resetCubic = true;
    let resetQuad = true;

    switch (upper) {
      case 'M': {
        // M arglist: first pair = moveto, subsequent pairs = lineto
        for (let i = 0; i < a.length; i += 2) {
          const x = rel && i > 0 ? cx + a[i] : ax(a[i]);
          const y = rel && i > 0 ? cy + a[i + 1] : ay(a[i + 1]);
          if (i === 0) {
            cx = x; cy = y;
            sx = x; sy = y;
          } else {
            segs.push({ type: 'L', x0: cx, y0: cy, x1: x, y1: y });
            cx = x; cy = y;
          }
        }
        break;
      }
      case 'L': {
        for (let i = 0; i < a.length; i += 2) {
          const x = ax(a[i]);
          const y = ay(a[i + 1]);
          segs.push({ type: 'L', x0: cx, y0: cy, x1: x, y1: y });
          cx = x; cy = y;
        }
        break;
      }
      case 'H': {
        for (let i = 0; i < a.length; i++) {
          const x = rel ? cx + a[i] : a[i];
          segs.push({ type: 'L', x0: cx, y0: cy, x1: x, y1: cy });
          cx = x;
        }
        break;
      }
      case 'V': {
        for (let i = 0; i < a.length; i++) {
          const y = rel ? cy + a[i] : a[i];
          segs.push({ type: 'L', x0: cx, y0: cy, x1: cx, y1: y });
          cy = y;
        }
        break;
      }
      case 'C': {
        for (let i = 0; i < a.length; i += 6) {
          const c1x = ax(a[i]);
          const c1y = ay(a[i + 1]);
          const c2x = ax(a[i + 2]);
          const c2y = ay(a[i + 3]);
          const x = ax(a[i + 4]);
          const y = ay(a[i + 5]);
          segs.push({ type: 'C', x0: cx, y0: cy, c1x, c1y, c2x, c2y, x1: x, y1: y });
          lastCubicCtrl = { x: c2x, y: c2y };
          cx = x; cy = y;
        }
        resetCubic = false;
        break;
      }
      case 'S': {
        for (let i = 0; i < a.length; i += 4) {
          // Reflect previous cubic c2 about current point. If previous was not C/S, use cx,cy.
          const c1x = lastCubicCtrl ? 2 * cx - lastCubicCtrl.x : cx;
          const c1y = lastCubicCtrl ? 2 * cy - lastCubicCtrl.y : cy;
          const c2x = ax(a[i]);
          const c2y = ay(a[i + 1]);
          const x = ax(a[i + 2]);
          const y = ay(a[i + 3]);
          segs.push({ type: 'C', x0: cx, y0: cy, c1x, c1y, c2x, c2y, x1: x, y1: y });
          lastCubicCtrl = { x: c2x, y: c2y };
          cx = x; cy = y;
        }
        resetCubic = false;
        break;
      }
      case 'Q': {
        for (let i = 0; i < a.length; i += 4) {
          const ctlx = ax(a[i]);
          const ctly = ay(a[i + 1]);
          const x = ax(a[i + 2]);
          const y = ay(a[i + 3]);
          segs.push({ type: 'Q', x0: cx, y0: cy, cx: ctlx, cy: ctly, x1: x, y1: y });
          lastQuadCtrl = { x: ctlx, y: ctly };
          cx = x; cy = y;
        }
        resetQuad = false;
        break;
      }
      case 'T': {
        for (let i = 0; i < a.length; i += 2) {
          const ctlx = lastQuadCtrl ? 2 * cx - lastQuadCtrl.x : cx;
          const ctly = lastQuadCtrl ? 2 * cy - lastQuadCtrl.y : cy;
          const x = ax(a[i]);
          const y = ay(a[i + 1]);
          segs.push({ type: 'Q', x0: cx, y0: cy, cx: ctlx, cy: ctly, x1: x, y1: y });
          lastQuadCtrl = { x: ctlx, y: ctly };
          cx = x; cy = y;
        }
        resetQuad = false;
        break;
      }
      case 'A': {
        for (let i = 0; i < a.length; i += 7) {
          const rx = a[i];
          const ry = a[i + 1];
          const xAxisRotation = a[i + 2];
          const largeArc = a[i + 3] !== 0;
          const sweep = a[i + 4] !== 0;
          const x = ax(a[i + 5]);
          const y = ay(a[i + 6]);
          // SVG spec §B.2.5: arcs with rx=0 or ry=0 degenerate to a straight
          // line, and arcs whose endpoints coincide are not rendered at all
          // (skip emitting a segment). Without these guards arcToCenter
          // produces NaN sample points, poisoning the entire path.
          if (rx === 0 || ry === 0) {
            if (cx !== x || cy !== y) {
              segs.push({ type: 'L', x0: cx, y0: cy, x1: x, y1: y });
            }
          } else if (cx === x && cy === y) {
            // identical endpoints — skip
          } else {
            segs.push({
              type: 'A', x0: cx, y0: cy, rx, ry, xAxisRotation, largeArc, sweep,
              x1: x, y1: y,
            });
          }
          cx = x; cy = y;
        }
        break;
      }
      case 'Z': {
        if (cx !== sx || cy !== sy) {
          segs.push({ type: 'L', x0: cx, y0: cy, x1: sx, y1: sy });
        }
        cx = sx; cy = sy;
        break;
      }
      default:
        break;
    }

    if (resetCubic) lastCubicCtrl = null;
    if (resetQuad) lastQuadCtrl = null;
  }

  return segs;
}

// ─── Curve evaluation + length tabulation ─────────────────────────────

function evalCubic(s: Extract<Seg, { type: 'C' }>, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt * mt2 * s.x0 + 3 * mt2 * t * s.c1x + 3 * mt * t2 * s.c2x + t2 * t * s.x1,
    y: mt * mt2 * s.y0 + 3 * mt2 * t * s.c1y + 3 * mt * t2 * s.c2y + t2 * t * s.y1,
  };
}

function evalQuadratic(s: Extract<Seg, { type: 'Q' }>, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * s.x0 + 2 * mt * t * s.cx + t * t * s.x1,
    y: mt * mt * s.y0 + 2 * mt * t * s.cy + t * t * s.y1,
  };
}

/**
 * Endpoint-to-center arc conversion (SVG spec).
 * Returns { cx, cy, theta1, deltaTheta } in the rotated frame.
 */
function arcToCenter(s: Extract<Seg, { type: 'A' }>) {
  let rx = Math.abs(s.rx);
  let ry = Math.abs(s.ry);
  const phi = (s.xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (s.x0 - s.x1) / 2;
  const dy = (s.y0 - s.y1) / 2;

  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Ensure radii are large enough
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s2 = Math.sqrt(lambda);
    rx *= s2;
    ry *= s2;
  }

  const sign = s.largeArc === s.sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = Math.sqrt(Math.max(0, num / den));

  const cxp = sign * factor * ((rx * y1p) / ry);
  const cyp = sign * factor * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (s.x0 + s.x1) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (s.y0 + s.y1) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let ang = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) ang = -ang;
    return ang;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angle(
    (x1p - cxp) / rx, (y1p - cyp) / ry,
    (-x1p - cxp) / rx, (-y1p - cyp) / ry,
  );
  deltaTheta = deltaTheta % (2 * Math.PI);
  if (!s.sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  else if (s.sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  return { cx, cy, rx, ry, phi, theta1, deltaTheta, cosPhi, sinPhi };
}

function evalArc(s: Extract<Seg, { type: 'A' }>, t: number): Point {
  const { cx, cy, rx, ry, cosPhi, sinPhi, theta1, deltaTheta } = arcToCenter(s);
  const theta = theta1 + t * deltaTheta;
  const px = rx * Math.cos(theta);
  const py = ry * Math.sin(theta);
  return {
    x: cosPhi * px - sinPhi * py + cx,
    y: sinPhi * px + cosPhi * py + cy,
  };
}

const CURVE_SAMPLES = 40;

interface SegEntry {
  /** Cumulative length at the START of this segment. */
  startLen: number;
  /** Total length of this segment. */
  length: number;
  seg: Seg;
  /** Sampled (t, length) pairs for non-line segments. t in [0, 1]. */
  samples?: { t: number; len: number }[];
}

/**
 * Build a PathLike interface from normalized segments.
 * Tabulates cumulative arc-length per segment for O(log N) length-to-point lookup.
 */
export function buildPathLike(segs: Seg[]): PathLike {
  const entries: SegEntry[] = [];
  let totalLen = 0;

  for (const seg of segs) {
    if (seg.type === 'L') {
      const len = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
      entries.push({ startLen: totalLen, length: len, seg });
      totalLen += len;
      continue;
    }
    // Sample CURVE_SAMPLES + 1 points and accumulate cumulative arc length.
    const samples: { t: number; len: number }[] = [];
    let cumLen = 0;
    let prev: Point;
    if (seg.type === 'C') prev = { x: seg.x0, y: seg.y0 };
    else if (seg.type === 'Q') prev = { x: seg.x0, y: seg.y0 };
    else prev = evalArc(seg, 0);
    samples.push({ t: 0, len: 0 });
    for (let i = 1; i <= CURVE_SAMPLES; i++) {
      const t = i / CURVE_SAMPLES;
      let p: Point;
      if (seg.type === 'C') p = evalCubic(seg, t);
      else if (seg.type === 'Q') p = evalQuadratic(seg, t);
      else p = evalArc(seg, t);
      cumLen += Math.hypot(p.x - prev.x, p.y - prev.y);
      samples.push({ t, len: cumLen });
      prev = p;
    }
    entries.push({ startLen: totalLen, length: cumLen, seg, samples });
    totalLen += cumLen;
  }

  function getPointAtLength(t: number): Point | null {
    // Reject NaN / Infinity — `t < 0` etc. silently pass NaN through.
    if (!Number.isFinite(t)) return null;
    if (t < 0 || t > totalLen + 1e-6) return null;
    if (t === 0 && entries.length > 0) {
      const first = entries[0].seg;
      if (first.type === 'L' || first.type === 'C' || first.type === 'Q') {
        return { x: first.x0, y: first.y0 };
      }
      return evalArc(first, 0);
    }
    // Find the segment via linear scan (segment count is usually small).
    // Could binary-search for very large paths.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (t > e.startLen + e.length + 1e-6) continue;
      const local = t - e.startLen;
      if (e.seg.type === 'L') {
        const frac = e.length === 0 ? 0 : Math.max(0, Math.min(1, local / e.length));
        return {
          x: e.seg.x0 + (e.seg.x1 - e.seg.x0) * frac,
          y: e.seg.y0 + (e.seg.y1 - e.seg.y0) * frac,
        };
      }
      // Binary search the sample table for the bracketing pair.
      const samples = e.samples!;
      let lo = 0, hi = samples.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].len <= local) lo = mid;
        else hi = mid;
      }
      const a = samples[lo];
      const b = samples[hi];
      const span = b.len - a.len;
      const frac = span === 0 ? 0 : (local - a.len) / span;
      // Clamp to [0, 1] — float drift in the polyline-sum vs true arc length
      // can push frac past 1.0 when t lands just past the last sample.
      const tt = Math.max(0, Math.min(1, a.t + (b.t - a.t) * frac));
      if (e.seg.type === 'C') return evalCubic(e.seg, tt);
      if (e.seg.type === 'Q') return evalQuadratic(e.seg, tt);
      return evalArc(e.seg, tt);
    }
    return null;
  }

  return { length: totalLen, getPointAtLength };
}

/** Convenience: parse a path string and build a PathLike in one call. */
export function pathFromString(d: string): PathLike {
  return buildPathLike(parsePathData(d));
}
