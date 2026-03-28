import { describe, it, expect } from 'vitest';
import { compareRenders, compareWrapping } from './helpers/compare.ts';
import { loadBasicCases, loadGoogleFontCase, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import baselines from './baselines.json';

// Baselines are locked for Chromium. Firefox uses them as reference but
// allows more tolerance since text rendering differs between engines.
const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');

// Allow this much regression above the locked baseline before failing.
// Firefox gets more tolerance since text rendering differs between engines.
const REGRESSION_TOLERANCE = isFirefox ? 35.0 : 2.0;
const PIXEL_RATIO = 2;

type ComparisonResult = Awaited<ReturnType<typeof compareRenders>>;

function formatResult(tc: BenchmarkCase, result: ComparisonResult, baseline?: number): string {
  const pct = result.contentMismatchPercentage;
  const contentPct = (result.contentPixels / result.totalPixels * 100).toFixed(0);
  const delta = baseline !== undefined ? (pct - baseline) : 0;
  const deltaStr = baseline !== undefined
    ? (delta < -0.5 ? ` (${delta.toFixed(1)} improved)` : delta > REGRESSION_TOLERANCE ? ` (+${delta.toFixed(1)} REGRESSION!)` : '')
    : '';
  return `[${tc.name}] ${pct.toFixed(2)}%${deltaStr} ` +
    `(${result.mismatchedPixels}/${result.contentPixels} content px, ${contentPct}% filled) | ` +
    `canvas: ${result.canvasLibTime.toFixed(0)}ms`;
}

async function testCaseWithBaseline(tc: BenchmarkCase) {
  const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  const baseline = (baselines as Record<string, number>)[tc.name];
  console.log(formatResult(tc, result, baseline));

  if (baseline !== undefined) {
    const maxAllowed = baseline + REGRESSION_TOLERANCE;
    expect(
      result.contentMismatchPercentage,
      `"${tc.name}" regressed: ${result.contentMismatchPercentage.toFixed(2)}% > baseline ${baseline}% + ${REGRESSION_TOLERANCE}% tolerance`,
    ).toBeLessThanOrEqual(maxAllowed);
  }
}

describe('HTML Canvas Renderer', () => {
  let allCases: BenchmarkCase[];

  it('loads all test cases', async () => {
    allCases = await loadBasicCases();
    expect(allCases.length).toBeGreaterThan(0);
    console.log(`Loaded ${allCases.length} test cases`);
  });

  describe('Basic & extended cases', () => {
    it('all cases', async () => {
      if (!allCases) allCases = await loadBasicCases();
      let passed = 0;
      let regressed = 0;
      let improved = 0;
      const regressions: string[] = [];
      const improvements: string[] = [];

      for (const tc of allCases) {
        const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
        const baseline = (baselines as Record<string, number>)[tc.name];
        console.log(formatResult(tc, result, baseline));

        if (baseline !== undefined) {
          const pct = result.contentMismatchPercentage;
          const delta = pct - baseline;
          if (delta > REGRESSION_TOLERANCE) {
            regressed++;
            regressions.push(`${tc.name}: ${pct.toFixed(2)}% (was ${baseline}%, +${delta.toFixed(1)})`);
          } else if (delta < -1) {
            improved++;
            improvements.push(`${tc.name}: ${pct.toFixed(2)}% (was ${baseline}%, ${delta.toFixed(1)})`);
          }
          passed++;
        }
      }

      console.log(`\n=== ${passed} cases | ${improved} improved | ${regressed} regressed ===`);
      if (improvements.length > 0) {
        console.log('Improved:\n  ' + improvements.join('\n  '));
      }
      if (regressions.length > 0) {
        console.log('Regressions:\n  ' + regressions.join('\n  '));
      }

      expect(regressed, `${regressed} cases regressed:\n  ${regressions.join('\n  ')}`).toBe(0);
    });
  });

  describe('Google Font case', () => {
    it('Google Font (Roboto)', async () => {
      const tc = await loadGoogleFontCase();
      await testCaseWithBaseline(tc);
    });
  });

  describe('Polotno cases', () => {
    it('Polotno HTML', async () => {
      await testCaseWithBaseline(polotnoCase);
    });

    it('Polotno Lists', async () => {
      await testCaseWithBaseline(polotnoListsCase);
    });
  });

  describe('Layout wrapping consistency', () => {
    it('no wrapping differences vs DOM', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const failures: string[] = [];

      // Known wrapping issues — fail only if NEW cases break
      const KNOWN_WRAPPING_ISSUES = new Set([
        'Formatted text (bold, italic, colors)',
        'Styled table',
        'Multi-column layout',
        'Mixed font sizes inline',
        'Subscript and superscript',
        'Mixed font-sizes same line',
        'Soft hyphens and zero-width spaces',
        'List items with rich formatting',
        'Empty list items mixed with content',
        'Monospace vs proportional text',
        'Very narrow container',
        'Mixed Google Fonts inline',
      ]);

      const newFailures: string[] = [];
      for (const tc of allCases) {
        const result = compareWrapping(tc.html, tc.css, tc.width, tc.height);
        if (!result.wrappingMatch) {
          const diffSummary = result.differentLines.slice(0, 3).map(d =>
            `  line ${d.lineIndex}: canvas="${d.canvas.substring(0, 40)}" dom="${d.dom.substring(0, 40)}"`
          ).join('\n');
          const msg = `${tc.name} (${result.canvasLineCount} vs ${result.domLineCount} lines):\n${diffSummary}`;
          failures.push(msg);
          if (!KNOWN_WRAPPING_ISSUES.has(tc.name)) {
            newFailures.push(msg);
          }
        }
      }

      const matched = allCases.length - failures.length;
      console.log(`\nWrapping: ${matched}/${allCases.length} match (${failures.length} known issues)`);
      if (failures.length > 0) {
        console.log(`WRAPPING DIFFERENCES:\n` + failures.join('\n\n'));
      }

      expect(newFailures.length, `${newFailures.length} NEW wrapping failures:\n${newFailures.join('\n\n')}`).toBe(0);
    });
  });

  describe('Multi-font matrix', () => {
    it('all cases × all fonts', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const multiFontCss = await loadMultiFontCss();
      const fonts = FONT_VARIANTS;

      let wrappingFailures = 0;
      const wrappingDetails: string[] = [];

      for (const font of fonts) {
        let totalMismatch = 0;
        let count = 0;
        let fontWrappingFails = 0;

        for (const tc of allCases) {
          const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;

          // Check wrapping
          const wrap = compareWrapping(tc.html, css, tc.width, tc.height);
          if (!wrap.wrappingMatch) {
            fontWrappingFails++;
            wrappingFailures++;
            const diff = wrap.differentLines[0];
            wrappingDetails.push(
              `[${font.name}] ${tc.name}: line ${diff.lineIndex} canvas="${diff.canvas.substring(0, 30)}" dom="${diff.dom.substring(0, 30)}"`
            );
          }

          // Pixel comparison
          const result = await compareRenders(tc.html, css, tc.width, tc.height, 0.1, PIXEL_RATIO);
          totalMismatch += result.contentMismatchPercentage;
          count++;
        }

        const avg = totalMismatch / count;
        console.log(`[${font.name}] avg mismatch: ${avg.toFixed(1)}% | wrapping fails: ${fontWrappingFails}/${count}`);
      }

      if (wrappingDetails.length > 0) {
        console.log(`\nFONT WRAPPING DIFFERENCES (${wrappingFailures}):`);
        for (const d of wrappingDetails.slice(0, 20)) console.log('  ' + d);
        if (wrappingDetails.length > 20) console.log(`  ... and ${wrappingDetails.length - 20} more`);
      }

      // Report but don't fail — multi-font wrapping is tracked for improvement
      console.log(`Total font wrapping issues: ${wrappingFailures}`);
    });
  });
});
