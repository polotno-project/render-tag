/**
 * A block declarer's background-clip:text fill is clipped to the block's box,
 * as Chrome paints it (tests/clip-text-box.test.ts gates the pixels): the
 * fill only, never the glyph's stroke, a shadow mask, or an inline
 * declarer's paint. Recorded on the recording ctx, whose paint ops carry the
 * clip they draw under.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { drawLayout, layout, setDOMParser } from '../../src/index.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

const CLIP = '-webkit-background-clip:text;background-clip:text;color:transparent';
const GRADIENT = 'background-image:linear-gradient(to right, red, blue)';

function paints(html: string, width = 400) {
  setDOMParser(new LinkedomDOMParser());
  const result = layout({ html, width, ctx: recordingCtx(width, 300).ctx });
  const rec = recordingCtx(width, 300);
  drawLayout({ layout: result, width, ctx: rec.ctx, createCanvas: rec.createCanvas });
  return rec.paints;
}

/** The clip state each `op` paints under, `undefined` for none. */
const clips = (ops: string[], op: string) =>
  ops.filter((p) => p.startsWith(`${op}(`)).map((p) => {
    const clip = /;clip=([^;]*);/.exec(p)?.[1];
    return clip === 'undefined' ? undefined : clip;
  });

describe('background-clip:text fill clipped to its block', () => {
  it('clips a block declarer\'s fill to the block box', () => {
    // 40px lines: three on the recording ctx, 120px tall, 200px wide.
    const ops = paints(`<div style="font-size:40px;line-height:40px;${GRADIENT};${CLIP}">Ugly gyp Ugly gyp Ugly gyp</div>`, 200);
    const fills = clips(ops, 'fillText');
    expect(fills.length).toBeGreaterThan(1);
    for (const clip of fills) expect(clip).toMatch(/rect\(0,0,200,120\)/);
  });

  it('clips a nested block\'s text to the declarer\'s box', () => {
    const ops = paints(`<div style="font-size:40px;line-height:40px;padding-top:10px;${GRADIENT};${CLIP}"><p style="margin:0">gyp</p></div>`);
    for (const clip of clips(ops, 'fillText')) expect(clip).toMatch(/rect\(0,0,400,50\)/);
  });

  it('clips a solid background-color clip too', () => {
    const ops = paints(`<div style="font-size:40px;line-height:40px;background-color:red;${CLIP}">gyp</div>`);
    for (const clip of clips(ops, 'fillText')) expect(clip).toMatch(/rect\(0,0,400,40\)/);
  });

  it('leaves the stroke, an opaque descendant and an inline declarer unclipped', () => {
    const stroked = paints(`<div style="font-size:40px;line-height:40px;-webkit-text-stroke:2px black;${GRADIENT};${CLIP}">gyp</div>`);
    expect(clips(stroked, 'strokeText')).toEqual([undefined]);
    expect(clips(stroked, 'fillText')[0]).toMatch(/rect\(/);
    const own = paints(`<div style="font-size:40px;line-height:40px;${GRADIENT};${CLIP}"><span style="color:green">own</span></div>`);
    expect(clips(own, 'fillText')).toEqual([undefined]);
    const inline = paints(`<p style="font-size:40px;line-height:40px">a <span style="${GRADIENT};${CLIP}">gyp</span></p>`);
    expect(clips(inline, 'fillText').every((c) => c === undefined)).toBe(true);
  });

  it('casts a clip-text shadow from the whole glyph', () => {
    const ops = paints(`<div style="font-size:40px;line-height:40px;text-shadow:2px 2px 0 black;${GRADIENT};${CLIP}">gyp</div>`);
    const masks = ops.filter((p) => p.startsWith('drawImage(')).join('\n');
    expect(masks).toMatch(/fillText/);
    expect(masks).not.toMatch(/clip\(/);
  });
});
