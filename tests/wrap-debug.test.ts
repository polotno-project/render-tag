/**
 * Wrap-accuracy debugging harness: a maintainer tool, in no lane. Sweeps every
 * case x font x width through `compareWrapping` and writes
 * `tests/.out/wrap-report.<browser>.json` (each failure with per-line diffs,
 * plus by-case and by-font counts). Tune FONT_MODE / WIDTH_MODE / CASE_FILTER
 * below: plain constants, because the browser context has no `process.env`.
 *
 *   npx vitest run --project chromium tests/wrap-debug.test.ts   # or firefox, webkit
 *
 * Classify a divergence before chasing it: a different line COUNT is likely a
 * break-logic bug; the same count with shifted membership is a break-boundary
 * divergence. Table cells and multi-column content are known-hard: their
 * independent flows cannot be paired through one global line stream.
 *
 * To tell a measurement bug from a font-loading artifact, open the benchmark
 * page (`npm run dev`, `benchmark.html?case=…&font=…`): it prints a
 * per-character canvas-vs-DOM line check and per-word measureText-vs-DOM
 * deltas. measureText matches the DOM to ~0.01px, except Playfair Display at
 * 48px (253.34px vs 251.77px for "This is 48px").
 */
import { describe, it, beforeAll } from 'vitest';
import {
  compareWrapping,
  prepareComparisonFonts,
  warmNativeLayout,
  SWEEP_WRAP_SKIPS,
} from './helpers/compare.ts';
import { loadCorpus, FONT_VARIANTS } from './helpers/test-cases.ts';
import type { BenchmarkCase, CorpusEntry } from './helpers/test-cases.ts';

// ─── Browser detection ──────────────────────────────────────────────────
import { browserName } from './helpers/browser-name.ts';
import { reportPath } from './helpers/report-path.ts';

// ─── Config ──────────────────────────────────────────────────────────────
// This runs in the browser context, where process.env is NOT populated — so
// these are plain constants you edit to tune a debugging run, not env vars.
//   FONT_MODE   'all' = default + all FONT_VARIANTS; 'default' = default only
//   CASE_FILTER null = all cases; or a Set of case names to isolate
//   WIDTH_MODE  'coarse' (6 widths/case) | 'fine' (20px sweep) | a step in px
const FONT_MODE: 'all' | 'default' = 'all';
const CASE_FILTER: Set<string> | null = null;
const WIDTH_MODE: 'coarse' | 'fine' | string = 'coarse';

// Measured but flagged "known" so they don't pollute the actionable list.
const KNOWN_HARD = SWEEP_WRAP_SKIPS;

/** Width sweep for a case based on its natural width. */
function widthsFor(tc: BenchmarkCase): number[] {
  const W = tc.width;
  const min = Math.max(80, Math.round(W * 0.25));
  if (WIDTH_MODE === 'coarse') {
    const fracs = [1.0, 0.85, 0.7, 0.55, 0.42, 0.32];
    const set = new Set<number>();
    for (const f of fracs) set.add(Math.max(min, Math.round(W * f)));
    return [...set].sort((a, b) => a - b);
  }
  const step =
    WIDTH_MODE === 'fine' ? 20 : Math.max(5, parseInt(WIDTH_MODE, 10) || 40);
  const out: number[] = [];
  for (let w = min; w <= W; w += step) out.push(w);
  if (out[out.length - 1] !== W) out.push(W);
  return out;
}

// ─── Report types ──────────────────────────────────────────────────────────
interface Failure {
  case: string;
  font: string;
  width: number;
  canvasLines: number;
  domLines: number;
  diff: { i: number; canvas: string; dom: string }[];
  known: boolean;
}

