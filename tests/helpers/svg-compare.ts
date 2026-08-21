import { htmlToImage } from 'html-to-svg';
import {
  compareRendersWithReference,
  type ComparisonResult,
} from './compare.ts';

/** Render through the demo's optional SVG foreignObject path. */
export async function renderToSvg(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): Promise<HTMLCanvasElement> {
  const pixelWidth = Math.ceil(width * pixelRatio);
  const pixelHeight = Math.ceil(height * pixelRatio);
  const fullHTML = `<div style="margin:0;padding:0;overflow:hidden">${html}</div>`;
  const fullCSS = `html, body { margin: 0; padding: 0; }\n${css || ''}`;
  const image = await htmlToImage({
    html: fullHTML,
    css: fullCSS,
    width,
    height,
    pixelRatio,
  });

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.getContext('2d')!.drawImage(image, 0, 0, pixelWidth, pixelHeight);
  return canvas;
}

/** Compare against the optional SVG reference used by the demo. */
export function compareSvgRenders(
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
    renderToSvg,
  );
}
