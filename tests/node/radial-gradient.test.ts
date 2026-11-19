/**
 * `radial-gradient` as CSS draws it (CSS Images 3 §3.2): a circle or an
 * ellipse sized by its extent keyword or lengths, centred at its `at`
 * position, painted over the same box a linear gradient uses at each site
 * (the block box, an inline fragment, the `--rt-text-stroke-image` box, and on
 * a path the declarer's glyphs as laid out there). A circle is a canvas
 * radial gradient; an ellipse is one at the origin handed its transform
 * through the gradient's `setTransform` when the ctx's gradients have one (a
 * vector adapter), a pattern on a raster canvas, else the circle of its
 * horizontal radius. The arithmetic runs on a fake ctx that records the
 * gradient; the paint sites on the recording ctx. The forms are checked
 * against Chrome's pixels in tests/gradient-parity.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { createCanvas } from '@napi-rs/canvas';
import { gradientKind, parseGradient, parseLinearGradient, parseRadialGradient, radialGradientGeometry, radialPaint } from '../../src/gradient.ts';
import { layout, drawLayout, setDOMParser } from '../../src/index.ts';
import { layoutTextOnPath, drawTextOnPathLayout } from '../../src/path/index.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

interface Recorded {
  kind: 'linear' | 'radial';
  args: number[];
  stops: [number, string][];
  transform?: DOMMatrix2DInit;
}

/** What `parse` builds on a fake ctx; `transforms`: its gradients take a `setTransform`, as a vector adapter's may. */
function record(
  parse: typeof parseGradient, image: string, x = 0, width = 480, y = 0, height = 200, transforms = true,
): Recorded | null {
  let rec: Recorded | null = null;
  const gradient = (kind: Recorded['kind']) => (...args: number[]) => {
    rec = { kind, args, stops: [] };
    return {
      addColorStop(offset: number, color: string) {
        if (!(offset >= 0 && offset <= 1)) throw new RangeError(`offset ${offset}`);
        rec!.stops.push([offset, color]);
      },
      ...(transforms && { setTransform(m: DOMMatrix2DInit) { rec!.transform = m; } }),
    };
  };
  const ctx = {
    createLinearGradient: gradient('linear'),
    createRadialGradient: gradient('radial'),
  } as unknown as CanvasRenderingContext2D;
  parse(ctx, image, x, width, y, height);
  return rec;
}

/** A ctx that builds no gradient: a solid paint needs none. */
const NO_GRADIENTS = {} as CanvasRenderingContext2D;

const radial = (image: string, x?: number, width?: number, y?: number, height?: number) =>
  record(parseRadialGradient, image, x, width, y, height);

/** The circle a radial gradient draws: [cx, cy, r]. */
function circle(r: Recorded | null): number[] {
  expect(r?.kind).toBe('radial');
  expect(r!.transform).toBeUndefined();
  const [x0, y0, r0, x1, y1, r1] = r!.args;
  expect([x1, y1, r0]).toEqual([x0, y0, 0]);
  return [x0, y0, r1];
}

/** The ellipse a radial gradient draws through its transform: [cx, cy, rx, ry]. */
function ellipse(r: Recorded | null): number[] {
  expect(r?.kind).toBe('radial');
  expect(r!.args).toEqual([0, 0, 0, 0, 0, r!.args[5]]);
  const { a, b, c, d, e, f } = r!.transform!;
  close([a!, b!, c!], [1, 0, 0]);
  return [e!, f!, r!.args[5], r!.args[5] * d!];
}

const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

