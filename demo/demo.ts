import { compareRenders } from '../tests/helpers/compare.ts';
import { loadBasicCases, loadGoogleFontCase, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from '../tests/helpers/test-cases.ts';
import type { BenchmarkCase } from '../tests/helpers/test-cases.ts';

const PIXEL_RATIO = window.devicePixelRatio || 2;

// ─── Types ──────────────────────────────────────────────────────────────

interface CellResult {
  mismatch: number;
}

// 2D grid: grid[testIndex][fontIndex] = CellResult
type ResultGrid = (CellResult | null)[][];

// ─── Font override ──────────────────────────────────────────────────────

let _multiFontCss = '';

/**
 * Create a variant of a test case with a different font.
 * Prepends the multi-font @font-face CSS and adds a body font-family override.
 */
function withFont(tc: BenchmarkCase, fontFamily: string): BenchmarkCase {
  return {
    ...tc,
    css: _multiFontCss + '\n' + tc.css + `\nbody { font-family: ${fontFamily} !important; }`,
  };
}

// ─── Detail view (click to expand) ──────────────────────────────────────

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

async function showDetail(tc: BenchmarkCase, fontFamily: string, container: HTMLElement) {
  const variant = withFont(tc, fontFamily);
  const result = await compareRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
  const pct = result.contentMismatchPercentage;
  const filled = (result.contentPixels / result.totalPixels * 100).toFixed(0);

  const section = document.createElement('div');
  section.className = 'case';
  section.id = 'detail-view';

  const title = document.createElement('h2');
  title.textContent = `${tc.name} — ${fontFamily} `;
  const badge = document.createElement('span');
  badge.className = pct < 5 ? 'badge good' : pct < 20 ? 'badge warn' : 'badge bad';
  badge.textContent = `${pct.toFixed(1)}%`;
  title.appendChild(badge);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'margin-left:12px;font-size:12px;padding:2px 8px;cursor:pointer;';
  closeBtn.onclick = () => section.remove();
  title.appendChild(closeBtn);
  section.appendChild(title);

  const row = document.createElement('div');
  row.className = 'comparison';

  addColumn(row, `Diff: ${pct.toFixed(1)}% (${filled}% filled)`, result.diffCanvas, PIXEL_RATIO);
  addColumn(row, 'html-to-svg', result.domCanvas, PIXEL_RATIO);

  // Canvas with click-to-swap
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

  const iframe = createIsolatedDOM(variant);
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

  const diffLabelEl = row.firstElementChild!.querySelector('h3') as HTMLElement;
  diffLabelEl.style.color = pct < 5 ? '#16a34a' : pct < 20 ? '#ca8a04' : '#dc2626';

  section.appendChild(row);

  // Remove existing detail view
  document.getElementById('detail-view')?.remove();
  container.prepend(section);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── 2D Results Table ───────────────────────────────────────────────────

function renderResultsTable(
  cases: BenchmarkCase[],
  fonts: typeof FONT_VARIANTS,
  grid: ResultGrid,
  container: HTMLElement,
  detailContainer: HTMLElement,
): HTMLElement {
  const table = document.createElement('div');
  table.id = 'results-grid';

  const fontNames = fonts.map(f => f.name);

  // Build HTML table
  const headerCells = fontNames.map(n => `<th>${n}</th>`).join('');
  let rows = '';
  for (let ti = 0; ti < cases.length; ti++) {
    let cells = '';
    for (let fi = 0; fi < fonts.length; fi++) {
      const cell = grid[ti][fi];
      if (cell === null) {
        cells += '<td class="pending">...</td>';
      } else {
        const pct = cell.mismatch;
        const cls = pct < 5 ? 'good' : pct < 20 ? 'warn' : 'bad';
        cells += `<td class="${cls}" data-test="${ti}" data-font="${fi}">${pct.toFixed(1)}</td>`;
      }
    }
    rows += `<tr><td class="test-name">${cases[ti].name}</td>${cells}</tr>`;
  }

  table.innerHTML = `
    <table class="results-table grid-table">
      <thead><tr><th>Test Case</th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Click handler for cells — show detail view
  table.addEventListener('click', (e) => {
    const td = (e.target as HTMLElement).closest('td[data-test]') as HTMLElement | null;
    if (!td) return;
    const ti = parseInt(td.dataset.test!);
    const fi = parseInt(td.dataset.font!);
    showDetail(cases[ti], fonts[fi].family, detailContainer);
  });

  container.innerHTML = '';
  container.appendChild(table);
  return table;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const app = document.getElementById('app')!;

  // Status
  const status = document.createElement('div');
  status.id = 'status';
  status.textContent = 'Loading fonts and test cases...';
  app.appendChild(status);

  // Load everything
  _multiFontCss = await loadMultiFontCss();
  const basicCases = await loadBasicCases();
  const googleFontCase = await loadGoogleFontCase();
  const allCases = [...basicCases, googleFontCase, polotnoCase, polotnoListsCase];
  const fonts = FONT_VARIANTS;

  // Create grid
  const grid: ResultGrid = allCases.map(() => fonts.map(() => null));

  // Table container
  const tableContainer = document.createElement('div');
  tableContainer.id = 'table-container';
  app.appendChild(tableContainer);

  // Detail container (for clicked cells)
  const detailContainer = document.createElement('div');
  detailContainer.id = 'detail-container';
  app.appendChild(detailContainer);

  // Initial render
  renderResultsTable(allCases, fonts, grid, tableContainer, detailContainer);

  // Run all comparisons
  const total = allCases.length * fonts.length;
  let done = 0;

  for (let ti = 0; ti < allCases.length; ti++) {
    for (let fi = 0; fi < fonts.length; fi++) {
      const tc = allCases[ti];
      const variant = withFont(tc, fonts[fi].family);
      try {
        const result = await compareRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
        grid[ti][fi] = { mismatch: result.contentMismatchPercentage };
      } catch (e) {
        grid[ti][fi] = { mismatch: -1 };
      }
      done++;
      status.textContent = `Running: ${done}/${total} (${(done/total*100).toFixed(0)}%)`;
      renderResultsTable(allCases, fonts, grid, tableContainer, detailContainer);
    }
  }

  // Summary
  const allResults = grid.flat().filter((c): c is CellResult => c !== null && c.mismatch >= 0);
  const avg = allResults.reduce((s, r) => s + r.mismatch, 0) / allResults.length;
  const good = allResults.filter(r => r.mismatch < 5).length;
  const warn = allResults.filter(r => r.mismatch >= 5 && r.mismatch < 20).length;
  const bad = allResults.filter(r => r.mismatch >= 20).length;
  status.innerHTML = `Done: ${allResults.length} cells | <span style="color:#16a34a">${good} &lt;5%</span> | <span style="color:#ca8a04">${warn} 5-20%</span> | <span style="color:#dc2626">${bad} &gt;20%</span> | avg ${avg.toFixed(1)}%`;
}

main().catch(console.error);
