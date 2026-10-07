/**
 * A text-shadow is cast from the glyphs' SHAPE, in the shadow's own color:
 * the text's fill alpha does not reach it. `color: transparent` text still
 * casts a full shadow (the "blurred text" idiom), a 40%-alpha fill casts a
 * solid shadow, and a stroked transparent glyph casts a FILLED shadow.
 * Blink casts it from the fill alone — a wide stroke hides most of it —
 * while WebKit's includes the stroke (`STROKE_CASTS_TEXT_SHADOW`); the 6px
 * rows tell the two apart.
 * Measured against the engine's own raster (Chromium, WebKit); Gecko is
 * unverified — the Firefox lane does not run this file.
 */
import { describe, expect, it } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';

/** Total coverage of pixels whose color is close to `rgb`, alpha-weighted. */
function coverage(canvas: HTMLCanvasElement, rgb: [number, number, number]): number {
  const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (Math.abs(d[i] - rgb[0]) + Math.abs(d[i + 1] - rgb[1]) + Math.abs(d[i + 2] - rgb[2]) > 60) continue;
    sum += d[i + 3];
  }
  return sum;
}

const CASES: [name: string, style: string, shadow: [number, number, number]][] = [
  ['transparent text, blurred shadow', 'color:transparent;text-shadow:0 0 6px black', [0, 0, 0]],
  ['40% alpha text, solid shadow', 'color:rgba(255,0,0,.4);text-shadow:4px 4px 0 blue', [0, 0, 255]],
  ['stroked transparent text', 'color:transparent;-webkit-text-stroke:2px blue;text-shadow:4px 4px 0 red', [255, 0, 0]],
  ['6px stroke, transparent fill', 'color:transparent;-webkit-text-stroke:6px blue;text-shadow:4px 4px 0 red', [255, 0, 0]],
  ['6px stroke, opaque fill', 'color:yellow;-webkit-text-stroke:6px blue;text-shadow:4px 4px 0 red', [255, 0, 0]],
  ['6px stroke, 50% fill', 'color:rgba(0,255,0,.5);-webkit-text-stroke:6px blue;text-shadow:4px 4px 0 red', [255, 0, 0]],
  // The fill hides the shadow except where the 0.1em = 4px offset shows it.
  ['em offsets, opaque fill', 'color:black;text-shadow:0.1em 0.1em 0 red', [255, 0, 0]],
  ['6px stroke, transparent -webkit-text-fill-color', 'color:green;-webkit-text-fill-color:transparent;-webkit-text-stroke:6px blue;text-shadow:4px 4px 0 red', [255, 0, 0]],
];

describe('text-shadow coverage ignores the fill alpha', () => {
  for (const [name, style, rgb] of CASES) {
    it(name, async () => {
      const css = await loadMultiFontCss();
      const html = `<div style="font-family:'Open Sans';font-size:40px;font-weight:bold;padding:10px;${style}">Shadow MW</div>`;
      const r = await compareNativeRenders(html, css, 320, 80, 0.1, 1);
      const dom = coverage(r.domCanvas, rgb), lib = coverage(r.libCanvas, rgb);
      expect(dom).toBeGreaterThan(10000);
      expect(lib / dom, `lib ${lib} vs dom ${dom}`).toBeGreaterThan(0.9);
      expect(lib / dom, `lib ${lib} vs dom ${dom}`).toBeLessThan(1.1);
    });
  }
});
