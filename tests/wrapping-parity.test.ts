import { expect, it } from 'vitest';
import { layout } from '../src/index.ts';
import {
  compareWrapping,
  extractDomLines,
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

/**
 * Each visible line as `index:text`, the index counted in line heights from the block top, so
 * a line holding only white space (no visible text) is pinned by the lines after it.
 */
function lineMembership(html: string, width: number, lineHeight: number): { dom: string[]; rt: string[] } {
  // White space dropped: the DOM side joins words across text nodes with a space.
  const entry = (y: number, text: string) => `${Math.round(y / lineHeight)}:${text.replace(/\s+/g, '')}`;
  const dom = extractDomLines(html, '', width).map((line) => entry(line.y, line.text));
  const rt = layout({ html, width }).lines.filter((line) => line.text.trim())
    .map((line) => entry(line.bounds.y, line.text));
  return { dom, rt };
}

// Chrome ends a line at an ordinary opportunity before it breaks a too-wide word anywhere
// (Blink `HandleOverflow`): after white space that wraps, under its own white-space, or an
// atomic inline. Collapsible spaces, box edges, `pre` spaces and NBSP offer none.
it('a too-wide word after the reported leading space breaks where Chrome does', () => {
  const html = '<div style="width:227px;font:34.42px Edo, serif;line-height:1.169;letter-spacing:-0.86px;text-align:right;white-space:pre-wrap;overflow-wrap:break-word;text-transform:uppercase"> snowboarding</div>';
  const { dom, rt } = lineMembership(html, 227, 34.42 * 1.169);
  expect(rt).toEqual(dom);
});

it.each([
  ['two spaces', 'white-space:pre-wrap', '  SNOWBOARDING'],
  ['a tab', 'white-space:pre-wrap', '\tSNOWBOARDING'],
  ['a space after a hard break', 'white-space:pre-wrap', 'X\n SNOWBOARDING'],
  ['break-spaces', 'white-space:break-spaces', ' SNOWBOARDING'],
  ['overflow-wrap: anywhere', 'white-space:pre-wrap;overflow-wrap:anywhere', ' SNOWBOARDING'],
  ['word-break: break-word', 'white-space:pre-wrap;word-break:break-word', ' SNOWBOARDING'],
  ['rtl', 'white-space:pre-wrap;direction:rtl', ' SNOWBOARDING'],
  ['a space before an opening edge', 'white-space:pre-wrap', ' <span style="padding-left:10px">SNOWBOARDING</span>'],
  ['a space in a padded pre-wrap span', '', '<span style="padding-left:10px;white-space:pre-wrap"> </span>SNOWBOARDING'],
  ['a pre-wrap span space in a collapsing block', '', '<span style="white-space:pre-wrap"> </span>SNOWBOARDING'],
  ['a pre-wrap span tab in a collapsing block', '', '<span style="white-space:pre-wrap">\t</span>SNOWBOARDING'],
  ['a break-spaces span space in a collapsing block', '', '<span style="white-space:break-spaces"> </span>SNOWBOARDING'],
  ['a space before a word continued across runs', 'white-space:pre-wrap', ' SNOW<b>BOARDING</b>'],
  ['a space before an opener', 'white-space:pre-wrap', ' (SNOWBOARDING'],
  ['a space before a hyphenated word', 'white-space:pre-wrap', ' SNOWBOARD-INGXX'],
  ['an inline-block', '', '<span style="display:inline-block">x</span>SNOWBOARDING'],
  ['a pre span space', 'white-space:pre-wrap', '<span style="white-space:pre"> </span>SNOWBOARDING'],
  ['a collapsible span space', 'white-space:pre-wrap', '<span style="white-space:normal"> </span>SNOWBOARDING'],
  ['a pre-line span space', 'white-space:pre-wrap', '<span style="white-space:pre-line"> </span>SNOWBOARDING'],
  ['an NBSP', 'white-space:pre-wrap', '\u00a0SNOWBOARDING'],
])('a too-wide word after %s breaks where Chrome does', (_name, style, body) => {
  const html = `<div style="width:200px;font:40px/50px Arial, sans-serif;overflow-wrap:break-word;${style}">${body}</div>`;
  const { dom, rt } = lineMembership(html, 200, 50);
  expect(rt).toEqual(dom);
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

// Blink and WebKit truncate the box width to a 1/64px LayoutUnit and keep a line up to
// one unit over it. The pre-wrap text is the Polotno editor's repro: its first line
// measures 751.8677px, wraps at 751.855 (laid out 751.84375 wide) and stays at 751.86.
// "container box" measures 529.1443px: it wraps at 529.125 and stays at 529.140625.
const KNIFE_EDGE_CASES: [string, number, number[]][] = [
  ['<p style="white-space:pre-wrap">Header  adf ;lkajsdf f asdfasfsdf sadfsad asdfasdfas ' +
    'dfasdfasdfasdfas dfasdf</p>', 800, [751.85, 751.855, 751.86, 751.875]],
  ['<p>Typography fitting puts every line right at the edge of its container box</p>', 1200,
    [529.109375, 529.125, 529.140625, 529.15625]],
];
it.each(KNIFE_EDGE_CASES.flatMap(([html, height, widths]) => widths.map((width) => [width, html, height])))(
  'breaks a knife-edge line like the native DOM at %s px', async (width, html, height) => {
    const font = FONT_VARIANTS.find((item) => item.name === 'Roboto')!;
    const css = `${await loadMultiFontCss()}\n${RESET}` +
      ` body { font-family: ${font.family}; font-size: 87.5px; line-height: 1.2; } p { margin: 0; }`;
    await prepareComparisonFonts(html, css);
    const result = compareWrapping(html, css, width, height);
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
