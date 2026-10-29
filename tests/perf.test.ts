import { test } from 'vitest';
import { commands } from 'vitest/browser';
import { drawLayout, layout, render } from '../src/index.js';
import { generateLargeHTML } from './helpers/large-doc.ts';
import { makeCanvas } from './helpers/pixels.ts';
import { reportPath } from './helpers/report-path.ts';

/**
 * Performance test with large content.
 * Run: npx vitest run --project chromium tests/perf.test.ts
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

/** Median ms of `frame()` over `runs`, after a warmup. */
function median(frame: () => void, runs = 60): number {
  frame();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    frame();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

// A text-unit animation frame: one layout, then every frame draws each unit under its own
// state. Reported against a plain drawLayout of the same layout.
test('performance: text unit frames', async () => {
  const words = 'Grow your brand with bold headlines that move'.split(' ');
  const text = Array.from({ length: 30 }, (_, i) => words[i % words.length]).join(' ');
  const { ctx } = makeCanvas(1200, 800);
  const rows: string[] = [];
  for (const shadow of ['', 'text-shadow:3px 3px 10px rgba(0,0,0,0.5);']) {
    const html = `<p style="margin:0;font:bold 40px sans-serif;${shadow}">${text}</p>`;
    for (const level of ['word', 'grapheme'] as const) {
      const result = layout({ html, width: 1100, ctx, textUnits: level });
      const count = result.textUnits!.length;
      const plain = median(() => { ctx.clearRect(0, 0, 1200, 800); drawLayout({ layout: result, width: 1100, ctx, pixelRatio: 1 }); });
      const units = median(() => {
        ctx.clearRect(0, 0, 1200, 800);
        drawLayout({ layout: result, width: 1100, ctx, pixelRatio: 1, paintTextUnit: ({ unit, ctx, draw }) => {
          const p = ((unit.index * 7) % count) / count;
          ctx.globalAlpha *= 0.3 + 0.7 * p;
          ctx.translate(0, 12 * (1 - p));
          draw();
        } });
      });
      rows.push(`${shadow ? 'shadow' : 'plain '} ${level.padEnd(8)} ${String(count).padStart(4)} units: drawLayout ${plain.toFixed(2)}ms, units ${units.toFixed(2)}ms`);
    }
  }
  console.log(`\n=== Performance: text unit frames (median of 60) ===\n  ${rows.join('\n  ')}`);
  await commands.writeFile(reportPath('perf-text-units.txt'), rows.join('\n') + '\n');
});
