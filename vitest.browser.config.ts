import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { captureNativeDom } from './tests/helpers/native-dom-command.ts';

/**
 * `include` names the lane: which suites this engine gates. Chromium omits it
 * and runs everything (its script excludes the maintainer-only files); the
 * other engines opt in, because several geometry suites deliberately encode
 * Chrome-first output. See CLAUDE.md.
 *
 * A lane is what the engine GATES, not the only thing it can run: naming a
 * file on the command line adds it for that run. `test:update-baselines:*`
 * depends on this — `tests/generate-baselines.test.ts` is in no lane.
 */
export function browserConfig(
  browser: 'chromium' | 'firefox' | 'webkit',
  testTimeout: number,
  include?: string[],
) {
  const requestedTests = process.argv.filter((argument) =>
    argument.endsWith('.test.ts'),
  );
  const effectiveInclude = include && requestedTests.length > 0
    ? [...new Set([...include, ...requestedTests])]
    : include;
  return defineConfig({
    // The browser context has no process.env; tests read this through
    // tests/helpers/portable-mode.ts. See CLAUDE.md "CI vs local deep testing".
    define: {
      __RENDER_TAG_PORTABLE__: JSON.stringify(
        process.env.RENDER_TAG_PORTABLE === '1',
      ),
    },
    // Firefox capture pages load fixture assets from an opaque page.
    server: { cors: true },
    resolve: {
      alias: {
        'html-to-svg': path.resolve(import.meta.dirname, 'vendor/html-to-svg/index.ts'),
      },
    },
    test: {
      browser: {
        enabled: true,
        provider: playwright(),
        commands: { captureNativeDom },
        instances: [{ browser, headless: true }],
      },
      testTimeout,
      ...(effectiveInclude ? { include: effectiveInclude } : {}),
    },
  });
}
