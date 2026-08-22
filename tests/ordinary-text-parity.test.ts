import { expect, it } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import {
  FONT_VARIANTS,
  loadBasicCases,
  loadMultiFontCss,
} from './helpers/test-cases.ts';

const simpleParagraph = async () =>
  (await loadBasicCases()).find((testCase) => testCase.name === 'Simple paragraph')!;

it('paints ordinary Cyrillic text exactly like Chrome DOM', async () => {
  const simple = await simpleParagraph();
  const html = '<p>Привет, мир. Быстрая лиса перепрыгнула через ленивую собаку.</p>';
  const css = `${simple.css}
    body { font-family: 'Open Sans', sans-serif; font-size: 16px; line-height: normal; }
    p { margin: 0; }`;

  const result = await compareNativeRenders(html, css, 500, 80, 0, 2);

  expect(result.mismatchedPixels).toBe(0);
});

it('paints an ordinary Playfair paragraph exactly like Chrome DOM', async () => {
  const simple = await simpleParagraph();
  const playfair = FONT_VARIANTS.find((font) => font.name === 'Playfair Display')!;
  const css = `${await loadMultiFontCss()}
    ${simple.css}
    body { font-family: ${playfair.family} !important; }`;

  const result = await compareNativeRenders(
    simple.html,
    css,
    simple.width,
    simple.height,
    0,
    2,
  );

  expect(result.mismatchedPixels).toBe(0);
});
