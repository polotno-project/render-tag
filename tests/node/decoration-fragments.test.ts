/**
 * Decorations and clip gradients are painted per TEXT FRAGMENT, not per run.
 *
 * Layout emits one LayoutText per word and per space; the engine paints a
 * decoration once across each text fragment — one text node's pieces,
 * contiguous on one line — so a dash pattern fits and a wave keeps its phase
 * across the spaces inside it, and restarts at the next text node
 * (measured in Chromium and WebKit, tests/decoration-shape-parity.test.ts).
 * A clip gradient is likewise one gradient object per fragment.
 *
 * Node takes the Blink branch (src/engine.ts DECORATION_PAINTER).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

function paint(body: string) {
  setDOMParser(new LinkedomDOMParser());
  const html = `<p style="margin:0;font-size:20px;line-height:40px">${body}</p>`;
  const result = layout({ html, width: 600, ctx: recordingCtx(600, 200).ctx });
  const painted = recordingCtx(600, 200);
  drawLayout({ layout: result, width: 600, ctx: painted.ctx, createCanvas: painted.createCanvas });
  return { paints: painted.paints, calls: painted.counts.calls };
}

const strokes = (paints: string[]) => paints.filter((p) => p.startsWith('stroke('));
const kinds = (paints: string[]) =>
  paints.map((p) => (p.startsWith('fillText') ? 'text' : p.startsWith('stroke(') ? 'band' : 'other'));

/** The x extent and dash of a straight band. */
function band(p: string) {
  const m = /moveTo\(([-\d.e]+),([-\d.e]+)\).*lineTo\(([-\d.e]+),([-\d.e]+)\)/.exec(p);
  const dash = /;dash=([^|;]*)/.exec(p)?.[1] ?? '';
  return { x0: Number(m![1]), x1: Number(m![3]), y: Number(m![2]), dash: dash ? dash.split(',').map(Number) : [] };
}

describe('one decoration band per text fragment', () => {
  it('draws one band across the words and spaces of a text node', () => {
    expect(strokes(paint('<u>Hello brave new world</u>').paints)).toHaveLength(1);
  });

  it('restarts at each text node under the same declarer', () => {
    expect(strokes(paint('<u>aa <b>bb</b> cc</u>').paints)).toHaveLength(3);
    expect(strokes(paint('<u>Hello<!---->World</u>').paints)).toHaveLength(2);
  });

  it('paints an underline and an overline under the text, a line-through over it', () => {
    expect(kinds(paint('<u>ab cd</u>').paints)).toEqual(['band', 'text', 'text', 'text']);
    expect(kinds(paint('<s>ab cd</s>').paints)).toEqual(['text', 'text', 'text', 'band']);
  });

  it('fits Blink dashes to the fragment: whole dashes at both ends', () => {
    const [p] = strokes(paint('<u style="text-decoration-style:dashed">Hello brave new world</u>').paints);
    const { x0, x1, dash } = band(p);
    // 20px: thickness 2 → dashes of 3 × 2, gaps near 2 × 2 (Blink's
    // DashLengthRatio / DashGapRatio below 3px), stretched to fit.
    expect(Number.isInteger(x0) && Number.isInteger(x1)).toBe(true);
    expect(dash[0]).toBe(6);
    const n = Math.round((x1 - x0 + dash[1]) / (dash[0] + dash[1]));
    expect(n * dash[0] + (n - 1) * dash[1]).toBeCloseTo(x1 - x0, 4);
  });

  it('draws one continuous wave from the fragment start', () => {
    const [p] = strokes(paint('<u style="text-decoration-style:wavy">Hello brave new world</u>').paints);
    expect(p).toMatch(/^stroke\(\) path=moveTo\(0,/);
    expect(p.match(/bezierCurveTo/g)!.length).toBeGreaterThan(5);
  });
});

describe('one clip gradient per fragment', () => {
  it('creates the inline declarer gradient once for all its words on a line', () => {
    const { calls } = paint(
      '<span style="background-image:linear-gradient(90deg,red,blue);-webkit-background-clip:text;color:transparent">' +
      'one two three four five</span>');
    expect(calls.createLinearGradient).toBe(1);
  });
});
