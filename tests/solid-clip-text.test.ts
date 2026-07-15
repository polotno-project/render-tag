/**
 * background-clip:text with a SOLID background-color (no gradient image).
 *
 * Chrome clips the color to the glyphs. The renderer used to ignore the clip
 * for solid colors and fillRect the raw background — a full-width colored
 * band painted over the content instead of colored text.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';

function countPixels(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

const isRed = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100;

describe('background-clip: text with solid background-color', () => {
  it('block declarer: paints red glyphs, not a full-width red band', () => {
    const { canvas } = render({
      html: '<div style="font-size: 40px; background-color: red; -webkit-background-clip: text; color: transparent;">Solid</div>',
      width: 300,
      pixelRatio: 1,
    });
    const red = countPixels(canvas, isRed);
    // Glyphs only: a few thousand px. The old fillRect band was ~13800.
    expect(red).toBeGreaterThan(200);
    expect(red).toBeLessThan(8000);
  });

  it('inline declarer with nested inline child: text still paints', () => {
    const { canvas } = render({
      html: '<p style="font-size: 40px;">He<s style="background-color: red; -webkit-background-clip: text; -webkit-text-fill-color: transparent;"><u>ader</u></s></p>',
      width: 300,
      pixelRatio: 1,
    });
    expect(countPixels(canvas, isRed)).toBeGreaterThan(200);
  });
});
