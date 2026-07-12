import { defineConfig } from 'vitest/config';

// Node-environment suite: validates that render-tag works without any DOM
// globals when a parser is injected (setDOMParser) and a measurement ctx is
// passed — and that it fails loud with guidance when they are missing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/node/**/*.test.ts'],
    testTimeout: 30000,
  },
});
