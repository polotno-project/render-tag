/**
 * A canvas that does not apply `letterSpacing` or `wordSpacing` (Safari before 18.4, Chrome
 * before 99, Firefox before 115, node-canvas, which accepts both and ignores them; a PDF
 * proxy without word-spacing): render-tag adds them itself, the way Chrome's canvas spaces,
 * in layout, in paint and on a path. The recording ctx's `letterSpacing: false` /
 * `wordSpacing: false` are such canvases; real-engine pixels are gated in
 * tests/canvas-spacing-parity.test.ts.
 *
 * Node takes the Blink branch: a plain or mixed-direction line paints as one fillText.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { drawLayout, layout, setDOMParser, type TextUnitLevel, type TextUnitPaint } from '../../src/index.ts';
import { layoutTextOnPath } from '../../src/path/index.ts';
import { fillTexts, recordingCtx, stateWidth, type CanvasSpacing as Spacing } from '../helpers/recording-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const NATIVE: Spacing = {};
const NONE: Spacing = { letterSpacing: false, wordSpacing: false };

const P = (style: string, body: string, dir = '') =>
  `<p ${dir} style="margin:0;font:20px serif;${style}">${body}</p>`;

/** Width under the paint state the recording ctx sees, with what it applies of `letterSpacing`. */
const w = (text: string, letterSpacing = 0) =>
  stateWidth({ font: '20px serif', letterSpacing: `${letterSpacing}px`, wordSpacing: '0px', fontKerning: 'normal' }, text);

function laidOut(html: string, spacing: Spacing, width = 400, textUnits?: TextUnitLevel) {
  const result = layout({ html, width, ctx: recordingCtx(width, 400, spacing).ctx, textUnits });
  return {
    lines: result.lines.length,
    runs: collectTexts(result.layoutRoot).map(t => [t.text, +t.x.toFixed(6), +t.width.toFixed(6)]),
    result,
  };
}

/** A draw's recorded fillTexts, each with the state it read. */
function fills(html: string, spacing: Spacing, textUnits?: TextUnitLevel) {
  const { result } = laidOut(html, spacing, 400, textUnits);
  const rec = recordingCtx(400, 400, spacing);
  drawLayout({
    layout: result, width: 400, ctx: rec.ctx, createCanvas: rec.createCanvas, pixelRatio: 1,
    paintTextUnit: textUnits && (({ draw }) => draw()),
  });
  return rec.paints.filter(p => p.startsWith('fillText('));
}

/** The fillTexts of a draw as [text, x]; `leftEdges`: x as the glyphs' left edge, whatever the alignment. */
function painted(html: string, spacing: Spacing, textUnits?: TextUnitLevel, leftEdges = false) {
  const paints = fills(html, spacing, textUnits);
  return fillTexts(paints).map(([text, x], i) => [
    text, +(leftEdges && paints[i].includes('textAlign="right"') ? x - w(text) : x).toFixed(6),
  ] as [string, number]);
}

describe('layout on a ctx without letterSpacing', () => {
  it.each([
    ['plain', P('letter-spacing:5px', 'Hello brave world')],
    ['wrapping', P('letter-spacing:4px', 'one two three four five six seven eight')],
    ['negative', P('letter-spacing:-1.5px', 'tight words here')],
    ['rtl', P('letter-spacing:5px', 'שלום עולם יפה', 'dir="rtl"')],
    ['with word-spacing', P('letter-spacing:3px;word-spacing:9px', 'ab&nbsp;cd ef gh')],
  ])('measures what a spacing ctx measures (%s)', (_, html) => {
    const native = laidOut(html, NATIVE, 150), fallback = laidOut(html, NONE, 150);
    expect(fallback.runs).toEqual(native.runs);
    expect(fallback.lines).toBe(native.lines);
  });

  it.each([
    ['one per grapheme', 'été', 3],
    ['none after a default-ignorable', 'a​b­c', 3],
    ['none in a cursive script', 'مرحبا', 0],
    ['Latin beside Arabic', 'abc مرحبا', 4],
    ['punctuation joins the script before it', 'مرحبا، كم', 1],
    ['a narrow no-break space after Latin', 'mot :', 5],
  ])('spaces as Chrome does: %s', (_, text, units) => {
    const sum = (spacing: Spacing, ls: number) => laidOut(P(`letter-spacing:${ls}px`, text), spacing)
      .runs.reduce((total, [, , width]) => total + (width as number), 0);
    expect(sum(NONE, 10) - sum(NATIVE, 0)).toBeCloseTo(units * 10, 6);
  });
});