describe('radial-gradient geometry', () => {
  it('reaches the farthest corner from an off-centre centre on a non-square box', () => {
    // 480×200 at 20% 80%: centre (96, 160); the farthest corner is the top
    // right (480, 0), 416px away. Half the diagonal would be 260.
    close(circle(radial('radial-gradient(circle at 20% 80%, red, blue)')), [96, 160, 416]);
  });

  it('offsets the centre by the box origin', () => {
    close(circle(radial('radial-gradient(circle at 20% 80%, red, blue)', 10, 480, 30, 200)), [106, 190, 416]);
  });

  it('draws the default ellipse through the farthest corner, its aspect the farthest sides\'', () => {
    // Centre (240, 100): sides 240 and 100, so rx = 240√2, ry = 100√2.
    close(ellipse(radial('radial-gradient(red, blue)')), [240, 100, 240 * Math.SQRT2, 100 * Math.SQRT2]);
  });

  // 480×200 at 20% 80%: centre (96, 160); sides left 96, right 384, top 160,
  // bottom 40; corners at 186.6 (top left), 416 (top right), 104 (bottom
  // left) and 386 (bottom right).
  it.each([
    ['ellipse at 20% 80%', [384 * Math.SQRT2, 160 * Math.SQRT2]],
    ['at 20% 80%', [384 * Math.SQRT2, 160 * Math.SQRT2]],
    ['ellipse farthest-corner at 20% 80%', [384 * Math.SQRT2, 160 * Math.SQRT2]],
    ['farthest-side at 20% 80%', [384, 160]],
    ['ellipse closest-side at 20% 80%', [96, 40]],
    ['closest-corner at 20% 80%', [96 * Math.SQRT2, 40 * Math.SQRT2]],
    ['50% 30% at 20% 80%', [240, 60]],
    ['ellipse 50% 30% at 20% 80%', [240, 60]],
    ['100px 2.5% at 20% 80%', [100, 5]],
    ['min(10px, 5%) max(1px, 2%) at 20% 80%', [10, 4]],
  ])('sizes the ellipse %s', (config, [rx, ry]) => {
    close(ellipse(radial(`radial-gradient(${config}, red, blue)`)), [96, 160, rx, ry]);
  });

  it.each([
    ['circle at 20% 80%', 416],
    ['circle farthest-corner at 20% 80%', 416],
    ['circle closest-side at 20% 80%', 40],
    ['farthest-side circle at 20% 80%', 384],
    ['closest-corner circle at 20% 80%', 104],
    ['120px at 20% 80%', 120],
    ['circle 120px at 20% 80%', 120],
    ['calc(20px + 10px) at 20% 80%', 30],
    ['circle at 20% 80% in oklab', 416],
  ])('sizes the circle %s', (config, r) => {
    close(circle(radial(`radial-gradient(${config}, red, blue)`)), [96, 160, r]);
  });

  it('measures a centre outside the box by its distance to each side', () => {
    // Centre (-20, 100) on 480×200: the sides are 20, 500, 100 and 100 away.
    close(circle(radial('radial-gradient(circle closest-side at -20px 50%, red, blue)')), [-20, 100, 20]);
    close(circle(radial('radial-gradient(circle farthest-side at -20px 50%, red, blue)')), [-20, 100, 500]);
  });

  it.each([
    'radial-gradient(circle 50% at 20% 80%, red, blue)',
    'radial-gradient(circle 10px 20px, red, blue)',
    'radial-gradient(ellipse 120px, red, blue)',
    'radial-gradient(-10px, red, blue)',
    'radial-gradient(10px 20px 30px, red, blue)',
    'radial-gradient(circle ellipse, red, blue)',
    'radial-gradient(closest-side farthest-side, red, blue)',
    'radial-gradient(closest-side 10px, red, blue)',
  ])('paints nothing for the invalid %s', (image) => {
    expect(radial(image)).toBeNull();
  });

  it('keeps the shape and the default extent for a size it cannot resolve', () => {
    // A viewport or font length has no basis here.
    close(circle(radial('radial-gradient(clamp(1px, 2vw, 30px) at 20% 80%, red, blue)')), [96, 160, 416]);
    close(ellipse(radial('radial-gradient(2em 1em at 20% 80%, red, blue)')),
      [96, 160, 384 * Math.SQRT2, 160 * Math.SQRT2]);
  });

  it('paints a zero-size gradient as its last stop', () => {
    expect(radial('radial-gradient(circle 0px, red, blue)')).toBeNull();
    expect(parseRadialGradient(NO_GRADIENTS, 'radial-gradient(circle 0px, red, blue)', 0, 480, 0, 200)).toBe('blue');
    expect(parseRadialGradient(NO_GRADIENTS, 'radial-gradient(circle closest-side at 0 50%, red, lime)', 0, 480, 0, 200))
      .toBe('lime');
  });

  it.each([
    // Its percentages resolve against a zero ray, so the period is zero: the average, as Chrome paints it.
    ['repeating-radial-gradient(circle 0px, red, blue)', 'rgba(128, 0, 128, 1)'],
    ['repeating-radial-gradient(circle 0px, red, lime 20%, blue)', 'rgba(26, 128, 102, 1)'],
    ['repeating-radial-gradient(circle closest-side at 0 50%, red, blue)', 'rgba(128, 0, 128, 1)'],
    ['repeating-radial-gradient(100px 0px, red 20%, blue 60%)', 'rgba(128, 0, 128, 1)'],
    ['repeating-radial-gradient(circle 0px, rgba(255, 0, 0, 0), blue)', 'rgba(0, 0, 255, 0.5)'],
    // A px period does not collapse: Chrome paints the last stop, as for a plain one.
    ['repeating-radial-gradient(100px 0px, red 0 10px, blue 10px 40px)', 'blue'],
    ['repeating-radial-gradient(0px 50px, red 0 10px, blue 10px 40px)', 'blue'],
    ['radial-gradient(0px 50px, red 0px, blue 100px)', 'blue'],
  ])('paints the zero-size %s as one colour', (image, color) => {
    expect(parseRadialGradient(NO_GRADIENTS, image, 0, 480, 0, 200)).toBe(color);
  });

  it('reads px stops along the horizontal radius of an ellipse', () => {
    const r = radial('radial-gradient(50% 30% at 20% 80%, red 0 60px, blue 60px)');
    close(ellipse(r), [96, 160, 240, 60]);
    expect(r!.stops).toEqual([[0, 'red'], [0.25, 'red'], [0.25, 'blue']]);
  });

  it('tiles a repeating ellipse out to the farthest corner', () => {
    // rx 48, ry 20 at the top left: the far corner is √200 ≈ 14.1 radii out, so 15 tiles.
    const r = radial('repeating-radial-gradient(10% 10% at 0 0, red 0 50%, blue 50% 100%)');
    close(ellipse(r), [0, 0, 48 * 15, 20 * 15]);
    expect(r!.stops).toHaveLength(60);
  });

  it('draws an ellipse as the circle of its horizontal radius where gradients take no transform', () => {
    const r = record(parseRadialGradient, 'radial-gradient(50% 30% at 20% 80%, red, blue)', 0, 480, 0, 200, false);
    close(circle(r), [96, 160, 240]);
  });

  it.each([
    ['center', 240, 100],
    ['left', 0, 100],
    ['right', 480, 100],
    ['top', 240, 0],
    ['bottom', 240, 200],
    ['left top', 0, 0],
    ['top left', 0, 0],
    ['right bottom', 480, 200],
    ['bottom right', 480, 200],
    ['center top', 240, 0],
    ['top center', 240, 0],
    ['left 25%', 0, 50],
    ['75% bottom', 360, 200],
    ['30%', 144, 100],
  ])('reads the keyword position at %s', (position, cx, cy) => {
    const [x, y, r] = circle(radial(`radial-gradient(circle at ${position}, red, blue)`));
    close([x, y], [cx, cy]);
    expect(r).toBeCloseTo(Math.hypot(Math.max(cx, 480 - cx), Math.max(cy, 200 - cy)), 6);
  });

  it('reads px positions as offsets from the box corner', () => {
    close(circle(radial('radial-gradient(circle at 100px 30px, red, blue)', 20, 480, 10, 200)),
      [120, 40, Math.hypot(380, 170)]);
    close(circle(radial('radial-gradient(circle at 0 0, red, blue)')), [0, 0, Math.hypot(480, 200)]);
  });

  it.each([
    'radial-gradient(calc(20px + 10px) at 20% 80%, red, blue)',
    'radial-gradient(min(10px, 5%) max(1px, 2%) at 20% 80%, red, blue)',
    'radial-gradient(clamp(1px, 2vw, 30px) at 20% 80%, red, blue)',
  ])('reads %s as a size and a position, not a stop', (image) => {
    expect(radial(image)!.stops).toEqual([[0, 'red'], [1, 'blue']]);
  });

  it('falls back to the centre for a position it cannot read', () => {
    close(circle(radial('radial-gradient(circle at 2em 1em, red, blue)')), [240, 100, Math.hypot(240, 100)]);
  });

  it('exposes the same shape as geometry', () => {
    expect(radialGradientGeometry('radial-gradient(circle at 20% 80%, red, blue 50%)', 0, 480, 0, 200))
      .toEqual({ cx: 96, cy: 160, rx: 416, ry: 416, stops: [['red', 0], ['blue', 0.5]], box: { x: 0, y: 0, width: 480, height: 200 } });
  });
});

