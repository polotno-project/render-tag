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
  /** Corner values in the expansion's fixed TL, TR, BR, BL order. */
  const radius = (value: string) =>
    expandShorthand('border-radius', value).map(d => d.value);

  it('assigns 1-4 values to corners in TL TR BR BL order', () => {
    expect(expandShorthand('border-radius', '4px').map(d => d.property)).toEqual([
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ]);
    expect(radius('4px')).toEqual(['4px', '4px', '4px', '4px']);
    expect(radius('4px 8px')).toEqual(['4px', '8px', '4px', '8px']);
    expect(radius('1px 2px 3px')).toEqual(['1px', '2px', '3px', '2px']);
    expect(radius('1px 2px 3px 4px')).toEqual(['1px', '2px', '3px', '4px']);
  });

  it('keeps the horizontal radii of the elliptical syntax', () => {
    expect(radius('4px / 2px')).toEqual(['4px', '4px', '4px', '4px']);
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

  it('resolves percentage radii against the border box at paint time', () => {
    // 50% on a non-square box is an ELLIPSE per corner (horizontal component
    // from the width, vertical from the height), so at 200x~20 the whole left
    // edge is curved: the corner is empty, the vertical-center column is not.
    const html = `<p style="margin:0; background:#1d4ed8; border-radius:50%; padding:8px;">x</p>`;
    const { canvas } = render({ html, width: 200, pixelRatio: 1 });
    const c = canvas as HTMLCanvasElement;
    expect(pixelAt(c, 1, 1)[3]).toBe(0);
    const [r, , b, a] = pixelAt(c, 1, Math.round(c.height / 2));
    expect(a).toBe(255);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(100);
  });

  it('clamps overlapping percentage radii uniformly (100% paints as 50%)', () => {
    // 100% radii overlap on every side; css-backgrounds §4.5 scales all
    // corners by the largest factor that fits, which lands exactly on 50%.
    const paint = (radius: string) => (render({
      html: `<p style="margin:0; background:#1d4ed8; border-radius:${radius}; padding:8px;">x</p>`,
      width: 200,
      pixelRatio: 1,
    }).canvas as HTMLCanvasElement).toDataURL();
    expect(paint('100%')).toBe(paint('50%'));
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
