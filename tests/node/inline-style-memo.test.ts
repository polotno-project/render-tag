/**
 * Elements that share one `style=""` text parse and expand it once per
 * resolve call (editor output repeats one style string on every run).
 */
import { afterAll, expect, it, vi } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { parseHTML } from '../../src/parse.ts';
import { resolveStylesFromCSS } from '../../src/css-resolver.ts';
import { setDOMParser } from '../../src/dom.ts';

const parsed: string[] = [];
vi.mock('../../src/css-syntax.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/css-syntax.ts')>();
  return {
    ...actual,
    parseDeclarationList: (text: string) => {
      parsed.push(text);
      return actual.parseDeclarationList(text);
    },
  };
});

afterAll(() => setDOMParser(null));

it('300 elements sharing one style string parse it once', () => {
  setDOMParser(new LinkedomDOMParser());
  const style = 'font: italic 14px serif; padding: 2px 4px; border: 1px solid red; color: blue';
  const { fragment, css } = parseHTML(Array.from({ length: 300 }, () => `<span style="${style}">x</span>`).join(''));
  parsed.length = 0;
  resolveStylesFromCSS(fragment, css, 400);
  expect(parsed.filter((t) => t === style)).toHaveLength(1);
  // Per call, not module-global: a second call parses again.
  const again = parseHTML(`<span style="${style}">x</span>`);
  resolveStylesFromCSS(again.fragment, again.css, 400);
  expect(parsed.filter((t) => t === style)).toHaveLength(2);
});
