import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { captureNativeDom } from './tests/helpers/native-dom-command.ts';

/**
 * `include` names the lane: which suites this engine gates. Chromium omits it
 * and runs everything (its script excludes the maintainer-only files); the
 * other engines opt in, because several geometry suites deliberately encode
 * Chrome-first output. See CLAUDE.md.
 */
export function browserConfig(
  browser: 'chromium' | 'firefox' | 'webkit',
  testTimeout: number,
  include?: string[],
) {
  return defineConfig({
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
      ...(include ? { include } : {}),
    },
  });
}
