/**
 * Determinism and cache isolation — a Tier-0 gate, Node only.
 *
 * A layout or a paint must depend on its inputs and nothing else: not on
 * which documents were laid out before it, and not on the state an earlier
 * call left on a reused ctx. `layout(A); layout(B); layout(A)` has to give the
 * second A exactly what a fresh process gives the first one.
 *
 * This is the gate that must exist BEFORE any cache outlives a call. The
 * library already keeps module-level state between calls (`_fontStringCache`,
 * `_fontMetricsCache`, the default measure ctx, path colour canonicals), and
 * a measure that ran under a stale `letterSpacing` is exactly this bug class.
 *
 * - "fresh" = a newly imported module graph (`vi.resetModules`) and a new ctx.
 * - "dirty" = ONE module graph and ONE ctx for every call, as `render()`
 *   reuses its output ctx and `layout()` its default measure ctx. The whole
 *   corpus runs forward, then in reverse, so each key follows a different
 *   predecessor each time and the middle key runs twice in a row. Each case
 *   appears at its width, at a narrower width, and with its text re-stated
 *   under other letter-spacing, word-spacing and kerning.
 * - Compared: the complete serialized `LayoutResult` (tree, styles, lines,
 *   line boxes, paintBounds, and which nodes share an object) and the
 *   effective paint stream from `recording-ctx.ts`, whose widths move with the
 *   font and letter-spacing state so a stale measure changes a break.
 *
 * Node takes the Blink engine branch only (UA `Node.js/…`); the Gecko and
 * WebKit branches are module constants and are not exercised here.
 */
import { describe, expect, it, vi } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { loadNodeCorpus, caseHtml } from '../helpers/node-corpus.ts';
import { recordingCtx, type RecordingCtx } from '../helpers/recording-ctx.ts';

type Api = typeof import('../../src/index.node.ts');
type PathApi = typeof import('../../src/path/index.node.ts');

async function freshApis(): Promise<{ api: Api; path: PathApi }> {
  vi.resetModules();
  const api = await import('../../src/index.node.ts');
  const path = await import('../../src/path/index.node.ts');
  // One dom module behind both entries, so one injection serves both.
  api.setDOMParser(new LinkedomDOMParser());
  return { api, path };
}

/**
 * Canonical JSON of an object graph. Keys are sorted; a repeated object
 * becomes `{"$ref":n}` (n = its first-visit index), which both breaks the
 * decoration-declarer cycles and pins WHICH nodes share a style or entry —
 * identity that `sameDecorationBand` and declarer stamping depend on.
 * Getters (`paintBounds`) are read like any property.
 */
