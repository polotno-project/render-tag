import { compareRenders } from '../tests/helpers/compare.ts';
import { loadBasicCases, loadGoogleFontCase, polotnoCase, polotnoListsCase } from '../tests/helpers/test-cases.ts';
import type { BenchmarkCase } from '../tests/helpers/test-cases.ts';

const PIXEL_RATIO = window.devicePixelRatio || 2;

function addColumn(
  row: HTMLElement,
  label: string,
  content: HTMLElement,
  pixelRatio: number,
): void {
  const col = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = label;
  col.appendChild(h3);
  content.style.border = '1px solid #ccc';
  if (content instanceof HTMLCanvasElement) {
    content.style.width = `${content.width / pixelRatio}px`;
    content.style.height = `${content.height / pixelRatio}px`;
  }
  col.appendChild(content);
  row.appendChild(col);
}

function createIsolatedDOM(tc: BenchmarkCase): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.style.width = `${tc.width}px`;
  iframe.style.height = `${tc.height}px`;
  iframe.style.border = '1px solid #ccc';
  iframe.style.overflow = 'hidden';
  iframe.scrolling = 'no';
  iframe.srcdoc = `<!DOCTYPE html>
<html><head><style>${tc.css || ''}</style></head>
<body style="margin:0;padding:0">${tc.html}</body></html>`;
  return iframe;
}

interface CaseResult {
  name: string;
  contentMismatch: number;
  referenceTime: number;
  canvasTime: number;
}

interface RenderedCase {
  section: HTMLElement;
  result: CaseResult;
}

async function renderComparison(tc: BenchmarkCase): Promise<RenderedCase> {
  const section = document.createElement('div');
  section.className = 'case';

  const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  const pct = result.contentMismatchPercentage;
  const filled = (result.contentPixels / result.totalPixels * 100).toFixed(0);
  const speedup = (result.referenceTime / result.canvasLibTime).toFixed(0);

  // Title with inline stats
  const title = document.createElement('h2');
  const badge = document.createElement('span');
  badge.className = pct < 5 ? 'badge good' : pct < 20 ? 'badge warn' : 'badge bad';
  badge.textContent = `${pct.toFixed(1)}%`;
  title.textContent = `${tc.name} `;
  title.appendChild(badge);
  const timing = document.createElement('span');
  timing.className = 'timing';
  timing.textContent = `${result.canvasLibTime.toFixed(0)}ms (${speedup}x)`;
  title.appendChild(timing);
  section.appendChild(title);

  const row = document.createElement('div');
  row.className = 'comparison';

  // Diff first for quick scanning
  const diffLabel = `Diff: ${pct.toFixed(1)}% (${filled}% filled)`;
  addColumn(row, diffLabel, result.diffCanvas, PIXEL_RATIO);

  // Then reference and our render
  addColumn(row, 'html-to-svg', result.domCanvas, PIXEL_RATIO);

  // Canvas (lib) with click-to-swap to DOM
  const libCol = document.createElement('div');
  const libH3 = document.createElement('h3');
  libH3.textContent = 'Canvas (lib) — click to compare';
  libH3.style.cursor = 'pointer';
  libCol.appendChild(libH3);

  const libCanvas = result.libCanvas;
  libCanvas.style.border = '1px solid #ccc';
  libCanvas.style.width = `${libCanvas.width / PIXEL_RATIO}px`;
  libCanvas.style.height = `${libCanvas.height / PIXEL_RATIO}px`;
  libCanvas.style.cursor = 'pointer';

  const iframe = createIsolatedDOM(tc);

  let showingCanvas = true;
  const swapContainer = document.createElement('div');
  swapContainer.appendChild(libCanvas);

  const toggleView = () => {
    showingCanvas = !showingCanvas;
    swapContainer.innerHTML = '';
    if (showingCanvas) {
      swapContainer.appendChild(libCanvas);
      libH3.textContent = 'Canvas (lib) — click to compare';
    } else {
      swapContainer.appendChild(iframe);
      libH3.textContent = 'DOM (live) — click to compare';
    }
  };
  libH3.addEventListener('click', toggleView);
  swapContainer.addEventListener('click', toggleView);

  libCol.appendChild(swapContainer);
  row.appendChild(libCol);

  // Color the diff label
  const diffLabelEl = row.firstElementChild!.querySelector('h3') as HTMLElement;
  diffLabelEl.style.color = pct < 5 ? '#16a34a' : pct < 20 ? '#ca8a04' : '#dc2626';

  section.appendChild(row);

  return {
    section,
    result: {
      name: tc.name,
      contentMismatch: pct,
      referenceTime: result.referenceTime,
      canvasTime: result.canvasLibTime,
    },
  };
}

