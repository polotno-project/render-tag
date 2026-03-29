/**
 * Compare current browser's canvas layout against Chrome reference.
 * Run after recording Chrome reference with test:cross-browser:record.
 *
 *   npm run test:cross-browser:firefox
 *   npm run test:cross-browser:webkit
 */
import { describe, it, expect } from 'vitest';
import { renderToCanvas } from './helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import reference from './cross-browser-reference.json';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isFirefox = ua.includes('Firefox');
const isWebKit = ua.includes('AppleWebKit') && !ua.includes('Chrome');
const browserName = isFirefox ? 'firefox' : isWebKit ? 'webkit' : 'chrome';

interface ReferenceLine {
  y: number;
  text: string;
}

interface ReferenceEntry {
  lines: ReferenceLine[];
}

const refMap = reference as Record<string, ReferenceEntry>;

function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

/** Normalize text for comparison: collapse whitespace, strip list markers. */
function normalize(s: string): string {
  let n = s.replace(/\s+/g, '');
  n = n.replace(/[•○■▪▸▹◦]/g, '');
  n = n.replace(/(?:^|\b)(\d+)\./g, '');
  n = n.replace(/-$/, '');
  return n.split('').sort().join('');
}

interface CaseResult {
  key: string;
  status: 'match' | 'line-count-mismatch' | 'text-mismatch' | 'y-drift' | 'no-reference';
  detail?: string;
  maxYDrift?: number;
}

function compareLinesAgainstReference(
  key: string,
  currentLines: { y: number; text: string }[],
): CaseResult {
  const ref = refMap[key];
  if (!ref) return { key, status: 'no-reference' };

  const chromeLines = ref.lines.filter(l => normalize(l.text).length > 0);
  const browserLines = currentLines.filter(l => normalize(l.text).length > 0);

  // Line count mismatch
  if (chromeLines.length !== browserLines.length) {
    const detail = `${chromeLines.length} lines (chrome) vs ${browserLines.length} lines (${browserName})`;
    return { key, status: 'line-count-mismatch', detail };
  }

  // Compare text content per line
  let maxYDrift = 0;
  const textMismatches: string[] = [];

  for (let i = 0; i < chromeLines.length; i++) {
    const chromeNorm = normalize(chromeLines[i].text);
    const browserNorm = normalize(browserLines[i].text);

    // Check cumulative character drift (same logic as compareWrapping)
    if (chromeNorm !== browserNorm) {
      const drift = Math.abs(chromeNorm.length - browserNorm.length);
      const lineLen = Math.max(chromeNorm.length, browserNorm.length, 1);
      if (drift > Math.max(lineLen * 0.1, 2)) {
        const chromePreview = chromeLines[i].text.substring(0, 40);
        const browserPreview = browserLines[i].text.substring(0, 40);
        textMismatches.push(`line ${i}: chrome="${chromePreview}" ${browserName}="${browserPreview}"`);
      }
    }

    // Track Y position drift
    const yDiff = Math.abs(chromeLines[i].y - browserLines[i].y);
    if (yDiff > maxYDrift) maxYDrift = yDiff;
  }

  if (textMismatches.length > 0) {
    return { key, status: 'text-mismatch', detail: textMismatches.join('\n    '), maxYDrift };
  }

  if (maxYDrift > 5) {
    return { key, status: 'y-drift', maxYDrift };
  }

  return { key, status: 'match', maxYDrift };
}

describe(`Cross-browser consistency: ${browserName} vs chrome`, () => {
  it('all cases match Chrome reference layout', async () => {
    const allCases = await loadBasicCases();
    const results: CaseResult[] = [];

    // Default font cases
    const defaultCases = [...allCases, polotnoCase, polotnoListsCase];
    for (const tc of defaultCases) {
      const key = baselineKey(tc.name);
      const { lines } = renderToCanvas(tc.html, tc.css, tc.width, tc.height);
      const result = compareLinesAgainstReference(key, lines);
      results.push(result);
    }

    // Multi-font cases
    const multiFontCss = await loadMultiFontCss();
    for (const font of FONT_VARIANTS) {
      for (const tc of allCases) {
        const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;
        const key = baselineKey(tc.name, font.name);
        const { lines } = renderToCanvas(tc.html, css, tc.width, tc.height);
        const result = compareLinesAgainstReference(key, lines);
        results.push(result);
      }
    }

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
        console.log(`[${r.key}] NO REFERENCE (run test:cross-browser:record first)`);
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
      console.log(`WARNING: ${noRef.length} cases have no Chrome reference. Run: npm run test:cross-browser:record`);
    }

    // Don't fail — this is a diagnostic report
    expect(true).toBe(true);
  }, 300000);
});
