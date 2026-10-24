/**
 * Pixel counting for the paint suites. A predicate's thresholds are part of
 * its suite's assertions, so a suite whose predicate differs keeps its own.
 */
export type RgbPredicate = (r: number, g: number, b: number) => boolean;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

/** Pixels in `rect` (default: the whole canvas) with alpha >= 128 that match `predicate`. */
export function countPixels(canvas: HTMLCanvasElement, predicate: RgbPredicate, rect?: Rect): number {
  const { x, y, w, h } = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const data = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

/** `countPixels` over the whole canvas, where near-white (r, g and b > 240) never counts. */
export function countColoredPixels(canvas: HTMLCanvasElement, predicate: RgbPredicate): number {
  return countPixels(canvas, (r, g, b) => !(r > 240 && g > 240 && b > 240) && predicate(r, g, b));
}

/** Every pixel whose RGBA matches, transparent ones included. */
export function countMatching(
  canvas: HTMLCanvasElement,
  predicate: (r: number, g: number, b: number, a: number) => boolean,
): number {
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) count++;
  }
  return count;
}

export const isAny: RgbPredicate = () => true;
export const isWhite: RgbPredicate = (r, g, b) => r > 240 && g > 240 && b > 240;
export const isRed: RgbPredicate = (r, g, b) => r > 150 && g < 100 && b < 100;
export const isBlue: RgbPredicate = (r, g, b) => b > 150 && r < 100 && g < 100;
export const isReddish: RgbPredicate = (r, g, b) => r > 130 && g < 110 && b < 110;
export const isGreenish: RgbPredicate = (r, g, b) => g > 150 && b < 120;
/** The magenta end-stop of the stroke-gradient suites, rgb(212, 0, 255). */
export const isMagenta: RgbPredicate = (r, g, b) => r > 140 && g < 90 && b > 140;
/** Opaque red stroke ink, for `countMatching`. */
export const isOpaqueRed = (r: number, g: number, b: number, a: number) =>
  a > 200 && r > 150 && g < 80 && b < 80;