describe('radial-gradient ellipse on a raster canvas', () => {
  const W = 240, H = 100;
  const pixels = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    draw(ctx);
    return ctx.getImageData(0, 0, W, H).data;
  };
  /** The ellipse as canvas itself paints it: a circle under a scaled transform. */
  const reference = (cx: number, cy: number, rx: number, ry: number) => pixels((ctx) => {
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'red');
    g.addColorStop(1, 'blue');
    ctx.fillStyle = g;
    ctx.fillRect(-cx, -cy * rx / ry, W, H * rx / ry);
  });
  const raster = { scale: 1, canvas: (w: number, h: number) => createCanvas(w, h) as unknown as OffscreenCanvas };

  function expectMatch(actual: Uint8ClampedArray, expected: Uint8ClampedArray) {
    let sum = 0, max = 0;
    for (let i = 0; i < actual.length; i++) {
      const d = Math.abs(actual[i] - expected[i]);
      sum += d;
      max = Math.max(max, d);
    }
    expect(sum / actual.length).toBeLessThan(0.5);
    expect(max).toBeLessThanOrEqual(4);
  }

  it('paints a pattern of the ellipse where the gradient takes no transform', () => {
    const geometry = radialGradientGeometry('radial-gradient(closest-side at 40% 50%, red, blue)', 0, W, 0, H)!;
    let kind = '';
    const actual = pixels((ctx) => {
      const paint = radialPaint(ctx, geometry, undefined, raster);
      kind = (paint as object).constructor.name;
      ctx.fillStyle = paint;
      ctx.fillRect(0, 0, W, H);
    });
    expect(kind).toBe('CanvasPattern');
    expectMatch(actual, reference(96, 50, 96, 50));
  });

  it('places the pattern in a rotated glyph frame', () => {
    // The frame maps layout space into the paint's: here a quarter turn about (120, 50).
    const geometry = radialGradientGeometry('radial-gradient(closest-side at 40% 50%, red, blue)', 0, W, 0, H)!;
    const frame = { a: 0, b: -1, c: 1, d: 0, e: -50, f: 120 };
    const actual = pixels((ctx) => {
      ctx.translate(120, 50);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = radialPaint(ctx, geometry, frame, raster);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(120, 50);
      ctx.rotate(Math.PI / 2);
      ctx.fillRect(-200, -200, 400, 400);
    });
    expectMatch(actual, reference(96, 50, 96, 50));
  });

  it('builds no pattern without a scratch canvas: the circle of its horizontal radius', () => {
    const geometry = radialGradientGeometry('radial-gradient(closest-side at 40% 50%, red, blue)', 0, W, 0, H)!;
    pixels((ctx) => {
      expect((radialPaint(ctx, geometry) as object).constructor.name).toBe('CanvasGradient');
    });
  });
});

