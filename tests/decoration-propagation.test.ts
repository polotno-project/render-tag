/**
 * Text-decoration propagation fidelity (Chrome-verified behavior).
 *
 * In CSS, text-decoration is not inherited — the DECLARING element paints the
 * line across its in-flow descendants with the declaring element's own
 * color/style. Three consequences this suite locks down (each verified against
 * Chrome via foreignObject rasterization before being encoded here):
 *
 * 1. An ancestor's explicit `text-decoration-color` must survive into text
 *    sitting inside block children (<p>, <li>). The resolver used to merge
 *    only the decoration LINE into descendants while the color fell back to
 *    the descendant's currentColor.
 * 2. Each decoration paints with its ORIGIN's color: a parent's red underline
 *    stays red across a blue child <s>, whose strike is blue.
 * 3. When no explicit decoration color is set, Chrome paints decorations with
 *    `-webkit-text-fill-color` (not `color`). With fill-color transparent
 *    inside a `background-clip: text` gradient element, the clipped gradient
 *    shows through the decoration band — so the decoration must be painted
 *    with the gradient.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';

function countColoredPixels(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    if (r > 240 && g > 240 && b > 240) continue;
    if (predicate(r, g, b)) count++;
  }
  return count;
}

const isRed = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100;
const isBlue = (r: number, g: number, b: number) => b > 150 && r < 100;

describe('decoration color propagation across block children', () => {
  it('ancestor explicit deco color reaches text inside <p>', () => {
    const html = `<div style="font-size: 24px; line-height: 2; color: rgb(40, 40, 40); text-decoration: underline; text-decoration-color: rgb(231, 76, 60);"><p>Underlined</p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countColoredPixels(canvas, isRed)).toBeGreaterThan(10);
  });

  it('ancestor explicit deco color reaches text inside <li>', () => {
    const html = `<div style="font-size: 24px; line-height: 2; color: rgb(40, 40, 40); text-decoration: underline; text-decoration-color: rgb(231, 76, 60);"><ol><li>Item</li></ol></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countColoredPixels(canvas, isRed)).toBeGreaterThan(10);
  });

  it('compound: parent red underline stays red across blue child <s>', () => {
    const html = `<div style="font-size: 24px; line-height: 2; color: rgb(40, 40, 40); text-decoration: underline; text-decoration-color: rgb(231, 76, 60);"><p><span style="color: rgb(52, 152, 219);"><s>Strike</s></span></p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    // parent's underline: red; child glyphs + own strike: blue
    expect(countColoredPixels(canvas, isRed)).toBeGreaterThan(10);
    expect(countColoredPixels(canvas, isBlue)).toBeGreaterThan(50);
  });
});

describe('decoration auto color follows -webkit-text-fill-color', () => {
  it('paints deco with fill-color, not color, when no explicit deco color', () => {
    const html = `<div style="font-size: 24px; line-height: 2; color: rgb(231, 76, 60); -webkit-text-fill-color: rgb(52, 152, 219);"><u>Filled</u></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    // Chrome: glyphs AND underline are blue; nothing red.
    expect(countColoredPixels(canvas, isRed)).toBe(0);
    expect(countColoredPixels(canvas, isBlue)).toBeGreaterThan(50);
  });

  it('transparent fill-color makes deco invisible too', () => {
    const html = `<div style="font-size: 24px; line-height: 2; color: rgb(231, 76, 60); -webkit-text-fill-color: transparent;"><u>Ghost</u></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countColoredPixels(canvas, () => true)).toBe(0);
  });
});

describe('decorations inside background-clip: text gradient', () => {
  const GRAD = `background-image: linear-gradient(90deg, rgb(52, 152, 219) 0%, rgb(52, 152, 219) 100%); background-size: 100% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent`;

  it('selection-level <u> paints the gradient in the decoration band', () => {
    const base = `<div style="font-size: 24px; line-height: 2; ${GRAD}"><p>AABB</p></div>`;
    const withU = `<div style="font-size: 24px; line-height: 2; ${GRAD}"><p>AA<u>BB</u></p></div>`;
    const basePixels = countColoredPixels(
      render({ html: base, width: 300, pixelRatio: 1 }).canvas,
      isBlue,
    );
    const withUPixels = countColoredPixels(
      render({ html: withU, width: 300, pixelRatio: 1 }).canvas,
      isBlue,
    );
    // the underline band adds gradient pixels beyond the glyphs
    expect(withUPixels).toBeGreaterThan(basePixels + 30);
  });

  it('element-level underline with explicit deco color is visible (polotno getHtml shape)', () => {
    const html = `<div style="font-size: 24px; line-height: 2; ${GRAD}; text-decoration: underline; text-decoration-color: rgb(231, 76, 60);"><p>AABB</p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countColoredPixels(canvas, isRed)).toBeGreaterThan(10);
  });

  it('gradient band continues over a run with an opaque own fill', () => {
    // Chrome clips the ancestor's background to the decoration band no matter
    // what the run's own glyph fill is: a solid-colored span inside a
    // gradient element still gets the (gradient) underline across it. The
    // painter must not skip transparent decoration entries just because the
    // run itself isn't gradient-filled.
    const html = `<div style="font-size: 24px; line-height: 2; ${GRAD}; text-decoration: underline;"><p><span style="color: rgb(0, 200, 0); -webkit-text-fill-color: currentcolor;">GGGG</span></p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    // glyphs are green; the underline band under them must paint the
    // gradient (blue), not vanish
    expect(
      countColoredPixels(canvas, (r, g, b) => g > 150 && r < 100 && b < 100),
    ).toBeGreaterThan(50); // glyphs
    expect(countColoredPixels(canvas, isBlue)).toBeGreaterThan(30); // band
  });
});

describe('decorations under -webkit-text-stroke', () => {
  it('the decoration band is stroked like the glyphs', () => {
    // Chrome strokes text decorations with -webkit-text-stroke (measured:
    // red text + 3px blue stroke + underline adds ONLY blue pixels — the
    // stroke swallows the thin band). The band must gain stroke-colored
    // edges, not stay purely decoration-colored.
    const base = `<div style="font-size: 40px; line-height: 2; color: rgb(231, 76, 60); -webkit-text-stroke: 3px rgb(52, 152, 219);">ABCD</div>`;
    const withDeco = `<div style="font-size: 40px; line-height: 2; color: rgb(231, 76, 60); -webkit-text-stroke: 3px rgb(52, 152, 219); text-decoration: underline;">ABCD</div>`;
    const bluesBase = countColoredPixels(
      render({ html: base, width: 320, pixelRatio: 1 }).canvas,
      isBlue,
    );
    const bluesDeco = countColoredPixels(
      render({ html: withDeco, width: 320, pixelRatio: 1 }).canvas,
      isBlue,
    );
    expect(bluesDeco).toBeGreaterThan(bluesBase + 200);
  });
});
