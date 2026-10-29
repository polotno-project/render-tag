/**
 * Text units (`layout({ textUnits })`, `drawLayout({ paintTextUnit })`): the laid-out
 * text cut into lines, words or graphemes in reading order, each painted under the
 * caller's canvas state.
 *
 * The layout half runs on `mockCtx` (every glyph 10px) so geometry is exact; the paint
 * half on `recording-ctx`, which kerns, so a piece painted alone at the wrong origin
 * shows. A unit painter that drops or repeats a glyph, or paints a line differently
 * from `drawLayout`, fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.ts';
import type { LayoutResult, TextUnit, TextUnitLevel, TextUnitPaint } from '../../src/index.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';
import { fillTexts, recordingCtx, stateWidth } from '../helpers/recording-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';
import { RUN_PIECES, type UnitRun } from '../../src/layout.ts';
import { isOpaque, isTransparent } from '../../src/css-resolver.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const P = '<p style="margin:0;font:10px serif">';

function units(html: string, level: TextUnitLevel, width = 400): TextUnit[] {
  return layout({ html, width, ctx: mockCtx(), textUnits: level }).textUnits!;
}

describe('text units: layout', () => {
  it('does no unit work unless asked', () => {
    expect(layout({ html: `${P}Hello world</p>`, width: 400, ctx: mockCtx() }).textUnits).toBeUndefined();
  });

  it('cuts words in reading order; white space is never a unit', () => {
    const words = units(`${P}Hello  <b>brave</b> world</p>`, 'word');
    expect(words.map(u => [u.index, u.word, u.text, u.kind, u.grouped])).toEqual([
      [0, 0, 'Hello', 'text', false],
      [1, 1, 'brave', 'text', false],
      [2, 2, 'world', 'text', false],
    ]);
    // 10px glyphs; the collapsed space is one 10px space.
    expect(words.map(u => [u.x, u.width])).toEqual([[0, 50], [60, 50], [120, 50]]);
    expect(words[0].fragments).toEqual([{ line: 0, x: 0, y: 0, width: 50, height: 16, baseline: 12, direction: 'ltr' }]);
  });

  it('keeps a word across style runs whole', () => {
    expect(units(`${P}Hel<b>lo</b> you</p>`, 'word').map(u => u.text)).toEqual(['Hello', 'you']);
  });

  it('cuts lines, with no word', () => {
    const lines = units(`${P}Hello brave world</p>`, 'line', 120);
    expect(lines.map(u => [u.text, u.word, u.fragments.map(f => f.line)])).toEqual([
      ['Hello brave', null, [0]],
      ['world', null, [1]],
    ]);
    expect(lines[1].y).toBe(16);
  });

  it('makes no unit of white space at any level', () => {
    const html = `${P}a</p>${P}&nbsp;</p><p style="margin:0;font:10px serif;white-space:pre">   </p>` +
      `${P}\u2003</p>${P}<span style="display:inline-block">&nbsp;</span></p>${P}b</p>`;
    for (const level of ['line', 'word', 'grapheme'] as const) {
      expect(units(html, level).map(u => u.text), level).toEqual(['a', 'b']);
    }
  });

  it('separates the words of a wrap that consumed a space', () => {
    expect(units(`${P}Hello world</p>`, 'word', 60).map(u => [u.text, u.fragments.length])).toEqual([
      ['Hello', 1], ['world', 1],
    ]);
  });

  it('keeps one word id across a wrap inside the word', () => {
    // A soft hyphen breaks "anima-tion"; break-word cuts "abcdefgh".
    const hyphen = units(`${P}anima&shy;tion</p>`, 'word', 70);
    expect(hyphen.map(u => [u.text, u.fragments.map(f => f.line)])).toEqual([['anima-tion', [0, 1]]]);
    const broken = units('<p style="margin:0;font:10px serif;overflow-wrap:break-word">abcdefgh</p>', 'word', 50);
    expect(broken.map(u => [u.text, u.fragments.map(f => f.line)])).toEqual([['abcdefgh', [0, 1]]]);
    const graphemes = units(`${P}anima&shy;tion</p>`, 'grapheme', 70);
    expect(new Set(graphemes.map(u => u.word))).toEqual(new Set([0]));
  });

  it('cuts graphemes with their word id', () => {
    const gs = units(`${P}Hi yo</p>`, 'grapheme');
    expect(gs.map(u => [u.text, u.word, u.x])).toEqual([['H', 0, 0], ['i', 0, 10], ['y', 1, 30], ['o', 1, 40]]);
  });

  it('keeps a grapheme whole across a style boundary', () => {
    const gs = units(`${P}a<span style="color:red">́</span>b</p>`, 'grapheme');
    expect(gs.map(u => [u.text, u.fragments.length])).toEqual([['á', 1], ['b', 1]]);
  });

  it('groups a joining script into one shaped run per word', () => {
    const gs = units(`${P}كتاب جميل</p>`, 'grapheme');
    expect(gs.map(u => [u.text, u.word, u.grouped])).toEqual([['كتاب', 0, true], ['جميل', 1, true]]);
  });

  it('orders RTL words by reading, placed right to left', () => {
    const words = units('<p dir="rtl" style="margin:0;font:10px serif">שלום עולם</p>', 'word');
    expect(words.map(u => u.text)).toEqual(['שלום', 'עולם']);
    expect(words[0].x).toBeGreaterThan(words[1].x);
    expect(words.map(u => u.fragments[0].direction)).toEqual(['rtl', 'rtl']);
    // Hebrew letters do not join: one unit per letter, the first rightmost.
    const letters = units('<p dir="rtl" style="margin:0;font:10px serif">שלום</p>', 'grapheme');
    expect(letters.map(u => [u.text, u.grouped, u.x])).toEqual([['ש', false, 390], ['ל', false, 380], ['ו', false, 370], ['ם', false, 360]]);
  });

  it('splits a word whose bidi pieces another word separates', () => {
    // LTR paragraph: "abc" | "דהו" | "אבג" — the next word sits between the first word's pieces.
    const words = units(`${P}abcאבג דהו</p>`, 'word');
    expect(words.map(u => u.text)).toEqual(['abcאבג', 'דהו']);
    const [first, second] = words;
    expect(first.fragments.map(f => f.direction).sort()).toEqual(['ltr', 'rtl']);
    const [left, right] = [...first.fragments].sort((a, b) => a.x - b.x);
    expect(second.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(second.x + second.width).toBeLessThanOrEqual(right.x);
  });

  it('keeps lines apart that share a top', () => {
    // line-height: 0 puts every line box at one y.
    const html = '<p style="margin:0;font:10px serif;line-height:0">Hello world</p>';
    expect(units(html, 'line', 60).map(u => u.text)).toEqual(['Hello', 'world']);
    expect(units(html, 'word', 60).map(u => [u.text, u.fragments[0].line])).toEqual([['Hello', 0], ['world', 1]]);
  });

  it('keeps one fragment for a word whose style pads it', () => {
    const [word] = units(`${P}un<mark style="padding:0 2px">believ</mark>able</p>`, 'word');
    expect(word.text).toBe('unbelievable');
    expect(word.fragments).toHaveLength(1);
  });

  it('glues punctuation as the line breaker does: an opener forward, a closer back', () => {
    expect(units(`${P}日本「東京」</p>`, 'word').map(u => u.text)).toEqual(['日本', '「東京」']);
    expect(units(`${P}今日は😀です。</p>`, 'word').map(u => u.text)).toEqual(['今日', 'は', '😀', 'です。']);
  });

  it('keeps an LTR line of an RTL block left to right', () => {
    // One fillText in the block's direction, all of it at an LTR level.
    const html = '<p style="margin:0;font:10px serif;direction:rtl">Hello world</p>';
    const words = units(html, 'word');
    expect(words.map(u => [u.text, u.fragments[0].direction])).toEqual([['Hello', 'ltr'], ['world', 'ltr']]);
    expect(words[0].x).toBeLessThan(words[1].x);
    const result = layout({ html, width: 400, ctx: recordingCtx(400, 100).ctx, textUnits: 'grapheme' });
    const xs = fillTexts(drawn(result, 400, ({ draw }) => draw()).paints).map(([, x]) => x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('gives a space to a unit beside it, whatever the reading order', () => {
    const pieces = (html: string) => collectTexts(layout({ html, width: 400, ctx: mockCtx(), textUnits: 'word' }).layoutRoot)
      .flatMap(run => (run as UnitRun)[RUN_PIECES] ?? []).sort((a, b) => a.left - b.left);
    // The space after עולם in reading order sits beside "cd": its band goes with a neighbour.
    const bidi = pieces(`${P}ab שלום עולם cd</p>`);
    bidi.forEach((piece, i) => {
      if (piece.space) expect([bidi[i - 1]?.unit, bidi[i + 1]?.unit]).toContain(piece.unit);
    });
    // An inline frame between a word and its space keeps the space with the word.
    const framed = pieces(`${P}<span style="border-right:2px solid red">Hello</span> world</p>`);
    expect(framed.filter(p => p.space).map(p => p.unit.text)).toEqual(['Hello']);
  });

  it('keeps nested inline-blocks one unit', () => {
    const html = `${P}a <span style="display:inline-block">b <span style="display:inline-block">c</span> d</span> e</p>`;
    expect(units(html, 'word').map(u => [u.text, u.kind])).toEqual([['a', 'text'], ['b c d', 'atomic'], ['e', 'text']]);
  });

  it('splits a mixed-direction word painted in one run by direction', () => {
    // At this width "(שלום" is a line of its own, one fillText over two levels.
    const word = units(`${P}abc (שלום עולם) def</p>`, 'word', 60).find(u => u.text === '(שלום')!;
    expect(word.fragments.map(f => f.direction).sort()).toEqual(['ltr', 'rtl']);
  });

  it('cuts scripts without spaces by words', () => {
    const thai = units(`${P}สวัสดีครับ</p>`, 'word');
    expect(thai.map(u => u.text).join('')).toBe('สวัสดีครับ');
    expect(thai.length).toBeGreaterThan(1);
  });

  it('makes a list marker its own unit and keeps it out of the words', () => {
    const html = '<ul style="margin:0;padding-left:40px;font:10px serif"><li>One two</li></ul>';
    expect(units(html, 'word').map(u => [u.text, u.kind, u.word])).toEqual([
      ['•', 'marker', null], ['One', 'text', 0], ['two', 'text', 1],
    ]);
    const lines = units(html, 'line');
    expect(lines.map(u => [u.text, u.kind])).toEqual([['• One two', 'text']]);
    // An empty item's line is its marker's own: the item's strut, not the disc's centre.
    const [marker] = units('<ul style="margin:0;padding-left:40px;font:10px serif"><li></li></ul>', 'word');
    expect([marker.fragments[0].baseline, marker.height]).toEqual([12, 16]);
  });

  it('marks a line-clamp ellipsis at grapheme level and keeps it in its word', () => {
    const html = '<p style="margin:0;font:10px serif;-webkit-line-clamp:1;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">Hello brave world</p>';
    const gs = units(html, 'grapheme', 100);
    expect(gs.at(-1)!.kind).toBe('ellipsis');
    expect(gs.at(-1)!.text).toBe('…');
    expect(gs.slice(0, -1).every(u => u.kind === 'text')).toBe(true);
    const words = units(html, 'word', 100);
    expect(words.at(-1)!.text.endsWith('…')).toBe(true);
  });

  it('keeps an inline-block whole', () => {
    const words = units(`${P}a <span style="display:inline-block">b c</span> d</p>`, 'word');
    expect(words.map(u => [u.text, u.kind, u.word])).toEqual([
      ['a', 'text', 0], ['b c', 'atomic', 1], ['d', 'text', 2],
    ]);
  });

  it.each([
    ['content overflowing its box', `${P}a<span style="display:inline-block;width:20px">longword</span>d</p>`, ['a', 'longword', 'd']],
    ['nowrap content wider than its box', `${P}x <span style="display:inline-block;width:30px;white-space:nowrap">ab cdefghij</span></p>`, ['x', 'ab cdefghij']],
    ['a zero line-height', `${P}a <span style="display:inline-block;line-height:0">b c</span> d</p>`, ['a', 'b c', 'd']],
  ])('keeps an inline-block whole with %s, on its outer line', (_label, html, texts) => {
    const words = units(html, 'word');
    expect(words.map(u => u.text)).toEqual(texts);
    expect(words.filter(u => u.kind === 'atomic')).toHaveLength(1);
    expect(words.flatMap(u => u.fragments.map(f => f.line))).toEqual(texts.map(() => 0));
  });

  it('keeps the word break of an inline-block\'s own wrap in its text', () => {
    const html = `${P}a <span style="display:inline-block;width:20px">bb cc</span></p>`;
    expect(units(html, 'word').map(u => u.text)).toEqual(['a', 'bb cc']);
    expect(units(html, 'line').map(u => u.text)).toEqual(['a bb cc']);
  });

  it('spans a whole line holding an inline-block', () => {
    const [line] = units(`${P}Hello <span style="display:inline-block">b c</span> world</p>`, 'line');
    expect([line.x, line.width]).toEqual([0, 150]);
  });

  it('places graphemes where the run paints them, kerning included', () => {
    const rec = recordingCtx(400, 100);
    const result = layout({ html: '<p style="margin:0;font:20px serif">AVAWAY</p>', width: 400, ctx: rec.ctx, textUnits: 'grapheme' });
    const state = { font: '20px serif', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'normal' };
    const text = 'AVAWAY';
    result.textUnits!.forEach((u, i) => {
      // Where the whole run's fillText draws grapheme i: its prefix less its own advance.
      const end = stateWidth(state, text.slice(0, i + 1));
      expect(u.x + u.width).toBeCloseTo(end, 9);
    });
  });
});

/** A recording of `result` drawn, through `paintTextUnit` when given. */
function drawn(result: LayoutResult, width: number, paintTextUnit?: (p: TextUnitPaint) => void, shadows = true) {
  const rec = recordingCtx(width, 400);
  drawLayout({ layout: result, width, ctx: rec.ctx, createCanvas: rec.createCanvas, renderShadows: shadows, paintTextUnit });
  return rec;
}

