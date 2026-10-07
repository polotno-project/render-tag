/**
 * Reentrancy — a Tier-0 gate, Node only.
 *
 * `layout()` runs caller code in the middle of a call: the `debug` callback,
 * and the caller's own ctx (`measureText` on a PDF proxy, a test mock, an
 * instrumented canvas). Either may call `layout()` again. Each call owns its
 * state in a `LayoutSession` (layout.ts), so a nested call must not touch the
 * outer one: both results — tree, lines, paintBounds, debug stream, and the
 * paint drawn from them — equal what the two calls give run one after the
 * other.
 *
 * The nested call runs on the SAME ctx (it rewrites the measuring state the
 * outer call's measurer believes the ctx holds) and on a separate one. Hooks
 * fire at several points of the outer call: during style resolution (the
 * `ch` unit is measured there), tokenizing, flex intrinsic sizing and line
 * flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import type { LayoutResult, DebugEntry } from '../../src/types.ts';
import { recordingCtx, type RecordingCtx } from '../helpers/recording-ctx.ts';
import { serializeResult } from '../helpers/serialize-result.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

// Exercises every piece of per-call state: lines (inline content AND list
// markers), the min/max-content caches and anonymous flex items (a nested
// flex row with bare text), DOM-free line heights, tab stops, ellipsis, and a
// `ch` length the resolver measures.
const OUTER = `
  <style>.row{display:flex;gap:6px}.grow{flex-grow:1}</style>
  <p style="padding-left:2ch;letter-spacing:1px">Outer <b>paragraph</b> with <i>several</i> words to wrap across lines.</p>
  <div class="row">bare text item<div class="grow">grow <span style="word-spacing:3px">one two</span></div>
    <div class="row grow"><div class="grow">nested leaf alpha</div><div>beta gamma</div></div></div>
  <ol style="font-size:20px"><li>First item</li><li>Second <u>item</u></li></ol>
  <pre style="tab-size:4">a\tb\tc</pre>
  <p style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:120px">An ellipsis line that is long</p>`;
const INNER = `<h2 style="font-size:30px;font-kerning:none">Inner heading</h2>
  <ul><li>inner list</li></ul><p style="letter-spacing:2px">inner words wrap here too</p>`;
const WIDTH = 260;
const INNER_WIDTH = 180;

interface Outcome { layout: string; debug: string; paint: string[] }

/** Every index from 1 to n: a nested call at each point of the outer one. */
const everyIndex = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function outcome(result: LayoutResult, debug: DebugEntry[], width: number): Outcome {
  const rec = recordingCtx(width, 2000);
  drawLayout({ layout: result, width, ctx: rec.ctx, createCanvas: rec.createCanvas });
  return { layout: serializeResult(result), debug: serializeResult(debug), paint: rec.paints };
}

function sequential(html: string, width: number): Outcome & { measures: number } {
  const debug: DebugEntry[] = [];
  const rec = recordingCtx(width, 2000);
  const result = layout({ html, width, ctx: rec.ctx, debug: (e) => debug.push(e) });
  const measures = rec.counts.calls.measureText ?? 0;
  return { ...outcome(result, debug, width), measures };
}

/** `rec.ctx` with a hook that runs after the `fireAt`-th measureText answered. */
function hookedCtx(rec: RecordingCtx, fireAt: number, nested: () => void): CanvasRenderingContext2D {
  let calls = 0;
  return new Proxy(rec.ctx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'measureText') return value;
      return (text: string) => {
        // Answer first: the nested call is about to change this ctx's font.
        const metrics = (value as (t: string) => TextMetrics)(text);
        if (++calls === fireAt) nested();
        return metrics;
      };
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  });
}

