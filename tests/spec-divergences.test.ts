/**
 * Spec divergence regression tests.
 *
 * Each test renders an HTML snippet in real Chrome (via DOM measurement)
 * and via render-tag, asserts the canvas output matches expected browser
 * behaviour. Each is an independently-failing test pinpointing one bug.
 */
import { describe, it, expect } from 'vitest';
import { renderToCanvas } from './helpers/compare.ts';

// ─── Helpers ───────────────────────────────────────────────────────────

function rightmostInkX(canvas: HTMLCanvasElement, yStart: number, yEnd: number): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let maxX = -1;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = canvas.width - 1; x >= 0; x--) {
      const i = (y * canvas.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 0 && (r < 250 || g < 250 || b < 250)) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  return maxX;
}

function leftmostInkX(canvas: HTMLCanvasElement, yStart: number, yEnd: number): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 0 && (r < 250 || g < 250 || b < 250)) {
        if (x < minX) minX = x;
        break;
      }
    }
  }
  return minX === canvas.width ? -1 : minX;
}

/** Browser DOM measurement: returns left edge of every visible word. */
function browserWordPositions(html: string): { text: string; x: number; y: number }[] {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;';
  container.innerHTML = html;
  document.body.appendChild(container);
  const inner = container.firstElementChild as HTMLElement;
  const cl = inner.getBoundingClientRect().left;
  const ct = inner.getBoundingClientRect().top;
  const words: { text: string; x: number; y: number }[] = [];
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent || '';
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      words.push({ text: m[0], x: r.left - cl, y: r.top - ct });
    }
  }
  document.body.removeChild(container);
  return words;
}

// ─── 1. Justify + hard break ────────────────────────────────────────────

describe('1. text-align: justify + hard break', () => {
  it('pre-wrap \\n: line before forced break is NOT justified', () => {
    const html = `<div style="width:400px; white-space:pre-wrap; text-align:justify; font:20px sans-serif">A    B    C
D    E    F</div>`;
    const { canvas } = renderToCanvas(html, '', 500, 200, 1);
    const line0Right = rightmostInkX(canvas, 0, 28);
    expect(line0Right).toBeLessThan(200); // browser: ~80, render-tag: 399
  });

  it('<br>: line before <br> is NOT justified', () => {
    const html = `<div style="width:400px; text-align:justify; font:20px sans-serif">A    B    C<br>D    E    F</div>`;
    const { canvas } = renderToCanvas(html, '', 500, 200, 1);
    const line0Right = rightmostInkX(canvas, 0, 28);
    expect(line0Right).toBeLessThan(200);
  });
});

// ─── 2. text-indent ─────────────────────────────────────────────────────

describe('2. text-indent', () => {
  it('first line is shifted by text-indent', () => {
    const html = `<div style="width:400px; text-indent:50px; font:20px sans-serif">First line text. Second line wraps onto here because we need enough words.</div>`;
    const browser = browserWordPositions(html);
    const firstWord = browser[0];
    // Browser places "First" at x ≈ 50.
    expect(firstWord.x).toBeGreaterThan(40);
    // render-tag: should also shift.
    const { canvas } = renderToCanvas(html, '', 500, 200, 1);
    // Inspect only the very top of the first line (above where line 2 could start).
    const leftIx = leftmostInkX(canvas, 4, 18);
    expect(leftIx).toBeGreaterThan(40);
  });
});

// ─── 3. <wbr> ──────────────────────────────────────────────────────────

describe('3. <wbr> word break opportunity', () => {
  it('long word with <wbr> breaks at the wbr', () => {
    // Width chosen so the word fits only if the <wbr> breaks it.
    const html = `<div style="width:120px; font:20px sans-serif">supercalifragilistic<wbr>expialidocious</div>`;
    const browser = browserWordPositions(html);
    // Expect "expialidocious" wraps to a second line in browser.
    const ys = [...new Set(browser.map(w => Math.round(w.y / 5) * 5))];
    expect(ys.length).toBeGreaterThanOrEqual(2);
    // render-tag: render and check that there's content on the second line.
    const { canvas } = renderToCanvas(html, '', 200, 200, 1);
    const line1HasInk = leftmostInkX(canvas, 30, 56) >= 0;
    expect(line1HasInk).toBe(true);
  });
});

