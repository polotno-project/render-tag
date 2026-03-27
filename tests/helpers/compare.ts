import pixelmatch from 'pixelmatch';
import { htmlToImage } from 'html-to-svg';
import { renderHTML } from '../../src/index.ts';

export interface ComparisonResult {
  mismatchedPixels: number;
  totalPixels: number;
  contentPixels: number;
  mismatchPercentage: number;
  contentMismatchPercentage: number;
  domCanvas: HTMLCanvasElement;
  libCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  referenceTime: number;
  canvasLibTime: number;
}

/**
 * Render HTML+CSS using html-to-svg (foreignObject-based, pixel-perfect with browser).
 */
export async function renderToDOM(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): Promise<HTMLCanvasElement> {
  const pixelWidth = Math.ceil(width * pixelRatio);
  const pixelHeight = Math.ceil(height * pixelRatio);

  const fullHTML = `<div style="margin:0;padding:0">${html}</div>`;
  const fullCSS = `html, body { margin: 0; padding: 0; }\n${css || ''}`;

  const img = await htmlToImage({
    html: fullHTML,
    css: fullCSS,
    width,
    height,
    pixelRatio,
  });

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);

  return canvas;
}

/**
 * Render HTML using our library.
 */
export async function renderToCanvas(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): Promise<HTMLCanvasElement> {
  const { canvas } = await renderHTML(html, {
    width,
    height,
    css,
    pixelRatio,
  });
  return canvas;
}

/**
 * Pad an ImageData to target dimensions (filling with white).
 */
function padImageData(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  if (imageData.width === targetWidth && imageData.height === targetHeight) {
    return imageData;
  }

  const padded = new ImageData(targetWidth, targetHeight);
  // Fill with white
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;     // R
    padded.data[i + 1] = 255; // G
    padded.data[i + 2] = 255; // B
    padded.data[i + 3] = 255; // A
  }

  // Copy original data
  for (let y = 0; y < imageData.height && y < targetHeight; y++) {
    for (let x = 0; x < imageData.width && x < targetWidth; x++) {
      const srcIdx = (y * imageData.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      padded.data[dstIdx] = imageData.data[srcIdx];
      padded.data[dstIdx + 1] = imageData.data[srcIdx + 1];
      padded.data[dstIdx + 2] = imageData.data[srcIdx + 2];
      padded.data[dstIdx + 3] = imageData.data[srcIdx + 3];
    }
  }

  return padded;
}

/**
 * Compare rasterizeHTML rendering with our canvas rendering using pixelmatch.
 */
export async function compareRenders(
  html: string,
  css: string,
  width: number,
  height: number,
  threshold = 0.1,
  pixelRatio = 1,
): Promise<ComparisonResult> {
  const t0 = performance.now();
  const domCanvas = await renderToDOM(html, css, width, height, pixelRatio);
  const t1 = performance.now();
  const libCanvas = await renderToCanvas(html, css, width, height, pixelRatio);
  const t2 = performance.now();
  const referenceTime = t1 - t0;
  const canvasLibTime = t2 - t1;

  // Get image data from both
  const domCtx = domCanvas.getContext('2d')!;
  const libCtx = libCanvas.getContext('2d')!;

  // Use the larger dimensions
  const w = Math.max(domCanvas.width, libCanvas.width);
  const h = Math.max(domCanvas.height, libCanvas.height);

  const domData = padImageData(
    domCtx.getImageData(0, 0, domCanvas.width, domCanvas.height), w, h);
  const libData = padImageData(
    libCtx.getImageData(0, 0, libCanvas.width, libCanvas.height), w, h);

  const diffData = new ImageData(w, h);
  const mismatchedPixels = pixelmatch(
    domData.data, libData.data, diffData.data,
    w, h,
    { threshold },
  );

  // Count content pixels: non-white in either image
  let contentPixels = 0;
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const domIsWhite = domData.data[idx] === 255 && domData.data[idx + 1] === 255 &&
      domData.data[idx + 2] === 255 && domData.data[idx + 3] === 255;
    const libIsWhite = libData.data[idx] === 255 && libData.data[idx + 1] === 255 &&
      libData.data[idx + 2] === 255 && libData.data[idx + 3] === 255;
    // Also treat fully transparent as empty
    const domIsEmpty = domIsWhite || domData.data[idx + 3] === 0;
    const libIsEmpty = libIsWhite || libData.data[idx + 3] === 0;
    if (!domIsEmpty || !libIsEmpty) {
      contentPixels++;
    }
  }

  // Create diff canvas
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = w;
  diffCanvas.height = h;
  diffCanvas.getContext('2d')!.putImageData(diffData, 0, 0);

  const totalPixels = w * h;
  // Use content pixels for mismatch %, with a floor to avoid division by zero
  const effectiveContent = Math.max(contentPixels, 1);

  return {
    mismatchedPixels,
    totalPixels,
    contentPixels,
    mismatchPercentage: (mismatchedPixels / totalPixels) * 100,
    contentMismatchPercentage: (mismatchedPixels / effectiveContent) * 100,
    domCanvas,
    libCanvas,
    diffCanvas,
    referenceTime,
    canvasLibTime,
  };
}