describe('layout() is reentrant', () => {
  let expectedOuter: Outcome;
  let expectedInner: Outcome;
  let outerMeasures = 0;
  let outerDebugEntries = 0;
  beforeAll(() => {
    const { measures, ...outer } = sequential(OUTER, WIDTH);
    expectedOuter = outer;
    outerMeasures = measures;
    outerDebugEntries = JSON.parse(outer.debug).length;
    const { measures: _, ...inner } = sequential(INNER, INNER_WIDTH);
    expectedInner = inner;
  });

  for (const where of ['same ctx', 'other ctx'] as const) {
    it(`from the debug callback (${where})`, () => {
      expect(outerDebugEntries).toBeGreaterThan(20);
      for (const fireAt of everyIndex(outerDebugEntries)) {
        const rec = recordingCtx(WIDTH, 2000);
        const debug: DebugEntry[] = [];
        let inner: Outcome | undefined;
        const result = layout({
          html: OUTER, width: WIDTH, ctx: rec.ctx,
          debug: (e) => {
            debug.push(e);
            if (debug.length !== fireAt) return;
            const innerDebug: DebugEntry[] = [];
            const ctx = where === 'same ctx' ? rec.ctx : recordingCtx(INNER_WIDTH, 2000).ctx;
            const r = layout({ html: INNER, width: INNER_WIDTH, ctx, debug: (d) => innerDebug.push(d) });
            inner = outcome(r, innerDebug, INNER_WIDTH);
          },
        });
        expect(inner, `inner layout at debug entry ${fireAt}`).toEqual(expectedInner);
        expect(outcome(result, debug, WIDTH), `outer layout, nested at debug entry ${fireAt}`).toEqual(expectedOuter);
      }
    });

    it(`from inside the ctx's measureText (${where})`, () => {
      // The first lands in style resolution (the `ch` unit), the rest in layout.
      expect(outerMeasures).toBeGreaterThan(20);
      for (const fireAt of everyIndex(outerMeasures)) {
        const rec = recordingCtx(WIDTH, 2000);
        const debug: DebugEntry[] = [];
        let inner: Outcome | undefined;
        const ctx = hookedCtx(rec, fireAt, () => {
          const innerDebug: DebugEntry[] = [];
          const innerCtx = where === 'same ctx' ? rec.ctx : recordingCtx(INNER_WIDTH, 2000).ctx;
          const r = layout({ html: INNER, width: INNER_WIDTH, ctx: innerCtx, debug: (d) => innerDebug.push(d) });
          inner = outcome(r, innerDebug, INNER_WIDTH);
        });
        const result = layout({ html: OUTER, width: WIDTH, ctx, debug: (e) => debug.push(e) });
        expect(inner, `inner layout at measureText ${fireAt}`).toEqual(expectedInner);
        expect(outcome(result, debug, WIDTH), `outer layout, nested at measureText ${fireAt}`).toEqual(expectedOuter);
      }
    });
  }

  it('nests two deep', () => {
    const rec = recordingCtx(WIDTH, 2000);
    let middle: Outcome | undefined;
    let innermost: Outcome | undefined;
    const debug: DebugEntry[] = [];
    const result = layout({
      html: OUTER, width: WIDTH, ctx: rec.ctx,
      debug: (e) => {
        debug.push(e);
        if (debug.length !== 3) return;
        const middleDebug: DebugEntry[] = [];
        const r = layout({
          html: INNER, width: INNER_WIDTH, ctx: rec.ctx,
          debug: (d) => {
            middleDebug.push(d);
            if (middleDebug.length !== 2) return;
            const deepDebug: DebugEntry[] = [];
            const deep = layout({ html: OUTER, width: WIDTH, ctx: rec.ctx, debug: (x) => deepDebug.push(x) });
            innermost = outcome(deep, deepDebug, WIDTH);
          },
        });
        middle = outcome(r, middleDebug, INNER_WIDTH);
      },
    });
    expect(innermost).toEqual(expectedOuter);
    expect(middle).toEqual(expectedInner);
    expect(outcome(result, debug, WIDTH)).toEqual(expectedOuter);
  });
});

