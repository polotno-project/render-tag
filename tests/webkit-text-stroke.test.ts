/**
 * Regression test: expandShorthand for `-webkit-text-stroke` split on whitespace
 * naively, so any color whose syntax has internal spaces (rgb(255, 255, 255),
 * rgba/hsl/var/color/...) was shattered and the color sub-property got the
 * leftmost fragment (e.g. "rgb(255,").
 *
 * Chromium's CSSOM serializes `-webkit-text-stroke-width` + `-webkit-text-stroke-color`
 * back to the shorthand `2px rgb(255, 255, 255)`, so this hits real input
 * whenever inline styles are read from a live DOM.
 */
import { describe, it, expect } from 'vitest';
import { expandShorthand, resolveStylesFromCSS } from '../src/css-resolver.ts';
import { parseHTML } from '../src/parse.ts';
import type { StyledNode } from '../src/types.ts';

function color(decls: { property: string; value: string }[]): string | undefined {
  return decls.find(d => d.property === '-webkit-text-stroke-color')?.value;
}

function width(decls: { property: string; value: string }[]): string | undefined {
  return decls.find(d => d.property === '-webkit-text-stroke-width')?.value;
}

describe('expandShorthand("-webkit-text-stroke")', () => {
  it('preserves rgb() color with spaces', () => {
    const decls = expandShorthand('-webkit-text-stroke', '2px rgb(255, 255, 255)');
    expect(width(decls)).toBe('2px');
    expect(color(decls)).toBe('rgb(255, 255, 255)');
  });

  it('preserves rgba() color with spaces', () => {
    const decls = expandShorthand('-webkit-text-stroke', '1px rgba(0, 0, 0, 0.5)');
    expect(width(decls)).toBe('1px');
    expect(color(decls)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('preserves hsl() color with spaces', () => {
    const decls = expandShorthand('-webkit-text-stroke', '3px hsl(200, 50%, 40%)');
    expect(width(decls)).toBe('3px');
    expect(color(decls)).toBe('hsl(200, 50%, 40%)');
  });

  it('preserves var() with fallback', () => {
    const decls = expandShorthand('-webkit-text-stroke', '2px var(--stroke, #ff0000)');
    expect(width(decls)).toBe('2px');
    expect(color(decls)).toBe('var(--stroke, #ff0000)');
  });

  it('preserves color(srgb ...) function', () => {
    const decls = expandShorthand('-webkit-text-stroke', '2px color(srgb 1 0 0)');
    expect(width(decls)).toBe('2px');
    expect(color(decls)).toBe('color(srgb 1 0 0)');
  });

  it('still handles hex color (regression guard)', () => {
    const decls = expandShorthand('-webkit-text-stroke', '1px #1e40af');
    expect(width(decls)).toBe('1px');
    expect(color(decls)).toBe('#1e40af');
  });

  it('handles color before width', () => {
    const decls = expandShorthand('-webkit-text-stroke', 'rgb(255, 0, 0) 2px');
    expect(width(decls)).toBe('2px');
    expect(color(decls)).toBe('rgb(255, 0, 0)');
  });
});

/**
 * Regression test: -webkit-text-stroke, -webkit-text-stroke-color and
 * -webkit-text-fill-color are inherited CSS properties, but were missing
 * from the resolver's inheritance list. A stroke set on a container div
 * never reached the text inside <p>/<strong>/<span> children, so nothing
 * was stroked.
 */
function resolve(html: string): StyledNode {
  const { fragment, css } = parseHTML(html);
  return resolveStylesFromCSS(fragment, css, 476);
}

function findText(node: StyledNode, text: string): StyledNode | null {
  if (node.tagName === '#text' && node.textContent?.includes(text)) return node;
  for (const child of node.children) {
    const found = findText(child, text);
    if (found) return found;
  }
  return null;
}

describe('-webkit-text-stroke inheritance', () => {
  it('inherits stroke width and color from container into nested elements', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 7px black; color: blue;">` +
        `<p><strong style="color: rgb(126, 14, 9);">Text 1</strong></p>` +
      `</div>`
    );
    const style = findText(tree, 'Text 1')!.style;
    expect(style.webkitTextStrokeWidth).toBe(7);
    // Computed stroke color inherits — stays black despite the child's own color
    expect(style.webkitTextStrokeColor).toBe('black');
  });

  it('keeps currentColor semantics when stroke color is never set', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke-width: 2px; color: blue;">` +
        `<span style="color: red;">child</span>` +
      `</div>`
    );
    const style = findText(tree, 'child')!.style;
    expect(style.webkitTextStrokeWidth).toBe(2);
    // '' is the canonical currentColor — the renderer falls back to the
    // element's own color, so the child strokes red, not the parent's blue
    expect(style.webkitTextStrokeColor).toBe('');
  });

  it('normalizes explicit currentColor to the canonical unset value', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 3px black;">` +
        `<span style="-webkit-text-stroke-color: currentColor; color: red;">child</span>` +
      `</div>`
    );
    const style = findText(tree, 'child')!.style;
    expect(style.webkitTextStrokeWidth).toBe(3);
    // Explicit currentColor overrides the inherited black and resolves to the
    // element's own color at render time
    expect(style.webkitTextStrokeColor).toBe('');
  });

  it('child can override inherited stroke', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 3px black;">` +
        `<span style="-webkit-text-stroke: 1px red;">child</span>` +
      `</div>`
    );
    const style = findText(tree, 'child')!.style;
    expect(style.webkitTextStrokeWidth).toBe(1);
    expect(style.webkitTextStrokeColor).toBe('red');
  });

  it('inherits -webkit-text-fill-color', () => {
    const tree = resolve(
      `<div style="-webkit-text-fill-color: green;">` +
        `<p><span style="color: red;">child</span></p>` +
      `</div>`
    );
    const style = findText(tree, 'child')!.style;
    expect(style.webkitTextFillColor).toBe('green');
  });
});

/**
 * stroke-linejoin controls the corner join for -webkit-text-stroke. It is not
 * a real CSS property for HTML text-stroke (browsers always paint round), so
 * render-tag reads it itself. Like the stroke width/color, it must inherit
 * from a container into nested text nodes.
 */
describe('stroke-linejoin resolution', () => {
  it('defaults to round when unset', () => {
    const tree = resolve(`<div style="-webkit-text-stroke: 5px black;">Text 1</div>`);
    expect(findText(tree, 'Text 1')!.style.strokeLinejoin).toBe('round');
  });

  it('parses an explicit miter join', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 5px black; stroke-linejoin: miter;">Text 1</div>`
    );
    expect(findText(tree, 'Text 1')!.style.strokeLinejoin).toBe('miter');
  });

  it('inherits the join into nested elements', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 7px black; stroke-linejoin: bevel;">` +
        `<p><strong>Text 1</strong></p>` +
      `</div>`
    );
    expect(findText(tree, 'Text 1')!.style.strokeLinejoin).toBe('bevel');
  });

  it('lets a child override the inherited join', () => {
    const tree = resolve(
      `<div style="-webkit-text-stroke: 3px black; stroke-linejoin: miter;">` +
        `<span style="stroke-linejoin: round;">child</span>` +
      `</div>`
    );
    expect(findText(tree, 'child')!.style.strokeLinejoin).toBe('round');
  });
});
