/**
 * Visually adjacent RTL pieces of one level merge into one fillText so Arabic
 * shapes across span boundaries (`sameBidiRun`, layout.ts). The merged run
 * paints with its FIRST piece's style, so pieces whose glyph paint differs in
 * any property must stay apart — each with its own paint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const A = 'שלום';
const B = 'עולם';
const STROKE = '-webkit-text-stroke:2px black';

/** Text paint ops of `<p dir=rtl><span a>A</span><span b>B</span></p>`, as `op "text" | state`. */
function textPaints(a: string, b: string): string[] {
  const html = `<p dir="rtl" style="margin:0;font:20px serif"><span style="${a}">${A}</span><span style="${b}">${B}</span></p>`;
  const rec = recordingCtx(400, 100);
  const result = layout({ html, width: 400, ctx: rec.ctx });
  drawLayout({ layout: result, width: 400, ctx: rec.ctx });
  return rec.paints.filter((p) => p.startsWith('fillText(') || p.startsWith('strokeText('));
}

/** [span A style, span B style, canvas state A's paint shows, B's]. */
const CASES: Record<string, [string, string, string, string]> = {
  '-webkit-text-fill-color': ['-webkit-text-fill-color:red', '-webkit-text-fill-color:blue', 'fillStyle="red"', 'fillStyle="blue"'],
  'stroke-linejoin': [`${STROKE};stroke-linejoin:round`, `${STROKE};stroke-linejoin:bevel`, 'lineJoin="round"', 'lineJoin="bevel"'],
  'font-variant-caps': ['font-variant-caps:small-caps', 'font-variant-caps:normal', 'font="small-caps 20px serif"', 'font="20px serif"'],
  'font-kerning': ['font-kerning:none', 'font-kerning:normal', 'fontKerning="none"', 'fontKerning="normal"'],
};

describe('bidi pieces that differ in glyph paint stay separate', () => {
  for (const [name, [a, b, showA, showB]] of Object.entries(CASES)) {
    it(name, () => {
      const paints = textPaints(a, b);
      const log = paints.join('\n');
      expect(paints.some((p) => p.includes(`"${A}"`) && p.includes(showA)), log).toBe(true);
      expect(paints.some((p) => p.includes(`"${B}"`) && p.includes(showB)), log).toBe(true);
    });
  }

  it('paint-order: each piece strokes and fills in its own order', () => {
    const paints = textPaints(`${STROKE};paint-order:stroke`, `${STROKE};paint-order:normal`);
    const ops = (text: string) => paints.filter((p) => p.includes(`"${text}"`)).map((p) => p.slice(0, p.indexOf('(')));
    expect(ops(A), paints.join('\n')).toEqual(['strokeText', 'fillText']);
    expect(ops(B), paints.join('\n')).toEqual(['fillText', 'strokeText']);
  });

  it('pieces with equal paint still merge into one fillText', () => {
    const paints = textPaints('-webkit-text-fill-color:red', '-webkit-text-fill-color:red');
    expect(paints.filter((p) => p.startsWith('fillText(')).length, paints.join('\n')).toBe(1);
    expect(paints.some((p) => p.includes(A + B) || p.includes(B + A)), paints.join('\n')).toBe(true);
  });
});