function createDashboard(total: number, container: HTMLElement): HTMLElement {
  const dashboard = document.createElement('div');
  dashboard.id = 'dashboard';
  container.prepend(dashboard);
  updateDashboard(dashboard, [], total);
  return dashboard;
}

function updateDashboard(dashboard: HTMLElement, results: CaseResult[], total: number) {
  const done = results.length;
  const passed = results.filter(r => r.contentMismatch < 5).length;
  const warn = results.filter(r => r.contentMismatch >= 5 && r.contentMismatch < 20).length;
  const failed = results.filter(r => r.contentMismatch >= 20).length;
  const avgMismatch = done > 0 ? results.reduce((s, r) => s + r.contentMismatch, 0) / done : 0;
  const progress = total > 0 ? (done / total * 100).toFixed(0) : '0';

  // Use median to avoid first-render outlier skewing
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const medCanvas = median(results.map(r => r.canvasTime));
  const medRef = median(results.map(r => r.referenceTime));
  const speedup = medCanvas > 0 ? (medRef / medCanvas).toFixed(1) : '-';

  // Build results table rows
  const sortedResults = [...results].sort((a, b) => b.contentMismatch - a.contentMismatch);
  const tableRows = sortedResults.map(r => {
    const cls = r.contentMismatch < 5 ? 'good' : r.contentMismatch < 20 ? 'warn' : 'bad';
    return `<tr class="${cls}">
      <td>${r.name}</td>
      <td>${r.contentMismatch.toFixed(1)}%</td>
      <td>${r.canvasTime.toFixed(0)}ms</td>
    </tr>`;
  }).join('');

  dashboard.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${done}/${total}</div><div class="stat-label">Done</div></div>
      <div class="stat good"><div class="stat-value">${passed}</div><div class="stat-label">&lt; 5%</div></div>
      <div class="stat warn"><div class="stat-value">${warn}</div><div class="stat-label">5-20%</div></div>
      <div class="stat bad"><div class="stat-value">${failed}</div><div class="stat-label">&gt; 20%</div></div>
      <div class="stat"><div class="stat-value">${avgMismatch.toFixed(1)}%</div><div class="stat-label">Avg mismatch</div></div>
      <div class="stat"><div class="stat-value">${medCanvas.toFixed(0)}ms</div><div class="stat-label">Median render</div></div>
      <div class="stat"><div class="stat-value">${medRef.toFixed(0)}ms</div><div class="stat-label">Median ref</div></div>
      <div class="stat"><div class="stat-value">${speedup}x</div><div class="stat-label">Speedup</div></div>
    </div>
    ${done > 0 ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px;color:#6b7280">Results table (${done} cases)</summary>
    <table class="results-table">
      <thead><tr><th>Test</th><th>Mismatch</th><th>Time</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></details>` : ''}
  `;
}

async function main() {
  const app = document.getElementById('app')!;

  const basicCases = await loadBasicCases();
  const googleFontCase = await loadGoogleFontCase();
  const allCases = [...basicCases, googleFontCase, polotnoCase, polotnoListsCase];

  const rendered: RenderedCase[] = [];
  const dashboard = createDashboard(allCases.length, app);

  for (const tc of allCases) {
    const entry = await renderComparison(tc);
    rendered.push(entry);
    updateDashboard(dashboard, rendered.map(r => r.result), allCases.length);
  }

  // Sort by mismatch (highest first) and append to DOM
  rendered.sort((a, b) => b.result.contentMismatch - a.result.contentMismatch);
  for (const entry of rendered) {
    app.appendChild(entry.section);
  }
}

main().catch(console.error);
