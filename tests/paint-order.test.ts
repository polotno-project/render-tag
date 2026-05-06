/**
 * Tests for CSS `paint-order` on stroked text.
 *
 * Default (`paint-order: normal` or unset) → fill, then stroke on top.
 * `paint-order: stroke fill` → stroke, then fill on top — fill covers the
 * inner half of the stroke so the visible glyph stays at original weight
 * and the stroke appears only outside the glyph edge.
 *
 * Browsers (Firefox/Chrome/Safari) honor paint-order on HTML text via the
 * SVG-derived property.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';
import { paintOrderHasStrokeFirst } from '../src/css-resolver.ts';

function countMatching(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number, a: number) => boolean,
): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) count++;
  }
  return count;
}

const isBlue = (r: number, g: number, b: number, a: number) =>
  a > 200 && b > 150 && r < 80 && g < 80;
const isRed = (r: number, g: number, b: number, a: number) =>
  a > 200 && r > 150 && g < 80 && b < 80;

describe('paintOrderHasStrokeFirst()', () => {
  it('returns false for empty / unset', () => {
    expect(paintOrderHasStrokeFirst('')).toBe(false);
  });
  it('returns false for "normal"', () => {
    expect(paintOrderHasStrokeFirst('normal')).toBe(false);
  });
  it('returns false for "fill stroke"', () => {
    expect(paintOrderHasStrokeFirst('fill stroke')).toBe(false);
  });
  it('returns true for "stroke fill"', () => {
    expect(paintOrderHasStrokeFirst('stroke fill')).toBe(true);
  });
  it('returns true for "stroke" alone (fill implicit-after)', () => {
    expect(paintOrderHasStrokeFirst('stroke')).toBe(true);
  });
  it('returns false for "fill" alone', () => {
    expect(paintOrderHasStrokeFirst('fill')).toBe(false);
  });
  it('returns true for "stroke markers fill"', () => {
    expect(paintOrderHasStrokeFirst('stroke markers fill')).toBe(true);
  });
  it('returns false for "markers fill stroke"', () => {
    expect(paintOrderHasStrokeFirst('markers fill stroke')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(paintOrderHasStrokeFirst('Stroke Fill')).toBe(true);
  });
});

describe('paint-order rendering', () => {
  const baseStyle = 'font-size: 80px; font-weight: 900; font-family: sans-serif;';
  const stroke = '-webkit-text-stroke: 6px red;';
  const fill = 'color: blue;';

  it('default order paints stroke on top of fill (blue partially covered)', () => {
    const html = `<span style="${baseStyle} ${stroke} ${fill}">O</span>`;
    const { canvas } = render({ html, width: 200, pixelRatio: 1 });
    const blue = countMatching(canvas, isBlue);
    const red = countMatching(canvas, isRed);
    expect(red).toBeGreaterThan(50);
    expect(blue).toBeGreaterThan(20);
  });

  it('paint-order: stroke fill paints fill on top of stroke (more blue than default)', () => {
    const defaultHtml = `<span style="${baseStyle} ${stroke} ${fill}">O</span>`;
    const reorderHtml = `<span style="${baseStyle} ${stroke} ${fill} paint-order: stroke fill;">O</span>`;
    const def = render({ html: defaultHtml, width: 200, pixelRatio: 1 });
    const reord = render({ html: reorderHtml, width: 200, pixelRatio: 1 });
    const defBlue = countMatching(def.canvas, isBlue);
    const reordBlue = countMatching(reord.canvas, isBlue);
    // With stroke painted first and fill on top, the inner half of the stroke
    // is overwritten by fill — so visible blue area is strictly larger.
    expect(reordBlue).toBeGreaterThan(defBlue);
  });

  it('paint-order inherits from parent', () => {
    const childOnly = `<span style="${baseStyle} ${stroke} ${fill}">O</span>`;
    const parentSet = `<div style="paint-order: stroke fill;"><span style="${baseStyle} ${stroke} ${fill}">O</span></div>`;
    const a = render({ html: childOnly, width: 200, pixelRatio: 1 });
    const b = render({ html: parentSet, width: 200, pixelRatio: 1 });
    expect(countMatching(b.canvas, isBlue)).toBeGreaterThan(countMatching(a.canvas, isBlue));
  });
});
