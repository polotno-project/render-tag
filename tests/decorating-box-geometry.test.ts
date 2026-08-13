/**
 * What the DECORATING box owns, and what it does not.
 *
 * The rule, and the Chrome rows it was measured from, live beside the code
 * that implements it — `renderText` in src/render.ts. In short: the box that
 * DECLARES a decoration owns the thickness of all three lines and the position
 * of the underline only; the overline and the line-through hang off whichever
 * fragment they cross.
 *
 * The bug this locks down: the painter took thickness AND position from each
 * RUN's own font, so a parent-declared underline over mixed sizes came out as
 * steps of different thickness. The fix must not overshoot in the other
 * direction and flatten the overline or the line-through.
 *
 * Positions are compared as PROFILES — the band's center per pixel column,
 * canvas against the live DOM — so no fixed sampling window has to be kept in
 * step with the text metrics, and a step is caught wherever it falls.
 */
import { describe, it, expect } from 'vitest';
import { compareRenders } from './helpers/compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';
import {
  type Column,
  profile,
  baselineRow,
  maxCenterDrift,
  bandY,
  spread,
  thicknesses,
} from './helpers/band-profile.ts';

const SMALL = 30;
const BIG = 80;
// No descenders: Chrome's default skip-ink would break the DOM reference band
// around a `y` or a `g` and punch holes through the profile.
const TEXT_SMALL = 'ABC';
const TEXT_BIG = 'Tale';

async function render(inner: string, attrs = '') {
  const fontCss = await loadMultiFontCss();
  const html =
    `<div ${attrs} style="font-family: Arial, sans-serif; font-size: ${SMALL}px; color: black; margin: 0; padding: 40px 0;">` +
    inner +
    `</div>`;
  const r = await compareRenders(html, fontCss, BIG * 12, BIG * 4, 0.1, 1);
  const relative = (canvas: HTMLCanvasElement) => {
    const base = baselineRow(canvas);
    return profile(canvas).map((c: Column | null) => (c ? { ...c, center: c.center - base } : null));
  };
  return { lib: relative(r.libCanvas), dom: relative(r.domCanvas) };
}

const parentDeclares = (line: string) =>
  `<span style="text-decoration: ${line}; text-decoration-color: red;">` +
  `${TEXT_SMALL}<span style="font-size: ${BIG}px;">${TEXT_BIG}</span></span>`;

describe('a parent-declared underline draws ONE flat band across mixed sizes', () => {
  it('keeps the declaring box position and thickness over the bigger child', async () => {
    const { lib, dom } = await render(parentDeclares('underline'));

    // Assert the reference really is flat, so a browser change can never turn
    // the canvas assertions below into a tautology.
    expect(spread(dom), 'DOM band is flat').toBeLessThanOrEqual(1);
    expect(spread(lib), 'canvas band is flat').toBeLessThanOrEqual(1);
    expect(thicknesses(lib), 'one thickness, the declarer s').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });
});

