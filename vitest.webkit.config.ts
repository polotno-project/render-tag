import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';
import { saveWrapReport } from './tests/helpers/wrap-report-command.ts';

export default defineConfig({
  resolve: {
    alias: {
      rasterizehtml: 'rasterizehtml/dist/rasterizeHTML.allinone.js',
      'html-to-svg': path.resolve(__dirname, 'vendor/html-to-svg/index.ts'),
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      commands: { saveWrapReport },
      instances: [
        { browser: 'webkit', headless: true },
      ],
    },
    testTimeout: 60000,
  },
});
