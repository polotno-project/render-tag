import { describe, it, expect } from 'vitest';
import { compareRenders } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';

// Step size: 10px increments for the initial sweep
const STEP = 10;
// Content mismatch threshold — layout shifts cause huge spikes
const LAYOUT_SHIFT_THRESHOLD = 30;
// Minimum width to test
const MIN_WIDTH = 100;

async function stressTestCase(tc: BenchmarkCase): Promise<{ name: string; failures: string[]; maxMismatch: number }> {
  const failures: string[] = [];
  let maxMismatch = 0;

  const startWidth = MIN_WIDTH;
  const endWidth = tc.width;

  for (let w = startWidth; w <= endWidth; w += STEP) {
    const result = await compareRenders(tc.html, tc.css, w, tc.height, 0.1, 1);
    const pct = result.contentMismatchPercentage;

    if (pct > maxMismatch) maxMismatch = pct;

    if (pct > LAYOUT_SHIFT_THRESHOLD) {
      failures.push(`w=${w}: ${pct.toFixed(1)}%`);
    }
  }

  return { name: tc.name, failures, maxMismatch };
}

describe('Layout stress test (width sweep)', () => {
  it('sweeps widths for key cases', async () => {
    const cases = await loadBasicCases();

    // Test a subset of important cases
    const keyCases = [
      cases[0],  // Simple paragraph
      cases[1],  // Formatted text
      cases[2],  // Multi-heading article
      cases[4],  // Rich blog post
      cases[6],  // Multi-column layout
      cases[9],  // Dense inline formatting
      polotnoCase,
      polotnoListsCase,
    ];

    const allResults: Array<{ name: string; failures: string[]; maxMismatch: number }> = [];

    for (const tc of keyCases) {
      const result = await stressTestCase(tc);
      const status = result.failures.length === 0 ? 'OK' : `FAIL (${result.failures.length} widths)`;
      console.log(
        `[${tc.name}] max=${result.maxMismatch.toFixed(1)}% ${status}` +
        (result.failures.length > 0 ? `\n  ${result.failures.join('\n  ')}` : ''),
      );
      allResults.push(result);
    }

    const totalFailures = allResults.reduce((s, r) => s + r.failures.length, 0);
    console.log(`\n=== ${allResults.length} cases tested, ${totalFailures} width failures ===`);
  });
}, 120000);
