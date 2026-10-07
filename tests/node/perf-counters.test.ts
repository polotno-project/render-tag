/**
 * Work counters — a Tier-0 ratchet, Node only.
 *
 * Timings are noisy; the WORK behind them is not. With the deterministic
 * `recording-ctx.ts`, each fixture costs an exact number of measureText calls,
 * measured characters, font, kerning and letter-spacing assignments,
 * fillText/save/restore calls, LayoutText runs, styled-tree style objects,
 * the passes that segment and measure an inline formatting context's text
 * (`layout.tokenizePasses`), the segments they produce and the per-word
 * objects layout allocates (`layout.wordObjects`),
 * selector sibling steps, and the scratch canvases a text-shadow draw creates
 * through `createCanvas` (with the most pixels they held at once, counting a
 * canvas from creation until it is released at 0×0), identical on every
 * machine. Those numbers are recorded in
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
import { layoutTextOnPath } from '../../src/path/index.node.ts';
import { parseHTML } from '../../src/parse.ts';
import { resolveStylesFromCSS } from '../../src/css-resolver.ts';
import { buildLayoutTree, type LayoutStats } from '../../src/layout.ts';
import type { StyledNode } from '../../src/types.ts';
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

interface Fixture { html: string; width: number; pixelRatio?: number }

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
  // `~` and `+` against a long list: matching must stay linear in the items
  // (`resolve.siblingSteps`); a per-element walk over every earlier sibling
  // took 610 ms for ONE such rule on 4,000 items in Chromium.
  'sibling selectors (4000 items)': {
    html: `<style>.x ~ li, .y ~ li { color: red } li + li { padding-left: 1px }</style>` +
      `<ul style="font-size:14px;margin:0">${Array.from({ length: 4000 }, (_, i) => `<li${i === 3990 ? ' class="y"' : ''}>Item ${i}</li>`).join('')}</ul>`,
    width: 400,
  },
  // 50 paragraphs, two shadow values, at pixelRatio 2. Before scratch reuse
  // this cast each value into its own document-sized image off a
  // document-sized mask: 3 canvases, 102 MB of RGBA in Chromium.
  'text-shadow (50 paragraphs, 2 shadows)': {
    html: `<div style="font:16px sans-serif;line-height:1.4;text-shadow:2px 2px 4px rgba(0,0,0,.5), 0 0 8px red">` +
      Array.from({ length: 50 }, (_, i) => `<p>${i}: ${WORDS.slice(0, 30).join(' ')}</p>`).join('') + '</div>',
    width: 600,
    pixelRatio: 2,
  },
  // Flex leaves are sized twice (min- and max-content) before they are laid
  // out, and a nested row asks again for its whole subtree: every one of
  // those passes must read ONE segmentation of each leaf's text.
  'flex with nested leaves': {
    html: `<div style="display:flex;gap:8px;font-size:14px">${[0, 1].map((i) =>
      `<div style="display:flex;flex-grow:1;gap:4px">${[0, 1].map((j) =>
        `<div style="display:flex;flex-grow:1">` +
        `<div style="flex-grow:1">alpha beta gamma ${i}${j} <b>bold</b> <i>words</i> and some more</div>` +
        `<div style="flex-grow:1">delta epsilon ${j} <b>bold</b> <i>words</i></div></div>`).join('')}</div>`).join('')}</div>`,
    width: 800,
  },
  'ordered list (4000 items)': {
    html: `<ol style="font-size:14px;margin:0">${Array.from({ length: 4000 }, (_, i) => `<li>Item ${i} with a few words</li>`).join('')}</ol>`,
    width: 400,
  },
};

const PANGRAM = 'The quick brown <b>fox</b> jumps over the <i>lazy</i> dog. ';

/** Text on a path: its measuring, which repeats for every repeated grapheme. */
const PATH_FIXTURES: Record<string, Fixture> = {
  'path text (Latin, 3 pangrams)': { html: `<p style="font-size:16px">${PANGRAM.repeat(3)}</p>`, width: 2000 },
  'path text (Arabic)': { html: '<p dir="rtl" style="font-size:16px">مرحبا بالعالم، هذا نص على مسار منحني</p>', width: 2000 },
};

function countPath(fixture: Fixture): Counters {
  const rec = recordingCtx(fixture.width, 1000);
  layoutTextOnPath({ html: fixture.html, path: `M0,200 Q${fixture.width / 2},0 ${fixture.width},200`, ctx: rec.ctx });
  return {
    sourceChars: sourceChars(fixture.html),
    'layout.measureText': rec.counts.calls.measureText ?? 0,
    'layout.measuredChars': rec.counts.measuredChars,
  };
}

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

