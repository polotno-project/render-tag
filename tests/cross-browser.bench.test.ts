/**
 * The cross-browser benchmark: how far render-tag in this browser is from render-tag in
 * Chrome, which lays out and paints as Chrome's DOM (README: one layout in every browser).
 * A report, not a gate (`cross-browser.compare` gates); run it after every layout change
 * and compare the summary line with the last one in the history file. The Chrome run also
 * measures render-tag in Node on `@napi-rs/canvas` (`renderInNode`), against the same Chrome.
 *
 * Per corpus case, at its own width and two narrower ones (0.85x, 0.7x: other wraps):
 * - layout: line membership, each line's y, its left and right edge (within 0.5px);
 * - visual: this browser's canvas against Chrome's at the case's width, as a mismatch %
 *   of content pixels (`compareCanvasPixels`; rasterizers differ, so 0 is not reachable:
 *   read the trend).
 *
 *   npm run bench:cross-browser         # records Chrome, measures Node, then Firefox and WebKit
 *
 * Writes tests/.out/cross-browser-bench/<lane>.json (per case) and appends one summary line
 * per lane (node, firefox, webkit) to tests/.out/cross-browser-bench/history.jsonl.
 */
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { compareCanvasPixels, prepareComparisonFonts, renderToCanvas } from './helpers/compare.ts';
import { decodePng } from './helpers/native-compare.ts';
import { compareLayout, loadCrossBrowserCorpus, type LayoutStatus, type ReferenceLine } from './helpers/cross-browser.ts';
import { browserName } from './helpers/browser-name.ts';
import { reportPath } from './helpers/report-path.ts';

const DIR = 'cross-browser-bench';
const REFERENCE = reportPath(`${DIR}/chrome-reference.json`);
const UPDATE_MODE = import.meta.env.MODE === 'update';
const WIDTH_FACTORS = [1, 0.85, 0.7];

/** The case's widths, on the half pixel. */
const widthsOf = (width: number) => WIDTH_FACTORS.map((factor) => Math.round(width * factor * 2) / 2);
/** A file name for a corpus key. */
const fileKey = (key: string) => key.replace(/[^\w@-]+/g, '_');

type Reference = Record<string, Record<string, ReferenceLine[]>>;

/** Each case's lines at each width and its canvas at its own width, here or in Node. */
async function* renders(inNode = false) {
  for (const { key, tc, css } of await loadCrossBrowserCorpus()) {
    await prepareComparisonFonts(tc.html, css);
    const byWidth: Record<string, ReferenceLine[]> = {};
    let canvas: HTMLCanvasElement | null = null;
    for (const width of widthsOf(tc.width)) {
      if (inNode) {
        const result = await commands.renderInNode(tc.html, css, width, tc.height);
        byWidth[width] = result.lines;
        canvas ??= await decodePng(result.png);
      } else {
        const result = renderToCanvas(tc.html, css, width, tc.height);
        byWidth[width] = result.lines.map((line) => ({ y: line.y, text: line.text, bounds: { x: line.bounds.x, width: line.bounds.width } }));
        canvas ??= result.canvas;
      }
    }
    yield { key, byWidth, canvas: canvas! };
  }
}

/** Measure `lane` (render-tag here, or in Node) against the recorded Chrome lines and canvases. */
async function measure(lane: string, inNode: boolean, skip: (note: string) => void): Promise<void> {
  let reference: Reference;
  try {
    reference = JSON.parse(await commands.readFile(REFERENCE)) as Reference;
  } catch {
    skip(`${REFERENCE} is missing: run npm run bench:cross-browser`);
    return;
  }
  const cases: { key: string; layout: Record<string, LayoutStatus>; drift: Record<string, string>; visual: number | null }[] = [];
  for await (const { key, byWidth, canvas } of renders(inNode)) {
    const chrome = reference[key];
    if (!chrome) continue;
    const layout: Record<string, LayoutStatus> = {};
    const drift: Record<string, string> = {};
    for (const [width, lines] of Object.entries(byWidth)) {
      if (!chrome[width]) continue;
      const result = compareLayout(chrome[width], lines, lane);
      layout[width] = result.status;
      if (result.status !== 'match') {
        drift[width] = result.detail ?? `y ${result.maxYDrift ?? 0} x ${(result.maxXDrift ?? 0).toFixed(2)}`;
      }
    }
    let visual: number | null = null;
    try {
      const png = await commands.readFile(reportPath(`${DIR}/chrome/${fileKey(key)}.png`), 'base64');
      visual = compareCanvasPixels(await decodePng(png), canvas).contentMismatchPercentage;
    } catch {
      // No Chrome canvas recorded for this case.
    }
    cases.push({ key, layout, drift, visual });
  }

  const statuses = cases.flatMap((c) => Object.values(c.layout));
  const count = (status: LayoutStatus) => statuses.filter((s) => s === status).length;
  const visuals = cases.map((c) => c.visual).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const mean = visuals.reduce((sum, v) => sum + v, 0) / Math.max(1, visuals.length);
  const summary = {
    at: new Date().toISOString(),
    browser: lane,
    cases: cases.length,
    layouts: statuses.length,
    consistent: count('match'),
    lineCount: count('line-count-mismatch'),
    membership: count('text-mismatch'),
    yDrift: count('y-drift'),
    xDrift: count('x-drift'),
    visualMean: Math.round(mean * 1000) / 1000,
    visualP90: visuals.length ? Math.round(visuals[Math.floor(visuals.length * 0.9)] * 1000) / 1000 : null,
  };
  console.log(`[cross-browser bench] ${lane}: ${summary.consistent}/${summary.layouts} layouts consistent ` +
    `(line count ${summary.lineCount}, membership ${summary.membership}, y ${summary.yDrift}, x ${summary.xDrift}); ` +
    `visual mismatch mean ${summary.visualMean}%, p90 ${summary.visualP90}%`);

  cases.sort((a, b) => (b.visual ?? 0) - (a.visual ?? 0));
  await commands.writeFile(reportPath(`${DIR}/${lane}.json`), JSON.stringify({ summary, cases }, null, 2) + '\n');
  let history = '';
  try {
    history = await commands.readFile(reportPath(`${DIR}/history.jsonl`));
  } catch {
    // The first run.
  }
  await commands.writeFile(reportPath(`${DIR}/history.jsonl`), history + JSON.stringify(summary) + '\n');
}

describe('Cross-browser benchmark', () => {
  if (browserName === 'chrome') {
    it.runIf(UPDATE_MODE)('records render-tag in Chrome', async () => {
      const reference: Reference = {};
      for await (const { key, byWidth, canvas } of renders()) {
        reference[key] = byWidth;
        await commands.writeFile(reportPath(`${DIR}/chrome/${fileKey(key)}.png`),
          canvas.toDataURL('image/png').split(',')[1], 'base64');
      }
      await commands.writeFile(REFERENCE, JSON.stringify(reference) + '\n');
      expect(Object.keys(reference).length).toBeGreaterThan(0);
    }, 900_000);
    it.runIf(UPDATE_MODE)('measures render-tag in Node against Chrome', ({ skip }) => measure('node', true, skip), 900_000);
    return;
  }

  it(`measures render-tag in ${browserName} against Chrome`, ({ skip }) => measure(browserName, false, skip), 900_000);
});
