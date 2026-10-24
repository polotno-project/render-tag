/**
 * Compare the current browser's canvas layout against Chrome's canvas layout.
 * The Chrome reference is a local recording (environment-pinned, git-ignored)
 * in tests/.out/cross-browser-reference.json; update mode on Chromium writes it.
 *
 *   npm run update -- --project chromium tests/cross-browser.compare.test.ts  # record the reference
 *   npx vitest run --project webkit tests/cross-browser.compare.test.ts       # or firefox
 *   npm run update -- --project webkit tests/cross-browser.compare.test.ts    # re-record residuals
 */
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { prepareComparisonFonts, renderToCanvas } from './helpers/compare.ts';
import {
  compareLineMembership,
  normalizeLineText,
} from './helpers/wrap-comparison.ts';
import { loadCorpus, polotnoCase, polotnoListsCase } from './helpers/test-cases.ts';
import { gateResidualBaseline } from './helpers/baselines.ts';
import residualBaseline from './cross-browser-baseline.json';
import { browserName } from './helpers/browser-name.ts';
import { PORTABLE_GATES_ONLY } from './helpers/portable-mode.ts';
import { reportPath } from './helpers/report-path.ts';

interface ReferenceLine {
  y: number;
  text: string;
}

interface ReferenceEntry {
  lines: ReferenceLine[];
}

const REFERENCE_FILE = reportPath('cross-browser-reference.json');
const RECORD_COMMAND = 'npm run update -- --project chromium tests/cross-browser.compare.test.ts';
const UPDATE_MODE = import.meta.env.MODE === 'update';

/** The corpus without negativeListMarginsCase: the recorded reference and residuals predate it. */
const loadCrossBrowserCorpus = () => loadCorpus({ extras: [polotnoCase, polotnoListsCase] });

/** Canvas lines per corpus key, as the reference records them. */
async function canvasLines(): Promise<Array<{ key: string; lines: ReferenceLine[] }>> {
  const out: Array<{ key: string; lines: ReferenceLine[] }> = [];
  for (const { key, tc, css } of await loadCrossBrowserCorpus()) {
    await prepareComparisonFonts(tc.html, css);
    out.push({ key, lines: renderToCanvas(tc.html, css, tc.width, tc.height).lines });
  }
  return out;
}

/** The Chrome reference, or null when it has not been recorded here. */
async function readReference(): Promise<Record<string, ReferenceEntry> | null> {
  let json: string;
  try {
    json = await commands.readFile(REFERENCE_FILE);
  } catch (error) {
    if (String(error).includes('ENOENT')) return null;
    throw error;
  }
  return JSON.parse(json) as Record<string, ReferenceEntry>;
}

interface CaseResult {
  key: string;
  status: 'match' | 'line-count-mismatch' | 'text-mismatch' | 'y-drift' | 'no-reference';
  detail?: string;
  maxYDrift?: number;
}

function signatureHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function compareLinesAgainstReference(
  refMap: Record<string, ReferenceEntry>,
  key: string,
  currentLines: { y: number; text: string }[],
): CaseResult {
  const ref = refMap[key];
  if (!ref) return { key, status: 'no-reference' };

  const chromeLines = ref.lines.filter(l => normalizeLineText(l.text).length > 0);
  const browserLines = currentLines.filter(l => normalizeLineText(l.text).length > 0);
  const membership = compareLineMembership(browserLines, chromeLines);

  // Line count mismatch
  if (chromeLines.length !== browserLines.length) {
    const detail = `${chromeLines.length} lines (chrome) vs ${browserLines.length} lines (${browserName})`;
    return { key, status: 'line-count-mismatch', detail };
  }

  // Compare text content per line
  let maxYDrift = 0;
  const textMismatches = membership.differentLines.map(({ lineIndex, canvas, dom }) =>
    `line ${lineIndex}: chrome="${dom.substring(0, 40)}" ` +
    `${browserName}="${canvas.substring(0, 40)}"`,
  );

  for (let i = 0; i < chromeLines.length; i++) {
    // Track Y position drift
    const yDiff = Math.abs(chromeLines[i].y - browserLines[i].y);
    if (yDiff > maxYDrift) maxYDrift = yDiff;
  }

  if (textMismatches.length > 0) {
    return { key, status: 'text-mismatch', detail: textMismatches.join('\n    '), maxYDrift };
  }

  if (maxYDrift > 0) {
    return { key, status: 'y-drift', maxYDrift };
  }

  return { key, status: 'match', maxYDrift };
}