// ─── After the call: paintBounds, paint, text-on-path ───────────────────
//
// A result is measured again after `layout()` returns — `paintBounds` on
// first read, `drawLayout` on every draw — and the caller's ctx may run a
// nested `layout()` from inside those measurements too. Paint's state
// tracker (`PaintState`) must notice that write like a measurer does.

const PAINT_HTML = `
  <p style="letter-spacing:1px;text-decoration:line-through overline;text-shadow:2px 2px 1px red">Struck <b style="font-size:22px">bold</b> words</p>
  <p style="word-spacing:4px;font-kerning:none"><i>Italic</i> and <s>struck</s> text again</p>`;
const PATH_HTML = '<span style="font-size:24px;letter-spacing:2px;text-decoration:underline">Curved <b>path</b> text</span>';
const PATH_D = 'M0,120 Q300,0 600,120';
// Nested from inside a measurement: a big font, so a measure left under it shows.
const NESTED = '<p style="font-size:60px;letter-spacing:9px;font-kerning:none">Big nested words</p>';

/** `ctx` with a hook at its `fireAt`-th measureText after `arm()` (0 = never). */
function armedCtx(ctx: CanvasRenderingContext2D, nested: () => void) {
  let calls = 0;
  let fireAt = 0;
  const proxy = new Proxy(ctx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'measureText') return typeof value === 'function' ? value.bind(target) : value;
      return (text: string) => {
        const metrics = (value as (t: string) => TextMetrics).call(target, text);
        if (fireAt && ++calls === fireAt) nested();
        return metrics;
      };
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  });
  return { ctx: proxy, arm: (at: number) => { calls = 0; fireAt = at; }, count: () => calls };
}

describe('measurements after layout() are reentrant', () => {
  const innerOutcome = () => {
    const ctx = recordingCtx(INNER_WIDTH, 2000).ctx;
    return serializeResult(layout({ html: NESTED, width: INNER_WIDTH, ctx }).lines);
  };

  it('paintBounds, nested at every measureText of its first read (same ctx)', () => {
    const expected = layout({ html: PAINT_HTML, width: WIDTH, ctx: recordingCtx(WIDTH, 2000).ctx }).paintBounds;
    const probe = armedCtx(recordingCtx(WIDTH, 2000).ctx, () => {});
    const counted = layout({ html: PAINT_HTML, width: WIDTH, ctx: probe.ctx });
    probe.arm(Number.MAX_SAFE_INTEGER);
    void counted.paintBounds;
    const reads = probe.count();
    expect(reads).toBeGreaterThan(3);
    for (const fireAt of everyIndex(reads)) {
      const rec = recordingCtx(WIDTH, 2000);
      let inner: string | undefined;
      const armed = armedCtx(rec.ctx, () => {
        inner = serializeResult(layout({ html: NESTED, width: INNER_WIDTH, ctx: rec.ctx }).lines);
      });
      const result = layout({ html: PAINT_HTML, width: WIDTH, ctx: armed.ctx });
      armed.arm(fireAt);
      expect(result.paintBounds, `paintBounds, nested at measureText ${fireAt}`).toEqual(expected);
      expect(inner).toEqual(innerOutcome());
    }
  });

  it('drawLayout, nested at every measureText of the draw (same ctx)', () => {
    const result = layout({ html: PAINT_HTML, width: WIDTH, ctx: recordingCtx(WIDTH, 2000).ctx });
    const draw = (ctx: CanvasRenderingContext2D, rec: RecordingCtx) =>
      drawLayout({ layout: result, width: WIDTH, ctx, createCanvas: rec.createCanvas });
    const clean = recordingCtx(WIDTH, 2000);
    draw(clean.ctx, clean);
    const probe = armedCtx(recordingCtx(WIDTH, 2000).ctx, () => {});
    probe.arm(Number.MAX_SAFE_INTEGER);
    draw(probe.ctx, recordingCtx(WIDTH, 2000));
    const reads = probe.count();
    expect(reads).toBeGreaterThan(0);
    for (const fireAt of everyIndex(reads)) {
      const rec = recordingCtx(WIDTH, 2000);
      const armed = armedCtx(rec.ctx, () => { layout({ html: NESTED, width: INNER_WIDTH, ctx: rec.ctx }); });
      armed.arm(fireAt);
      draw(armed.ctx, rec);
      expect(rec.paints, `paint, nested at measureText ${fireAt}`).toEqual(clean.paints);
    }
  });

  it('text-on-path layout and paintBounds, nested at every measureText (same ctx)', async () => {
    const path = await import('../../src/path/index.node.ts');
    const run = (ctx: CanvasRenderingContext2D) => path.layoutTextOnPath({ html: PATH_HTML, path: PATH_D, ctx });
    const expectedLayout = run(recordingCtx(600, 200).ctx);
    const expected = { layout: serializeResult(expectedLayout), bounds: expectedLayout.paintBounds };
    const probe = armedCtx(recordingCtx(600, 200).ctx, () => {});
    probe.arm(Number.MAX_SAFE_INTEGER);
    void run(probe.ctx).paintBounds;
    const reads = probe.count();
    expect(reads).toBeGreaterThan(3);
    for (const fireAt of everyIndex(reads)) {
      const rec = recordingCtx(600, 200);
      const armed = armedCtx(rec.ctx, () => { layout({ html: NESTED, width: INNER_WIDTH, ctx: rec.ctx }); });
      armed.arm(fireAt);
      const r = run(armed.ctx);
      const actual = { layout: serializeResult(r), bounds: r.paintBounds };
      expect(actual, `path, nested at measureText ${fireAt}`).toEqual(expected);
    }
  });
});

