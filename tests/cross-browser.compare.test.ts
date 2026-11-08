/**
 * Compare the current browser's canvas layout against Chrome's canvas layout.
 * The Chrome reference is recorded where the comparison runs (git-ignored,
 * tests/.out/cross-browser-reference.json); update mode on Chromium writes it,
 * and CI's Firefox and WebKit jobs record it on their runner first. Every
 * runner gates the portable cases; the residual baseline is the maintainer's.
 *
 *   npm run update -- --project chromium tests/cross-browser.compare.test.ts  # record the reference
 *   npx vitest run --project webkit tests/cross-browser.compare.test.ts       # or firefox
 *   npm run update -- --project webkit tests/cross-browser.compare.test.ts    # re-record residuals
 */
/// <reference types="vite/client" />
import { beforeAll, describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { getFontMetrics, layout } from '../src/index.ts';
import { isSimpleScript } from '../src/layout/segment.ts';
import { prepareComparisonFonts, renderToCanvas } from './helpers/compare.ts';
import { compareLayout, loadCrossBrowserCorpus, type LayoutComparison, type ReferenceLine } from './helpers/cross-browser.ts';
import { gateResidualBaseline } from './helpers/baselines.ts';
import residualBaseline from './cross-browser-baseline.json';
import { browserName } from './helpers/browser-name.ts';
import { PORTABLE_GATES_ONLY } from './helpers/portable-mode.ts';
import { reportPath } from './helpers/report-path.ts';
import { styleFixture } from './helpers/style-fixture.ts';
import arimo from './fonts/arimo/arimo-latin-wght-normal.woff2?url';
import playfair from './fonts/playfair-display/playfair-display-latin-wght-normal.woff2?url';

interface ReferenceEntry {
  lines: ReferenceLine[];
}

const REFERENCE_FILE = reportPath('cross-browser-reference.json');
const RECORD_COMMAND = 'npm run update -- --project chromium tests/cross-browser.compare.test.ts';
const UPDATE_MODE = import.meta.env.MODE === 'update';

/** Whether a case sets a font of its own (a stack, monospace): system fonts differ per runner. */
const ownFonts = (html: string, css: string) => /font-family|<tt\b/i.test(html) ||
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some(([, selector, body]) => !/^body$|@font-face/.test(selector.trim()) && /font-family\s*:(?!\s*inherit)/i.test(body));

/**
 * Canvas lines per corpus key, as the reference records them. `portable`: Latin or Cyrillic
 * text in a vendored font variant alone, which any runner lays out as the maintainer's does.
 */
async function canvasLines(): Promise<Array<{ key: string; lines: ReferenceLine[]; portable: boolean; at: (dx: number) => ReferenceLine[] }>> {
  const out: Array<{ key: string; lines: ReferenceLine[]; portable: boolean; at: (dx: number) => ReferenceLine[] }> = [];
  for (const { key, tc, css, font } of await loadCrossBrowserCorpus()) {
    await prepareComparisonFonts(tc.html, css);
    const portable = !!font && isSimpleScript(tc.html.replace(/<[^>]*>/g, '')) && !ownFonts(tc.html, tc.css);
    const at = (dx: number) => renderToCanvas(tc.html, css, tc.width + dx, tc.height).lines;
    out.push({ key, lines: at(0), portable, at });
  }
  return out;
}

/**
 * A canvas measuring a line up to 1px apart from Chrome's moves a knife-edge break, not a layout
 * rule: WebKit's canvas never kerns a space (Roboto lines 0.3-0.6px wider).
 */
const KNIFE_EDGE = 1;
/** Portable cases a canvas cannot lay out as Chrome yet, per browser and platform. */
const KNOWN_DRIFT: Record<string, string[]> = {
  // Lobster's synthetic bold italic still lays out wider in Linux Firefox, not on macOS; unmeasured.
  'firefox-linux': ['Deeply nested inline styles@Lobster'],
};
const platformKey = `${browserName}${/Linux/.test(navigator.userAgent) ? '-linux' : ''}`;

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

interface CaseResult extends Partial<LayoutComparison> {
  key: string;
  status: LayoutComparison['status'] | 'no-reference';
}

function signatureHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Portable: the box comes from vendored font files, so CI's Firefox and WebKit lanes gate it.
describe("Chrome's font box in every browser", () => {
  beforeAll(async () => {
    document.fonts.add(await new FontFace('BoxArimo', `url(${arimo})`, { weight: '100 900' }).load());
    document.fonts.add(await new FontFace('BoxPlayfair', `url(${playfair})`, { weight: '100 900' }).load());
  });

  // Chrome rounds the box to whole px; Firefox's canvas ceils it (CANVAS_CEILS_FONT_BOX).
  it.each([['BoxArimo', 16, 14, 3], ['BoxPlayfair', 100, 108, 25]] as const)(
    '%s %spx lays out on %s / %s', (family, size, ascent, descent) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      expect(getFontMetrics(ctx, styleFixture({ fontFamily: family, fontSize: size }))).toEqual({ ascent, descent });
      const { lines } = layout({ html: `<p style="margin:0;font:${size}px ${family}">Hxg</p>`, width: 1000 });
      expect(lines[0].bounds.height).toBe(ascent + descent);
    });
});

