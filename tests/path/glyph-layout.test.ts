import { describe, it, expect } from 'vitest';
import { layoutGlyphsOnPath, type Segment, type AlignMode } from '../../src/path/glyph-layout.ts';
import type { PathLike } from '../../src/path/svg-path.ts';
import type { ResolvedStyle } from '../../src/types.ts';
import { styleFixture } from '../helpers/style-fixture.ts';

const CHAR_WIDTH = 10;

const mockStyle = (overrides: Partial<ResolvedStyle> = {}): ResolvedStyle =>
  styleFixture({ display: 'inline', ...overrides });

function mockCtx(charWidth = CHAR_WIDTH): CanvasRenderingContext2D {
  return {
    font: '',
    fontKerning: 'normal',
    letterSpacing: '0px',
    measureText(text: string) {
      return {
        width: text.length * charWidth,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * charWidth,
      };
    },
  } as unknown as CanvasRenderingContext2D;
}

/** Straight horizontal path from (0,0) along +x for `length` units. */
function horizontalPath(length: number): PathLike {
  return {
    length,
    getPointAtLength: (t: number) =>
      t < 0 || t > length + 1e-6 ? null : { x: t, y: 0 },
  };
}

/** Upper semicircle from (0,0) to (2r,0). Length = π·r. */
function semicirclePath(radius: number): PathLike {
  const length = Math.PI * radius;
  return {
    length,
    getPointAtLength: (t: number) => {
      if (t < 0 || t > length + 1e-6) return null;
      const theta = Math.PI - t / radius; // start at π (= (0,0)), end at 0 (= (2r,0))
      return {
        x: radius + radius * Math.cos(theta),
        y: -radius * Math.sin(theta),
      };
    },
  };
}

function seg(text: string, style: Partial<ResolvedStyle> = {}, rtl = false): Segment {
  return { text, style: mockStyle(style), rtl };
}

describe('layoutGlyphsOnPath', () => {
  it('lays plain text on a horizontal path with rotation 0', () => {
    const ctx = mockCtx();
    const path = horizontalPath(200);
    const out = layoutGlyphsOnPath({
      segments: [seg('hello')],
      path,
      ctx,
      align: 'left',
    });
    expect(out.glyphs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(out.glyphs[i].x).toBeCloseTo(i * CHAR_WIDTH, 5);
      expect(out.glyphs[i].y).toBeCloseTo(0, 5);
      expect(out.glyphs[i].rotation).toBeCloseTo(0, 5);
    }
    expect(out.textWidth).toBe(50);
  });

  it('center align offsets the first glyph by (pathLength - textWidth) / 2', () => {
    const ctx = mockCtx();
    const path = horizontalPath(200);
    const out = layoutGlyphsOnPath({
      segments: [seg('ABC')],
      path,
      ctx,
      align: 'center',
    });
    expect(out.glyphs[0].x).toBe((200 - 30) / 2);
  });

  it('right align anchors text to the path end', () => {
    const ctx = mockCtx();
    const path = horizontalPath(100);
    const out = layoutGlyphsOnPath({
      segments: [seg('AB')],
      path,
      ctx,
      align: 'right',
    });
    expect(out.glyphs[0].x).toBe(100 - 20);
    expect(out.glyphs[1].x).toBe(100 - 10);
  });

  it('justify expands spaces to fill the path', () => {
    const ctx = mockCtx();
    const path = horizontalPath(100);
    // "AB CD" — text width 50, 1 space, path length 100 → extra per space = 50
    const out = layoutGlyphsOnPath({
      segments: [seg('AB CD')],
      path,
      ctx,
      align: 'justify',
    });
    expect(out.glyphs).toHaveLength(5);
    // A=0, B=10, space=20 (takes 10+50=60 of path), C=80, D=90
    expect(out.glyphs[0].x).toBe(0);
    expect(out.glyphs[1].x).toBe(10);
    expect(out.glyphs[2].x).toBe(20);   // space starts at 20
    expect(out.glyphs[3].x).toBe(80);   // after expanded space
    expect(out.glyphs[4].x).toBe(90);
  });

  it('curved path: rotation varies smoothly across glyphs', () => {
    const ctx = mockCtx();
    const path = semicirclePath(100);
    // Pick a path long enough to fit several glyphs.
    const out = layoutGlyphsOnPath({
      segments: [seg('abcdefghij')],
      path,
      ctx,
      align: 'center',
    });
    expect(out.glyphs.length).toBeGreaterThan(5);
    // Rotation should monotonically progress from near +π/2 (top of arc start)
    // through 0 toward -π/2 (top of arc end). Just check the trend.
    const rots = out.glyphs.map(g => g.rotation);
    // Tangent at the leftmost point of an upper semicircle traversed
    // counterclockwise (start (0,0) → top → (2r,0)) is straight up
    // (rotation ≈ -π/2 in screen-coords where y goes down).
    expect(rots[0]).toBeLessThan(0);
    expect(rots[rots.length - 1]).toBeGreaterThan(0);
  });

  it('two-style rich text: each glyph carries its segment style', () => {
    const ctx = mockCtx();
    const path = horizontalPath(200);
    const out = layoutGlyphsOnPath({
      segments: [
        seg('AA', { fontWeight: 400 }),
        seg('BB', { fontWeight: 700 }),
      ],
      path,
      ctx,
      align: 'left',
    });
    expect(out.glyphs).toHaveLength(4);
    expect(out.glyphs[0].style.fontWeight).toBe(400);
    expect(out.glyphs[1].style.fontWeight).toBe(400);
    expect(out.glyphs[2].style.fontWeight).toBe(700);
    expect(out.glyphs[3].style.fontWeight).toBe(700);
  });

  it('rtl segment reverses the grapheme order', () => {
    const ctx = mockCtx();
    const path = horizontalPath(200);
    const out = layoutGlyphsOnPath({
      segments: [seg('ABC', {}, true)],
      path,
      ctx,
      align: 'left',
    });
    // Reversed: C at x=0, B at x=10, A at x=20
    expect(out.glyphs.map(g => g.char)).toEqual(['C', 'B', 'A']);
  });

  it('overflow: stops emitting once a glyph would extend past the path', () => {
    const ctx = mockCtx();
    const path = horizontalPath(35);
    const out = layoutGlyphsOnPath({
      segments: [seg('abcdef')],
      path,
      ctx,
      align: 'left',
    });
    // 3 full glyphs (0..30) fit. The 4th (30..40) overflows by 5px → drop.
    // (Slack from kerning is 0 with our mock since per-glyph sum == whole-string measure.)
    expect(out.glyphs.length).toBe(3);
    expect(out.glyphs.map(g => g.char)).toEqual(['a', 'b', 'c']);
  });

  it('letterSpacing increases the per-glyph advance', () => {
    const ctx = mockCtx();
    const path = horizontalPath(200);
    const out = layoutGlyphsOnPath({
      segments: [seg('ABC', { letterSpacing: 5 })],
      path,
      ctx,
      align: 'left',
    });
    // A=0, B=10+5=15, C=30+5+5=... wait: offset after A = 10 (width) + 5 (ls) = 15
    // B is at offset 15, then advances to 15+10+5=30. C at 30, advances to 30+10=40.
    expect(out.glyphs[0].x).toBe(0);
    expect(out.glyphs[1].x).toBe(15);
    expect(out.glyphs[2].x).toBe(30);
  });
});
