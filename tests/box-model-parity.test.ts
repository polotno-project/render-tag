/**
 * Box geometry against the browser's own layout: `box-sizing`, inline-block
 * shrink-to-fit (sized from its content in the content's own styles) and
 * percentages against the containing block layout actually settled — a flex
 * item's used width, an inline-block's shrink-to-fit width, with every
 * percentage cyclic (0, or auto for a width) while that width is computed.
 *
 * Each fixture marks the boxes under test with `background: rgb(N, 0, 1)`;
 * both sides read the marker back, so boxes pair without class names in the
 * layout tree. Border boxes compare in x, y, width and height.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutBox, LayoutNode } from '../src/types.ts';
import { canvasFixtureHtml, mountFixture, prepareComparisonFonts, warmNativeLayout } from './helpers/compare.ts';
import { loadBoxModelCases } from './helpers/test-cases.ts';

// Blink and WebKit lay text out in 1/64px LayoutUnits; canvas measures in
// floats. A shrink-to-fit width inherits that last fraction.
const TOLERANCE = 0.05;

interface Box { x: number; y: number; width: number; height: number }

const MARKER = /^rgb\((\d+), ?0, ?1\)$/;

function domBoxes(html: string, css: string, width: number): Map<number, Box> {
  const { container, content } = mountFixture(html, css, width);
  const origin = content.getBoundingClientRect();
  const boxes = new Map<number, Box>();
  for (const element of content.querySelectorAll('*')) {
    const marker = MARKER.exec(getComputedStyle(element).backgroundColor);
    if (!marker) continue;
    const r = element.getBoundingClientRect();
    boxes.set(Number(marker[1]), { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
  }
  container.remove();
  return boxes;
}

function canvasBoxes(html: string, css: string, width: number): Map<number, Box> {
  const { layoutRoot } = layout({ html: canvasFixtureHtml(html, css), width });
  const boxes = new Map<number, Box>();
  const walk = (node: LayoutNode) => {
    if (node.type !== 'box') return;
    const marker = MARKER.exec(node.style.backgroundColor);
    if (marker) {
      // One box per element: a second one would be the box painted twice.
      expect(boxes.has(Number(marker[1])), `marker ${marker[1]} on more than one box`).toBe(false);
      boxes.set(Number(marker[1]), { x: node.x, y: node.y, width: node.width, height: node.height });
    }
    for (const child of (node as LayoutBox).children) walk(child);
  };
  walk(layoutRoot);
  return boxes;
}

describe('Box model parity with the DOM', () => {
  it('places and sizes every marked box like the browser', async () => {
    const cases = await loadBoxModelCases();
    const failures: string[] = [];
    for (const testCase of cases) {
      await prepareComparisonFonts(testCase.html, testCase.css);
      warmNativeLayout(testCase.html, testCase.css, testCase.width);
      const expected = domBoxes(testCase.html, testCase.css, testCase.width);
      const actual = canvasBoxes(testCase.html, testCase.css, testCase.width);
      expect([...actual.keys()].sort(), `${testCase.name}: marked boxes`).toEqual([...expected.keys()].sort());
      for (const [id, dom] of expected) {
        const rt = actual.get(id)!;
        const keys: (keyof Box)[] = testCase.noHeight?.includes(id) ? ['x', 'y', 'width'] : ['x', 'y', 'width', 'height'];
        const off = keys.filter((key) => Math.abs(rt[key] - dom[key]) > TOLERANCE);
        if (off.length > 0) {
          failures.push(`${testCase.name} #${id}: ` +
            off.map((key) => `${key} ${rt[key].toFixed(2)} vs ${dom[key].toFixed(2)}`).join(', '));
        }
      }
    }
    expect(failures, `Box geometry diverged from the DOM:\n${failures.join('\n')}`).toEqual([]);
  }, 120000);
});