describe(`Cross-browser consistency: ${browserName} vs chrome`, () => {
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
    const entries = await canvasLines();
    const results: CaseResult[] = entries.map(({ key, lines }) =>
      refMap[key] ? { key, ...compareLayout(refMap[key].lines, lines) } : { key, status: 'no-reference' });

    // Print report
    const matches = results.filter(r => r.status === 'match');
    const lineCountMismatches = results.filter(r => r.status === 'line-count-mismatch');
    const textMismatches = results.filter(r => r.status === 'text-mismatch');
    const yDriftOnly = results.filter(r => r.status === 'y-drift');
    const xDriftOnly = results.filter(r => r.status === 'x-drift');
    const noRef = results.filter(r => r.status === 'no-reference');

    console.log(`\n=== Cross-browser consistency: ${browserName} vs chrome ===\n`);

    for (const r of results) {
      if (r.status === 'match') {
        // Only log non-default-font matches briefly
        if (!r.key.includes('@')) {
          console.log(`[${r.key}] MATCH`);
        }
      } else if (r.status === 'line-count-mismatch') {
        console.log(`[${r.key}] LINE COUNT MISMATCH: ${r.detail}`);
      } else if (r.status === 'text-mismatch') {
        console.log(`[${r.key}] TEXT MISMATCH:\n    ${r.detail}`);
      } else if (r.status === 'y-drift') {
        console.log(`[${r.key}] Y-DRIFT: ${r.maxYDrift?.toFixed(1)}px`);
      } else if (r.status === 'x-drift') {
        console.log(`[${r.key}] X-DRIFT: ${r.maxXDrift?.toFixed(2)}px`);
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
      if (r.status === 'match') {
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

    console.log(`\n=== Summary: ${matches.length}/${results.length} consistent | ${lineCountMismatches.length} line-count | ${textMismatches.length} text | ${yDriftOnly.length} y-drift | ${xDriftOnly.length} x-drift ===`);

    if (noRef.length > 0) {
      console.log(`WARNING: ${noRef.length} cases have no Chrome reference. Run: ${RECORD_COMMAND}`);
    }

    // Every runner: the portable cases keep Chrome's lines and their positions; a canvas's own
    // kerning may still move their edges (WebKit's never kerns a space).
    const holds = (status: string) => status === 'match' || status === 'x-drift';
    const drifted = results.filter((result, k) => entries[k].portable && !holds(result.status) &&
      result.status !== 'no-reference' &&
      ![-KNIFE_EDGE, KNIFE_EDGE].some((dx) => holds(compareLayout(refMap[result.key].lines, entries[k].at(dx)).status)));
    for (const result of drifted) console.log(`[portable] ${result.key}: ${result.status} ${result.detail ?? `y ${result.maxYDrift}`}`);
    expect(drifted.map((result) => result.key), 'Latin/Cyrillic cases off Chrome\'s lines (KNOWN_DRIFT)')
      .toEqual(KNOWN_DRIFT[platformKey] ?? []);
    // The residuals are the maintainer's machine's: one layout in every browser, Chrome's
    // (README), gated on line membership, line positions and line extents (X_TOLERANCE).
    if (PORTABLE_GATES_ONLY) return;
    const signatures = results
      .filter((result) => result.status !== 'match')
      .map((result) =>
        `${result.key}|${result.status}|` +
        signatureHash(`${result.detail || ''}|y=${result.maxYDrift ?? 0}|x=${Math.round((result.maxXDrift ?? 0) * 10) / 10}`),
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
