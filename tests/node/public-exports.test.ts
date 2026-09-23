/**
 * The public surface external renderers build on (@polotno/svg-export):
 * layoutRoot's node types as named exports, and the shared metric helpers.
 * A rename or dropped re-export must fail here, not in a downstream repo.
 */
import { it, expect, afterAll } from 'vitest';
import { DOMParser } from 'linkedom';
import { layoutTextOnPath } from '../../src/path/index.node.ts';
import {
  lineBaselineOffset,
  getFontMetrics,
  tabStopMetrics,
  layout,
  setDOMParser,
} from '../../src/index.node.ts';
import type {
  LayoutBox,
  LayoutText,
  LayoutNode,
  ResolvedStyle,
  DecorationEntry,
  BorderRadius,
} from '../../src/index.node.ts';
import { mockCtx, CHAR_WIDTH } from '../helpers/mock-ctx.ts';

it('re-exports the shared metric helpers', () => {
  expect(typeof lineBaselineOffset).toBe('function');
  expect(typeof getFontMetrics).toBe('function');
  expect(typeof tabStopMetrics).toBe('function');
});

it('tabStopMetrics sizes the interval from the block font, letter-spacing off', () => {
  const ctx = mockCtx();
  const style = {
    fontFamily: 'sans-serif', fontSize: 16, fontWeight: 400,
    fontStyle: 'normal', letterSpacing: 2, wordSpacing: 0,
  } as unknown as ResolvedStyle;
  const { interval, halfSpace } = tabStopMetrics(ctx, style);
  // The space itself measures with letter-spacing OFF (CHAR_WIDTH), then the
  // block's letter-spacing joins each stop: (10 + 2) * 8.
  expect(interval).toBe((CHAR_WIDTH + 2) * 8);
  expect(halfSpace).toBe(CHAR_WIDTH / 2);
});

it('names the layout node types', () => {
  // Type-level assertions — this compiles only while the exports exist.
  const node: LayoutNode = { type: 'text' } as unknown as LayoutText;
  const box = { children: [node] } as unknown as LayoutBox;
  const deco: DecorationEntry[] = [];
  const radius: BorderRadius = { pct: 50 };
  expect([box, deco, radius]).toBeDefined();
});

afterAll(() => setDOMParser(null));

it('measures painted bounds through both Node entry points without a DOM canvas', () => {
  setDOMParser(new DOMParser());
  const ctx = mockCtx();
  const html = '<div style="font-size:40px;text-shadow:60px 0 red">Hello</div>';
  const flat = layout({ html, width: 100, ctx });
  const plain = layout({ html: html.replace('text-shadow:60px 0 red', ''), width: 100, ctx }).paintBounds;
  const shadow = flat.paintBounds;
  expect(shadow.width).toBeGreaterThan(plain.width);
  const curved = layoutTextOnPath({ html, path: 'M0,0 L500,0', ctx });
  const bounds = curved.paintBounds;
  expect(bounds.width).toBeGreaterThan(curved.textWidth);
  expect(bounds.height).toBeGreaterThan(0);
});
