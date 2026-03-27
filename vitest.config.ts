import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      rasterizehtml: 'rasterizehtml/dist/rasterizeHTML.allinone.js',
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [
        {
          browser: 'chromium',
          launch: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          },
        },
      ],
    },
    testTimeout: 30000,
  },
});
