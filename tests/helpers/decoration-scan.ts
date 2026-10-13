/** A fixture's rectangle inside a stacked capture, in CSS px. */
export interface Region {
  y: number;
  width: number;
  height: number;
}

export interface Stack {
  html: string;
  width: number;
  height: number;
  /** One per block, in block order. */
  regions: Region[];
}

/**
 * Stack independent fixtures into ONE native capture. Each block sits in its
 * own box the size of its standalone canvas, at an integer offset, so its
 * layout and raster are those of a capture of its own (`min-height`, not
 * `height`: render-tag has no `height`, and no block here outgrows its box).
 * The gap below each box takes what a renderer paints past the NEXT box's
 * top (a 64px overline starts 2px above it): the engine clips that at the
 * box, as the canvas edge did standalone, but render-tag has no overflow
 * clipping. Never stack fonts: the pruned face set (`keepUsedFontFaces`)
 * would change.
 */
export function stackFixtures(
  blocks: { html: string; width: number; height: number }[],
  gap = 8,
): Stack {
  const regions: Region[] = [];
  let y = 0;
  const html = blocks.map((block) => {
    regions.push({ y, width: block.width, height: block.height });
    y += block.height + gap;
    return (
      `<div style="width:${block.width}px;min-height:${block.height}px;` +
      `padding-bottom:${gap}px;overflow:hidden">${block.html}</div>`
    );
  }).join('');
  return { html, width: Math.max(...blocks.map((block) => block.width)), height: y, regions };
}

/** The device pixels of one region of a capture (default: all of it). */
export function pixels(canvas: HTMLCanvasElement, region?: Region, dpr = 1): ImageData {
  const context = canvas.getContext('2d')!;
  if (!region) return context.getImageData(0, 0, canvas.width, canvas.height);
  return context.getImageData(0, region.y * dpr, region.width * dpr, region.height * dpr);
}

export interface BandScan {
  /** First device-pixel row of the red band. */
  top: number;
  /** Red rows: the band's thickness in device px. */
  rows: number;
  /** One past the last row of black ink: the baseline of the decorated `H`s. */
  baseline: number;
}

/** A solid red decoration band over black `H` glyphs, read off a raster. */
export function scanBand(source: HTMLCanvasElement | ImageData): BandScan {
  const { width, height, data: d } = source instanceof ImageData ? source : pixels(source);
  const red: number[] = [];
  let ink = -1;
  for (let y = 0; y < height; y++) {
    let r = 0, k = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (d[i + 3] <= 128) continue;
      if (d[i] > 150 && d[i] - d[i + 1] > 80) r++;
      else if (d[i] < 90 && d[i + 1] < 90) k++;
    }
    if (r > 20) red.push(y);
    if (k > 3) ink = y;
  }
  return { top: red[0], rows: red.length, baseline: ink + 1 };
}