const identity = ({ draw }: TextUnitPaint) => draw();

/** The glyphs a paint fills, white space dropped, in order. */
function glyphs(paints: string[]): string {
  return fillTexts(paints).map(([text]) => text).join('').replace(/\s/g, '');
}

const PARITY_CASES: Record<string, string> = {
  plain: '<p style="margin:0;font:20px serif">Hello brave new world of text units</p>',
  styles: '<p style="margin:0;font:20px serif">Hel<b>lo</b> <i style="color:red">brave</i> <span style="font-size:30px">new</span> world</p>',
  decorations: '<p style="margin:0;font:20px serif;text-decoration:underline wavy red">Hello <s>brave new</s> world</p>',
  gradient: '<p style="margin:0;font:20px serif;background:linear-gradient(90deg,red,blue);-webkit-background-clip:text;color:transparent">Hello <span>brave</span> new world</p>',
  stroke: '<p style="margin:0;font:20px serif;-webkit-text-stroke:2px blue;paint-order:stroke fill">Hello brave world</p>',
  boxes: '<div style="font:20px serif"><p style="margin:0">Hello <span style="background:yellow;padding:0 4px">brave</span> world</p><p style="margin:0;background:#eee;border:1px solid red">Second paragraph here</p></div>',
  rtl: '<p dir="rtl" style="margin:0;font:20px serif">שלום עולם ומה <b>שלומך</b> היום</p>',
  bidi: '<p style="margin:0;font:20px serif">Hello עולם ומה world 123</p>',
  list: '<ul style="margin:0;padding-left:40px;font:20px serif"><li>One two</li><li>Three <u>four</u></li></ul><ol style="font:20px serif"><li>Alpha</li></ol>',
  clamp: '<p style="margin:0;font:20px serif;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">Hello brave new world of text units and more words to cut</p>',
  inlineBlock: '<p style="margin:0;font:20px serif">a <span style="display:inline-block;background:pink;padding:2px">b c</span> d</p>',
  arabic: '<p dir="rtl" style="margin:0;font:20px serif">كتاب جميل جدا</p>',
  justify: '<p style="margin:0;font:20px serif;text-align:justify">Hello brave new world of text units and more words</p>',
};

