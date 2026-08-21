import { describe, expect, it } from 'vitest';
import singleWeightFontUrl from '@fontsource/lobster/files/lobster-latin-400-normal.woff2?url';
import { compareCanvasPixels } from './helpers/compare.ts';
import { renderToNativeDOM } from './helpers/native-compare.ts';
import { renderToSvg } from './helpers/svg-compare.ts';

describe('SVG demo reference parity', () => {
  it('does not change a single-weight face while inlining it', async () => {
    const css = `
      @font-face {
        font-family: 'RT Single Weight';
        font-style: normal;
        font-weight: 400;
        src: url('${new URL(singleWeightFontUrl, location.href).href}') format('woff2');
      }
      body {
        font-family: 'RT Single Weight';
        font-size: 36px;
        line-height: 44px;
        font-weight: 700;
      }
    `;
    const args = ['Synthetic bold must stay synthetic', css, 700, 100, 2] as const;
    const [nativeCanvas, svgCanvas] = await Promise.all([
      renderToNativeDOM(...args),
      renderToSvg(...args),
    ]);
    const { mismatchedPixels } = compareCanvasPixels(nativeCanvas, svgCanvas);

    expect(mismatchedPixels).toBeLessThanOrEqual(1);
  });
});
