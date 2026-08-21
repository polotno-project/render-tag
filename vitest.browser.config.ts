import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { captureNativeDom } from './tests/helpers/native-dom-command.ts';

export function browserConfig(
  browser: 'chromium' | 'firefox' | 'webkit',
  testTimeout: number,
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
    },
  });
}
