/**
 * Where the baseline sits inside a line box.
 *
 * The CSS half-leading is `(lineHeight - (ascent + descent)) / 2`, and the
 * baseline sits that far below the line top, plus the ascent. Blink does not
 * use that value directly: `FontHeight::AddLeading` FLOORS it to a whole CSS
 * pixel, so Chrome's DOM text sits up to 1px HIGHER than the exact value.
 * WebKit floors it too, and lays the line out at a whole-pixel line-height
 * besides (`TRUNCATES_LINE_HEIGHT`): 16px x 1.6 is a 25px line there, so the
 * exact value drifts 0.6px further off with every line. Gecko keeps both the
 * exact half-leading and the exact line-height.
 *
 * render-tag kept the exact value everywhere, so canvas text stood up to 1px
 * BELOW the same HTML in Chrome — a fraction of a pixel per line, plainly
 * visible when text sits on a rule.
 *
 * `lines[].y` is rounded, so these tests read the baseline off the layout tree,
 * which carries it unrounded.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import { FLOORS_LINE_BASELINE, TRUNCATES_LINE_HEIGHT } from '../src/layout.ts';
import { collectTexts } from './helpers/layout-tree.ts';

const FONT = 'sans-serif';
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
  // Blink and WebKit floor half-leading + ascent onto a whole pixel, WebKit
  // over a line-height it has already truncated; Gecko keeps the exact value.
  // render-tag follows the engine it runs on, so the canvas sits on the
  // baseline that engine's own DOM would use.
  it.each(CASES)(
    'places the baseline the way this engine does at $size px / $lineHeight',
    ({ size, lineHeight }) => {
      const lineHeightPx = size * lineHeight;
      const used = TRUNCATES_LINE_HEIGHT ? Math.floor(Math.fround(lineHeightPx)) : lineHeightPx;
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${size}px ${FONT}`;
      const m = ctx.measureText('M');
      const exact =
        (used - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 +
        m.fontBoundingBoxAscent;

      expect(canvasBaseline(size, lineHeightPx)).toBeCloseTo(
        FLOORS_LINE_BASELINE ? Math.floor(exact) : exact,
        2,
      );
    },
  );

  // Every engine places its DOM baseline on a rule stated in canvas terms, so
  // each asserts parity against its own DOM. (An older note excluded WebKit
  // because a 30px/1 line landed at 25.59375 in its DOM against 25.5 from the
  // canvas; Playwright WebKit lays every baseline here on a whole pixel, with
  // integer canvas metrics, so the floored rule reaches it exactly. Branded
  // Safari is not re-measured.)
  it.each(CASES)(
    'lands on the DOM baseline at $size px / $lineHeight',
    ({ size, lineHeight }) => {
      const font = `${size}px ${FONT}`;
      const lineHeightPx = size * lineHeight;

      expect(canvasBaseline(size, lineHeightPx)).toBeCloseTo(
        domBaseline(font, lineHeightPx),
        2,
      );
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
  // The baseline of line N is where the line-height ROUNDING compounds: WebKit
  // steps 25px per 16px x 1.6 line, so the exact 25.6 lands 0.6px lower on
  // every line — the single largest WebKit pixel residual over the corpus.
  // Unitless, length, percentage and em values; fractional font sizes; and a
  // product (20 x 1.15) that is a hair under 23 in double but 23 in WebKit's
  // float32. Blink keeps the line-height on its 1/64px LayoutUnit grid,
  // rounded down (25.6 -> 25.59375; LAYOUT_UNIT_LINE_HEIGHT): sub-pixel, but
  // it compounds, and once Blink's paint rounds every line top
  // (SNAPS_LINE_PAINT) 45 lines of it move a line by a whole pixel. So the
  // match is exact, not within a LayoutUnit per line.
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
    // WebKit floors the font-size to 1/64px BEFORE it multiplies: 13.6 x 1.25
    // is a 16px line there, not 17 (floor(fround(13.6 x 1.25)) = 17).
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
    canvas.forEach((y, i) => {
      expect(Math.abs(y - dom[i]), `line ${i}: canvas ${y}, DOM ${dom[i]}`)
        .toBeLessThanOrEqual(0.001);
    });
  });
});

describe('vertical-align: middle', () => {
  // CSS 2.1 centres the BOX — its leaded box, half-leading included — on the
  // parent baseline plus half an x-height. Blink and WebKit floor the
  // half-leading, so the content area's midpoint (what render-tag used) sits
  // up to 0.5px off the leaded one: 34.0 against a DOM 34.70 here, in both.
  // The 0.25 left is the x-height, approximated as 0.5em.
  it.each([
    { block: 'font-size:18px;line-height:2', inner: 'Icon <span style="vertical-align:middle;font-size:30px">M</span> mid' },
    { block: 'font-size:16px;line-height:1.6', inner: 'a <span style="vertical-align:middle;font-size:25px">M</span>' },
  ])('lands the line baseline on the DOM\'s ($inner)', ({ block, inner }) => {
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
    expect(Math.abs(texts[0].y - dom)).toBeLessThanOrEqual(0.25);
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
