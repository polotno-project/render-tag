/**
 * Record Chrome canvas layout as the cross-browser reference.
 * Run this in Chrome to generate the reference data that Firefox/WebKit compare against.
 *
 *   npm run test:cross-browser:record
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { renderToCanvas } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';

interface ReferenceLine {
  y: number;
  text: string;
}

interface ReferenceEntry {
  lines: ReferenceLine[];
}

function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

describe('Cross-browser: record Chrome reference', () => {
  it('records layout lines for all cases', async () => {
    const allCases = await loadBasicCases();
    const results: Record<string, ReferenceEntry> = {};

    // Default font cases
    const defaultCases = [...allCases, polotnoCase, polotnoListsCase];
    for (const tc of defaultCases) {
      const key = baselineKey(tc.name);
      const { lines } = renderToCanvas(tc.html, tc.css, tc.width, tc.height);
      results[key] = { lines };
      console.log(`[${key}] ${lines.length} lines`);
    }

    // Multi-font cases
    const multiFontCss = await loadMultiFontCss();
    for (const font of FONT_VARIANTS) {
      for (const tc of allCases) {
        const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;
        const key = baselineKey(tc.name, font.name);
        const { lines } = renderToCanvas(tc.html, css, tc.width, tc.height);
        results[key] = { lines };
        console.log(`[${key}] ${lines.length} lines`);
      }
    }

    const json = JSON.stringify(results, null, 2) + '\n';
    await commands.writeFile('./tests/cross-browser-reference.json', json);

    console.log(`\nRecorded ${Object.keys(results).length} cases to cross-browser-reference.json`);
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 300000);
});
