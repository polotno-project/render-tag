import { describe, expect, it } from 'vitest';
import { compareLineMembership } from '../helpers/wrap-comparison.ts';

describe('line membership comparison', () => {
  it('rejects a one-character break drift', () => {
    const result = compareLineMembership(
      [{ y: 0, text: 'ab' }, { y: 20, text: 'cd' }],
      [{ y: 0, text: 'a' }, { y: 20, text: 'bcd' }],
    );

    expect(result.wrappingMatch).toBe(false);
    expect(result.differentLines.map(({ lineIndex }) => lineIndex)).toEqual([0, 1]);
  });

  it('ignores visual glyph order for a bidi line', () => {
    const result = compareLineMembership(
      [{ y: 0, text: 'abcאבג' }],
      [{ y: 0, text: 'גבאcba' }],
    );

    expect(result.wrappingMatch).toBe(true);
  });
});
