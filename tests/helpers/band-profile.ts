/**
 * Band-profile toolkit shared by the decoration-geometry suites
 * (decorating-box-geometry.test.ts, decoration-offset-thickness.test.ts).
 *
 * Decoration bands are compared as PROFILES — the red band's center and
 * thickness per pixel column, canvas against the live DOM — so no fixed
 * sampling window has to be kept in step with the text metrics, and a step
 * is caught wherever it falls. Centers are reported relative to the lowest
 * glyph-ink row (`baselineRow`), which cancels the sub-pixel line-layout
 * difference between the canvas and the DOM.
 */
import { expect } from 'vitest';

export interface Column {
  center: number;
  thickness: number;
}

/** The red-band pixel predicate, shared by every scanner below. */
const isRed = (data: Uint8ClampedArray, i: number): boolean =>
  data[i + 3] > 128 &&
  data[i] > 150 &&
  data[i] - data[i + 1] > 80 &&
  data[i] - data[i + 2] > 80;

/** The red band's center and thickness per pixel column; null where absent. */
export function profile(canvas: HTMLCanvasElement): (Column | null)[] {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const columns: (Column | null)[] = [];
  for (let x = 0; x < width; x++) {
    const rows: number[] = [];
    for (let y = 0; y < height; y++) {
      if (isRed(data, (y * width + x) * 4)) rows.push(y);
    }
    columns.push(
      rows.length
        ? { center: (rows[0] + rows[rows.length - 1]) / 2, thickness: rows.length }
        : null,
    );
  }
  return columns;
}

/** Red row-run clusters of the whole canvas — one entry per distinct band. */
export function bandClusters(
  canvas: HTMLCanvasElement,
): { top: number; center: number; thickness: number }[] {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const isBandRow: boolean[] = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) {
      if (isRed(data, (y * width + x) * 4)) n++;
    }
    isBandRow.push(n > 20);
  }
  const clusters: { top: number; center: number; thickness: number }[] = [];
  let start = -1;
  for (let y = 0; y <= height; y++) {
    if (y < height && isBandRow[y]) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      clusters.push({ top: start, center: (start + y - 1) / 2, thickness: y - start });
      start = -1;
    }
  }
  return clusters;
}

/**
 * The shared alphabetic baseline proxy: the lowest glyph-ink row. Use sample
 * text without descenders so it IS the baseline. Band centers are reported
 * relative to it.
 */
export function baselineRow(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128 && data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) return y;
    }
  }
  throw new Error('no glyphs rendered');
}

/** Columns where both renders drew a band — the comparable ones. */
export function shared(lib: (Column | null)[], dom: (Column | null)[]): number[] {
  const xs: number[] = [];
  for (let x = 0; x < Math.min(lib.length, dom.length); x++) {
    if (lib[x] && dom[x]) xs.push(x);
  }
  expect(xs.length, 'no comparable band columns').toBeGreaterThan(20);
  return xs;
}

/** Widest gap between the canvas band and the DOM band, over shared columns. */
export function maxCenterDrift(lib: (Column | null)[], dom: (Column | null)[]): number {
  return Math.max(...shared(lib, dom).map((x) => Math.abs(lib[x]!.center - dom[x]!.center)));
}

/** Mean band center, for comparing one render against another. */
export function bandY(p: (Column | null)[]): number {
  const centers = p.filter((c): c is Column => c !== null).map((c) => c.center);
  return centers.reduce((a, b) => a + b, 0) / centers.length;
}

/** How far the band moves across its own run — 0 for a flat band. */
export function spread(p: (Column | null)[]): number {
  const centers = p.filter((c): c is Column => c !== null).map((c) => c.center);
  return Math.max(...centers) - Math.min(...centers);
}

/** Every thickness the band takes, low to high. */
export function thicknesses(p: (Column | null)[]): number[] {
  return [...new Set(p.filter((c): c is Column => c !== null).map((c) => c.thickness))].sort(
    (a, b) => a - b,
  );
}
