import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser } from 'linkedom';
import { render, layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { drawTextOnPath, layoutTextOnPath, drawTextOnPathLayout } from '../../src/path/index.node.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';

afterAll(() => setDOMParser(null));

const html = `<div style="font-size:40px;color:blue;-webkit-text-stroke:4px red;
  paint-order:stroke fill;text-decoration:underline;text-shadow:8px 8px 4px black">Header</div>`;

function vectorContext() {
  const calls: string[] = [];
  const ctx = Object.assign(mockCtx(), {
    canvas: { width: 500, height: 200 },
    translate() {}, rotate() {},
    shadowColor: 'purple', shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 0,
    fillText() { expect(ctx.shadowColor).toBe('transparent'); calls.push('fillText'); },
    strokeText() { expect(ctx.shadowColor).toBe('transparent'); calls.push('strokeText'); },
    stroke() { calls.push('stroke'); },
  });
  return { ctx, calls };
}

describe('vector adapters', () => {
  for (const curved of [false, true]) for (const separateLayout of [false, true]) {
    it(`retains drawing commands without raster APIs (${curved ? 'path' : 'block'}, ${separateLayout ? 'layout + draw' : 'combined'})`, () => {
      setDOMParser(new DOMParser());
      const { ctx, calls } = vectorContext();
      const options = {
        ctx, renderShadows: false,
        createCanvas: () => { throw new Error('Vector foreground must not allocate a canvas'); },
      };
      if (curved) {
        const config = { html, path: 'M0,100 L500,100', ...options };
        if (separateLayout) drawTextOnPathLayout({ layout: layoutTextOnPath(config), ...options });
        else drawTextOnPath(config);
      } else {
        const config = { html, width: 500, ...options };
        if (separateLayout) drawLayout({ layout: layout(config), width: 500, ...options });
        else render(config);
      }
      expect(calls).toContain('fillText');
      expect(calls).toContain('strokeText');
      expect(calls).toContain('stroke');
      expect(ctx.shadowColor).toBe('purple');
      expect(ctx.shadowBlur).toBe(12);
    });
  }

  it('explains the adapter contract instead of silently dropping a shadow', () => {
    setDOMParser(new DOMParser());
    const { ctx } = vectorContext();
    expect(() => render({ html, width: 500, ctx })).toThrow(/renderShadows: false/);
  });

  it('requires a scratch-canvas factory for Node canvas shadows', () => {
    setDOMParser(new DOMParser());
    const { ctx } = vectorContext();
    Object.assign(ctx, {
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      setTransform() {}, drawImage() {},
    });
    expect(() => render({ html, width: 500, ctx })).toThrow(/provide createCanvas/);
  });
});
