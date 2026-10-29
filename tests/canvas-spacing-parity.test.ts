/**
 * render-tag on a canvas that has no `letterSpacing` or `wordSpacing` (Safari before 18.4)
 * against the same fixture on this engine's own spacing. The properties are deleted from the
 * 2D context prototypes, as such an engine has none, and render-tag adds the spacing itself
 * the way Chrome's canvas does (tests/node/canvas-spacing.test.ts holds the rules).
 *
 * The oracle is this engine's canvas, so a fixture where its rule is not Chrome's cannot
 * match: `RESIDUE` lists them per engine, with the reason, and only shrinks; it was measured
 * on the maintainer's Mac, so in portable mode (CI) a listed fixture may match. Firefox is not a
 * lane: its own spacing is not Chrome's (an RTL glyph's on its other side, none after a
 * no-break space's word-spacing, Arabic letters spaced).
 *
 *   npx vitest run --project chromium tests/canvas-spacing-parity.test.ts
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { drawLayout, layout } from '../src/index.ts';
import { drawTextOnPath } from '../src/path/index.ts';
import { compareCanvasPixels, prepareComparisonFonts } from './helpers/compare.ts';
import { loadMultiFontCss, TEST_FALLBACK_STACK } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';
import { makeCanvas } from './helpers/pixels.ts';
import { PORTABLE_GATES_ONLY } from './helpers/portable-mode.ts';
import { reportPath } from './helpers/report-path.ts';

const PIXEL_RATIO = 2;
const WIDTH = 360;
const family = (name: string) => `'${name}', ${TEST_FALLBACK_STACK}, sans-serif`;
const p = (style: string, body: string, attrs = '') =>
  `<p ${attrs} style="margin:0 0 8px;font:24px ${family('Roboto')};${style}">${body}</p>`;

const FIXTURES: [string, string][] = [
  ['right aligned', p('text-align:right;font-size:40px;letter-spacing:20px', 'HHH')],
  ['centered, wrapping', p('text-align:center;letter-spacing:3px', 'The quick brown fox jumps over the lazy dog again and again')],
  ['kerning', p(`font-family:${family('Playfair Display')};letter-spacing:4px`, 'AVAWAY To Ty Wo')],
  ['negative', p('letter-spacing:-1.5px', 'Tightly set words in a row')],
  ['decorated', p('letter-spacing:5px;text-decoration:underline line-through', 'Under and through')],
  ['shadow and stroke', p('letter-spacing:4px;text-shadow:2px 2px 3px #f00;-webkit-text-stroke:1px #00f', 'Shadow stroke')],
  ['spans', p('letter-spacing:2px', 'plain <b style="letter-spacing:8px">wide</b> <i>italic</i> end')],
  ['combining and emoji', p('letter-spacing:6px', 'café 👨‍👩‍👧 🇺🇸 ok')],
  ['Hebrew', p('letter-spacing:5px', 'שלום עולם יפה מאוד', 'dir="rtl"')],
  ['mixed direction', p('letter-spacing:3px', 'one שלום (עולם) [יפה] two')],
  ['bdo', p('letter-spacing:4px', 'ab <bdo dir="rtl">reversed text</bdo> cd')],
  // Ends at the bdo: Chrome's own canvas gives a string's leading space no word-spacing, so
  // its one-fillText ` cd` after it paints 12px off render-tag's layout; the fallback does not.
  ['bdo with word-spacing', p('word-spacing:12px', 'ab <bdo dir="rtl">reversed text here</bdo>')],
  ['RTL with Latin words', p('word-spacing:8px', 'שלום hello world 123 עולם', 'dir="rtl"')],
  ['RTL with Latin words, both spacings', p('letter-spacing:3px;word-spacing:8px', 'שלום hello world 123 עולם', 'dir="rtl"')],
  ['RTL kerning', p(`font-family:${family('Playfair Display')};letter-spacing:4px`, 'A V To', 'dir="rtl"')],
  ['word-spacing', p('word-spacing:14px', 'one two three four')],
  ['word-spacing over nbsp', p('word-spacing:14px', 'one&nbsp;two&nbsp;three four')],
  ['both spacings', p('letter-spacing:3px;word-spacing:10px', 'one&nbsp;two three')],
  ['Arabic beside Latin', p('letter-spacing:6px', 'hello مرحبا world')],
  ['Arabic sentence', p('letter-spacing:6px', 'مرحبا بكم، hello', 'dir="rtl"')],
  ['Devanagari', p('letter-spacing:6px', 'नमस्ते दुनिया')],
  ['Thai', p('letter-spacing:6px', 'สวัสดี ชาวโลก')],
  ['ligatures', p(`font-family:${family('Playfair Display')};letter-spacing:3px`, 'office affluent')],
];

/**
 * Fixtures this engine's own spacing places differently from the fallback. Only shrinks.
 * - Arabic sentence: Chrome leaves a space between Arabic words unspaced in Roboto (kerned)
 *   but spaces it in an Arabic font; the fallback spaces it. WebKit spaces Arabic letters.
 * - Devanagari, Thai: both engines space inside a shaped run (`shapesAsRun`), which the
 *   fallback paints whole.
 * - ligatures: Chrome drops them under letter-spacing, and the fallback measures with them;
 *   WebKit keeps them and spaces each glyph.
 * - RTL with Latin words: WebKit's own canvas gives a string's leading space no word-spacing,
 *   so its one-fillText ` עולם` paints off render-tag's layout; the fallback does not.
 */
