/**
 * Gradient text stroke via the render-tag-only `-webkit-text-stroke-image`.
 *
 * CSS can't put a gradient on a text stroke, so callers hand render-tag the
 * gradient through this property; render-tag builds a CanvasGradient spanning
 * the declaring element (same as a background-clip:text fill gradient) and uses
 * it as the stroke paint. The fill stays whatever `color` says — so a white
 * glyph with a gradient outline keeps its white interior (the bug this fixes
 * used to fill the whole glyph with the stroke gradient and drop the fill).
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';
import { countPixels, isMagenta, isWhite } from './helpers/pixels.ts';

describe('gradient text stroke (-webkit-text-stroke-image)', () => {
  const base =
    'font-size: 64px; line-height: 1.4; color: rgb(255, 255, 255); ' +
    '-webkit-text-stroke: 6px black; paint-order: stroke fill';

  it('strokes with the gradient and keeps the solid fill', () => {
    const grad =
      '--rt-text-stroke-image: linear-gradient(0deg, black 0%, rgb(212, 0, 255) 100%)';
    const { canvas } = render({
      html: `<div style="${base}; ${grad}">AB</div>`,
      width: 300,
      pixelRatio: 1,
    });
    // white fill interior is preserved (the whole-glyph-gradient bug erased it)
    expect(countPixels(canvas, isWhite)).toBeGreaterThan(50);
    // the stroke shows the gradient's magenta end — proving it's a gradient
    // stroke, not the solid black `-webkit-text-stroke` color
    expect(countPixels(canvas, isMagenta)).toBeGreaterThan(20);
  });

  it('solid stroke (no stroke-image) shows no gradient color', () => {
    const { canvas } = render({
      html: `<div style="${base}">AB</div>`,
      width: 300,
      pixelRatio: 1,
    });
    expect(countPixels(canvas, isWhite)).toBeGreaterThan(50);
    expect(countPixels(canvas, isMagenta)).toBe(0);
  });

  it('threads the stroke gradient through block children (<li>)', () => {
    const grad =
      '--rt-text-stroke-image: linear-gradient(0deg, black 0%, rgb(212, 0, 255) 100%)';
    const { canvas } = render({
      html: `<div style="${base}; ${grad}"><ul><li>AB</li></ul></div>`,
      width: 300,
      pixelRatio: 1,
    });
    expect(countPixels(canvas, isWhite)).toBeGreaterThan(50);
    expect(countPixels(canvas, isMagenta)).toBeGreaterThan(20);
  });

  it('keeps the stroke gradient when break-word splits the fragment mid-word', () => {
    // Same fix as the background-clip:text break-word case: the stroke-image
    // declarer must survive the mid-word char-flatten. Declared on an inline
    // <s> holding part of a word that overflow-wrap:break-word splits across
    // lines — without the fix the split pieces revert to the solid black
    // -webkit-text-stroke and the gradient's magenta end vanishes.
    const grad =
      '--rt-text-stroke-image: linear-gradient(0deg, black 0%, rgb(212, 0, 255) 100%)';
    const wrap =
      'font-size:76px;font-family:Arial;white-space:pre-wrap;overflow-wrap:break-word;color:rgb(255,255,255)';
    for (const width of [220, 150]) {
      const { canvas } = render({
        html:
          `<div style="${wrap}">He` +
          `<s style="${grad}; -webkit-text-stroke:6px black; paint-order: stroke fill">ader</s></div>`,
        width,
        pixelRatio: 1,
      });
      expect(countPixels(canvas, isMagenta)).toBeGreaterThan(20);
    }
  });
});
