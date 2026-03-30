import { test } from 'vitest';
import { render } from '../src/index.js';

/**
 * Performance test with large content.
 * Run: npx vitest run tests/perf.test.ts
 */

// Generate a large HTML document with mixed content
function generateLargeHTML(): string {
  const paragraphs: string[] = [];

  // 50 paragraphs with inline styles
  for (let i = 0; i < 50; i++) {
    paragraphs.push(
      `<p>Paragraph ${i}: Will be <span style="color: rgb(226, 15, 15);">responsible</span>` +
      `<span> for managing activities that are part of the production of </span>` +
      `<strong><span>goods</span></strong> and services. Direct <em><span>responsibilities</span></em>` +
      ` include managing both the operations process, embracing design, planning, control, ` +
      `performance <u><span>improvement</span></u>, and <span style="color: rgb(20, 218, 103);">operations</span>` +
      `<span> strategy.</span></p>`
    );
  }

  // 10 unordered lists with 5 items each
  for (let i = 0; i < 10; i++) {
    const items = Array.from({ length: 5 }, (_, j) =>
      `<li>List item ${i * 5 + j}: Some content with <strong>bold</strong> and <em>italic</em> text</li>`
    ).join('');
    paragraphs.push(`<ul>${items}</ul>`);
  }

  // 5 ordered lists with 5 items each
  for (let i = 0; i < 5; i++) {
    const items = Array.from({ length: 5 }, (_, j) =>
      `<li>Ordered item ${i * 5 + j}: Description with <span style="color: blue;">colored</span> text</li>`
    ).join('');
    paragraphs.push(`<ol>${items}</ol>`);
  }

  const css = `
  p { margin: 0; padding: 0; word-wrap: break-word; white-space: pre-wrap; }
  ul, ol {
    list-style: none;
    padding-inline-start: 0;
    margin: 0;
    display: block;
    width: 100%;
    text-decoration: inherit;
    counter-reset: ol-counter;
  }
  li {
    position: relative;
    padding-inline-start: 2.1em;
    margin: 0;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  li::before {
    content: '';
    position: absolute;
    inset-inline-start: 0;
    top: 0;
    letter-spacing: normal;
    display: inline-block;
    width: 2em;
    text-align: end;
    margin-inline-end: 0.8em;
    font-weight: normal;
    font-style: normal;
  }
  ul > li::before {
    content: '\\2022';
    text-align: center;
    font-size: 1.2em;
    width: 2em;
    margin-inline-end: 1.5em;
  }
  ol > li { counter-increment: ol-counter; }
  ol > li::before { content: counter(ol-counter) "."; }
  .ql-indent-1 { margin-inline-start: 0.5em; }
  .ql-indent-2 { margin-inline-start: 1em; }
  .ql-indent-3 { margin-inline-start: 1.5em; }`;

  return `<div style="font-size: 16px; font-family: sans-serif; color: black; line-height: 1.4;" dir="ltr">
    ${paragraphs.join('\n')}
  </div>
  <style>${css}</style>`;
}

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
