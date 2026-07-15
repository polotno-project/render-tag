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

interface Rect { x: number; y: number; w: number; h: number; }

function countPixels(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number) => boolean,
  rect?: Rect,
): number {
  const ctx = canvas.getContext('2d')!;
  const { x, y, w, h } = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const data = ctx.getImageData(x, y, w, h).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

const isReddish = (r: number, g: number, b: number) => r > 130 && g < 110 && b < 110;
const isGreenish = (r: number, g: number, b: number) => g > 150 && b < 120;
const isAny = () => true;

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

  it('minimal <span>-in-<span> nesting paints the gradient too', () => {
    const html =
      '<div style="font-size: 40px; background-image: linear-gradient(90deg, red, blue); ' +
      '-webkit-background-clip: text; -webkit-text-fill-color: transparent;">' +
      '<span><span>Nested</span></span></div>';
    const { canvas } = render({ html, width: 400, pixelRatio: 1 });
    expect(countPixels(canvas, isAny)).toBeGreaterThan(50);
  });
});