// ─── 4. text-align-last: justify ──────────────────────────────────────

describe('4. text-align-last: justify', () => {
  it('last line is justified when text-align-last:justify', () => {
    const html = `<div style="width:300px; text-align:justify; text-align-last:justify; font:20px sans-serif">A B C D E F G H</div>`;
    // Single line — without text-align-last:justify it would be start-aligned.
    // With it, the line should fill to ~300.
    const { canvas } = renderToCanvas(html, '', 400, 100, 1);
    const right = rightmostInkX(canvas, 0, 28);
    // Browser: last word "H" sits flush right around x ≈ 290.
    expect(right).toBeGreaterThan(270);
  });
});

// ─── 5. text-transform: capitalize + Unicode ──────────────────────────

describe('5. text-transform: capitalize Unicode', () => {
  it('capitalizes non-ASCII first letters (über → Über)', () => {
    const html = `<div style="text-transform:capitalize; font:20px sans-serif">über</div>`;
    const browser = browserWordPositions(html);
    // Browser will render "Über" — the rendered text starts with capital U+0308 ligature
    // We check via DOM textContent + computed transform isn't directly observable, but
    // we can check render-tag's output text via its public API.
    const { canvas, lines } = renderToCanvas(html, '', 200, 100, 1);
    const renderedText = lines.map(l => l.text).join('');
    // Browser would render "Über"; render-tag with /\b\w/g leaves "über" because \w doesn't match ü.
    expect(renderedText.startsWith('Ü')).toBe(true);
  });
});

// ─── 7. <ol start="N"> ────────────────────────────────────────────────

describe('7. <ol start="N">', () => {
  it('first marker is N, not 1', () => {
    const html = `<ol start="5" style="font:20px sans-serif"><li>first</li><li>second</li></ol>`;
    const { lines } = renderToCanvas(html, '', 400, 200, 1);
    const text = lines.map(l => l.text).join('\n');
    // Browser would render markers "5." and "6." — render-tag uses internal index.
    expect(text).toContain('5.');
    expect(text).toContain('6.');
  });
});

// ─── 8. list-style-type: lower-roman ──────────────────────────────────

describe('8. list-style-type: lower-roman', () => {
  it('produces roman numerals', () => {
    const html = `<ol style="list-style-type:lower-roman; font:20px sans-serif"><li>a</li><li>b</li><li>c</li></ol>`;
    const { lines } = renderToCanvas(html, '', 400, 200, 1);
    const text = lines.map(l => l.text).join('\n');
    expect(text).toContain('i.');
    expect(text).toContain('ii.');
    expect(text).toContain('iii.');
  });
});

// ─── 9. <li value="N"> ────────────────────────────────────────────────

describe('9. <li value="N">', () => {
  it('reseeds the counter from <li value>', () => {
    const html = `<ol style="font:20px sans-serif"><li>a</li><li value="10">b</li><li>c</li></ol>`;
    const { lines } = renderToCanvas(html, '', 400, 200, 1);
    const text = lines.map(l => l.text).join('\n');
    // Browser renders 1., 10., 11. — render-tag does 1., 2., 3.
    expect(text).toContain('10.');
    expect(text).toContain('11.');
  });
});

// ─── 10. <ol reversed> ────────────────────────────────────────────────

describe('10. <ol reversed>', () => {
  it('counts down from N', () => {
    const html = `<ol reversed style="font:20px sans-serif"><li>a</li><li>b</li><li>c</li></ol>`;
    const { lines } = renderToCanvas(html, '', 400, 200, 1);
    const text = lines.map(l => l.text).join('\n');
    // Browser: 3., 2., 1.
    const idx3 = text.indexOf('3.');
    const idx1 = text.indexOf('1.');
    expect(idx3).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeGreaterThan(idx3); // 1. comes after 3.
  });
});

