/**
 * background-clip: text gradients declared on an INLINE element must reach text
 * held by a nested inline child.
 *
 * `background-image`/`background-clip` don't inherit, and inline elements are
 * flattened into text runs — so when the gradient is declared on an inline
 * element (<s>, <span>) but the actual text lives one level deeper in another
 * inline (<u>, <span>…), the run carried neither the gradient nor the clip and
 * `-webkit-text-fill-color: transparent` (which DOES inherit) painted nothing:
 * the whole gradient-clipped, underlined, struck-through fragment vanished.
 *
 * The gradient geometry spans the declaring inline element's fragment box
 * (mirrors how a block clip box spans its element), threaded onto every run it
 * covers.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';
import { countPixels, isAny, isGreenish, isReddish } from './helpers/pixels.ts';

// The exact fragment reported by the user.
const BUG_HTML =
  '<ol><li>He<s style="background-image: linear-gradient(0deg, rgb(194, 28, 28) 0%, rgb(142, 255, 12) 100%); background-size: 100% 100%; background-clip: text; -webkit-text-fill-color: transparent; color: rgb(194, 28, 28);"><u>ader</u></s></li></ol>';

describe('background-clip: text gradient declared on an inline element, text in a nested inline', () => {
  it('paints the gradient text held by a nested <u> inside a clipped <s>', () => {
    const { canvas } = render({ html: BUG_HTML, width: 300, pixelRatio: 1 });
    // Something visible at all (regression: nothing was painted).
    expect(countPixels(canvas, isAny)).toBeGreaterThan(50);
    // Both ends of the vertical gradient show through the glyphs + decorations.
    expect(countPixels(canvas, isReddish)).toBeGreaterThan(20);
    expect(countPixels(canvas, isGreenish)).toBeGreaterThan(20);
  });

  it('still paints when overflow-wrap:break-word splits the clipped fragment across lines', () => {
    // The reported bug: at a wide width (one line) the gradient shows, but a
    // narrower box wraps "Header" mid-word (overflow-wrap:break-word, as the
    // editor sets), splitting the clipped <s><u>ader</u></s> fragment across
    // lines. The break-word char-flattening rebuilt words WITHOUT the clip
    // declarer, so the inherited transparent fill had no clip box and the
    // whole fragment painted nothing (red=green=0).
    const wrapped =
      '<div style="font-size:76px;font-family:Arial;white-space:pre-wrap;overflow-wrap:break-word">' +
      BUG_HTML +
      '</div>';
    for (const width of [341, 250, 180]) {
      const { canvas } = render({ html: wrapped, width, pixelRatio: 1 });
      expect(countPixels(canvas, isReddish)).toBeGreaterThan(20);
      expect(countPixels(canvas, isGreenish)).toBeGreaterThan(20);
    }
  });

  it('minimal <span>-in-<span> nesting paints the gradient too', () => {
    const html =
      '<div style="font-size: 40px; background-image: linear-gradient(90deg, red, blue); ' +
      '-webkit-background-clip: text; -webkit-text-fill-color: transparent;">' +
      '<span><span>Nested</span></span></div>';
    const { canvas } = render({ html, width: 400, pixelRatio: 1 });
    expect(countPixels(canvas, isAny)).toBeGreaterThan(50);
  });
});
