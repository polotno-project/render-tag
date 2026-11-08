/**
 * Line-break rules at inline box edges and in preserved white space, against Chrome's DOM:
 * the container width at which a word joins the first line. Per case the DOM's
 * threshold is found to 1/64px; render-tag must keep the word off the first line 0.25px below
 * it and on it 0.25px above it. A wrong rule is off by a whole edge or space (5-6px here), a
 * measuring difference by hundredths. The engine's own sans-serif, except where a case needs
 * a font's kerning.
 *
 *   npx vitest run --project <browser> tests/break-rules-parity.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { layout } from '../src/index.ts';
import playfair from './fonts/playfair-display/playfair-display-latin-wght-normal.woff2?url';
import arimo from './fonts/arimo/arimo-latin-wght-normal.woff2?url';
import merriweather from './fonts/merriweather/merriweather-latin-wght-normal.woff2?url';
import { extractDomBoxes, extractDomLines } from './helpers/compare.ts';
import { collectInlineBoxes } from './helpers/layout-tree.ts';

const STYLE = 'font: 20px sans-serif; margin: 0';
const MARGIN = 0.25;

/** The line holding `anchor` (else the first line) holds `word`. */
function lineHolds(lines: readonly { text: string }[], word: string, anchor?: string): boolean {
  const line = anchor ? lines.find((l) => l.text.includes(anchor)) : lines[0];
  return line?.text.includes(word) ?? false;
}

function domHolds(html: string, style: string, word: string, width: number, anchor?: string): boolean {
  return lineHolds(extractDomLines(`<p>${html}</p>`, `p { ${STYLE}; ${style} }`, width), word, anchor);
}

function canvasHolds(html: string, style: string, word: string, width: number, anchor?: string): boolean {
  return lineHolds(layout({ html: `<p style="${STYLE}; ${style}">${html}</p>`, width }).lines, word, anchor);
}

/** The narrowest width at which the DOM's line `anchor` ends on holds `word`, to 1/64px. */
function domThreshold(html: string, style: string, word: string, anchor?: string): number {
  let lo = 20;
  let hi = 600;
  expect(domHolds(html, style, word, hi, anchor), 'fits at the widest probe').toBe(true);
  while (hi - lo > 1 / 64) {
    const mid = (lo + hi) / 2;
    if (domHolds(html, style, word, mid, anchor)) hi = mid;
    else lo = mid;
  }
  return hi;
}

const CASES: { name: string; html: string; word: string; style?: string }[] = [
  // A box edge is no break opportunity: the word and both edges share a line.
  { name: 'a word continued into a padded box', html: 'aaa bb luya<span style="padding:0 6px">lu</span> c', word: 'luya' },
  { name: 'a word continued out of a padded box', html: 'aaa bb <span style="padding:0 6px">luya</span>lu c', word: 'luya' },
  // EDGE_BEFORE_SPACE_MAX_CLOSES (flow.ts).
  { name: 'an opening edge right before a space', html: 'aaa bb homaj<b style="padding-left:6px"> rajtoj</b>', word: 'homaj' },
  { name: 'an opening edge before a space, one closing tag between', html: 'aaa bb <span>homaj</span><b style="padding-left:6px"> rajtoj</b>', word: 'homaj' },
  { name: 'an opening edge before a space, two closing tags between', html: 'aaa bb <span><span>homaj</span></span><b style="padding-left:6px"> rajtoj</b>', word: 'homaj' },
  { name: 'an opening edge before a preserved space, two closing tags between', html: 'aaa bb <span><span>homaj</span></span><b style="padding-left:6px"> rajtoj</b>', word: 'homaj', style: 'white-space: pre-wrap' },
  // `break-spaces`: a word wraps with its first space.
  { name: 'break-spaces', html: 'aaa bbb ccc', word: 'bbb', style: 'white-space: break-spaces' },
  { name: 'pre-wrap', html: 'aaa bbb ccc', word: 'bbb', style: 'white-space: pre-wrap' },
  // A URL wraps after "?" under every white-space.
  { name: 'a break after "?"', html: 'aa aaaa?bbbb', word: 'aaaa' },
  { name: 'a break after "?" in pre-wrap', html: 'aa aaaa?bbbb', word: 'aaaa', style: 'white-space: pre-wrap' },
];

/** render-tag keeps `word` off the line MARGIN below the DOM's threshold and on it MARGIN above. */
function expectThreshold(html: string, style: string, word: string, anchor?: string): void {
  const threshold = domThreshold(html, style, word, anchor);
  expect(canvasHolds(html, style, word, threshold - MARGIN, anchor), `holds "${word}" at ${threshold} - ${MARGIN}`).toBe(false);
  expect(canvasHolds(html, style, word, threshold + MARGIN, anchor), `holds "${word}" at ${threshold} + ${MARGIN}`).toBe(true);
}

beforeAll(async () => {
  for (const [family, url] of [['KernPlayfair', playfair], ['KernArimo', arimo], ['KernMerriweather', merriweather]]) {
    document.fonts.add(await new FontFace(family, `url(${url})`, { weight: '100 900' }).load());
  }
});

describe('line-break rules vs the DOM', () => {
  for (const { name, html, word, style = '' } of CASES) {
    it(name, () => expectThreshold(html, style, word));
  }
});