describe('radial-gradient color stops', () => {
  const stops = (image: string) => radial(image)!.stops.map(([o, c]) => [+o.toFixed(6), c]);

  it('spaces unpositioned stops as the linear parser does', () => {
    expect(stops('radial-gradient(circle, red 20%, lime, blue)')).toEqual([[0.2, 'red'], [0.6, 'lime'], [1, 'blue']]);
    expect(stops('radial-gradient(red, lime, blue)')).toEqual([[0, 'red'], [0.5, 'lime'], [1, 'blue']]);
  });

  it('reads color names that start like a keyword as colors', () => {
    expect(stops('radial-gradient(indigo, indianred)')).toEqual([[0, 'indigo'], [1, 'indianred']]);
  });

  it('reads px stops against the radius', () => {
    // 416px radius.
    expect(stops('radial-gradient(circle at 20% 80%, red 0 104px, blue 104px)'))
      .toEqual([[0, 'red'], [0.25, 'red'], [0.25, 'blue']]);
  });

  it('widens the circle over stops past 100%', () => {
    const r = radial('radial-gradient(circle at 20% 80%, red, blue 200%)');
    close(circle(r), [96, 160, 832]);
    expect(r!.stops).toEqual([[0, 'red'], [1, 'blue']]);
  });

  it('pads past the last stop inside 100%', () => {
    const r = radial('radial-gradient(circle at 20% 80%, red, blue 50%)');
    close(circle(r), [96, 160, 416]);
    expect(r!.stops).toEqual([[0, 'red'], [0.5, 'blue']]);
  });

  it('opens with the colour CSS interpolates at the centre for a stop before it', () => {
    // Half way from red to blue; the stop before the centre is cut there.
    expect(stops('radial-gradient(red -100%, blue 100%)')).toEqual([[0, 'rgba(128, 0, 128, 1)'], [1, 'blue']]);
    expect(stops('radial-gradient(hsl(120 100% 25%) -50%, #00f 50%)')).toEqual([[0, 'rgba(0, 64, 128, 1)'], [0.5, '#00f']]);
    // Premultiplied, as CSS mixes: transparent red takes on blue's hue.
    expect(stops('radial-gradient(rgba(255, 0, 0, 0) -100%, blue 100%)')).toEqual([[0, 'rgba(0, 0, 255, 0.5)'], [1, 'blue']]);
    expect(stops('radial-gradient(red -50%, lime -10%, blue 100%)'))
      .toEqual([[0, 'rgba(0, 232, 23, 1)'], [1, 'blue']]);
    expect(stops('radial-gradient(red -50%, blue -10%)')).toEqual([[0, 'blue']]);
  });

  it('takes a missing component from the other stop when mixing at the centre', () => {
    // rgb()'s `none` red is red's 255 throughout: full red, not half.
    expect(stops('radial-gradient(rgb(none 0 0) -100%, red 100%)')).toEqual([[0, 'rgba(255, 0, 0, 1)'], [1, 'red']]);
    expect(stops('radial-gradient(rgb(255 0 0 / none) -100%, rgba(0, 0, 255, 0.5) 100%)'))
      .toEqual([[0, 'rgba(128, 0, 128, 0.5)'], [1, 'rgba(0, 0, 255, 0.5)']]);
    // An hsl() `none` is 0, not carried: hsl(none 100% 50%) is red.
    expect(stops('radial-gradient(hsl(none 100% 50%) -100%, blue 100%)')).toEqual([[0, 'rgba(128, 0, 128, 1)'], [1, 'blue']]);
  });

  it('reads math functions in a stop colour\'s channels', () => {
    expect(stops('radial-gradient(rgb(calc(255) 0 0) -100%, blue 100%)')).toEqual([[0, 'rgba(128, 0, 128, 1)'], [1, 'blue']]);
    expect(stops('radial-gradient(rgb(calc(510 / 2), 0, min(0, 9)) -100%, blue 100%)'))
      .toEqual([[0, 'rgba(128, 0, 128, 1)'], [1, 'blue']]);
    expect(stops('radial-gradient(rgb(calc(50% + 50%) 0 0 / calc(1 / 2)) -100%, blue 100%)'))
      .toEqual([[0, 'rgba(85, 0, 170, 0.75)'], [1, 'blue']]);
    // A length is no channel: the stop is left unmixed, as before.
    expect(stops('radial-gradient(rgb(calc(255px) 0 0) -100%, blue 100%)')[0]).toEqual([0, 'rgb(calc(255px) 0 0)']);
  });

  it('cuts a repeating radial\'s first tile at the centre', () => {
    // Period 40% starting at -30%: the centre is 3/4 of the way from red to blue.
    // The last tile ends at 130%, which widens the circle by 1.3.
    expect(stops('repeating-radial-gradient(circle, red -30%, blue 10%)').slice(0, 3))
      .toEqual([[0, 'rgba(64, 0, 191, 1)'], [+(0.1 / 1.3).toFixed(6), 'blue'], [+(0.1 / 1.3).toFixed(6), 'red']]);
  });

  it('tiles a repeating radial over the circle', () => {
    const r = radial('repeating-radial-gradient(circle at 20% 80%, red 0 10%, blue 10% 20%)')!;
    expect(r.stops.length).toBe(20);
    expect(r.stops.at(-1)).toEqual([1, 'blue']);
  });

  it('returns null without a color', () => {
    expect(radial('radial-gradient(circle at 20% 80%)')).toBeNull();
  });
});