describe('vertical-align splits the same way as font-size', () => {
  // Chrome, 40px text with a `super` child: an underline declared ABOVE the
  // child stays one flat band across it (x 0-228, center 133.5), while the
  // same child DECLARING its own underline carries the band up with it
  // (x 82-148, center 119.5). The overline and the strike step either way.
  const SUP = `<span style="vertical-align: super;">Xyz</span>`;

  it('keeps a parent-declared underline flat across a super child', async () => {
    const { lib, dom } = await render(
      `<span style="text-decoration: underline; text-decoration-color: red;">ABC${SUP}DEF</span>`,
    );

    expect(spread(dom), 'DOM band is flat').toBeLessThanOrEqual(1);
    expect(spread(lib), 'canvas band is flat').toBeLessThanOrEqual(1);
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('steps a parent-declared overline with the super child', async () => {
    // The other half of the same rule: the overline hangs off the fragment it
    // crosses, so the shift moves it — the opposite of the underline above.
    const { lib, dom } = await render(
      `<span style="text-decoration: overline; text-decoration-color: red;">ABC${SUP}DEF</span>`,
    );

    expect(spread(dom), 'DOM steps').toBeGreaterThan(3);
    expect(spread(lib), 'canvas steps too').toBeGreaterThan(3);
  });

  it('carries the band up when the super child declares it itself', async () => {
    // Measured RELATIVE to the same span without the shift, not against the
    // DOM's absolute rows: render-tag's `super` offset is ~12px away from
    // Chrome's at this size (a pre-existing vertical-align divergence, visible
    // in the GLYPHS themselves), which would swamp the band assertion. What
    // this owns is which baseline the band picks — the decorating box IS the
    // shifted element here, so the band must ride up with it.
    const declaring = (va: string) =>
      `<span>ABC<span style="${va} text-decoration: underline; text-decoration-color: red;">Xyz</span>DEF</span>`;
    const shifted = await render(declaring('vertical-align: super;'));
    const flat = await render(declaring(''));

    // Chrome lifts it by 5px at this size; the canvas lifts by its own super
    // offset. Only the direction is asserted — the amount is the divergence
    // above, and pinning it would make this a vertical-align test.
    expect(bandY(flat.dom) - bandY(shifted.dom), 'DOM lifts the band').toBeGreaterThan(3);
    expect(bandY(flat.lib) - bandY(shifted.lib), 'canvas lifts the band too').toBeGreaterThan(3);
  });
});

describe('a parent-declared overline and line-through still step per fragment', () => {
  // They hang off the crossed fragment's ascent, so flattening them onto the
  // declaring box would be the same bug in the opposite direction.
  it('overline follows the crossed run, at the declarer s thickness', async () => {
    const { lib, dom } = await render(parentDeclares('overline'));

    expect(spread(dom), 'DOM steps').toBeGreaterThan(10);
    expect(spread(lib), 'canvas steps too').toBeGreaterThan(10);
    expect(thicknesses(lib), 'one thickness, the declarer s').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(2.5);
  });

  // Position is NOT asserted against the DOM here. Chrome moves a PROPAGATED
  // strike up over a bigger child — measured 54px above the baseline over the
  // 80px child, where the same 80px text self-declaring gets 24.5px — and no
  // single-formula fit for that is known. The canvas draws 0.33em of the
  // crossed run (26.4px), a divergence that predates the decorating-box work
  // and that this file deliberately leaves where it found it. What IS asserted
  // is the part this change owns: the band steps rather than flattening onto
  // the declarer, and its thickness is the declarer's.
  it('line-through follows the crossed run, at the declarer s thickness', async () => {
    const { lib, dom } = await render(parentDeclares('line-through'));

    expect(spread(dom), 'DOM steps').toBeGreaterThan(10);
    expect(spread(lib), 'canvas steps too').toBeGreaterThan(10);
    expect(thicknesses(lib), 'one thickness, the declarer s').toEqual(thicknesses(dom));
  });
});

describe('each decorating box keeps its own band', () => {
  it('a span-declared underline steps and thickens under the bigger span', async () => {
    const { lib, dom } = await render(
      `<span style="text-decoration: underline; text-decoration-color: red;">${TEXT_SMALL}</span>` +
        `<span style="font-size: ${BIG}px; text-decoration: underline; text-decoration-color: red;">${TEXT_BIG}</span>`,
    );

    expect(thicknesses(dom).length, 'DOM draws two thicknesses').toBe(2);
    expect(thicknesses(lib), 'both thicknesses').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('does not merge RTL runs that share a text style under different declarers', async () => {
    // The layout joins consecutive words of the same text style into one
    // shaping group, and that group carries ONE decoration entry. It is
    // reachable only from the bidi paths (this RTL block, or Hebrew/Arabic on
    // an LTR line) — a Latin LTR line emits a node per run regardless.
    //
    // BOTH runs here are 30px red-underlined Hebrew — identical text style, so
    // only the decoration comparison can keep them apart — but the first is
    // declared by an 80px box and the second declares its own. Before that
    // comparison included the decorating font they became one group, and the
    // second was painted with the first's 80px band.
    const { lib, dom } = await render(
      `<span style="font-size: ${BIG}px; text-decoration: underline; text-decoration-color: red;">` +
        `<span style="font-size: ${SMALL}px;">\u05d0\u05d1\u05d2</span></span>` +
        `<span style="text-decoration: underline; text-decoration-color: red;">\u05d3\u05d4\u05d5</span>`,
      'dir="rtl"',
    );

    expect(thicknesses(dom).length, 'DOM draws two thicknesses').toBe(2);
    expect(thicknesses(lib), 'both thicknesses').toEqual(thicknesses(dom));
  });
});
