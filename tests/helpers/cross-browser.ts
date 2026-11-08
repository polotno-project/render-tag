/**
 * render-tag's layout in one browser against its layout in Chrome: the one comparison
 * `cross-browser.compare` gates and `cross-browser.bench` reports. render-tag lays out as
 * Chrome in every browser (README), so any difference here is a bug or a canvas left to
 * normalize.
 */
import { compareLineMembership, normalizeLineText } from './wrap-comparison.ts';
import { loadCorpus, polotnoCase, polotnoListsCase } from './test-cases.ts';
import { browserName } from './browser-name.ts';

/** The corpus both compare, without negativeListMarginsCase: the recorded residuals predate it. */
export const loadCrossBrowserCorpus = () => loadCorpus({ extras: [polotnoCase, polotnoListsCase] });

/** A line as the Chrome reference records it (`LayoutLine`). */
export interface ReferenceLine {
  y: number;
  text: string;
  bounds?: { x: number; width: number };
}

/** A line's left or right edge further from Chrome's than this is a layout difference. */
export const X_TOLERANCE = 0.5;

export type LayoutStatus = 'match' | 'line-count-mismatch' | 'text-mismatch' | 'y-drift' | 'x-drift';

export interface LayoutComparison {
  status: LayoutStatus;
  detail?: string;
  maxYDrift?: number;
  maxXDrift?: number;
}

/**
 * Compare `browserLines` with Chrome's `chromeLines`, the first difference by severity:
 * line count, line membership, a line's y, a line's left or right edge past X_TOLERANCE.
 */
export function compareLayout(
  chromeLines: readonly ReferenceLine[], browserLines: readonly ReferenceLine[], lane = browserName,
): LayoutComparison {
  const chrome = chromeLines.filter((line) => normalizeLineText(line.text).length > 0);
  const browser = browserLines.filter((line) => normalizeLineText(line.text).length > 0);
  if (chrome.length !== browser.length) {
    return { status: 'line-count-mismatch', detail: `${chrome.length} lines (chrome) vs ${browser.length} lines (${lane})` };
  }
  const membership = compareLineMembership(browser, chrome);
  const textMismatches = membership.differentLines.map(({ lineIndex, canvas, dom }) =>
    `line ${lineIndex}: chrome="${dom.substring(0, 40)}" ${lane}="${canvas.substring(0, 40)}"`);
  let maxYDrift = 0;
  let maxXDrift = 0;
  for (let i = 0; i < chrome.length; i++) {
    maxYDrift = Math.max(maxYDrift, Math.abs(chrome[i].y - browser[i].y));
    const a = chrome[i].bounds;
    const b = browser[i].bounds;
    if (a && b) maxXDrift = Math.max(maxXDrift, Math.abs(a.x - b.x), Math.abs(a.x + a.width - (b.x + b.width)));
  }
  if (textMismatches.length > 0) return { status: 'text-mismatch', detail: textMismatches.join('\n    '), maxYDrift, maxXDrift };
  if (maxYDrift > 0) return { status: 'y-drift', maxYDrift, maxXDrift };
  if (maxXDrift > X_TOLERANCE) return { status: 'x-drift', maxXDrift };
  return { status: 'match', maxYDrift, maxXDrift };
}
