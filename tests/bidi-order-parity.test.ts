/**
 * Bidi visual order against the browser's own layout (UAX #9 L2 across runs).
 *
 * DOM side: one `Range` per character, its rect's centre x; the line's
 * characters sorted left to right. render-tag side: the run order and x are
 * layout's; the order INSIDE a run is Canvas's, which applies UAX #9 to the
 * run text in the run's direction — for a level-uniform run that is simply
 * reversed (RTL) or as-is (LTR), and for a single-paint line in Blink
 * (`CANVAS_BIDI_LINE`) it is the engine's own reordering of the whole line.
 * Whitespace is dropped on both sides.
 *
 * Each run's horizontal extent is also checked against the DOM extent of the
 * same characters, so a run in the right order at the wrong x still fails.
 *
 * Single-line fixtures in the system sans-serif: both sides use the same
 * face, and the order does not depend on which one it is.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutText } from '../src/types.ts';
import { collectTexts } from './helpers/layout-tree.ts';
import { resolveBidi, lineLevels, visualOrder } from '../src/bidi.ts';

const WIDTH = 700;
const CSS = 'p { margin: 0; font-family: sans-serif; font-size: 16px; line-height: 24px; }';
/** Extent tolerance: Range rects snap in WebKit (CLAUDE.md, geometry oracle). */
const EXTENT_TOLERANCE = 1.5;

interface Glyph { c: string; x: number }

function domOrder(html: string): { order: string; glyphs: Array<{ c: string; left: number; right: number }> } {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:0;top:0;width:${WIDTH}px;`;
  host.innerHTML = `<style>${CSS}</style>${html}`;
  document.body.appendChild(host);
  try {
    const origin = host.getBoundingClientRect().left;
    const glyphs: Array<{ c: string; left: number; right: number }> = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.tagName === 'STYLE') continue;
      const text = node.textContent ?? '';
      for (let i = 0; i < text.length; i++) {
        if (!text[i].trim()) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const r = rects.at(-1) ?? range.getBoundingClientRect();
        glyphs.push({ c: text[i], left: r.left - origin, right: r.right - origin });
      }
    }
    const order = [...glyphs].sort((a, b) => (a.left + a.right) - (b.left + b.right))
      .map((g) => g.c).join('');
    return { order, glyphs };
  } finally {
    host.remove();
  }
}

function canvasRuns(html: string): LayoutText[] {
  const result = layout({ html: `<style>${CSS}</style>${html}`, width: WIDTH });
  return collectTexts(result.layoutRoot).filter((t) => t.text.trim());
}

function canvasOrder(runs: LayoutText[]): string {
  const glyphs: Glyph[] = [];
  for (const run of runs) {
    const rtl = run.style.direction === 'rtl';
    const left = rtl ? run.x - run.width : run.x;
    // Inside one run Canvas orders the text itself (UAX #9 in the run's
    // direction): reversed for a level-uniform RTL run, as-is for LTR, and
    // the engine's own reordering for a single-paint line (CANVAS_BIDI_LINE).
    const own = resolveBidi(run.text, rtl ? 1 : 0);
    const chars = visualOrder(lineLevels(own, 0, run.text.length))
      .map((i) => run.text[i]).filter((c) => c.trim());
    // Positions inside a run only order it; spacing them evenly is enough.
    chars.forEach((c, i) => glyphs.push({ c, x: left + (i + 0.5) * (run.width / chars.length) }));
  }
  return glyphs.sort((a, b) => a.x - b.x).map((g) => g.c).join('');
}

const CASES: Record<string, string> = {
  // "Mixed scripts with formatting", line 1: the triage's failing shape.
  'two Arabic words in one bold span inside an English line':
    '<p>This paragraph mixes <strong>العربية الغامقة</strong> with text.</p>',
  // "Mixed scripts with formatting", line 3.
  'two Hebrew words in one coloured span at the line start':
    '<p><span style="color:#dc2626">עברית אדומה</span> next to text.</p>',
  'Hebrew words split across formatting elements':
    '<p>x <b>עברית</b> <i>אדומה</i> end</p>',
  'a number between Hebrew words':
    '<p>Total <b>מחיר</b> 123 שקל today</p>',
  'neutrals between Hebrew words':
    '<p>abc <b>עב,</b> רי! xyz</p>',
  'LTR code inside an Arabic paragraph':
    '<p dir="rtl">استخدم دالة <code>render()</code> لرسم النص.</p>',
  'currency, percent and brackets in an Arabic paragraph':
    '<p dir="rtl">السعر: $42.99 (خصم 10%) فقط</p>',
  'Arabic-Indic digits in an Arabic paragraph':
    '<p dir="rtl">العدد ١٢٣ هنا</p>',
  'English words in an Arabic paragraph':
    '<p dir="rtl">البرمجة Programming هي فن Art وعلم</p>',
  'an RTL span isolate inside English quotes':
    '<p>The thread said: “<span dir="rtl">هذا جيد، شكرا</span>.” ok 2026</p>',
  // dir=auto takes the direction of the first strong character (HTML; UAX #9
  // P2/P3): RTL here, so the paragraph is right-aligned and reordered RTL.
  'dir=auto with a Hebrew first strong character':
    '<p dir="auto">שלום world 123</p>',
  'dir=auto with a Latin first strong character':
    '<p dir="auto">123 world שלום</p>',
  'dir=auto on an inline span':
    '<p>a <span dir="auto">שלום world</span> b</p>',
  // CSS direction alone (unicode-bidi: normal) does not reorder an inline;
  // its LTR words must still paint LTR where layout put them.
  'an inline with direction:rtl over LTR text':
    '<p>a <span style="direction:rtl">abc, def!</span> b</p>',
};

describe('Bidi visual order parity (DOM Range rects)', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(name, () => {
      const dom = domOrder(html);
      const runs = canvasRuns(html);
      expect(canvasOrder(runs)).toBe(dom.order);

      // Extent: each run covers the DOM extent of its own characters.
      const remaining = [...dom.glyphs];
      for (const run of runs) {
        const left = run.style.direction === 'rtl' ? run.x - run.width : run.x;
        const right = left + run.width;
        const chars = [...run.text].filter((c) => c.trim());
        let domLeft = Infinity;
        let domRight = -Infinity;
        for (const c of chars) {
          // The DOM glyph of this character nearest the run's span.
          let best = -1;
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].c !== c) continue;
            const d = Math.abs((remaining[i].left + remaining[i].right) / 2 - (left + right) / 2);
            if (best < 0 || d < Math.abs((remaining[best].left + remaining[best].right) / 2 - (left + right) / 2)) best = i;
          }
          if (best < 0) continue;
          domLeft = Math.min(domLeft, remaining[best].left);
          domRight = Math.max(domRight, remaining[best].right);
          remaining.splice(best, 1);
        }
        // A side that ends in a space has no glyph there to compare.
        const rtl = run.style.direction === 'rtl';
        const spaceLeft = rtl ? /\s$/.test(run.text) : /^\s/.test(run.text);
        const spaceRight = rtl ? /^\s/.test(run.text) : /\s$/.test(run.text);
        if (!spaceLeft) {
          expect(Math.abs(left - domLeft), `${name}: "${run.text}" left`).toBeLessThan(EXTENT_TOLERANCE);
        }
        if (!spaceRight) {
          expect(Math.abs(right - domRight), `${name}: "${run.text}" right`).toBeLessThan(EXTENT_TOLERANCE);
        }
      }
    });
  }
});