const RESIDUE: Partial<Record<string, string[]>> = {
  chrome: ['Arabic sentence', 'Devanagari', 'Thai', 'ligatures'],
  webkit: ['RTL with Latin words', 'Arabic beside Latin', 'Arabic sentence', 'Devanagari', 'Thai', 'ligatures'],
};

/** The 2D contexts without their spacing properties, as an engine without them has. */
function withoutCanvasSpacing<T>(draw: () => T): T {
  const saved = [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype].flatMap((proto) =>
    (['letterSpacing', 'wordSpacing'] as const).map((key) => [proto, key, Object.getOwnPropertyDescriptor(proto, key)!] as const));
  for (const [proto, key] of saved) delete (proto as Partial<CanvasRenderingContext2D>)[key];
  try {
    return draw();
  } finally {
    for (const [proto, key, d] of saved) Object.defineProperty(proto, key, d);
  }
}

/** A fresh measuring ctx each time: a ctx that ever had spacing keeps it once the setter is gone. */
function drawBlock(html: string): HTMLCanvasElement {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const result = layout({ html, width: WIDTH, ctx });
  return drawLayout({ layout: result, width: WIDTH, pixelRatio: PIXEL_RATIO }).canvas as HTMLCanvasElement;
}

function drawPath(html: string): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(WIDTH * PIXEL_RATIO, 120 * PIXEL_RATIO);
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  drawTextOnPath({ ctx, html, path: `M10 90 Q${WIDTH / 2} 10 ${WIDTH - 10} 90`, align: 'center' });
  return canvas;
}

describe('a canvas without letterSpacing and wordSpacing paints as one with them', () => {
  it('block layout', async () => {
    const css = await loadMultiFontCss();
    await prepareComparisonFonts(FIXTURES.map(([, html]) => html).join(''), css);
    const failures: string[] = [];
    const report: string[] = [];
    for (const [name, html] of FIXTURES) {
      const percent = compareCanvasPixels(drawBlock(html), withoutCanvasSpacing(() => drawBlock(html)))
        .contentMismatchPercentage;
      report.push(`${percent.toFixed(4)}%\t${name}`);
      const known = RESIDUE[browserName]?.includes(name);
      if (known && percent === 0 && !PORTABLE_GATES_ONLY) failures.push(`${name}: now matches, remove it from RESIDUE`);
      else if (!known && percent > 0) failures.push(`${name}: ${percent.toFixed(3)}%`);
    }
    await commands.writeFile(reportPath(`canvas-spacing.${browserName}.txt`), report.join('\n') + '\n');
    expect(failures).toEqual([]);
  });

  it('text on a path', async () => {
    const html = `<span style="font:28px ${family('Roboto')};letter-spacing:9px">Spaced on a curve</span>`;
    await prepareComparisonFonts(html, await loadMultiFontCss());
    expect(compareCanvasPixels(drawPath(html), withoutCanvasSpacing(() => drawPath(html))).contentMismatchPercentage).toBe(0);
  });
});