/**
 * The styled tree's size: its nodes, and the distinct style objects they hold.
 * A text node shares its parent element's style, so the objects are about
 * one per element, not one per node (each is a ~75-field object).
 */
function styledTreeCounts(fixture: Fixture): { nodes: number; styles: number; siblingSteps: number } {
  const { fragment, css } = parseHTML(fixture.html);
  const styles = new Set<object>();
  let nodes = 0;
  const walk = (n: StyledNode) => {
    nodes++;
    styles.add(n.style);
    n.children.forEach(walk);
  };
  const [tree, siblingSteps] = countSiblingSteps(fragment.ownerDocument!.createElement('p'),
    () => resolveStylesFromCSS(fragment, css, fixture.width));
  walk(tree);
  return { nodes, styles: styles.size, siblingSteps };
}

/**
 * Run `fn`, counting reads of `previousElementSibling` — the step a
 * sibling-combinator match takes — on the DOM implementation `sample` is from.
 */
function countSiblingSteps<T>(sample: Element, fn: () => T): [T, number] {
  let proto = Object.getPrototypeOf(sample);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'previousElementSibling')) proto = Object.getPrototypeOf(proto);
  const desc = Object.getOwnPropertyDescriptor(proto, 'previousElementSibling')!;
  let steps = 0;
  Object.defineProperty(proto, 'previousElementSibling', {
    ...desc,
    get() { steps++; return desc.get!.call(this); },
  });
  try {
    return [fn(), steps];
  } finally {
    Object.defineProperty(proto, 'previousElementSibling', desc);
  }
}

/**
 * Layout's own work, which no ctx call shows: `buildLayoutTree` takes a
 * `stats` sink (internal; `layout()` never passes one). Styles are resolved
 * as `layout()` resolves them for these fixtures (none uses ch/ex).
 */
function layoutStats(fixture: Fixture): LayoutStats {
  const rec = recordingCtx(fixture.width, 100000);
  const { fragment, css } = parseHTML(fixture.html);
  const tree = resolveStylesFromCSS(fragment, css, fixture.width, {
    viewport: { width: fixture.width, height: fixture.width },
  });
  const stats: LayoutStats = { tokenizePasses: 0, segments: 0, wordObjects: 0 };
  buildLayoutTree(rec.ctx, tree, fixture.width, false, undefined, stats);
  return stats;
}

function count(fixture: Fixture): Counters {
  const rec = recordingCtx(fixture.width, 100000);
  const result = layout({ html: fixture.html, width: fixture.width, ctx: rec.ctx });
  const afterLayout = { calls: { ...rec.counts.calls }, measuredChars: rec.counts.measuredChars };
  const pixelRatio = fixture.pixelRatio ?? 1;
  rec.ctx.scale(pixelRatio, pixelRatio);
  drawLayout({ layout: result, width: fixture.width, ctx: rec.ctx, createCanvas: rec.createCanvas, pixelRatio });
  const calls = rec.counts.calls;
  const drawn = (name: string) => (calls[name] ?? 0) - (afterLayout.calls[name] ?? 0);
  const tree = styledTreeCounts(fixture);
  const work = layoutStats(fixture);
  return {
    sourceChars: sourceChars(fixture.html),
    'resolve.styledNodes': tree.nodes,
    'resolve.styleObjects': tree.styles,
    'resolve.siblingSteps': tree.siblingSteps,
    layoutTexts: collectTexts(result.layoutRoot).length,
    'layout.measureText': afterLayout.calls.measureText ?? 0,
    'layout.measuredChars': afterLayout.measuredChars,
    'layout.fontSets': afterLayout.calls['set:font'] ?? 0,
    'layout.kerningSets': afterLayout.calls['set:fontKerning'] ?? 0,
    'layout.letterSpacingSets': afterLayout.calls['set:letterSpacing'] ?? 0,
    'layout.tokenizePasses': work.tokenizePasses,
    'layout.segments': work.segments,
    'layout.wordObjects': work.wordObjects,
    'draw.measureText': drawn('measureText'),
    'draw.fontSets': drawn('set:font'),
    'draw.fillText': drawn('fillText'),
    'draw.save': drawn('save'),
    'draw.restore': drawn('restore'),
    'draw.scratchCanvases': rec.scratch.created,
    'draw.scratchPeakPixels': rec.scratch.peakPixels,
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
  for (const [name, fixture] of Object.entries(PATH_FIXTURES)) current[name] = countPath(fixture);

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
