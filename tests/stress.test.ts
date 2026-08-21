import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareNativeRenders as compareRenders } from './helpers/native-compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import stressBaseline from './stress-baseline.json';
import { browserName } from './helpers/browser-name.ts';
import { gateResidualBaseline } from './helpers/baselines.ts';

// Step size: 10px increments for the initial sweep
const STEP = 10;
// Content mismatch threshold — layout shifts cause huge spikes
const LAYOUT_SHIFT_THRESHOLD = 30;
// Minimum width to test
const MIN_WIDTH = 100;

interface WidthFailure {
  width: number;
  pct: number;
}

async function stressTestCase(tc: BenchmarkCase): Promise<{ name: string; failures: WidthFailure[]; maxMismatch: number }> {
  const failures: WidthFailure[] = [];
  let maxMismatch = 0;

  for (let width = MIN_WIDTH; width <= tc.width; width += STEP) {
    const result = await compareRenders(tc.html, tc.css, width, tc.height, 0.1, 1);
    const pct = result.contentMismatchPercentage;

    if (pct > maxMismatch) maxMismatch = pct;
    if (pct > LAYOUT_SHIFT_THRESHOLD) failures.push({ width, pct });
  }

  return { name: tc.name, failures, maxMismatch };
}

describe('Layout stress test (width sweep)', () => {
  it('sweeps widths for key cases', async () => {
    const cases = await loadBasicCases();

    const byName = new Map(cases.map((testCase) => [testCase.name, testCase]));
    const keyCases = [
      byName.get('Simple paragraph')!,
      byName.get('Formatted text (bold, italic, colors)')!,
      byName.get('Multi-heading article')!,
      byName.get('Rich blog post')!,
      byName.get('Multi-column layout')!,
      byName.get('Dense inline formatting')!,
      polotnoCase,
      polotnoListsCase,
    ];

    const allResults: Array<{ name: string; failures: WidthFailure[]; maxMismatch: number }> = [];

    for (const tc of keyCases) {
      const result = await stressTestCase(tc);
      const status = result.failures.length === 0 ? 'OK' : `FAIL (${result.failures.length} widths)`;
      console.log(
        `[${tc.name}] max=${result.maxMismatch.toFixed(1)}% ${status}` +
        (result.failures.length > 0
          ? `\n  ${result.failures.map(({ width, pct }) => `w=${width}: ${pct.toFixed(1)}%`).join('\n  ')}`
          : ''),
      );
      allResults.push(result);
    }

    const totalFailures = allResults.reduce((s, r) => s + r.failures.length, 0);
    console.log(`\n=== ${allResults.length} cases tested, ${totalFailures} width failures ===`);
    const signatures = allResults.flatMap((result) =>
      result.failures.map(({ width }) => `${result.name}@w=${width}`),
    ).sort();

    const expected = await gateResidualBaseline({
      file: './tests/stress-baseline.json',
      browserName,
      signatures,
      recorded: stressBaseline as Record<string, string[]>,
      updateMode: import.meta.env.MODE === 'update-stress',
      writeFile: commands.writeFile,
    });
    if (expected === null) return;
    expect(
      signatures,
      'Width-sweep residuals changed. Fix the cause or deliberately update ' +
      'tests/stress-baseline.json.',
    ).toEqual(expected);
  }, 300000);
});