describe('paint on a ctx without letter- and word-spacing', () => {
  it('a spacing ctx paints each run whole', () => {
    expect(painted(P('letter-spacing:5px', 'AVA'), NATIVE)).toEqual([['AVA', 0]]);
  });

  it('places each grapheme where a spacing ctx paints it', () => {
    expect(painted(P('letter-spacing:5px', 'AVA'), NONE)).toEqual([
      ['A', 0], ['V', +(w('AV') - w('V') + 5).toFixed(6)], ['A', +(w('AVA') - w('A') + 10).toFixed(6)],
    ]);
  });

  it('puts an RTL glyph\'s spacing on its visual right, as Chrome does', () => {
    // dir=rtl paints right-aligned at the right edge: each x is a glyph's right edge.
    expect(painted(P('letter-spacing:5px', 'אבג', 'dir="rtl"'), NONE)).toEqual([
      ['א', 395], ['ב', +(400 - (w('אב') - w('ב')) - 10).toFixed(6)], ['ג', +(400 - (w('אבג') - w('ג')) - 15).toFixed(6)],
    ]);
  });

  it('cuts only where spacing goes: an unspaced script paints whole', () => {
    expect(painted(P('letter-spacing:5px', 'مرحبا', 'dir="rtl"'), NONE)).toEqual([['مرحبا', 400]]);
  });

  it('adds word-spacing inside one run (an nbsp joins two words)', () => {
    expect(painted(P('word-spacing:7px', 'ab&nbsp;cd ef'), NONE)).toEqual([
      ['ab ', 0],
      ['cd ', +(w('ab cd ') - w('cd ') + 7).toFixed(6)],
      ['ef', +(w('ab cd ef') - w('ef') + 14).toFixed(6)],
    ]);
  });

  it('keeps words whole on a ctx that applies letter-spacing but not word-spacing, and writes it none', () => {
    const paints = fills(P('letter-spacing:2px;word-spacing:7px', 'one two'), { wordSpacing: false });
    expect(fillTexts(paints).map(([text, x]) => [text, +x.toFixed(6)])).toEqual([
      ['one ', 0], ['two', +(w('one two', 2) - w('two', 2) + 7).toFixed(6)],
    ]);
    for (const p of paints) expect(p).toContain('letterSpacing="2px";wordSpacing="0px"');
  });

  it('paints each piece in its level\'s direction, so no space of it moves', () => {
    // An RTL paragraph's Latin words on a ctx without word-spacing (a PDF proxy).
    const paints = fills(P('word-spacing:8px', 'שלום hello world עולם', 'dir="rtl"'), { wordSpacing: false });
    expect(fillTexts(paints).map(([text], i) => `${text}|${/direction="(\w+)"/.exec(paints[i])![1]}`))
      .toEqual(['שלום|rtl', ' |rtl', 'hello |ltr', 'world|ltr', ' עולם|rtl']);
  });

  it('orders a mixed-direction run as Canvas does', () => {
    // One Blink fillText: `ab ` and ` cd` left to right, `אב` right to left between them,
    // each Hebrew letter painted right to left, at its right edge.
    const drawn = painted(P('letter-spacing:5px', 'ab אב cd'), NONE);
    const at = (text: string) => drawn.filter(([t]) => t === text).map(([, x]) => x);
    const left2 = w('ab ') + 15, right2 = left2 + w('אב') + 10;
    expect(drawn.map(([t]) => t)).toEqual(['a', 'b', ' ', 'א', 'ב', ' ', 'c', 'd']);
    expect(at('א')[0]).toBeCloseTo(right2 - 5, 6);
    expect(at('ב')[0]).toBeCloseTo(right2 - (w('אב') - w('ב')) - 10, 6);
    expect(at(' ')[1]).toBeCloseTo(right2, 6);
  });

  it('reverses an RTL override (bdo) from its right edge', () => {
    const html = P('letter-spacing:5px', 'ab <bdo dir="rtl">cd</bdo>');
    const right = laidOut(html, NONE).runs.find(([t]) => t === '\u202Ecd\u202C')![1] as number;
    const drawn = new Map(painted(html, NONE));
    expect(drawn.get('\u202Ec\u202C')).toBeCloseTo(right - 5, 6);
    expect(drawn.get('\u202Ed\u202C')).toBeCloseTo(right - (w('\u202Ecd') - w('d')) - 10, 6);
  });

  it.each([['without either spacing', NONE], ['without word-spacing', { wordSpacing: false }]] as const)(
    'keeps an RTL override on a piece of several letters (%s)', (_, spacing) => {
      const html = P('word-spacing:7px', 'ab <bdo dir="rtl">cd ef</bdo>');
      const right = laidOut(html, spacing).runs.find(([t]) => t === '\u202Ecd ef\u202C')![1] as number;
      // Right to left, a space's word-spacing is on its visual right: the cut comes before it.
      expect(painted(html, spacing).filter(([t]) => /[c-f]/.test(t))).toEqual([
        ['\u202Ecd\u202C', right],
        ['\u202E ef\u202C', +(right - w('\u202Ecd ef\u202C') + w('\u202E ef\u202C') - 7).toFixed(6)],
      ]);
    });

  it.each(['line', 'word', 'grapheme'] as const)('%s units at rest paint where drawLayout paints', (level) => {
    const html = P('letter-spacing:4px;word-spacing:6px', 'Hello שלום world', 'dir="rtl"');
    // Each glyph's left edge: a unit's piece may paint left-aligned where the line paints right.
    const lefts = (textUnits?: TextUnitLevel) => painted(html, NONE, textUnits, true)
      .filter(([t]) => t.trim()).map(([t, x]) => x).sort((a, b) => a - b).map(x => +x.toFixed(4));
    expect(lefts(level)).toEqual(lefts());
  });
});

