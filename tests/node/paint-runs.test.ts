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
import { layout, drawLayout, setDOMParser } from '../../src/index.ts';
import { getNodePaintBounds } from '../../src/render.ts';
import { LINE_TOP, type PrivateText } from '../../src/layout/session.ts';
import { fillTexts, recordingCtx } from '../helpers/recording-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';
import { serializeResult } from '../helpers/serialize-result.ts';

afterAll(() => setDOMParser(null));

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
  it.each(['', 'text-shadow:1px 1px 2px red'])('batched paint leaves the result and its bounds as laid out (%s)', (shadow) => {
    setDOMParser(new LinkedomDOMParser());
    const rec = recordingCtx(180, 400);
    const result = layout({
      html: `<p style="margin:0;font-size:20px;${shadow}">Hello brave world<!----> and more words</p>`,
      width: 180, ctx: rec.ctx,
    });
    const before = serializeResult(result);
    drawLayout({ layout: result, width: 180, ctx: rec.ctx, createCanvas: rec.createCanvas });
    expect(getNodePaintBounds(rec.ctx, result.layoutRoot)).toEqual(result.paintBounds);
    expect(serializeResult(result)).toBe(before);
    expect(collectTexts(result.layoutRoot).map(node => node.text)).toEqual([
      'Hello', ' ', 'brave', 'world', ' ', 'and', ' ', 'more', 'words',
    ]);
  });

  it('still paints one text node as one batched fillText', () => {
    expect(paint(`${P}Hello brave world</p>`).fills.map(([t]) => t)).toEqual(['Hello brave world']);
  });

  it('keeps the line snap and shadow insertion point of each batched fragment', () => {
    setDOMParser(new LinkedomDOMParser());
    const html = '<div style="font-size:19px;line-height:1.375;padding-top:.25px;text-shadow:3px 4px 2px red">' +
      '<p style="margin:0"><span style="vertical-align:-2.7px">Hello brave<!---->Tail words</span></p>' +
      '<p style="margin:0;background:yellow">Later shadow</p></div>';
    const rec = recordingCtx(400, 200);
    const result = layout({ html, width: 400, ctx: rec.ctx });
    const texts = collectTexts(result.layoutRoot);
    const heads = ['Hello', 'Tail', 'Later'].map(text => texts.find(run => run.text === text)!);
    const expected = ['Hello brave', 'Tail words', 'Later shadow'].map((text, i) => {
      const head = heads[i] as PrivateText;
      const top = head[LINE_TOP]!;
      expect(top % 1).not.toBe(0);
      return { text, x: head.x, y: head.y + Math.round(top) - top };
    });
    // Rounding each baseline would lose the line's fractional internal offset.
    expect(expected.some((call, i) => call.y !== Math.round(heads[i].y))).toBe(true);
    drawLayout({ layout: result, width: 400, ctx: rec.ctx, createCanvas: rec.createCanvas });
    expect(fillTexts(rec.paints)).toEqual(expected.map(({ text, x, y }) => [text, x, y]));
    expect(rec.paints.map(op => op.slice(0, op.indexOf('('))))
      .toEqual(['drawImage', 'fillText', 'fillText', 'fillRect', 'drawImage', 'fillText']);
    const masks = rec.paints.filter(op => op.startsWith('drawImage('));
    expected.forEach(({ text, x, y }, i) =>
      expect(masks[i < 2 ? 0 : 1]).toContain(`fillText(${JSON.stringify(text)},${x},${y})`));
  });

  // The batch is per fragment: a run the gate rejects, a sibling box or a
  // text-shadow leaves the other runs of the box batched.
  it.each([
    ['an underlined word', 'Hello brave <u>new</u> world', ['Hello brave ', 'new', ' world']],
    ['an inline background box', 'Hello <span style="background:yellow">brave</span> world', ['Hello ', 'brave', ' world']],
    ['a nested block', '<div>Hello brave</div><div>new world</div>', ['Hello brave', 'new world']],
    ['a text-shadow', '<span style="text-shadow:1px 1px 2px red">Hello brave</span> world', ['Hello brave', ' world']],
  ])('batches the plain runs of a box beside %s', (_label, html, expected) => {
    expect(paint(`${P}${html}</p>`).fills.map(([t]) => t)).toEqual(expected);
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
