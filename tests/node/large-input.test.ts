/**
 * Input-sized arrays must never be spread into call arguments
 * (`push(...arr)`, `Math.min(...arr)`): V8 overflows its stack at about 120k
 * arguments, so a long paragraph or line threw "Maximum call stack size
 * exceeded". Each input here is 200k units.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, setDOMParser } from '../../src/index.node.ts';
import { layoutTextOnPath } from '../../src/path/index.node.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const N = 200_000;

const BLOCK_CASES: Record<string, string> = {
  'RTL paragraph, wrapping': `<p>${'אב '.repeat(N / 3)}</p>`,
  'RTL paragraph, nowrap': `<p style="white-space:nowrap">${'אב '.repeat(N / 3)}</p>`,
  'one Hebrew word': `<p>${'א'.repeat(N)}</p>`,
  'bdo with 200k spans': `<p><bdo dir="rtl">${'<span>a </span>'.repeat(N)}</bdo></p>`,
  '200k <br>': `<p>${'a<br>'.repeat(N)}</p>`,
  'inline words beside a block': `<div>${'ab '.repeat(N)}<div>x</div></div>`,
};

for (const [name, html] of Object.entries(BLOCK_CASES)) {
  it(`lays out ${name}`, () => {
    expect(() => layout({ html, width: 400, ctx: mockCtx() })).not.toThrow();
  });
}

it('lays out 200k Latin characters on a path', () => {
  expect(() => layoutTextOnPath({ html: `<p>${'a'.repeat(N)}</p>`, path: 'M0,0 L100000,0', ctx: mockCtx() }))
    .not.toThrow();
});

it('lays out 200k Hebrew characters on a path', () => {
  expect(() => layoutTextOnPath({ html: `<p>${'א'.repeat(N)}</p>`, path: 'M0,0 L100000,0', ctx: mockCtx() }))
    .not.toThrow();
});
