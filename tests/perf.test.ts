import { test } from 'vitest';
import { render } from '../src/index.js';
import { generateLargeHTML } from './helpers/large-doc.ts';

/**
 * Performance test with large content.
 * Run: npx vitest run tests/perf.test.ts
 */

test('performance: large content render', () => {
  const html = generateLargeHTML();
  const width = 600;
  const RUNS = 10;
  const times: number[] = [];

  // Warmup
  render({ html, width, pixelRatio: 1 });

  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    render({ html, width, pixelRatio: 1 });
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(RUNS / 2)];
  const min = times[0];
  const max = times[RUNS - 1];
  const avg = times.reduce((a, b) => a + b, 0) / RUNS;

  console.log(`\n=== Performance: Large Content (${RUNS} runs) ===`);
  console.log(`  Median: ${median.toFixed(1)}ms`);
  console.log(`  Avg:    ${avg.toFixed(1)}ms`);
  console.log(`  Min:    ${min.toFixed(1)}ms`);
  console.log(`  Max:    ${max.toFixed(1)}ms`);
  console.log(`  All:    [${times.map(t => t.toFixed(1)).join(', ')}]`);
});