describe('Wrap debug matrix', () => {
  let corpus: CorpusEntry[];

  beforeAll(async () => {
    corpus = await loadCorpus({ extras: [], fonts: FONT_MODE === 'all' ? FONT_VARIANTS : [] });
  }, 60000);

  it('sweeps wrapping across cases × fonts × widths', async () => {
    const units = CASE_FILTER
      ? corpus.filter((unit) => CASE_FILTER.has(unit.tc.name))
      : corpus;
    const caseCount = new Set(units.map((unit) => unit.tc.name)).size;
    const fontPassCount = 1 + (FONT_MODE === 'all' ? FONT_VARIANTS.length : 0);

    const failures: Failure[] = [];
    let totalRuns = 0;

    // Aggregations
    const failByCase = new Map<string, number>();
    const failByFont = new Map<string, number>();
    const failByCaseFont = new Map<string, number>();

    for (const { tc, css, font = 'default' } of units) {
      const widths = widthsFor(tc);
      const known = KNOWN_HARD.has(tc.name);
      await prepareComparisonFonts(tc.html, css);
      warmNativeLayout(tc.html, css, tc.width);
      for (const w of widths) {
        totalRuns++;
        let res;
        try {
          res = compareWrapping(tc.html, css, w, tc.height);
        } catch (e) {
          failures.push({
            case: tc.name,
            font,
            width: w,
            canvasLines: -1,
            domLines: -1,
            diff: [{ i: -1, canvas: 'ERROR', dom: String(e) }],
            known,
          });
          continue;
        }
        if (!res.wrappingMatch) {
          failures.push({
            case: tc.name,
            font,
            width: w,
            canvasLines: res.canvasLineCount,
            domLines: res.domLineCount,
            diff: res.differentLines.slice(0, 3).map((d) => ({
              i: d.lineIndex,
              canvas: d.canvas,
              dom: d.dom,
            })),
            known,
          });
          failByCase.set(tc.name, (failByCase.get(tc.name) || 0) + 1);
          failByFont.set(font, (failByFont.get(font) || 0) + 1);
          const cf = `${tc.name} @ ${font}`;
          failByCaseFont.set(cf, (failByCaseFont.get(cf) || 0) + 1);
        }
      }
    }

    const actionable = failures.filter((f) => !f.known);
    const structural = actionable.filter((failure) =>
      failure.canvasLines !== failure.domLines,
    );

    // ─── Human-readable summary ───────────────────────────────────────────
    console.log(
      `\n=== WRAP DEBUG [${browserName}] cases=${caseCount} fontPasses=${fontPassCount} runs=${totalRuns} ===`,
    );
    console.log(
      `Failures: ${failures.length} total | ${actionable.length} actionable | ${failures.length - actionable.length} known-hard`,
    );
    console.log(
      `Actionable: ${structural.length} structural | ${actionable.length - structural.length} same-line-count drift`,
    );

    console.log('\n-- By case (actionable, desc) --');
    const byCaseSorted = [...failByCase.entries()]
      .filter(([name]) => !KNOWN_HARD.has(name))
      .sort((a, b) => b[1] - a[1]);
    for (const [name, n] of byCaseSorted) console.log(`  ${n.toString().padStart(3)}  ${name}`);

    console.log('\n-- By font --');
    for (const [name, n] of [...failByFont.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`  ${n.toString().padStart(3)}  ${name}`);

    // ─── Write machine-readable report to disk via browser command ────────
    const report = JSON.stringify(
      {
        browser: browserName,
        widthMode: WIDTH_MODE,
        fontMode: FONT_MODE,
        totalRuns,
        failureCount: failures.length,
        actionableCount: actionable.length,
        structuralCount: structural.length,
        byCase: Object.fromEntries(byCaseSorted),
        byCaseFont: Object.fromEntries(
          [...failByCaseFont.entries()].sort((a, b) => b[1] - a[1]),
        ),
        failures: actionable,
      },
      null,
      2,
    );
    const { commands } = await import('vitest/browser');
    const out = reportPath(`wrap-report.${browserName}.json`);
    await commands.writeFile(out, report);
    console.log(`Report written to ${out}`);

    // This is a DEBUG harness — it never fails the run, just reports.
  }, 600000);
});
