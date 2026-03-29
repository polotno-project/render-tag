/**
 * Run this test to regenerate baselines for the current browser.
 *
 *   npm run test:update-baselines            # Chrome
 *   npm run test:update-baselines:firefox    # Firefox
 *   npm run test:update-baselines:webkit     # WebKit/Safari
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareRenders, compareWrapping } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';

const PIXEL_RATIO = 2;

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isFirefox = ua.includes('Firefox');
const isWebKit = ua.includes('AppleWebKit') && !ua.includes('Chrome');
const browserName = isFirefox ? 'firefox' : isWebKit ? 'webkit' : 'chrome';
const baselineFile = `./tests/baselines.${browserName}.json`;

const SKIP_WRAPPING = new Set([
  'Very narrow container',
  ...(isFirefox ? ['Long unbroken word overflow-wrap'] : []),
]);

function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

describe('Generate baselines', () => {
  it(`collects all scores and wrapping results for ${browserName}`, async () => {
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
    await commands.writeFile(baselineFile, json);

    console.log(`\nWrote ${Object.keys(results).length} baselines to ${baselineFile} (${browserName})`);
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 300000);
});
