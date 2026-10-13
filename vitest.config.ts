import { playwright } from '@vitest/browser-playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { captureNativeDom } from './tests/helpers/native-dom-command.ts';

/**
 * One config, four projects: `node` and one browser instance per engine.
 * Select with `--project <name>`; `npm test` runs node + chromium together.
 *
 * A project's `include` is the lane: what that engine GATES. Chromium gates
 * every browser suite except the maintainer tools below; the other engines
 * opt in, because several geometry suites deliberately encode Chrome-first
 * output (see CLAUDE.md). A lane is not the only thing an engine can run:
 * a test file named on the command line joins every browser lane for that
 * run, so `npx vitest run --project webkit tests/generate-baselines.test.ts`
 * works although no lane gates that file.
 *
 * `--mode update` is the one re-recording mode (`import.meta.env.MODE`).
 * Files run one at a time in it: the engine-divergence suites merge their
 * keys into a single JSON file.
 */

/** Browser suites no lane gates: recorders, sweeps and report-only probes. */
const MAINTAINER_ONLY = [
  'tests/generate-baselines.test.ts',
  'tests/cross-browser.compare.test.ts',
  'tests/cross-browser.record.test.ts',
  'tests/wrap-debug.test.ts',
  'tests/wrap-sweep.test.ts',
  'tests/perf.test.ts',
  'tests/list-marker-parity.test.ts',
  'tests/engine-probe.test.ts',
  'tests/geometry-oracle.test.ts',
];

const FIREFOX_LANE = [
  'tests/render.test.ts',
  'tests/render.fonts.test.ts',
  'tests/native-dom-oracle.test.ts',
  'tests/font-fixtures.test.ts',
  'tests/flex-parity.test.ts',
  'tests/computed-style-parity.test.ts',
  'tests/parse-style-extraction.test.ts',
  // Gated in Firefox CI only (Firefox cannot launch on the maintainer's
  // machine); Gecko's known divergences are in tests/engine-divergences.json.
  'tests/line-box-parity.test.ts',
  'tests/line-baseline-parity.test.ts',
  'tests/margin-collapse-parity.test.ts',
  'tests/bidi-order-parity.test.ts',
  'tests/line-metadata.test.ts',
  'tests/cross-browser.compare.test.ts',
  'tests/stress.test.ts',
  'tests/text-shadow-paint.test.ts',
  'tests/paint-bounds.test.ts',
  // UNVERIFIED in Firefox until they pass there.
  'tests/box-model-parity.test.ts',
  'tests/gradient-parity.test.ts',
];

const WEBKIT_LANE = [
  'tests/render.test.ts',
  'tests/render.fonts.test.ts',
  'tests/native-dom-oracle.test.ts',
  'tests/font-fixtures.test.ts',
  'tests/flex-parity.test.ts',
  'tests/computed-style-parity.test.ts',
  'tests/parse-style-extraction.test.ts',
  'tests/line-box-parity.test.ts',
  'tests/line-baseline-parity.test.ts',
  'tests/margin-collapse-parity.test.ts',
  'tests/box-model-parity.test.ts',
  'tests/bidi-order-parity.test.ts',
  'tests/line-metadata.test.ts',
  'tests/cross-browser.compare.test.ts',
  'tests/stress.test.ts',
  'tests/text-shadow-paint.test.ts',
  'tests/paint-bounds.test.ts',
  'tests/decoration-shape-parity.test.ts',
  'tests/decoration-position-parity.test.ts',
  'tests/gradient-parity.test.ts',
  'tests/text-shadow-coverage.test.ts',
];

// Firefox capture pages load fixture assets from an opaque origin, so the
// browser server must answer CORS. For an inline project, @vitest/browser
// never loads this file as a Vite config and overwrites the project's
// `server` with its own literal; only plugins pass through, and a plugin's
// `config` result is merged. Hence a plugin, not a `server` option.
const captureCors = { name: 'render-tag:capture-cors', config: () => ({ server: { cors: true } }) };

// Playwright's Firefox keeps profile bookkeeping in ~/Library/Application
// Support/Firefox, which macOS 27 TCC-protects, so the launch hangs until the
// timeout (microsoft/playwright#42768; fixed upstream in Firefox 158, not yet
// shipped). A home of its own for the browser process sidesteps it.
const firefoxHome = join(import.meta.dirname, 'node_modules/.cache/render-tag/firefox-home');
if (process.platform === 'darwin') mkdirSync(firefoxHome, { recursive: true });
const firefoxLaunch = process.platform === 'darwin'
  ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }
  : {};

const requested = process.argv
  .filter((argument) => argument.endsWith('.test.ts') && !argument.startsWith('tests/node/'));

function lane(include: string[]) {
  return [...new Set([...include, ...requested])];
}

export default defineConfig(({ mode }) => {
  const update = mode === 'update';
  return {
    test: {
      fileParallelism: !update,
      projects: [
        {
          test: {
            name: 'node',
            environment: 'node',
            include: ['tests/node/**/*.test.ts'],
            testTimeout: 30_000,
            // tests/node/memory.test.ts calls gc().
            execArgv: ['--expose-gc'],
          },
        },
        {
          // The browser context has no process.env; tests read this through
          // tests/helpers/portable-mode.ts. See CLAUDE.md "CI vs local deep testing".
          define: {
            __RENDER_TAG_PORTABLE__: JSON.stringify(process.env.RENDER_TAG_PORTABLE === '1'),
          },
          plugins: [captureCors],
          test: {
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              commands: { captureNativeDom },
              fileParallelism: !update,
              instances: [
                {
                  browser: 'chromium',
                  name: 'chromium',
                  include: ['tests/**/*.test.ts'],
                  exclude: [
                    ...configDefaults.exclude,
                    'tests/node/**',
                    ...MAINTAINER_ONLY.filter((file) => !requested.includes(file)),
                  ],
                  testTimeout: 30_000,
                },
                {
                  browser: 'firefox',
                  name: 'firefox',
                  include: lane(FIREFOX_LANE),
                  testTimeout: 60_000,
                  provider: playwright({ launchOptions: firefoxLaunch }),
                },
                { browser: 'webkit', name: 'webkit', include: lane(WEBKIT_LANE), testTimeout: 60_000 },
              ],
            },
          },
        },
      ],
    },
  };
});
