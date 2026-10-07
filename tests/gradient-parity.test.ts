/**
 * `linear-gradient` parsing against the browser's own gradient, sampled
 * through `background-clip: text` (the one place render-tag paints a
 * gradient). Glyph edges differ between the canvas and the DOM, so only
 * pixels fully inside a glyph in BOTH images are compared, by color.
 *
 * The arithmetic is pinned in tests/node/linear-gradient.test.ts; this file
 * checks the result is the engine's: corner keywords that depend on the box
 * aspect ratio, unpositioned and out-of-range stops, hard stops, angle units,
 * repeating gradients.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';

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
];

describe('linear-gradient matches the browser', () => {
  it.each(GRADIENTS)('%s', async (gradient) => {
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
