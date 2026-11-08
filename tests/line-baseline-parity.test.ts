/**
 * Where the baseline sits inside a line box.
 *
 * The CSS half-leading is `(lineHeight - (ascent + descent)) / 2`, and the
 * baseline sits that far below the line top, plus the ascent. Blink does not
 * use that value directly: `FontHeight::AddLeading` FLOORS it to a whole CSS
 * pixel, so Chrome's DOM text sits up to 1px HIGHER than the exact value.
 * render-tag places it so in every browser (README: one layout, Chrome's); the
 * DOM cases gate Chrome.
 *
 * `lines[].y` is rounded, so these tests read the baseline off the layout tree,
 * which carries it unrounded.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import { collectTexts } from './helpers/layout-tree.ts';

const FONT = 'sans-serif';
const DOM_TOLERANCE = 0.001;
// Sizes and ratios chosen so the exact baseline lands on whole, half and
// arbitrary fractions of a pixel — a rule that only floors integers proves
// nothing.
const CASES = [
  { size: 30, lineHeight: 1 },
  { size: 30, lineHeight: 1.2 },
  { size: 30, lineHeight: 2.1 },
  { size: 12.5, lineHeight: 1.15 },
  { size: 21, lineHeight: 1.37 },
  { size: 120, lineHeight: 1.15 },
];

/** Baseline of the first line, measured in the real DOM. */
function domBaseline(font: string, lineHeightPx: number): number {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    `position:absolute;left:-9999px;top:0;font:${font};line-height:${lineHeightPx}px;`;
  // A zero-height inline-block on the baseline: its top edge IS the baseline.
  wrap.innerHTML =
    '<span>Hxg</span>' +
    '<span class="probe" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
  document.body.appendChild(wrap);
  const top = wrap.getBoundingClientRect().top;
  const probe = wrap.querySelector('.probe') as HTMLElement;
  const baseline = probe.getBoundingClientRect().top - top;
  wrap.remove();
  return baseline;
}

/** Baseline of the first line, as render-tag lays it out. */
function canvasBaseline(size: number, lineHeightPx: number): number {
  // Longhands, not the `font` shorthand: the CSS resolver reads the longhands.
  const html =
    `<div style="margin:0;padding:0;font-size:${size}px;font-family:${FONT};` +
    `line-height:${lineHeightPx}px">Hxg</div>`;
  const texts = collectTexts(layout({ html, width: 400 }).layoutRoot);
  expect(texts.length).toBeGreaterThan(0);
  return texts[0].y;
}

describe('line-box baseline', () => {
  it.each(CASES)(
    'lands on the DOM baseline at $size px / $lineHeight',
    ({ size, lineHeight }) => {
      const font = `${size}px ${FONT}`;
      const lineHeightPx = size * lineHeight;
      const canvas = canvasBaseline(size, lineHeightPx);
      const dom = domBaseline(font, lineHeightPx);
      expect(Math.abs(canvas - dom), `canvas ${canvas}, DOM ${dom}`).toBeLessThanOrEqual(0.005);
    },
  );
});

/** Baseline of each of `lines` forced lines, measured in the real DOM. */
function domBaselines(size: number, lineHeight: string, lines: number, family = FONT): number[] {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    `position:absolute;left:-9999px;top:0;font-family:${family};font-size:${size}px;` +
    `line-height:${lineHeight};`;
  const probe =
    '<span class="probe" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
  wrap.innerHTML = Array.from({ length: lines }, () => `Hxg${probe}`).join('<br>');
  document.body.appendChild(wrap);
  const top = wrap.getBoundingClientRect().top;
  const baselines = [...wrap.querySelectorAll('.probe')]
    .map((p) => p.getBoundingClientRect().top - top);
  wrap.remove();
  return baselines;
}

