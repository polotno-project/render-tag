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
import { mockCtx } from '../helpers/mock-ctx.ts';

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

it('a kept result releases its ctx after paintBounds is read', async () => {
  const results: unknown[] = [];
  const held = ((): WeakRef<object> => {
    const ctx = mockCtx();
    const result = layout({ html: PARAGRAPH, width: 400, ctx });
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
});