describe('a result is self-contained', () => {
  /** `ctx` whose font ascent/descent read 1.5x larger: a vector proxy beside a screen canvas. */
  const tallMetrics = (ctx: CanvasRenderingContext2D) => new Proxy(ctx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'measureText') return typeof value === 'function' ? value.bind(target) : value;
      return (text: string) => {
        const m = (value as (t: string) => TextMetrics).call(target, text);
        return { ...m, fontBoundingBoxAscent: m.fontBoundingBoxAscent * 1.5, fontBoundingBoxDescent: m.fontBoundingBoxDescent * 1.5 };
      };
    },
    set(target, key, value) { return Reflect.set(target, key, value); },
  });

  it('paints the same after another layout on a ctx with other font metrics', () => {
    const paint = (result: LayoutResult) => {
      const rec = recordingCtx(WIDTH, 2000);
      drawLayout({ layout: result, width: WIDTH, ctx: rec.ctx, createCanvas: rec.createCanvas });
      return rec.paints;
    };
    const a = layout({ html: PAINT_HTML, width: WIDTH, ctx: recordingCtx(WIDTH, 2000).ctx });
    const before = paint(a);
    layout({ html: PAINT_HTML, width: WIDTH, ctx: tallMetrics(recordingCtx(WIDTH, 2000).ctx) });
    expect(paint(a)).toEqual(before);
  });

  it('text-on-path paints the same after another layout on a ctx with other font metrics', async () => {
    const path = await import('../../src/path/index.node.ts');
    const paint = (result: ReturnType<typeof path.layoutTextOnPath>) => {
      const rec = recordingCtx(600, 200);
      path.drawTextOnPathLayout({ layout: result, ctx: rec.ctx, createCanvas: rec.createCanvas });
      return rec.paints;
    };
    const a = path.layoutTextOnPath({ html: PATH_HTML, path: PATH_D, ctx: recordingCtx(600, 200).ctx });
    const before = paint(a);
    layout({ html: PATH_HTML, width: WIDTH, ctx: tallMetrics(recordingCtx(WIDTH, 2000).ctx) });
    path.layoutTextOnPath({ html: PATH_HTML, path: PATH_D, ctx: tallMetrics(recordingCtx(600, 200).ctx) });
    expect(paint(a)).toEqual(before);
  });
});
