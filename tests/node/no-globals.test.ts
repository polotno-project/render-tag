/**
 * Runs in plain Node (no DOM globals). Verifies:
 *  - render-tag never installs or requires DOM globals;
 *  - functions throw with guidance when nothing is injected;
 *  - injecting a parser (linkedom) + passing a measurement ctx makes
 *    layout()/drawLayout() fully functional;
 *  - globalThis stays clean after a full layout+draw cycle.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { PARITY_HTML, PARITY_WIDTH, mockMeasureCtx } from '../helpers/parity-fixture.ts';

const DOM_GLOBALS = ['document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'window'] as const;

function assertNoDomGlobals() {
  for (const name of DOM_GLOBALS) {
    expect(name in globalThis, `globalThis.${name} must not exist`).toBe(false);
  }
}

afterAll(() => setDOMParser(null));

describe('render-tag in Node without DOM globals', () => {
  it('starts with a clean globalThis', () => {
    assertNoDomGlobals();
  });

  it('layout() without an injected parser throws with guidance', () => {
    setDOMParser(null);
    expect(() => layout({ html: '<p>hi</p>', width: 100, ctx: mockMeasureCtx() }))
      .toThrowError(/setDOMParser/);
  });

  it('layout() with injected parser but no ctx throws with guidance', () => {
    setDOMParser(new LinkedomDOMParser());
    expect(() => layout({ html: '<p>hi</p>', width: 100 }))
      .toThrowError(/pass config\.ctx/);
  });

  it('layout() works with injected parser + measurement ctx', () => {
    setDOMParser(new LinkedomDOMParser());
    const result = layout({ html: PARITY_HTML, width: PARITY_WIDTH, ctx: mockMeasureCtx() });
    expect(result.lines.length).toBeGreaterThan(3);
    expect(result.height).toBeGreaterThan(0);
    expect(result.lines.map((l) => l.text).join('\n')).toContain('Hello');
  });

  it("accuracy 'balanced' throws (needs a browser DOM)", () => {
    setDOMParser(new LinkedomDOMParser());
    expect(() =>
      layout({ html: '<p>hi</p>', width: 100, ctx: mockMeasureCtx(), accuracy: 'balanced' })
    ).toThrowError(/'balanced' requires a browser DOM/);
  });

  it('drawLayout() without ctx/canvas throws (cannot create a canvas)', () => {
    setDOMParser(new LinkedomDOMParser());
    const result = layout({ html: '<p>hi</p>', width: 100, ctx: mockMeasureCtx() });
    expect(() => drawLayout({ layout: result, width: 100 }))
      .toThrowError(/pass ctx or canvas/);
  });

  it('drawLayout() draws onto a provided mock ctx', () => {
    setDOMParser(new LinkedomDOMParser());
    const result = layout({ html: '<p>hi</p>', width: 100, ctx: mockMeasureCtx() });
    const calls: string[] = [];
    const drawCtx = Object.assign(mockMeasureCtx(), {
      canvas: { width: 100, height: 100 },
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      fillText: (text: string) => calls.push(`fillText:${text}`),
      translate: () => {},
      fillStyle: '',
    });
    drawLayout({ layout: result, width: 100, ctx: drawCtx as any });
    expect(calls.some((c) => c === 'fillText:hi')).toBe(true);
  });

  it('leaves globalThis clean after layout + draw', () => {
    assertNoDomGlobals();
  });
});
