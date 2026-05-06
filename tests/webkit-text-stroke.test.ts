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
import { expandShorthand } from '../src/css-resolver.ts';

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
