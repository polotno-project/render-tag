/**
 * Blink paint batching (`BLINK_TEXT_RUN_SHAPING`, render.ts) paints the
 * pieces of ONE measured run with one fillText, so the engine shapes across
 * their spaces. It must never merge pieces layout measured apart: their
 * painted glyphs would then drift from their layout positions by the kerning
 * across the seam.
 *
 * Text nodes of one element share that element's style object, so style
 * identity cannot stand for "same run": `Hello<!---->World` is two text nodes,
 * two runs, measured separately — and must paint as two.
 *
 * Node takes the Blink branch (UA `Node.js/…`); the recording ctx kerns, so a
 * merged string is not the sum of its pieces.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.node.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';

afterAll(() => setDOMParser(null));

/** The fillText calls of a paint, as [text, x]. */
function fillTexts(paints: string[]): [string, number][] {
  return paints
    .filter((p) => p.startsWith('fillText('))
    .map((p) => {
      const m = /^fillText\((".*?"),(-?[\d.e+-]+),/.exec(p);
      if (!m) throw new Error(`unparsed paint: ${p}`);
      return [JSON.parse(m[1]) as string, Number(m[2])];
    });
}

function paint(html: string) {
  setDOMParser(new LinkedomDOMParser());
  const rec = recordingCtx(400, 200);
  const result = layout({ html, width: 400, ctx: rec.ctx });
  const painted = recordingCtx(400, 200);
  drawLayout({ layout: result, width: 400, ctx: painted.ctx, createCanvas: painted.createCanvas });
  return { texts: collectTexts(result.layoutRoot), fills: fillTexts(painted.paints) };
}

const P = '<p style="margin:0;font-size:20px">';

describe('paint batching follows the measured run', () => {
  it('still paints one text node as one batched fillText', () => {
    expect(paint(`${P}Hello brave world</p>`).fills.map(([t]) => t)).toEqual(['Hello brave world']);
  });

  for (const [label, html] of [
    ['a comment', 'Hello<!---->World'],
    ['an empty span', 'Hello<span></span>World'],
    ['a display:none span', 'Hello<span style="display:none">x</span>World'],
    ['a script', 'Hello<script>x</script>World'],
  ]) {
    it(`does not merge text nodes split by ${label}`, () => {
      const { texts, fills } = paint(`${P}${html}</p>`);
      expect(fills.map(([t]) => t)).toEqual(['Hello', 'World']);
      // Each paint sits at its LayoutText's x.
      expect(fills.map(([, x]) => x)).toEqual(texts.map((t) => t.x));
    });
  }
});
