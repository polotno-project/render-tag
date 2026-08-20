/**
 * Whitespace, newline, wrapping, and alignment edge cases.
 *
 * Strategy: each test renders the exact same HTML in the real browser DOM
 * (chromium) and via render-tag's `layout()`. We measure the visible text's
 * x position via `getBoundingClientRect()` and assert render-tag is within
 * a small tolerance of the browser. Tolerance is 2.5px to absorb canvas vs.
 * DOM shaper rounding.
 *
 * Where the implementation correctly handles a case, the test serves as a
 * regression guard. Where it diverges, the test fails, exposing a bug.
 *
 * NBSP is written as ` ` so the source stays ASCII; the runtime values
 * are the actual non-breaking-space character.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutNode, LayoutText } from '../src/types.ts';
import { collectTexts } from './helpers/layout-tree.ts';

const FONT = 'Arial, sans-serif';
const TOL = 2.5;
const NBSP = ' ';

/** Group render-tag layout texts by Y. */
function rtLines(html: string, width: number): { y: number; text: string; x: number }[] {
  const result = layout({ html, width });
  const texts = collectTexts(result.layoutRoot);
  const byY = new Map<number, { text: string; x: number }>();
  for (const t of texts) {
    const y = Math.round(t.y);
    const cur = byY.get(y);
    if (cur) {
      cur.text += t.text;
      cur.x = Math.min(cur.x, t.x);
    } else {
      byY.set(y, { text: t.text, x: t.x });
    }
  }
  return [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, v]) => ({ y, text: v.text, x: v.x }));
}

/** Render html in DOM and return the bounding rect of the first range matching `word`. */
function measureDomWord(
  html: string,
  width: number,
  selector: string,
  word: string,
  occurrence = 0,
): { left: number; top: number; width: number; height: number } | null {
  const container = document.createElement('div');
  container.style.cssText = `position:absolute;left:0;top:0;width:${width}px;`;
  container.innerHTML = html;
  document.body.appendChild(container);

  const target = container.querySelector(selector) as HTMLElement | null;
  if (!target) {
    document.body.removeChild(container);
    return null;
  }

  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let count = 0;
  let result: { left: number; top: number; width: number; height: number } | null = null;
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const text = textNode.textContent || '';
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      if (count === occurrence) {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + word.length);
        const rect = range.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        result = {
          left: rect.left - cRect.left,
          top: rect.top - cRect.top,
          width: rect.width,
          height: rect.height,
        };
        break;
      }
      count++;
      idx += word.length;
    }
    if (result) break;
    textNode = walker.nextNode() as Text | null;
  }

  document.body.removeChild(container);
  return result;
}

/** Total content right edge in DOM (range over the whole div). */
function domContentRightEdge(html: string, width: number): number {
  const c = document.createElement('div');
  c.style.cssText = `position:absolute;left:0;top:0;width:${width}px;`;
  c.innerHTML = html;
  document.body.appendChild(c);
  const div = c.firstElementChild as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(div);
  const right = range.getBoundingClientRect().right - c.getBoundingClientRect().left;
  document.body.removeChild(c);
  return right;
}

/** Total content right edge in render-tag (max x+width across text nodes). */
function rtContentRightEdge(html: string, width: number): number {
  const r = layout({ html, width });
  const texts = collectTexts(r.layoutRoot);
  return Math.max(...texts.map(t => t.x + t.width));
}

/**
 * Compare render-tag's x-position of a word against the DOM's, asserting
 * within tolerance. The word must appear in render-tag's output as its own
 * text node.
 */
function expectMatchesDom(
  html: string,
  width: number,
  selector: string,
  word: string,
  occurrence = 0,
): void {
  const dom = measureDomWord(html, width, selector, word, occurrence);
  expect(dom, `DOM measurement for "${word}" missing`).not.toBeNull();
  const rtAll = collectTexts(layout({ html, width }).layoutRoot)
    .filter(t => t.text === word);
  const rt = rtAll[occurrence];
  expect(rt, `render-tag has no node for "${word}" at occurrence ${occurrence}`).toBeDefined();
  expect(Math.abs(rt!.x - dom!.left)).toBeLessThan(TOL);
}