describe('sliced text units on a ctx without spacing', () => {
  it('paint each glyph near its unit only, not the whole line per unit', () => {
    const html = P('letter-spacing:1px;white-space:nowrap', Array.from({ length: 40 }, () => 'word').join(' '));
    const count = (paintTextUnit?: TextUnitPaint) => {
      const rec = recordingCtx(400, 400, NONE);
      const result = layout({ html, width: 400, ctx: rec.ctx, textUnits: 'grapheme' });
      drawLayout({ layout: result, width: 400, ctx: rec.ctx, pixelRatio: 1, paintTextUnit });
      return rec.counts.calls.fillText;
    };
    expect(count(({ draw }) => draw({ slice: true }))).toBeLessThan(8 * count());
  });
});

describe('a path on a ctx without letterSpacing', () => {
  it('places glyphs where a spacing ctx places them', () => {
    const glyphs = (spacing: Spacing) => layoutTextOnPath({
      html: '<span style="font:40px serif;letter-spacing:20px">HHH</span>', path: 'M0 80 L400 80', align: 'right',
      ctx: recordingCtx(400, 200, spacing).ctx,
    }).glyphs.map(g => +g.x.toFixed(6));
    expect(glyphs(NONE)).toEqual(glyphs(NATIVE));
  });
});
