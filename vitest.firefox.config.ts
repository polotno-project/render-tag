import { browserConfig } from './vitest.browser.config.ts';

export default browserConfig('firefox', 60_000, [
  'tests/render.test.ts',
  'tests/native-dom-oracle.test.ts',
  'tests/font-fixtures.test.ts',
  'tests/flex-parity.test.ts',
  'tests/computed-style-parity.test.ts',
  'tests/parse-style-extraction.test.ts',
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
  // Stage 4: box-sizing, inline-block shrink-to-fit and percentages against
  // the used containing block. Never run in Firefox yet (UNVERIFIED there).
  'tests/box-model-parity.test.ts',
  // Stage 3: the gradient parser is engine-independent CSS; never run in
  // Firefox yet (UNVERIFIED there until it passes).
  'tests/gradient-parity.test.ts',
]);
