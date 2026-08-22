import { browserConfig } from './vitest.browser.config.ts';

export default browserConfig('firefox', 60_000, [
  'tests/render.test.ts',
  'tests/native-dom-oracle.test.ts',
  'tests/font-fixtures.test.ts',
  'tests/cross-browser.compare.test.ts',
  'tests/stress.test.ts',
]);
