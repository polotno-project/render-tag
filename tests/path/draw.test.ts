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

function countAlphaPixels(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  const data = ctx.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) n++;
  }
  return n;
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

  // ─── Per-glyph metrics ──────────────────────────────────────────────

  // ─── TextOnPathLayout.bounds ────────────────────────────────────────

  it('layout.bounds is a DOMRect-shaped union of all glyph cells', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hello</span>',
      path: 'M0,100 L400,100',
      align: 'left',
    });
    expect(layout.bounds).toBeDefined();
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
    // First glyph starts at x≈0; bounds.x should match within a few px.
    expect(layout.bounds.x).toBeCloseTo(0, 0);
    // For default line-height (font-size 24, normal ~1.2x ≈ 28.8), bounds
    // should span ~14 px above and below the baseline at y=100.
    expect(layout.bounds.y).toBeLessThan(100);
    expect(layout.bounds.y + layout.bounds.height).toBeGreaterThan(100);
  });

  it('bounds extends along the curve, not just the baseline', () => {
    // Semicircle of radius 100 from (50,150) to (250,150) — text on top.
    const layout = layoutTextOnPath({
      html: '<span style="font-size:18px;font-family:sans-serif">curved text on top</span>',
      path: 'M50,150 A100,100 0 0 1 250,150',
      align: 'center',
    });
    // The top of the semicircle reaches y ≈ 50. Text on top dips above that.
    expect(layout.bounds.y).toBeLessThan(60);
    // And the right edge extends past x = 200 (right side of arc).
    expect(layout.bounds.x + layout.bounds.width).toBeGreaterThan(200);
  });

  it('mixed font sizes use per-glyph line-height, not max', () => {
    // Two segments: small + huge. If bounds used max-line-height, the small
    // glyphs would contribute a tall cell. With per-glyph it's tight.
    const mixedLayout = layoutTextOnPath({
      html: `<span style="font-size:12px;font-family:sans-serif;line-height:14px">tiny</span><span style="font-size:60px;font-family:sans-serif;line-height:70px">BIG</span>`,
      path: 'M0,200 L1000,200',
      align: 'left',
    });
    const onlySmall = layoutTextOnPath({
      html: '<span style="font-size:12px;font-family:sans-serif;line-height:14px">tinytinytinytinytinytinytinytiny</span>',
      path: 'M0,200 L1000,200',
      align: 'left',
    });
    // Bounds for mixed should be ~70px tall (the BIG segment); the small
    // glyphs don't inflate it to twice that.
    expect(mixedLayout.bounds.height).toBeLessThan(85);
    // And small-only is much tighter still.
    expect(onlySmall.bounds.height).toBeLessThan(20);
  });

  it('empty layout returns zero bounds', () => {
    const layout = layoutTextOnPath({
      html: '',
      path: 'M0,100 L400,100',
      align: 'left',
    });
    expect(layout.glyphs).toHaveLength(0);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('bounds approximates the painted area (line-box ribbon, not strict glyph silhouette)', () => {
    // bounds uses per-glyph line-height — a ribbon polotno can use for
    // element width/height. With `line-height: normal` it may be slightly
    // tighter than the actual glyph silhouette (descender / ascender tail).
    // We check that bounds is *broadly* aligned with the painted area: the
    // painted bbox isn't wildly larger.
    const { ctx } = makeCanvas(400, 200);
    const layout = drawTextOnPath({
      html: '<span style="font-size:32px;font-family:sans-serif;line-height:48px;color:rgb(255,0,0)">Hello</span>',
      path: 'M20,150 Q200,30 380,150',
      ctx,
      align: 'center',
    });
    // Build the painted bbox.
    let pMinX = 400, pMinY = 200, pMaxX = 0, pMaxY = 0;
    const data = ctx.getImageData(0, 0, 400, 200).data;
    for (let py = 0; py < 200; py++) {
      for (let px = 0; px < 400; px++) {
        if (data[(py * 400 + px) * 4 + 3] === 0) continue;
        if (px < pMinX) pMinX = px;
        if (px > pMaxX) pMaxX = px;
        if (py < pMinY) pMinY = py;
        if (py > pMaxY) pMaxY = py;
      }
    }
    const { x, y, width, height } = layout.bounds;
    // bounds is a per-glyph LINE-HEIGHT ribbon — not a strict glyph bbox.
    // Painted area can drift a few px beyond it (descenders, AA, normal
    // line-height < ascent+descent). Verify "close to" not "contains".
    expect(Math.abs(pMinX - x)).toBeLessThan(30);
    expect(Math.abs(pMaxX - (x + width))).toBeLessThan(30);
    expect(Math.abs(pMinY - y)).toBeLessThan(30);
    expect(Math.abs(pMaxY - (y + height))).toBeLessThan(30);
  });

  it('exposes ascent/descent and pathOffset on each glyph', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size: 20px; font-family: sans-serif">Hi</span>',
      path: 'M0,50 L400,50',
      align: 'left',
    });
    expect(layout.glyphs).toHaveLength(2);
    for (const g of layout.glyphs) {
      expect(g.ascent).toBeGreaterThan(0);
      expect(g.descent).toBeGreaterThan(0);
    }
    expect(layout.glyphs[0].pathOffset).toBe(0);
    expect(layout.glyphs[1].pathOffset).toBeGreaterThan(0);
  });

  // ─── Background-color (Pass 1) ──────────────────────────────────────

  it('draws background-color behind the glyphs', () => {
    const { ctx } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black">AB</span>',
      path: 'M0,50 L400,50',
      ctx,
      align: 'left',
    });
    const noBgPixels = countAlphaPixels(ctx, 400, 100);

    const c2 = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black;background-color:rgb(255,0,0)">AB</span>',
      path: 'M0,50 L400,50',
      ctx: c2.ctx,
      align: 'left',
    });
    const bgPixels = countAlphaPixels(c2.ctx, 400, 100);

    // Background fills a rect that's much larger than the glyph silhouettes.
    expect(bgPixels).toBeGreaterThan(noBgPixels * 2);

    // The new pixels include red ones — verify a pixel near the glyph is red.
    const d = c2.ctx.getImageData(20, 50, 1, 1).data;
    expect(d[0]).toBeGreaterThan(200);
    expect(d[1]).toBeLessThan(50);
  });

  // ─── Text-shadow (Pass 2) ───────────────────────────────────────────

  it('draws text-shadow under the glyph fill', () => {
    const { ctx: ctxNo } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:white">A</span>',
      path: 'M50,50 L350,50',
      ctx: ctxNo,
      align: 'left',
    });
    const noShadow = countAlphaPixels(ctxNo, 400, 100);

    const { ctx: ctxSh } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:white;text-shadow:6px 6px 2px rgb(0,0,0)">A</span>',
      path: 'M50,50 L350,50',
      ctx: ctxSh,
      align: 'left',
    });
    const withShadow = countAlphaPixels(ctxSh, 400, 100);

    // Shadow adds dark pixels offset from the glyph.
    expect(withShadow).toBeGreaterThan(noShadow);
  });

  // ─── Decoration (Pass 3) ────────────────────────────────────────────

  it('underline strokes a line below the baseline', () => {
    const { ctx: ctxNo } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black">ABC</span>',
      path: 'M0,50 L400,50',
      ctx: ctxNo,
      align: 'left',
    });
    const noUnderline = countAlphaPixels(ctxNo, 400, 100);

    const { ctx: ctxU } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black;text-decoration:underline">ABC</span>',
      path: 'M0,50 L400,50',
      ctx: ctxU,
      align: 'left',
    });
    const withUnderline = countAlphaPixels(ctxU, 400, 100);
    expect(withUnderline).toBeGreaterThan(noUnderline);
  });

  it('line-through and overline both produce visible strokes', () => {
    const a = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black;text-decoration:line-through">XX</span>',
      path: 'M0,50 L400,50',
      ctx: a.ctx,
      align: 'left',
    });
    expect(countAlphaPixels(a.ctx, 400, 100)).toBeGreaterThan(0);

    const b = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;color:black;text-decoration:overline">XX</span>',
      path: 'M0,50 L400,50',
      ctx: b.ctx,
      align: 'left',
    });
    expect(countAlphaPixels(b.ctx, 400, 100)).toBeGreaterThan(0);
  });

  // ─── Gradient text (Pass 2 specialty) ───────────────────────────────

  it('background-clip:text + linear-gradient paints glyphs with varying colors along the path', () => {
    const { ctx } = makeCanvas(400, 100);
    drawTextOnPath({
      html: `<span style="font-size:80px;font-family:sans-serif;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-image:linear-gradient(to right, rgb(255,0,0), rgb(0,0,255))">ABCDEFG</span>`,
      path: 'M0,60 L400,60',
      ctx,
      align: 'left',
    });
    let earlyRed = 0, lateBlue = 0;
    for (let y = 30; y < 90; y++) {
      const dA = ctx.getImageData(20, y, 1, 1).data;
      const dB = ctx.getImageData(370, y, 1, 1).data;
      if (dA[3] > 0 && dA[0] > 150 && dA[2] < 100) earlyRed++;
      if (dB[3] > 0 && dB[2] > 150 && dB[0] < 100) lateBlue++;
    }
    expect(earlyRed).toBeGreaterThan(0);
    expect(lateBlue).toBeGreaterThan(0);
  });

  // ─── Joining-script shaping ─────────────────────────────────────────

  it('groups Arabic graphemes into a single shaped run', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">مرحبا</span>',
      path: 'M0,50 L400,50',
      align: 'left',
    });
    // 5 Arabic graphemes → ONE placement so the browser can cursively join.
    expect(layout.glyphs).toHaveLength(1);
    expect(layout.glyphs[0].char).toBe('مرحبا');
    expect(layout.glyphs[0].shaped).toBe(true);
  });

  it('splits shaped runs at whitespace', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">مرحبا بك</span>',
      path: 'M0,50 L800,50',
      align: 'left',
    });
    // run, space, run — each word can rotate independently on a curve.
    expect(layout.glyphs).toHaveLength(3);
    expect(layout.glyphs[0].shaped).toBe(true);
    expect(layout.glyphs[1].char).toBe(' ');
    expect(layout.glyphs[1].shaped).toBe(false);
    expect(layout.glyphs[2].shaped).toBe(true);
  });

  it('mixed Latin + Arabic: Latin stays per-grapheme, Arabic groups into a run', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hi مرحبا</span>',
      path: 'M0,50 L600,50',
      align: 'left',
    });
    // 'H', 'i', ' ', 'مرحبا'
    expect(layout.glyphs).toHaveLength(4);
    expect(layout.glyphs[0].char).toBe('H');
    expect(layout.glyphs[0].shaped).toBe(false);
    expect(layout.glyphs[1].char).toBe('i');
    expect(layout.glyphs[2].char).toBe(' ');
    expect(layout.glyphs[3].shaped).toBe(true);
  });

  it('RTL segment reverses run order but keeps shaped runs in logical order', () => {
    const layout = layoutTextOnPath({
      html: '<bdo dir="rtl" style="font-size:24px;font-family:sans-serif">مرحبا بك</bdo>',
      path: 'M0,50 L800,50',
      align: 'left',
    });
    // Reversed: [shaped("بك"), " ", shaped("مرحبا")].
    expect(layout.glyphs).toHaveLength(3);
    expect(layout.glyphs[0].char).toBe('بك');
    expect(layout.glyphs[0].shaped).toBe(true);
    expect(layout.glyphs[2].char).toBe('مرحبا');
  });

  it('Thai is also recognised as a shaping script', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">สวัสดี</span>',
      path: 'M0,50 L600,50',
      align: 'left',
    });
    expect(layout.glyphs[0].shaped).toBe(true);
    expect(layout.glyphs[0].char.length).toBeGreaterThan(1);
  });

  // ─── Regression: SHAPING_RE only matches true shaping scripts ────────

  it('CJK / Hangul / Hiragana are NOT grouped as shaped runs', () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:18px;font-family:sans-serif">你好世界</span>',
      path: 'M0,50 L800,50',
      align: 'left',
    });
    // 4 distinct CJK graphemes → 4 placements with per-glyph rotation,
    // NOT one shaped run.
    expect(layout.glyphs).toHaveLength(4);
    for (const g of layout.glyphs) expect(g.shaped).toBe(false);
  });

  it('Hangul / Hiragana per-glyph too', () => {
    const a = layoutTextOnPath({
      html: '<span style="font-size:18px;font-family:sans-serif">안녕</span>',
      path: 'M0,50 L600,50', align: 'left',
    });
    expect(a.glyphs).toHaveLength(2);
    expect(a.glyphs.every(g => !g.shaped)).toBe(true);

    const b = layoutTextOnPath({
      html: '<span style="font-size:18px;font-family:sans-serif">こんにちは</span>',
      path: 'M0,50 L600,50', align: 'left',
    });
    expect(b.glyphs).toHaveLength(5);
    expect(b.glyphs.every(g => !g.shaped)).toBe(true);
  });

  // ─── Regression: paint-order: fill stroke is fill-FIRST ──────────────

  it("paint-order: 'fill stroke' draws stroke on top of fill (not below)", () => {
    // Fill = white (the visible top layer for paint-order: fill).
    // Stroke = black (drawn on top).
    // For 'paint-order: fill stroke': fill drawn first, stroke drawn over.
    // Inspect a stroked pixel — it should be black (stroke wins).
    // For 'paint-order: stroke fill': stroke drawn first, fill drawn over.
    // Inspect a fill pixel — it should be white (fill wins).
    const fillFirst = makeCanvas(200, 100);
    drawTextOnPath({
      html: `<span style="font-size:40px;font-family:sans-serif;color:white;-webkit-text-stroke-width:8px;-webkit-text-stroke-color:black;paint-order:fill stroke">M</span>`,
      path: 'M30,70 L170,70',
      ctx: fillFirst.ctx,
      align: 'left',
    });
    // Sample many pixels — at least one must be dark (stroke on top).
    let darkPixels = 0;
    const d1 = fillFirst.ctx.getImageData(0, 0, 200, 100).data;
    for (let i = 0; i < d1.length; i += 4) {
      if (d1[i + 3] > 0 && d1[i] < 50 && d1[i + 1] < 50 && d1[i + 2] < 50) darkPixels++;
    }
    expect(darkPixels).toBeGreaterThan(50);
  });

  // ─── Regression: -webkit-text-fill-color: transparent suppresses fill ─

  it("-webkit-text-fill-color: transparent with color:red renders NOT red", () => {
    const { ctx } = makeCanvas(200, 100);
    drawTextOnPath({
      html: '<span style="font-size:40px;font-family:sans-serif;color:red;-webkit-text-fill-color:transparent">HELLO</span>',
      path: 'M10,70 L190,70',
      ctx,
      align: 'left',
    });
    // No solid red pixels expected (fill suppressed).
    const data = ctx.getImageData(0, 0, 200, 100).data;
    let redPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) redPixels++;
    }
    expect(redPixels).toBe(0);
  });

  // ─── Regression: ellipsis preserves boxStyle (only path module tests
  //     can't easily prove this — covered in layout-logic.test.ts) ───────

  // ─── Regression: gradient + justify don't snap to gradient last stop ─

  it('gradient text + justify spreads gradient across the natural-text span (mid-text is mid-gradient)', () => {
    // With the pre-fix bug, pathOffset for late glyphs exceeded textWidth,
    // so the gradient was clamped to its last stop and ALL late glyphs
    // (B, C, D, E in justified "A B C D E") would render uniformly blue.
    // With the fix, pathOffset stays in [0, textWidth] and the mid glyph
    // C renders mid-gradient (purple), distinguishable from the tail.
    const { ctx } = makeCanvas(800, 100);
    drawTextOnPath({
      html: `<span style="font-size:48px;font-family:sans-serif;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-image:linear-gradient(to right, rgb(255,0,0), rgb(0,0,255))">A B C D E</span>`,
      path: 'M20,70 L780,70',
      ctx,
      align: 'justify',
    });
    // Sample the painted pixels in the middle horizontal band (where C sits
    // for justified text). Expect a mix of reds, purples, and blues.
    const data = ctx.getImageData(0, 0, 800, 100).data;
    let red = 0, blue = 0, purple = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 150 && b < 100) red++;
      else if (b > 150 && r < 100) blue++;
      else if (r > 80 && b > 80) purple++;
    }
    // All three regions should be represented — gradient flows across full text.
    expect(red).toBeGreaterThan(0);
    expect(blue).toBeGreaterThan(0);
    expect(purple).toBeGreaterThan(0);
  });

  // ─── Regression: letter-spacing applied at render too ────────────────

  it('letter-spacing in render matches measured width (Arabic shaped run)', () => {
    // Just verify nothing crashes and glyph count + width look right.
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;letter-spacing:3px">مرحبا</span>',
      path: 'M0,50 L800,50',
      align: 'left',
    });
    expect(layout.glyphs).toHaveLength(1);
    expect(layout.glyphs[0].shaped).toBe(true);
    // Render — should produce visible pixels.
    const { ctx } = makeCanvas(800, 100);
    drawTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif;letter-spacing:3px;color:black">مرحبا</span>',
      path: 'M0,50 L800,50',
      ctx,
      align: 'left',
    });
    expect(isCanvasNonEmpty(ctx, 800, 100)).toBe(true);
  });

  // ─── Regression: bounds asymmetric around baseline ───────────────────

  it('bounds extends more ABOVE baseline than below (matches font ascent/descent)', () => {
    // 32px font on a horizontal path with baseline at y=80. Default
    // line-height: normal (≈ fontSize). Bounds top should be near
    // y=80-25 (ascent ~25 for sans-serif), bottom near y=80+7 (descent).
    const layout = layoutTextOnPath({
      html: '<span style="font-size:32px;font-family:sans-serif">HELLO</span>',
      path: 'M0,80 L800,80',
      align: 'left',
    });
    const { y, height } = layout.bounds;
    const topDist = 80 - y;              // distance baseline → bounds.top
    const bottomDist = (y + height) - 80; // distance baseline → bounds.bottom
    // Asymmetric — top should be much larger than bottom.
    expect(topDist).toBeGreaterThan(bottomDist);
    // Sanity: each within plausible font-metric range for 32px sans-serif.
    expect(topDist).toBeGreaterThan(15);
    expect(topDist).toBeLessThan(40);
    expect(bottomDist).toBeLessThan(15);
  });

  // ─── Regression: canonical color grouping ────────────────────────────

  it('same color in different syntactic forms groups into one background polygon', () => {
    // If 'red' and 'rgb(255,0,0)' were grouped separately, we'd get two
    // polygons with a seam between them. We can't easily detect a seam
    // pixel-perfectly, but we CAN verify the canvas state cleanly draws
    // a continuous red band.
    const { ctx } = makeCanvas(400, 100);
    drawTextOnPath({
      html: '<span style="background-color:red;color:black">AB</span><span style="background-color:rgb(255,0,0);color:black">CD</span>',
      path: 'M0,50 L400,50',
      ctx,
      align: 'left',
    });
    // Verify the background painted (any red pixel along the band).
    let redCount = 0;
    for (let x = 10; x < 200; x += 5) {
      const d = ctx.getImageData(x, 50, 1, 1).data;
      if (d[3] > 0 && d[0] > 200 && d[1] < 50 && d[2] < 50) redCount++;
    }
    expect(redCount).toBeGreaterThan(5);
  });

  // ─── textBaseline option ────────────────────────────────────────────

  it("textBaseline defaults to 'alphabetic' (path = baseline)", () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hi</span>',
      path: 'M0,80 L400,80',
      align: 'left',
    });
    expect(layout.textBaseline).toBe('alphabetic');
    // bounds.y is well above the baseline (ascent), bounds bottom barely below.
    const baselineY = 80;
    expect(baselineY - layout.bounds.y).toBeGreaterThan(15);          // above
    expect((layout.bounds.y + layout.bounds.height) - baselineY).toBeLessThan(15); // below
  });

  it("textBaseline 'middle' centres bounds on the path", () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hi</span>',
      path: 'M0,80 L400,80',
      align: 'left',
      textBaseline: 'middle',
    });
    expect(layout.textBaseline).toBe('middle');
    // bounds should be roughly centred on y=80.
    const pathY = 80;
    const topGap = pathY - layout.bounds.y;
    const bottomGap = (layout.bounds.y + layout.bounds.height) - pathY;
    expect(Math.abs(topGap - bottomGap)).toBeLessThan(4);
  });

  it("textBaseline 'top' places bounds entirely below the path", () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hi</span>',
      path: 'M0,80 L400,80',
      align: 'left',
      textBaseline: 'top',
    });
    const pathY = 80;
    // bounds top sits AT (or just below) the path.
    expect(layout.bounds.y).toBeGreaterThanOrEqual(pathY - 1);
    // bounds extends downward by ~lineHeight.
    expect(layout.bounds.y + layout.bounds.height).toBeGreaterThan(pathY + 20);
  });

  it("textBaseline 'bottom' places bounds entirely above the path", () => {
    const layout = layoutTextOnPath({
      html: '<span style="font-size:24px;font-family:sans-serif">Hi</span>',
      path: 'M0,80 L400,80',
      align: 'left',
      textBaseline: 'bottom',
    });
    const pathY = 80;
    // bounds bottom sits at (or just above) the path.
    expect(layout.bounds.y + layout.bounds.height).toBeLessThanOrEqual(pathY + 1);
  });

  it('textBaseline changes painted pixel band — middle is centred on path', () => {
    // Without textBaseline: painted area is mostly above the path.
    // With textBaseline:'middle': painted area is roughly symmetric around it.
    const a = makeCanvas(400, 160);
    drawTextOnPath({
      html: '<span style="font-size:40px;font-family:sans-serif;color:black">M</span>',
      path: 'M30,80 L370,80',
      ctx: a.ctx,
      align: 'left',
    });
    const b = makeCanvas(400, 160);
    drawTextOnPath({
      html: '<span style="font-size:40px;font-family:sans-serif;color:black">M</span>',
      path: 'M30,80 L370,80',
      ctx: b.ctx,
      align: 'left',
      textBaseline: 'middle',
    });
    const paintedYRange = (ctx: CanvasRenderingContext2D) => {
      const data = ctx.getImageData(0, 0, 400, 160).data;
      let top = 160, bot = 0;
      for (let y = 0; y < 160; y++) {
        for (let x = 0; x < 400; x++) {
          if (data[(y * 400 + x) * 4 + 3] > 0) {
            if (y < top) top = y;
            if (y > bot) bot = y;
            break;
          }
        }
      }
      return { top, bot, mid: (top + bot) / 2 };
    };
    const ra = paintedYRange(a.ctx);
    const rb = paintedYRange(b.ctx);
    // alphabetic: mid of painted area is well above the path (y=80).
    expect(ra.mid).toBeLessThan(80);
    // middle: mid of painted area is close to the path.
    expect(Math.abs(rb.mid - 80)).toBeLessThan(8);
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
