/**
 * Unit tests for layout logic using mocked measureText.
 *
 * These test deterministic algorithms (line breaking, margin collapsing,
 * hyphen splitting, etc.) without browser dependencies. The mock context
 * uses a fixed character width so tests are predictable and fast.
 */
import { describe, it, expect } from 'vitest';
import { buildLayoutTree } from '../src/layout.ts';
import type { StyledNode, ResolvedStyle, LayoutBox, LayoutText, LayoutNode } from '../src/types.ts';

// ─── Test helpers ──────────────────────────────────────────────────────

const CHAR_WIDTH = 10;
const SPACE_WIDTH = 10;

/** Default style — all zeroes/defaults. Override per-test as needed. */
function defaultStyle(overrides: Partial<ResolvedStyle> = {}): ResolvedStyle {
  return {
    fontFamily: 'TestFont',
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    color: 'black',
    textAlign: 'left',
    textTransform: 'none',
    textDecorationLine: 'none',
    textDecorationStyle: 'solid',
    textDecorationColor: 'black',
    textShadow: 'none',
    webkitTextStrokeWidth: 0,
    webkitTextStrokeColor: '',
    webkitTextFillColor: '',
    webkitBackgroundClip: '',
    backgroundImage: 'none',
    letterSpacing: 0,
    fontKerning: 'auto',
    lineHeight: 20,
    verticalAlign: 'baseline',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    direction: 'ltr',
    display: 'block',
    width: 0,
    minHeight: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    borderTopColor: 'transparent',
    borderTopStyle: 'none',
    borderRightWidth: 0,
    borderRightColor: 'transparent',
    borderRightStyle: 'none',
    borderBottomWidth: 0,
    borderBottomColor: 'transparent',
    borderBottomStyle: 'none',
    borderLeftWidth: 0,
    borderLeftColor: 'transparent',
    borderLeftStyle: 'none',
    flexDirection: 'row',
    gap: 0,
    flexGrow: 0,
    listStyleType: 'disc',
    ...overrides,
  };
}

/** Create a text node. */
function textNode(text: string, styleOverrides: Partial<ResolvedStyle> = {}): StyledNode {
  return {
    element: null,
    tagName: '#text',
    style: defaultStyle(styleOverrides),
    children: [],
    textContent: text,
  };
}

/** Create a block element with children. */
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

/** Create an inline element with children. */
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

/**
 * Create a mock canvas context with predictable measureText.
 * Every character is CHAR_WIDTH pixels wide.
 */
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

/** Run layout and return the root box. */
function doLayout(tree: StyledNode, width: number): LayoutBox {
  const ctx = mockCtx();
  const { root } = buildLayoutTree(ctx, tree, width, false); // useDomMeasurements=false
  return root;
}

/** Collect all text nodes from a layout tree, in order. */
function collectTexts(node: LayoutNode): LayoutText[] {
  if (node.type === 'text') return [node];
  const result: LayoutText[] = [];
  for (const child of node.children) {
    result.push(...collectTexts(child));
  }
  return result;
}

