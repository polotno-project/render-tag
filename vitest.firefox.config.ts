import { browserConfig } from './vitest.browser.config.ts';

export default browserConfig('firefox', 60_000, [
  'tests/render.test.ts',
  'tests/native-dom-oracle.test.ts',
  'tests/font-fixtures.test.ts',
  'tests/flex-parity.test.ts',
  // Stage 1.5 parity tests. Never run in Firefox yet (it cannot launch on the
  // machine they were written on): the Gecko branches they cover are
  // UNVERIFIED until these pass here.
  'tests/line-box-parity.test.ts',
  'tests/line-baseline-parity.test.ts',
  'tests/margin-collapse-parity.test.ts',
  'tests/bidi-order-parity.test.ts',
  'tests/line-metadata.test.ts',
  'tests/cross-browser.compare.test.ts',
  'tests/stress.test.ts',
  'tests/text-shadow-paint.test.ts',
  'tests/paint-bounds.test.ts',
]);
