/**
 * Full-corpus width sweep at 1px resolution — the wide net for line-breaking
 * bugs. Not part of `npm test`: it is a rarely-run milestone gate.
 *
 *   npx vitest run --project chromium tests/wrap-sweep.test.ts   # or firefox, webkit
 *   npm run update -- --project chromium tests/wrap-sweep.test.ts
 *
 * Why 1px and not the stress test's 10px: wrapping is a STEP function of
 * container width, so a divergence occupies a contiguous BAND of widths whose
 * size is the disagreement itself. A 10px grid samples a band of size d with
 * probability d/10, which means it misses essentially every sub-pixel
 * threshold knife-edge and a third of the structural ones.
 *
 * Band width is the diagnosis, and the two classes want different treatment:
 *  - 1-2px  threshold knife-edge. render-tag and the DOM disagree about where
 *           one word stops fitting, by a fraction of a pixel. Inherent to
 *           canvas `measureText` vs the layout engine; recorded as a per-key
 *           COUNT so a measurement nudge does not rewrite hundreds of lines.
 *  - >=3px  the wrong break decision PERSISTS across many widths. That is a
 *           break-rule bug, and each band is recorded individually.
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import {
  prepareComparisonFonts,
  sweepWrapWidths,
  SWEEP_WRAP_SKIPS,
  warmNativeLayout,
} from './helpers/compare.ts';
import { loadCorpus, FONT_VARIANTS } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';
import { reportPath } from './helpers/report-path.ts';
import { gateResidualBaseline } from './helpers/baselines.ts';
import sweepBaseline from './wrap-sweep-baseline.json';

// ─── knobs (plain constants: the browser context has no `process.env`) ───

/** Narrowest width swept; cases narrower than this are swept at their width. */
const MIN_WIDTH = 100;
/** Bands this wide or narrower are threshold knife-edges, counted not listed. */
const KNIFE_MAX = 2;
/** `'default'` sweeps the corpus font only; `'all'` adds the 5 font variants. */
const FONT_MODE: 'default' | 'all' = 'default';
/** Restrict to these case names for a quick subset run; `null` sweeps all. */
const CASE_FILTER: string[] | null = null;

interface CaseFinding {
  key: string;
  span: number;
  failed: number;
  knifeEdges: number;
  structural: Array<[number, number]>;
}

async function sweepOne(key: string, tc: BenchmarkCase, css: string): Promise<CaseFinding> {
  const failedWidths = await sweepWrapWidths(tc.html, css, tc.width, tc.height, {
    minWidth: MIN_WIDTH,
  });

  const bands: Array<[number, number]> = [];
  for (const width of failedWidths) {
    const last = bands[bands.length - 1];
    if (last && width === last[1] + 1) last[1] = width;
    else bands.push([width, width]);
  }

  const structural = bands.filter(([a, b]) => b - a + 1 > KNIFE_MAX);
  return {
    key,
    span: tc.width - Math.min(MIN_WIDTH, tc.width) + 1,
    failed: failedWidths.length,
    knifeEdges: bands.length - structural.length,
    structural,
  };
}

describe('Full-corpus 1px width sweep', () => {
  it('finds no unrecorded line-breaking divergence', async () => {
    const wanted = (tc: BenchmarkCase) =>
      !SWEEP_WRAP_SKIPS.has(tc.name) && (!CASE_FILTER || CASE_FILTER.includes(tc.name));
    const work = (await loadCorpus({ fonts: FONT_MODE === 'all' ? FONT_VARIANTS : [] }))
      .filter((unit) => wanted(unit.tc));

    const findings: CaseFinding[] = [];
    let points = 0;
    let failures = 0;

    for (const [index, unit] of work.entries()) {
      // Per-key breadcrumb through the server. Browser console output does
      // not stream to the terminal here, and a killed page can make vitest
      // exit silently (even with code 0) — on a crash this file is the only
      // record of which key was running. Keeping the page alive is
      // sweepWrapWidths' job: it yields the task queue inside each case.
      await commands.writeFile(
        reportPath(`wrap-sweep-progress.${browserName}.log`),
        `[${index + 1}/${work.length}] ${unit.key}\n`,
      );
      await prepareComparisonFonts(unit.tc.html, unit.css);
      warmNativeLayout(unit.tc.html, unit.css, unit.tc.width);
      const finding = await sweepOne(unit.key, unit.tc, unit.css);
      points += finding.span;
      failures += finding.failed;
      if (finding.failed > 0) findings.push(finding);
      if (index % 25 === 0 || index === work.length - 1) {
        console.log(
          `[${index + 1}/${work.length}] ${points} widths, ${failures} failing ` +
          `(${findings.length} keys affected)`,
        );
      }
    }

    const structuralBands = findings.reduce((n, f) => n + f.structural.length, 0);
    console.log(
      `\n=== ${browserName}: ${work.length} keys, ${points} widths swept, ` +
      `${failures} failing, ${structuralBands} structural bands ===`,
    );

    // Widest structural bands first — the fixing work queue.
    const queue = findings
      .flatMap((f) => f.structural.map(([a, b]) => ({ key: f.key, a, b, size: b - a + 1 })))
      .sort((x, y) => y.size - x.size);
    for (const band of queue.slice(0, 25)) {
      console.log(`  ${band.size}px  ${band.key}  w=${band.a}-${band.b}`);
    }

    await commands.writeFile(
      reportPath(`wrap-sweep-report.${browserName}.json`),
      JSON.stringify({ browserName, points, failures, findings }, null, 1) + '\n',
    );

    const signatures = findings
      .flatMap((f) => [
        ...f.structural.map(([a, b]) => `${f.key} w=${a}-${b}`),
        ...(f.knifeEdges > 0 ? [`${f.key} knife=${f.knifeEdges}`] : []),
      ])
      .sort();

    const expected = await gateResidualBaseline({
      file: './tests/wrap-sweep-baseline.json',
      browserName,
      signatures,
      recorded: sweepBaseline as unknown as Record<string, string[]>,
      updateMode: import.meta.env.MODE === 'update',
      writeFile: commands.writeFile,
    });
    if (expected === null) return;
    expect(
      signatures,
      'Width-sweep divergence changed. Fix the cause or deliberately update ' +
      'tests/wrap-sweep-baseline.json.',
    ).toEqual(expected);
  }, 7_200_000);
});
