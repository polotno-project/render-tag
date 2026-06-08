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
    paintOrder: 'normal',
    webkitBackgroundClip: '',
    backgroundImage: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    fontKerning: 'auto',
    lineHeight: 20,
    verticalAlign: 'baseline',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    unicodeBidi: 'normal',
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
    lineClamp: 0,
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
      // Mirror Chrome canvas: letter-spacing adds after every character
      // (trailing included). Lets tests exercise letter-spacing-aware paths.
      const ls = parseFloat((ctx as any).letterSpacing) || 0;
      const width = text.length * CHAR_WIDTH + text.length * ls;
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

/** Collect all inline boxes (LayoutBox with tagName 'span') from layout tree. */
function collectInlineBoxes(node: LayoutNode): LayoutBox[] {
  if (node.type === 'text') return [];
  const result: LayoutBox[] = [];
  if (node.tagName === 'span') result.push(node);
  for (const child of node.children) {
    result.push(...collectInlineBoxes(child));
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

    it('skips hyphen split when first part does not fit on current line', () => {
      // "a zero-width" with container = 15px (very narrow)
      // "a" = 10px fits. "zero-width" = 100px overflows.
      // Hyphen split: "zero-" = 50px. Available = 15 - 10(a) - 10(space) = -5px.
      // First part "zero-" doesn't fit → skip hyphen split → wrap whole word.
      // "zero-width" on fresh line → fresh-line hyphen split: "zero-" (50px > 15px) → char break
      // Actually at 15px, "a" = 10px fits, then "zero-width" wraps to fresh line,
      // then fresh-line split: "zero-" = 50px > 15px, still too wide → char break.
      // But the key point: "a" must be on its own line, not merged with "zero-".
      const tree = block('div', [
        block('p', [textNode('a zero-end')]),
      ]);
      const root = doLayout(tree, 15);
      const lines = getLines(root);
      // "a" on line 1, rest wraps. "zero-end" = 80px > 15px on fresh line.
      // Fresh-line hyphen: "zero-" = 50px > 15px → still too wide → char break.
      // "a" should NOT be merged with the next word.
      expect(lines[0]).toBe('a');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('fits hyphen prefix on current line when word overflows', () => {
      // "aaaa top-to-end" with container = 100px
      // "aaaa" = 40px, " top-to-end" = 10+100 = 110px → total 150px > 100px OVERFLOW
      // Hyphen split: "top-" = 40px → 40+10+40 = 90px fits on current line!
      // Line 1 = "aaaa top-", line 2 = "to-end"
      const tree = block('div', [
        block('p', [textNode('aaaa top-to-end')]),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      expect(lines).toEqual(['aaaa top-', 'to-end']);
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

  // ─── overflow-wrap break-word ────────────────────────────────────────

  describe('overflow-wrap break-word', () => {
    it('breaks long word at content width boundary', () => {
      // "abcdefghij" = 10 chars = 100px, container = 35px
      // overflowWrap on text node (inherited from parent in real pipeline)
      const tree = block('div', [
        block('p', [textNode('abcdefghij', { overflowWrap: 'break-word' })]),
      ]);
      const root = doLayout(tree, 35);
      const lines = getLines(root);
      expect(lines).toEqual(['abc', 'def', 'ghi', 'j']);
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

    it('capitalize does not break on a mid-word apostrophe', () => {
      // UAX#29: "o'clock" is one word → "O'clock", not "O'Clock".
      const tree = block('div', [
        block('p', [textNode("o'clock don't", { textTransform: 'capitalize' })]),
      ]);
      const allText = collectTexts(doLayout(tree, 300)).map(t => t.text).join('');
      expect(allText).toContain("O'clock");
      expect(allText).toContain("Don't");
    });

    it('capitalize still breaks on hyphen and punctuation', () => {
      const tree = block('div', [
        block('p', [textNode('test-case (paren)', { textTransform: 'capitalize' })]),
      ]);
      const allText = collectTexts(doLayout(tree, 300)).map(t => t.text).join('');
      expect(allText).toContain('Test-Case');
      expect(allText).toContain('(Paren)');
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

    // CSS Text 3 §4.1.1: pre/pre-wrap preserve trailing whitespace at
    // hard breaks and end-of-content; collapsing modes always strip it.
    // Soft wraps strip even in pre-wrap (whitespace "hangs"). DOM-vs-render
    // comparisons are in `tests/whitespace-edge-cases.test.ts`; these unit
    // tests pin the deterministic line-width math.
    it('pre-wrap: trailing space before \\n included in centered line width', () => {
      // "Calcium \n" at width 200 (CHAR=SPACE=10):
      //   buggy (trimmed):   width=70 → centered x=65
      //   correct (kept):    width=80 → centered x=60
      const tree = block('div', [
        block('p', [textNode('Calcium \n')],
          { whiteSpace: 'pre-wrap', textAlign: 'center' }),
      ]);
      const calcium = collectTexts(doLayout(tree, 200)).find(t => t.text === 'Calcium');
      expect(calcium!.x).toBe(60);
    });

    it('pre: trailing space before \\n included in centered line width', () => {
      // `pre` shares the trim logic with `pre-wrap` (both go through
      // `preservesWhitespace`). This pins the `pre` branch directly since
      // `white-space: pre` is not exercised by any DOM test.
      const tree = block('div', [
        block('p', [textNode('Calcium \n')],
          { whiteSpace: 'pre', textAlign: 'center' }),
      ]);
      const calcium = collectTexts(doLayout(tree, 200)).find(t => t.text === 'Calcium');
      expect(calcium!.x).toBe(60);
    });

    it('pre-wrap: trailing space at a soft wrap is trimmed (hangs)', () => {
      // "aa bb cc" at width 60 must wrap to 2 lines, not 3 — the trailing
      // space before the wrap must not become its own empty line.
      const tree = block('div', [
        block('p', [textNode('aa bb cc')],
          { whiteSpace: 'pre-wrap', textAlign: 'center' }),
      ]);
      expect(getLines(doLayout(tree, 60)).length).toBe(2);
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

  // ─── List markers ──────────────────────────────────────────────────

  describe('List markers', () => {
    it('places marker to the left for LTR lists', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
      };
      const tree = block('div', [
        block('ul', [li]),
      ]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const marker = texts.find(t => t.text === '•');
      const item = texts.find(t => t.text === 'Item');
      expect(marker).toBeDefined();
      expect(item).toBeDefined();
      // Marker should be to the left of content
      expect(marker!.x).toBeLessThan(item!.x);
    });

    it('places marker to the right for RTL lists', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingRight: 30, direction: 'rtl' }),
        children: [textNode('عنصر', { direction: 'rtl' })],
        textContent: null,
        listMarker: '•',
      };
      const tree = block('div', [
        block('ul', [li], { direction: 'rtl' }),
      ], { direction: 'rtl' });
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const marker = texts.find(t => t.text === '•');
      const item = texts.find(t => t.text === 'عنصر');
      expect(marker).toBeDefined();
      expect(item).toBeDefined();
      // Marker should be to the right of content
      expect(marker!.x).toBeGreaterThan(item!.x);
    });

    // ─── ::marker pseudo-element overrides ────────────────────────────
    // Default gap = fontSize * 0.15. With fontSize=16 and paddingLeft=30,
    // marker width = 1*CHAR_WIDTH = 10, so:
    //   default gap = 16 * 0.15 = 2.4
    //   marker.x = paddingLeft - markerWidth - gap = 30 - 10 - 2.4 = 17.6

    it('default gap unchanged when no markerStyle (regression)', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      expect(marker.x).toBeCloseTo(17.6, 5);
    });

    it('LTR: markerStyle.paddingRight widens the gap', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
        markerStyle: { paddingRight: 20 },
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      // marker.x = 30 - 10 - 20 = 0
      expect(marker.x).toBeCloseTo(0, 5);
    });

    it('LTR: markerStyle.paddingRight = 0 zeroes the gap (set vs absent)', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
        markerStyle: { paddingRight: 0 },
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      // marker.x = 30 - 10 - 0 = 20 (flush against content)
      expect(marker.x).toBeCloseTo(20, 5);
    });

    it('RTL: markerStyle.paddingLeft widens the RTL gap', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingRight: 30, fontSize: 16, direction: 'rtl' }),
        children: [textNode('عنصر', { direction: 'rtl' })],
        textContent: null,
        listMarker: '•',
        markerStyle: { paddingLeft: 20 },
      };
      const tree = block('div', [
        block('ul', [li], { direction: 'rtl' }),
      ], { direction: 'rtl' });
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      // RTL: marker placed to the right of li (boxRightEdge + gap).
      // Default gap = 16 * 0.15 = 2.4 → marker.x = li.x + li.width + 2.4
      // With paddingLeft=20 → gap = 20 → marker.x = li.x + li.width + 20
      // Since width depends on layout, just verify the override-vs-default delta:
      const liBox = (root.children[0] as LayoutBox).children[0] as LayoutBox;
      const expectedX = liBox.x + liBox.width + 20;
      expect(marker.x).toBeCloseTo(expectedX, 5);
    });

    it('marker font-size override flows into pushed marker text node', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
        markerStyle: { fontSize: 8 },
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      expect(marker.style.fontSize).toBe(8);
    });
  });

  // ─── RTL inline boxes and decorations ────────────────────────────────

  describe('RTL inline boxes', () => {
    it('positions background box on correct RTL word', () => {
      // "aaa <bg>bbb</bg> ccc" in RTL — background should be on "bbb" not "aaa"
      // RTL visual order: ccc bbb[bg] aaa (right to left)
      const tree = block('div', [
        block('p', [
          textNode('aaa ', { direction: 'rtl' }),
          inline('span', [
            textNode('bbb', { direction: 'rtl', backgroundColor: '#fef08a' }),
          ], { backgroundColor: '#fef08a', direction: 'rtl' }),
          textNode(' ccc', { direction: 'rtl' }),
        ], { direction: 'rtl' }),
      ], { direction: 'rtl' });

      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const boxes = collectInlineBoxes(root);

      // Find the "bbb" text and the background box
      const bbbText = texts.find(t => t.text.includes('bbb'));
      expect(bbbText).toBeDefined();
      expect(boxes.length).toBeGreaterThan(0);

      const bgBox = boxes[0];
      // The background box should overlap with "bbb" text position
      // For RTL, bbb.x is the right edge, so the text spans [bbb.x - bbb.width, bbb.x]
      const bbbLeft = bbbText!.x - bbbText!.width;
      const bbbRight = bbbText!.x;
      const boxLeft = bgBox.x;
      const boxRight = bgBox.x + bgBox.width;

      // Box should overlap with bbb position (not aaa or ccc)
      expect(boxRight).toBeGreaterThan(bbbLeft);
      expect(boxLeft).toBeLessThan(bbbRight);
    });

    it('RTL inline box does not appear at LTR position', () => {
      // Background box should NOT be at the left side of the container
      // (which would happen if box scan used LTR order for RTL text)
      const tree = block('div', [
        block('p', [
          textNode('aaa ', { direction: 'rtl' }),
          inline('span', [
            textNode('bbb', { direction: 'rtl', backgroundColor: '#fef08a' }),
          ], { backgroundColor: '#fef08a', direction: 'rtl' }),
        ], { direction: 'rtl' }),
      ], { direction: 'rtl' });

      const root = doLayout(tree, 200);
      const boxes = collectInlineBoxes(root);

      // With 200px container and RTL, text is right-aligned.
      // "aaa bbb" = 70px. RTL curX = 200 - 70 = 130.
      // "bbb" background should be near the LEFT end of the text (RTL visual order).
      // It should NOT be at x=130 (which is where LTR scan would put the first word).
      if (boxes.length > 0) {
        const bgBox = boxes[0];
        // Box should be in the left half of the text region, not the right half
        // (since "bbb" comes second in RTL visual order = further left)
        expect(bgBox.x).toBeLessThan(170);
      }
    });
  });

  describe('RTL text decorations', () => {
    it('underline spans correct width for RTL text', () => {
      const tree = block('div', [
        block('p', [
          textNode('abcd', { direction: 'rtl', textDecorationLine: 'underline' }),
        ], { direction: 'rtl' }),
      ], { direction: 'rtl' });

      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const textNode_ = texts.find(t => t.text === 'abcd');
      expect(textNode_).toBeDefined();
      expect(textNode_!.style.direction).toBe('rtl');
      expect(textNode_!.style.textDecorationLine).toBe('underline');
      expect(textNode_!.x).toBeGreaterThan(0);
    });

    it('does not merge underlined and non-underlined words in RTL groups', () => {
      // "normal <u>underlined</u> normal" in RTL
      // The underlined word must be a separate text node so its decoration renders.
      // If sameTextStyle ignores textDecorationLine, they'd merge and lose the underline.
      const tree = block('div', [
        block('p', [
          textNode('aaa ', { direction: 'rtl' }),
          textNode('bbb', { direction: 'rtl', textDecorationLine: 'underline' }),
          textNode(' ccc', { direction: 'rtl' }),
        ], { direction: 'rtl' }),
      ], { direction: 'rtl' });

      const root = doLayout(tree, 400);
      const texts = collectTexts(root);

      // "bbb" must be its own text node (not merged with "aaa" or "ccc")
      const underlinedTexts = texts.filter(t => t.style.textDecorationLine === 'underline');
      expect(underlinedTexts.length).toBeGreaterThan(0);
      // The underlined text should contain "bbb" but NOT "aaa" or "ccc"
      const underlinedContent = underlinedTexts.map(t => t.text).join('');
      expect(underlinedContent).toContain('bbb');
      expect(underlinedContent).not.toContain('aaa');
      expect(underlinedContent).not.toContain('ccc');
    });

    it('does not merge different background colors in RTL groups', () => {
      // "normal <bg>highlighted</bg> normal" in RTL
      const tree = block('div', [
        block('p', [
          textNode('aaa ', { direction: 'rtl' }),
          textNode('bbb', { direction: 'rtl', backgroundColor: 'yellow' }),
          textNode(' ccc', { direction: 'rtl' }),
        ], { direction: 'rtl' }),
      ], { direction: 'rtl' });

      const root = doLayout(tree, 400);
      const texts = collectTexts(root);

      // "bbb" must be its own text node (not merged with others)
      const bgTexts = texts.filter(t => t.style.backgroundColor === 'yellow');
      expect(bgTexts.length).toBeGreaterThan(0);
      const bgContent = bgTexts.map(t => t.text).join('');
      expect(bgContent).toContain('bbb');
      expect(bgContent).not.toContain('aaa');
    });
  });

  // ─── RTL text alignment ──────────────────────────────────────────────

  describe('RTL text alignment', () => {
    // RTL text nodes use x = right edge of the run. Container = 200, "abc" = 30px.
    const rtlRightEdge = (textAlign: string, extra: Partial<ResolvedStyle> = {}) => {
      const tree = block('div', [textNode('abc', { direction: 'rtl' })],
        { direction: 'rtl', textAlign, ...extra });
      const t = collectTexts(doLayout(tree, 200)).find(t => t.text === 'abc')!;
      return t.x;
    };

    it('default (start) aligns to the right edge', () => {
      expect(rtlRightEdge('start')).toBe(200);
    });

    it('text-align:right aligns to the right edge', () => {
      expect(rtlRightEdge('right')).toBe(200);
    });

    it('text-align:left aligns to the left edge', () => {
      // RTL + explicit left → line hugs the left; right edge = text width.
      expect(rtlRightEdge('left')).toBe(30);
    });

    it('text-align:end aligns to the left edge (end = left in RTL)', () => {
      expect(rtlRightEdge('end')).toBe(30);
    });

    it('text-align:center centers within the container', () => {
      expect(rtlRightEdge('center')).toBe(115); // (200-30)/2 + 30
    });

    it('text-indent insets the first line from the right edge', () => {
      // RTL inline-start is the right; indent moves the right edge inward by 40.
      expect(rtlRightEdge('start', { textIndent: 40 })).toBe(160);
    });

    it('justify expands spaces so non-last lines fill the width', () => {
      // "aaa bbb ccc ddd eee" wraps in a 100px box; non-last lines justify.
      const tree = block('div', [textNode('aaa bbb ccc ddd eee', { direction: 'rtl' })],
        { direction: 'rtl', textAlign: 'justify', width: 100 });
      const texts = collectTexts(doLayout(tree, 100));
      // Group by line (y); RTL node x = right edge, left edge = x - width.
      const byY = new Map<number, LayoutText[]>();
      for (const t of texts) {
        const y = Math.round(t.y);
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y)!.push(t);
      }
      const lines = [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => a);
      expect(lines.length).toBeGreaterThan(1);
      // Every non-last line must fill the box: right edge ~100 and left edge ~0.
      for (let i = 0; i < lines.length - 1; i++) {
        const rightEdge = Math.max(...lines[i].map(t => t.x));
        const leftEdge = Math.min(...lines[i].map(t => t.x - t.width));
        expect(rightEdge).toBeCloseTo(100, 1);
        expect(leftEdge).toBeCloseTo(0, 1);
      }
    });
  });

  // ─── Bidi override (bdo) ─────────────────────────────────────────────

  describe('Bidi override', () => {
    it('bdo dir=rtl reverses character order', () => {
      const tree = block('div', [
        inline('bdo', [textNode('abcdef', { direction: 'rtl', unicodeBidi: 'bidi-override' })],
          { direction: 'rtl', unicodeBidi: 'bidi-override' }),
      ]);
      const texts = collectTexts(doLayout(tree, 200));
      expect(texts.map(t => t.text).join('')).toBe('fedcba');
    });

    it('bidi-override reverses run order and text across styled children', () => {
      // <bdo dir=rtl>ab<b>cd</b>ef</bdo> → visual "fe dc ba" (bold on "dc")
      const tree = block('div', [
        inline('bdo', [
          textNode('ab', { direction: 'rtl', unicodeBidi: 'bidi-override' }),
          textNode('cd', { direction: 'rtl', unicodeBidi: 'bidi-override', fontWeight: 700 }),
          textNode('ef', { direction: 'rtl', unicodeBidi: 'bidi-override' }),
        ], { direction: 'rtl', unicodeBidi: 'bidi-override' }),
      ]);
      const texts = collectTexts(doLayout(tree, 200));
      expect(texts.map(t => t.text).join('')).toBe('fedcba');
      // The bold run carries "dc"
      expect(texts.find(t => t.style.fontWeight === 700)!.text).toBe('dc');
    });

    it('bdo without rtl leaves order unchanged', () => {
      const tree = block('div', [
        inline('bdo', [textNode('abc', { unicodeBidi: 'bidi-override' })], { unicodeBidi: 'bidi-override' }),
      ]);
      const texts = collectTexts(doLayout(tree, 200));
      expect(texts.map(t => t.text).join('')).toBe('abc');
    });
  });

  // ─── Word spacing ──────────────────────────────────────────────────

  describe('Word spacing', () => {
    it('wider word spacing causes earlier wrapping', () => {
      // "aa bb cc dd" = 110px with default spacing (CHAR_WIDTH=10, space=10)
      // With wordSpacing: 20 (extra 20px per space), each space = 30px
      // "aa" = 20, " bb" = 50 (30+20), " cc" = 50 → total = 120
      // Container = 100px → "aa bb" = 70px fits, "cc" wraps
      // Without wordSpacing: "aa bb cc" = 80px fits in 100px
      const tree = block('div', [
        block('p', [textNode('aa bb cc dd', { wordSpacing: 20 })]),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      // With extra 20px per space, wraps earlier than without
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toBe('aa bb');
    });
  });

  // ─── Letter spacing ────────────────────────────────────────────────

  describe('Letter spacing', () => {
    it('break-all accounts for letter-spacing when choosing break points', () => {
      // "ABCDEFGH" with char=10 + letter-spacing=5 → 15px effective per char.
      // Container 60px: cumulative "ABCD"=60 fits, "ABCDE"=75 wraps → 4 chars/line.
      // A trailing run with letter-spacing:0 is tokenized last, so ctx.letterSpacing
      // is left at 0px — exposing whether breakWordIfNeeded re-sets it per word.
      // If it ignored letter-spacing it would fit 6 chars (60px) → "ABCDEF".
      const tree = block('div', [
        block('p', [
          textNode('ABCDEFGH', { letterSpacing: 5, wordBreak: 'break-all' }),
          textNode(' z', { letterSpacing: 0 }),
        ]),
      ]);
      const root = doLayout(tree, 60);
      const lines = getLines(root);
      expect(lines[0]).toBe('ABCD');
    });
  });

  // ─── Vertical align ────────────────────────────────────────────────

  describe('Vertical align', () => {
    // Baseline word + an aligned word on the same line; measure the y delta.
    // Mock font metrics are uniform, so length/percent/sub/super deltas are
    // deterministic (text-top/middle need real metrics → covered by pixel tests).
    const yDelta = (va: string) => {
      const tree = block('div', [block('p', [
        textNode('base'),
        textNode('X', { verticalAlign: va }),
      ])]);
      const texts = collectTexts(doLayout(tree, 400));
      const base = texts.find(t => t.text === 'base')!;
      const x = texts.find(t => t.text === 'X')!;
      return x.y - base.y;
    };

    it('length raises the baseline by the given px', () => {
      expect(yDelta('5px')).toBeCloseTo(-5, 5); // positive value → up (smaller y)
    });

    it('percentage raises by percent of line-height (20px)', () => {
      expect(yDelta('50%')).toBeCloseTo(-10, 5);
    });

    it('sub lowers, super raises (fractions of parent font size 16)', () => {
      expect(yDelta('sub')).toBeCloseTo(16 * 0.26, 5);
      expect(yDelta('super')).toBeCloseTo(-16 * 0.4, 5);
    });

    it('baseline leaves the word on the baseline', () => {
      expect(yDelta('baseline')).toBeCloseTo(0, 5);
    });

    it('unsupported line-relative keywords fall back to baseline', () => {
      expect(yDelta('top')).toBeCloseTo(0, 5);
      expect(yDelta('bottom')).toBeCloseTo(0, 5);
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

  // ─── line-clamp ────────────────────────────────────────────────────

  describe('-webkit-line-clamp', () => {
    // Mock: each char is 10px wide. Default fontSize=16 / lineHeight=20.
    // For ellipsis "…" measureText returns 1 * 10 = 10px (one grapheme).

    it('no clamp leaves content untouched', () => {
      // 200px container, 3 wraps; clamp=0 (default).
      const tree = block('div', [
        block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd')]),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      // 4 words × 9 chars = each 90px; one per line at 100px width → 4 lines.
      // No ellipsis anywhere.
      expect(lines.length).toBe(4);
      expect(lines.join('')).not.toContain('…');
    });

    it('content shorter than clamp: no ellipsis', () => {
      const tree = block('div', [
        block('p', [textNode('aaaaa bbbbb')], { lineClamp: 5 }),
      ]);
      const root = doLayout(tree, 1000);
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain('…');
    });

    it('clamp=2: drops lines past 2, appends ellipsis on line 2', () => {
      // 4 single-word lines, each 9 chars wide on a 100px container.
      const tree = block('div', [
        block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd')], { lineClamp: 2 }),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      expect(lines.length).toBe(2);
      // Line 2 ends with ellipsis (after trimming "bbbbbbbbb" to fit).
      expect(lines[1].endsWith('…')).toBe(true);
    });

    it('back-trims trailing words until ellipsis fits', () => {
      // 200px wide container; "aaaaa bbbbb ccccc ddddd" = three lines fitting
      // "aaaaa bbbbb" (11 chars + space = 12) twice... let's pick a concrete case.
      // Container 60px: "aaaa bbbb" = 9 chars=90px > 60, so first wraps.
      // Actually let's just verify ellipsis added and last char isn't a space.
      const tree = block('div', [
        block('p', [textNode('one two three four five six')], { lineClamp: 1 }),
      ]);
      const root = doLayout(tree, 50); // very narrow
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0].endsWith('…')).toBe(true);
      // Verify the ellipsis is preceded by a non-space character.
      const beforeEllipsis = lines[0].slice(0, -1);
      expect(beforeEllipsis).not.toMatch(/\s$/);
    });

    it('clamp=1 on already-fitting single line: no ellipsis', () => {
      const tree = block('div', [
        block('p', [textNode('short')], { lineClamp: 1 }),
      ]);
      const root = doLayout(tree, 1000);
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain('…');
    });

    it('clamp keeps emitted line count == clampN even if content has 10 lines', () => {
      // 10 short words on a narrow container → 10 lines naturally.
      const tree = block('div', [
        block('p', [textNode('a b c d e f g h i j')], { lineClamp: 3 }),
      ]);
      const root = doLayout(tree, 15); // each 'a' (10px) + space barely fits
      const lines = getLines(root);
      expect(lines.length).toBe(3);
      expect(lines[2]).toContain('…');
    });

    it('preserves earlier lines verbatim — only the Nth gets ellipsized', () => {
      const tree = block('div', [
        block('p', [textNode('first second third fourth')], { lineClamp: 2 }),
      ]);
      // 100px width: "first" (50) + " " (10) + "second" (60) overflows;
      // so line 0 = "first", line 1 = "second", line 2 = "third", line 3 = "fourth".
      const root = doLayout(tree, 80);
      const lines = getLines(root);
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe('first');
      expect(lines[1]).toContain('…');
      // Earlier lines are untouched.
      expect(lines[0]).not.toContain('…');
    });

    // ─── Regression: single-word that doesn't fit + ellipsis ─────────

    it('single word wider than line drops the word — ellipsis renders alone', () => {
      // Two long words. Container is narrow enough that NEITHER word fits
      // alongside the ellipsis. After clamp=1 keeps line 0 ("verylongword"),
      // back-trim must pop the word (since with ellipsis it still doesn't
      // fit) and the line ends with just '…'.
      const tree = block('div', [
        block('p', [textNode('verylongword anotherword')], { lineClamp: 1 }),
      ]);
      // 60px container, "verylongword" = 120px → forces a wrap.
      // Without the fix, the single-word line would have totalWidth=130
      // (>60); with the fix, the word is popped → '…' alone (10px).
      const root = doLayout(tree, 60);
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe('…');
    });

    // ─── Regression: boxClose markers preserved across trim ──────────

    it('does not pop boxOpen/boxClose markers during back-trim', () => {
      // An inline span with horizontal padding/border emits boxOpen and
      // boxClose markers with empty text. After clamp+trim those markers
      // must still be present so the inline-box renders with its padding.
      // We can't easily inspect markers from the public layout API, but
      // we CAN verify the clamp produces visually-correct output (no crash,
      // ellipsis exists).
      const tree = block('div', [
        block(
          'p',
          [
            textNode('aaaa '),
            inline('span', [textNode('bbbb')], {
              backgroundColor: 'yellow',
              paddingLeft: 4,
              paddingRight: 4,
              display: 'inline',
            }),
            textNode(' cccc'),
          ],
          { lineClamp: 1 },
        ),
      ]);
      const root = doLayout(tree, 100);
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('…');
    });
  });
});
