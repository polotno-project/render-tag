import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareRenders, compareWrapping } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import chromeBaselines from './baselines.chrome.json';
import firefoxBaselines from './baselines.firefox.json';
import webkitBaselines from './baselines.webkit.json';

// Detect browser engine
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isFirefox = ua.includes('Firefox');
const isWebKit = ua.includes('AppleWebKit') && !ua.includes('Chrome');
const browserName = isFirefox ? 'firefox' : isWebKit ? 'webkit' : 'chrome';

// Each browser has its own baseline file — no cross-browser tolerance needed.
// 2% tolerance accounts for minor run-to-run variance within the same engine.
const SCORE_TOLERANCE = 2.0;
const PIXEL_RATIO = 2;

interface BaselineEntry {
  score: number;
  wrap: boolean;
}

const baselineFiles: Record<string, Record<string, BaselineEntry>> = {
  chrome: chromeBaselines as Record<string, BaselineEntry>,
  firefox: firefoxBaselines as Record<string, BaselineEntry>,
  webkit: webkitBaselines as Record<string, BaselineEntry>,
};
const baselineMap = baselineFiles[browserName];
const baselineFile = `./tests/baselines.${browserName}.json`;

// Known wrapping limitations that are skipped from wrap checks
const SKIP_WRAPPING = new Set([
  'Very narrow container',
  ...(isFirefox ? ['Long unbroken word overflow-wrap'] : []),
]);

type ComparisonResult = Awaited<ReturnType<typeof compareRenders>>;

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

