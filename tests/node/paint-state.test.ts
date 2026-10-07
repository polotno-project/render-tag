/**
 * Paint state is written explicitly, once per change — a Tier-0 gate, Node only.
 *
 * Paint used to wrap every run in `save` → font/baseline/kerning/spacing →
 * `restore`: 3,675 pairs for the large document, each one a q/Q pair on a PDF
 * proxy. `PaintState` (src/paint-state.ts) writes each property only when it
 * changes and never relies on `restore` to put a value back. So:
 *
 * - a run's paint must not depend on what an earlier run, or the caller, left
 *   on the ctx — every value an operation reads is written for it;
 * - the paint must not depend on whether the ctx's save/restore snapshots
 *   state at all (some drawing-command proxies do not, `shadow.ts`);
 * - the caller gets its ctx back as it handed it over.
 *
 * The recording ctx logs each paint op with the state it reads, so these are
 * stream comparisons, not pixel guesses.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { drawTextOnPath } from '../../src/path/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

/** Every paint-state hazard next to each other: a stroked run's join and
 * width before a border, a dotted band before a border, RTL before LTR,
 * spacing changes between runs. */
const MIXED = [
  '<p style="font-size:20px;-webkit-text-stroke:3px blue;stroke-linejoin:round">Stroked MW</p>',
  '<div style="border:6px solid black;border-radius:0 12px 0 12px;height:30px"></div>',
  '<p style="font-size:20px"><u style="text-decoration-style:dotted">dotted</u> plain <s style="text-decoration-style:dashed">dashed</s></p>',
  '<div style="border:2px solid red;border-radius:0 4px 0 0;height:10px"></div>',
  '<p dir="rtl" style="font-size:20px">abc <b>def</b></p>',
  '<p style="font-size:20px">after rtl</p>',
  '<p style="font-size:20px;letter-spacing:3px;word-spacing:5px">wide words <span style="letter-spacing:0;word-spacing:0">norm words</span></p>',
  '<p style="font-size:20px;background-image:linear-gradient(90deg,red,blue);-webkit-background-clip:text;color:transparent">grad <u style="text-decoration-color:transparent">band</u></p>',
  '<p style="font-size:20px">plain <span style="color:red">red</span> tail</p>',
].join('');

function draw(html: string, ctx: CanvasRenderingContext2D, rec: ReturnType<typeof recordingCtx>, shadows = true) {
  const result = layout({ html, width: 400, ctx: rec.ctx });
  drawLayout({ layout: result, width: 400, ctx, createCanvas: rec.createCanvas, renderShadows: shadows });
}

/** The recording ctx with save/restore that snapshot nothing. */
function noSnapshot(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'save' || key === 'restore') return () => {};
      return Reflect.get(target, key);
    },
    set(target, key, value) { return Reflect.set(target, key, value); },
  });
}

