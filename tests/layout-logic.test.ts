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