// The Chrome reference layout and the residual baseline are both recorded on
// the maintainer's machine; canvas metrics shift per OS, so portable mode
// (CI) skips this suite entirely.
describe.skipIf(PORTABLE_GATES_ONLY)(`Cross-browser consistency: ${browserName} vs chrome`, () => {
  if (browserName === 'chrome' && UPDATE_MODE) {
    it('records the Chrome reference layout', async () => {
      const results: Record<string, ReferenceEntry> = {};
      for (const { key, lines } of await canvasLines()) {
        results[key] = { lines };
        console.log(`[${key}] ${lines.length} lines`);
      }
      await commands.writeFile(REFERENCE_FILE, JSON.stringify(results, null, 2) + '\n');
      console.log(`\nRecorded ${Object.keys(results).length} cases to ${REFERENCE_FILE}`);
      expect(Object.keys(results).length).toBeGreaterThan(0);
    }, 300000);
    return;
  }

  it('all cases match Chrome reference layout', async ({ skip }) => {
    const refMap = await readReference();
    if (!refMap) {
      skip(`${REFERENCE_FILE} is missing: run \`${RECORD_COMMAND}\` first`);
      return;
    }
    const results = (await canvasLines())
      .map(({ key, lines }) => compareLinesAgainstReference(refMap, key, lines));

    // Print report
    const matches = results.filter(r => r.status === 'match');
    const lineCountMismatches = results.filter(r => r.status === 'line-count-mismatch');
    const textMismatches = results.filter(r => r.status === 'text-mismatch');
    const yDriftOnly = results.filter(r => r.status === 'y-drift');
    const noRef = results.filter(r => r.status === 'no-reference');

    console.log(`\n=== Cross-browser consistency: ${browserName} vs chrome ===\n`);

    for (const r of results) {
      if (r.status === 'match') {
        // Only log non-default-font matches briefly
        if (!r.key.includes('@')) {
          console.log(`[${r.key}] MATCH${r.maxYDrift && r.maxYDrift > 1 ? ` (y-drift: ${r.maxYDrift.toFixed(1)}px)` : ''}`);
        }
      } else if (r.status === 'line-count-mismatch') {
        console.log(`[${r.key}] LINE COUNT MISMATCH: ${r.detail}`);
      } else if (r.status === 'text-mismatch') {
        console.log(`[${r.key}] TEXT MISMATCH:\n    ${r.detail}`);
      } else if (r.status === 'y-drift') {
        if (!r.key.includes('@')) {
          console.log(`[${r.key}] Y-DRIFT: ${r.maxYDrift?.toFixed(1)}px`);
        }
      } else if (r.status === 'no-reference') {
        console.log(`[${r.key}] NO REFERENCE (record it: ${RECORD_COMMAND})`);
      }
    }

    // Font matrix summary (compact)
    const fontResults: Record<string, { match: number; total: number; mismatches: string[] }> = {};
    for (const r of results) {
      if (!r.key.includes('@')) continue;
      const fontName = r.key.split('@')[1];
      if (!fontResults[fontName]) fontResults[fontName] = { match: 0, total: 0, mismatches: [] };
      fontResults[fontName].total++;
      if (r.status === 'match' || r.status === 'y-drift') {
        fontResults[fontName].match++;
      } else {
        fontResults[fontName].mismatches.push(r.key.split('@')[0]);
      }
    }
    if (Object.keys(fontResults).length > 0) {
      console.log('\n--- Font matrix summary ---');
      for (const [font, data] of Object.entries(fontResults)) {
        console.log(`[${font}] ${data.match}/${data.total} match${data.mismatches.length > 0 ? ` | mismatches: ${data.mismatches.slice(0, 5).join(', ')}${data.mismatches.length > 5 ? '...' : ''}` : ''}`);
      }
    }

    console.log(`\n=== Summary: ${matches.length + yDriftOnly.length}/${results.length} consistent | ${lineCountMismatches.length} line-count | ${textMismatches.length} text | ${yDriftOnly.length} y-drift-only ===`);

    if (noRef.length > 0) {
      console.log(`WARNING: ${noRef.length} cases have no Chrome reference. Run: ${RECORD_COMMAND}`);
    }

    const signatures = results
      // Y positions are already checked against each engine's native DOM by
      // the pixel baselines. This lane gates cross-engine line membership;
      // engine-specific baseline branches intentionally move some baselines.
      .filter((result) =>
        result.status !== 'match' && result.status !== 'y-drift',
      )
      .map((result) =>
        `${result.key}|${result.status}|` +
        signatureHash(`${result.detail || ''}|y=${result.maxYDrift ?? 0}`),
      )
      .sort();
    const expected = await gateResidualBaseline({
      file: './tests/cross-browser-baseline.json',
      browserName,
      signatures,
      recorded: residualBaseline as Record<string, string[]>,
      updateMode: UPDATE_MODE,
      writeFile: commands.writeFile,
    });
    if (expected === null) return;
    expect(
      signatures,
      'Cross-browser residuals changed. Fix the cause or deliberately update ' +
      'tests/cross-browser-baseline.json.',
    ).toEqual(expected);
  }, 300000);
});
