import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

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
      instances: [
        { browser: 'firefox', headless: true },
      ],
    },
    testTimeout: 60000,
  },
});
