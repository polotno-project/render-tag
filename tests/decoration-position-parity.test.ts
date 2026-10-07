/**
 * Where a SOLID decoration band sits and how thick it is, against the
 * engine's own raster: Chromium and WebKit, five pinned fonts, 10-64px, two
 * line-heights, DPR 1 and 2 (WebKit rounds a band's thickness on the device
 * grid). Each band's top is taken relative to the bottom ink row of
 * the black `H`s it decorates (the baseline), so the comparison is immune to
 * where each renderer put the line.
 *
 * The rules live in src/decoration.ts (`decorationBand`). Every row here is
 * exact except WebKit's line-through, which reads a font table canvas cannot
 * reach and is fitted (a CSS pixel of budget). Gecko is unmeasured: the
 * Firefox lane skips this file.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss, FONT_VARIANTS } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';

interface Scan { top: number; rows: number; baseline: number }

function scan(canvas: HTMLCanvasElement): Scan {
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

const FONTS = FONT_VARIANTS.map((f) => [f.name, f.family] as const);
const SIZES = [10, 13, 16, 17, 20, 25, 32, 40, 48, 64];
const LINES = ['underline', 'overline', 'line-through'] as const;

const lane = browserName === 'firefox' ? describe.skip : describe;

lane('solid decoration bands sit where the engine puts them', () => {
  for (const dpr of [1, 2]) for (const [name, family] of FONTS) for (const line of LINES) for (const lineHeight of ['normal', '2']) {
    it.each(SIZES)(`${name} ${line} line-height:${lineHeight} @ %ipx, DPR ${dpr}`, async (size) => {
      const css = await loadMultiFontCss();
      const html =
        `<div style="font-family:${family};font-size:${size}px;line-height:${lineHeight};color:black;padding:4px 0 0 4px">` +
        `<span style="text-decoration:${line} red;text-decoration-skip-ink:none">HHHHHH</span></div>`;
      const r = await compareNativeRenders(html, css, size * 6, size * 3, 0.1, dpr);
      const lib = scan(r.libCanvas), dom = scan(r.domCanvas);
      expect(lib.rows, 'thickness (device px)').toBe(dom.rows);
      const budget = browserName === 'webkit' && line === 'line-through' ? dpr : 0;
      expect(Math.abs((lib.top - lib.baseline) - (dom.top - dom.baseline)), 'band top below the baseline')
        .toBeLessThanOrEqual(budget);
    });
  }
});

// An EXPLICIT thickness: Blink paints round(T) rows and moves the underline
// down by ceil(T/2); WebKit rounds T up on the device grid, like its auto
// thickness, and keeps its auto underline position. 0.2em at 32px is 6.4px.
const THICKNESSES = ['1px', '2.5px', '3px', '0.2em', '7px'];

lane('explicit-thickness bands sit where the engine puts them', () => {
  for (const dpr of [1, 2]) for (const [name, family] of FONTS.slice(0, 3)) for (const line of LINES) {
    it.each(THICKNESSES)(`${name} ${line} 32px thickness %s, DPR ${dpr}`, async (thickness) => {
      const css = await loadMultiFontCss();
      const html =
        // Room below: a 7px underline hangs past the line box.
        `<div style="font-family:${family};font-size:32px;color:black;padding:12px 0 24px 4px">` +
        `<span style="text-decoration:${line} red;text-decoration-thickness:${thickness};text-decoration-skip-ink:none">HHHHHH</span></div>`;
      const r = await compareNativeRenders(html, css, 32 * 6, 32 * 4, 0.1, dpr);
      const lib = scan(r.libCanvas), dom = scan(r.domCanvas);
      expect(lib.rows, 'thickness (device px)').toBe(dom.rows);
      const budget = browserName === 'webkit' && line === 'line-through' ? dpr : 0;
      expect(Math.abs((lib.top - lib.baseline) - (dom.top - dom.baseline)), 'band top below the baseline')
        .toBeLessThanOrEqual(budget);
    });
  }
});
