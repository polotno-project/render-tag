/**
 * Text-shadow scratch canvases — what one draw allocates, keeps and hands
 * out, through the `createCanvas` hook (Node, recording ctx).
 *
 * A shadow is rasterized: the group's glyphs go into a mask canvas, the mask
 * casts each shadow into an image canvas, and the image is `drawImage`d onto
 * the destination. Two rules bound that memory without touching what it
 * paints:
 *
 * - A canvas HANDED to the destination is never reused or resized: a vector
 *   adapter may embed it asynchronously (README, PDF adapter contract).
 * - Every other scratch canvas is pooled within the draw and released
 *   (0×0) when it ends, and a tall group is cast in horizontal tiles, so the
 *   pool never holds a whole-document mask.
 */
import { afterAll, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

const PARAGRAPH = 'Will be responsible for managing activities that are part of the production of goods ' +
  'and services. Direct responsibilities include managing both the operations process, embracing design.';
const WIDTH = 600;
const PIXEL_RATIO = 2;

function draw(style: string, paragraphStyle = '', callerShadow = false) {
  setDOMParser(new LinkedomDOMParser());
  const html = `<div style="font:16px sans-serif;line-height:1.4;${style}">` +
    Array.from({ length: 50 }, (_, i) => `<p style="${paragraphStyle}">${i}: ${PARAGRAPH}</p>`).join('') + '</div>';
  const result = layout({ html, width: WIDTH, ctx: recordingCtx(WIDTH, 100).ctx });
  const rec = recordingCtx(WIDTH * PIXEL_RATIO, 100000);
  rec.ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  if (callerShadow) Object.assign(rec.ctx, { shadowColor: 'rgba(0,0,255,.5)', shadowOffsetX: 3, shadowBlur: 2 });
  drawLayout({ layout: result, width: WIDTH, ctx: rec.ctx, createCanvas: rec.createCanvas, pixelRatio: PIXEL_RATIO });
  const handedPixels = [...rec.scratch.handed].reduce<number>((sum, c) => sum + (c as any).width * (c as any).height, 0);
  return { rec, handedPixels, contentPixels: WIDTH * PIXEL_RATIO * result.height * PIXEL_RATIO };
}

for (const [name, style, paragraphStyle, callerShadow] of [
  ['one group, 2 shadows', 'text-shadow:2px 2px 4px rgba(0,0,0,.5), 0 0 8px red', '', false],
  ['one group per paragraph', 'text-shadow:2px 2px 4px rgba(0,0,0,.5)', 'background:#fafafa', false],
  // The text-shadow images then land on the caller-shadow source layer, a
  // pooled canvas: they are scratch too, not handed out.
  ['caller shadow over a text-shadow', 'text-shadow:2px 2px 4px rgba(0,0,0,.5)', '', true],
] as const) {
  it(`${name}: handed images are never resized; everything else is released`, () => {
    const { rec, handedPixels } = draw(style, paragraphStyle, callerShadow);
    expect(rec.scratch.handed.size).toBeGreaterThan(0);
    expect(rec.scratch.handedThenResized).toBe(0);
    // What is still live after the draw is exactly what was handed out.
    expect(rec.scratch.livePixels).toBe(handedPixels);
  });
}

it('casts one image per tile for every shadow value, not one per value', () => {
  const { rec, handedPixels, contentPixels } = draw('text-shadow:2px 2px 4px rgba(0,0,0,.5), 0 0 8px red');
  // The two values share an image; it covers the content plus its blur
  // margin once (the old path handed two content-sized images).
  expect(handedPixels).toBeLessThan(contentPixels * 1.25);
  // The pool never holds a whole-document mask: a tile is a fraction of it.
  expect(rec.scratch.peakPixels - handedPixels).toBeLessThan(contentPixels / 4);
});
