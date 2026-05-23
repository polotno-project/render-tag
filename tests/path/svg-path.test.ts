import { describe, it, expect } from 'vitest';
import { parsePathData, buildPathLike, pathFromString } from '../../src/path/svg-path.ts';

function approx(a: number, b: number, eps = 0.01) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
}

describe('SVG path parser', () => {
  it('horizontal line: length and midpoint', () => {
    const p = pathFromString('M0,0 L100,0');
    expect(p.length).toBe(100);
    const mid = p.getPointAtLength(50)!;
    approx(mid.x, 50);
    approx(mid.y, 0);
  });

  it('L-shape: length sums and corner is reached at the joint length', () => {
    const p = pathFromString('M0,0 L100,0 L100,100');
    expect(p.length).toBe(200);
    const corner = p.getPointAtLength(100)!;
    approx(corner.x, 100);
    approx(corner.y, 0);
    const lateral = p.getPointAtLength(150)!;
    approx(lateral.x, 100);
    approx(lateral.y, 50);
  });

  it('H and V commands behave as L for length', () => {
    const p = pathFromString('M0,0 H50 V50');
    expect(p.length).toBe(100);
    const pt = p.getPointAtLength(75)!;
    approx(pt.x, 50);
    approx(pt.y, 25);
  });

  it('relative commands compose correctly', () => {
    const p = pathFromString('M10,10 l 50,0 l 0,50');
    expect(p.length).toBe(100);
    const endpoint = p.getPointAtLength(100)!;
    approx(endpoint.x, 60);
    approx(endpoint.y, 60);
  });

  it('Z closes the subpath: length includes the close segment', () => {
    // Triangle 0,0 → 100,0 → 100,100 → close
    const p = pathFromString('M0,0 L100,0 L100,100 Z');
    // Three sides: 100 + 100 + sqrt(100^2 + 100^2) ≈ 100 + 100 + 141.42 = 341.42
    approx(p.length, 100 + 100 + Math.hypot(100, 100), 0.01);
  });

  it('cubic bezier: endpoints exact, midpoint within sampling tolerance', () => {
    // Symmetric cubic — midpoint should be at (50, 50) approximately
    const p = pathFromString('M0,0 C0,100 100,100 100,0');
    const a = p.getPointAtLength(0)!;
    approx(a.x, 0); approx(a.y, 0);
    const b = p.getPointAtLength(p.length)!;
    approx(b.x, 100); approx(b.y, 0);
    const mid = p.getPointAtLength(p.length / 2)!;
    approx(mid.x, 50, 0.5);
    approx(mid.y, 75, 0.5); // peak of the cubic, not 50 — cubic ~~ y(0.5) = 75
  });

  it('quadratic bezier with smooth T command', () => {
    // First Q: control at (50,100), endpoint (100,0). Second T uses reflected control.
    const p = pathFromString('M0,0 Q50,100 100,0 T200,0');
    // Endpoints
    const a = p.getPointAtLength(0)!;
    approx(a.x, 0); approx(a.y, 0);
    const end = p.getPointAtLength(p.length)!;
    approx(end.x, 200, 0.5); approx(end.y, 0, 0.5);
  });

  it('arc: half-circle radius 50 has length ≈ π·50', () => {
    // From (0,0) to (100,0), rx=50 ry=50, large-arc=0 sweep=1 — upper half-circle
    const p = pathFromString('M0,0 A50,50 0 0 1 100,0');
    approx(p.length, Math.PI * 50, 0.5);
    const mid = p.getPointAtLength(p.length / 2)!;
    approx(mid.x, 50, 0.5);
    // Goes through (50, -50) at the top
    approx(mid.y, -50, 0.5);
  });

  it('returns null for out-of-range length', () => {
    const p = pathFromString('M0,0 L100,0');
    expect(p.getPointAtLength(-1)).toBeNull();
    expect(p.getPointAtLength(200)).toBeNull();
  });

  it('parsePathData handles comma- and whitespace-separated numbers, leading sign', () => {
    const segs = parsePathData('M0 0L-10,10 L10 ,-5');
    expect(segs.length).toBe(2);
    expect(segs[0]).toMatchObject({ type: 'L', x1: -10, y1: 10 });
    expect(segs[1]).toMatchObject({ type: 'L', x1: 10, y1: -5 });
  });

  it('arc with rx=0 degenerates to a straight line (no NaN)', () => {
    const p = pathFromString('M0,0 A0,50 0 0 1 100,0');
    expect(Number.isFinite(p.length)).toBe(true);
    expect(p.length).toBe(100);
    const mid = p.getPointAtLength(50)!;
    expect(Number.isFinite(mid.x)).toBe(true);
    approx(mid.x, 50);
    approx(mid.y, 0);
  });

  it('arc with ry=0 degenerates to a straight line', () => {
    const p = pathFromString('M0,0 A50,0 0 0 1 100,0');
    expect(p.length).toBe(100);
  });

  it('arc with identical endpoints is skipped (no NaN, no contribution to length)', () => {
    const p = pathFromString('M0,0 L100,0 A50,50 0 0 1 100,0 L200,0');
    expect(Number.isFinite(p.length)).toBe(true);
    expect(p.length).toBe(200);
  });

  it('rejects non-finite query lengths', () => {
    const p = pathFromString('M0,0 L100,0');
    expect(p.getPointAtLength(Number.NaN)).toBeNull();
    expect(p.getPointAtLength(Number.POSITIVE_INFINITY)).toBeNull();
    expect(p.getPointAtLength(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('handles multiple subpaths (M restarts current point but Z closes the most recent subpath)', () => {
    const p = pathFromString('M0,0 L10,0 M50,0 L60,0');
    expect(p.length).toBe(20); // two 10px segments
    // Beginning of first segment
    const a = p.getPointAtLength(0)!;
    approx(a.x, 0); approx(a.y, 0);
    // Beginning of second subpath = start of second L (length 10 in)
    const b = p.getPointAtLength(10)!;
    approx(b.x, 10); approx(b.y, 0);
    const c = p.getPointAtLength(15)!;
    approx(c.x, 55); approx(c.y, 0);
  });
});
