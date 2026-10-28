/**
 * Bullet markers paint Chrome's synthetic disc in every engine: the scaled
 * glyph's ink is ascent/3 tall, centred ascent/3 above the baseline, and its
 * inner edge sits 7px + ascent/3 from the content (`addListMarker`). A
 * self-check against layout's own numbers, so it gates every lane: WebKit's
 * clamped ink box (`INK_BOX_FROM_PAINT`) drew it half size and raised, Gecko's
 * shifted one 1.5px off the text.
 *
 * Run: npx vitest run --project webkit tests/list-marker-geometry.test.ts
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { layout } from '../src/index.ts';
import { buildCanvasFont } from '../src/layout.ts';
import type { LayoutBox, LayoutNode, LayoutText } from '../src/types.ts';
import { prepareComparisonFonts } from './helpers/compare.ts';
import { makeCanvas } from './helpers/pixels.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';

const FAMILIES = ["'Roboto'", "'Open Sans'", "'Playfair Display'", "'Merriweather'", "'Lobster'"];
const SIZES = [16, 40, 120];
const TYPES = ['disc', 'circle', 'square'];
/** Supersampling of the paint the ink is read from: an edge reads to 1/16px. */
const SCALE = 8;

function html(family: string, size: number, type: string, direction: string, font = ''): string {
  return `<div style="font-family:${family};font-size:${size}px;line-height:1.2;direction:${direction};${font}">` +
    `<ul style="margin:0;padding-inline-start:2.1em;list-style-type:${type}"><li>Header</li></ul></div>`;
}

/** The list item of a `html()` layout: its marker is the first child, its text the second. */
function listItem(source: string, width: number): LayoutBox {
  const find = (node: LayoutNode): LayoutBox | undefined =>
    node.type === 'box' ? (node.listMarker ? node : node.children.map(find).find(Boolean)) : undefined;
  return find(layout({ html: source, width }).layoutRoot)!;
}

/** The painted ink box of `marker` inside the square of half-side `half` around (cx, cy). */
function paintedInk(marker: LayoutText, cx: number, cy: number, half: number) {
  const x0 = Math.floor(cx - half), y0 = Math.floor(cy - half);
  const side = Math.ceil(2 * half + 1) * SCALE;
  const { ctx } = makeCanvas(side, side);
  ctx.scale(SCALE, SCALE);
  ctx.translate(-x0, -y0);
  ctx.font = buildCanvasFont(marker.style);
  ctx.fillText(marker.text, marker.x, marker.y);
  const { data } = ctx.getImageData(0, 0, side, side);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    if (data[(y * side + x) * 4 + 3] < 128) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  expect(right, 'the marker paints ink').toBeGreaterThan(left);
  return { left: x0 + left / SCALE, right: x0 + right / SCALE, top: y0 + top / SCALE, bottom: y0 + bottom / SCALE };
}

/** `measureText(text)` in an upright 400 `family` at `size`. */
function metrics(family: string, size: number, text: string): TextMetrics {
  const { ctx } = makeCanvas(1, 1);
  ctx.font = `${size}px ${family}`;
  return ctx.measureText(text);
}

/** Chrome's marker unit, ascent/3. */
const markerUnit = (family: string, size: number) => metrics(family, size, 'M').fontBoundingBoxAscent / 3;

describe('bullet markers paint the disc layout promises', () => {
  beforeAll(async () => {
    const css = await loadMultiFontCss();
    await prepareComparisonFonts(FAMILIES.map((f) => html(f, 40, 'disc', 'ltr', 'font-weight:700')).join(''), css);
  });

  it('frees the canvas it reads ink from', () => {
    const source = html("'Roboto'", 40, 'disc', 'ltr');
    listItem(source, 1600);
    const create = vi.spyOn(document, 'createElement');
    listItem(source, 1600);
    const made = create.mock.results.map((r) => r.value).filter((e) => e instanceof HTMLCanvasElement);
    create.mockRestore();
    expect(made.map((c) => c.width * c.height)).toEqual(made.map(() => 0));
  });

  // Each makes the painted ink unreadable; the marker then sizes from measureText.
  const unreadable = {
    'its readback is not the paint (fingerprinting protection)': () => {
      const read = CanvasRenderingContext2D.prototype.getImageData;
      return vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData').mockImplementation(function (
        this: CanvasRenderingContext2D, ...args: Parameters<typeof read>
      ) {
        const image = read.apply(this, args);
        image.data.fill(255);
        return image;
      });
    },
    'there is no 2D context (the canvas memory cap)': () =>
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null),
  };

  it.each(Object.entries(unreadable))('falls back to measureText when %s', (_name, install) => {
    const source = html("'Roboto'", 40, 'disc', 'ltr');
    listItem(source, 1600);
    const spy = install();
    let marker: LayoutNode;
    try {
      marker = listItem(source, 1600).children[0];
    } finally {
      spy.mockRestore();
    }
    const ink = metrics("'Roboto'", 40, '•');
    const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent;
    expect(marker.style.fontSize).toBeCloseTo(40 * markerUnit("'Roboto'", 40) / inkHeight, 5);
  });

  const cases = [
    ...FAMILIES.flatMap((family) => SIZES.flatMap((size) => TYPES.flatMap((type) =>
      ['ltr', 'rtl'].map((direction) => ({ family, size, type, direction, font: '' }))))),
    // A bullet keeps the disc's size and place in a bold or italic item.
    ...FAMILIES.flatMap((family) => ['font-weight:700', 'font-style:italic'].map((font) =>
      ({ family, size: 40, type: 'disc', direction: 'ltr', font }))),
  ];

  it.each(cases)('$family $size px $type $direction $font', ({ family, size, type, direction, font }) => {
    const item = listItem(html(family, size, type, direction, font), 40 * size);
    const [marker, text] = item.children as LayoutText[];
    const unit = markerUnit(family, size);
    const gap = 7 + unit;
    const centreY = text.y - unit;
    const inkEnd = item.x + item.style.borderLeftWidth + item.style.paddingLeft - gap;
    const inkStart = item.x + item.width + gap;
    // Wide enough that a marker twice the size still shows as wrong, not clipped to fit.
    const ink = paintedInk(marker, direction === 'ltr' ? inkEnd - unit / 2 : inkStart + unit / 2, centreY, 1.5 * unit + 2);

    const tolerance = 0.5;
    expect(Math.abs(ink.bottom - ink.top - unit), 'ink height').toBeLessThan(tolerance);
    expect(Math.abs((ink.top + ink.bottom) / 2 - centreY), 'ink centre above the baseline').toBeLessThan(tolerance);
    if (direction === 'ltr') {
      expect(Math.abs(ink.right - inkEnd), 'ink end to content').toBeLessThan(tolerance);
    } else {
      expect(Math.abs(ink.left - inkStart), 'ink start to the box edge').toBeLessThan(tolerance);
    }
  });
});
