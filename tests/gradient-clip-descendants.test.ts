/**
 * background-clip: text gradients must survive block descendants.
 *
 * Browsers clip the declaring element's background to the text glyphs of ALL
 * descendants — including block children like <p>/<li> — and the gradient
 * geometry spans the declaring element's box. The renderer used to compute
 * the gradient per box and drop it when recursing into a child box, while
 * `color: transparent` still inherited: text inside any block child painted
 * nothing (e.g. Polotno's Quill output wraps every line in <p>).
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Count pixels in a region matching a color predicate (alpha >= 128). */
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

const isRed = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100;
const isBlue = (r: number, g: number, b: number) => b > 150 && r < 100 && g < 100;
const isGreen = (r: number, g: number, b: number) => g > 150 && r < 100 && b < 100;
const isAny = () => true;

const CLIP = '-webkit-background-clip: text; color: transparent;';

describe('background-clip: text gradient through block descendants', () => {
  it('control: gradient declared on the <p> itself still paints', () => {
    const html = `<p style="font-size: 24px; background-image: linear-gradient(90deg, red, blue); ${CLIP}">Gradient</p>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countPixels(canvas, isAny)).toBeGreaterThan(50);
  });

  it('paints text inside a <p> child of the gradient element', () => {
    const html = `<div style="font-size: 24px; background-image: linear-gradient(90deg, red, blue); ${CLIP}"><p>Gradient text</p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countPixels(canvas, isAny)).toBeGreaterThan(50);
  });

  it('gradient geometry spans the declaring element, not each paragraph', () => {
    // Vertical red→blue gradient over two paragraphs. With full-element
    // geometry the first paragraph samples the red end and the second the
    // blue end. (Per-paragraph geometry would give both paragraphs the full
    // red→blue ramp instead.)
    const html = `<div style="font-size: 24px; line-height: 1; background-image: linear-gradient(180deg, red, blue); ${CLIP}"><p style="margin: 0;">AAAAAAAA</p><p style="margin: 0;">BBBBBBBB</p></div>`;
    const { canvas } = render({ html, width: 300, height: 48, pixelRatio: 1 });
    const top: Rect = { x: 0, y: 0, w: canvas.width, h: Math.floor(canvas.height / 2) };
    const bottom: Rect = { x: 0, y: Math.floor(canvas.height / 2), w: canvas.width, h: Math.floor(canvas.height / 2) };
    expect(countPixels(canvas, isRed, top)).toBeGreaterThan(20);
    expect(countPixels(canvas, isBlue, bottom)).toBeGreaterThan(20);
    // and no strongly-blue glyphs in the top paragraph
    expect(countPixels(canvas, isBlue, top)).toBe(0);
  });

  it('a descendant declaring its own clipping gradient overrides the ancestor', () => {
    const html = `<div style="font-size: 24px; background-image: linear-gradient(90deg, red, red); ${CLIP}"><p style="background-image: linear-gradient(90deg, blue, blue); ${CLIP}">Own</p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countPixels(canvas, isBlue)).toBeGreaterThan(20);
    expect(countPixels(canvas, isRed)).toBe(0);
  });

  it('an INLINE span re-declaring its own clipping gradient overrides the ancestor', () => {
    // Regression: the parent clips a red gradient over the whole word; the
    // inline <span> re-declares its own clip. Unlike a block <p> child
    // (overridden at the box level), an inline span is a text RUN carrying its
    // parent's copied style — it must still paint its OWN gradient, while the
    // surrounding runs keep the ancestor's. (Polotno: a recolored sub-selection
    // inside a gradient-filled text element — previously the span painted the
    // ancestor gradient and its own was lost.)
    //
    // The span uses a REAL multi-stop gradient (green→blue) so this also guards
    // that the span samples ITS OWN gradient (both stops appear) rather than a
    // solid re-declaration that a plain ancestor-override could fake.
    const html = `<div style="font-size: 40px; background-image: linear-gradient(90deg, red, red); ${CLIP}">A<span style="background-image: linear-gradient(90deg, lime, blue); ${CLIP}">BBBB</span>C</div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countPixels(canvas, isGreen)).toBeGreaterThan(20); // span "BBBB" green end
    expect(countPixels(canvas, isBlue)).toBeGreaterThan(20); // span "BBBB" blue end
    expect(countPixels(canvas, isRed)).toBeGreaterThan(20); // "A" and "C" keep ancestor red
  });

  it('a descendant with an opaque color paints that color, not the gradient', () => {
    const html = `<div style="font-size: 24px; background-image: linear-gradient(90deg, blue, blue); ${CLIP}"><p style="color: red;">Opaque</p></div>`;
    const { canvas } = render({ html, width: 300, pixelRatio: 1 });
    expect(countPixels(canvas, isRed)).toBeGreaterThan(20);
    expect(countPixels(canvas, isBlue)).toBe(0);
  });
});
