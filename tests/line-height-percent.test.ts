/**
 * Percentage line-height parsing.
 *
 * Before the fix, "line-height: 120%" fell into the unitless branch of the
 * css-resolver: parseFloat("120%") = 120, i.e. a 120x multiplier. A single
 * 20px line measured 2400px tall, which drove polotno's font-fitting loop
 * into an infinite shrink cycle (fontSize collapsed to the model minimum
 * and the export hung forever).
 *
 * Per CSS, `line-height: <percentage>` computes against the element's own
 * font-size and children inherit the COMPUTED value (like px/em), not the
 * ratio (unlike unitless).
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';

const FONT = 'Arial, sans-serif';

describe('line-height: <percentage>', () => {
  it('120% equals unitless 1.2 for a single element', () => {
    const percent = layout({
      html: `<div style="font-family: ${FONT}; font-size: 20px; line-height: 120%;">hello</div>`,
      width: 300,
    });
    const unitless = layout({
      html: `<div style="font-family: ${FONT}; font-size: 20px; line-height: 1.2;">hello</div>`,
      width: 300,
    });
    expect(percent.height).toBeCloseTo(unitless.height, 1);
    // regression guard: one 20px line must be ~24px, not ~2400px
    expect(percent.height).toBeLessThan(100);
  });

  it('children inherit the computed value, not the ratio', () => {
    // Parent: 20px font, 120% => computed 24px, inherited as 24px.
    // The child span's bigger font must NOT scale it (unitless 1.2 would
    // recompute to 1.2 * 40 = 48px).
    const percent = layout({
      html: `<div style="font-family: ${FONT}; font-size: 20px; line-height: 120%;"><span style="font-size: 40px;">hello</span></div>`,
      width: 300,
    });
    const unitless = layout({
      html: `<div style="font-family: ${FONT}; font-size: 20px; line-height: 1.2;"><span style="font-size: 40px;">hello</span></div>`,
      width: 300,
    });
    expect(percent.height).toBeLessThan(unitless.height);
  });
});
