/**
 * Centered/right-aligned text with wide letter-spacing.
 *
 * Two related scenarios:
 *  1. The text wraps at letter boundaries (overflow-wrap:break-word or
 *     word-break:break-all). Each letter sits on its own line and is
 *     centered relative to the line-box width (which includes the trailing
 *     letter-spacing — that's what Chrome's foreignObject reference does).
 *  2. The text doesn't wrap and overflows the container width. Per
 *     CSS Text 3 §7.1 and Chrome's actual behavior, alignment falls back
 *     to start so the content begins at the container's leading edge
 *     instead of being pushed outside it.
 *
 * Before the fix, scenario 2 had a ~62% pixel mismatch against the DOM
 * because render-tag was placing centered overflow text at negative x.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutNode, LayoutText } from '../src/types.ts';
import { compareRenders } from './helpers/compare.ts';
import { collectTexts } from './helpers/layout-tree.ts';

const FONT = 'Arial, sans-serif';
const TOL = 2.5;

function measureDomFirstChar(
  html: string,
  width: number,
  selector: string,
  char: string,
): { left: number; top: number; width: number; height: number } {
  const c = document.createElement('div');
  c.style.cssText = `position:absolute;left:0;top:0;width:${width}px;`;
  c.innerHTML = html;
  document.body.appendChild(c);
  const target = c.querySelector(selector) as HTMLElement;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  let result = { left: 0, top: 0, width: 0, height: 0 };
  while (textNode) {
    const t = textNode.textContent || '';
    const idx = t.indexOf(char);
    if (idx !== -1) {
      const r = document.createRange();
      r.setStart(textNode, idx);
      r.setEnd(textNode, idx + 1);
      const rect = r.getBoundingClientRect();
      const cRect = c.getBoundingClientRect();
      result = {
        left: rect.left - cRect.left,
        top: rect.top - cRect.top,
        width: rect.width,
        height: rect.height,
      };
      break;
    }
    textNode = walker.nextNode() as Text | null;
  }
  document.body.removeChild(c);
  return result;
}

describe('Letter-spacing alignment at line boundaries', () => {
  it('centered, wraps at letters: each letter is positioned like the DOM', () => {
    // word-break:break-all forces letter-level wrapping; each letter is its
    // own line and should be centered exactly as the DOM does it.
    const html =
      `<div style="font-family:${FONT};font-size:32px;line-height:1.2;` +
      `text-align:center;letter-spacing:2em;width:120px;margin:0;padding:0;` +
      `word-break:break-all;">ABC</div>`;
    const width = 200;

    const dom = measureDomFirstChar(html, width, 'div', 'A');
    const rt = collectTexts(layout({ html, width }).layoutRoot)
      .find((t) => t.text.includes('A'))!;
    expect(rt, 'render-tag should emit a text node containing "A"').toBeDefined();
    expect(
      Math.abs(rt.x - dom.left),
      `render-tag x=${rt.x.toFixed(2)} vs DOM x=${dom.left.toFixed(2)}`,
    ).toBeLessThan(TOL);
  });

  it('right-aligned, wraps at letters: position matches the DOM', () => {
    const html =
      `<div style="font-family:${FONT};font-size:32px;line-height:1.2;` +
      `text-align:right;letter-spacing:2em;width:120px;margin:0;padding:0;` +
      `word-break:break-all;">AB</div>`;
    const width = 200;

    const dom = measureDomFirstChar(html, width, 'div', 'A');
    const rt = collectTexts(layout({ html, width }).layoutRoot)
      .find((t) => t.text.includes('A'))!;
    expect(rt).toBeDefined();
    expect(
      Math.abs(rt.x - dom.left),
      `render-tag x=${rt.x.toFixed(2)} vs DOM x=${dom.left.toFixed(2)}`,
    ).toBeLessThan(TOL);
  });

  it('centered overflow line falls back to start alignment (matches DOM)', () => {
    // No break-all/break-word — "ABCD" stays on one line and overflows the
    // 120px container. Chrome aligns the overflowing line as start (x=0),
    // not centered to a negative x.
    const html =
      `<div style="font-family:${FONT};font-size:32px;line-height:1.2;` +
      `text-align:center;letter-spacing:2em;width:120px;margin:0;padding:0;">ABCD</div>`;
    const width = 200;

    const dom = measureDomFirstChar(html, width, 'div', 'A');
    const rt = collectTexts(layout({ html, width }).layoutRoot)
      .find((t) => t.text.startsWith('A'))!;
    expect(rt).toBeDefined();
    expect(
      Math.abs(rt.x - dom.left),
      `render-tag x=${rt.x.toFixed(2)} vs DOM x=${dom.left.toFixed(2)}`,
    ).toBeLessThan(TOL);
  });

  it('right-aligned overflow line falls back to start alignment (matches DOM)', () => {
    const html =
      `<div style="font-family:${FONT};font-size:32px;line-height:1.2;` +
      `text-align:right;letter-spacing:2em;width:120px;margin:0;padding:0;">ABCD</div>`;
    const width = 200;

    const dom = measureDomFirstChar(html, width, 'div', 'A');
    const rt = collectTexts(layout({ html, width }).layoutRoot)
      .find((t) => t.text.startsWith('A'))!;
    expect(rt).toBeDefined();
    expect(
      Math.abs(rt.x - dom.left),
      `render-tag x=${rt.x.toFixed(2)} vs DOM x=${dom.left.toFixed(2)}`,
    ).toBeLessThan(TOL);
  });

  it('pixel score: centered wrapped letters', async () => {
    const html =
      `<div style="font-family:${FONT};font-size:28px;line-height:1.2;` +
      `text-align:center;letter-spacing:2em;width:140px;margin:0;padding:0;` +
      `overflow-wrap:break-word;">ABCD</div>`;
    const r = await compareRenders(html, '', 300, 280, 0.1, 2);
    expect(
      r.contentMismatchPercentage,
      `score ${r.contentMismatchPercentage.toFixed(2)}%`,
    ).toBeLessThan(5);
  });

  it('pixel score: centered overflowing single line (regression guard)', async () => {
    // Pre-fix this scored ~62% because the centered line was placed at
    // negative x. Post-fix it falls back to start alignment.
    const html =
      `<div style="font-family:${FONT};font-size:28px;line-height:1.2;` +
      `text-align:center;letter-spacing:2em;width:140px;margin:0;padding:0;">ABCD</div>`;
    const r = await compareRenders(html, '', 300, 280, 0.1, 2);
    expect(
      r.contentMismatchPercentage,
      `score ${r.contentMismatchPercentage.toFixed(2)}%`,
    ).toBeLessThan(10);
  });
});
