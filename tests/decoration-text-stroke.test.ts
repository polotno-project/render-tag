import { describe, expect, it } from 'vitest';
import { drawLayout, layout } from '../src/index.ts';
import { drawTextOnPath } from '../src/path/index.ts';
import { renderToNativeDOM } from './helpers/native-compare.ts';

const PALE = [220, 186, 186];
const PURPLE = [106, 13, 173];
const GREEN = [0, 255, 0];

// Sample the space in "H H" to isolate the underline. Native HTML paints it
// behind glyphs, so sampling under a letter could include its text stroke.
function bandRows(canvas: HTMLCanvasElement, x: number, color: number[]): number[] {
  const { height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(Math.floor(x), 0, 1, height).data;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const i = y * 4;
    if (data[i + 3] > 200 && color.every((c, channel) => Math.abs(data[i + channel] - c) < 5)) rows.push(y);
  }
  return rows;
}

describe('HTML decorations with text stroke (Chromium oracle)', () => {
  const fixtures: {
    name: string; size: number; stroke: number; order: string;
    extra?: string; color?: number[];
  }[] = [
    { name: '27px stroke at 160px, stroke fill', size: 160, stroke: 27, order: 'stroke fill' },
    { name: 'default paint order', size: 160, stroke: 27, order: 'normal' },
    { name: '8px stroke at 40px', size: 40, stroke: 8, order: 'stroke fill' },
    { name: 'stroke thinner than the band', size: 160, stroke: 1, order: 'stroke fill' },
    { name: 'explicit decoration colour', size: 160, stroke: 27, order: 'stroke fill',
      extra: 'text-decoration-color: #00ff00;', color: GREEN },
    { name: 'gradient text fill', size: 160, stroke: 27, order: 'stroke fill',
      extra: 'color: transparent; background-image: linear-gradient(90deg, #6a0dad, #280841); background-clip: text;' },
    { name: 'transparent text stroke', size: 160, stroke: 27, order: 'stroke fill',
      extra: '-webkit-text-stroke-color: transparent;', color: PURPLE },
    ...['rgba(255, 0, 0, 0)', '#f000', '#ff000000', 'rgb(255 0 0 / 0%)', 'hsl(0 100% 50% / 0)']
      .map((color) => ({ name: `zero-alpha stroke ${color}`, size: 160, stroke: 27,
        order: 'stroke fill', extra: `-webkit-text-stroke-color: ${color};`, color: PURPLE })),
    ...['currentColor', 'currentcolor'].map((color) => ({
      name: `stylesheet decoration ${color}`, size: 160, stroke: 27, order: 'stroke fill',
      extra: `text-decoration-color: ${color};`,
    })),
  ];
  for (const fixture of fixtures) {
    it(`keeps the decoration thickness and colour: ${fixture.name}`, async () => {
      const width = 800;
      const height = 300;
      // Keep declarations in a stylesheet so inline CSSOM cannot normalize
      // hex/slash alpha into rgba() before render-tag parses the input.
      const html = `<style>div { padding: 30px; font-size: ${fixture.size}px; font-weight: bold; ` +
        `font-family: Arial; color: #6a0dad; -webkit-text-stroke: ${fixture.stroke}px rgb(220,186,186); ` +
        `paint-order: ${fixture.order}; text-decoration: underline; ${fixture.extra || ''} }</style><div>H H</div>`;
      const result = layout({ html, width, height });
      const { canvas } = drawLayout({ layout: result, width, pixelRatio: 1 });
      const native = await renderToNativeDOM(html, '', width, height);
      const { x, width: textWidth } = result.lines[0].bounds;
      const sampleX = x + textWidth / 2;
      const color = fixture.color || PALE;
      const expected = bandRows(native, sampleX, color);
      const actual = bandRows(canvas as HTMLCanvasElement, sampleX, color);

      // Native HTML paints one thin band, unlike native SVG's filled outline.
      expect(expected, 'native decoration band').toHaveLength(fixture.size / 10);
      expect(actual, 'canvas decoration thickness').toHaveLength(expected.length);
      expect(Math.abs(actual[0] - expected[0]), 'band position').toBeLessThanOrEqual(1);
      if (color !== PURPLE) {
        expect(bandRows(canvas as HTMLCanvasElement, sampleX, PURPLE), 'no purple inner band').toEqual([]);
      }
    });
  }
});

describe('decoration stroke colour propagation', () => {
  for (const path of [false, true]) {
    it(`keeps the declarer's band colour across a differently stroked child (${path ? 'path' : 'layout'})`, () => {
      const html = '<span style="font-size: 40px; font-family: Arial; color: #6a0dad; ' +
        '-webkit-text-stroke: 8px rgb(220,186,186); text-decoration: underline;">' +
        '<span style="-webkit-text-stroke-color: #00ff00;">H H</span></span>';
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 150;
      const ctx = canvas.getContext('2d')!;
      let textWidth: number;
      let x = 30;
      if (path) {
        textWidth = drawTextOnPath({ html, ctx, path: 'M30,80 L390,80' }).textWidth;
      } else {
        const result = layout({ html, width: 400, height: 150 });
        textWidth = result.lines[0].bounds.width;
        x = result.lines[0].bounds.x;
        drawLayout({ layout: result, width: 400, ctx });
      }
      expect(bandRows(canvas, x + textWidth / 2, PALE)).toHaveLength(4);
      expect(bandRows(canvas, x + textWidth / 2, GREEN)).toEqual([]);
    });
  }
});
