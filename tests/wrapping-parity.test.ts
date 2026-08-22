import { expect, it } from 'vitest';
import {
  compareWrapping,
  prepareComparisonFonts,
  warmNativeLayout,
} from './helpers/compare.ts';
import {
  FONT_VARIANTS,
  loadBasicCases,
  loadMultiFontCss,
} from './helpers/test-cases.ts';

const RESET = 'html, body { margin: 0; padding: 0; }';

it('matches native flex automatic minimum sizing', () => {
  const html = `
    <div class="columns">
      <div>Our platform comprehensive</div>
      <div>Our platform comprehensive</div>
    </div>
  `;
  const css = `${RESET}
    body { font: 16px sans-serif; }
    .columns { display: flex; gap: 20px; }
    .columns > div { flex: 1; }
  `;

  const result = compareWrapping(html, css, 100, 300);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});

it('wraps inside a shrink-to-fit inline-block like the native DOM', () => {
  const html = '<span class="tag">Web Development</span>';
  const css = `${RESET}
    body { font: 12px sans-serif; }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      margin-right: 6px;
    }
  `;

  const result = compareWrapping(html, css, 100, 100);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});

it.each([
  {
    width: 90,
    html: `<div style="font-size:40px;font-family:'Roboto',sans-serif;line-height:1.2;white-space:pre-wrap;overflow-wrap:break-word">well-being internationalization Vibes<span style="font-size:.6em"> Da</span>nce Moonlight Glow and</div>`,
  },
  {
    width: 130,
    html: `<div style="font-size:40px;font-family:'Roboto',sans-serif;line-height:1.2;text-align:center;overflow-wrap:break-word">celebrate Festiva<i style="font-size:.6em">l </i>wonderful</div>`,
  },
  {
    width: 130,
    html: `<div style="font-size:70px;font-family:'Roboto',sans-serif;line-height:1.2;text-align:right;overflow-wrap:break-word">wonderful Moon<strong>light </strong>Glow Night well-being Music</div>`,
  },
])('matches native break-word flow at $width px', ({ html, width }) => {
  const result = compareWrapping(html, '', width, 1000);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});

it.each([
  ['Line-height variations', 425],
  ['RTL with embedded numbers', 160],
  ['URL text wrapping', 165],
  ['Dense emoji sequences', 96],
  ['Long CJK paragraph', 193],
  ['Mixed CJK and Latin text', 248],
  ['Mixed app text comprehensive', 144],
  ['Mixed app text comprehensive', 189],
] as const)('matches native structural wrapping for %s at %d px', async (name, width) => {
  const testCase = (await loadBasicCases()).find((item) => item.name === name)!;
  await prepareComparisonFonts(testCase.html, testCase.css);
  warmNativeLayout(testCase.html, testCase.css, testCase.width);
  const result = compareWrapping(testCase.html, testCase.css, width, testCase.height);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});

it.each([
  ['URL text wrapping', 'Roboto', 165],
  ['Letter spacing and word spacing', 'Playfair Display', 160],
  ['Letter spacing and word spacing', 'Merriweather', 210],
  ['Letter spacing and word spacing', 'Lobster', 275],
  ['Korean Hangul text', 'Lobster', 280],
  ['Mixed CJK and Latin text', 'Open Sans', 248],
  ['Mixed CJK and Latin text', 'Playfair Display', 248],
] as const)('matches native structural wrapping for %s in %s at %d px', async (
  caseName,
  fontName,
  width,
) => {
  const testCase = (await loadBasicCases()).find(
    (item) => item.name === caseName,
  )!;
  const font = FONT_VARIANTS.find((item) => item.name === fontName)!;
  const css = `${await loadMultiFontCss()}\n${testCase.css}\n` +
    `body { font-family: ${font.family} !important; }`;
  await prepareComparisonFonts(testCase.html, css);

  const result = compareWrapping(testCase.html, css, width, testCase.height);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});

it.each([
  ['CJK', '<div style="overflow-wrap:break-word">ab \u6f22\u5b57 cd</div>'],
  ['emoji', '<div style="overflow-wrap:break-word">ab xy\u{1F600}\u{1F600} cd</div>'],
  // Regional-indicator flags are not Extended_Pictographic; they still have to
  // reach the grapheme segmenter.
  ['flag', '<div style="overflow-wrap:break-word">ab \u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7} cd</div>'],
])('does not take an emergency break for a %s word that already fits', (_name, html) => {
  const css = `${RESET} body { font: 16px sans-serif; }`;
  const result = compareWrapping(html, css, 400, 200);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ wrappingMatch: true });
});