const baseStyle = (overrides: string = '') =>
  `font-family: ${FONT}; font-size: 32px; line-height: 1.2; margin: 0; padding: 0; ${overrides}`;

describe('Whitespace edge cases', () => {

  // ─── Trailing whitespace ──────────────────────────────────────────

  describe('Trailing whitespace', () => {
    it('pre-wrap: multiple trailing spaces before \\n shift centered text further left', () => {
      const css = baseStyle('text-align:center;white-space:pre-wrap;width:400px;');
      const oneSpace = measureDomWord(`<div style="${css}">Word <br></div>`, 400, 'div', 'Word')!;
      const threeSpaces = measureDomWord(`<div style="${css}">Word   <br></div>`, 400, 'div', 'Word')!;
      const noSpace = measureDomWord(`<div style="${css}">Word<br></div>`, 400, 'div', 'Word')!;

      // DOM ground truth: each trailing space contributes ~half its width to
      // the left-shift (because text is centered). Three spaces > one space.
      expect(noSpace.left - threeSpaces.left).toBeGreaterThan(noSpace.left - oneSpace.left);

      expectMatchesDom(`<div style="${css}">Word   <br></div>`, 400, 'div', 'Word');
    });

    it('pre-wrap: trailing tab before \\n is included in centered line width', () => {
      const css = baseStyle('text-align:center;white-space:pre-wrap;width:600px;');
      expectMatchesDom(`<div style="${css}">Word\t<br></div>`, 600, 'div', 'Word');
    });

    it('pre-wrap: trailing space + text-align:right shifts line left by space width', () => {
      const css = baseStyle('text-align:right;white-space:pre-wrap;width:400px;');
      expectMatchesDom(`<div style="${css}">Word <br></div>`, 400, 'div', 'Word');
    });

    it('normal: multiple trailing spaces collapse and are stripped', () => {
      const css = baseStyle('text-align:center;width:400px;');
      expectMatchesDom(`<div style="${css}">Word   </div>`, 400, 'div', 'Word');
    });

    it('pre-wrap: trailing space at end of content (no \\n) is preserved', () => {
      // The original Polotno bug case: trailing space at EOC, no <br>.
      const css = baseStyle('text-align:center;white-space:pre-wrap;width:400px;');
      expectMatchesDom(`<div style="${css}">Word </div>`, 400, 'div', 'Word');
    });
  });

  // ─── Leading whitespace ───────────────────────────────────────────

  describe('Leading whitespace', () => {
    it('pre-wrap: leading space at start of content is preserved', () => {
      const css = baseStyle('text-align:left;white-space:pre-wrap;width:400px;');
      expectMatchesDom(`<div style="${css}"> Word</div>`, 400, 'div', 'Word');
    });

    it('pre-wrap: leading space after \\n is preserved', () => {
      const css = baseStyle('text-align:left;white-space:pre-wrap;width:400px;');
      expectMatchesDom(`<div style="${css}">First\n After</div>`, 400, 'div', 'After');
    });

    it('normal: leading space at start of content is stripped', () => {
      const css = baseStyle('text-align:left;width:400px;');
      expectMatchesDom(`<div style="${css}"> Word</div>`, 400, 'div', 'Word');
    });

    it('normal: leading space after a soft wrap is stripped', () => {
      const css = baseStyle('text-align:left;width:120px;');
      const html = `<div style="${css}">aaaa bbbb</div>`;
      expectMatchesDom(html, 120, 'div', 'bbbb');
    });
  });

  // ─── Multiple spaces ──────────────────────────────────────────────

  describe('Multiple internal spaces', () => {
    it('pre-wrap: preserves multiple internal spaces', () => {
      const css = baseStyle('text-align:left;white-space:pre-wrap;width:400px;');
      expectMatchesDom(`<div style="${css}">A   B</div>`, 400, 'div', 'B');
    });

    it('normal: collapses multiple spaces to one', () => {
      const css = baseStyle('text-align:left;width:400px;');
      expectMatchesDom(`<div style="${css}">A   B</div>`, 400, 'div', 'B');
    });

    it('pre-line: collapses multiple spaces but preserves \\n', () => {
      const css = baseStyle('text-align:left;white-space:pre-line;width:400px;');
      expectMatchesDom(`<div style="${css}">A   B</div>`, 400, 'div', 'B');

      const html = `<div style="${css}">Line1\nLine2</div>`;
      const dom = measureDomWord(html, 400, 'div', 'Line2')!;
      const rt = collectTexts(layout({ html, width: 400 }).layoutRoot)
        .find(t => t.text === 'Line2')!;
      expect(rt).toBeDefined();
      // Both DOM and render-tag should put "Line2" on the second line (y > 10).
      expect(dom.top).toBeGreaterThan(10);
      expect(rt.y).toBeGreaterThan(10);
    });
  });

  // ─── Tab character ────────────────────────────────────────────────

  describe('Tab in pre-wrap', () => {
    it('snaps to 8-space tab stop', () => {
      const css = baseStyle('text-align:left;white-space:pre-wrap;width:600px;');
      expectMatchesDom(`<div style="${css}">A\tB</div>`, 600, 'div', 'B');
    });
  });

  // ─── Non-breaking space ───────────────────────────────────────────

  describe('Non-breaking space (\\u00A0)', () => {
    it('keeps NBSP-joined words on the same line (no break opportunity at NBSP)', () => {
      // Width is just barely too small to fit "word word" with a regular
      // space (2 words on one line), but with NBSP, the joined string has
      // no break opportunity inside it, so it must stay on one line.
      const css = baseStyle('width:400px;');
      const html = `<div style="${css}">word${NBSP}word</div>`;
      const lines = rtLines(html, 400);
      expect(lines.length).toBe(1);
    });

    it('NBSPs are preserved (do not collapse) in normal mode', () => {
      // Compare total content widths: 2 NBSPs vs 1 NBSP. They must differ
      // by ~one NBSP-width in DOM, and render-tag must match.
      const css = baseStyle('text-align:left;width:400px;');
      const htmlTwo = `<div style="${css}">A${NBSP}${NBSP}B</div>`;
      const htmlOne = `<div style="${css}">A${NBSP}B</div>`;

      const domTwo = domContentRightEdge(htmlTwo, 400);
      const domOne = domContentRightEdge(htmlOne, 400);
      const rtTwo = rtContentRightEdge(htmlTwo, 400);
      const rtOne = rtContentRightEdge(htmlOne, 400);

      // Sanity: DOM doesn't collapse NBSPs (2-NBSP wider than 1-NBSP).
      expect(domTwo - domOne).toBeGreaterThan(5);
      // Render-tag matches DOM in both cases.
      expect(Math.abs(rtTwo - domTwo)).toBeLessThan(TOL);
      expect(Math.abs(rtOne - domOne)).toBeLessThan(TOL);
    });
  });

  // ─── Newline handling ─────────────────────────────────────────────

  describe('Newlines', () => {
    it('pre-wrap: multiple consecutive \\n produce empty lines', () => {
      const css = baseStyle('white-space:pre-wrap;width:400px;');
      const html = `<div style="${css}">A\n\n\nB</div>`;
      const result = layout({ html, width: 400 });
      const a = collectTexts(result.layoutRoot).find(t => t.text === 'A')!;
      const b = collectTexts(result.layoutRoot).find(t => t.text === 'B')!;
      const lineHeight = 32 * 1.2;
      // Vertical distance from A to B = 3 line-heights (one per \n).
      expect(Math.abs((b.y - a.y) - lineHeight * 3)).toBeLessThan(2);
    });

    it('pre-wrap: leading \\n produces empty first line', () => {
      const css = baseStyle('white-space:pre-wrap;width:400px;');
      const html = `<div style="${css}">\nWord</div>`;
      const result = layout({ html, width: 400 });
      const word = collectTexts(result.layoutRoot).find(t => t.text === 'Word')!;
      const lineHeight = 32 * 1.2;
      expect(word.y).toBeGreaterThan(lineHeight - 2);
    });

    it('pre-wrap: trailing \\n is absorbed (no extra empty line)', () => {
      // CSS Text 3 / browser behavior: a trailing \n at end of content does
      // not produce an extra empty line. `\n\n` produces one empty line
      // (between the two \n's); a single trailing \n is absorbed.
      function rtH(html: string) { return layout({ html, width: 400 }).height; }
      function domH(html: string) {
        const c = document.createElement('div');
        c.style.cssText = 'position:absolute;left:0;top:0;width:400px;';
        c.innerHTML = html;
        document.body.appendChild(c);
        const h = (c.firstElementChild as HTMLElement).getBoundingClientRect().height;
        document.body.removeChild(c);
        return h;
      }
      const css = baseStyle('white-space:pre-wrap;width:400px;');
      const plain = `<div style="${css}">Word</div>`;
      const oneNl = `<div style="${css}">Word\n</div>`;
      const twoNl = `<div style="${css}">Word\n\n</div>`;
      // DOM ground truth: plain == oneNl < twoNl (by exactly 1 line-height).
      expect(Math.abs(domH(plain) - domH(oneNl))).toBeLessThan(1);
      expect(domH(twoNl) - domH(oneNl)).toBeGreaterThan(20);
      // Render-tag matches.
      expect(Math.abs(rtH(plain) - rtH(oneNl))).toBeLessThan(1);
      expect(rtH(twoNl) - rtH(oneNl)).toBeGreaterThan(20);
    });

    it('normal: \\n inside text is treated as a space (no break)', () => {
      const css = baseStyle('white-space:normal;width:400px;');
      const html = `<div style="${css}">A\nB</div>`;
      const lines = rtLines(html, 400);
      expect(lines.length).toBe(1);
    });

    it('<br> in normal mode forces a break', () => {
      const css = baseStyle('width:400px;');
      const html = `<div style="${css}">First<br>Second</div>`;
      const result = layout({ html, width: 400 });
      const first = collectTexts(result.layoutRoot).find(t => t.text === 'First')!;
      const second = collectTexts(result.layoutRoot).find(t => t.text === 'Second')!;
      const lineHeight = 32 * 1.2;
      expect(second.y - first.y).toBeGreaterThan(lineHeight - 2);
    });
  });

  // ─── Alignment ────────────────────────────────────────────────────

  describe('Alignment with wrapped lines', () => {
    it('center: each wrapped line is centered independently', () => {
      const css = baseStyle('text-align:center;width:200px;');
      const html = `<div style="${css}">longword shortw</div>`;
      expectMatchesDom(html, 200, 'div', 'longword');
      expectMatchesDom(html, 200, 'div', 'shortw');
    });

    it('right: each wrapped line is right-aligned', () => {
      const css = baseStyle('text-align:right;width:200px;');
      const html = `<div style="${css}">longword shortw</div>`;
      expectMatchesDom(html, 200, 'div', 'longword');
      expectMatchesDom(html, 200, 'div', 'shortw');
    });

    it('justify: last line is left-aligned (not justified)', () => {
      const css = baseStyle('text-align:justify;width:280px;');
      const html = `<div style="${css}">aaa bbb ccc ddd eee</div>`;
      const result = layout({ html, width: 280 });
      const texts = collectTexts(result.layoutRoot);
      const byY = new Map<number, LayoutText[]>();
      for (const t of texts) {
        const y = Math.round(t.y);
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y)!.push(t);
      }
      const sortedYs = [...byY.keys()].sort((a, b) => a - b);
      expect(sortedYs.length).toBeGreaterThanOrEqual(2);
      const lastLineTexts = byY.get(sortedYs[sortedYs.length - 1])!;
      const firstLastLineWord = lastLineTexts.reduce((min, t) => t.x < min.x ? t : min, lastLineTexts[0]);
      const word = firstLastLineWord.text.trim().split(/\s+/)[0];
      if (word) expectMatchesDom(html, 280, 'div', word);
    });
  });

  // ─── All-whitespace / empty ───────────────────────────────────────

  describe('Empty / all-whitespace content', () => {
    it('pre-wrap: all-whitespace content has visible height', () => {
      const css = baseStyle('white-space:pre-wrap;width:400px;');
      const html = `<div style="${css}">   </div>`;
      const result = layout({ html, width: 400 });
      const lineHeight = 32 * 1.2;
      expect(result.height).toBeGreaterThan(lineHeight - 2);
    });
  });
});
