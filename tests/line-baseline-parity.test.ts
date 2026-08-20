/**
 * Where the baseline sits inside a line box.
 *
 * The CSS half-leading is `(lineHeight - (ascent + descent)) / 2`, and the
 * baseline sits that far below the line top, plus the ascent. Blink does not
 * use that value directly: `FontHeight::AddLeading` FLOORS it to a whole CSS
 * pixel, so Chrome's DOM text sits up to 1px HIGHER than the exact value.
 * Gecko and WebKit lay the exact value out instead.
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
import { FLOORS_LINE_BASELINE } from '../src/layout.ts';
import { collectTexts } from './helpers/layout-tree.ts';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isWebKit = ua.includes('AppleWebKit') && !ua.includes('Chrome');

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
  // Blink floors half-leading + ascent onto a whole pixel; Gecko and WebKit
  // keep the exact value. render-tag follows the engine it runs on, so the
  // canvas sits on the baseline that engine's own DOM would use.
  it.each(CASES)(
    'places the baseline the way this engine does at $size px / $lineHeight',
    ({ size, lineHeight }) => {
      const lineHeightPx = size * lineHeight;
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${size}px ${FONT}`;
      const m = ctx.measureText('M');
      const exact =
        (lineHeightPx - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 +
        m.fontBoundingBoxAscent;

      expect(canvasBaseline(size, lineHeightPx)).toBeCloseTo(
        FLOORS_LINE_BASELINE ? Math.floor(exact) : exact,
        2,
      );
    },
  );

  // Chrome and Firefox place their DOM baseline on a rule we can state
  // exactly, so both assert parity against their own DOM. WebKit is excluded:
  // Safari's canvas metrics disagree with its own layout metrics (a 30px/1
  // line lands at 25.59375 in the DOM against 25.5 from the canvas), so no
  // rounding rule stated in canvas terms can reach its DOM. The exact value is
  // still the closest branch — see FLOORS_LINE_BASELINE for the corpus
  // measurement that picked it.
  it.runIf(!isWebKit).each(CASES)(
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
