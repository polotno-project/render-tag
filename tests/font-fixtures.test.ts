import { describe, expect, it } from 'vitest';
import {
  fontFaceCoversText,
  keepUsedFontFaces,
  loadBasicCases,
  loadMultiFontCss,
} from './helpers/test-cases.ts';
import { matchFontFaces } from './helpers/css-text.ts';

const covers = (face: string, codePoint: number) =>
  fontFaceCoversText(face, new Set([codePoint]));

describe('hermetic font fixtures', () => {
  it('loads every corpus face from the local test server', async () => {
    const cases = await loadBasicCases();
    const css = cases.map((testCase) => testCase.css).join('\n') +
      await loadMultiFontCss();

    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
    expect(css).toContain(`${location.origin}/`);
    expect(css).toContain("font-family: 'Open Sans'");
    expect(css).toContain("font-family: 'RT Noto Sans Arabic'");
    expect(css).toContain("font-family: 'RT Noto Sans SC'");
    expect(css).toContain("font-family: 'RT Noto Sans KR'");
    expect(css).toContain("font-family: 'RT Noto Emoji'");
  });

  // The shared canvas document registers the whole catalog, so it can always
  // reach a family's neutral face. The isolated reference page only ever sees
  // the pruned fixture CSS: prune that face away and the two sides take spaces
  // and punctuation from different families, which scores as a render defect.
  it('keeps the neutral face of a family whose letters come from another subset', async () => {
    const css = await loadMultiFontCss();
    const kept = keepUsedFontFaces(
      css,
      `<p style="font-family:'Open Sans'">Привет, мир.</p>`,
    );
    const openSans = matchFontFaces(kept).filter((face) =>
      /font-family:\s*'?Open Sans'?/i.test(face),
    );

    expect(openSans.some((face) => covers(face, 0x0410))).toBe(true);
    expect(openSans.some((face) => covers(face, 0x0020))).toBe(true);
  });
});
