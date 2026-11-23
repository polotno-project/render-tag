/**
 * `linear-gradient` parsing against the browser's own gradient, sampled
 * through `background-clip: text` (the one place render-tag paints a
 * gradient). Glyph edges differ between the canvas and the DOM, so only
 * pixels fully inside a glyph in BOTH images are compared, by color.
 *
 * The arithmetic is pinned in tests/node/linear-gradient.test.ts; this file
 * checks the result is the engine's: corner keywords that depend on the box
 * aspect ratio, unpositioned and out-of-range stops, hard stops, angle units,
 * repeating gradients. Radial gradients (tests/node/radial-gradient.test.ts)
 * match it in every shape and size on the 600×120 box: circles, and the
 * ellipses a raster canvas paints as a pattern.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';
import { isFirefox, isWebKit } from './helpers/browser-name.ts';

/** Mean per-channel color difference (0-255) over pixels opaque in both. */
function colorError(a: HTMLCanvasElement, b: HTMLCanvasElement): { error: number; pixels: number } {
  const { width, height } = a;
  const da = a.getContext('2d')!.getImageData(0, 0, width, height).data;
  const db = b.getContext('2d')!.getImageData(0, 0, width, height).data;
  let sum = 0, pixels = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i + 3] < 255 || db[i + 3] < 255) continue;
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    pixels++;
  }
  return { error: pixels ? sum / pixels / 3 : Infinity, pixels };
}

const GRADIENTS = [
  'linear-gradient(to top right, red, blue)',
  'linear-gradient(to bottom left, #f00, #0f0, #00f)',
  'linear-gradient(to right, red 20%, lime, blue)',
  'linear-gradient(to right, red, lime 30%, yellow, black, blue)',
  'linear-gradient(to right, red -50%, blue 150%)',
  'linear-gradient(to right, red -20%, lime 50%, blue 120%)',
  'linear-gradient(to right, red 50%, blue 50%)',
  'linear-gradient(to right, red 60%, blue 20%)',
  'linear-gradient(to right, red 0 30%, lime 30% 60%, blue 60%)',
  'linear-gradient(0.3turn, red, blue)',
  'linear-gradient(to right, red 0px, blue 200px)',
  // Repeating: the stop list tiles the gradient line, both ways.
  'repeating-linear-gradient(to right, red 0 20px, blue 20px 40px)',
  'repeating-linear-gradient(to right, red 10%, blue 30%)',
  'repeating-linear-gradient(30deg, red, lime 15px, blue 45px)',
  'linear-gradient(30deg, red, lime 15px, blue 45px)',
  'repeating-linear-gradient(30deg, red, lime 150px, blue 450px)',
  'repeating-linear-gradient(90deg, red, lime 15px, blue 45px)',
  'repeating-linear-gradient(30deg, red 0 20px, blue 20px 40px)',
  // Stops in other lengths and math functions; a single stop.
  'linear-gradient(to right, red 0 1in, blue 1in)',
  'linear-gradient(to right, red calc(10px + 10%), blue 3em)',
  'linear-gradient(red)',
];

