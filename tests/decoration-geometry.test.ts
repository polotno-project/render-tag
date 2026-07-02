/**
 * Decoration geometry vs real Chromium raster.
 *
 * Renders red underline / line-through on black text through both render-tag
 * and the DOM reference renderer, isolates the red band, and asserts its
 * y-center, thickness, and x-extent match.
 *
 * Tuned invariants (see renderText in src/render.ts):
 * - thickness: max(1, floor(fontSize / 10)) — matches Chrome exactly
 * - underline: centered 0.105em below baseline, pixel-snapped — exact
 * - line-through: 0.33em above baseline — Chrome uses the font's OS/2
 *   strikeout metric, which canvas can't read; ±2px is the achievable bound
 *   for a font-agnostic formula (Playfair vs Open Sans need different strike
 *   positions at identical measured x-height).
 */
import { describe, it, expect } from 'vitest';
import { compareRenders } from './helpers/compare.ts';
import { loadMultiFontCss, FONT_VARIANTS } from './helpers/test-cases.ts';

interface Band {
  center: number;
  thickness: number;
  x0: number;
  x1: number;
}

/** Locate the red decoration band: per-row red pixel counts → weighted center. */
function redBand(canvas: HTMLCanvasElement): Band | null {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const rowCounts = new Array(height).fill(0);
  let minX = Infinity;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a > 128 && r > 150 && r - g > 80 && r - b > 80) {
        rowCounts[y]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  const max = Math.max(...rowCounts);
  if (max === 0) return null;
  let wsum = 0, ws = 0;
  rowCounts.forEach((c, y) => { wsum += c * y; ws += c; });
  return { center: wsum / ws, thickness: ws / max, x0: minX, x1: maxX };
}

const FONTS = [
  { name: 'serif(default)', family: 'serif' },
  ...FONT_VARIANTS.map(f => ({ name: f.name, family: f.family })),
];
const SIZES = [16, 40, 64];

async function measure(deco: string, family: string, size: number) {
  const fontCss = await loadMultiFontCss();
  const html =
    `<div style="font-family: ${family}; font-size: ${size}px; color: black; margin: 0; padding: 0;">` +
    `<span style="text-decoration: ${deco}; text-decoration-color: red;">Hello World</span></div>`;
  const r = await compareRenders(html, fontCss, size * 14, size * 3, 0.1, 1);
  return { lib: redBand(r.libCanvas), dom: redBand(r.domCanvas) };
}

describe('underline geometry matches DOM', () => {
  for (const font of FONTS) {
    for (const size of SIZES) {
      it(`${font.name} @ ${size}px`, async () => {
        const { lib, dom } = await measure('underline', font.family, size);
        expect(lib, 'no underline rendered').not.toBeNull();
        expect(dom, 'no underline in DOM render').not.toBeNull();
        expect(Math.abs(lib!.center - dom!.center), 'y center').toBeLessThanOrEqual(0.6);
        expect(Math.abs(lib!.thickness - dom!.thickness), 'thickness').toBeLessThanOrEqual(0.6);
        expect(Math.abs(lib!.x0 - dom!.x0), 'x start').toBeLessThanOrEqual(2);
        expect(Math.abs(lib!.x1 - dom!.x1), 'x end').toBeLessThanOrEqual(2);
      });
    }
  }
});

describe('line-through geometry matches DOM', () => {
  for (const font of FONTS) {
    for (const size of SIZES) {
      it(`${font.name} @ ${size}px`, async () => {
        const { lib, dom } = await measure('line-through', font.family, size);
        expect(lib, 'no line-through rendered').not.toBeNull();
        expect(dom, 'no line-through in DOM render').not.toBeNull();
        expect(Math.abs(lib!.center - dom!.center), 'y center').toBeLessThanOrEqual(2);
        expect(Math.abs(lib!.thickness - dom!.thickness), 'thickness').toBeLessThanOrEqual(0.6);
        expect(Math.abs(lib!.x0 - dom!.x0), 'x start').toBeLessThanOrEqual(2);
        expect(Math.abs(lib!.x1 - dom!.x1), 'x end').toBeLessThanOrEqual(2);
      });
    }
  }
});
