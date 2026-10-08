export interface BandScan {
  /** First device-pixel row of the red band. */
  top: number;
  /** Red rows: the band's thickness in device px. */
  rows: number;
  /** One past the last row of black ink: the baseline of the decorated `H`s. */
  baseline: number;
}

/** A solid red decoration band over black `H` glyphs, read off a raster. */
export function scanBand(canvas: HTMLCanvasElement): BandScan {
  const { width, height } = canvas;
  const d = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
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
