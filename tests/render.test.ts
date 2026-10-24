import { describe, it, expect } from 'vitest';
import { loadCorpus } from './helpers/test-cases.ts';
import { validateBaselineCoverage } from './helpers/baselines.ts';
import { baselineMap, gateBaselines, UPDATE_MODE } from './helpers/render-corpus.ts';
import { browserName } from './helpers/browser-name.ts';
import { PORTABLE_GATES_ONLY } from './helpers/portable-mode.ts';

describe('HTML Canvas Renderer', () => {
  it('loads all test cases', async () => {
    const corpus = await loadCorpus();
    expect(corpus.length).toBeGreaterThan(0);
    // An update run records the keys; the 5-font matrix in
    // tests/render.fonts.test.ts holds the font keys checked here.
    if (!PORTABLE_GATES_ONLY && !UPDATE_MODE) {
      expect(validateBaselineCoverage(corpus.map((entry) => entry.key), baselineMap)).toEqual({
        missing: [],
        unexpected: [],
      });
    }
    console.log(`Loaded ${corpus.length} corpus keys | browser: ${browserName} | baselines: ${Object.keys(baselineMap).length}${PORTABLE_GATES_ONLY ? ' | PORTABLE MODE: environment-pinned score/wrap contract not gated' : ''}`);
  });

  describe('Default font cases', () => {
    it('all cases (score + wrapping)', async () => {
      await gateBaselines(await loadCorpus({ fonts: [] }));
    }, 300000);
  });
});