const RADIAL_GRADIENTS = [
  'radial-gradient(circle at 20% 80%, red, blue)',
  'radial-gradient(circle, red, lime 40%, blue)',
  'radial-gradient(circle at right top, red 10%, blue 90%)',
  'radial-gradient(circle at 100px 30px, red, blue 300px)',
  'radial-gradient(circle farthest-corner at 30% 60%, red 0 30%, blue 30%)',
  'radial-gradient(circle at 70% 20%, red, blue 150%)',
  'repeating-radial-gradient(circle at 30% 40%, red 0 20px, blue 20px 40px)',
  // A stop before the centre: the colour there is mixed from the stops either side.
  'radial-gradient(circle, red -100%, blue 100%)',
  // A missing component takes the other stop's, as Chrome and Gecko mix it.
  // WebKit's own paint does not carry it (error 30), and render-tag paints
  // Chrome's in every browser.
  ...(isWebKit ? [] : ['radial-gradient(circle, rgb(none 0 0) -100%, red 100%)']),
  'radial-gradient(circle, rgb(calc(255) 0 0) -100%, blue 100%)',
  // Circle extents and lengths.
  'radial-gradient(circle closest-side at 30% 40%, red, blue)',
  'radial-gradient(circle farthest-side at 30% 40%, red, blue)',
  'radial-gradient(circle closest-corner at 30% 40%, red, blue)',
  'radial-gradient(circle 80px at 30% 40%, red, blue)',
  // Positions: edge offsets, a math function, another unit.
  'radial-gradient(circle at right 100px bottom 20px, red, blue)',
  'radial-gradient(circle at calc(20% + 10px) 80%, red, blue)',
  'radial-gradient(circle at 1in 0.5in, red, blue)',
  // Font units, on the declaring element's 96px font.
  'radial-gradient(circle 2em at 1em 0.5em, red, blue)',
  // The stop inside the shape: WebKit on macOS 26 pads its own drawing with the color before a
  // hard stop at exactly 100% (red here), where Chrome and render-tag paint the one after.
  'radial-gradient(1em 0.5em at 30% 40%, red 0 0.5em, blue 0.5em)',
  'radial-gradient(circle 100px, red 0 0.5in, blue 0.5in)',
  'radial-gradient(red)',
  // The first layer paints over the rest.
  'radial-gradient(circle, red, blue), linear-gradient(lime, lime)',
  'linear-gradient(to right, red, blue), radial-gradient(circle, lime, lime)',
  // Ellipses: the default, each extent, lengths, and tiles out to the far corner.
  'radial-gradient(red, blue)',
  'radial-gradient(red, lime 40%, blue)',
  'radial-gradient(at 20% 80%, red, blue)',
  'radial-gradient(ellipse closest-side at 30% 40%, red, blue)',
  'radial-gradient(farthest-side at 30% 40%, red, blue)',
  'radial-gradient(closest-corner at 70% 20%, red, blue)',
  'radial-gradient(40% 80% at 30% 40%, red, blue)',
  'radial-gradient(200px 30px, red 0 50%, blue 50%)',
  'radial-gradient(ellipse at 100px 30px, red, blue 300px)',
  'repeating-radial-gradient(at 30% 40%, red 0 20px, blue 20px 40px)',
  'repeating-radial-gradient(10% 20% at 0 0, red 0 50%, blue 50% 100%)',
  // Zero-size shapes are one colour as Chrome paints them: the last stop, or the
  // average of a repeating one whose percentages collapse onto the zero ray.
  // Each engine paints its own (error 102 against a limit of 3): WebKit none of
  // these, Gecko not the average; render-tag paints Chrome's in every browser.
  ...(isWebKit ? [] : [
    'radial-gradient(0px 50px, red 0px, blue 100px)',
    'repeating-radial-gradient(100px 0px, red 0 10px, blue 10px 40px)',
  ]),
  ...(isWebKit || isFirefox ? [] : [
    'repeating-radial-gradient(circle 0px, red, lime 20%, blue)',
    'repeating-radial-gradient(circle closest-side at 0 50%, red, blue)',
  ]),
];

describe.each([
  ['linear-gradient', GRADIENTS],
  ['radial-gradient', RADIAL_GRADIENTS],
])('%s matches the browser', (_kind, gradients) => {
  it.each(gradients)('%s', async (gradient) => {
    const css = await loadMultiFontCss();
    const html =
      `<div style="font-family:'Open Sans';font-weight:800;font-size:96px;line-height:120px;width:600px;` +
      `background-image:${gradient};-webkit-background-clip:text;background-clip:text;color:transparent">MMMMM</div>`;
    const r = await compareNativeRenders(html, css, 640, 140, 0.1, 1);
    const { error, pixels } = colorError(r.libCanvas, r.domCanvas);
    expect(pixels, 'opaque glyph pixels').toBeGreaterThan(5000);
    // Gradient dithering and 8-bit interpolation differ by a level or two.
    expect(error).toBeLessThan(3);
  });
});

describe('radial-gradient ellipse matches the browser at pixelRatio 2', () => {
  // The pattern is drawn at device resolution, so a hard stop stays sharp.
  it.each([
    'radial-gradient(farthest-side at 30% 40%, red, blue)',
    'radial-gradient(200px 30px, red 0 50%, blue 50%)',
  ])('%s', async (gradient) => {
    const css = await loadMultiFontCss();
    const html =
      `<div style="font-family:'Open Sans';font-weight:800;font-size:96px;line-height:120px;width:600px;` +
      `background-image:${gradient};-webkit-background-clip:text;background-clip:text;color:transparent">MMMMM</div>`;
    const r = await compareNativeRenders(html, css, 640, 140, 0.1, 2);
    const { error, pixels } = colorError(r.libCanvas, r.domCanvas);
    expect(pixels, 'opaque glyph pixels').toBeGreaterThan(20000);
    expect(error).toBeLessThan(3);
  });
});