describe('paint state', () => {
  it('does not depend on the caller\'s text alignment, direction or spacing', () => {
    setDOMParser(new LinkedomDOMParser());
    const fresh = recordingCtx(400, 800);
    draw(MIXED, fresh.ctx, fresh);
    const dirty = recordingCtx(400, 800);
    Object.assign(dirty.ctx, {
      textAlign: 'center', direction: 'rtl', textBaseline: 'top',
      letterSpacing: '7px', wordSpacing: '9px', lineJoin: 'bevel', fontKerning: 'none',
    });
    draw(MIXED, dirty.ctx, dirty);
    // Layout re-measures on `dirty`, so compare only the paint streams.
    expect(dirty.paints).toEqual(fresh.paints);
  });

  it('does not depend on save/restore snapshotting state', () => {
    setDOMParser(new LinkedomDOMParser());
    const real = recordingCtx(400, 800);
    draw(MIXED, real.ctx, real, false);
    const flat = recordingCtx(400, 800);
    draw(MIXED, noSnapshot(flat.ctx), flat, false);
    expect(flat.paints).toEqual(real.paints);
  });

  it('writes a style\'s text state once, not once per run', () => {
    setDOMParser(new LinkedomDOMParser());
    // justify keeps Blink from batching the runs into one fillText.
    const words = Array.from({ length: 40 }, (_, i) => (i % 10 === 9 ? `<b>w${i}</b>` : `w${i}`)).join(' ');
    const html = `<p style="font-size:16px;text-align:justify;margin:0">${words}</p>`;
    const rec = recordingCtx(400, 800);
    const result = layout({ html, width: 400, ctx: rec.ctx });
    const before = { ...rec.counts.calls };
    drawLayout({ layout: result, width: 400, ctx: rec.ctx });
    const drawn = (k: string) => (rec.counts.calls[k] ?? 0) - (before[k] ?? 0);
    const runs = drawn('fillText');
    expect(runs).toBeGreaterThan(70);
    // The regular font, then 4 bold words (w9 … w39, the last one ends the
    // paragraph): 4 switches in, 3 back out.
    expect(drawn('set:font')).toBe(8);
    expect(drawn('set:fillStyle')).toBe(1);
    // One pair around the whole draw, none per run.
    expect(drawn('save')).toBe(1);
    expect(drawn('restore')).toBe(1);
  });

  it('hands the caller its ctx state back', () => {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(400, 800);
    const result = layout({ html: MIXED, width: 400, ctx: rec.ctx });
    const caller = {
      font: '13px serif', fillStyle: '#123456', strokeStyle: '#654321', lineWidth: 7,
      textAlign: 'center', direction: 'rtl', letterSpacing: '2px', lineJoin: 'bevel',
    };
    Object.assign(rec.ctx, caller);
    drawLayout({ layout: result, width: 400, ctx: rec.ctx, createCanvas: rec.createCanvas });
    for (const [key, value] of Object.entries(caller)) expect([key, (rec.ctx as any)[key]]).toEqual([key, value]);
    expect(rec.ctx.getLineDash()).toEqual([]);
  });

  it('text on a path does not depend on save/restore snapshotting state', () => {
    setDOMParser(new LinkedomDOMParser());
    const html = '<span style="font-size:24px;-webkit-text-stroke:2px red;stroke-linejoin:round;text-decoration:underline dotted">Stroke <b style="letter-spacing:3px">wide</b> <span style="text-decoration:overline double;background:yellow">dbl</span></span>';
    const run = (wrap: (c: CanvasRenderingContext2D) => CanvasRenderingContext2D) => {
      const rec = recordingCtx(700, 300);
      // Per-glyph transforms still need a real save/restore; only the state
      // must not lean on it, so snapshot the matrix but not the state.
      drawTextOnPath({ html, path: 'M0,150 Q350,0 700,150', ctx: wrap(rec.ctx), renderShadows: false });
      return rec.paints;
    };
    expect(run(matrixOnlySnapshot)).toEqual(run((c) => c));
  });
});

/** save/restore that keep the transform but not the drawing state. */
function matrixOnlySnapshot(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  const stack: DOMMatrix2DInit[] = [];
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'save') return () => { stack.push(target.getTransform()); };
      if (key === 'restore') return () => { const m = stack.pop(); if (m) target.setTransform(m as DOMMatrix); };
      return Reflect.get(target, key);
    },
    set(target, key, value) { return Reflect.set(target, key, value); },
  });
}

describe('shadow masks', () => {
  // A dotted band leaves a round cap and a dash on the destination until its
  // tracker's next stroke. A shadow cast in between copies that state onto
  // its mask (`prepareLayer`), whose own tracker assumes solid and butt — so
  // the mask's SOLID underline and text stroke came out dotted.
  it('a dotted band before a shadow does not dash the shadow\'s solid strokes', () => {
    setDOMParser(new LinkedomDOMParser());
    const html = '<p style="font-size:40px;text-decoration:underline dotted;text-decoration-thickness:6px">aaaa</p>' +
      '<div style="background:yellow"><p style="font-size:40px;text-shadow:3px 3px 0 black;' +
      'text-decoration:underline;-webkit-text-stroke:2px red">bbbb</p></div>';
    for (const callerShadow of [false, true]) {
      const rec = recordingCtx(400, 800);
      const result = layout({ html, width: 400, ctx: rec.ctx });
      if (callerShadow) Object.assign(rec.ctx, { shadowColor: 'blue', shadowOffsetX: 2, shadowBlur: 1 });
      drawLayout({ layout: result, width: 400, ctx: rec.ctx, createCanvas: rec.createCanvas });
      // Every op in the stream, the scratch canvases' included.
      const ops = rec.paints.join('\n').split(/ \/ |\{|\n/);
      // The second paragraph's strokes: its text stroke and its solid
      // underline (the first paragraph's dotted band is the 6px one).
      const solid = ops.filter(op => op.startsWith('strokeText("bbbb"') ||
        (op.startsWith('stroke()') && !op.includes('lineWidth=6;')));
      // The foreground's two strokes plus the mask's underline (Blink's mask
      // has no text stroke: `STROKE_CASTS_TEXT_SHADOW`); the caller's shadow
      // repaints both on its source layer.
      expect(solid.length).toBeGreaterThan(callerShadow ? 4 : 2);
      for (const op of solid) {
        expect({ callerShadow, op: op.slice(0, 40), cap: /lineCap="(\w+)"/.exec(op)?.[1], dash: /;dash=([^;|}]*)/.exec(op)?.[1] })
          .toEqual({ callerShadow, op: op.slice(0, 40), cap: 'butt', dash: '' });
      }
    }
  });
});
