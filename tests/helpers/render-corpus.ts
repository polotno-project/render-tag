/**
 * The pixel/wrap baseline contract shared by `tests/render.test.ts` (default
 * font) and `tests/render.fonts.test.ts` (the 5-font matrix). Two files, not
 * one per font: Vitest's parallel iframes share one renderer thread, and each
 * iframe loads the whole font catalog again (6 shards measured slower than 1).
 *
 * `npm run update -- --project <browser> tests/render.test.ts
 * tests/render.fonts.test.ts` re-records `tests/baselines.<browser>.json`:
 * each run merges the keys it produced, in corpus order.
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareWrapping, WRAP_SKIPS } from './compare.ts';
import { compareNativeRenders } from './native-compare.ts';
import { loadCorpus, FONT_VARIANTS, type BenchmarkCase, type CorpusEntry } from './test-cases.ts';
import { classifyBaselineResult, mergeBaselines, type BaselineEntry } from './baselines.ts';
import chromeBaselines from '../baselines.chrome.json';
import firefoxBaselines from '../baselines.firefox.json';
import webkitBaselines from '../baselines.webkit.json';
import { browserName } from './browser-name.ts';
import { PORTABLE_GATES_ONLY } from './portable-mode.ts';

// Each browser has its own baseline file — no cross-browser tolerance needed.
export const SCORE_TOLERANCE = 0.01;
export const PIXEL_RATIO = 2;

const baselineFiles: Record<string, Record<string, BaselineEntry>> = {
  chrome: chromeBaselines as Record<string, BaselineEntry>,
  firefox: firefoxBaselines as Record<string, BaselineEntry>,
  webkit: webkitBaselines as Record<string, BaselineEntry>,
};
export const baselineMap = baselineFiles[browserName];
const BASELINE_FILE = `./tests/baselines.${browserName}.json`;
export const UPDATE_MODE = import.meta.env.MODE === 'update';

function formatResult(name: string, score: number, wrap: boolean, baseline?: BaselineEntry): string {
  const scoreDelta = baseline ? (score - baseline.score) : 0;
  const scoreStr = baseline
    ? (scoreDelta < -0.5 ? ` (${scoreDelta.toFixed(1)} improved)` : scoreDelta > SCORE_TOLERANCE ? ` (+${scoreDelta.toFixed(1)} REGRESSION!)` : '')
    : '';
  const wrapStr = baseline
    ? (baseline.wrap && !wrap ? ' (WRAP REGRESSION!)' : !baseline.wrap && wrap ? ' (wrap improved)' : '')
    : '';
  return `[${name}] score: ${score.toFixed(2)}%${scoreStr} | wrap: ${wrap}${wrapStr}`;
}

/** Run a single case: pixel comparison + wrapping check. */
export async function runCase(
  tc: BenchmarkCase,
  css: string,
): Promise<{ score: number; wrap: boolean }> {
  const result = await compareNativeRenders(tc.html, css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  const wrap = WRAP_SKIPS.has(tc.name)
    ? { wrappingMatch: true } // skipped = treat as passing
    : compareWrapping(tc.html, css, tc.width, tc.height, result.canvasLines);
  return { score: result.contentMismatchPercentage, wrap: wrap.wrappingMatch };
}

/**
 * Score every case against its recorded baseline and fail on ANY unrecorded
 * change. In portable mode the cases still render and log; only the
 * environment-pinned contract is not gated. In update mode the scores
 * (rounded to 0.01) and wraps are recorded instead.
 */
export async function gateBaselines(cases: CorpusEntry[]): Promise<void> {
  const issues: string[] = [];
  const produced: Record<string, BaselineEntry> = {};
  let totalScore = 0;
  for (const { key, tc, css } of cases) {
    const baseline = PORTABLE_GATES_ONLY || UPDATE_MODE ? undefined : baselineMap[key];
    const { score, wrap } = await runCase(tc, css);
    console.log(formatResult(key, score, wrap, baseline));
    totalScore += score;
    if (UPDATE_MODE) {
      produced[key] = { score: Math.round(score * 100) / 100, wrap };
    } else if (!PORTABLE_GATES_ONLY) {
      issues.push(...classifyBaselineResult(key, score, wrap, baseline, SCORE_TOLERANCE));
    }
  }
  console.log(`avg: ${(totalScore / cases.length).toFixed(1)}% over ${cases.length} cases`);
  if (UPDATE_MODE) {
    // Read the file, not the imported module: an earlier file or font in
    // this run may have rewritten it.
    const recorded = JSON.parse(await commands.readFile(BASELINE_FILE)) as Record<string, BaselineEntry>;
    const keys = (await loadCorpus()).map((entry) => entry.key);
    await commands.writeFile(BASELINE_FILE, JSON.stringify(mergeBaselines(keys, recorded, produced), null, 2) + '\n');
    console.log(`Recorded ${cases.length} baselines in ${BASELINE_FILE}`);
    return;
  }
  expect(issues, `Baseline contract changed:\n  ${issues.join('\n  ')}`).toEqual([]);
}

/** The corpus under one `FONT_VARIANTS` entry: the body of a per-font shard. */
export function fontMatrixSuite(fontName: (typeof FONT_VARIANTS)[number]['name']): void {
  const font = FONT_VARIANTS.find((variant) => variant.name === fontName)!;
  describe(`Multi-font matrix: ${fontName}`, () => {
    // Cold WebKit native captures can take longer than five minutes on macOS.
    it('all cases (score + wrapping)', async () => {
      await gateBaselines(await loadCorpus({ defaultFont: false, fonts: [font] }));
    }, 900_000);
  });
}
