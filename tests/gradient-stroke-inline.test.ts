/**
 * -webkit-text-stroke-image (via --rt-text-stroke-image) declared on an INLINE
 * element. The property doesn't inherit and inline elements are flattened into
 * text runs, so the gradient must be threaded to the runs the declaring
 * element covers — both its direct text and text in nested inline children —
 * with geometry spanning the declaring element's fragment (mirrors the
 * background-clip:text fill fix).
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

const isWhite = (r: number, g: number, b: number) => r > 240 && g > 240 && b > 240;
const isMagenta = (r: number, g: number, b: number) => r > 140 && g < 90 && b > 140;

const base =
  'font-size: 64px; line-height: 1.4; color: rgb(255, 255, 255); ' +
  '-webkit-text-stroke: 6px black; paint-order: stroke fill';
const grad =
  '--rt-text-stroke-image: linear-gradient(0deg, black 0%, rgb(212, 0, 255) 100%)';

describe('gradient text stroke on inline elements', () => {
  it('an inline <span> declaring the stroke gradient strokes its own text with it', () => {
    const { canvas } = render({
      html: `<div style="${base}"><span style="${grad}">AB</span></div>`,
      width: 300,
      pixelRatio: 1,
    });
    expect(countPixels(canvas, isWhite)).toBeGreaterThan(50);
    expect(countPixels(canvas, isMagenta)).toBeGreaterThan(20);
  });

  it('the stroke gradient reaches text in a NESTED inline child (<u>)', () => {
    const { canvas } = render({
      html: `<div style="${base}"><span style="${grad}"><u>AB</u></span></div>`,
      width: 300,
      pixelRatio: 1,
    });
    expect(countPixels(canvas, isWhite)).toBeGreaterThan(50);
    expect(countPixels(canvas, isMagenta)).toBeGreaterThan(20);
  });
});
