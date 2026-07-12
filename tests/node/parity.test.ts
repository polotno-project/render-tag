/**
 * Node half of the parse-parity pair (browser half: tests/parse-parity.test.ts).
 * Same HTML + same mock measureText must produce the same line breaks as the
 * browser — pins linkedom-parse ≡ browser-parse.
 */
import { it, expect, afterAll } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, setDOMParser } from '../../src/index.node.ts';
import {
  PARITY_HTML,
  PARITY_WIDTH,
  EXPECTED_LINES,
  EXPECTED_HEIGHT,
  mockMeasureCtx,
  lineTexts,
} from '../helpers/parity-fixture.ts';

afterAll(() => setDOMParser(null));

it('linkedom parse produces the pinned line breaks', () => {
  setDOMParser(new LinkedomDOMParser());
  const result = layout({ html: PARITY_HTML, width: PARITY_WIDTH, ctx: mockMeasureCtx() });
  expect(lineTexts(result.lines)).toEqual(EXPECTED_LINES);
  expect(result.height).toBe(EXPECTED_HEIGHT);
});
