/**
 * Geometry oracle, SHADOW MODE — report-only.
 *
 * Runs `compareGeometry` (tests/helpers/geometry.ts) over the corpus at each
 * case's own width and writes `tests/geometry-report.<browser>.json`
 * (git-ignored): per key, order-aware line membership, visual order, and the
 * signed per-token x / baseline / advance and per-line baseline / x-range
 * errors against the browser's own layout.
 *
 * It asserts NOTHING about those numbers yet. Gates (membership exact, numeric
 * budgets) come after the numbers have been read on every lane and on a CI
 * runner — see the Tier-2 plan. The one failure is an exception: a key that
 * throws is a broken oracle or a broken layout, never a residual.
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { prepareComparisonFonts, warmNativeLayout } from './helpers/compare.ts';
import { compareGeometry, type GeometryComparison } from './helpers/geometry.ts';
import {
  loadBasicCases, loadMultiFontCss, FONT_VARIANTS,
  polotnoCase, polotnoListsCase, negativeListMarginsCase,
} from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';

/** `'default'` = the corpus font; `'all'` adds the 5 font variants. */
const FONT_MODE: 'default' | 'all' = 'all';

describe('Geometry oracle (shadow mode)', () => {
  it('writes the geometry report', async () => {
    const started = performance.now();
    const allCases = await loadBasicCases();
    const work: Array<{ key: string; tc: BenchmarkCase; css: string }> = [];
    for (const tc of [...allCases, polotnoCase, polotnoListsCase, negativeListMarginsCase]) {
      work.push({ key: tc.name, tc, css: tc.css });
    }
    if (FONT_MODE === 'all') {
      const multiFontCss = await loadMultiFontCss();
      for (const font of FONT_VARIANTS) {
        for (const tc of allCases) {
          work.push({
            key: `${tc.name}@${font.name}`,
            tc,
            // The same CSS the pixel matrix (render.test) builds per font.
            css: `${multiFontCss}\n${tc.css}\nbody { font-family: ${font.family} !important; }`,
          });
        }
      }
    }

    const keys: Record<string, GeometryComparison & { width: number }> = {};
    const errors: string[] = [];
    for (const unit of work) {
      try {
        await prepareComparisonFonts(unit.tc.html, unit.css);
        warmNativeLayout(unit.tc.html, unit.css, unit.tc.width);
        keys[unit.key] = {
          width: unit.tc.width,
          ...compareGeometry(unit.tc.html, unit.css, unit.tc.width, unit.tc.height),
        };
      } catch (error) {
        errors.push(`${unit.key}: ${(error as Error)?.stack ?? error}`);
      }
      // Yield between keys: long synchronous runs starve the runner's RPC.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const results = Object.values(keys);
    const summary = {
      browser: browserName,
      fontMode: FONT_MODE,
      keys: results.length,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      membershipMismatches: results.filter((r) => !r.membership).length,
      sortedMembershipMismatches: results.filter((r) => !r.sortedMembership).length,
      legacyMembershipMismatches: results.filter((r) => !r.legacyMembership).length,
      visualOrderMismatchKeys: results.filter((r) => r.visualOrderMismatches.length > 0).length,
      keysWithUnmatchedChars: results.filter(
        (r) => r.unmatchedChars.dom + r.unmatchedChars.canvas > 0,
      ).length,
    };
    await commands.writeFile(
      `./tests/geometry-report.${browserName}.json`,
      `${JSON.stringify({ summary, keys }, null, 1)}\n`,
    );
    console.log(`geometry oracle: ${JSON.stringify(summary)}`);

    expect(errors, `Geometry oracle threw:\n${errors.join('\n')}`).toEqual([]);
  }, 600_000);
});
