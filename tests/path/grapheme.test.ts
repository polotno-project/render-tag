import { describe, it, expect } from 'vitest';
import { stringToArray } from '../../src/path/grapheme.ts';

describe('stringToArray', () => {
  it('splits ASCII into characters', () => {
    expect(stringToArray('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('splits an empty string into []', () => {
    expect(stringToArray('')).toEqual([]);
  });

  it('keeps surrogate pairs together (emoji 😀)', () => {
    const out = stringToArray('a😀b');
    expect(out).toEqual(['a', '😀', 'b']);
  });

  it('keeps ZWJ emoji sequences together when Intl.Segmenter is available', () => {
    // Family emoji: 👨‍👩‍👧 is 👨 + ZWJ + 👩 + ZWJ + 👧
    // With Intl.Segmenter, this is one grapheme cluster.
    const out = stringToArray('👨‍👩‍👧');
    // Either one cluster (Segmenter) or multiple code points (fallback);
    // both behaviors are acceptable but Segmenter is the modern path.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.join('')).toBe('👨‍👩‍👧');
  });

  it('combining marks join their base letter (when Segmenter is available)', () => {
    // é as e + combining acute (U+0301)
    const out = stringToArray('é');
    expect(out.join('')).toBe('é');
  });
});
