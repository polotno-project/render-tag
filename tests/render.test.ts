import { describe, it, expect } from 'vitest';
import { compareRenders } from './helpers/compare.ts';
import { loadBasicCases, loadGoogleFontCase, polotnoCase, polotnoListsCase } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';

// Maximum allowed content mismatch percentage (content pixels only, not total area)
const MAX_MISMATCH_PERCENT = 55;
const PIXEL_RATIO = 2;

function formatResult(tc: BenchmarkCase, result: ComparisonResult): string {
  const contentPct = (result.contentPixels / result.totalPixels * 100).toFixed(0);
  return `[${tc.name}] content-mismatch: ${result.contentMismatchPercentage.toFixed(2)}% ` +
    `(${result.mismatchedPixels}/${result.contentPixels} content px, ${contentPct}% filled) | ` +
    `ref: ${result.referenceTime.toFixed(0)}ms | ` +
    `canvas: ${result.canvasLibTime.toFixed(0)}ms | ` +
    `${(result.referenceTime / result.canvasLibTime).toFixed(0)}x`;
}

async function testCase(tc: BenchmarkCase) {
  const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  console.log(formatResult(tc, result));

  expect(
    result.contentMismatchPercentage,
    `Content mismatch for "${tc.name}" is ${result.contentMismatchPercentage.toFixed(2)}%, expected < ${MAX_MISMATCH_PERCENT}%`,
  ).toBeLessThan(MAX_MISMATCH_PERCENT);
}

type ComparisonResult = Awaited<ReturnType<typeof compareRenders>>;

describe('HTML Canvas Renderer', () => {
  let allCases: BenchmarkCase[];

  it('loads all test cases', async () => {
    allCases = await loadBasicCases();
    expect(allCases.length).toBeGreaterThan(0);
    console.log(`Loaded ${allCases.length} test cases`);
  });

  // Dynamically create a test for each basic case
  // We use a pre-loaded cache since vitest needs static it() calls
  describe('Basic & extended cases', () => {
    // Run all cases dynamically
    it('all cases', async () => {
      if (!allCases) allCases = await loadBasicCases();
      let passed = 0;
      let failed = 0;
      const failures: string[] = [];

      for (const tc of allCases) {
        const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
        console.log(formatResult(tc, result));
        if (result.contentMismatchPercentage < MAX_MISMATCH_PERCENT) {
          passed++;
        } else {
          failed++;
          failures.push(`${tc.name}: ${result.contentMismatchPercentage.toFixed(2)}%`);
        }
      }

      console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed out of ${allCases.length} ===`);
      if (failures.length > 0) {
        console.log('Failures:\n  ' + failures.join('\n  '));
      }

      expect(failed, `${failed} cases exceeded ${MAX_MISMATCH_PERCENT}% content mismatch:\n  ${failures.join('\n  ')}`).toBe(0);
    });
  });

  describe('Google Font case', () => {
    it('Google Font (Roboto)', async () => {
      const tc = await loadGoogleFontCase();
      await testCase(tc);
    });
  });

  describe('Polotno cases', () => {
    it('Polotno HTML', async () => {
      await testCase(polotnoCase);
    });

    it('Polotno Lists', async () => {
      await testCase(polotnoListsCase);
    });
  });
});
