import { beforeAll, expect, test, vi } from 'vitest';
import { layout, drawLayout, render, type PaintBounds } from '../src/index.ts';
import { layoutTextOnPath, drawTextOnPathLayout, drawTextOnPath } from '../src/path/index.ts';
import fontUrl from '@fontsource-variable/arimo/files/arimo-latin-wght-normal.woff2?url';

beforeAll(async () => {
  document.fonts.add(await new FontFace('BoundsFixture', `url(${fontUrl})`, { weight: '100 900' }).load());
});

function surface() {
  const canvas = document.createElement('canvas');
  canvas.width = 1000; canvas.height = 700;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(300, 250);
  return ctx;
}

function containsPaint(ctx: CanvasRenderingContext2D, bounds: PaintBounds) {
  const pixels = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  let painted = 0, outside = 0;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
    if (pixels.data[(y * pixels.width + x) * 4 + 3] < 2) continue;
    painted++;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    if (x + 1 < 300 + bounds.x || x > 300 + bounds.x + bounds.width ||
        y + 1 < 250 + bounds.y || y > 250 + bounds.y + bounds.height) outside++;
  }
  expect(painted).toBeGreaterThan(100);
  expect(outside, JSON.stringify({ bounds, paint: { left: left - 300, top: top - 250, right: right - 300, bottom: bottom - 250 } })).toBe(0);
}

const cases = [
  ['italic overhang', 'font-style:italic;text-align:right', 'ff'],
  ['short line height', 'line-height:0.4', 'Égj'],
  ['stroke and decorations', '-webkit-text-stroke:20px black;text-decoration:underline wavy;text-underline-offset:35px;text-decoration-thickness:8px', 'fj'],
  ['CSS shadows', 'text-shadow:-70px -30px 8px red, 45px 40px 5px blue', 'Ab'],
  ['mixed runs and boxes', '', '<span style="font-size:130px">f</span><span style="background:red;font-size:35px">gj</span>'],
] as const;

for (const [name, style, text] of cases) {
  const html = `<div style="font-size:70px;font-family:BoundsFixture;${style}">${text}</div>`;
  test(`flat bounds contain ${name}`, () => {
    const ctx = surface();
    const result = layout({ html, width: 220, ctx });
    const bounds = result.paintBounds;
    drawLayout({ layout: result, width: 220, ctx });
    containsPaint(ctx, bounds);
  });
  test(`path bounds contain ${name}`, () => {
    const ctx = surface();
    const result = layoutTextOnPath({ html, path: 'M0,0 Q100,-80 250,30', ctx });
    const bounds = result.paintBounds;
    drawTextOnPathLayout({ layout: result, ctx });
    containsPaint(ctx, bounds);
  });
}

for (const curved of [false, true]) {
  test(`${curved ? 'path' : 'flat'} bounds are lazy, reusable and independent of context state`, () => {
    const ctx = surface();
    const html = '<div style="font-size:70px;font-family:BoundsFixture;text-shadow:100px 0 red">A</div>';
    const config = { html, width: 100, path: 'M0,0 L500,0' };
    const createLayout = curved ? layoutTextOnPath : layout;
    const expected = createLayout(config).paintBounds;
    const result = createLayout({ ...config, ctx });
    const measure = vi.spyOn(ctx, 'measureText');
    // Height/selection-only callers must not perform paint measurements.
    expect(Object.keys(result)).toContain('paintBounds');
    expect(measure).not.toHaveBeenCalled();
    ctx.font = '12px serif'; ctx.textAlign = 'right'; ctx.direction = 'rtl';
    ctx.letterSpacing = '-25px'; ctx.wordSpacing = '30px'; ctx.miterLimit = 50;
    ctx.shadowBlur = 90; ctx.shadowOffsetX = 200; ctx.shadowColor = 'red';
    ctx.scale(2, 3);
    const transform = ctx.getTransform().toJSON();
    expect(result.paintBounds).toEqual(expected);
    expect(measure).toHaveBeenCalled();
    expect(ctx.font).toBe('12px serif');
    expect(ctx.textAlign).toBe('right');
    expect(ctx.direction).toBe('rtl');
    expect(ctx.letterSpacing).toBe('-25px');
    expect(ctx.wordSpacing).toBe('30px');
    expect(ctx.miterLimit).toBe(50);
    expect(ctx.shadowBlur).toBe(90);
    expect(ctx.getTransform().toJSON()).toEqual(transform);
    const bounds = result.paintBounds;
    measure.mockClear();
    expect(result.paintBounds).toBe(bounds);
    expect(measure).not.toHaveBeenCalled();
    measure.mockRestore();
  });
}

test('combined render APIs return painted bounds without changing layout geometry', () => {
  const html = '<div style="font-size:70px;font-family:BoundsFixture;font-style:italic;text-shadow:-100px -50px red">ff</div>';
  const flat = layout({ html, width: 220 });
  const plain = layout({ html: html.replace('text-shadow:-100px -50px red', ''), width: 220 });
  const rendered = render({ html, width: 220, ctx: surface() });
  expect(rendered.paintBounds).toEqual(flat.paintBounds);
  expect(flat.height).toBe(plain.height);
  expect(flat.paintBounds.x).toBeLessThan(plain.paintBounds.x);
  expect(flat.paintBounds.y).toBeLessThan(plain.paintBounds.y);
  const config = { html, path: 'M0,0 Q100,-80 250,30' };
  const curve = layoutTextOnPath(config);
  const drawn = drawTextOnPath({ ...config, ctx: surface() });
  expect(drawn.paintBounds).toEqual(curve.paintBounds);
  expect(curve.bounds).toEqual(layoutTextOnPath({ ...config, html: html.replace('text-shadow:-100px -50px red', '') }).bounds);
});

test('empty path has empty painted bounds', () => {
  const result = layoutTextOnPath({ html: '', path: 'M0,0 L100,0' });
  expect(result.paintBounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
});

test('default bounds context does not inherit spacing from another layout', () => {
  const result = layout({ html: '<div style="font-size:100px;font-family:BoundsFixture;font-style:italic;text-align:right">ff</div>', width: 220 });
  layout({ html: '<div style="font-size:70px;font-family:BoundsFixture;letter-spacing:-25px">abc</div>', width: 220 });
  const ctx = surface();
  drawLayout({ layout: result, width: 220, ctx });
  containsPaint(ctx, result.paintBounds);
});
