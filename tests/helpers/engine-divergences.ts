/**
 * The per-engine divergence ratchet for DOM-parity suites.
 *
 * A parity case runs in every engine. One that diverges from THIS engine's own
 * DOM must be listed for this engine in `tests/engine-divergences.json`; a
 * listed case that now matches fails too (the list only shrinks). Tolerances
 * stay in the suites, in that engine's layout units — only skips live here.
 *
 * Self-parity, so it gates in portable mode as well. Re-record deliberately
 * with `npm run test:update-engine-divergences[:firefox|:webkit]`, which runs
 * the files one at a time: each file merges its own keys into the shared file.
 */
import { it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import recorded from '../engine-divergences.json';
import { browserName } from './browser-name.ts';
import { gateResidualBaseline } from './baselines.ts';

const FILE = './tests/engine-divergences.json';
const UPDATE = import.meta.env.MODE === 'update-engine-divergences';

export interface DivergenceRatchet {
  /** The ratchet's verdict on one case: a failure message, or null. Pass
   * `divergence` as null when the case matches the DOM, else the measured
   * numbers. */
  verdict(caseName: string, divergence: string | null): string | null;
  /** `verdict`, asserted. */
  check(caseName: string, divergence: string | null): void;
  /** Registers the suite's closing test, after every case: rewrites this
   * suite's keys in update mode, else fails on a listed key no case produced. */
  itRecords(): void;
}

export function divergenceRatchet(suite: string): DivergenceRatchet {
  const prefix = `${suite} › `;
  const listed = new Set(
    ((recorded as Record<string, string[]>)[browserName] ?? []).filter((k) => k.startsWith(prefix)),
  );
  const seen = new Map<string, string | null>();

  const verdict = (caseName: string, divergence: string | null): string | null => {
    const key = prefix + caseName;
    if (seen.has(key)) throw new Error(`duplicate divergence key ${key}`);
    seen.set(key, divergence);
    if (UPDATE) return null;
    if (divergence !== null && !listed.has(key)) {
      return `${key}: new ${browserName} divergence from its DOM — ${divergence}`;
    }
    if (divergence === null && listed.has(key)) {
      return `${key}: now matches the ${browserName} DOM — remove it from ${FILE}`;
    }
    if (divergence !== null) console.info(`[engine-divergences ${browserName}] listed: ${key} — ${divergence.slice(0, 300)}`);
    return null;
  };

  return {
    verdict,
    check(caseName, divergence) {
      const v = verdict(caseName, divergence);
      expect(v, v ?? '').toBeNull();
    },
    itRecords() {
      it(`${suite}: the recorded ${browserName} divergences are real cases`, async () => {
        // Fresh, not the import: an earlier file in the same update run may
        // have rewritten it.
        const current = JSON.parse(await commands.readFile(FILE)) as Record<string, string[]>;
        const mine = [...seen].filter(([, d]) => d !== null).map(([k]) => k);
        const others = (current[browserName] ?? []).filter((k) => !k.startsWith(prefix));
        const expected = await gateResidualBaseline({
          file: FILE,
          browserName,
          signatures: [...others, ...mine].sort(),
          recorded: current,
          updateMode: UPDATE,
          writeFile: commands.writeFile,
        });
        if (expected === null) return;
        const stale = expected.filter((k) => k.startsWith(prefix) && !seen.has(k));
        expect(stale, `Listed in ${FILE} for ${browserName} but no such case ran:\n${stale.join('\n')}`)
          .toEqual([]);
      });
    },
  };
}
