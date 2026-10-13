/**
 * Where a SOLID decoration band sits and how thick it is, against the
 * engine's own raster: Chromium and WebKit, five pinned fonts, 10-64px, two
 * line-heights, DPR 1 and 2 (WebKit rounds a band's thickness on the device
 * grid). Each band's top is taken relative to the bottom ink row of
 * the black `H`s it decorates (the baseline), so the comparison is immune to
 * where each renderer put the line.
 *
 * One native capture per font × line-height × DPR holds every line × size
 * (`stackFixtures`); each case reads its own region, which rasterizes exactly
 * as a capture of its own would.
 *
 * The rules live in src/decoration.ts (`decorationBand`). Every row here is
 * exact except WebKit's line-through, which reads a font table canvas cannot
 * reach and is fitted (a CSS pixel of budget). Gecko is unmeasured: the
 * Firefox lane skips this file.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import type { ComparisonResult } from './helpers/compare.ts';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss, FONT_VARIANTS } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';
import { pixels, scanBand, stackFixtures, type Region, type Stack } from './helpers/decoration-scan.ts';

const FONTS = FONT_VARIANTS.map((f) => [f.name, f.family] as const);
const SIZES = [10, 13, 16, 17, 20, 25, 32, 40, 48, 64];
const LINES = ['underline', 'overline', 'line-through'] as const;
type Line = (typeof LINES)[number];

const lane = browserName === 'firefox' ? describe.skip : describe;

/** Captures the stack once for its describe block; a cold WebKit capture is slow. */
function capturedStack(stack: Stack, dpr: number): () => ComparisonResult {
  let result: ComparisonResult;
  beforeAll(async () => {
    result = await compareNativeRenders(stack.html, await loadMultiFontCss(), stack.width, stack.height, 0.1, dpr);
  }, 120_000);
  return () => result;
}

function expectSameBand(r: ComparisonResult, region: Region, line: Line, dpr: number): void {
  const lib = scanBand(pixels(r.libCanvas, region, dpr));
  const dom = scanBand(pixels(r.domCanvas, region, dpr));
  expect(lib.rows, 'thickness (device px)').toBe(dom.rows);
  const budget = browserName === 'webkit' && line === 'line-through' ? dpr : 0;
  expect(Math.abs((lib.top - lib.baseline) - (dom.top - dom.baseline)), 'band top below the baseline')
    .toBeLessThanOrEqual(budget);
}

lane('solid decoration bands sit where the engine puts them', () => {
  for (const dpr of [1, 2]) for (const [name, family] of FONTS) for (const lineHeight of ['normal', '2']) {
    const cases = LINES.flatMap((line) => SIZES.map((size) => ({ line, size })));
    const stack = stackFixtures(cases.map(({ line, size }) => ({
      html:
        `<div style="font-family:${family};font-size:${size}px;line-height:${lineHeight};color:black;padding:4px 0 0 4px">` +
        `<span style="text-decoration:${line} red;text-decoration-skip-ink:none">HHHHHH</span></div>`,
      width: size * 6,
      height: size * 3,
    })));
    describe(`${name} line-height:${lineHeight}, DPR ${dpr}`, () => {
      const captured = capturedStack(stack, dpr);
      it.each(cases.map(({ line, size }, index) => [line, size, index] as const))(
        `${name} %s line-height:${lineHeight} @ %ipx, DPR ${dpr}`,
        (line, _size, index) => expectSameBand(captured(), stack.regions[index], line, dpr),
      );
    });
  }
});

// An EXPLICIT thickness: Blink paints round(T) rows and moves the underline
// down by ceil(T/2); WebKit rounds T up on the device grid, like its auto
// thickness, and keeps its auto underline position. 0.2em at 32px is 6.4px.
const THICKNESSES = ['1px', '2.5px', '3px', '0.2em', '7px'];

lane('explicit-thickness bands sit where the engine puts them', () => {
  for (const dpr of [1, 2]) for (const [name, family] of FONTS.slice(0, 3)) {
    const cases = LINES.flatMap((line) => THICKNESSES.map((thickness) => ({ line, thickness })));
    const stack = stackFixtures(cases.map(({ line, thickness }) => ({
      html:
        // Room below: a 7px underline hangs past the line box.
        `<div style="font-family:${family};font-size:32px;color:black;padding:12px 0 24px 4px">` +
        `<span style="text-decoration:${line} red;text-decoration-thickness:${thickness};text-decoration-skip-ink:none">HHHHHH</span></div>`,
      width: 32 * 6,
      height: 32 * 4,
    })));
    describe(`${name} 32px explicit thickness, DPR ${dpr}`, () => {
      const captured = capturedStack(stack, dpr);
      it.each(cases.map(({ line, thickness }, index) => [line, thickness, index] as const))(
        `${name} %s 32px thickness %s, DPR ${dpr}`,
        (line, _thickness, index) => expectSameBand(captured(), stack.regions[index], line, dpr),
      );
    });
  }
});
