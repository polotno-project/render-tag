/**
 * `text-underline-offset` and `text-decoration-thickness`.
 *
 * The shared formulas live in `bandWidthFor` / `explicitUnderlineDelta`
 * (src/render.ts), used by both renderers; Chrome rows they were measured
 * from (Arial 40px, rows relative to the alphabetic baseline B):
 *  - explicit offset E: band TOP = B + E, for px, em and % alike. Negative
 *    offsets are legal but Chrome's skip-ink eats the band where it crosses
 *    glyph ink (render-tag has no skip-ink — a documented divergence).
 *  - explicit thickness T: the band is round(T) integer rows, all three line
 *    kinds. `from-font` needs the font's post table, which canvas cannot
 *    read — it falls back to `auto` (documented divergence).
 *  - auto offset + explicit thickness T: band TOP = B + ceil(T/2) — measured
 *    exactly for T ∈ {1, 3, 4, 5, 8, 10}.
 *  - offset is underline-only; a % re-resolves against each INHERITING
 *    element's own font size, an em inherits as computed px (see types.ts).
 *
 * The use case that drove this (polotno): a nested span painting a SECOND
 * underline offset below the element's default one — spellcheck-style
 * overlays. That is the two-band test at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders as compareRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';
import { mockCtx } from './helpers/mock-ctx.ts';
import {
  type Column,
  profile,
  bandClusters,
  baselineRow,
  maxCenterDrift,
  bandY,
  thicknesses,
} from './helpers/band-profile.ts';
import { drawTextOnPath } from '../src/path/index.ts';
import { layout } from '../src/index.ts';

const FS = 40;
// No descenders: Chrome's default skip-ink would punch holes through the
// DOM reference band.
const TEXT = 'ABCDEF';

async function render(inner: string) {
  const fontCss = await loadMultiFontCss();
  const html =
    `<div style="font-family: Arial, sans-serif; font-size: ${FS}px; color: black; margin: 0; padding: 40px 0;">` +
    inner +
    `</div>`;
  const r = await compareRenders(html, fontCss, 500, 220, 0.1, 1);
  const relative = (canvas: HTMLCanvasElement) => {
    const base = baselineRow(canvas);
    return profile(canvas).map((c: Column | null) => (c ? { ...c, center: c.center - base } : null));
  };
  return {
    lib: relative(r.libCanvas),
    dom: relative(r.domCanvas),
    libCanvas: r.libCanvas,
    domCanvas: r.domCanvas,
  };
}

const span = (deco: string, text = TEXT) =>
  `<span style="${deco} text-decoration-color: red;">${text}</span>`;

describe('text-underline-offset', () => {
  it('places the band top at baseline + offset', async () => {
    const { lib, dom } = await render(span('text-decoration: underline; text-underline-offset: 10px;'));
    expect(thicknesses(lib), 'thickness').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('resolves em and % against the element font size', async () => {
    for (const unit of ['0.2em', '25%']) {
      const { lib, dom } = await render(
        span(`text-decoration: underline; text-underline-offset: ${unit};`),
      );
      expect(maxCenterDrift(lib, dom), `band y vs DOM for ${unit}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('re-resolves an inherited % against the declarer child font size', async () => {
    // 25% declared on the 40px wrapper; the underline is declared by the 80px
    // child, so Chrome offsets by 20px (25% of 80), not 10px.
    const { lib, dom } = await render(
      `<span style="text-underline-offset: 25%;">` +
        `<span style="font-size: ${FS * 2}px; text-decoration: underline; text-decoration-color: red;">${TEXT}</span></span>`,
    );
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('inherits an em offset as computed px of the declaring wrapper', async () => {
    const { lib, dom } = await render(
      `<span style="text-underline-offset: 0.25em;">` +
        `<span style="font-size: ${FS * 2}px; text-decoration: underline; text-decoration-color: red;">${TEXT}</span></span>`,
    );
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('is a no-op for line-through', async () => {
    // Chrome's strike position has a known ±2px divergence (see
    // decorating-box-geometry.test.ts), so assert self-consistency: the
    // offset must not move the canvas band at all.
    const plain = await render(span('text-decoration: line-through;'));
    const offset = await render(
      span('text-decoration: line-through; text-underline-offset: 10px;'),
    );
    expect(Math.abs(bandY(offset.lib) - bandY(plain.lib)), 'canvas band unmoved').toBeLessThanOrEqual(0.5);
    expect(Math.abs(bandY(offset.dom) - bandY(plain.dom)), 'DOM band unmoved').toBeLessThanOrEqual(0.5);
  });
});

describe('text-decoration-thickness', () => {
  it('draws round(T) rows at Chrome band position for auto offset', async () => {
    for (const t of ['5px', '7.5px', '25%']) {
      const { lib, dom } = await render(
        span(`text-decoration: underline; text-decoration-thickness: ${t};`),
      );
      expect(thicknesses(lib), `thickness for ${t}`).toEqual(thicknesses(dom));
      expect(maxCenterDrift(lib, dom), `band y vs DOM for ${t}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('combines with an explicit offset', async () => {
    const { lib, dom } = await render(
      span(
        'text-decoration: underline; text-decoration-thickness: 6px; text-underline-offset: 8px;',
      ),
    );
    expect(thicknesses(lib), 'thickness').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('parses from the text-decoration shorthand', async () => {
    const { lib, dom } = await render(`<span style="text-decoration: underline solid red 5px;">${TEXT}</span>`);
    expect(thicknesses(lib), 'thickness').toEqual(thicknesses(dom));
    expect(maxCenterDrift(lib, dom), 'band y vs DOM').toBeLessThanOrEqual(1.5);
  });

  it('applies to line-through and overline too', async () => {
    for (const kind of ['line-through', 'overline']) {
      const { lib, dom } = await render(
        span(`text-decoration: ${kind}; text-decoration-thickness: 5px;`),
      );
      // Positions of both kinds carry pre-existing divergences; the thickness
      // is what this property owns.
      expect(thicknesses(lib), `thickness for ${kind}`).toEqual(thicknesses(dom));
    }
  });
});

describe('two stacked underlines (the spellcheck-overlay case)', () => {
  it('paints the default band AND the offset child band, like Chrome', async () => {
    const { libCanvas, domCanvas } = await render(
      `<span style="text-decoration: underline; text-decoration-color: red;">` +
        `<span style="text-decoration: underline; text-decoration-color: red; text-underline-offset: 12px; text-decoration-thickness: 3px;">${TEXT}</span></span>`,
    );
    const lib = bandClusters(libCanvas);
    const dom = bandClusters(domCanvas);
    expect(dom.length, 'DOM draws two bands').toBe(2);
    expect(lib.length, 'canvas draws two bands').toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(
        Math.abs(
          lib[i].center - baselineRow(libCanvas) - (dom[i].center - baselineRow(domCanvas)),
        ),
        `band ${i} y vs DOM`,
      ).toBeLessThanOrEqual(1.5);
      expect(lib[i].thickness, `band ${i} thickness`).toBe(dom[i].thickness);
    }
  });
});

describe('resolved style plumbing', () => {
  const firstDeco = (html: string) => {
    const res = layout({ html, width: 600, ctx: mockCtx() });
    let found: any = null;
    const walk = (box: any) => {
      if (!found && box.style?.textDecorations?.length) found = box.style.textDecorations[0];
      (box.children || []).forEach(walk);
    };
    walk(res.layoutRoot);
    return found;
  };

  it('stamps offset and thickness onto the declarer', () => {
    const d = firstDeco(
      `<div style="font-size: 40px; text-decoration: underline; text-underline-offset: 7px; text-decoration-thickness: 3px;">x</div>`,
    );
    expect(d.declarer.textUnderlineOffset).toBe(7);
    expect(d.declarer.textDecorationThickness).toBe(3);
  });

  it('treats auto and from-font as null', () => {
    const d = firstDeco(
      `<div style="font-size: 40px; text-decoration: underline; text-underline-offset: auto; text-decoration-thickness: from-font;">x</div>`,
    );
    expect(d.declarer.textUnderlineOffset).toBe(null);
    expect(d.declarer.textDecorationThickness).toBe(null);
  });

  it('reads a thickness length from the shorthand', () => {
    const d = firstDeco(`<div style="font-size: 40px; text-decoration: underline red 0.1em;">x</div>`);
    expect(d.declarer.textDecorationThickness).toBeCloseTo(4);
  });

  it('ignores invalid values, like the browser', () => {
    // An invalid declaration is dropped, not coerced to 0 — 0 would hide the
    // band (thickness) or pin it at the baseline (offset).
    const d = firstDeco(
      `<div style="font-size: 40px; text-decoration: underline; text-underline-offset: garbage; text-decoration-thickness: thin;">x</div>`,
    );
    expect(d.declarer.textUnderlineOffset).toBe(null);
    expect(d.declarer.textDecorationThickness).toBe(null);
  });

  it('shorthand without a thickness token resets an earlier thickness to auto', () => {
    // css-text-decor-4: thickness is a longhand of the shorthand, so the
    // shorthand resets it — Chrome draws the auto band here, not 5px.
    const d = firstDeco(
      `<div style="font-size: 40px; text-decoration-thickness: 5px; text-decoration: underline;">x</div>`,
    );
    expect(d.declarer.textDecorationThickness).toBe(null);
  });
});

describe('text on path', () => {
  const draw = (deco: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    drawTextOnPath({
      html: `<span style="font-size: ${FS}px; font-family: Arial, sans-serif; ${deco} text-decoration-color: red;">${TEXT}</span>`,
      path: 'M10,80 L390,80', // straight horizontal path, baseline at y=80
      ctx,
    });
    return bandClusters(canvas)[0] ?? null;
  };

  it('moves the underline down by the offset at the given thickness', () => {
    const auto = draw('text-decoration: underline;');
    const offset = draw(
      'text-decoration: underline; text-underline-offset: 20px; text-decoration-thickness: 3px;',
    );
    expect(auto, 'auto band exists').not.toBe(null);
    expect(offset, 'offset band exists').not.toBe(null);
    // top = path baseline (80) + offset
    expect(Math.abs(offset!.top - (80 + 20)), 'band top = baseline + offset').toBeLessThanOrEqual(1.5);
    expect(offset!.thickness, 'explicit thickness').toBe(3);
    expect(offset!.top - auto!.top, 'moved down from auto').toBeGreaterThan(10);
  });

  it('thickens a line-through without moving the underline formula in', () => {
    const strike = draw('text-decoration: line-through; text-decoration-thickness: 6px;');
    expect(strike, 'band exists').not.toBe(null);
    expect(strike!.thickness).toBe(6);
    expect(strike!.top, 'stays above the baseline').toBeLessThan(80);
  });

  it('a declared thickness of 0 hides the band', () => {
    const none = draw('text-decoration: underline; text-decoration-thickness: 0;');
    expect(none).toBe(null);
  });
});
