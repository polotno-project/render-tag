/**
 * Where a run starts and ends next to a kerned pair, against Chrome's DOM. A pair's kern
 * belongs to its first glyph (HarfBuzz, every DOM), so the run after the pair starts that much
 * sooner; runs painted one by one (Gecko, WebKit, vector consumers) need that placement.
 * Vendored fonts at 100px, where a kern is several px; a 1px tolerance.
 *
 *   npx vitest run --project chromium tests/kern-placement-parity.test.ts
 */
import { beforeAll, expect, it } from 'vitest';
import { layout } from '../src/index.ts';
import { collectTexts } from './helpers/layout-tree.ts';
import arimo from './fonts/arimo/arimo-latin-wght-normal.woff2?url';
import playfair from './fonts/playfair-display/playfair-display-latin-wght-normal.woff2?url';
import merriweather from './fonts/merriweather/merriweather-latin-wght-normal.woff2?url';
import robotoLatin from './fonts/roboto/roboto-latin-wght-normal.woff2?url';
import robotoCyrillic from './fonts/roboto/roboto-cyrillic-wght-normal.woff2?url';
import notoJapanese from './fonts/noto-sans-jp/noto-sans-jp-119-400-normal.woff2?url';

const TOLERANCE = 1;

beforeAll(async () => {
  document.fonts.add(await new FontFace('PlaceArimo', `url(${arimo})`, { weight: '100 900' }).load());
  document.fonts.add(await new FontFace('PlacePlayfair', `url(${playfair})`, { weight: '100 900' }).load());
  document.fonts.add(await new FontFace('PlaceMerriweather', `url(${merriweather})`, { weight: '100 900' }).load());
  document.fonts.add(await new FontFace('PlaceRoboto', `url(${robotoLatin})`, { weight: '100 900', unicodeRange: 'U+0000-00FF' }).load());
  document.fonts.add(await new FontFace('PlaceRoboto', `url(${robotoCyrillic})`, { weight: '100 900', unicodeRange: 'U+0400-045F' }).load());
  // Hiragana.
  document.fonts.add(await new FontFace('PlaceNotoJapanese', `url(${notoJapanese})`).load());
});

/** `word`'s left and right edges in the DOM, from its text node's Range rect. */
function domEdges(html: string, style: string, word: string): [number, number] {
  const p = document.createElement('p');
  p.style.cssText = `${style}; margin: 0; width: 2000px`;
  p.innerHTML = html;
  document.body.append(p);
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let edges: [number, number] = [NaN, NaN];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const at = node.data.indexOf(word);
    if (at < 0) continue;
    range.setStart(node, at);
    range.setEnd(node, at + word.length);
    const rect = range.getBoundingClientRect();
    const left = p.getBoundingClientRect().left;
    edges = [rect.left - left, rect.right - left];
    break;
  }
  p.remove();
  return edges;
}

function canvasEdges(html: string, style: string, word: string): [number, number] {
  const texts = collectTexts(layout({ html: `<p style="${style}; margin: 0">${html}</p>`, width: 2000 }).layoutRoot);
  const run = texts.find((text) => text.text === word);
  return run ? [run.x, run.x + run.width] : [NaN, NaN];
}

it.each([
  // Arimo " A" -5.5px: Chrome and Firefox kern it, WebKit never kerns a space.
  ['a word after a kerned space', 'aa Axx', 'Axx', 'font: 100px PlaceArimo'],
  // Arimo "AV" -7.4px across a colour span (`continuesShaping`).
  ['a run across an element edge', 'A<span style="color: red">V</span>x', 'V', 'font: 100px PlaceArimo'],
  // Playfair "y " -2.6px, in every engine.
  ['a word before a kerned space', 'ab glory cd', 'glory', 'font: 100px PlacePlayfair'],
  // Chrome kerns across a break opportunity: Merriweather "-t" -6.7px, Arimo "AV" -7.4px.
  ['a piece after a hyphen', 'text-top', 'top', 'font: 100px PlaceMerriweather'],
  ['a part after a soft hyphen', 'A&shy;V', 'V', 'font: 100px PlaceArimo'],
  // And across a zero-width space.
  ['a part after a zero-width space', 'A&#8203;Vx', 'Vx', 'font: 100px PlaceArimo'],
  // No kern joins a space to a word of another script: the space shapes with the script
  // before it (UAX #24), a closing bracket with its opener's. Arimo " A" -5.5px, Roboto " T"
  // -1.95px.
  ['a Latin word after a Japanese one', 'こんにちは Axx', 'Axx', 'font: 100px PlaceArimo, PlaceNotoJapanese'],
  ['a Latin word after a Cyrillic one', 'Привет Tokyo', 'Tokyo', 'font: 100px PlaceRoboto'],
  ['a Latin word after a bracket opened in Cyrillic', 'Привет (aa) Tokyo', 'Tokyo', 'font: 100px PlaceRoboto'],
  ['a Latin word after a bracket closed around Cyrillic', 'aa (Привет) Tokyo', 'Tokyo', 'font: 100px PlaceRoboto'],
])('%s', (name, html, word, style) => {
  const [domLeft, domRight] = domEdges(html, style, word);
  const [left, right] = canvasEdges(html, style, word);
  const within = Math.abs(left - domLeft) < TOLERANCE && Math.abs(right - domRight) < TOLERANCE;
  expect(within, `left ${left.toFixed(2)} vs DOM ${domLeft.toFixed(2)}, right ${right.toFixed(2)} vs DOM ${domRight.toFixed(2)}`).toBe(true);
});
