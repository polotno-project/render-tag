/**
 * border-radius rendering (issue #2) and the border shorthand's color parsing.
 *
 * Regression test: the CSS resolver's expandShorthand for `border` split on
 * whitespace, breaking rgb() color values like "rgb(29, 78, 216)" into
 * fragments — the same bug class decoration-color.test.ts records for
 * text-decoration. Canvas silently ignores the invalid strokeStyle, so the
 * border painted with whatever color the previous box left behind.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';
import { expandShorthand } from '../src/css-resolver.ts';

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const d = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

describe('border-radius shorthand parsing', () => {
  const radius = (value: string) =>
    Object.fromEntries(expandShorthand('border-radius', value).map(d => [d.property, d.value]));

  it('assigns 1-4 values to corners in TL TR BR BL order', () => {
    expect(radius('4px')).toEqual({
      'border-top-left-radius': '4px',
      'border-top-right-radius': '4px',
      'border-bottom-right-radius': '4px',
      'border-bottom-left-radius': '4px',
    });
    expect(radius('4px 8px')).toEqual({
      'border-top-left-radius': '4px',
      'border-top-right-radius': '8px',
      'border-bottom-right-radius': '4px',
      'border-bottom-left-radius': '8px',
    });
    expect(radius('1px 2px 3px')).toEqual({
      'border-top-left-radius': '1px',
      'border-top-right-radius': '2px',
      'border-bottom-right-radius': '3px',
      'border-bottom-left-radius': '2px',
    });
    expect(radius('1px 2px 3px 4px')).toEqual({
      'border-top-left-radius': '1px',
      'border-top-right-radius': '2px',
      'border-bottom-right-radius': '3px',
      'border-bottom-left-radius': '4px',
    });
  });

  it('keeps the horizontal radii of the elliptical syntax', () => {
    expect(radius('4px / 2px')['border-top-left-radius']).toBe('4px');
  });

  it('keeps a function color in the border shorthand intact', () => {
    const decls = expandShorthand('border', '2px solid rgb(29, 78, 216)');
    expect(decls).toContainEqual({ property: 'border-top-color', value: 'rgb(29, 78, 216)' });
    expect(decls).toContainEqual({ property: 'border-top-width', value: '2px' });
    expect(decls).toContainEqual({ property: 'border-top-style', value: 'solid' });
  });
});

describe('border-radius rendering', () => {
  it('rounds a background box: the corner pixel stays unpainted', () => {
    const html = `<p style="margin:0; background:#1d4ed8; border-radius:16px; padding:8px;">x</p>`;
    const { canvas } = render({ html, width: 200, pixelRatio: 1 });
    const [, , , cornerAlpha] = pixelAt(canvas as HTMLCanvasElement, 1, 1);
    expect(cornerAlpha).toBe(0);
    const [r, g, b] = pixelAt(canvas as HTMLCanvasElement, 100, 10);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(100);
    expect(g).toBeLessThan(150);
  });

  it('rounds a uniform border and paints it its own color', () => {
    // Two boxes: the first leaves red on the ctx; the second must still
    // stroke blue (the rgb() split regression painted it red).
    const html = `
      <p style="margin:0 0 4px 0; border:2px solid red;">a</p>
      <p style="margin:0; border:2px solid rgb(29, 78, 216); border-radius:12px; padding:4px;">b</p>`;
    const { canvas } = render({ html, width: 200, pixelRatio: 1 });
    const c = canvas as HTMLCanvasElement;
    const secondTop = c.height - 2; // inside the 2px bottom border band
    let blue = 0, red = 0;
    for (let x = 0; x < c.width; x++) {
      const [r, g, b, a] = pixelAt(c, x, secondTop);
      if (a === 0) continue;
      if (b > 150 && r < 100) blue++;
      if (r > 150 && b < 100) red++;
    }
    expect(blue).toBeGreaterThan(50);
    expect(red).toBe(0);
  });
});
