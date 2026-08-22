import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutBox, LayoutNode } from '../src/types.ts';
import {
  compareWrapping,
  extractDomBoxes,
  prepareComparisonFonts,
  warmNativeLayout,
} from './helpers/compare.ts';
import { loadFlexCases } from './helpers/test-cases.ts';

// Every flex item in the fixtures is a <section>; both sides collect them in
// document order, so the two trees pair without needing class names in the
// layout tree.
const ITEM_TAG = 'section';

// Chrome resolves flex lengths in 1/64px LayoutUnits and we do not round at
// all, so a matching distribution still differs in the last fraction.
const WIDTH_TOLERANCE = 0.05;

const MIN_WIDTH = 120;
const STEP = 20;

function canvasItemBoxes(
  html: string,
  css: string,
  width: number,
  height: number,
): { x: number; width: number }[] {
  const { layoutRoot } = layout({ html: `<style>${css}</style>${html}`, width, height });
  const boxes: { x: number; width: number }[] = [];
  const walk = (node: LayoutNode) => {
    if (node.type !== 'box') return;
    const box = node as LayoutBox;
    if (box.tagName === ITEM_TAG) boxes.push({ x: box.x, width: box.width });
    for (const child of box.children) walk(child);
  };
  walk(layoutRoot);
  return boxes;
}

describe('Flex sizing parity with the DOM', () => {
  it('sizes and places every flex item like the browser', async () => {
    const cases = await loadFlexCases();
    const failures: string[] = [];

    for (const testCase of cases) {
      await prepareComparisonFonts(testCase.html, testCase.css);
      warmNativeLayout(testCase.html, testCase.css, testCase.width);

      for (let width = MIN_WIDTH; width <= testCase.width; width += STEP) {
        const expected = extractDomBoxes(testCase.html, testCase.css, width, ITEM_TAG);
        const actual = canvasItemBoxes(testCase.html, testCase.css, width, testCase.height);
        expect(
          actual.length,
          `${testCase.name}@w=${width}: flex item count`,
        ).toBe(expected.length);

        for (let index = 0; index < expected.length; index++) {
          const dx = Math.abs(actual[index].x - expected[index].x);
          const dw = Math.abs(actual[index].width - expected[index].width);
          if (dx > WIDTH_TOLERANCE || dw > WIDTH_TOLERANCE) {
            failures.push(
              `${testCase.name}@w=${width} item ${index}: ` +
              `x ${actual[index].x.toFixed(2)} vs ${expected[index].x.toFixed(2)}, ` +
              `w ${actual[index].width.toFixed(2)} vs ${expected[index].width.toFixed(2)}`,
            );
          }
        }
      }
    }

    expect(failures, `Flex item geometry diverged from the DOM:\n${failures.join('\n')}`)
      .toEqual([]);
  }, 300000);

  it('wraps flex column text like the browser', async () => {
    const cases = await loadFlexCases();
    const failures: string[] = [];

    for (const testCase of cases) {
      // Nested rows put two independent flows on overlapping bands, which the
      // line oracle cannot pair; their geometry is gated by the test above.
      if (testCase.name === 'Flex nested rows') continue;
      await prepareComparisonFonts(testCase.html, testCase.css);
      warmNativeLayout(testCase.html, testCase.css, testCase.width);

      for (let width = MIN_WIDTH; width <= testCase.width; width += STEP) {
        const { wrappingMatch } = compareWrapping(
          testCase.html, testCase.css, width, testCase.height,
        );
        if (!wrappingMatch) failures.push(`${testCase.name}@w=${width}`);
      }
    }

    expect(failures, `Flex text wrapping diverged from the DOM:\n${failures.join('\n')}`)
      .toEqual([]);
  }, 300000);
});
