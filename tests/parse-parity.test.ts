/**
 * Browser half of the parse-parity pair (Node half: tests/node/parity.test.ts).
 * Uses the ambient DOMParser and the same mock measureText as the Node test —
 * both must produce the pinned line breaks, proving browser-parse ≡ linkedom-parse.
 */
import { it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import {
  PARITY_HTML,
  PARITY_WIDTH,
  EXPECTED_LINES,
  EXPECTED_HEIGHT,
  mockMeasureCtx,
  lineTexts,
} from './helpers/parity-fixture.ts';

it('browser parse produces the pinned line breaks', () => {
  const result = layout({ html: PARITY_HTML, width: PARITY_WIDTH, ctx: mockMeasureCtx() });
  expect(lineTexts(result.lines)).toEqual(EXPECTED_LINES);
  expect(result.height).toBe(EXPECTED_HEIGHT);
});
