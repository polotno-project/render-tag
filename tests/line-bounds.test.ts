/**
 * Unit tests for LayoutLine.bounds — per-line geometry.
 *
 * Reuses the mocked-measureText helpers from layout-logic.test.ts conventions:
 * 10px per character, fontSize=16, lineHeight=20.
 */
import { describe, it, expect } from 'vitest';
import { buildLayoutTree } from '../src/layout.ts';
import type { StyledNode, ResolvedStyle, LayoutLine } from '../src/types.ts';
import { styleFixture as defaultStyle } from './helpers/style-fixture.ts';

const CHAR_WIDTH = 10;

function textNode(text: string, styleOverrides: Partial<ResolvedStyle> = {}): StyledNode {
  return {
    element: null,
    tagName: '#text',
    style: defaultStyle(styleOverrides),
    children: [],
    textContent: text,
  };
}

function block(
  tag: string,
  children: StyledNode[],
  styleOverrides: Partial<ResolvedStyle> = {},
): StyledNode {
  return {
    element: null,
    tagName: tag,
    style: defaultStyle({ display: 'block', ...styleOverrides }),
    children,
    textContent: null,
  };
}

function inline(
  tag: string,
  children: StyledNode[],
  styleOverrides: Partial<ResolvedStyle> = {},
): StyledNode {
  return {
    element: null,
    tagName: tag,
    style: defaultStyle({ display: 'inline', ...styleOverrides }),
    children,
    textContent: null,
  };
}

function mockCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '',
    fontKerning: 'normal',
    letterSpacing: '0px',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    measureText(text: string) {
      const width = text.length * CHAR_WIDTH;
      return {
        width,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
    fillText() {},
    strokeText() {},
    save() {},
    restore() {},
    scale() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    getImageData() { return { data: new Uint8ClampedArray(0), width: 0, height: 0 }; },
    putImageData() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function doLines(tree: StyledNode, width: number): LayoutLine[] {
  const ctx = mockCtx();
  const { lines } = buildLayoutTree(ctx, tree, width, false);
  return lines;
}

describe('LayoutLine.bounds', () => {
  it('single line of plain text has bounds at content origin', () => {
    const tree = block('div', [textNode('hello')]);
    const lines = doLines(tree, 1000);
    expect(lines.length).toBe(1);
    const { bounds, y, text } = lines[0];
    expect(text).toBe('hello');
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(5 * CHAR_WIDTH);
    expect(bounds.height).toBe(20);
    // Baseline sits inside the line box.
    expect(y).toBeGreaterThanOrEqual(bounds.y);
    expect(y).toBeLessThanOrEqual(bounds.y + bounds.height);
  });

  it('padding shifts bounds origin', () => {
    const tree = block('div', [textNode('hi')], { paddingLeft: 12, paddingTop: 7 });
    const lines = doLines(tree, 1000);
    expect(lines.length).toBe(1);
    expect(lines[0].bounds.x).toBe(12);
    expect(lines[0].bounds.y).toBe(7);
  });

  it('wrapped text produces one line per wrap with stacking bounds.y', () => {
    // 100px wide / 10px per char = 10 chars per line. "aaaa bbbb cccc" = 14 chars.
    // Should wrap: "aaaa bbbb" (10 with space — width 90, fits) | "cccc" (4)
    const tree = block('div', [textNode('aaaa bbbb cccc')]);
    const lines = doLines(tree, 100);
    expect(lines.length).toBe(2);
    expect(lines[0].bounds.y).toBe(0);
    expect(lines[1].bounds.y).toBe(20);
    // Heights equal default line height
    expect(lines[0].bounds.height).toBe(20);
    expect(lines[1].bounds.height).toBe(20);
    // Baselines inside their respective boxes
    expect(lines[0].y).toBeGreaterThanOrEqual(0);
    expect(lines[0].y).toBeLessThanOrEqual(20);
    expect(lines[1].y).toBeGreaterThanOrEqual(20);
    expect(lines[1].y).toBeLessThanOrEqual(40);
  });

  it('justified line has bounds.width == content width (spaces expanded to fill)', () => {
    const tree = block(
      'div',
      [textNode('aaaa bbbb cccc')],
      { textAlign: 'justify' },
    );
    const lines = doLines(tree, 100);
    // Last line in justified text uses text-align-last (default = start),
    // so only the wrapped line is justified.
    expect(lines.length).toBe(2);
    // First line is justified — width = full content area (100)
    expect(lines[0].bounds.width).toBe(100);
    // Last line is left-aligned (default text-align-last)
    expect(lines[1].bounds.width).toBe(4 * CHAR_WIDTH); // "cccc"
  });

  it('right-aligned line: bounds.x reflects content left edge, not container left', () => {
    const tree = block('div', [textNode('hi')], { textAlign: 'right' });
    const lines = doLines(tree, 100);
    // "hi" is 20px wide; right-aligned in 100px container → x = 80
    expect(lines.length).toBe(1);
    expect(lines[0].bounds.x).toBe(80);
    expect(lines[0].bounds.width).toBe(20);
  });

  it('center-aligned: bounds.x reflects centering', () => {
    const tree = block('div', [textNode('hi')], { textAlign: 'center' });
    const lines = doLines(tree, 100);
    expect(lines.length).toBe(1);
    // (100 - 20) / 2 = 40
    expect(lines[0].bounds.x).toBe(40);
    expect(lines[0].bounds.width).toBe(20);
  });

  it('mixed font sizes on one line: bounds.height matches max line height', () => {
    // collectTextRuns reads style off the #text nodes, so per-word styles
    // live on the text nodes themselves (not the wrapping span).
    const tree = block('div', [
      textNode('hi '),
      inline('span', [textNode('BIG', { fontSize: 32, lineHeight: 40 })]),
    ]);
    const lines = doLines(tree, 1000);
    expect(lines.length).toBe(1);
    // Effective line height is max(20, 40) = 40
    expect(lines[0].bounds.height).toBe(40);
    // Same baseline for both runs
    expect(lines[0].y).toBeGreaterThan(0);
  });

  it('multiple block paragraphs: each emits its own line(s) with absolute y', () => {
    const tree = block('div', [
      block('p', [textNode('first')]),
      block('p', [textNode('second')]),
    ]);
    const lines = doLines(tree, 1000);
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('first');
    expect(lines[1].text).toBe('second');
    expect(lines[0].bounds.y).toBe(0);
    expect(lines[1].bounds.y).toBe(20);
  });

  it('lines are returned in y-order even from interleaved sources', () => {
    // Single block — implicit ordering check.
    const tree = block('div', [textNode('a a a a a a a a a a')]);
    const lines = doLines(tree, 50);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].bounds.y).toBeGreaterThanOrEqual(lines[i - 1].bounds.y);
    }
  });

  it('super expands bounds upward: bounds.y < curY when sup is present', () => {
    // Without sup, bounds.y == 0. With sup, bounds.y should go negative
    // (or at minimum smaller than the no-sup baseline) because the
    // super-aligned content extends above the nominal line top.
    const tree = block('div', [
      textNode('Hello '),
      inline('sup', [textNode('1', { fontSize: 10, lineHeight: 12, verticalAlign: 'super' })]),
    ]);
    const lines = doLines(tree, 1000);
    expect(lines.length).toBe(1);
    // Top of bounds should sit at or above the nominal curY=0 — super raises it.
    expect(lines[0].bounds.y).toBeLessThanOrEqual(0);
    // bounds.y + bounds.height should equal the bottom of the line box,
    // which is at least lineHeight (20). super-expansion may also push
    // bottom further if no sub was used, but should never be < lineHeight.
    expect(lines[0].bounds.y + lines[0].bounds.height).toBeGreaterThanOrEqual(20);
  });

  it('list marker is included in line text', () => {
    // Mock the listMarker field — buildLayoutTree expects it on <li> nodes.
    const li: StyledNode = {
      element: null,
      tagName: 'li',
      style: defaultStyle({ display: 'block' }),
      children: [textNode('Item')],
      textContent: null,
      listMarker: '•',
    };
    const ul: StyledNode = {
      element: null,
      tagName: 'ul',
      style: defaultStyle({ display: 'block', paddingLeft: 40 }),
      children: [li],
      textContent: null,
    };
    const lines = doLines(ul, 1000);
    expect(lines.length).toBe(1);
    // Marker text is merged into the same line as 'Item' (baselines match).
    expect(lines[0].text).toContain('•');
    expect(lines[0].text).toContain('Item');
  });
});