describe('line pitch', () => {
  // The baseline of line N is where the line-height ROUNDING compounds.
  // Unitless, length, percentage and em values; fractional font sizes; and a
  // product (20 x 1.15) that is a hair under 23 in double. Blink keeps the
  // line-height on its 1/64px LayoutUnit grid, rounded down (25.6 -> 25.59375;
  // `multipliedLineHeight`): sub-pixel, but it compounds, and once Blink's
  // paint rounds every line top (`paintLineSnap`) 45 lines of it move a line
  // by a whole pixel. So the match is exact, not within a LayoutUnit per line.
  const LINES = 6;
  it.each([
    { size: 16, lineHeight: '1.6' },
    { size: 16, lineHeight: '1.4' },
    { size: 16, lineHeight: '1.8' },
    { size: 16, lineHeight: '25.6px' },
    { size: 16, lineHeight: '133%' },
    { size: 16, lineHeight: '1.3em' },
    { size: 20, lineHeight: '1.15' },
    { size: 17.3, lineHeight: '1.37' },
    { size: 12.5, lineHeight: '1.7' },
    { size: 44, lineHeight: '1.15' },
    { size: 13.6, lineHeight: '1.25' },
    { size: 17.3, lineHeight: '1.85' },
    { size: 8.7, lineHeight: '1.15' },
    // A percentage is an INTEGER percentage in Blink and WebKit: 162.9% acts
    // as 162%, and 133.3% as 133%.
    { size: 16, lineHeight: '133.3%' },
    { size: 8, lineHeight: '162.5%' },
    { size: 13.33, lineHeight: '133.3%' },
    { size: 16, lineHeight: '162.9%' },
    { size: 30.8, lineHeight: '133.3%', family: 'Georgia' },
    { size: 30.8, lineHeight: '162.5%', family: 'Georgia' },
    // Blink halves a NEGATIVE leading in LayoutUnits, truncating toward zero,
    // and only then floors: an odd number of 64ths short puts the baseline
    // 1px lower than flooring the exact half.
    { size: 13.6, lineHeight: '1.25', family: 'Verdana' },
    { size: 33.9, lineHeight: '1.15' },
    { size: 38.1, lineHeight: '1.05' },
    { size: 18.1, lineHeight: '21.99px', family: 'Verdana' },
    { size: 13.33, lineHeight: '1.2', family: 'Verdana' },
  ])('lands every line on the DOM baseline at $size px / $lineHeight $family', ({ size, lineHeight, family = FONT }) => {
    const html =
      `<div style="margin:0;padding:0;font-size:${size}px;font-family:${family};` +
      `line-height:${lineHeight}">${Array.from({ length: LINES }, () => 'Hxg').join('<br>')}</div>`;
    const canvas = collectTexts(layout({ html, width: 400 }).layoutRoot)
      .filter((t) => t.text.trim())
      .map((t) => t.y);
    const dom = domBaselines(size, lineHeight, LINES, family);
    expect(canvas).toHaveLength(LINES);
    const off = canvas.flatMap((y, i) =>
      Math.abs(y - dom[i]) <= DOM_TOLERANCE ? [] : [`line ${i}: canvas ${y}, DOM ${dom[i]}`]);
    expect(off).toEqual([]);
  });
});

describe('vertical-align: middle', () => {
  // CSS 2.1 centres the BOX — its leaded box, half-leading included — on the
  // parent baseline plus half an x-height. Blink and WebKit floor the
  // half-leading, so the content area's midpoint (what render-tag used) sits
  // up to 0.5px off the leaded one: 34.0 against a DOM 34.70 here, in both.
  // The 0.25 left is the x-height, approximated as 0.5em.
  it.each([
    { name: '30px in 18px/2', block: 'font-size:18px;line-height:2', inner: 'Icon <span style="vertical-align:middle;font-size:30px">M</span> mid' },
    { name: '25px in 16px/1.6', block: 'font-size:16px;line-height:1.6', inner: 'a <span style="vertical-align:middle;font-size:25px">M</span>' },
  ])('lands the line baseline on the DOM\'s ($name)', ({ name, block, inner }) => {
    const style = `margin:0;padding:0;font-family:${FONT};${block}`;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
    wrap.innerHTML =
      `<div style="${style}"><span class="probe" style="display:inline-block;width:0;height:0"></span>${inner}</div>`;
    document.body.appendChild(wrap);
    const dom = wrap.querySelector('.probe')!.getBoundingClientRect().top -
      wrap.getBoundingClientRect().top;
    wrap.remove();
    const texts = collectTexts(layout({ html: `<div style="${style}">${inner}</div>`, width: 600 }).layoutRoot);
    expect(Math.abs(texts[0].y - dom), `canvas ${texts[0].y}, DOM ${dom}`).toBeLessThanOrEqual(0.25);
  });
});


describe('block strut baseline', () => {
  // The strut is a BASELINE participant, not only a height floor: a smaller
  // inline sits on the block-font baseline (lower in the taller line box),
  // not centered in it. This needs real font metrics (they must scale with
  // font-size — the mock ctx returns a fixed ascent/descent), so it runs the
  // full layout() with a system font, here rather than with the mocked
  // strut cases in tests/node/layout-logic.test.ts. Guards the
  // strut seed in `lineBoxExtent` (`leadedBox(blockStyle)`); without it the small glyph rides ~12px
  // too high.
  it('aligns smaller-only inline text to the block-font baseline (real fonts)', () => {
    const baselineOf = (html: string): number => {
      const res = layout({
        html: `<div style="font-family:Arial;font-size:76px;line-height:1.2">${html}</div>`,
        width: 600,
      });
      // LayoutText.y is the baseline.
      return collectTexts(res.layoutRoot).find((t) => t.text === 'x')!.y;
    };
    // A 42px span and a full-size 76px glyph share the same strut baseline.
    const small = baselineOf('<span style="font-size:42px">x</span>');
    const full = baselineOf('x');
    expect(Math.abs(small - full)).toBeLessThan(1.5);
  });
});
