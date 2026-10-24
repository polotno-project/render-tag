/**
 * Memory gate, Node only (`--expose-gc` via the node project in vitest.config.ts).
 *
 * - Repeated `layout()` calls must not accumulate heap: everything a call
 *   allocates dies with its result.
 * - A kept result must not pin the ctx it was measured on: `paintBounds` is
 *   lazy, so the closure releases the ctx once it has measured (a PDF proxy
 *   or an OffscreenCanvas would otherwise live as long as the layout).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, setDOMParser } from '../../src/index.ts';
import { layoutTextOnPath } from '../../src/path/index.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('tests/node/memory.test.ts needs --expose-gc (vitest.config.ts node project execArgv)');

const WORDS = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'.split(' ');
const PARAGRAPH = `<p style="font-size:16px;margin:0">${Array.from({ length: 300 }, (_, i) => WORDS[i % WORDS.length]).join(' ')}</p>`;

function settledHeap(): number {
  gc!(); gc!();
  return process.memoryUsage().heapUsed;
}

it('2000 layouts leave no heap behind', () => {
  const ctx = mockCtx();
  for (let i = 0; i < 50; i++) layout({ html: PARAGRAPH, width: 400, ctx });
  const before = settledHeap();
  for (let i = 0; i < 2000; i++) layout({ html: PARAGRAPH, width: 400, ctx });
  const growth = settledHeap() - before;
  // Generous: a leak of one result per call would be 2000 x ~100 KB.
  expect(growth).toBeLessThan(8 * 1024 * 1024);
});

/** Keep the result `make` returns, read its `paintBounds`, and expect the ctx collected. */
async function expectCtxReleased(make: (ctx: CanvasRenderingContext2D) => { paintBounds: unknown }) {
  const results: unknown[] = [];
  const held = ((): WeakRef<object> => {
    const ctx = mockCtx();
    const result = make(ctx);
    void result.paintBounds;
    results.push(result);
    return new WeakRef(ctx);
  })();
  // `deref()` keeps its target alive for the rest of the job: gc first, read once.
  for (let i = 0; i < 3; i++) {
    gc!();
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(held.deref()).toBeUndefined();
  expect(results).toHaveLength(1);
}

it.each([
  ['plain text', PARAGRAPH],
  ['percentage width', '<div style="width:50%">text</div>'],
  ['mixed font units', '<div style="width:calc(50% + 2ch + 1ex)">text</div>'],
  ['inherited indent', '<div style="width:50%;text-indent:calc(10% + 2ch + 1ex)"><div style="width:50%;font-size:30px">text</div></div>'],
  ['flex percentages', '<div style="display:flex;gap:10%"><div style="flex:1;padding-left:calc(5% + 1ch)">text</div><div>other</div></div>'],
])('a kept result with %s releases its ctx after paintBounds is read', (_, html) =>
  expectCtxReleased((ctx) => layout({ html, width: 400, ctx })));

it('a kept text-on-path result releases its ctx after paintBounds is read', () =>
  expectCtxReleased((ctx) => layoutTextOnPath({
    html: '<p style="font-size:16px">Text <b>on</b> a path, 2ch <span style="padding:0 1ch">wide</span></p>',
    path: 'M0,100 Q500,0 1000,100', ctx,
  })));

it('percentage-only styles do not measure font units', () => {
  const rec = recordingCtx();
  layout({
    html: '<div style="width:50%;padding:10%;text-indent:20%"><div style="width:50%"></div></div>',
    width: 400, ctx: rec.ctx,
  });
  expect(rec.counts.calls.measureText ?? 0).toBe(0);
});
