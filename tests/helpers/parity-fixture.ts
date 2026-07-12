/**
 * Shared fixture for the browser/node parse-parity tests.
 *
 * The same HTML is laid out in both environments with the same deterministic
 * mock measureText (fixed char width). If the browser DOMParser and an
 * injected linkedom parser produce the same styled tree, the resulting line
 * breaks must be identical — pinned here as EXPECTED_LINES.
 */
export const PARITY_HTML = `
  <style>p { margin: 0; padding: 0; } .big { font-size: 32px; }</style>
  <p>Hello world this is a wrap test</p>
  <p><b>Bold</b> and <span class="big">big&nbsp;text</span> with &amp; entities</p>
  <ul><li>alpha</li><li>beta gamma</li></ul>
`;

export const PARITY_WIDTH = 160;

export { mockCtx as mockMeasureCtx } from './mock-ctx.ts';

/**
 * Line texts expected from layout(PARITY_HTML) at PARITY_WIDTH with the mock
 * ctx — identical in browser (ambient DOMParser) and Node (injected linkedom)
 * by construction; each environment's test asserts against this constant.
 */
export const EXPECTED_LINES = [
  'Hello world this',
  'is a wrap test',
  'Bold and',
  'big\u00A0text with &', // NBSP from &nbsp; keeps "big text" unbreakable
  'entities',
  '• alpha',
  '• beta gamma',
];

export const EXPECTED_HEIGHT = 144;

export function lineTexts(lines: Array<{ text: string }>): string[] {
  return lines.map((l) => l.text);
}
