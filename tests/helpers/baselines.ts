export interface BaselineEntry {
  score: number;
  wrap: boolean;
}

export interface BaselineCoverage {
  missing: string[];
  unexpected: string[];
}

export function validateBaselineCoverage(
  expectedKeys: Iterable<string>,
  baseline: Record<string, BaselineEntry>,
): BaselineCoverage {
  const expected = new Set(expectedKeys);
  const actual = new Set(Object.keys(baseline));
  return {
    missing: [...expected].filter((key) => !actual.has(key)).sort(),
    unexpected: [...actual].filter((key) => !expected.has(key)).sort(),
  };
}

export function classifyBaselineResult(
  key: string,
  score: number,
  wrap: boolean,
  baseline: BaselineEntry | undefined,
  tolerance: number,
): string[] {
  if (!baseline) return [`${key}: missing baseline`];

  const issues: string[] = [];
  const delta = score - baseline.score;
  if (delta > tolerance) {
    issues.push(
      `${key}: score ${score.toFixed(2)}% (was ${baseline.score}%, ` +
      `+${delta.toFixed(2)} regression)`,
    );
  } else if (delta < -tolerance) {
    issues.push(
      `${key}: score ${score.toFixed(2)}% (was ${baseline.score}%, ` +
      `${delta.toFixed(2)} improvement; update baseline)`,
    );
  }

  if (baseline.wrap && !wrap) {
    issues.push(`${key}: wrapping regressed`);
  } else if (!baseline.wrap && wrap) {
    issues.push(`${key}: wrapping improved; update baseline`);
  }
  return issues;
}

/**
 * Gate a sorted residual signature list against its recorded per-browser
 * baseline, or rewrite that baseline when the run is in `updateMode`.
 * Returns the recorded signatures to assert against, or `null` when the
 * baseline was just rewritten and there is nothing to assert.
 */
export async function gateResidualBaseline(options: {
  file: string;
  browserName: string;
  signatures: string[];
  recorded: Record<string, string[]>;
  updateMode: boolean;
  writeFile: (path: string, contents: string) => Promise<unknown>;
}): Promise<string[] | null> {
  const { file, browserName, signatures, recorded, updateMode, writeFile } = options;
  if (updateMode) {
    const updated = { ...recorded, [browserName]: signatures };
    await writeFile(file, JSON.stringify(updated, null, 2) + '\n');
    return null;
  }
  const expected = recorded[browserName];
  if (!expected) {
    throw new Error(
      `No residual baseline exists for ${browserName} in ${file}. ` +
      `Record one before gating this lane.`,
    );
  }
  return expected;
}
