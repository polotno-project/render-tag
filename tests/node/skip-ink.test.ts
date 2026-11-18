/**
 * `text-decoration-skip-ink: auto`, the default: a band is stroked in pieces around the glyphs
 * that cross its rows (src/skip-ink.ts). The scratch canvas here is a
 * fake whose only ink is 4px of every `g`, from 2px to 6px after its origin, at any row:
 * the real gaps against Chrome are tests/skip-ink-parity.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.ts';
import { recordingCtx, stateWidth } from '../helpers/recording-ctx.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const INK = [2, 6];

/** A scratch canvas that reports `INK` under the last `g` painted. */
function inkCanvas(reads: { count: number }) {
  return (width: number, height: number) => {
    let scale = 1, shift = 0, inked: number | null = null;
    const ctx: Record<string, unknown> = {
      font: '10px sans-serif', letterSpacing: '0px', wordSpacing: '0px',
      measureText(text: string) {
        const w = stateWidth(ctx, text);
        // Only these reach below the baseline.
        const descent = /[g_/\\日本\u{1F308}]/u.test(text) ? 4 : 0;
        return { width: w, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: descent, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w };
      },
      setTransform(a: number, _b: number, _c: number, _d: number, e: number) { scale = a; shift = e; },
      clearRect() { inked = null; },
      fillText(text: string, x: number) { if (text === 'g' || text === '\u{1F308}') inked = x; },
      getImageData(_x: number, _y: number, w: number, h: number) {
        reads.count++;
        const data = new Uint8ClampedArray(w * h * 4);
        if (inked !== null) {
          for (let column = 0; column < w; column++) {
            const at = (column + 0.5 - shift) / scale - inked;
            if (at > INK[0] && at < INK[1]) for (let row = 0; row < h; row++) data[(row * w + column) * 4 + 3] = 255;
          }
        }
        return { data, width: w, height: h };
      },
      save() {}, restore() {}, setLineDash() {},
    };
    const canvas = { width, height, getContext: () => ctx };
    return canvas as unknown as HTMLCanvasElement;
  };
}

function bands(body: string) {
  const html = `<p style="margin:0;font:20px serif;line-height:40px">${body}</p>`;
  const painted = recordingCtx(600, 200);
  const reads = { count: 0 };
  const result = layout({ html, width: 600, ctx: painted.ctx });
  drawLayout({ layout: result, width: 600, ctx: painted.ctx, createCanvas: inkCanvas(reads) });
  // A band's kept pieces: the subpaths of its stroke (a dashed band: a stroke each).
  const strokes = painted.paints.filter((p) => p.startsWith('stroke(')).flatMap((p) =>
    [...p.matchAll(/moveTo\(([-\d.e]+),[-\d.e]+\)\S* lineTo\(([-\d.e]+),/g)].map((m) => [Number(m[1]), Number(m[2])]));
  return { strokes, reads: reads.count, paints: painted.paints, clips: painted.counts.calls.clip ?? 0 };
}

/** Where the first `g` of `text` starts in the recording canvas's metrics: kerning moves the
 * glyph before a pair's second, so its prefix's end less its own advance. */
function originOfG(text: string): number {
  const state = { font: '20px serif', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'normal', textRendering: 'optimizeLegibility' };
  return stateWidth(state, text.slice(0, text.indexOf('g') + 1)) - stateWidth(state, 'g');
}

describe('text-decoration-skip-ink', () => {
  it('strokes the band on each side of a crossing, widened by the thickness, on whole pixels', () => {
    const none = bands('<u style="text-decoration-skip-ink:none">bag bag</u>');
    // `none`: one whole band, no scratch canvas.
    expect(none.strokes).toHaveLength(1);
    expect(none.reads).toBe(0);
    const whole = none.strokes[0];
    const { strokes, clips, paints } = bands('<u>bag bag</u>');
    // 20px: a 2px band.
    const first = originOfG('bag bag');
    expect(strokes).toHaveLength(3);
    expect(strokes[0]).toEqual([whole[0], Math.round(first + INK[0] - 2)]);
    expect(strokes[1][0]).toBe(Math.round(first + INK[1] + 2));
    expect(strokes[2][1]).toBe(whole[1]);
    // One plain stroke: a vector adapter gets no clip.
    expect(clips).toBe(0);
    expect(paints.filter((p) => p.startsWith('stroke('))).toHaveLength(1);
  });

  it('reads a glyph once per draw, whichever element it is in', () => {
    expect(bands('<u>gag gig</u><br><u>gog</u>').reads).toBe(1);
  });

  it('inherits, and `auto` turns it on again', () => {
    const { strokes } = bands(
      '<span style="text-decoration-skip-ink:none"><u>bag</u> <u style="text-decoration-skip-ink:auto">bag</u></span>');
    expect(strokes).toHaveLength(3);
  });

  it('leaves a line-through whole', () => {
    expect(bands('<s>bag</s>').strokes).toHaveLength(1);
  });

  it('keeps a dashed band in phase across a gap', () => {
    const { paints } = bands('<u style="text-decoration-style:dashed">bag bag bag bag</u>');
    const offsets = paints.filter((p) => p.startsWith('stroke(')).map((p) => Number(/lineDashOffset=([-\d.e]+)/.exec(p)?.[1]));
    expect(offsets.length).toBeGreaterThan(1);
    expect(offsets[0]).toBe(0);
    expect(offsets.slice(1).every((o) => o > 0)).toBe(true);
  });

  it('never skips `_`, `/`, `\\`, CJK or emoji', () => {
    // Each reaches the band's rows in the fake, yet none is read.
    expect(bands('<u>a_b/c\\d 日本 \u{1F308}</u>').reads).toBe(0);
  });

  it('makes its scratch canvas with the destination canvas\'s class, as Node canvases allow', () => {
    const reads = { count: 0 };
    class NodeCanvas {
      private readonly ctx: unknown;
      constructor(public width: number, public height: number) { this.ctx = inkCanvas(reads)(width, height).getContext('2d'); }
      getContext() { return this.ctx; }
    }
    const painted = recordingCtx(600, 200);
    const canvas = new NodeCanvas(600, 200);
    const ctx = new Proxy(painted.ctx, { get: (target, key) => key === 'canvas' ? canvas : Reflect.get(target, key) });
    const result = layout({ html: '<u>bag</u>', width: 600, ctx });
    drawLayout({ layout: result, width: 600, ctx });
    expect(reads.count).toBe(1);
  });

  it('asks for createCanvas where no canvas can be made', () => {
    const painted = recordingCtx(600, 200);
    const result = layout({ html: '<u>bag</u>', width: 600, ctx: painted.ctx });
    expect(() => drawLayout({ layout: result, width: 600, ctx: painted.ctx, renderShadows: false }))
      .toThrow(/text-decoration-skip-ink.*createCanvas/);
  });
});
