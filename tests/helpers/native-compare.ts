import { commands } from 'vitest/browser';
import {
  compareRendersWithReference,
  type ComparisonResult,
} from './compare.ts';

export async function decodePng(base64: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return canvas;
}

/** Render the fixture in an isolated real browser page and decode its PNG. */
export async function renderToNativeDOM(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): Promise<HTMLCanvasElement> {
  return decodePng(await commands.captureNativeDom({
    html,
    css,
    width,
    height,
    pixelRatio,
  }));
}

/** Compare render-tag against independent native DOM paint. */
export function compareNativeRenders(
  html: string,
  css: string,
  width: number,
  height: number,
  threshold = 0.1,
  pixelRatio = 1,
): Promise<ComparisonResult> {
  return compareRendersWithReference(
    html,
    css,
    width,
    height,
    threshold,
    pixelRatio,
    renderToNativeDOM,
    true,
  );
}