/** Group text nodes into lines by Y position. */
function getLines(root: LayoutBox): string[] {
  const texts = collectTexts(root);
  const lineMap = new Map<number, string[]>();
  for (const t of texts) {
    const y = Math.round(t.y);
    if (!lineMap.has(y)) lineMap.set(y, []);
    lineMap.get(y)!.push(t.text);
  }
  return [...lineMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, words]) => words.join(''));
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Layout logic (mocked measureText)', () => {

  // ─── Line breaking ─────────────────────────────────────────────────

  describe('Line breaking', () => {
    it('single line when text fits', () => {
      // "Hello World" = 11 chars = 110px, container = 200px
      const tree = block('div', [
        block('p', [textNode('Hello World')]),
      ]);
      const root = doLayout(tree, 200);
      const lines = getLines(root);
      expect(lines).toEqual(['Hello World']);
    });

    it('wraps when text exceeds width', () => {
      // "Hello World" = 110px, container = 60px
      // "Hello" = 50px fits, " " = 10px, "World" = 50px → 110px > 60px → wrap
      const tree = block('div', [
        block('p', [textNode('Hello World')]),
      ]);
      const root = doLayout(tree, 60);
      const lines = getLines(root);
      expect(lines).toEqual(['Hello', 'World']);
    });

    it('wraps multiple lines', () => {
      // "aa bb cc dd" with 4 words, container = 55px
      // "aa" = 20, " bb" = 30 → 50 fits, " cc" = 30 → 80 > 55 → wrap
      const tree = block('div', [
        block('p', [textNode('aa bb cc dd')]),
      ]);
      const root = doLayout(tree, 55);
      const lines = getLines(root);
      expect(lines).toEqual(['aa bb', 'cc dd']);
    });

    it('respects nowrap', () => {
      const tree = block('div', [
        block('p', [textNode('Hello World Foo Bar')], { whiteSpace: 'nowrap' }),
      ]);
      const root = doLayout(tree, 60);
      const lines = getLines(root);
      expect(lines).toEqual(['Hello World Foo Bar']);
    });
  });

  // ─── Hyphen breaking ───────────────────────────────────────────────

  describe('Hyphen breaking', () => {
    it('breaks at hyphens when word overflows on fresh line', () => {
      // "top-to-bottom" = 13 chars = 130px, container = 80px
      // Doesn't fit on fresh line → split at hyphens: "top-" (40px), "to-" (30px), "bottom" (60px)
      // "top-to-" = 70px fits in 80px, "bottom" = 60px fits on next line
      const tree = block('div', [
        block('p', [textNode('top-to-bottom')]),
      ]);
      const root = doLayout(tree, 80);
      const lines = getLines(root);
      expect(lines).toEqual(['top-to-', 'bottom']);
    });

    it('does not break at hyphens when whole word fits on next line', () => {
      // "aa top-to-bottom" with container = 140px
      // "aa" = 20, " top-to-bottom" = 140px → total 160px > 140px → wrap whole word
      // "top-to-bottom" = 130px fits on fresh line (< 140px) → no hyphen split
      const tree = block('div', [
        block('p', [textNode('aa top-to-bottom')]),
      ]);
      const root = doLayout(tree, 140);
      const lines = getLines(root);
      expect(lines).toEqual(['aa', 'top-to-bottom']);
    });

    it('splits at first fitting hyphen point', () => {
      // "a-b-c-d" = 7 chars = 70px, container = 40px
      // Fresh line, doesn't fit → try hyphen splits
      // "a-" = 20px fits, "b-" = 20px → "a-b-" = 40px fits, "c-" = 20px → 60px > 40 → break
      const tree = block('div', [
        block('p', [textNode('a-b-c-d')]),
      ]);
      const root = doLayout(tree, 40);
      const lines = getLines(root);
      expect(lines).toEqual(['a-b-', 'c-d']);
    });
  });

  // ─── Margin collapsing ─────────────────────────────────────────────

  describe('Margin collapsing', () => {
    it('collapses sibling margins — takes larger', () => {
      // Two paragraphs: first has marginBottom=20, second has marginTop=10
      // Collapsed margin = max(20, 10) = 20, not 30
      const tree = block('div', [
        block('p', [textNode('A')], { marginBottom: 20 }),
        block('p', [textNode('B')], { marginTop: 10 }),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const yA = texts.find(t => t.text === 'A')!.y;
      const yB = texts.find(t => t.text === 'B')!.y;
      // Line height is 20, so B baseline should be at A_baseline + 20 (lineHeight) + 20 (collapsed margin)
      expect(yB - yA).toBe(40);
    });

    it('collapses sibling margins — equal margins', () => {
      const tree = block('div', [
        block('p', [textNode('A')], { marginBottom: 15 }),
        block('p', [textNode('B')], { marginTop: 15 }),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const yA = texts.find(t => t.text === 'A')!.y;
      const yB = texts.find(t => t.text === 'B')!.y;
      // Collapsed margin = max(15, 15) = 15
      expect(yB - yA).toBe(35); // 20 (lineHeight) + 15 (margin)
    });
  });

  // ─── Padding and borders ───────────────────────────────────────────

  describe('Padding and borders', () => {
    it('padding offsets content', () => {
      const tree = block('div', [
        block('p', [textNode('A')], { paddingLeft: 20, paddingTop: 10 }),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      expect(texts[0].x).toBe(20);
    });

    it('padding reduces content width for wrapping', () => {
      // Container 100px, padding 30px each side → content width = 40px
      // "Hello World" = 110px → wraps
      const tree = block('div', [
        block('p', [textNode('Hello World')], { paddingLeft: 30, paddingRight: 30 }),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      expect(lines).toEqual(['Hello', 'World']);
    });
  });

  // ─── Text transform ────────────────────────────────────────────────

  describe('Text transform', () => {
    it('uppercase', () => {
      // textTransform is on the text node style (inherited from parent in real pipeline)
      const tree = block('div', [
        block('p', [textNode('hello', { textTransform: 'uppercase' })]),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      expect(texts[0].text).toBe('HELLO');
    });

    it('lowercase', () => {
      const tree = block('div', [
        block('p', [textNode('HELLO', { textTransform: 'lowercase' })]),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      expect(texts[0].text).toBe('hello');
    });

    it('capitalize', () => {
      const tree = block('div', [
        block('p', [textNode('hello world', { textTransform: 'capitalize' })]),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const allText = texts.map(t => t.text).join('');
      expect(allText).toContain('Hello');
      expect(allText).toContain('World');
    });
  });

  // ─── Pre-wrap / newlines ───────────────────────────────────────────

  describe('Whitespace modes', () => {
    it('pre-wrap preserves newlines', () => {
      const tree = block('div', [
        block('p', [textNode('line1\nline2')], { whiteSpace: 'pre-wrap' }),
      ]);
      const root = doLayout(tree, 200);
      const lines = getLines(root);
      expect(lines).toEqual(['line1', 'line2']);
    });

    it('br forces line break', () => {
      const tree = block('div', [
        block('p', [
          textNode('before'),
          textNode('\n'), // br becomes \n text node
          textNode('after'),
        ]),
      ]);
      const root = doLayout(tree, 200);
      const lines = getLines(root);
      expect(lines).toEqual(['before', 'after']);
    });
  });

  // ─── Block height ──────────────────────────────────────────────────

  describe('Block height', () => {
    it('empty block has zero content height', () => {
      const tree = block('div', [
        block('p', []),
      ]);
      const root = doLayout(tree, 200);
      expect(root.height).toBe(0);
    });

    it('empty block with padding has padding height', () => {
      const tree = block('div', [
        block('p', [], { paddingTop: 10, paddingBottom: 5 }),
      ]);
      const root = doLayout(tree, 200);
      // The p box should have height = paddingTop + paddingBottom = 15
      const pBox = root.children.find(c => c.type === 'box') as LayoutBox;
      expect(pBox.height).toBe(15);
    });

    it('minHeight is respected', () => {
      const tree = block('div', [
        block('p', [textNode('A')], { minHeight: 100 }),
      ]);
      const root = doLayout(tree, 200);
      const pBox = root.children.find(c => c.type === 'box') as LayoutBox;
      expect(pBox.height).toBe(100);
    });
  });

  // ─── Flex layout ───────────────────────────────────────────────────

  describe('Flex layout', () => {
    it('row flex distributes width equally', () => {
      const tree = block('div', [
        block('div', [
          block('div', [textNode('A')]),
          block('div', [textNode('B')]),
        ], { display: 'flex', flexDirection: 'row' }),
      ]);
      const root = doLayout(tree, 200);
      // Find the flex children
      const flexBox = root.children[0] as LayoutBox;
      const childBoxes = flexBox.children.filter(c => c.type === 'box') as LayoutBox[];
      expect(childBoxes.length).toBe(2);
      expect(childBoxes[0].width).toBe(100);
      expect(childBoxes[1].width).toBe(100);
    });

    it('flex-grow distributes proportionally', () => {
      const tree = block('div', [
        block('div', [
          block('div', [textNode('A')], { flexGrow: 1 }),
          block('div', [textNode('B')], { flexGrow: 3 }),
        ], { display: 'flex', flexDirection: 'row' }),
      ]);
      const root = doLayout(tree, 200);
      const flexBox = root.children[0] as LayoutBox;
      const childBoxes = flexBox.children.filter(c => c.type === 'box') as LayoutBox[];
      expect(childBoxes[0].width).toBe(50);  // 1/4 of 200
      expect(childBoxes[1].width).toBe(150); // 3/4 of 200
    });
  });

  // ─── CJK breaking ─────────────────────────────────────────────────

  describe('CJK character breaking', () => {
    it('breaks CJK at character boundaries', () => {
      // Each CJK char is 10px, container is 25px → 2 chars per line
      const tree = block('div', [
        block('p', [textNode('\u4e00\u4e8c\u4e09\u56db')]), // 一二三四
      ]);
      const root = doLayout(tree, 25);
      const lines = getLines(root);
      // 2 chars per line (20px), 3rd wraps
      expect(lines.length).toBeGreaterThanOrEqual(2);
      // Each line should have at most ~2 chars
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(3);
      }
    });
  });
});
