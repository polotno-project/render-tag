/**
 * Run this test to regenerate baselines.json with current scores and wrapping results.
 *
 *   npm run test:update-baselines
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareRenders, compareWrapping } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';

const PIXEL_RATIO = 2;

const SKIP_WRAPPING = new Set(['Very narrow container']);

function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

describe('Generate baselines', () => {
  it('collects all scores and wrapping results', async () => {
    const allCases = await loadBasicCases();
    const results: Record<string, { score: number; wrap: boolean }> = {};

    // Default font cases (including polotno)
    const defaultCases = [...allCases, polotnoCase, polotnoListsCase];
    for (const tc of defaultCases) {
      const key = baselineKey(tc.name);
      const r = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
      const wrap = SKIP_WRAPPING.has(tc.name)
        ? { wrappingMatch: true }
        : compareWrapping(tc.html, tc.css, tc.width, tc.height);
      const score = Math.round(r.contentMismatchPercentage * 100) / 100;
      results[key] = { score, wrap: wrap.wrappingMatch };
      console.log(`[${key}] score: ${score}% wrap: ${wrap.wrappingMatch}`);
    }

    // Multi-font cases
    const multiFontCss = await loadMultiFontCss();
    for (const font of FONT_VARIANTS) {
      for (const tc of allCases) {
        const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;
        const key = baselineKey(tc.name, font.name);
        const r = await compareRenders(tc.html, css, tc.width, tc.height, 0.1, PIXEL_RATIO);
        const wrap = SKIP_WRAPPING.has(tc.name)
          ? { wrappingMatch: true }
          : compareWrapping(tc.html, css, tc.width, tc.height);
        const score = Math.round(r.contentMismatchPercentage * 100) / 100;
        results[key] = { score, wrap: wrap.wrappingMatch };
        console.log(`[${key}] score: ${score}% wrap: ${wrap.wrappingMatch}`);
      }
    }

    const json = JSON.stringify(results, null, 2) + '\n';
    console.log('__BASELINES_JSON_START__');
    console.log(json);
    console.log('__BASELINES_JSON_END__');

    // Also try to write via vitest commands (server-side file write)
    await commands.writeFile('./tests/baselines.json', json);

    console.log(`Wrote ${Object.keys(results).length} baselines to tests/baselines.json`);
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 300000);
});