describe('a hanging space keeps its kern with the glyph before it', () => {
  // Playfair Display kerns "y " -1.04px and "T " -0.96px at 40px: the line ends that much
  // narrower in Chrome's DOM, where the space after it would not show.
  const font = 'font: 40px KernPlayfair';
  it.each([
    ['y', 'ab glory cd', 'glory', font],
    ['y, pre-wrap', 'ab glory cd', 'glory', `${font}; white-space: pre-wrap`],
    ['T', 'ab THAT cd', 'THAT', font],
    // A trailing space that would show (`LineFlow.endKern`).
    ['y, centred', 'ab glory cd', 'glory', `${font}; text-align: center`],
    ['y, justified', 'ab glory cd', 'glory', `${font}; text-align: justify`],
    ['y, underlined', '<u>ab glory cd</u>', 'glory', font],
    ['y, on a background', '<span style="background: yellow">ab glory cd</span>', 'glory', font],
    ['y, coloured', '<span style="color: red">ab glory cd</span>', 'glory', font],
    ['y, in a bordered block', 'ab glory cd', 'glory', `${font}; border-right: 1px solid transparent; box-sizing: border-box`],
    ['y, in a block with a background', 'ab glory cd', 'glory', `${font}; background: yellow`],
    ['y, in a block with a gradient', 'ab glory cd', 'glory', `${font}; background-image: linear-gradient(red, blue)`],
    ['y, in a padded block', 'ab glory cd', 'glory', `${font}; padding-right: 1px; box-sizing: border-box`],
  ])('a line ending in "%s"', (_, html, word, style) => expectThreshold(html, style, word));

  // Chrome strips a collapsible space ending the paragraph or a line before <br> before it
  // shapes: a box shrunk to its content is as wide as the glyph before it unkerned.
  it.each([
    ['ending the paragraph', 'ab glory ', ''],
    ['before a <br>', 'ab glory <br>cd', ''],
    ['ending the paragraph, pre-wrap', 'ab glory ', 'white-space: pre-wrap'],
  ])('a space %s', (_, html, style) => {
    const box = `display: inline-block; ${font}; ${style}`;
    const dom = extractDomBoxes(`<span style="${box}">${html}</span>`, '', 600, 'span')[0].width;
    const canvas = collectInlineBoxes(layout({ html: `<div><span style="${box}">${html}</span></div>`, width: 600 }).layoutRoot)[0];
    expect(Math.abs(canvas.width - dom), `${canvas.width} vs DOM ${dom}`).toBeLessThan(MARGIN);
  });
});

describe('kerning across an element edge', () => {
  // `continuesShaping`: Arimo kerns "AV" and "VA" ~-3px at 40px; five pairs here straddle
  // element edges. Chrome kerns across them.
  const pairs = (attrs: string) => `${`A<span ${attrs}>V</span>`.repeat(3)} zz`;
  it.each([
    ['a colour span', pairs('style="color: red"'), 'zz', 'font: 40px KernArimo'],
    ['a padded span', pairs('style="padding-left: 1px"'), 'zz', 'font: 40px KernArimo'],
    ['a word-spacing span', pairs('style="word-spacing: 2px"'), 'zz', 'font: 40px KernArimo'],
    ['a line end after an element edge', 'ab <span style="color: red">glory</span> cd', 'cd', 'font: 40px KernPlayfair'],
  ])('across %s', (_, html, word, style) => expectThreshold(html, style, word));
});

describe('a word starting a line has no kern from the text before the break', () => {
  // Chrome shapes a line's first word alone: Arimo " A" -2.21px, " T" -0.72px and "A&shy;V"
  // -2.97px, Merriweather "-t" -2.66px at 40px. A first word wider than any probe puts the
  // word at the start of line 2.
  const wide = 'm'.repeat(30);
  it.each([
    ['Axx', `${wide} Axx zz`, 'KernArimo'],
    ['Txx', `${wide} Txx zz`, 'KernArimo'],
    ['txx after a hyphen', `${wide}-txx zz`, 'KernMerriweather'],
    ['Vxx after a soft hyphen', `${wide}A&shy;Vxx zz`, 'KernArimo'],
  ])('a line starting with "%s"', (start, html, family) => {
    expectThreshold(html, `font: 40px ${family}`, 'zz', start.split(' ')[0]);
  });
});

describe('overflow-wrap: a word too wide for any line', () => {
  // Every engine breaks it where it stops fitting, before its comma too.
  it.each(['overflow-wrap: break-word', 'overflow-wrap: anywhere', 'word-break: break-word'])(
    'breaks before its trailing comma under %s', (style) => {
      const width = extractDomBoxes('<span>aaaa</span>', `span { ${STYLE} }`, 600, 'span')[0].width + 2;
      const text = 'aa aaaa, bb';
      const dom = extractDomLines(`<p>${text}</p>`, `p { ${STYLE}; ${style} }`, width).map((line) => line.text.trim());
      expect(dom).toContain('aaaa');
      const canvas = layout({ html: `<p style="${STYLE}; ${style}">${text}</p>`, width }).lines.map((line) => line.text.trim());
      expect(canvas).toEqual(dom);
    });
});
