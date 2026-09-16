import { describe, expect, it } from 'vitest';
import { layout, type LayoutBox } from '../src/index.ts';

const STYLE = 'font-family:Arial;font-size:20px;line-height:1.5;margin:0';

function boxes(root: LayoutBox, tag: string): LayoutBox[] {
  return [
    ...(root.tagName === tag ? [root] : []),
    ...root.children.flatMap(child => child.type === 'box' ? boxes(child, tag) : []),
  ];
}

describe('layout line metadata', () => {
  it('distinguishes a hard break from an otherwise identical soft wrap', () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '20px Arial';
    const width = Math.ceil(ctx.measureText('The quick brown fox jumps').width) + 1;
    const hard = layout({
      html: `<p style="${STYLE}">The quick brown fox jumps<br>over</p>`, width,
    });
    const soft = layout({
      html: `<p style="${STYLE}">The quick brown fox jumps over</p>`, width,
    });

    expect(hard.lines.map(({ text, y }) => ({ text, y })))
      .toEqual(soft.lines.map(({ text, y }) => ({ text, y })));
    // Firefox can differ by ~0.000015px after accumulating word widths.
    hard.lines.forEach((line, i) => {
      expect(line.bounds.width).toBeCloseTo(soft.lines[i].bounds.width, 4);
    });
    expect(hard.lines.map(line => line.text)).toEqual(['The quick brown fox jumps', 'over']);
    expect(boxes(hard.layoutRoot, 'p')[0].lineBoxes?.map(line => line.endedByHardBreak))
      .toEqual([true, false]);
    expect(boxes(soft.layoutRoot, 'p')[0].lineBoxes?.map(line => line.endedByHardBreak))
      .toEqual([false, false]);
  });

  it.each([
    ['', 0], ['<br>', 1], ['<br><br>', 2],
  ] as const)('exposes actual blank lines in <p>%s</p>, without inventing any', (middle, count) => {
    const html = `<style>p { ${STYLE} }</style><p>first</p><p>${middle}</p><p>third</p>`;
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px';
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const native = [...host.querySelectorAll('p')].map(p => p.getBoundingClientRect());
      const result = layout({ html, width: 400 });
      const paragraphs = boxes(result.layoutRoot, 'p');
      const blankLines = paragraphs[1].lineBoxes ?? [];
      expect(blankLines).toHaveLength(count);
      expect(blankLines.every(line => line.width === 0 && line.endedByHardBreak)).toBe(true);
      expect(paragraphs[1].height).toBeCloseTo(native[1].height, 5);
      expect(blankLines.reduce((height, line) => height + line.height, 0))
        .toBeCloseTo(native[1].height, 5);
      for (const [i, line] of blankLines.entries()) {
        expect(line.y).toBeCloseTo(native[1].top - native[0].top + i * line.height, 5);
      }
      expect(paragraphs[2].lineBoxes![0].y).toBeCloseTo(native[2].top - native[0].top, 5);
      // The legacy summary remains text-only.
      expect(result.lines.map(line => line.text)).toEqual(['first', 'third']);
    } finally {
      host.remove();
    }
  });

  it('keeps break metadata after soft-hyphen substitution and preserved blank lines', () => {
    const result = layout({
      html: `<p style="${STYLE};white-space:pre-wrap">super\u00adcalifragilistic\n\nafter</p>`,
      width: 130,
    });
    expect(result.lines.map(line => line.text)).toEqual(['super-', 'califragilistic', 'after']);
    expect(boxes(result.layoutRoot, 'p')[0].lineBoxes).toMatchObject([
      { y: 0, height: 30, endedByHardBreak: false },
      { y: 30, height: 30, endedByHardBreak: true },
      { y: 60, width: 0, height: 30, endedByHardBreak: true },
      { y: 90, height: 30, endedByHardBreak: false },
    ]);
  });

  it.each(['first second third', 'first<br>second'])('does not label a clamp as a hard break: %s', text => {
    const result = layout({
      html: `<p style="${STYLE};-webkit-line-clamp:1">${text}</p>`, width: 105,
    });
    expect(result.lines[0].text).toContain('…');
    expect(boxes(result.layoutRoot, 'p')[0].lineBoxes).toMatchObject([
      { endedByHardBreak: false },
    ]);
  });

  it('keeps nested inline-block line boxes in canvas coordinates', () => {
    const result = layout({
      html: `<p style="${STYLE};padding:10px">before <span style="display:inline-block;width:140px;padding:7px;border:2px solid transparent"><span style="display:inline-block;width:100px;padding:4px;border:2px solid transparent">one<br><br>two</span></span> after</p>`,
      width: 500,
    });
    const [outer, inner] = boxes(result.layoutRoot, 'span');
    expect(outer.lineBoxes).toHaveLength(1);
    expect(inner.lineBoxes).toMatchObject([
      { x: inner.x + 6, y: inner.y + 6, height: 30, endedByHardBreak: true },
      { x: inner.x + 6, y: inner.y + 36, width: 0, height: 30, endedByHardBreak: true },
      { x: inner.x + 6, y: inner.y + 66, height: 30, endedByHardBreak: false },
    ]);
    expect(boxes(result.layoutRoot, 'p')[0].lineBoxes).toHaveLength(1);
  });

  it('keeps simultaneous table-cell lines separate', () => {
    const result = layout({
      html: `<table style="${STYLE}"><tr><td>a<br><br>b</td><td>a b</td></tr></table>`,
      width: 300,
    });
    const [left, right] = boxes(result.layoutRoot, 'td');
    expect(left.lineBoxes?.map(line => line.endedByHardBreak)).toEqual([true, true, false]);
    expect(right.lineBoxes?.map(line => line.endedByHardBreak)).toEqual([false]);
    expect(left.lineBoxes![0].y).toBe(right.lineBoxes![0].y);
    expect(left.lineBoxes![0].x).toBeLessThan(right.lineBoxes![0].x);
    expect(result.lines.map(line => line.text)).toEqual(['a a b', 'b']);
  });

  it('collects only a box’s own inline groups around block children', () => {
    const result = layout({
      html: `<section style="${STYLE}">before<br><p style="margin:0">inside<br>paragraph</p>after</section>`,
      width: 300,
    });
    expect(boxes(result.layoutRoot, 'section')[0].lineBoxes).toMatchObject([
      { y: 0, endedByHardBreak: true },
      { y: 90, endedByHardBreak: false },
    ]);
    expect(boxes(result.layoutRoot, 'p')[0].lineBoxes).toMatchObject([
      { y: 30, endedByHardBreak: true },
      { y: 60, endedByHardBreak: false },
    ]);
  });

  it.each(['left', 'center', 'right'])('positions blank lines with %s alignment and absorbs a trailing newline', align => {
    const result = layout({
      html: `<p style="${STYLE};white-space:pre-wrap;text-align:${align}">\nlast\n</p>`, width: 400,
    });
    expect(boxes(result.layoutRoot, 'p')[0].lineBoxes).toMatchObject([
      { x: { left: 0, center: 200, right: 400 }[align], y: 0, width: 0, height: 30, endedByHardBreak: true },
      { y: 30, height: 30, endedByHardBreak: true },
    ]);
  });
});