// ─── 11. <wbr> precise break position ─────────────────────────────────

describe('11. <wbr> break position', () => {
  it('breaks exactly at <wbr>, not elsewhere', () => {
    // Container is wide enough to fit "hello" but not "helloworld".
    // With <wbr>, it should wrap as "hello" / "world".
    // Without honoring wbr, the long word may wrap elsewhere or overflow.
    const html = `<div style="width:80px; font:20px sans-serif; word-break:keep-all">hello<wbr>world</div>`;
    const { canvas, lines } = renderToCanvas(html, '', 200, 100, 1);
    // Render-tag returns one .text per line. If wbr were honored, we'd see
    // two lines: "hello" and "world".
    const lineTexts = lines.map(l => l.text.trim());
    expect(lineTexts).toContain('hello');
    expect(lineTexts).toContain('world');
  });
});

// ─── 12. <br> inside white-space: nowrap ──────────────────────────────

describe('12. <br> inside nowrap', () => {
  it('<br> still breaks even when white-space:nowrap', () => {
    const html = `<div style="width:400px; white-space:nowrap; font:20px sans-serif">first<br>second</div>`;
    const browser = browserWordPositions(html);
    const yFirst = browser.find(w => w.text === 'first')!.y;
    const ySecond = browser.find(w => w.text === 'second')!.y;
    expect(ySecond - yFirst).toBeGreaterThan(15); // browser breaks at <br>
    const { lines } = renderToCanvas(html, '', 500, 200, 1);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 13. <hr> element ────────────────────────────────────────────────

describe('13. <hr> element', () => {
  it('<hr> renders as a horizontal line', () => {
    const html = `<div style="font:20px sans-serif">A<hr>B</div>`;
    const browser = browserWordPositions(html);
    const ya = browser.find(w => w.text === 'A')!.y;
    const yb = browser.find(w => w.text === 'B')!.y;
    expect(yb - ya).toBeGreaterThan(20); // browser: hr takes vertical space
    const { canvas, lines } = renderToCanvas(html, '', 400, 200, 1);
    // Find the y of "B" in the canvas: scan ink lines.
    const inkRows: number[] = [];
    let inInk = false;
    for (let y = 0; y < canvas.height; y++) {
      const has = rightmostInkX(canvas, y, y + 1) >= 0;
      if (has && !inInk) { inkRows.push(y); inInk = true; }
      else if (!has) inInk = false;
    }
    // Browser: 3 distinct ink runs (A, hr line, B). render-tag without hr support: 2 (A, B).
    expect(inkRows.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 14. text-align: right with trailing whitespace ───────────────────

describe('14. text-align: right ignores trailing whitespace', () => {
  it('trailing space does not push text away from right edge', () => {
    // CSS Text 3 §3: Trailing whitespace at end of a line is "hung" outside
    // the line box for alignment purposes. So "hello " with text-align:right
    // should put "hello" flush right, not "hello " (offset by one space width).
    const html = `<div style="width:200px; text-align:right; font:20px monospace">hello </div>`;
    const browser = browserWordPositions(html);
    const helloX = browser.find(w => w.text === 'hello')!.x;
    // Browser: "hello" right edge at ~200, so left edge ~140 (5 chars * 12px).
    // If trailing space were counted, left edge would be ~128.
    const browserHelloRight = helloX + 60; // approximate
    const { canvas } = renderToCanvas(html, '', 300, 100, 1);
    const right = rightmostInkX(canvas, 0, 28);
    // Both should be near 200. Just confirm render-tag puts text near 200.
    expect(Math.abs(right - browserHelloRight)).toBeLessThan(15);
  });
});

// ─── 15. <pre> / <code> default monospace ─────────────────────────────

// (already in defaults map — sanity skip)

// ─── 16. empty <p></p> takes vertical space ──────────────────────────

describe('16. empty <p></p>', () => {
  it('empty paragraph between two paragraphs adds a line of space', () => {
    const html = `<div style="font:20px sans-serif"><p>before</p><p></p><p>after</p></div>`;
    const browser = browserWordPositions(html);
    const yBefore = browser.find(w => w.text === 'before')!.y;
    const yAfter = browser.find(w => w.text === 'after')!.y;
    // Browser: with default p margins, gap is roughly 60-100px (margin top+bottom + empty line).
    // The empty p contributes its own height plus margins.
    const gap = yAfter - yBefore;

    const { canvas } = renderToCanvas(html, '', 400, 400, 1);
    // Find first ink row and last ink row in canvas to measure rendered gap.
    let firstY = -1, lastY = -1;
    for (let y = 0; y < canvas.height; y++) {
      if (rightmostInkX(canvas, y, y + 1) >= 0) { if (firstY < 0) firstY = y; lastY = y; }
    }
    // The rendered total height should track the browser layout.
    // If empty <p> is dropped, the gap will be smaller.
    expect(lastY - firstY).toBeGreaterThan(gap - 30);
  });
});

// ─── 17. (removed) — trailing \n is absorbed by browsers; covered in
//        tests/whitespace-edge-cases.test.ts ─────────────────────────

// ─── 18. <small> element font-size ────────────────────────────────────

describe('18. <small> element', () => {
  it('shrinks text to 0.83x', () => {
    const html = `<div style="font:20px sans-serif">Big <small>tiny</small></div>`;
    const browser = browserWordPositions(html);
    // Heights aren't directly measured; check Y positions and fonts via DOM.
    // Simpler: render both and check pixel heights of the two words.
    const { canvas } = renderToCanvas(html, '', 400, 100, 1);
    // Collect ink height of the two words by scanning columns separately.
    // Big covers x ≈ 0..40, tiny covers x ≈ 50..90.
    function inkHeight(xStart: number, xEnd: number): number {
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minY = canvas.height, maxY = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const i = (y * canvas.width + x) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (a > 0 && (r < 250 || g < 250 || b < 250)) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            break;
          }
        }
      }
      return maxY - minY;
    }
    // We don't know exact word x ranges, so use whole-line scan based on browser positions.
    const big = browser.find(w => w.text === 'Big')!;
    const tiny = browser.find(w => w.text === 'tiny')!;
    const bigHeight = inkHeight(Math.max(0, big.x - 2), big.x + 50);
    const tinyHeight = inkHeight(Math.max(0, tiny.x - 2), tiny.x + 50);
    // Browser: tinyHeight should be ~0.83 of bigHeight.
    // render-tag without small support: roughly equal heights.
    expect(tinyHeight).toBeLessThan(bigHeight * 0.95);
  });
});

// ─── 6. pre-line collapses spaces but preserves newlines ──────────────

describe('6. pre-line preserves blank lines from \\n\\n', () => {
  it('two consecutive \\n produce a blank line', () => {
    const html = `<div style="white-space:pre-line; font:20px sans-serif; line-height:30px">A\n\nB</div>`;
    // Browser: "A" at y=0, "B" at y=60 (blank line at y=30).
    const browser = browserWordPositions(html);
    const ya = browser.find(w => w.text === 'A')!.y;
    const yb = browser.find(w => w.text === 'B')!.y;
    expect(yb - ya).toBeGreaterThan(50); // ~60 in browser

    // render-tag: scan for ink rows
    const { canvas } = renderToCanvas(html, '', 300, 200, 1);
    const aTop = (() => {
      for (let y = 0; y < canvas.height; y++) {
        if (rightmostInkX(canvas, y, y + 1) >= 0) return y;
      }
      return -1;
    })();
    // Find next ink row after the first text block ends
    let aBottom = aTop;
    for (let y = aTop; y < canvas.height; y++) {
      if (rightmostInkX(canvas, y, y + 1) < 0) { aBottom = y; break; }
    }
    let bTop = -1;
    for (let y = aBottom; y < canvas.height; y++) {
      if (rightmostInkX(canvas, y, y + 1) >= 0) { bTop = y; break; }
    }
    // Expect blank line gap between A and B (>= 30px line of empty space).
    expect(bTop - aBottom).toBeGreaterThan(15);
  });
});