/** Run a single case: pixel comparison + wrapping check. Returns score and wrap result. */
async function runCase(
  tc: BenchmarkCase,
  css: string,
): Promise<{ score: number; wrap: boolean; result: ComparisonResult }> {
  const result = await compareRenders(tc.html, css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  const wrap = SKIP_WRAPPING.has(tc.name)
    ? { wrappingMatch: true } // skipped = treat as passing
    : compareWrapping(tc.html, css, tc.width, tc.height);
  return { score: result.contentMismatchPercentage, wrap: wrap.wrappingMatch, result };
}

/** Baseline key for a case, optionally with a font suffix. */
function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

/**
 * Compare a result against its baseline.
 * Pushes detail strings into the provided arrays.
 */
function classifyResult(
  key: string,
  score: number,
  wrap: boolean,
  baseline: BaselineEntry | undefined,
  regressions: string[],
  improvements: string[],
): void {
  if (!baseline) return;

  if (score - baseline.score > SCORE_TOLERANCE) {
    regressions.push(`${key}: score ${score.toFixed(2)}% (was ${baseline.score}%, +${(score - baseline.score).toFixed(1)})`);
  } else if (score - baseline.score < -1) {
    improvements.push(`${key}: score ${score.toFixed(2)}% (was ${baseline.score}%, ${(score - baseline.score).toFixed(1)})`);
  }
  if (baseline.wrap && !wrap) {
    regressions.push(`${key}: wrapping regressed (was passing)`);
  } else if (!baseline.wrap && wrap) {
    improvements.push(`${key}: wrapping improved (now passing)`);
  }
}

/**
 * If there are improvements and no regressions, auto-update the browser's baselines file.
 * Merges new results into existing baselines (preserves entries not in collected).
 */
async function autoUpdateBaselines(
  collected: Record<string, BaselineEntry>,
  improvements: string[],
  regressions: string[],
): Promise<void> {
  if (improvements.length === 0 || regressions.length > 0) return;

  const updated = { ...baselineMap };
  for (const [key, entry] of Object.entries(collected)) {
    updated[key] = {
      score: Math.round(entry.score * 100) / 100,
      wrap: entry.wrap,
    };
  }

  const json = JSON.stringify(updated, null, 2) + '\n';
  await commands.writeFile(baselineFile, json);
  console.log(`\n✓ Auto-updated ${baselineFile} (${improvements.length} improvements locked in)`);
}

describe('HTML Canvas Renderer', () => {
  let allCases: BenchmarkCase[];
  // Collected results across all describes — used for auto-update at the end
  const collected: Record<string, BaselineEntry> = {};
  const allRegressions: string[] = [];
  const allImprovements: string[] = [];

  const hasBaselines = Object.keys(baselineMap).length > 0;

  it('loads all test cases', async () => {
    allCases = await loadBasicCases();
    expect(allCases.length).toBeGreaterThan(0);
    console.log(`Loaded ${allCases.length} test cases | browser: ${browserName} | baselines: ${Object.keys(baselineMap).length}`);
  });

  describe('Default font cases', () => {
    it('all cases (score + wrapping)', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const cases = [...allCases, polotnoCase, polotnoListsCase];
      const regressions: string[] = [];
      const improvements: string[] = [];

      for (const tc of cases) {
        const key = baselineKey(tc.name);
        const baseline = baselineMap[key];
        const { score, wrap } = await runCase(tc, tc.css);
        collected[key] = { score, wrap };
        console.log(formatResult(key, score, wrap, baseline));
        classifyResult(key, score, wrap, baseline, regressions, improvements);
      }

      allRegressions.push(...regressions);
      allImprovements.push(...improvements);

      console.log(`\n=== ${cases.length} cases | ${improvements.length} improved | ${regressions.length} regressed ===`);
      if (improvements.length > 0) console.log('Improved:\n  ' + improvements.join('\n  '));
      if (regressions.length > 0) console.log('Regressions:\n  ' + regressions.join('\n  '));

      expect(regressions.length, `${regressions.length} regressions:\n  ${regressions.join('\n  ')}`).toBe(0);
    });
  });

  describe('Punctuation wrapping', () => {
    it('trailing comma stays with preceding word', async () => {
      const html = '<p>Just some words before the <strong>target</strong>, then rest of text continues here</p>';
      const css = 'body { font-family: sans-serif; font-size: 16px; }';
      const { render } = await import('../src/index.ts');
      const fullHtml = `<style>${css}</style>${html}`;

      let testWidth = 0;
      for (let w = 300; w >= 100; w--) {
        const r = render({ html: fullHtml, width: w, height: 200 });
        const line0 = r.lines[0]?.text || '';
        if (line0.includes('target') && !line0.includes(',')) {
          testWidth = w;
          break;
        }
      }

      if (testWidth === 0) return; // fix already prevents comma wrapping

      const result = render({ html: fullHtml, width: testWidth, height: 200 });
      const wrap = compareWrapping(html, css, testWidth, 200, result.lines);
      expect(wrap.wrappingMatch, 'Trailing comma should not wrap to next line').toBe(true);
    });
  });

  describe('Multi-font matrix', () => {
    it('all cases × all fonts (score + wrapping)', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const multiFontCss = await loadMultiFontCss();
      const fonts = FONT_VARIANTS;
      const regressions: string[] = [];
      const improvements: string[] = [];

      for (const font of fonts) {
        let totalScore = 0;
        let count = 0;

        for (const tc of allCases) {
          const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;
          const key = baselineKey(tc.name, font.name);
          const baseline = baselineMap[key];
          const { score, wrap } = await runCase(tc, css);
          collected[key] = { score, wrap };
          console.log(formatResult(key, score, wrap, baseline));
          totalScore += score;
          count++;
          classifyResult(key, score, wrap, baseline, regressions, improvements);
        }

        console.log(`[${font.name}] avg: ${(totalScore / count).toFixed(1)}%`);
      }

      allRegressions.push(...regressions);
      allImprovements.push(...improvements);

      console.log(`\n=== Multi-font | ${improvements.length} improved | ${regressions.length} regressed ===`);
      if (improvements.length > 0) console.log('Improved:\n  ' + improvements.join('\n  '));
      if (regressions.length > 0) console.log('Regressions:\n  ' + regressions.join('\n  '));

      expect(regressions.length, `${regressions.length} regressions:\n  ${regressions.join('\n  ')}`).toBe(0);
    });
  });

  // Runs last — auto-updates the browser's baselines file if only improvements were found
  describe('Baseline auto-update', () => {
    it('locks in improvements', async () => {
      await autoUpdateBaselines(collected, allImprovements, allRegressions);
    });
  });
});
