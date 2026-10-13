/**
 * Text-on-path draw work on the recording ctx (`tests/helpers/recording-ctx.ts`):
 * one setTransform per glyph (no save/translate/rotate/restore), glyph ink
 * measured once per style and text (not per glyph per access), and a shadow
 * mask that repaints only the glyphs inside each tile. The save/restore
 * fallback for a ctx without `getTransform` must paint the same stream.
 */
import { describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layoutTextOnPath, drawTextOnPathLayout, setDOMParser } from '../../src/path/index.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

setDOMParser(new LinkedomDOMParser());

const WORDS = ['Lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do'];
let text = '';
while (text.length < 2000) text += WORDS[text.length % WORDS.length] + ' ';
text = text.slice(0, 2000);
const PATH_D = 'M0,200 Q2500,0 5000,200 T10000,200 T15000,200 T20000,200';

function draw(html: string, ctx?: CanvasRenderingContext2D) {
  const rec = recordingCtx(1000, 1000);
  const target = ctx ?? rec.ctx;
  const layout = layoutTextOnPath({ html, path: PATH_D, ctx: target });
  const before = { ...rec.counts.calls };
  drawTextOnPathLayout({ layout, ctx: target, createCanvas: rec.createCanvas });
  const calls = Object.fromEntries(Object.entries(rec.counts.calls).map(([k, v]) => [k, v - (before[k] ?? 0)]));
  return { layout, rec, calls };
}

describe('text-on-path draw counts', () => {
  it('2000 glyphs: one setTransform each, no per-glyph save/restore', () => {
    const { layout, calls } = draw(`<span style="font-size:12px">${text}</span>`);
    expect(layout.glyphs.length).toBe(2000);
    expect(calls.fillText).toBe(2000);
    expect(calls.setTransform).toBe(2001);
    expect(calls.save ?? 0).toBeLessThanOrEqual(1);
    expect(calls.translate ?? 0).toBe(0);
    expect(calls.rotate ?? 0).toBe(0);
    expect(calls.measureText ?? 0).toBe(0);
  });

  it('a shadow measures ink once per glyph text and repaints only each tile\'s glyphs', () => {
    const { layout, calls } = draw(`<span style="font-size:12px;text-shadow:2px 2px 3px black">${text}</span>`);
    const glyphs = layout.glyphs.length;
    const distinct = new Set(layout.glyphs.map(g => g.width + ' ' + g.char)).size;
    expect(calls.measureText).toBeLessThanOrEqual(distinct);
    expect(calls.save).toBeLessThanOrEqual(2);
    // Foreground once plus the mask tiles: well under one full repaint per tile.
    expect(calls.drawImage).toBeGreaterThan(1);
    expect(calls.fillText).toBeLessThan(glyphs * 3);
    expect(calls.fillText).toBeGreaterThan(glyphs);
  });

  it('paintBounds is measured once per glyph text, not per glyph', () => {
    const rec = recordingCtx(1000, 1000);
    const layout = layoutTextOnPath({ html: `<span style="font-size:12px">${text}</span>`, path: PATH_D, ctx: rec.ctx });
    const before = rec.counts.calls.measureText;
    void layout.paintBounds;
    void layout.paintBounds;
    const distinct = new Set(layout.glyphs.map(g => g.width + ' ' + g.char)).size;
    expect(rec.counts.calls.measureText - before).toBeLessThanOrEqual(distinct);
  });

  it('a ctx without getTransform paints the same stream through save/translate/rotate/restore', () => {
    const html = `<u style="font-size:12px">${text.slice(0, 200)}</u><s style="text-decoration:line-through wavy">${text.slice(200, 400)}</s>`;
    const fast = draw(html);
    const slow = recordingCtx(1000, 1000);
    const hidden = new Proxy(slow.ctx, {
      get(target, key, receiver) {
        if (key === 'getTransform') return undefined;
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) { return Reflect.set(target, key, value); },
    });
    const layout = layoutTextOnPath({ html, path: PATH_D, ctx: hidden });
    drawTextOnPathLayout({ layout, ctx: hidden, createCanvas: slow.createCanvas });
    expect(slow.counts.calls.setTransform ?? 0).toBe(0);
    expect(slow.counts.calls.save).toBeGreaterThan(layout.glyphs.length);
    expect(slow.paints).toEqual(fast.rec.paints);
  });
});