describe('text units: paint', () => {
  it('a layout with units draws as before without a painter', () => {
    for (const html of Object.values(PARITY_CASES)) {
      const plain = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx });
      const withUnits = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'grapheme' });
      expect(drawn(withUnits, 300).paints).toEqual(drawn(plain, 300).paints);
    }
  });

  // No text-shadow here: each unit casts its own, so shadows are not op-identical by design.
  it('paints every line exactly as drawLayout when the painter changes nothing', () => {
    for (const [name, html] of Object.entries(PARITY_CASES)) {
      const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'line' });
      expect(drawn(result, 300, identity).paints, name).toEqual(drawn(result, 300).paints);
    }
  });

  for (const level of ['word', 'grapheme'] as const) {
    it(`paints every glyph once at ${level} level`, () => {
      for (const [name, html] of Object.entries(PARITY_CASES)) {
        const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: level });
        expect(glyphs(drawn(result, 300, identity).paints), name).toBe(glyphs(drawn(result, 300).paints));
      }
    });
  }

  it('calls the painter once per unit in reading order, shadow phase first', () => {
    const html = '<div style="font:20px serif"><p style="margin:0;text-shadow:2px 2px 3px red">Hello brave</p><p style="margin:0">world</p></div>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const calls: string[] = [];
    drawn(result, 300, ({ unit, phase, draw }) => { calls.push(`${phase}:${unit.text}`); draw(); });
    expect(calls).toEqual(['shadow:Hello', 'shadow:brave', 'shadow:world', 'text:Hello', 'text:brave', 'text:world']);
    calls.length = 0;
    drawn(result, 300, ({ unit, phase, draw }) => { calls.push(`${phase}:${unit.text}`); draw(); }, false);
    expect(calls).toEqual(['text:Hello', 'text:brave', 'text:world']);
  });

  it('paints nothing of a unit the painter does not draw', () => {
    const result = layout({ html: PARITY_CASES.plain, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, draw }) => { if (unit.text === 'brave') draw(); });
    expect(glyphs(rec.paints)).toBe('brave');
  });

  it('applies the caller state to the unit, and only to it', () => {
    const result = layout({ html: PARITY_CASES.plain, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, ctx, draw }) => {
      if (unit.text === 'brave') { ctx.globalAlpha = 0.5; ctx.translate(0, 7); }
      draw();
    });
    const fills = rec.paints.filter(p => p.startsWith('fillText('));
    const brave = fills.find(p => p.startsWith('fillText("brave"'))!;
    expect(brave).toContain('globalAlpha=0.5');
    expect(brave).toContain('matrix=1,0,0,1,0,7');
    for (const other of fills.filter(p => p !== brave)) {
      expect(other).toContain('globalAlpha=1');
      expect(other).toContain('matrix=1,0,0,1,0,0');
    }
  });

  it('keeps its own text state when the painter writes over it', () => {
    const result = layout({ html: PARITY_CASES.styles, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const clobber = ({ ctx, draw }: TextUnitPaint) => {
      ctx.font = '99px clobbered'; ctx.fillStyle = 'lime'; ctx.letterSpacing = '9px';
      ctx.textAlign = 'center'; ctx.setLineDash([3, 3]); ctx.lineCap = 'round';
      draw();
    };
    const expected = drawn(result, 300, identity).paints;
    expect(drawn(result, 300, clobber).paints).toEqual(expected);
  });

  it('replaces the glyph fill, not the stroke', () => {
    const result = layout({ html: PARITY_CASES.stroke, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, draw }) => draw(unit.index === 1 ? { fill: 'gold' } : undefined));
    const paints = rec.paints.filter(p => p.startsWith('fillText(') || p.startsWith('strokeText('));
    expect(paints.find(p => p.startsWith('fillText("brave"'))).toContain('fillStyle="gold"');
    expect(paints.find(p => p.startsWith('strokeText("brave"'))).toContain('strokeStyle="blue"');
    expect(paints.find(p => p.startsWith('fillText("Hello"'))).not.toContain('gold');
    const outline = layout({
      html: '<p style="margin:0;font:20px serif;color:transparent;-webkit-text-stroke:1px blue">Hello</p>',
      width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word',
    });
    const hollow = drawn(outline, 300, ({ draw }) => draw({ fill: 'gold' })).paints;
    expect(hollow.some(p => p.startsWith('strokeText('))).toBe(true);
    expect(hollow.some(p => p.startsWith('fillText('))).toBe(false);
  });

  it('clips a decoration band to the unit, so a hidden word leaves a gap', () => {
    const html = '<p style="margin:0;font:20px serif;text-decoration:underline">Hello brave world</p>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, draw }) => { if (unit.text !== 'brave') draw(); });
    const bands = rec.paints.filter(p => !p.startsWith('fillText('));
    expect(bands).toHaveLength(2);
    for (const band of bands) expect(band).toMatch(/clip=\[".*rect\(/);
  });

  it('casts each unit\'s text-shadow under that unit\'s state', () => {
    const html = '<p style="margin:0;font:20px serif;text-shadow:2px 2px 3px red">Hello brave world</p>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, ctx, draw }) => {
      if (unit.text === 'brave') ctx.globalAlpha = 0.5;
      draw();
    });
    const images = rec.paints.filter(p => p.startsWith('drawImage('));
    // One mask per unit, each drawn before any glyph.
    expect(images).toHaveLength(3);
    expect(rec.paints.findIndex(p => p.startsWith('fillText('))).toBeGreaterThan(rec.paints.lastIndexOf(images[2]));
    // The op's own state follows its last ' | ' (a scratch canvas describes its ops inside).
    expect(images.map(p => /globalAlpha=([\d.]+)/.exec(p.slice(p.lastIndexOf(' | ')))![1])).toEqual(['1', '0.5', '1']);
  });

  it('casts a canvas shadow once per draw, never per glyph', () => {
    const result = layout({ html: PARITY_CASES.plain, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ unit, ctx, draw }) => {
      if (unit.text === 'brave') { ctx.shadowColor = 'blue'; ctx.shadowBlur = 5; }
      draw();
    });
    expect(rec.paints.filter(p => p.startsWith('drawImage('))).toHaveLength(1);
    for (const fill of rec.paints.filter(p => p.startsWith('fillText('))) expect(fill).not.toContain('shadowColor="blue"');
  });

  it('strokes a canvas-shadow layer solid whatever dash the callback set', () => {
    const html = '<p style="margin:0;font:20px serif;text-decoration:underline wavy">Hello brave</p>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ ctx, draw }) => {
      ctx.setLineDash([3, 3]); ctx.shadowColor = 'blue'; ctx.shadowBlur = 5;
      draw();
    });
    const layers = rec.paints.filter(p => p.startsWith('drawImage('));
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) expect(layer).not.toContain('dash=3,3');
    expect(rec.paints.filter(p => p.startsWith('stroke(')).some(p => p.endsWith('dash=3,3'))).toBe(false);
  });

  it('casts a shadow set on the ctx before any unit\'s text, one per unit', () => {
    const result = layout({ html: PARITY_CASES.plain, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = recordingCtx(300, 400);
    Object.assign(rec.ctx, { shadowColor: 'blue', shadowBlur: 4, shadowOffsetX: 3 });
    drawLayout({ layout: result, width: 300, ctx: rec.ctx, createCanvas: rec.createCanvas, paintTextUnit: identity });
    const ops = rec.paints.map(p => p.slice(0, p.indexOf('(')));
    expect(ops.filter(op => op === 'drawImage')).toHaveLength(result.textUnits!.length);
    expect(ops.lastIndexOf('drawImage')).toBeLessThan(ops.indexOf('fillText'));
  });

  it('paints no shadow inside a callback under renderShadows: false', () => {
    const html = '<p style="margin:0;font:20px serif;text-shadow:2px 2px 3px red">Hello brave</p>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ ctx, draw }) => { ctx.shadowColor = 'blue'; ctx.shadowBlur = 5; draw(); }, false);
    expect(rec.paints.some(p => p.startsWith('drawImage('))).toBe(false);
    for (const fill of rec.paints.filter(p => p.startsWith('fillText('))) expect(fill).not.toContain('shadowColor="blue"');
  });

  it('clips a band to finite edges under a zero scale', () => {
    const html = '<p style="margin:0;font:20px serif;text-decoration:underline">Hello brave world</p>';
    const result = layout({ html, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'word' });
    const rec = drawn(result, 300, ({ ctx, draw }) => { ctx.scale(0, 0); draw(); });
    const clipped = rec.paints.filter(p => p.includes('clip=['));
    expect(clipped.length).toBeGreaterThan(0);
    for (const paint of clipped) expect(paint).not.toMatch(/Infinity|NaN/);
  });

  it('overlaps a rotated band only when its colour is surely opaque', () => {
    for (const color of ['red', '#000', 'rgb(1 2 3)', 'hsl(0, 0%, 0%)']) expect(isOpaque(color), color).toBe(true);
    for (const color of ['rgba(0,0,0,.5)', '#0008', 'rgb(0 0 0 / 50%)', 'transparent',
      'color-mix(in srgb, red 50%, transparent)', 'rgb(0 0 0 / calc(.5))', 'rgb(from #0008 r g b)']) {
      expect(isOpaque(color), color).toBe(false);
    }
    // Unreadable is not transparent either: it still paints.
    expect(isTransparent('color-mix(in srgb, red 50%, transparent)')).toBe(false);
  });

  it('rejects an unknown level', () => {
    expect(() => layout({ html: PARITY_CASES.plain, width: 300, ctx: mockCtx(), textUnits: 'letter' as TextUnitLevel }))
      .toThrow(/textUnits/);
  });

  it('throws without units', () => {
    const result = layout({ html: PARITY_CASES.plain, width: 300, ctx: recordingCtx(300, 400).ctx });
    expect(() => drawn(result, 300, identity)).toThrow(/textUnits/);
  });

  it('restores the caller ctx', () => {
    const result = layout({ html: PARITY_CASES.decorations, width: 300, ctx: recordingCtx(300, 400).ctx, textUnits: 'grapheme' });
    const rec = recordingCtx(300, 400);
    rec.ctx.globalAlpha = 0.25;
    drawLayout({ layout: result, width: 300, ctx: rec.ctx, createCanvas: rec.createCanvas, paintTextUnit: ({ ctx, draw }) => {
      ctx.globalAlpha = 1; ctx.rotate(0.3); draw();
    } });
    expect(rec.ctx.globalAlpha).toBe(0.25);
    expect(rec.ctx.getTransform()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });
});
