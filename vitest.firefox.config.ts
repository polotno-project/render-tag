import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';
import { playwright } from '@vitest/browser-playwright';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    browser: {
      provider: playwright(),
      instances: [
        { browser: 'firefox', headless: true },
      ],
    },
  },
}));
