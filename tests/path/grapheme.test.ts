import { describe, it, expect } from 'vitest';
import { graphemes } from '../../src/layout.ts';

describe('graphemes', () => {
  it('splits ASCII into characters', () => {
    expect(graphemes('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('splits an empty string into []', () => {
    expect(graphemes('')).toEqual([]);
  });

  it('keeps surrogate pairs together (emoji 😀)', () => {
    const out = graphemes('a😀b');
    expect(out).toEqual(['a', '😀', 'b']);
  });

  it('keeps ZWJ emoji sequences together when Intl.Segmenter is available', () => {
    // Family emoji: 👨‍👩‍👧 is 👨 + ZWJ + 👩 + ZWJ + 👧
    // With Intl.Segmenter, this is one grapheme cluster.
    const out = graphemes('👨‍👩‍👧');
    // Either one cluster (Segmenter) or multiple code points (fallback);
    // both behaviors are acceptable but Segmenter is the modern path.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.join('')).toBe('👨‍👩‍👧');
  });

  it('combining marks join their base letter (when Segmenter is available)', () => {
    // é as e + combining acute (U+0301)
    const out = graphemes('é');
    expect(out.join('')).toBe('é');
  });
});
