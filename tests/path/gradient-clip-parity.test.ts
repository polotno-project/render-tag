/**
 * Path renderer parity for background-clip:text gradients — the same paint
 * model as the main renderer:
 *  - a gradient declared on an inline ancestor reaches text in a NESTED
 *    inline child (background-image/clip don't inherit; the propagation is
 *    a painting rule, not property inheritance),
 *  - transparent decorations (underline/strike) over clip-gradient text show
 *    the gradient through the band instead of vanishing,
 *  - the gradient spans the DECLARING element's fragment, not the whole text.
 */
import { describe, it, expect } from 'vitest';
import { drawTextOnPath } from '../../src/path/index.ts';

function makeCanvas(width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  return { canvas: c, ctx };
}

function countPixels(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  const data = ctx.getImageData(0, 0, w, h).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

const isAny = () => true;
const isReddish = (r: number, g: number, b: number) => r > 130 && g < 110 && b < 110;
const isGreenish = (r: number, g: number, b: number) => g > 150 && b < 120;
const isBluish = (r: number, g: number, b: number) => b > 150 && r < 100 && g < 100;

const CLIP = '-webkit-background-clip: text; -webkit-text-fill-color: transparent;';

describe('drawTextOnPath — clip-gradient paint parity', () => {
  it('paints gradient text held by a nested inline inside the declaring inline', () => {
    const { ctx } = makeCanvas(400, 120);
    drawTextOnPath({
      html: `<span style="font-size: 60px; font-family: sans-serif; background-image: linear-gradient(90deg, red, blue); ${CLIP} color: red;"><u>Header</u></span>`,
      path: 'M10,80 L390,80',
      ctx,
    });
    expect(countPixels(ctx, 400, 120, isAny)).toBeGreaterThan(100);
    expect(countPixels(ctx, 400, 120, isReddish)).toBeGreaterThan(30);
    expect(countPixels(ctx, 400, 120, isBluish)).toBeGreaterThan(30);
  });

  it('transparent underline + strike over clip-gradient text paint the gradient band', () => {
    const { ctx } = makeCanvas(400, 120);
    // 0deg = bottom-to-top red→green; the underline sits at the red end,
    // glyph tops at the green end. Decorations must not vanish.
    drawTextOnPath({
      html: `<s style="font-size: 60px; font-family: sans-serif; background-image: linear-gradient(0deg, rgb(194,28,28) 0%, rgb(142,255,12) 100%); ${CLIP} color: rgb(194,28,28);"><u>Header</u></s>`,
      path: 'M10,80 L390,80',
      ctx,
    });
    expect(countPixels(ctx, 400, 120, isAny)).toBeGreaterThan(100);
    expect(countPixels(ctx, 400, 120, isReddish)).toBeGreaterThan(30);
    expect(countPixels(ctx, 400, 120, isGreenish)).toBeGreaterThan(30);
  });

  it('solid background-color + clip:text paints red glyphs, not a background band', () => {
    const { ctx } = makeCanvas(400, 120);
    drawTextOnPath({
      html: '<span style="font-size: 50px; font-family: sans-serif; background-color: red; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Solid</span>',
      path: 'M10,80 L390,80',
      ctx,
    });
    const red = countPixels(ctx, 400, 120, isReddish);
    // Glyphs only (~1600 px at this size) — not the full glyph-cell polygon
    // band (~6400 px) that an unclipped background paints.
    expect(red).toBeGreaterThan(200);
    expect(red).toBeLessThan(3200);
  });

  it('gradient spans the declaring fragment, not the whole text', () => {
    const { ctx } = makeCanvas(600, 120);
    // "MMMM" solid black, then a green→blue gradient span. If the gradient
    // spanned the WHOLE text, the span (sitting in the right half) would
    // sample only the blue tail and show no green.
    drawTextOnPath({
      html: `<span style="font-size: 50px; font-family: sans-serif; color: black;">MMMM<span style="background-image: linear-gradient(90deg, lime, blue); ${CLIP}">WWWW</span></span>`,
      path: 'M10,80 L590,80',
      ctx,
    });
    expect(countPixels(ctx, 600, 120, isGreenish)).toBeGreaterThan(30);
    expect(countPixels(ctx, 600, 120, isBluish)).toBeGreaterThan(30);
  });
});

describe('drawTextOnPath — gradient stroke (--rt-text-stroke-image)', () => {
  const isMagenta = (r: number, g: number, b: number) => r > 140 && g < 90 && b > 140;
  const isWhite = (r: number, g: number, b: number) => r > 240 && g > 240 && b > 240;

  it('strokes with the gradient and keeps the solid fill (incl. nested inline)', () => {
    const { ctx } = makeCanvas(400, 120);
    drawTextOnPath({
      html: '<span style="font-size: 60px; font-family: sans-serif; color: white; ' +
        '-webkit-text-stroke: 6px black; paint-order: stroke fill; ' +
        '--rt-text-stroke-image: linear-gradient(0deg, rgb(212,0,255) 0%, rgb(212,0,255) 100%)"><u>AB</u></span>',
      path: 'M10,80 L390,80',
      ctx,
    });
    expect(countPixels(ctx, 400, 120, isWhite)).toBeGreaterThan(50);
    expect(countPixels(ctx, 400, 120, isMagenta)).toBeGreaterThan(20);
  });
});

describe('drawTextOnPath — clip-painted decorations keep per-declarer geometry', () => {
  /** Rows of ink strictly BELOW the baseline in an x window — the band only. */
  const bandRows = (ctx: CanvasRenderingContext2D, x0: number, x1: number) => {
    const d = ctx.getImageData(0, 0, 600, 260).data;
    let n = 0;
    for (let y = 152; y < 260; y++) {
      for (let x = x0; x < x1; x++) {
        if (d[(y * 600 + x) * 4 + 3] > 128) {
          n++;
          break;
        }
      }
    }
    return n;
  };

  const draw = (html: string) => {
    const { ctx } = makeCanvas(600, 260);
    drawTextOnPath({ html, path: 'M10,150 L590,150', ctx });
    return ctx;
  };

  it('splits the transparent band where the decorating box changes size', () => {
    // A transparent decoration over clip-painted text is grouped on its own
    // path, and that grouping has to make the same call as the solid one: two
    // declarer sizes are two bands. The BIG span comes first on purpose — one
    // merged group would then paint the small run with the 90px band.
    const CLIPPED = (size: number, text: string) =>
      `<span style="font-size: ${size}px; font-family: sans-serif; background-image: linear-gradient(90deg, red, blue); ${CLIP}"><u>${text}</u></span>`;

    const mixed = draw(
      `<span style="font-size: 30px; font-family: sans-serif; background-image: linear-gradient(90deg, red, blue); ${CLIP}">` +
        `<span style="font-size: 90px;"><u>CD</u></span><u>ab</u></span>`,
    );
    const reference = draw(CLIPPED(30, 'ab'));

    // The trailing 30px run must carry the 30px band, not the 90px one.
    const refBand = bandRows(reference, 12, 40);
    expect(refBand, 'reference band drawn').toBeGreaterThan(0);
    // The 90px "CD" runs to x≈130 and the 30px "ab" follows it to x≈175.
    expect(bandRows(mixed, 145, 175), 'band over the small trailing run').toBeLessThanOrEqual(
      refBand + 1,
    );
  });
});
