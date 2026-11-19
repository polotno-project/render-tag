/**
 * `background-clip: text` paints the declaring block's background, so Chrome
 * clips it to that block's border box: ink past it (descenders under
 * `line-height: 1`, accents above `0.8`) is not painted. An inline
 * declarer's box is its content area, which holds the glyphs, so its paint
 * is not cut. The glyph's own stroke is text, not background: it is painted
 * past the box, the fill under it is not.
 *
 * Each fixture sits inside padding so the capture's own `overflow: hidden`
 * crops nothing; a plain-coloured twin proves the ink does overflow.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';

/** Opaque pixels and their first and last rows. */
function ink(canvas: HTMLCanvasElement): { pixels: number; top: number; bottom: number } {
  const { width, height } = canvas;
  const d = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let pixels = 0, top = Infinity, bottom = -1;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] <= 128) continue;
    pixels++;
    const row = Math.floor(i / 4 / width);
    top = Math.min(top, row);
    bottom = Math.max(bottom, row);
  }
  return { pixels, top, bottom };
}

const FONT = "font-family:'Open Sans';font-size:80px;width:600px";
const CLIP = '-webkit-background-clip:text;background-clip:text;color:transparent';
const GRADIENT = 'background-image:linear-gradient(to right, red, blue)';

async function render(html: string) {
  const css = await loadMultiFontCss();
  const r = await compareNativeRenders(`<div style="padding:40px 0">${html}</div>`, css, 640, 240, 0.1, 1);
  return { dom: ink(r.domCanvas), lib: ink(r.libCanvas) };
}

function expectSameInk(dom: ReturnType<typeof ink>, lib: ReturnType<typeof ink>) {
  expect(Math.abs(lib.top - dom.top), `top ${lib.top} vs ${dom.top}`).toBeLessThanOrEqual(1);
  expect(Math.abs(lib.bottom - dom.bottom), `bottom ${lib.bottom} vs ${dom.bottom}`).toBeLessThanOrEqual(1);
  expect(Math.abs(lib.pixels - dom.pixels) / dom.pixels).toBeLessThan(0.03);
}

describe('background-clip:text is clipped to the declaring block', () => {
  it.each([
    ['descenders under line-height:1', `<div style="${FONT};line-height:1;${GRADIENT};${CLIP}">Ugly gyp</div>`],
    ['both ends under line-height:0.8', `<div style="${FONT};line-height:0.8;margin-top:30px;${GRADIENT};${CLIP}">Ugly ÉÅ</div>`],
    ['a solid background-color', `<div style="${FONT};line-height:1;background-color:red;${CLIP}">Ugly gyp</div>`],
    ['a nested block, to the declarer\'s box', `<div style="${FONT};line-height:1;${GRADIENT};${CLIP}"><p style="margin:0">Ugly gyp</p></div>`],
    ['a block with padding, to its border box', `<div style="${FONT};line-height:1;padding:0 0 10px;${GRADIENT};${CLIP}">Ugly gyp</div>`],
  ])('%s', async (_, html) => {
    const plain = await render(html.replace(CLIP, 'color:blue'));
    const { dom, lib } = await render(html);
    expect(dom.bottom - dom.top, 'the clip cuts native ink').toBeLessThan(plain.dom.bottom - plain.dom.top);
    expectSameInk(dom, lib);
  });

  it.each([
    ['an inline declarer', `<p style="${FONT};line-height:0.8;margin:30px 0 0">a <span style="${GRADIENT};${CLIP}">Ugly ÉÅ</span></p>`],
  ])('leaves %s uncut', async (_, html) => {
    const { dom, lib } = await render(html);
    expectSameInk(dom, lib);
  });

  it('paints the glyph\'s own stroke past the box, the fill under it not', async () => {
    const css = await loadMultiFontCss();
    // The block spans rows 40 to 120.
    const html = `<div style="padding:40px 0"><div style="${FONT};line-height:1;-webkit-text-stroke:3px black;${GRADIENT};${CLIP}">Ugly gyp</div></div>`;
    const r = await compareNativeRenders(html, css, 640, 240, 0.1, 1);
    const below = (canvas: HTMLCanvasElement) => {
      const d = canvas.getContext('2d')!.getImageData(0, 120, canvas.width, 120).data;
      let stroke = 0, fill = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] <= 128) continue;
        if (d[i] > 100 || d[i + 2] > 100) fill++;
        else stroke++;
      }
      return { stroke, fill };
    };
    const dom = below(r.domCanvas), lib = below(r.libCanvas);
    expect(dom.fill, 'native').toBe(0);
    expect(dom.stroke, 'native').toBeGreaterThan(200);
    expect(lib.fill).toBe(0);
    expect(Math.abs(lib.stroke - dom.stroke) / dom.stroke).toBeLessThan(0.05);
  });
});
