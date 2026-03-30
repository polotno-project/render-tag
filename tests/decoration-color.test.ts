/**
 * Test that text-decoration colors are preserved from CSS.
 *
 * Regression test: the CSS resolver's expandShorthand for text-decoration
 * split on whitespace, breaking rgb() color values like "rgb(231, 76, 60)"
 * into fragments. The color was lost and decorations rendered black.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';

/**
 * Count pixels matching a color predicate across the entire canvas.
 * Skips transparent (a < 128) and near-white (r,g,b > 240) pixels.
 */
function countColoredPixels(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    if (r > 240 && g > 240 && b > 240) continue;
    if (predicate(r, g, b)) count++;
  }
  return count;
}

describe('text-decoration color', () => {
  it('should render underline in red, not black', () => {
    const html = `<p style="font-size: 20px; line-height: 3;"><span style="text-decoration: underline #e74c3c;">Red underline</span></p>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });

    const redPixels = countColoredPixels(canvas, (r, g, b) => r > 150 && g < 100 && b < 100);
    expect(redPixels).toBeGreaterThan(10);
  });

  it('should render wavy underline in blue, not black', () => {
    const html = `<p style="font-size: 20px; line-height: 3;"><span style="text-decoration: underline wavy #3498db;">Blue wavy</span></p>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });

    const bluePixels = countColoredPixels(canvas, (r, g, b) => b > 150 && r < 100);
    expect(bluePixels).toBeGreaterThan(10);
  });

  it('should render dotted underline in green, not black', () => {
    const html = `<p style="font-size: 20px; line-height: 3;"><span style="text-decoration: underline dotted #27ae60;">Green dotted</span></p>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });

    const greenPixels = countColoredPixels(canvas, (r, g, b) => g > 100 && r < 80 && b < 120);
    expect(greenPixels).toBeGreaterThan(5);
  });
});
