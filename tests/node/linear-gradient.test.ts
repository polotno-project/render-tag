/**
 * `parseLinearGradient` against the CSS Images 3 gradient rules, on a fake
 * ctx that records the gradient line and its stops. The pixels these produce
 * are checked against the browser in tests/gradient-parity.test.ts; this file
 * pins the arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { parseLinearGradient } from '../../src/gradient.ts';

interface Recorded { line: number[]; stops: [number, string][] }

function parse(image: string, x = 0, width = 200, y = 0, height = 100): Recorded | null {
  let rec: Recorded | null = null;
  const ctx = {
    createLinearGradient(...line: number[]) {
      rec = { line, stops: [] };
      return {
        addColorStop(offset: number, color: string) {
          if (!(offset >= 0 && offset <= 1)) throw new RangeError(`offset ${offset}`);
          rec!.stops.push([offset, color]);
        },
      };
    },
  } as unknown as CanvasRenderingContext2D;
  parseLinearGradient(ctx, image, x, width, y, height);
  return rec;
}

/** The gradient line for a CSS angle on a W×H box at the origin (spec §3.1.1). */
function cssLine(deg: number, w: number, h: number): number[] {
  const a = deg * Math.PI / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  return [w / 2 - dx * len / 2, h / 2 - dy * len / 2, w / 2 + dx * len / 2, h / 2 + dy * len / 2];
}

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
const offsets = (r: Recorded | null) => r!.stops.map(([o]) => +o.toFixed(6));

describe('linear-gradient direction', () => {
  it('defaults to bottom', () => close(parse('linear-gradient(red, blue)')!.line, cssLine(180, 200, 100)));

  it.each([
    ['to top right', Math.atan2(100, 200) * 180 / Math.PI],
    ['to right top', Math.atan2(100, 200) * 180 / Math.PI],
    ['to bottom right', 180 - Math.atan2(100, 200) * 180 / Math.PI],
    ['to bottom left', 180 + Math.atan2(100, 200) * 180 / Math.PI],
    ['to top left', 360 - Math.atan2(100, 200) * 180 / Math.PI],
  ])('a corner keyword depends on the box aspect ratio: %s', (dir, deg) => {
    close(parse(`linear-gradient(${dir}, red, blue)`)!.line, cssLine(deg, 200, 100));
  });

  it('puts the corner keyword ending point in its corner of a square', () => {
    const [, , x1, y1] = parse('linear-gradient(to bottom right, red, blue)', 0, 100, 0, 100)!.line;
    expect(x1).toBeCloseTo(100, 6);
    expect(y1).toBeCloseTo(100, 6);
  });

  it.each([
    ['0.25turn', 90], ['100grad', 90], [`${Math.PI / 2}rad`, 90], ['-90deg', 270], ['45deg', 45],
  ])('reads the angle unit %s', (angle, deg) => {
    close(parse(`linear-gradient(${angle}, red, blue)`)!.line, cssLine(deg, 200, 100));
  });
});

describe('linear-gradient color stops', () => {
  it('spaces unpositioned stops between their positioned neighbours', () => {
    expect(offsets(parse('linear-gradient(to right, red 20%, blue, green)'))).toEqual([0.2, 0.6, 1]);
    expect(offsets(parse('linear-gradient(to right, red, blue, green 40%, white, black)'))).toEqual([0, 0.2, 0.4, 0.7, 1]);
  });

  it('clamps a stop that precedes an earlier one up to it', () => {
    expect(offsets(parse('linear-gradient(to right, red 60%, blue 20%)'))).toEqual([0.6, 0.6]);
  });

  it('keeps a repeated position as a hard step, in order', () => {
    const r = parse('linear-gradient(to right, red 50%, blue 50%)')!;
    expect(r.stops).toEqual([[0.5, 'red'], [0.5, 'blue']]);
  });

  it('reads a two-position stop as two stops', () => {
    const r = parse('linear-gradient(to right, red 0 50%, blue 50% 100%)')!;
    expect(r.stops).toEqual([[0, 'red'], [0.5, 'red'], [0.5, 'blue'], [1, 'blue']]);
  });

  it('reads px stops against the gradient line length', () => {
    expect(offsets(parse('linear-gradient(to right, red 0px, blue 100px)'))).toEqual([0, 0.5]);
  });

  it('keeps a color with commas and a percentage', () => {
    const r = parse('linear-gradient(to right, rgba(0, 0, 0, 0.5) 10%, rgb(1 2 3) 90%)')!;
    expect(r.stops).toEqual([[0.1, 'rgba(0, 0, 0, 0.5)'], [0.9, 'rgb(1 2 3)']]);
  });

  it('extends the gradient line over stops outside 0-100% instead of dropping them', () => {
    const r = parse('linear-gradient(to right, red -50%, blue 150%)')!;
    // 0% is x=0 and 100% is x=200; the stops sit at -100 and 300.
    close(r.line, [-100, 50, 300, 50]);
    expect(r.stops).toEqual([[0, 'red'], [1, 'blue']]);
    const s = parse('linear-gradient(to right, red -50%, white 50%, blue 100%)')!;
    close(s.line, [-100, 50, 200, 50]);
    expect(offsets(s)).toEqual([0, 0.666667, 1]);
  });

  it('ignores a color hint (the transition stays linear, midpoint halfway)', () => {
    const r = parse('linear-gradient(to right, red, 30%, blue)')!;
    expect(r.stops).toEqual([[0, 'red'], [1, 'blue']]);
  });

  it('returns null without at least one color', () => {
    expect(parse('linear-gradient(to right)')).toBeNull();
  });
});

describe('repeating-linear-gradient', () => {
  it('tiles the stop list over the whole line', () => {
    // 200px line, period 40px: five tiles, each red 0-20px then blue.
    const r = parse('repeating-linear-gradient(to right, red 0 20px, blue 20px 40px)')!;
    close(r.line, [0, 50, 200, 50]);
    expect(r.stops.length).toBe(20);
    expect(r.stops.slice(0, 5)).toEqual([[0, 'red'], [0.1, 'red'], [0.1, 'blue'], [0.2, 'blue'], [0.2, 'red']]);
  });

  it('keeps tile seams in order when the period does not divide evenly', () => {
    const r = parse('repeating-linear-gradient(90deg, red, lime 15px, blue 45px)', 0, 600, 0, 120)!;
    const o = r.stops.map(([offset]) => offset);
    for (let i = 1; i < o.length; i++) expect(o[i]).toBeGreaterThanOrEqual(o[i - 1]);
    // Every seam is blue then red, never red first.
    for (let i = 3; i < r.stops.length; i += 3) expect([r.stops[i - 1][1], r.stops[i][1]]).toEqual(['blue', 'red']);
  });

  it('paints a zero period as its last color', () => {
    expect(parse('repeating-linear-gradient(to right, red 30%, blue 30%)')!.stops).toEqual([[0, 'blue'], [1, 'blue']]);
  });
});

describe('function name case', () => {
  it('matches the function name case-insensitively, repeating- prefix included', () => {
    expect(parse('LINEAR-GRADIENT(90deg, red, blue)')).toEqual(parse('linear-gradient(90deg, red, blue)'));
    const lower = parse('repeating-linear-gradient(to right, red 0 20px, blue 20px 40px)');
    expect(parse('Repeating-Linear-Gradient(to right, red 0 20px, blue 20px 40px)')).toEqual(lower);
  });
});
