import { describe, expect, it } from 'vitest';
import { loadBasicCases, loadMultiFontCss } from './helpers/test-cases.ts';

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
    expect(css).toContain("font-family: 'RT Noto Color Emoji'");
  });
});
