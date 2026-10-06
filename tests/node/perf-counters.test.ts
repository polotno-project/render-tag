/**
 * Work counters — a Tier-0 ratchet, Node only.
 *
 * Timings are noisy; the WORK behind them is not. With the deterministic
 * `recording-ctx.ts`, each fixture costs an exact number of measureText calls,
 * measured characters, font, kerning and letter-spacing assignments,
 * fillText/save/restore calls and LayoutText runs, identical on every machine. Those numbers are recorded in
 * `tests/perf-counters-baseline.json` as upper bounds, and like every other
 * recorded contract here, ANY change fails:
 *
 * - a counter going UP is a regression (e.g. a measure loop gone quadratic);
 * - a counter going DOWN is an improvement that must be promoted on purpose,
 *   so the bound keeps ratcheting instead of leaving headroom to regress into.
 *   Promote with `npm run test:update-perf-counters`.
 *
 * `sourceChars` is the fixture's own text length; it must match exactly, and
 * `measuredChars / sourceChars` is the number to drive toward ~1.
 *
 * Node takes the Blink engine branch only (UA `Node.js/…`), so Gecko/WebKit
 * paint batching is not counted here.
 */
import { afterAll, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';
import { generateLargeHTML } from '../helpers/large-doc.ts';

const BASELINE_PATH = new URL('../perf-counters-baseline.json', import.meta.url);
const UPDATE = import.meta.env.MODE === 'update-perf-counters';

afterAll(() => setDOMParser(null));

const WORDS = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris ' +
  'nisi ut aliquip ex ea commodo consequat.').split(' ');
const CJK = '日本語のテキストを、ブラウザと同じ規則で折り返す。「括弧」と（丸括弧）も禁則処理の対象です！';

interface Fixture { html: string; width: number }

const FIXTURES: Record<string, Fixture> = {
  'long paragraph (2000 words)': {
    html: `<p style="font-size:16px;margin:0">${Array.from({ length: 2000 }, (_, i) => WORDS[i % WORDS.length]).join(' ')}</p>`,
    width: 600,
  },
  'CJK paragraph (2000 chars)': {
    html: `<p style="font-size:16px;margin:0">${CJK.repeat(Math.ceil(2000 / CJK.length)).slice(0, 2000)}</p>`,
    width: 400,
  },
  'large rich document (perf.test)': {
    html: generateLargeHTML(),
    width: 600,
  },
  'ordered list (4000 items)': {
    html: `<ol style="font-size:14px;margin:0">${Array.from({ length: 4000 }, (_, i) => `<li>Item ${i} with a few words</li>`).join('')}</ol>`,
    width: 400,
  },
};

/** Characters of text the fixture carries (text nodes outside <style>). */
function sourceChars(html: string): number {
  const doc = new LinkedomDOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  let n = 0;
  const walk = (node: any) => {
    if (node.nodeType === 3) n += node.data.length;
    else if (node.nodeName !== 'STYLE') for (const child of node.childNodes) walk(child);
  };
  walk(doc.body);
  return n;
}

type Counters = Record<string, number>;

function count(fixture: Fixture): Counters {
  const rec = recordingCtx(fixture.width, 100000);
  const result = layout({ html: fixture.html, width: fixture.width, ctx: rec.ctx });
  const afterLayout = { calls: { ...rec.counts.calls }, measuredChars: rec.counts.measuredChars };
  drawLayout({ layout: result, width: fixture.width, ctx: rec.ctx, createCanvas: rec.createCanvas });
  const calls = rec.counts.calls;
  const drawn = (name: string) => (calls[name] ?? 0) - (afterLayout.calls[name] ?? 0);
  return {
    sourceChars: sourceChars(fixture.html),
    layoutTexts: collectTexts(result.layoutRoot).length,
    'layout.measureText': afterLayout.calls.measureText ?? 0,
    'layout.measuredChars': afterLayout.measuredChars,
    'layout.fontSets': afterLayout.calls['set:font'] ?? 0,
    'layout.kerningSets': afterLayout.calls['set:fontKerning'] ?? 0,
    'layout.letterSpacingSets': afterLayout.calls['set:letterSpacing'] ?? 0,
    'draw.measureText': drawn('measureText'),
    'draw.fontSets': drawn('set:font'),
    'draw.fillText': drawn('fillText'),
    'draw.save': drawn('save'),
    'draw.restore': drawn('restore'),
  };
}

it('work counters match the recorded bounds', () => {
  setDOMParser(new LinkedomDOMParser());
  const current: Record<string, Counters> = {};
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    current[name] = count(fixture);
    const c = current[name];
    console.log(`${name}: measuredChars/sourceChars ${(c['layout.measuredChars'] / c.sourceChars).toFixed(2)}, ` +
      `${c['layout.measureText']} measureText, ${c.layoutTexts} LayoutText, ${c['draw.fillText']} fillText`);
  }

  if (UPDATE) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`Recorded ${Object.keys(current).length} fixtures to tests/perf-counters-baseline.json`);
    return;
  }

  const recorded: Record<string, Counters> = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const problems: string[] = [];
  for (const name of Object.keys(recorded)) if (!current[name]) problems.push(`${name}: recorded fixture no longer exists`);
  for (const [name, counters] of Object.entries(current)) {
    const bounds = recorded[name];
    if (!bounds) { problems.push(`${name}: no recorded bounds`); continue; }
    for (const key of new Set([...Object.keys(bounds), ...Object.keys(counters)])) {
      const was = bounds[key], now = counters[key];
      if (was === undefined || now === undefined) problems.push(`${name} ${key}: ${was === undefined ? 'not recorded' : 'no longer counted'}`);
      else if (key === 'sourceChars' && now !== was) problems.push(`${name} sourceChars: ${now} (was ${was}) — the fixture changed`);
      else if (now > was) problems.push(`${name} ${key}: ${now} (bound ${was}, +${now - was} REGRESSION)`);
      else if (now < was) problems.push(`${name} ${key}: ${now} (bound ${was}, -${was - now} improvement; lower the bound)`);
    }
  }
  expect(problems, `${problems.join('\n')}\n\nA deliberate change is promoted with: npm run test:update-perf-counters`).toEqual([]);
});
