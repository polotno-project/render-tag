import { describe, it, beforeAll } from 'vitest';
import {
  compareWrapping,
  prepareComparisonFonts,
  warmNativeLayout,
} from './helpers/compare.ts';
import {
  loadBasicCases,
  FONT_VARIANTS,
  loadMultiFontCss,
} from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';

// ─── Browser detection ──────────────────────────────────────────────────
import { browserName } from './helpers/browser-name.ts';

// ─── Config ──────────────────────────────────────────────────────────────
// This runs in the browser context, where process.env is NOT populated — so
// these are plain constants you edit to tune a debugging run, not env vars.
//   FONT_MODE   'all' = default + all FONT_VARIANTS; 'default' = default only
//   CASE_FILTER null = all cases; or a Set of case names to isolate
//   WIDTH_MODE  'coarse' (6 widths/case) | 'fine' (20px sweep) | a step in px
const FONT_MODE: 'all' | 'default' = 'all';
const CASE_FILTER: Set<string> | null = null;
const WIDTH_MODE: 'coarse' | 'fine' | string = 'coarse';

// Cases that are inherently impossible / out of scope for wrap matching.
// We still measure them but flag results as "known" so they don't pollute
// the actionable failure list.
const KNOWN_HARD = new Set<string>([
  'Very narrow container', // 1ch container, browser-specific min-content
  // The extractor produces one global line stream, but these layouts contain
  // independent cell/column flows whose rows cannot be paired globally.
  'Styled table',
  'Multi-column layout',
]);

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
  let allCases: BenchmarkCase[];
  let multiFontCss: string;

  beforeAll(async () => {
    allCases = await loadBasicCases();
    multiFontCss = await loadMultiFontCss();
  }, 60000);

  it('sweeps wrapping across cases × fonts × widths', async () => {
    const cases = CASE_FILTER
      ? allCases.filter((c) => CASE_FILTER.has(c.name))
      : allCases;

    const fontPasses: { name: string; cssFor: (tc: BenchmarkCase) => string }[] =
      [{ name: 'default', cssFor: (tc) => tc.css }];
    if (FONT_MODE === 'all') {
      for (const f of FONT_VARIANTS) {
        fontPasses.push({
          name: f.name,
          cssFor: (tc) =>
            multiFontCss +
            '\n' +
            tc.css +
            `\nbody { font-family: ${f.family} !important; }`,
        });
      }
    }

    const failures: Failure[] = [];
    let totalRuns = 0;

    // Aggregations
    const failByCase = new Map<string, number>();
    const failByFont = new Map<string, number>();
    const failByCaseFont = new Map<string, number>();

    for (const tc of cases) {
      const widths = widthsFor(tc);
      const known = KNOWN_HARD.has(tc.name);
      for (const fp of fontPasses) {
        const css = fp.cssFor(tc);
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
              font: fp.name,
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
              font: fp.name,
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
            failByFont.set(fp.name, (failByFont.get(fp.name) || 0) + 1);
            const cf = `${tc.name} @ ${fp.name}`;
            failByCaseFont.set(cf, (failByCaseFont.get(cf) || 0) + 1);
          }
        }
      }
    }

    const actionable = failures.filter((f) => !f.known);
    const structural = actionable.filter((failure) =>
      failure.canvasLines !== failure.domLines,
    );

    // ─── Human-readable summary ───────────────────────────────────────────
    console.log(
      `\n=== WRAP DEBUG [${browserName}] cases=${cases.length} fontPasses=${fontPasses.length} runs=${totalRuns} ===`,
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
    const out = `tests/wrap-report.${browserName}.json`;
    await commands.writeFile(out, report);
    console.log(`Report written to ${out}`);

    // This is a DEBUG harness — it never fails the run, just reports.
  }, 600000);
});