function serialize(root: unknown): string {
  const seen = new Map<object, number>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value);
    if (typeof value === 'function') return '[function]';
    if (value === null || typeof value !== 'object') return value;
    const ref = seen.get(value);
    if (ref !== undefined) return { $ref: ref };
    seen.set(value, seen.size);
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Map || value instanceof Set) return { [value.constructor.name]: [...value].map(walk) };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = walk((value as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(walk(root));
}

interface Outcome { layout: string; paint: string[] }

/** layout() then drawLayout() on one ctx — what render() does. */
function runBlock(api: Api, rec: RecordingCtx, html: string, width: number): Outcome {
  const result = api.layout({ html, width, ctx: rec.ctx });
  const layout = serialize(result);
  const start = rec.paints.length;
  api.drawLayout({ layout: result, width, ctx: rec.ctx, createCanvas: rec.createCanvas });
  return { layout, paint: rec.paints.slice(start) };
}

function runPath(api: PathApi, rec: RecordingCtx, html: string, d: string): Outcome {
  const result = api.layoutTextOnPath({ html, path: d, ctx: rec.ctx });
  const layout = serialize(result);
  const start = rec.paints.length;
  api.drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
  return { layout, paint: rec.paints.slice(start) };
}

/** First difference between two outcomes, or null. Short enough to read. */
function difference(expected: Outcome, actual: Outcome): string | null {
  if (expected.layout !== actual.layout) {
    let i = 0;
    while (expected.layout[i] === actual.layout[i]) i++;
    return `layout differs at char ${i}:\n  fresh: …${expected.layout.slice(Math.max(0, i - 80), i + 80)}\n  dirty: …${actual.layout.slice(Math.max(0, i - 80), i + 80)}`;
  }
  const n = Math.max(expected.paint.length, actual.paint.length);
  for (let i = 0; i < n; i++) {
    if (expected.paint[i] !== actual.paint[i]) {
      return `paint op ${i} of ${expected.paint.length} (dirty: ${actual.paint.length}) differs:\n  fresh: ${expected.paint[i]}\n  dirty: ${actual.paint[i]}`;
    }
  }
  return null;
}

/**
 * Same fonts and text, different canvas measuring state — ONE property per
 * variant. Changed together, the letter-spacing difference alone moves any
 * key that includes it, so a cache key missing only `fontKerning` (or only
 * `wordSpacing`) would never collide with the plain run and pass unseen.
 */
const RESTATES = {
  'letter-spacing': 'letter-spacing:1.5px',
  'word-spacing': 'word-spacing:3px',
  'kerning': 'font-kerning:none',
};

// Inline content for text-on-path: the paints that propagate by painting
// rule, shadows, spacing, bidi and script fallbacks.
const PATH_D = 'M0,120 Q300,0 600,120';
const PATH_SNIPPETS = [
  '<span style="font-size:28px">Plain curved text</span>',
  '<span style="font-size:30px;background-image:linear-gradient(90deg,red,blue);-webkit-background-clip:text;color:transparent">Gra<u>dient</u> clip</span>',
  '<span style="font-size:26px;text-decoration:underline;-webkit-text-stroke:2px red;text-shadow:3px 3px 2px black">Stroke and shadow</span>',
  '<span style="font-size:24px;letter-spacing:4px">Spaced</span> <b style="font-size:32px">bold</b> <i>italic</i>',
  '<span style="font-size:24px">English مرحبا بالعالم text</span>',
  '<span style="font-size:24px">日本語のテキスト and 😀 emoji</span>',
];

describe('determinism and cache isolation', () => {
  it('layout and paint of every corpus case are independent of earlier calls and ctx state', async () => {
    const corpus = await loadNodeCorpus();
    // Each case adjacent in the sequence: its own width, a narrower one, and
    // the SAME text under each other measuring state (a cache key missing one
    // of them hands one run the other's widths).
    const keys = corpus.flatMap((c) => [
      { name: `${c.name} @${c.width}`, html: caseHtml(c), width: c.width },
      { name: `${c.name} @${Math.round(c.width * 0.6)}`, html: caseHtml(c), width: Math.round(c.width * 0.6) },
      ...Object.entries(RESTATES).map(([label, style]) => ({
        name: `${c.name} @${c.width} ${label}`,
        html: `${c.css ? `<style>${c.css}</style>` : ''}<div style="${style}">${c.html}</div>`,
        width: c.width,
      })),
    ]);

    const fresh = new Map<string, Outcome>();
    for (const key of keys) {
      const { api } = await freshApis();
      fresh.set(key.name, runBlock(api, recordingCtx(key.width, 4000), key.html, key.width));
    }

    const { api } = await freshApis();
    const shared = recordingCtx(1000, 4000);
    const failures: string[] = [];
    for (const key of [...keys, ...[...keys].reverse()]) {
      const diff = difference(fresh.get(key.name)!, runBlock(api, shared, key.html, key.width));
      if (diff && failures.length < 10) failures.push(`${key.name}: ${diff}`);
      else if (diff) failures.push(key.name);
    }
    expect(failures, `${failures.length} dirty run(s) diverged from a fresh one:\n${failures.join('\n\n')}`).toEqual([]);
  });

  it('text-on-path layout and paint are independent of earlier calls and ctx state', async () => {
    const corpus = await loadNodeCorpus();
    const fresh = PATH_SNIPPETS.map(() => null as Outcome | null);
    for (let i = 0; i < PATH_SNIPPETS.length; i++) {
      const { path } = await freshApis();
      fresh[i] = runPath(path, recordingCtx(600, 200), PATH_SNIPPETS[i], PATH_D);
    }

    // Block layouts between the path calls share the ctx and module state.
    const { api, path } = await freshApis();
    const shared = recordingCtx(1000, 4000);
    const failures: string[] = [];
    const order = [...PATH_SNIPPETS.keys(), ...[...PATH_SNIPPETS.keys()].reverse()];
    order.forEach((i, step) => {
      const noise = corpus[(step * 7) % corpus.length];
      runBlock(api, shared, caseHtml(noise), noise.width);
      const diff = difference(fresh[i]!, runPath(path, shared, PATH_SNIPPETS[i], PATH_D));
      if (diff) failures.push(`path snippet ${i} after "${noise.name}": ${diff}`);
    });
    expect(failures, failures.join('\n\n')).toEqual([]);
  });
});
