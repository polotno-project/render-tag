/**
 * Where Blink PAINTS a line, against its own DOM raster.
 *
 * Blink lays lines out on fractional positions (a 1.6 line-height steps
 * 25.59375px), and render-tag matches that layout to ~0.01px. But it paints
 * each line box at a WHOLE CSS pixel: the line top rounds (half up), and
 * everything inside the line keeps its laid-out offset. A canvas only lands
 * `fillText` on a DEVICE pixel, so at DPR 2 and 3 render-tag painted text up
 * to half a pixel off a line Chrome had moved onto the grid — visible as a
 * doubled edge on every glyph (see `SNAPS_LINE_PAINT`).
 *
 * Each case sweeps the line top through k/16px (Blink's layout unit is 1/64,
 * so these land exactly), at DPR 1, 2 and 3, in every pinned font.
 *
 * Chromium only: WebKit snaps to a DEVICE pixel instead (not modelled), and
 * Gecko is unmeasured.
 */
import { describe, it, expect } from 'vitest';
import { layout, drawLayout } from '../src/index.ts';
import { canvasFixtureHtml, compareCanvasPixels, prepareComparisonFonts } from './helpers/compare.ts';
import { renderToNativeDOM } from './helpers/native-compare.ts';
import {
  loadBasicCases, loadMultiFontCss, keepUsedFontFaces, FONT_VARIANTS, TEST_FALLBACK_STACK,
} from './helpers/test-cases.ts';

const FAMILIES = [
  { name: 'default', family: `'Open Sans', ${TEST_FALLBACK_STACK}, sans-serif` },
  ...FONT_VARIANTS,
];
const DPRS = [1, 2, 3];
const TOPS = [0, 3, 6, 8, 9, 12, 15].map((k) => k / 16);
const WIDTH = 260;
const HEIGHT = 110;

interface Rendered { dom: HTMLCanvasElement; lib: HTMLCanvasElement }

async function renderBoth(body: string, family: string, size: number, top: number, dpr: number): Promise<Rendered> {
  const css = (await loadMultiFontCss()) +
    `\nbody{font-family:${family};font-size:${size}px;margin:0}`;
  const html = `<div style="padding:${top}px 0 0 20px;line-height:1.37">${body}</div>`;
  const fixtureCss = keepUsedFontFaces(css, html);
  await prepareComparisonFonts(html, css);
  const dom = await renderToNativeDOM(html, fixtureCss, WIDTH, HEIGHT, dpr);
  const result = layout({ html: canvasFixtureHtml(html, fixtureCss), width: WIDTH, height: HEIGHT });
  const lib = drawLayout({ layout: result, width: WIDTH, pixelRatio: dpr }).canvas as HTMLCanvasElement;
  return { dom, lib };
}

/** First and last device-pixel rows holding ink that `match` accepts. */
function inkRows(canvas: HTMLCanvasElement, match: (r: number, g: number, b: number) => boolean) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let first = -1, last = -1;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128 && match(data[i], data[i + 1], data[i + 2])) count++;
    }
    // A few stray antialiased pixels are not the row the glyphs stand on.
    if (count > 3) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return { first, last };
}

const dark = (r: number, g: number, b: number) => r < 110 && g < 110 && b < 110;
const red = (r: number, g: number, b: number) => r > 150 && r - g > 80 && r - b > 80;

describe('Blink paints each line box at a whole CSS pixel', () => {
  // Three lines at a fractional pitch, under a fractional top: every line's
  // fraction differs, so a rule that only rounds the first line fails.
  it('a wrapped paragraph matches the DOM raster exactly', async () => {
    await loadBasicCases();
    const failures: string[] = [];
    for (const dpr of DPRS) for (const font of FAMILIES) for (const top of TOPS) {
      const { dom, lib } = await renderBoth(
        '<div style="width:150px;line-height:1.6">alpha beta gamma delta epsilon zeta eta theta</div>',
        font.family, 16, top, dpr);
      const { mismatchedPixels } = compareCanvasPixels(dom, lib);
      if (mismatchedPixels !== 0) failures.push(`${font.name} dpr=${dpr} top=${top}: ${mismatchedPixels}px`);
    }
    expect(failures).toEqual([]);
  }, 300_000);

  // A shifted run follows its LINE's snap, keeping its own fractional offset:
  // rounding the run's own baseline puts `sub` (fontSize/5 + 1 = 4.2px) and a
  // -2.7px shift a pixel off. Only the shifted run is painted, in glyphs that
  // all stand on the baseline, so the last ink row IS the painted baseline.
  // (The top row is not compared: Blink rasterizes the smaller sub/sup font
  // one antialiased row taller in some fonts, at any position.)
  for (const [name, body] of [
    ['sub', '<span style="color:transparent">Text </span><sub>sub</sub>'],
    ['super', '<span style="color:transparent">Text </span><sup>sup</sup>'],
    ['length', '<span style="color:transparent">Text </span><span style="vertical-align:-2.7px">dn</span>'],
  ] as const) {
    it(`a vertical-align: ${name} run lands on the DOM's rows`, async () => {
      await loadBasicCases();
      const failures: string[] = [];
      for (const dpr of DPRS) for (const font of FAMILIES) for (const top of TOPS) {
        const { dom, lib } = await renderBoth(body, font.family, 23, top, dpr);
        const want = inkRows(dom, dark).last, got = inkRows(lib, dark).last;
        if (want !== got) failures.push(`${font.name} dpr=${dpr} top=${top}: baseline row ${got}, DOM ${want}`);
      }
      expect(failures).toEqual([]);
    }, 300_000);
  }

  // The auto underline hangs ceil(fontSize / 20) below the SNAPPED baseline
  // (BLINK_UNDERLINE_GAP): sizes either side of each step.
  it('an auto underline lands on the DOM band rows', async () => {
    await loadBasicCases();
    const failures: string[] = [];
    for (const dpr of [1, 2]) for (const font of FAMILIES) for (const size of [12, 20, 21, 40, 44, 64]) {
      for (const top of [0, 6 / 16, 9 / 16]) {
        const { dom, lib } = await renderBoth(
          '<span style="color:transparent;text-decoration:underline;text-decoration-color:red">Hello World</span>',
          font.family, size, top, dpr);
        const want = inkRows(dom, red), got = inkRows(lib, red);
        if (want.first !== got.first || want.last !== got.last) {
          failures.push(`${font.name} ${size}px dpr=${dpr} top=${top}: rows ${got.first}-${got.last}, DOM ${want.first}-${want.last}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