describe('parseGradient', () => {
  it('draws a radial gradient', () => {
    expect(record(parseGradient, 'radial-gradient(circle at 20% 80%, red, blue)')!.kind).toBe('radial');
  });

  it.each([
    'linear-gradient(to right, red, blue)',
    'repeating-linear-gradient(30deg, red, lime 15px, blue 45px)',
    'radial-gradient(red, blue), linear-gradient(to right, red, blue)',
  ])('draws %s exactly as parseLinearGradient', (image) => {
    const viaDispatch = record(parseGradient, image);
    expect(viaDispatch!.kind).toBe('linear');
    expect(viaDispatch).toEqual(record(parseLinearGradient, image));
  });
});

describe('gradient detection', () => {
  it('reads a gradient only from its function call, never from a url path', () => {
    const url = "url('/x/radial-gradients/a.png')";
    expect(gradientKind(url)).toBeNull();
    expect(record(parseGradient, url)).toBeNull();
    expect(gradientKind("url('/x/linear-gradients/a.png')")).toBeNull();
  });

  it.each([
    "url('/x/radial-gradient(red,blue).png')",
    'url("/x/repeating-radial-gradient(red,blue).png")',
    'url(/x/radial-gradient(red,blue).png)',
    'image-set("/x/radial-gradient(red,blue).png" 1x)',
  ])('reads no gradient from a file path that names one: %s', (image) => {
    expect(gradientKind(image)).toBeNull();
    expect(record(parseGradient, image)).toBeNull();
  });

  it('paints a radial layer beside a url that names a linear gradient', () => {
    const image = "url('/x/linear-gradient(to right, red, blue).png'), radial-gradient(circle at 20% 80%, red, blue)";
    expect(gradientKind(image)).toBe('radial');
    close(circle(record(parseGradient, image)), [96, 160, 416]);
  });

  it('paints the gradient beside a url layer', () => {
    const image = "url('/x/radial-gradients/a.png'), radial-gradient(circle at 20% 80%, red, blue)";
    expect(gradientKind(image)).toBe('radial');
    close(circle(record(parseGradient, image)), [96, 160, 416]);
  });

  it('paints a url-only clip background as its solid color', () => {
    const fills = paint(`<div style="font-size:40px;background-color:lime;background-image:url('/x/radial-gradients/a.png');${CLIP}">Text</div>`)
      .filter((p) => p.startsWith('fillText('));
    expect(fills.length).toBeGreaterThan(0);
    for (const p of fills) expect(p).not.toMatch(/fillStyle=(radial|linear)\(/);
  });
});

/** The gradients the recording ctx painted text with, as `kind(args|stops)`. */
function gradientsOf(paints: string[], prop: 'fillStyle' | 'strokeStyle', kind: string): string[] {
  const re = new RegExp(`${prop}=(${kind}\\([^)]*\\)(?:@[^;]*)?)`);
  return [...new Set(paints.filter((p) => /^(fillText|strokeText)\(/.test(p))
    .map((p) => re.exec(p)?.[1]).filter((g): g is string => !!g))];
}

const numbers = (gradient: string) => /\(([^|]*)\|/.exec(gradient)![1].split(',').map(Number);

function paint(html: string, width = 480) {
  setDOMParser(new LinkedomDOMParser());
  const result = layout({ html, width, ctx: recordingCtx(width, 400).ctx });
  const painted = recordingCtx(width, 400);
  drawLayout({ layout: result, width, ctx: painted.ctx, createCanvas: painted.createCanvas });
  return painted.paints;
}

/**
 * The box a linear gradient spans at a site, read back from `to right`
 * (x0, x1 at mid-height) and `to bottom` (y0, y1 at mid-width): radial must
 * paint over the same one.
 */
function linearBox(html: (image: string) => string, prop: 'fillStyle' | 'strokeStyle') {
  const [h] = gradientsOf(paint(html('linear-gradient(to right, red, blue)')), prop, 'linear');
  const [v] = gradientsOf(paint(html('linear-gradient(to bottom, red, blue)')), prop, 'linear');
  const [x0, , x1] = numbers(h), [, y0, , y1] = numbers(v);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function expectCircleOver(gradient: string, box: { x: number; y: number; width: number; height: number }) {
  const [cx, cy, r0, cx1, cy1, r] = numbers(gradient);
  const ox = 0.2 * box.width, oy = 0.8 * box.height;
  close([cx, cy, r0, cx1, cy1, r], [
    box.x + ox, box.y + oy, 0, box.x + ox, box.y + oy,
    Math.hypot(Math.max(ox, box.width - ox), Math.max(oy, box.height - oy)),
  ]);
}

const RADIAL = 'radial-gradient(circle at 20% 80%, red, blue)';
const CLIP = '-webkit-background-clip:text;background-clip:text;color:transparent';

describe('radial-gradient paint sites', () => {
  it('fills block text with the circle over the block box', () => {
    const html = (image: string) =>
      `<div style="width:480px;font-size:40px;line-height:50px;background-image:${image};${CLIP}">Radial text</div>`;
    const box = linearBox(html, 'fillStyle');
    expect(box.width).toBeCloseTo(480, 6);
    const fills = gradientsOf(paint(html(RADIAL)), 'fillStyle', 'radial');
    expect(fills).toHaveLength(1);
    expectCircleOver(fills[0], box);
    expect(fills[0]).toMatch(/\|0 red,1 blue\)$/);
  });

  it('fills an inline span with the circle over its fragment', () => {
    const html = (image: string) =>
      `<p style="margin:0;font-size:20px;line-height:40px">ab <span style="background-image:${image};${CLIP}">cd ef</span> gh</p>`;
    const box = linearBox(html, 'fillStyle');
    expect(box.x).toBeGreaterThan(0);
    const fills = gradientsOf(paint(html(RADIAL)), 'fillStyle', 'radial');
    expect(fills).toHaveLength(1);
    expectCircleOver(fills[0], box);
  });

  /** An ellipse placed by its gradient's transform: [cx, cy, rx, ry]. */
  function placedEllipse(gradient: string): number[] {
    const m = /^radial\(([^|]*)\|[^)]*\)@(.*)$/.exec(gradient);
    expect(m, gradient).not.toBeNull();
    const [x0, y0, r0, x1, y1, r] = m![1].split(',').map(Number);
    expect([x0, y0, r0, x1, y1]).toEqual([0, 0, 0, 0, 0]);
    const [a, b, c, d, e, f] = m![2].split(',').map(Number);
    close([a, b, c], [1, 0, 0]);
    return [e, f, r, r * d];
  }

  it('fills block text with the ellipse over the block box, placed by the gradient\'s transform', () => {
    const html = (image: string) =>
      `<div style="width:480px;font-size:40px;line-height:50px;background-image:${image};${CLIP}">Radial text</div>`;
    const box = linearBox(html, 'fillStyle');
    const fills = gradientsOf(paint(html('radial-gradient(farthest-side at 20% 80%, red, blue)')), 'fillStyle', 'radial');
    expect(fills).toHaveLength(1);
    close(placedEllipse(fills[0]), [box.x + 0.2 * box.width, box.y + 0.8 * box.height, 0.8 * box.width, 0.8 * box.height]);
  });

  it('strokes with the ellipse over the --rt-text-stroke-image box', () => {
    const html = (image: string) =>
      `<div style="font-size:40px;line-height:50px;color:white;-webkit-text-stroke:4px black;--rt-text-stroke-image:${image}">Stroke</div>`;
    const box = linearBox(html, 'strokeStyle');
    const strokes = gradientsOf(paint(html('radial-gradient(closest-side, red, blue)')), 'strokeStyle', 'radial');
    expect(strokes).toHaveLength(1);
    close(placedEllipse(strokes[0]), [box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2]);
  });

  it('strokes with the circle over the --rt-text-stroke-image box', () => {
    const html = (image: string) =>
      `<div style="font-size:40px;line-height:50px;color:white;-webkit-text-stroke:4px black;--rt-text-stroke-image:${image}">Stroke</div>`;
    const box = linearBox(html, 'strokeStyle');
    const strokes = gradientsOf(paint(html(RADIAL)), 'strokeStyle', 'radial');
    expect(strokes).toHaveLength(1);
    expectCircleOver(strokes[0], box);
  });
});

describe('radial-gradient on a path', () => {
  const PATH = 'M20,160 Q240,0 460,160';

  /** Each glyph's gradient centre and radius, mapped from its frame back to layout space. */
  function circles(html: string, prop: 'fillStyle' | 'strokeStyle') {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(480, 240);
    const result = layoutTextOnPath({ html, path: PATH, ctx: rec.ctx });
    drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
    const ops = rec.paints.filter((p) => p.startsWith(prop === 'fillStyle' ? 'fillText(' : 'strokeText('));
    expect(ops.length).toBe(result.glyphs.length);
    const out = ops.map((p) => {
      const m = new RegExp(`${prop}=radial\\(([^|]*)\\|`).exec(p);
      expect(m, p).not.toBeNull();
      const [lx, ly, , , , r] = m![1].split(',').map(Number);
      const [a, b, c, d, e, f] = /matrix=([^;|]*)/.exec(p)![1].split(',').map(Number);
      return [a * lx + c * ly + e, b * lx + d * ly + f, r];
    });
    return { bounds: result.bounds, out };
  }

  function expectOneCircle({ bounds, out }: ReturnType<typeof circles>) {
    const ox = 0.2 * bounds.width, oy = 0.8 * bounds.height;
    const expected = [bounds.x + ox, bounds.y + oy,
      Math.hypot(Math.max(ox, bounds.width - ox), Math.max(oy, bounds.height - oy))];
    for (const c of out) close(c, expected);
  }

  it('fills every glyph from one circle over the laid-out text', () => {
    expectOneCircle(circles(`<span style="font-size:40px;background-image:${RADIAL};${CLIP}">Curved</span>`, 'fillStyle'));
  });

  /** The outer radial's circle for each of its own glyphs (the B glyphs paint a linear gradient). */
  function outerCircles(html: string) {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(480, 240);
    const result = layoutTextOnPath({ html, path: PATH, ctx: rec.ctx });
    drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
    const ops = rec.paints.filter((p) => p.startsWith('fillText(') && !/^fillText\("B"/.test(p));
    const out = ops.map((p) => {
      const m = /fillStyle=radial\(([^|]*)\|/.exec(p);
      expect(m, p).not.toBeNull();
      const [lx, ly, , , , r] = m![1].split(',').map(Number);
      const [a, b, c, d, e, f] = /matrix=([^;|]*)/.exec(p)![1].split(',').map(Number);
      return [a * lx + c * ly + e, b * lx + d * ly + f, r];
    });
    return { bounds: result.bounds, out };
  }
  const OWN = `background-image:linear-gradient(red, blue);${CLIP}`;

  it.each([
    ['around', `AA<span style="${OWN}">BB</span>CC`, 4],
    ['at the end of', `AA<span style="${OWN}">BBBB</span>`, 2],
  ])('spans one circle over the declarer\'s glyphs %s a descendant with its own paint', (_, inner, own) => {
    const circles = outerCircles(`<span style="font-size:40px;background-image:${RADIAL};${CLIP}">${inner}</span>`);
    expect(circles.out).toHaveLength(own);
    // The outer span holds every glyph, the B glyphs too, so its circle spans the whole text.
    expectOneCircle(circles);
  });

  it('builds radial gradients only for painted glyphs, none in a shadow mask', () => {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(480, 240);
    const html = `<span style="font-size:40px;text-shadow:2px 2px 3px black;background-image:radial-gradient(circle at 20% 80%, red, lime 30%, blue);${CLIP}">Curved</span>`;
    const result = layoutTextOnPath({ html, path: PATH, ctx: rec.ctx });
    const calls = { gradients: 0, stops: 0 };
    const ctx = new Proxy(rec.ctx, {
      get(target, key) {
        if (key !== 'createRadialGradient') {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: number[]) => {
          calls.gradients++;
          const gradient = target.createRadialGradient(...(args as [number, number, number, number, number, number]));
          const add = gradient.addColorStop.bind(gradient);
          gradient.addColorStop = (offset, color) => { calls.stops++; add(offset, color); };
          return gradient;
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value); },
    });
    const scratchCalls = () => rec.counts.calls.createRadialGradient ?? 0;
    const before = scratchCalls();
    drawTextOnPathLayout({ layout: result, ctx, createCanvas: rec.createCanvas });
    const glyphs = result.glyphs.length;
    expect(rec.paints.some((p) => p.startsWith('drawImage('))).toBe(true);
    // One per glyph on the destination, three stops each; the mask canvases build none.
    expect(calls).toEqual({ gradients: glyphs, stops: 3 * glyphs });
    expect(scratchCalls() - before).toBe(glyphs);
  });

  it('fills every glyph from one ellipse over the laid-out text', () => {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(480, 240);
    const html = `<span style="font-size:40px;background-image:radial-gradient(closest-side, red, blue);${CLIP}">Curved</span>`;
    const result = layoutTextOnPath({ html, path: PATH, ctx: rec.ctx });
    drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
    const ops = rec.paints.filter((p) => p.startsWith('fillText('));
    expect(ops.length).toBe(result.glyphs.length);
    const { x, y, width, height } = result.bounds;
    for (const p of ops) {
      // The ctx's glyph matrix times the gradient's: the ellipse in layout space.
      const [a, b, c, d, e, f] = /matrix=([^;|]*)/.exec(p)![1].split(',').map(Number);
      const m = /fillStyle=radial\(0,0,0,0,0,([^|]*)\|[^)]*\)@([^;]*)/.exec(p);
      expect(m, p).not.toBeNull();
      const r = Number(m![1]);
      const [ga, gb, gc, gd, ge, gf] = m![2].split(',').map(Number);
      close([
        a * ga + c * gb, b * ga + d * gb, a * gc + c * gd, b * gc + d * gd,
        a * ge + c * gf + e, b * ge + d * gf + f, r,
      ], [1, 0, 0, height / width, x + width / 2, y + height / 2, width / 2]);
    }
  });

  it('strokes a zero-size gradient with its one colour', () => {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(480, 240);
    const html = '<span style="font-size:40px;color:white;-webkit-text-stroke:3px black;' +
      '--rt-text-stroke-image:radial-gradient(circle 0px, red, blue)">Curved</span>';
    const result = layoutTextOnPath({ html, path: PATH, ctx: rec.ctx });
    drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
    const strokes = rec.paints.filter((p) => p.startsWith('strokeText('));
    expect(strokes).toHaveLength(result.glyphs.length);
    for (const p of strokes) expect(/strokeStyle=([^;]*)/.exec(p)?.[1]).toBe('"blue"');
  });

  it('strokes every glyph from one circle over the laid-out text', () => {
    expectOneCircle(circles(
      `<span style="font-size:40px;color:white;-webkit-text-stroke:3px black;--rt-text-stroke-image:${RADIAL}">Curved</span>`,
      'strokeStyle'));
  });
});
