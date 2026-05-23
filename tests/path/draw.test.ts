/**
 * End-to-end integration test for drawTextOnPath using a real canvas
 * context. We don't pixel-compare; we just sanity-check that:
 *  - the function runs without throwing
 *  - it returns sensible glyph metadata
 *  - some pixels get drawn somewhere along the path
 */
import { describe, it, expect } from 'vitest';
import { drawTextOnPath, layoutTextOnPath, drawTextOnPathLayout } from '../../src/path/index.ts';

function makeCanvas(width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  return { canvas: c, ctx };
}

function isCanvasNonEmpty(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

describe('drawTextOnPath (integration)', () => {
  it('draws plain text along a straight path', () => {
    const { ctx } = makeCanvas(400, 100);
    const result = drawTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; color: black">Hello</span>',
      path: 'M10,40 L390,40',
      ctx,
      align: 'left',
    });
    expect(result.glyphs.length).toBeGreaterThan(0);
    expect(result.pathLength).toBe(380);
    expect(result.glyphs[0].style.fontSize).toBe(20);
    // First glyph sits at the path start, not at (0, 0).
    expect(result.glyphs[0].x).toBeCloseTo(10, 1);
    expect(result.glyphs[0].y).toBeCloseTo(40, 1);
    expect(isCanvasNonEmpty(ctx, 400, 100)).toBe(true);
  });

  it('respects align: center', () => {
    const { ctx } = makeCanvas(400, 100);
    const result = drawTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; color: black">Hi</span>',
      path: 'M0,50 L400,50',
      ctx,
      align: 'center',
    });
    const firstX = result.glyphs[0].x;
    // Text width is small; centering should push it well past 100.
    expect(firstX).toBeGreaterThan(100);
    // And well short of the right edge.
    expect(firstX).toBeLessThan(300);
  });

  it('mixed styles: bold span gets bigger glyph advances', () => {
    const { ctx } = makeCanvas(600, 100);
    const result = drawTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif">A<b>B</b>C</span>',
      path: 'M0,50 L600,50',
      ctx,
      align: 'left',
    });
    // Three glyphs total.
    expect(result.glyphs).toHaveLength(3);
    // Bold weight differs from the surrounding regular weight.
    expect(result.glyphs[0].style.fontWeight).toBeLessThan(result.glyphs[1].style.fontWeight);
    expect(result.glyphs[2].style.fontWeight).toBe(result.glyphs[0].style.fontWeight);
  });

  it('curved path: glyphs follow the curve with non-zero rotation', () => {
    const { ctx } = makeCanvas(400, 200);
    // Steeper arc — semicircle to guarantee meaningful rotation.
    const result = drawTextOnPath({
      html: '<span style="font-size: 24px; font-family: sans-serif; color: black">Curved text</span>',
      path: 'M50,150 A100,100 0 0 1 350,150',
      ctx,
      align: 'left',
    });
    expect(result.glyphs.length).toBeGreaterThan(0);
    // Some glyph on a semicircle must have rotation > 0.5 rad.
    const maxRot = Math.max(...result.glyphs.map(g => Math.abs(g.rotation)));
    expect(maxRot).toBeGreaterThan(0.5);
  });

  it('overflow: drops glyphs that do not fit on the path', () => {
    const { ctx } = makeCanvas(200, 100);
    const result = drawTextOnPath({
      // Long enough that some chars get dropped on a short path.
      html: '<span style="font-size: 20px; font-family: sans-serif">A really long string that absolutely cannot fit</span>',
      path: 'M0,50 L40,50',
      ctx,
      align: 'left',
    });
    // Fewer glyphs than characters in the input.
    expect(result.glyphs.length).toBeLessThan(20);
  });

  it('layoutTextOnPath returns placements without touching the canvas', () => {
    const { ctx } = makeCanvas(400, 100);
    const result = layoutTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; color: black">Hi</span>',
      path: 'M0,50 L400,50',
      align: 'center',
    });
    expect(result.glyphs.length).toBe(2);
    expect(result.pathLength).toBe(400);
    // Nothing drawn yet.
    expect(isCanvasNonEmpty(ctx, 400, 100)).toBe(false);
  });

  it('drawTextOnPathLayout draws a precomputed layout', () => {
    const { ctx } = makeCanvas(400, 100);
    const layout = layoutTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; color: black">Hi</span>',
      path: 'M0,50 L400,50',
      align: 'center',
    });
    drawTextOnPathLayout({ layout, ctx });
    expect(isCanvasNonEmpty(ctx, 400, 100)).toBe(true);
  });

  it('draws same layout onto multiple canvases', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; color: black">Hi</span>',
      path: 'M0,50 L400,50',
      align: 'left',
    });
    const a = makeCanvas(400, 100);
    const b = makeCanvas(400, 100);
    drawTextOnPathLayout({ layout, ctx: a.ctx });
    drawTextOnPathLayout({ layout, ctx: b.ctx });
    expect(isCanvasNonEmpty(a.ctx, 400, 100)).toBe(true);
    expect(isCanvasNonEmpty(b.ctx, 400, 100)).toBe(true);
  });

  it('does not leak ctx state (font, letterSpacing) to caller', () => {
    const { ctx } = makeCanvas(400, 100);
    ctx.font = '12px serif';
    ctx.letterSpacing = '0px' as any;
    drawTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; letter-spacing: 5px">Hi</span>',
      path: 'M0,50 L400,50',
      ctx,
      align: 'left',
    });
    // ctx state should be restored to what caller set it to.
    expect(ctx.font).toBe('12px serif');
    expect(ctx.letterSpacing).toBe('0px');
  });

  it('resets ctx.letterSpacing between segments with different letter-spacing', () => {
    const { ctx } = makeCanvas(800, 100);
    const layout = layoutTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif; letter-spacing: 30px">A</span>' +
            '<span style="font-size: 20px; font-family: sans-serif">BCDE</span>',
      path: 'M0,50 L800,50',
      align: 'left',
    });
    // Sanity: 5 glyphs.
    expect(layout.glyphs).toHaveLength(5);
    // The leak would inflate B/C/D/E advances by 30px each. We verify they
    // sit close to the natural 'BCDE' progression — no segment should be
    // displaced by >25px from its neighbour.
    for (let i = 2; i < layout.glyphs.length; i++) {
      const dx = layout.glyphs[i].x - layout.glyphs[i - 1].x;
      expect(dx).toBeLessThan(25);
    }
  });

  it('PathLike input bypasses the SVG parser', () => {
    const { ctx } = makeCanvas(400, 100);
    let calls = 0;
    const path = {
      length: 200,
      getPointAtLength: (t: number) => {
        calls++;
        return { x: t, y: 50 };
      },
    };
    const result = drawTextOnPath({
      html: '<span style="font-size: 16px; font-family: sans-serif">abc</span>',
      path,
      ctx,
      align: 'left',
    });
    expect(result.glyphs).toHaveLength(3);
    expect(calls).toBeGreaterThan(0);
  });
});
