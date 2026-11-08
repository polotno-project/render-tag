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

  it('ignores alphabetic and roman list markers, which DOM ranges never report', () => {
    const result = compareLineMembership(
      [
        { y: 0, text: 'a. First item' },
        { y: 20, text: 'iv. Fourth' },
        { y: 40, text: 'XII. Twelfth' },
        // An RTL item's marker sits at its right, the line's visual end.
        { y: 60, text: 'עברית b.' },
      ],
      [
        { y: 0, text: 'First item' },
        { y: 20, text: 'Fourth' },
        { y: 40, text: 'Twelfth' },
        { y: 60, text: 'עברית' },
      ],
    );

    expect(result.wrappingMatch).toBe(true);
  });

  it('still sees a short word that moved across a line edge', () => {
    const result = compareLineMembership(
      [{ y: 0, text: 'we do' }, { y: 20, text: 'it. Then' }],
      [{ y: 0, text: 'we do it.' }, { y: 20, text: 'Then' }],
    );

    expect(result.wrappingMatch).toBe(false);
  });
});
