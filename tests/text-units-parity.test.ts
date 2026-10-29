/**
 * Text units at rest — a `paintTextUnit` that only calls `draw()` — against `drawLayout`, over
 * the default-font corpus in this engine. Not pixel equality: a word unit paints its words
 * on their own (Blink run batching stays inside a unit, so kerning across a space can move
 * a glyph by a fraction of a pixel), each unit casts its shadow from its own mask, and bands
 * are clipped per unit. The gate is coarse on purpose: it catches a unit painter that drops,
 * repeats or misplaces paint (a lost underline or gradient, a glyph twice). Exact operation
 * parity at line level is gated in tests/node/text-units.test.ts. The grapheme level is
 * reported, not gated: a cut breaks ligatures, which changes real glyphs. Firefox is not a
 * lane: Gecko's canvas orders some one-fillText bidi lines unlike the layout ("Numbers and
 * currency in RTL"), so its plain draw differs where units follow the layout.
 *
 *   npx vitest run --project chromium tests/text-units-parity.test.ts
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { drawLayout, layout, type TextUnitLevel, type TextUnitPaint } from '../src/index.ts';
import { canvasFixtureHtml, compareCanvasPixels, prepareComparisonFonts } from './helpers/compare.ts';
import { loadCorpus } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';
import { makeCanvas } from './helpers/pixels.ts';
import { reportPath } from './helpers/report-path.ts';

const PIXEL_RATIO = 2;
/** The content-mismatch percentage a case may show at rest. */
const GATED_PERCENT: Partial<Record<TextUnitLevel, number>> = { line: 0, word: 0.05 };

describe('text units at rest paint as drawLayout', () => {
  for (const level of ['line', 'word', 'grapheme'] as const) {
    it(`${level} units`, async () => {
      const failures: string[] = [];
      const percents: [string, number][] = [];
      for (const { key, tc, css } of await loadCorpus({ fonts: [] })) {
        await prepareComparisonFonts(tc.html, css);
        const html = canvasFixtureHtml(tc.html, css);
        const result = layout({ html, width: tc.width, height: tc.height, textUnits: level });
        const plain = drawLayout({ layout: result, width: tc.width, pixelRatio: PIXEL_RATIO }).canvas as HTMLCanvasElement;
        const units = drawLayout({
          layout: result, width: tc.width, pixelRatio: PIXEL_RATIO, paintTextUnit: ({ draw }) => draw(),
        }).canvas as HTMLCanvasElement;
        const percent = compareCanvasPixels(plain, units).contentMismatchPercentage;
        percents.push([key, percent]);
        const gate = GATED_PERCENT[level];
        if (gate !== undefined && percent > gate) failures.push(`${key}: ${percent.toFixed(3)}%`);
      }
      percents.sort((x, y) => y[1] - x[1]);
      await commands.writeFile(reportPath(`text-units-${level}.${browserName}.txt`),
        percents.map(([k, p]) => `${p.toFixed(4)}%\t${k}`).join('\n') + '\n');
      expect(percents.length).toBeGreaterThan(50);
      expect(failures).toEqual([]);
    }, 300_000);
  }
});

/**
 * Units at rest against `drawLayout` over one underline, glyphs transparent (rotated glyphs drawn
 * one by one rasterize apart from the whole run's). A gap is a band pixel lighter than the
 * whole band's, a tick one darker; pixelmatch would pass either as antialiasing.
 */
function bandSeams(band: string, rotate: number, padding = 0) {
  const html = `<p style="margin:0;padding-left:${padding}px;font:24px serif;color:transparent;` +
    `text-decoration:underline ${band};text-decoration-thickness:6px">Hello brave new world of units</p>`;
  const result = layout({ html, width: 420, textUnits: 'grapheme' });
  const draw = (paintTextUnit?: (paint: TextUnitPaint) => void) => {
    const { ctx } = makeCanvas(520, 320);
    ctx.translate(60, 40);
    ctx.rotate(rotate);
    drawLayout({ layout: result, width: 420, ctx, pixelRatio: 1, paintTextUnit });
    return ctx.getImageData(0, 0, 520, 320).data;
  };
  const plain = draw(), units = draw(({ draw }) => draw());
  let gaps = 0, ticks = 0;
  for (let i = 3; i < plain.length; i += 4) {
    if (plain[i] - units[i] > 32) gaps++;
    if (units[i] - plain[i] > 32) ticks++;
  }
  return { gaps, ticks };
}

it('meets its neighbours\' bands without a seam', () => {
  // Rotated: an opaque band overlaps its neighbour's, a translucent one meets it edge to edge.
  expect(bandSeams('black', 0.3).gaps).toBe(0);
  // WebKit antialiases a clip edge a little into its neighbour: a few faint ticks at most.
  const translucent = bandSeams('rgba(0,0,0,0.5)', 0.3);
  expect(translucent.gaps + translucent.ticks).toBeLessThan(20);
  // At rest the fragment's own ends stay unclipped, whatever their device position.
  expect(bandSeams('black', 0, 0.7)).toEqual({ gaps: 0, ticks: 0 });
});
