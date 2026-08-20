/**
 * Unit tests for layout logic using mocked measureText.
 *
 * These test deterministic algorithms (line breaking, margin collapsing,
 * hyphen splitting, etc.) without browser dependencies. The mock context
 * uses a fixed character width so tests are predictable and fast.
 */
import { describe, it, expect } from 'vitest';
import { buildLayoutTree, sameDecorationBand, BLINK_SUPER_SUB } from '../src/layout.ts';
import { layout } from '../src/index.ts';
import { mockCtx, CHAR_WIDTH } from './helpers/mock-ctx.ts';
import type { StyledNode, ResolvedStyle, LayoutBox, LayoutText, DecorationEntry } from '../src/types.ts';
import { collectInlineBoxes, collectTexts } from './helpers/layout-tree.ts';

// ─── Test helpers ──────────────────────────────────────────────────────

const SPACE_WIDTH = CHAR_WIDTH;

/** Default style — all zeroes/defaults. Override per-test as needed. */
function defaultStyle(overrides: Partial<ResolvedStyle> = {}): ResolvedStyle {
  return {
    fontFamily: 'TestFont',
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    fontVariantCaps: 'normal',
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

/** Run layout and return the root box. */
function doLayout(tree: StyledNode, width: number): LayoutBox {
  const ctx = mockCtx();
  const { root } = buildLayoutTree(ctx, tree, width, false); // useDomMeasurements=false
  return root;
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

    it('does not break a hyphen flanked by digits (phone/number/date)', () => {
      // "+1-555-123-4567" — every hyphen sits between digits, which is NOT a
      // break opportunity in the browser, so the token stays whole (overflowing)
      // rather than splitting at the hyphens.
      const tree = block('div', [block('p', [textNode('+1-555-123-4567')])]);
      const root = doLayout(tree, 100);
      expect(getLines(root)).toEqual(['+1-555-123-4567']);
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

    it('reserves the visible hyphen width at a soft-hyphen break', () => {
      // "ab­cd­ef": soft hyphens split into pieces ab|cd|ef (char=10).
      // hyphen '-' = 10px. Container = 45px.
      // Chrome only breaks at a soft hyphen if prefix + '-' fits: "ab-" = 30 ≤ 45
      // but "abcd-" = 50 > 45, so it must break after "ab", giving "ab-" / "cdef".
      // Without reserving the hyphen, the engine packs "abcd" (40 ≤ 45) then adds
      // "-" → "abcd-" = 50px overflowing the line.
      const tree = block('div', [
        block('p', [textNode('ab­cd­ef')]),
      ]);
      const root = doLayout(tree, 45);
      const lines = getLines(root);
      expect(lines[0]).toBe('ab-');
    });
  });

  describe('Emoji cluster breaking', () => {
    it('breaks between emoji clusters in an unspaced run', () => {
      // Each emoji measures 20px (2 UTF-16 units × 10px in the mock).
      // Container 50px: 😀😁 = 40px fits, 😂 wraps. Browsers treat each emoji
      // grapheme as a break opportunity; without the rule the run stays whole.
      const tree = block('div', [block('p', [textNode('😀😁😂')])]);
      const root = doLayout(tree, 50);
      const lines = getLines(root);
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe('😀😁');
    });

    it('never splits inside a ZWJ emoji sequence (family)', () => {
      // 👨‍👩‍👧‍👦 is a single grapheme cluster — must stay intact even when narrow.
      const tree = block('div', [block('p', [textNode('👨‍👩‍👧‍👦')])]);
      const root = doLayout(tree, 10);
      const lines = getLines(root);
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe('👨‍👩‍👧‍👦');
    });
  });

  describe('Adjacent inline spans with no whitespace', () => {
    it('does not break between adjacent spans that have no whitespace between them', () => {
      // <span>RED</span><span>BLUE</span> with no space → "REDBLUE" is one
      // unbreakable unit in CSS (no break opportunity at the element boundary).
      // char=10: REDBLUE = 70px overflows a 40px container but must stay whole.
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('RED')]),
          inline('span', [textNode('BLUE')]),
        ]),
      ]);
      const root = doLayout(tree, 40);
      expect(getLines(root)).toEqual(['REDBLUE']);
    });

    it('still breaks at real whitespace between spans', () => {
      // A space between the spans is a genuine break opportunity.
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('RED')]),
          textNode(' '),
          inline('span', [textNode('BLUE')]),
        ]),
      ]);
      const root = doLayout(tree, 40);
      expect(getLines(root)).toEqual(['RED', 'BLUE']);
    });

    it('break-word splits a word that overflows even when it is split across a span boundary', () => {
      // "Experience" = <span>E</span>xperience, overflow-wrap:break-word.
      // char=10: "Experience"=100. Container=80. Neither "E"(10) nor
      // "xperience"(90) alone exceeds 80, so per-word break-word never fires —
      // the word overflows. The browser breaks the whole word at char level:
      // "Experien"(80) / "ce"(20). The break must span the run boundary.
      const bw = { overflowWrap: 'break-word' as const };
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('E', bw)], bw),
          textNode('xperience', bw),
        ], bw),
      ]);
      const root = doLayout(tree, 80);
      expect(getLines(root)).toEqual(['Experien', 'ce']);
    });

    it('break-word across a span boundary accounts for the glued prefix already on the line', () => {
      // "E"(span) + "xperience". char=10, container=80. The first break chunk
      // must include the "E" already placed: "Experien"(80)/"ce", NOT
      // "xperienc"(broken in isolation, ignoring "E", which would overflow).
      const bw = { overflowWrap: 'break-word' as const };
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('E', bw)], bw),
          textNode('xperience', bw),
        ], bw),
      ]);
      const root = doLayout(tree, 80);
      const lines = getLines(root);
      // First line must not exceed 8 chars (80px / 10px).
      expect(lines[0].length).toBeLessThanOrEqual(8);
      expect(lines.join('')).toBe('Experience');
    });

    it('breaks a hyphenated word at the hyphen even when split across a span boundary', () => {
      // "well-being" = <span>wel</span>l-being. A hyphen is a normal break
      // opportunity (independent of overflow-wrap). char=10: "well-"=50,
      // "being"=50. Container=70: "well-" fits, "being" wraps. The break must
      // happen at the hyphen, which sits across the run boundary.
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('wel')]),
          textNode('l-being'),
        ]),
      ]);
      const root = doLayout(tree, 70);
      expect(getLines(root)).toEqual(['well-', 'being']);
    });

    it('fills the current line up to the hyphen of a split word (hyphen is not last-resort)', () => {
      // "x <span>wel</span>l-being", container=70. Unlike break-word, a hyphen
      // fills the current line: "x well-" / "being" (NOT "x" / "well-being").
      const tree = block('div', [
        block('p', [
          textNode('x '),
          inline('span', [textNode('wel')]),
          textNode('l-being'),
        ]),
      ]);
      const root = doLayout(tree, 70);
      expect(getLines(root)).toEqual(['x well-', 'being']);
    });

    it('wraps a whole word that is split across a span boundary as one unit', () => {
      // "Experience" is split across an inline span: <span>Experie</span>nce.
      // There is NO break opportunity between "Experie" and "nce", so the word
      // must wrap as a unit. The fit check for "Experie" must include the glued
      // "nce" that follows — otherwise "Experie" packs onto the "Music " line
      // and the glued "nce" overflows it.
      // char=10: "Music"=50 +space=10, "Experie"=70, "nce"=30.
      // Width 130: "Music Experie"=130 would just fit, but the full word
      // "Experience"=100 doesn't fit after "Music " (60+100=160>130), so the
      // browser wraps the whole word.
      const tree = block('div', [
        block('p', [
          textNode('Music '),
          inline('span', [textNode('Experie')]),
          textNode('nce'),
        ]),
      ]);
      const root = doLayout(tree, 130);
      expect(getLines(root)).toEqual(['Music', 'Experience']);
    });

    it('handles a non-BMP char in the preceding run at the boundary', () => {
      // <em>🎭</em>! — the glue check inspects the last character of the
      // previous run, and the emoji is a surrogate pair: indexing the
      // code-point array by the code-unit length reads past the end.
      const tree = block('div', [
        block('p', [
          inline('em', [textNode('🎭')]),
          textNode('!'),
        ]),
      ]);
      const root = doLayout(tree, 200);
      expect(getLines(root)).toEqual(['🎭!']);
    });

    it('handles a non-BMP char anywhere in the preceding run at the boundary', () => {
      // Same bug, emoji not last: any surrogate pair in the previous run makes
      // its code-unit length exceed its code-point count.
      const tree = block('div', [
        block('p', [
          inline('em', [textNode('italic 🎭')]),
          textNode('!'),
        ]),
      ]);
      const root = doLayout(tree, 200);
      expect(getLines(root)).toEqual(['italic 🎭!']);
    });

    it('keeps the emoji break opportunity across a span boundary', () => {
      // Emoji are UAX #14 class ID — a break after one is allowed regardless of
      // element boundaries, exactly like CJK. char=10 (emoji = 2 units = 20px),
      // container 40: <em>🎭</em>xxxx must break as "🎭" / "xxxx", matching the
      // single-run "🎭xxxx". Gluing it would overflow the box by 20px.
      const tree = block('div', [
        block('p', [
          inline('em', [textNode('🎭')]),
          textNode('xxxx'),
        ]),
      ]);
      const root = doLayout(tree, 40);
      expect(getLines(root)).toEqual(['🎭', 'xxxx']);
    });

    it('keeps the emoji break opportunity for a VS16 cluster across a span boundary', () => {
      // ❤️ is U+2764 + U+FE0F — a BMP base plus a variation selector, so the
      // boundary character must be read as a GRAPHEME cluster: the last code
      // point alone (U+FE0F) is not emoji, which would glue and overflow.
      // char=10, ❤️ = 2 units = 20px, container 40 — same output as the
      // single-run "❤️xxxx".
      const glued = block('div', [
        block('p', [
          inline('em', [textNode('❤️')]),
          textNode('xxxx'),
        ]),
      ]);
      const single = block('div', [block('p', [textNode('❤️xxxx')])]);
      expect(getLines(doLayout(glued, 40))).toEqual(getLines(doLayout(single, 40)));
      expect(getLines(doLayout(glued, 40))).toEqual(['❤️', 'xxxx']);
    });
  });

  describe('URL break opportunities', () => {
    it('breaks after "?" (query delimiter) inside an unbreakable token', () => {
      // char=10. "q3?lang" = 7 chars. Container 35px.
      // Chrome breaks after the query delimiter "?": "q3?" (30px) fits,
      // "lang" wraps. Without the rule the whole token overflows on one line.
      const tree = block('div', [block('p', [textNode('q3?lang')])]);
      const root = doLayout(tree, 35);
      expect(getLines(root)).toEqual(['q3?', 'lang']);
    });

    it('does NOT break at "/", "&", "=" or "." inside a token', () => {
      // These are NOT break opportunities in Chrome (verified against the
      // browser): a path/query without "?" stays whole and overflows.
      const tree = block('div', [block('p', [textNode('a/b&c=d.e')])]);
      const root = doLayout(tree, 40);
      // 9 chars = 90px overflows 40px but must stay on ONE line (no break).
      expect(getLines(root)).toEqual(['a/b&c=d.e']);
    });

    it('does not split a token that has no "?" follower', () => {
      // Trailing "?" (end of token) must not create a phantom empty fragment.
      const tree = block('div', [block('p', [textNode('Done?')])]);
      const root = doLayout(tree, 200);
      expect(getLines(root)).toEqual(['Done?']);
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

    it('prefers a hyphen break over a mid-character break', () => {
      // "well-being"=100, container=70, overflow-wrap:break-word. A hyphen is a
      // normal break opportunity, so the browser breaks there ("well-"/"being")
      // rather than mid-character ("well-be"/"ing"). break-word is last-resort.
      const tree = block('div', [
        block('p', [textNode('well-being', { overflowWrap: 'break-word' })]),
      ]);
      const root = doLayout(tree, 70);
      expect(getLines(root)).toEqual(['well-', 'being']);
    });

    it('char-breaks a hyphen segment that is itself too wide', () => {
      // container=30: each hyphen segment ("well-"=50, "being"=50) still
      // overflows, so it falls back to char-breaking within the segment.
      const tree = block('div', [
        block('p', [textNode('well-being', { overflowWrap: 'break-word' })]),
      ]);
      const root = doLayout(tree, 30);
      expect(getLines(root)).toEqual(['wel', 'l-', 'bei', 'ng']);
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

    // Tab stops (css-text-3 §tab-size, verified against Chrome):
    // interval = tab-size(8) × (space advance + letter-spacing + word-spacing)
    // computed from the BLOCK's style; when the next stop is closer than
    // half a space width (without spacing), the tab skips to the following stop.
    it('tab advances to the next 8-space tab stop', () => {
      // "ab" = 20 → interval 8 × 10 = 80 → "cd" starts at 80
      const tree = block('div', [
        block('p', [textNode('ab\tcd', { whiteSpace: 'pre-wrap' })], { whiteSpace: 'pre-wrap' }),
      ]);
      const cd = collectTexts(doLayout(tree, 400)).find(t => t.text === 'cd');
      expect(cd!.x).toBe(80);
    });

    it('tab interval includes letter-spacing', () => {
      // char = 10 + 5 → interval 8 × 15 = 120; "ab" = 30 → "cd" at 120
      const tree = block('div', [
        block('p', [textNode('ab\tcd', { whiteSpace: 'pre-wrap', letterSpacing: 5 })],
          { whiteSpace: 'pre-wrap', letterSpacing: 5 }),
      ]);
      const cd = collectTexts(doLayout(tree, 600)).find(t => t.text === 'cd');
      expect(cd!.x).toBe(120);
    });

    it('tab skips to following stop when next stop is closer than half a space', () => {
      // Block letter-spacing 5 → interval 120; skip threshold = 10/2 = 5.
      // Prefix: span(ls:1) "aaaa" = 44 + span(ls:5) "bbbbb" = 75 → pos 119.
      // Distance to stop 120 is 1 < 5 → tab jumps to 240.
      const tree = block('div', [
        block('p', [
          inline('span', [textNode('aaaa', { whiteSpace: 'pre-wrap', letterSpacing: 1 })], { letterSpacing: 1 }),
          inline('span', [textNode('bbbbb', { whiteSpace: 'pre-wrap', letterSpacing: 5 })], { letterSpacing: 5 }),
          textNode('\tcd', { whiteSpace: 'pre-wrap', letterSpacing: 5 }),
        ], { whiteSpace: 'pre-wrap', letterSpacing: 5 }),
      ]);
      const cd = collectTexts(doLayout(tree, 600)).find(t => t.text === 'cd');
      expect(cd!.x).toBe(240);
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

  // ─── Block strut ───────────────────────────────────────────────────

  describe('Block strut (line box minimum = block font)', () => {
    // CSS plants a "strut" in every block: an invisible zero-width inline box
    // carrying the block's OWN font + line-height at the start of each line
    // box. So a line whose only content is a SMALLER inline font is still at
    // least the block's own line-height tall. render-tag used to size the
    // line box from the inline content alone, under-measuring lists like
    // <li style="font-size:76px"><span style="font-size:42px">x</span></li>
    // (the line came out 50px instead of the block's 91px), which shrank the
    // reported element height and let edit-mode DOM spill past the box.
    it('sizes a line box to the block strut when inline content is smaller', () => {
      const ctx = mockCtx();
      const tree = block('div', [
        block(
          'li',
          [
            inline('span', [textNode('x', { fontSize: 42, lineHeight: 50 })], {
              fontSize: 42,
              lineHeight: 50,
            }),
          ],
          { display: 'list-item', fontSize: 76, lineHeight: 91 },
        ),
      ]);
      const { height } = buildLayoutTree(ctx, tree, 600, false);
      expect(height).toBeCloseTo(91, 0); // strut, not the span's 50
    });

    it('keeps taller inline content that exceeds the block strut', () => {
      const ctx = mockCtx();
      const tree = block('div', [
        block(
          'p',
          [
            inline('span', [textNode('x', { fontSize: 76, lineHeight: 91 })], {
              fontSize: 76,
              lineHeight: 91,
            }),
          ],
          { fontSize: 42, lineHeight: 50 },
        ),
      ]);
      const { height } = buildLayoutTree(ctx, tree, 600, false);
      expect(height).toBeCloseTo(91, 0); // content wins over the 50px strut
    });

    // The strut is a BASELINE participant, not only a height floor: a smaller
    // inline sits on the block-font baseline (lower in the taller line box),
    // not centered in it. This needs real font metrics (they must scale with
    // font-size — the mock ctx returns a fixed ascent/descent), so it runs the
    // full layout() with a system font. Guards the maxAscent/maxDescent strut
    // seed; without it the small glyph rides ~12px too high.
    it('aligns smaller-only inline text to the block-font baseline (real fonts)', () => {
      const baselineOf = (html: string): number => {
        const res = layout({
          html: `<div style="font-family:Arial;font-size:76px;line-height:1.2">${html}</div>`,
          width: 600,
        });
        // LayoutText.y is the baseline.
        return collectTexts(res.layoutRoot).find((t) => t.text === 'x')!.y;
      };
      // A 42px span and a full-size 76px glyph share the same strut baseline.
      const small = baselineOf('<span style="font-size:42px">x</span>');
      const full = baselineOf('x');
      expect(Math.abs(small - full)).toBeLessThan(1.5);
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

    // ─── Chrome-matching marker positions ──────────────────────────────
    // Bullet glyphs (•/○/■) mimic Chrome's PAINTED symbols. Chrome draws a
    // synthetic disc ~ascent/3 in diameter (bigger than the font's small '•'
    // glyph), so render-tag SCALES the glyph up to that diameter. Invariants
    // held across the scale: ink right edge at contentStart - (7 + ascent/3),
    // ink center ascent/3 above the line baseline.
    // Mock metrics: ascent = 12 → gap = 7 + 4 = 11; glyph ink height =
    // aAscent(12)+aDescent(4)=16, target = ascent/3 = 4 → scale = 0.25.
    // Text markers ("1."): gap = one space advance (Chrome suffix ". ").

    it('bullet: glyph scaled so its ink diameter == ascent/3 (Chrome disc)', () => {
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
      // scale = (ascent/3) / inkHeight = 4/16 = 0.25 → drawn at 16*0.25 = 4px.
      expect(marker.style.fontSize).toBeCloseTo(4, 5);
    });

    it('bullet: ink RIGHT edge ends 7px + ascent/3 before content', () => {
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
      // Gap to the ink right edge is preserved through the scale: mock ink
      // right == advance, so ink right edge = marker.x + marker.width and must
      // land at contentStart(30) - gap(11) = 19. (origin itself = 16.5.)
      expect(marker.x + marker.width).toBeCloseTo(19, 5);
    });

    it('bullet: glyph ink center lands ascent/3 above the line baseline', () => {
      // Custom ctx: bullet ink ascent 12 / descent 0 → ink height 12, so
      // scale = (ascent/3)/12 = 1/3. The DRAWN glyph's ink center
      // (marker.y - scaledInkAscent/2) must sit ascent/3 = 4 above the line
      // baseline regardless of the scale.
      const ctx = mockCtx();
      const base = ctx.measureText.bind(ctx);
      (ctx as any).measureText = (text: string) => {
        const m = base(text);
        if (text === '•') {
          return { ...m, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 0 };
        }
        return m;
      };
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16 }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '•',
      };
      const tree = block('div', [block('ul', [li])]);
      const { root } = buildLayoutTree(ctx, tree, 200, false);
      const texts = collectTexts(root);
      const marker = texts.find(t => t.text === '•')!;
      const item = texts.find(t => t.text === 'Item')!;
      const scale = (12 / 3) / 12; // (ascent/3) / inkHeight
      const inkCenterY = marker.y - (12 * scale) / 2;
      expect(inkCenterY).toBeCloseTo(item.y - 12 / 3, 5);
    });

    it('numbered: gap is one space advance, baseline unchanged', () => {
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16, listStyleType: 'decimal' }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '1.',
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const texts = collectTexts(root);
      const marker = texts.find(t => t.text === '1.')!;
      const item = texts.find(t => t.text === 'Item')!;
      // space advance = 10, marker advance = 20 → x = 30 - 10 - 20 = 0
      expect(marker.x).toBeCloseTo(0, 5);
      expect(marker.y).toBeCloseTo(item.y, 5);
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
      // Explicit gap 20 to the ink right edge: marker.x + marker.width = 30 - 20 = 10
      expect(marker.x + marker.width).toBeCloseTo(10, 5);
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
      // gap 0: ink right edge flush against content → marker.x + marker.width = 30
      expect(marker.x + marker.width).toBeCloseTo(30, 5);
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

    it('RTL bullet: scaled ink LEFT edge sits at boxRightEdge + gap', () => {
      // Custom '•' with a non-zero left bearing so scaling of inkLeft actually
      // matters (the default mock reports actualBoundingBoxLeft = 0). scale =
      // (ascent/3)/inkH = 4/(12+4) = 0.25; default gap = 7 + 4 = 11.
      const ctx = mockCtx();
      const base = ctx.measureText.bind(ctx);
      (ctx as any).measureText = (text: string) => {
        const m = base(text);
        if (text === '•') {
          return { ...m, actualBoundingBoxLeft: 4, actualBoundingBoxRight: 6, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 };
        }
        return m;
      };
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingRight: 30, fontSize: 16, direction: 'rtl' }),
        children: [textNode('عنصر', { direction: 'rtl' })],
        textContent: null,
        listMarker: '•',
      };
      const tree = block('div', [block('ul', [li], { direction: 'rtl' })], { direction: 'rtl' });
      const { root } = buildLayoutTree(ctx, tree, 200, false);
      const marker = collectTexts(root).find(t => t.text === '•')!;
      const liBox = (root.children[0] as LayoutBox).children[0] as LayoutBox;
      // ink left edge (facing the text) = origin - scaled left bearing (4*0.25=1)
      // must land at boxRightEdge + gap, invariant to the scale.
      expect(marker.x - 4 * 0.25).toBeCloseTo(liBox.x + liBox.width + 11, 5);
    });

    it('circle and square symbols scale to the Chrome disc like disc', () => {
      // isBullet covers disc/circle/square (BULLET_MARKERS); all three are the
      // font glyph scaled so ink height == ascent/3 (mock scale 4/16 = 0.25).
      for (const [type, glyph] of [['circle', '○'], ['square', '■']] as const) {
        const li: StyledNode = {
          element: null,
          tagName: 'li',
          style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16, listStyleType: type }),
          children: [textNode('Item')],
          textContent: null,
          listMarker: glyph,
        };
        const tree = block('div', [block('ul', [li])]);
        const root = doLayout(tree, 200);
        const marker = collectTexts(root).find(t => t.text === glyph)!;
        expect(marker.style.fontSize).toBeCloseTo(4, 5);
      }
    });

    it('marker font-size override flows into pushed marker text node', () => {
      // Number markers draw at the li/marker font unscaled (only bullet symbols
      // get the Chrome-disc scale), so the ::marker font-size flows straight
      // through — a clean check that the override reaches the pushed node.
      const li: StyledNode = {
        element: null,
        tagName: 'li',
        style: defaultStyle({ display: 'list-item', paddingLeft: 30, fontSize: 16, listStyleType: 'decimal' }),
        children: [textNode('Item')],
        textContent: null,
        listMarker: '1.',
        markerStyle: { fontSize: 8 },
      };
      const tree = block('div', [block('ul', [li])]);
      const root = doLayout(tree, 200);
      const marker = collectTexts(root).find(t => t.text === '1.')!;
      expect(marker.style.fontSize).toBe(8);
    });

    it('measures the marker at the ::marker font, not the li font', () => {
      // `getFontMetrics` used to leave `ctx.font` on the face it measured, so
      // on a COLD cache the marker was measured on the li's face instead of
      // its own. The per-call family name is what forces that cache miss; the
      // mock is fixed-width, so scale it by the ACTIVE font here — the width
      // is then the only witness to which font was current.
      const markerWidthFor = (markerFontSize: number) => {
        const ctx = mockCtx();
        const base = ctx.measureText.bind(ctx);
        (ctx as any).measureText = (text: string) => {
          const m = base(text);
          const px = parseFloat(ctx.font) || 16;
          return { ...m, width: (m.width * px) / 16 };
        };
        const li: StyledNode = {
          element: null,
          tagName: 'li',
          style: defaultStyle({
            display: 'list-item', paddingLeft: 30, fontSize: 16,
            fontFamily: `LiProbe${markerFontSize}`, listStyleType: 'decimal',
          }),
          // EMPTY: an li with text lays that text out first, which warms the
          // metrics cache for the li font and hides the clobber entirely.
          children: [],
          textContent: null,
          listMarker: '1.',
          markerStyle: { fontSize: markerFontSize },
        };
        const { root } = buildLayoutTree(ctx, block('div', [block('ul', [li])]), 200, false);
        return collectTexts(root).find(t => t.text === '1.')!.width;
      };
      // 40px is 2.5x the li's 16px. Measured on the li's face both overrides
      // come out identical, which is what the ratio catches.
      expect(markerWidthFor(40) / markerWidthFor(16)).toBeCloseTo(2.5, 5);
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

    it('negative letter-spacing narrows measurement so more chars fit per line', () => {
      // char=10, letter-spacing=-2 → 8px effective per char.
      // Container 80px: with -2 spacing, "AAAAAAAAAA" (10 chars) = 80px fits.
      // If negatives were clamped to 0 (the bug), only 8 chars (80px) would fit
      // and the word would wrap earlier.
      const tree = block('div', [
        block('p', [
          textNode('AAAAAAAAAA BBBB', { letterSpacing: -2, wordBreak: 'break-all' }),
        ]),
      ]);
      const root = doLayout(tree, 80);
      const lines = getLines(root);
      expect(lines[0]).toBe('AAAAAAAAAA');
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

    it("sub lowers, super raises by the engine's own rule (font size 16)", () => {
      // Measured off the DOM, 8-56px across three families (see CLAUDE.md):
      // Blink and WebKit shift by fontSize/3 + 1 and fontSize/5 + 1, Gecko by
      // 0.34em and 0.2em. These are not tunable constants — they are what the
      // browser does, and the parity suites check them against it.
      // BLINK_SUPER_SUB, never FLOORS_LINE_BASELINE: the two disagree exactly
      // in Safari, where the baseline is exact but the shift is Blink's.
      const superShift = BLINK_SUPER_SUB ? 16 / 3 + 1 : 16 * 0.34;
      const subShift = BLINK_SUPER_SUB ? 16 / 5 + 1 : 16 * 0.2;
      expect(yDelta('sub')).toBeCloseTo(subShift, 5);
      expect(yDelta('super')).toBeCloseTo(-superShift, 5);
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

    // ─── Clamp on a wrapper with block children (Chrome -webkit-box
    //     semantics: line boxes are counted across block descendants) ──

    describe('clamp across block children', () => {
      // 9-char words = 90px → exactly one word per line on a 100px container.

      it('truncates a single <p> child of a clamped wrapper', () => {
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd')]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(2);
        expect(lines[1].endsWith('…')).toBe(true);
        expect(root.height).toBe(40); // 2 lines × 20px
      });

      it('line budget spans multiple <p> children', () => {
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb')]),            // 2 lines
          block('p', [textNode('ccccccccc ddddddddd eeeeeeeee')]),  // 3 lines
        ], { lineClamp: 3 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(3);
        expect(lines[0]).toBe('aaaaaaaaa');
        expect(lines[1]).toBe('bbbbbbbbb');
        expect(lines[2].endsWith('…')).toBe(true);
        expect(root.height).toBe(60);
      });

      it('drops all content after the clamp point', () => {
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc')]),
          block('p', [textNode('hidden1')]),
          block('p', [textNode('hidden2')]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(2);
        expect(lines.join('')).not.toContain('hidden');
      });

      it('clamp larger than total lines: untouched, no ellipsis', () => {
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb')]),
          block('p', [textNode('ccccccccc ddddddddd')]),
        ], { lineClamp: 10 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(4);
        expect(lines.join('')).not.toContain('…');
        expect(root.height).toBe(80);
      });

      it("truncated paragraph's margin-bottom does not extend the wrapper", () => {
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc')], { marginBottom: 30 }),
          block('p', [textNode('hidden')]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        expect(getLines(root).length).toBe(2);
        expect(root.height).toBe(40); // margin below the cut line is clipped
      });

      it('works through nested block wrappers', () => {
        const tree = block('div', [
          block('div', [
            block('p', [textNode('aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd')]),
          ]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(2);
        expect(lines[1].endsWith('…')).toBe(true);
      });

      it('exact-fit boundary: following paragraph is dropped', () => {
        // First paragraph consumes the whole budget without truncation;
        // anything after it must still be dropped. (No ellipsis in this
        // case — the budget ran out between paragraphs, after the Nth
        // line was already emitted. Known limitation.)
        const tree = block('div', [
          block('p', [textNode('aaaaaaaaa bbbbbbbbb')]), // exactly 2 lines
          block('p', [textNode('hidden')]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(2);
        expect(lines.join('')).not.toContain('hidden');
        expect(root.height).toBe(40);
      });

      it('mixed inline + block children under a clamped wrapper', () => {
        const tree = block('div', [
          textNode('aaaaaaaaa bbbbbbbbb ccccccccc'), // 3 lines, truncated at 2
          block('p', [textNode('hidden')]),
        ], { lineClamp: 2 });
        const root = doLayout(tree, 100);
        const lines = getLines(root);
        expect(lines.length).toBe(2);
        expect(lines[1].endsWith('…')).toBe(true);
        expect(lines.join('')).not.toContain('hidden');
      });
    });
  });
});

describe('sameDecorationBand (run merging)', () => {
  // The layout joins adjacent runs that share a text style into one shaping
  // group, and the group carries ONE decoration entry. Two runs may only share
  // a group while the band they draw is the same, which is decided by the
  // DECORATING box — the element that declared the decoration, not the run.
  // The pixel proof lives in tests/decorating-box-geometry.test.ts; this pins
  // the rule directly, which is cheaper to run and to read.
  const entry = (declarer: Partial<ResolvedStyle>): DecorationEntry => ({
    line: 'underline',
    color: 'red',
    style: 'solid',
    declarer: defaultStyle(declarer),
  });

  it('two declarers that would draw the same band still merge', () => {
    // Keeps a shaping group whole across siblings declaring the same thing.
    expect(sameDecorationBand(entry({ fontSize: 30 }), entry({ fontSize: 30 }))).toBe(true);
  });

  it('a different declarer size splits the band', () => {
    expect(sameDecorationBand(entry({ fontSize: 30 }), entry({ fontSize: 80 }))).toBe(false);
  });

  it('a different declarer font splits the band', () => {
    // The path renderer reads the declarer's descent, which the family moves.
    expect(
      sameDecorationBand(entry({ fontFamily: 'A' }), entry({ fontFamily: 'B' })),
    ).toBe(false);
  });

  it('a vertical-aligned declarer splits the band', () => {
    // It decides which baseline the underline hangs off.
    expect(
      sameDecorationBand(entry({ verticalAlign: 'baseline' }), entry({ verticalAlign: 'super' })),
    ).toBe(false);
  });
});
