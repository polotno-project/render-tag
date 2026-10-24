import { describe, expect, it } from 'vitest';
import {
  classifyBaselineResult,
  mergeBaselines,
  validateBaselineCoverage,
} from '../helpers/baselines.ts';

describe('baseline contract', () => {
  it('rejects missing and stale case keys', () => {
    expect(
      validateBaselineCoverage(
        ['current', 'missing'],
        { current: { score: 1, wrap: true }, stale: { score: 2, wrap: false } },
      ),
    ).toEqual({ missing: ['missing'], unexpected: ['stale'] });
  });

  it('requires deliberate promotion for regressions and improvements', () => {
    const baseline = { score: 10, wrap: false };

    expect(classifyBaselineResult('same', 10.005, false, baseline, 0.01))
      .toEqual([]);
    expect(classifyBaselineResult('regressed', 10.02, false, baseline, 0.01))
      .toEqual(['regressed: score 10.02% (was 10%, +0.02 regression)']);
    expect(classifyBaselineResult('improved', 9.98, false, baseline, 0.01))
      .toEqual(['improved: score 9.98% (was 10%, -0.02 improvement; update baseline)']);
    expect(classifyBaselineResult('wrap improved', 10, true, baseline, 0.01))
      .toEqual(['wrap improved: wrapping improved; update baseline']);
  });

  it('merges an update run in corpus order and drops keys no case produces', () => {
    const merged = mergeBaselines(
      ['a', 'b', 'c'],
      { stale: { score: 9, wrap: true }, c: { score: 3, wrap: true }, a: { score: 1, wrap: true } },
      { b: { score: 2, wrap: false }, a: { score: 1.5, wrap: false } },
    );
    expect(JSON.stringify(merged)).toBe(JSON.stringify({
      a: { score: 1.5, wrap: false },
      b: { score: 2, wrap: false },
      c: { score: 3, wrap: true },
    }));
  });

  it('treats an absent baseline as a contract failure', () => {
    expect(classifyBaselineResult('new case', 0, true, undefined, 0.01))
      .toEqual(['new case: missing baseline']);
  });
});
