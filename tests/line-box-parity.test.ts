/**
 * Line box geometry against the real DOM.
 *
 * A line box is built from EVERY box on the line — the block's strut, each run,
 * each run moved by vertical-align, each inline-block — and each of them brings
 * its own line-height and its own half-leading (see `lineBaselineOffset`). The
 * line takes the outermost edge on each side, so a line carrying a second font,
 * a second size, or a shifted box stands TALLER than the largest line-height on
 * it, and its baseline sits deeper than the strut alone would put it.
 *
 * render-tag used to centre the line's max ascent+descent in the line's max
 * line-height, which is a different number on every one of those lines. The
 * cases below are the ones that were measurably wrong: each asserts against the
 * height the browser gives the same markup, so the test states no constant of
 * its own.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import { collectInlineBoxes, collectTexts } from './helpers/layout-tree.ts';

const FONT_A = 'sans-serif';
const FONT_B = 'serif';

/** Height of the block, laid out by the browser. */
function domHeight(inner: string, blockStyle: string, width: number): number {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;left:-9999px;top:0;width:${width}px;`;
  wrap.innerHTML = `<div style="margin:0;padding:0;${blockStyle}">${inner}</div>`;
  document.body.appendChild(wrap);
  const height = (wrap.firstElementChild as HTMLElement).getBoundingClientRect().height;
  wrap.remove();
  return height;
}

/** Height of the same block, laid out by render-tag. */
function canvasHeight(inner: string, blockStyle: string, width: number): number {
  return layout({
    html: `<div style="margin:0;padding:0;${blockStyle}">${inner}</div>`,
    width,
  }).height;
}

const WIDTH = 600;
const CASES: {
  name: string; inner: string; blockStyle: string; tolerance?: number; width?: number;
}[] = [
  {
    name: 'one font, one line-height (the collapsed case)',
    inner: 'Hxg baseline',
    blockStyle: `font-size:30px;font-family:${FONT_A};line-height:1.15`,
  },
  {
    name: 'a second font on the line',
    inner: `Hxg <span style="font-family:${FONT_B}">Hxg</span>`,
    blockStyle: `font-size:30px;font-family:${FONT_A};line-height:1.15`,
  },
  {
    name: 'a second size on the line',
    inner: '<span style="font-size:60px">M</span> and small text',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:1.15`,
  },
  {
    name: 'a length line-height inherited by a bigger run',
    inner: '<span style="font-size:44px">M</span> and small text',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:40px`,
  },
  {
    name: 'vertical-align: middle on a bigger run',
    inner: '<span style="font-size:30px;vertical-align:middle">M</span> middle',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'vertical-align: text-top on a bigger run',
    inner: '<span style="font-size:30px;vertical-align:text-top">T</span> text-top',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'vertical-align: text-bottom on a bigger run',
    inner: '<span style="font-size:30px;vertical-align:text-bottom">B</span> text-bottom',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'text-top and text-bottom on one line',
    inner: '<span style="font-size:30px;vertical-align:text-top">T</span> and ' +
      '<span style="font-size:30px;vertical-align:text-bottom">B</span>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'text-top with a smaller run and a length line-height',
    inner: '<span style="font-size:11px;vertical-align:text-top">t</span> text',
    blockStyle: `font-size:24px;font-family:${FONT_B};line-height:1.3`,
  },
  {
    name: 'sup and sub',
    inner: 'base <sup>sup</sup> and <sub>sub</sub>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
    // Safari grows a line around a shifted box ~0.9px differently from the
    // other two; the shift itself matches (the 8px and 56px cases below hold
    // there at 0.5px).
    tolerance: 1,
  },
  // The shift is a rule of the font SIZE, so it has to hold at both ends of the
  // range. A single mid-range constant fits 18px and misses 8px by 0.5px and
  // 56px by 2.7px, and only these two cases can see that.
  {
    name: 'sup and sub at 8px',
    inner: 'base <sup>s</sup> and <sub>u</sub>',
    blockStyle: `font-size:8px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'sup and sub at 56px',
    inner: 'base <sup>s</sup> and <sub>u</sub>',
    blockStyle: `font-size:56px;font-family:${FONT_B};line-height:2`,
  },
  {
    // Falling back to no shift sized this box as if the sup sat on the
    // baseline: 5.7px short of Chrome, with the glyph painting above the line
    // it was inside. Applying the shift leaves 2px, because the shift itself
    // falls back to the run's own font size when the line has no
    // baseline-aligned run to read the parent's size from. The tolerance is
    // the part still unmodelled, not slack — the invariant suite below is what
    // pins the fix.
    name: 'a line whose only content is a sup',
    inner: '<sup>x</sup>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:1`,
    tolerance: 2.5,
  },
  {
    // The shifts measure against the PARENT's content area, not the tallest
    // box on the line — so a bigger baseline-aligned sibling must not move
    // them. It did: 14px out against Chrome.
    name: 'text-top beside a bigger baseline-aligned run',
    inner: '<span style="font-size:44px">BIG</span> ' +
      '<span style="font-size:30px;vertical-align:text-top">T</span>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    name: 'text-bottom beside a bigger baseline-aligned run',
    inner: '<span style="font-size:44px">BIG</span> ' +
      '<span style="font-size:30px;vertical-align:text-bottom">B</span>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    // The shift is a fraction of the run's PARENT font size. Taking the line's
    // tallest run instead put this 8px out and made the sub variant's block
    // 4.8px too tall — invisible while every case had the block as the tallest.
    name: 'sup beside a bigger baseline-aligned run',
    inner: '<span style="font-size:40px">BIG</span> <sup>s</sup>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    name: 'sub beside a bigger baseline-aligned run',
    inner: '<span style="font-size:40px">BIG</span> <sub>s</sub>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    // ...and the same run NESTED in the bigger span measures against that span,
    // which is what a block-level constant would get wrong instead.
    name: 'sup nested inside a bigger run',
    inner: '<span style="font-size:40px">BIG <sup>s</sup></span>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    name: 'inline-block beside a bigger baseline-aligned run',
    inner: '<span style="font-size:44px">BIG</span> ' +
      '<span style="display:inline-block;margin:4px;padding:4px">b</span>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:1.4`,
  },
  {
    // A word split by break-word rebuilds its cells, and the parent a shift
    // measures against has to survive that. It did not: the sup fell back to
    // the block's 16px and the wrapped block came out 8px short.
    name: 'a shifted run inside a word split by break-word',
    inner: '<span style="font-size:40px">Wiii<sup>s</sup></span>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1;overflow-wrap:break-word`,
    width: 60,
  },
  {
    // A percentage shift is a fraction of the ELEMENT's own line-height, not
    // the line's — which is only visible when the two differ.
    name: 'percentage vertical-align under a taller line',
    inner: 'base <span style="line-height:1;vertical-align:50%">up</span>',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:2`,
  },
  {
    // A wrapper element with no text of its own is still a box on the line.
    name: 'a wrapper span whose only child is an element',
    inner: 'base <span style="line-height:3"><span style="line-height:1">x</span></span>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    name: 'a wrapper span with a bigger font and no text of its own',
    inner: 'base <span style="font-size:40px"><span style="font-size:10px">x</span></span>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    // A wrapper that carries BOTH a vertical-align and direct text of its own
    // enters the union twice — once through its run, once as the parent of its
    // element child. Added at different positions, the line spanned both: 60px
    // where the DOM has 40.
    name: 'a shifted wrapper with direct text and an element child',
    inner: 'base <span style="font-size:40px;vertical-align:-20px">d ' +
      '<span style="font-size:10px">x</span></span>',
    blockStyle: `font-size:16px;font-family:${FONT_A};line-height:1`,
  },
  {
    name: 'inline-block with padding and margin',
    inner: 'before <span style="display:inline-block;margin:4px 8px;padding:4px 8px">box</span> after',
    blockStyle: `font-size:18px;font-family:${FONT_A};line-height:1.4`,
  },
];

describe('line box height vs the DOM', () => {
  it.each(CASES)('$name', ({ inner, blockStyle, tolerance, width }) => {
    const dom = domHeight(inner, blockStyle, width ?? WIDTH);
    const canvas = canvasHeight(inner, blockStyle, width ?? WIDTH);
    // 0.5px covers the engines' own sub-pixel line-box rounding. The bugs this
    // pins cost 9px on a line whose run inherited a length line-height, 5.6px
    // on a sup/sub line, and 25px on a line holding text-top and text-bottom.
    expect(Math.abs(canvas - dom)).toBeLessThanOrEqual(tolerance ?? 0.5);
  });
});

/** Every text run laid out for `inner`, with the line box each one belongs to. */
function runsWithLineBox(inner: string, blockStyle: string) {
  const html = `<div style="margin:0;padding:0;${blockStyle}">${inner}</div>`;
  const res = layout({ html, width: WIDTH });
  return collectTexts(res.layoutRoot).map((t) => ({
    text: t.text,
    y: t.y,
    line: res.lines.find((l) => t.y >= l.bounds.y && t.y <= l.bounds.y + l.bounds.height),
  }));
}

// A line box that does not contain what it sized is worse than a wrong height:
// the caller clips, scrolls and hit-tests against `bounds`. Both ways of
// getting this wrong are silent in the height comparison above — the box
// measures right and the glyph still lands outside it.
describe('a glyph stays inside the line box it sized', () => {
  it.each([
    { name: 'sup alone on its line', inner: '<sup>x</sup>' },
    { name: 'sup beside baseline text', inner: 'base <sup>x</sup>' },
    { name: 'sub alone on its line', inner: '<sub>x</sub>' },
    {
      name: 'inline-block carrying vertical-align',
      inner: 'a <span style="display:inline-block;vertical-align:super">b</span> c',
    },
  ])('$name', ({ inner }) => {
    const runs = runsWithLineBox(inner, `font-size:18px;font-family:${FONT_A};line-height:1`);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.line, `"${run.text}" (baseline ${run.y}) sits outside every line box`)
        .toBeDefined();
    }
  });
});

// An inline box paints its background over its own glyphs, so its rect has to be
// the browser's rect — not merely "somewhere around the baseline". Pinning an
// inline-block to the line TOP detached the two as soon as a taller run shared
// the line (background y 4..33 around text whose baseline was 46), and sizing it
// from bare font metrics instead of its line-height was 4px short.
describe('an inline-block box matches the browser rect', () => {
  it.each([
    { name: 'alone on the line', inner: 'a <span id="ib" style="display:inline-block;margin:4px;padding:4px">b</span> c' },
    {
      name: 'beside a bigger run',
      inner: '<span style="font-size:44px">BIG</span> ' +
        '<span id="ib" style="display:inline-block;margin:4px;padding:4px">b</span>',
    },
    { name: 'padding only', inner: 'a <span id="ib" style="display:inline-block;padding:6px">b</span>' },
  ])('$name', ({ inner }) => {
    const blockStyle = `font-size:18px;font-family:${FONT_A};line-height:1.4`;
    const html = `<div style="margin:0;padding:0;${blockStyle}">${inner}</div>`;

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;left:-9999px;top:0;width:${WIDTH}px;`;
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    const blockTop = (wrap.firstElementChild as HTMLElement).getBoundingClientRect().top;
    const domRect = (wrap.querySelector('#ib') as HTMLElement).getBoundingClientRect();
    const dom = { y: domRect.top - blockTop, height: domRect.height };
    wrap.remove();

    const box = collectInlineBoxes(layout({ html, width: WIDTH }).layoutRoot)
      .filter((b) => b.style.display === 'inline-block')
      .pop();

    expect(box, 'no inline-block box was emitted').toBeDefined();
    expect(Math.abs(box!.y - dom.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box!.height - dom.height)).toBeLessThanOrEqual(0.5);
  });
});

// `-webkit-line-clamp` rebuilds the last line's tail as an ellipsis word. It
// takes the trimmed run's style, so it has to take that style's parent too —
// without it the "…" sat 8px off the run it continues.
describe('the clamp ellipsis keeps its run\'s parent', () => {
  it('places the ellipsis on the shifted run\'s baseline', () => {
    const html =
      `<div style="margin:0;padding:0;font-size:16px;font-family:${FONT_A};` +
      `line-height:1;-webkit-line-clamp:1;width:200px">` +
      '<span style="font-size:40px">AA <sup>ss ss ss ss ss</sup></span></div>';
    const texts = collectTexts(layout({ html, width: 200 }).layoutRoot);
    const ellipsis = texts.find((t) => t.text.includes('…'));
    const sup = texts.find((t) => t.text.startsWith('ss'));
    expect(ellipsis, 'no ellipsis was emitted').toBeDefined();
    expect(sup, 'no sup run survived the clamp').toBeDefined();
    expect(ellipsis!.y).toBeCloseTo(sup!.y, 1);
  });
});
