import { compareRenders, compareWrapping, extractDomLines } from '../tests/helpers/compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from '../tests/helpers/test-cases.ts';
import type { BenchmarkCase } from '../tests/helpers/test-cases.ts';

const PIXEL_RATIO = window.devicePixelRatio || 2;

// ─── Types ──────────────────────────────────────────────────────────────

interface CellResult {
  mismatch: number;
  wrappingFail: boolean;
}

type ResultGrid = (CellResult | null)[][];

// ─── Pause control ──────────────────────────────────────────────────────

let paused = false;
let pauseResolve: (() => void) | null = null;

function waitIfPaused(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise(resolve => { pauseResolve = resolve; });
}

function resume() {
  paused = false;
  if (pauseResolve) {
    pauseResolve();
    pauseResolve = null;
  }
}

// ─── Font override ──────────────────────────────────────────────────────

let _multiFontCss = '';

function withFont(tc: BenchmarkCase, fontFamily: string): BenchmarkCase {
  return {
    ...tc,
    css: _multiFontCss + '\n' + tc.css + `\nbody { font-family: ${fontFamily} !important; }`,
  };
}

// ─── Detail view ────────────────────────────────────────────────────────

function addColumn(
  row: HTMLElement,
  label: string,
  content: HTMLElement,
  pixelRatio: number,
): void {
  const col = document.createElement('div');
  col.style.flexShrink = '0';
  const h3 = document.createElement('h3');
  h3.textContent = label;
  h3.style.cssText = 'margin:0 0 6px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;';
  col.appendChild(h3);
  content.style.border = '1px solid #ccc';
  if (content instanceof HTMLCanvasElement) {
    content.style.width = `${content.width / pixelRatio}px`;
    content.style.height = `${content.height / pixelRatio}px`;
  }
  col.appendChild(content);
  row.appendChild(col);
}

function createIsolatedDOM(tc: BenchmarkCase): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `width:${tc.width}px;height:${tc.height}px;border:1px solid #ccc;overflow:hidden;position:relative;`;

  const id = `__dom_preview_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  wrapper.id = id;
  const scopedCss = (tc.css || '').replace(
    /(^|[},;\s])(\s*)(html|body)\b/gm,
    (match, before, space) => `${before}${space}#${id}`,
  );
  const style = document.createElement('style');
  style.textContent = scopedCss;
  wrapper.appendChild(style);

  const content = document.createElement('div');
  content.style.cssText = 'margin:0;padding:0;';
  content.innerHTML = tc.html;
  wrapper.appendChild(content);

  return wrapper;
}

let allCases: BenchmarkCase[] = [];

async function showDetail(tc: BenchmarkCase, fontFamily: string, container: HTMLElement) {
  const variant = withFont(tc, fontFamily);
  const result = await compareRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
  const pct = result.contentMismatchPercentage;
  const wrap = await compareWrapping(variant.html, variant.css, variant.width, variant.height, result.canvasLines);
  const filled = (result.contentPixels / result.totalPixels * 100).toFixed(0);

  const section = document.createElement('div');
  section.id = 'detail-view';
  section.style.cssText = 'margin:24px auto;max-width:1056px;padding:16px 32px;background:#fff;border:1px solid #e0e0e0;font-family:system-ui,sans-serif;';

  const title = document.createElement('h2');
  title.style.cssText = 'margin:0 0 12px;font-size:16px;color:#374151;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  title.textContent = `${tc.name} — ${fontFamily} `;

  const badgeColor = pct < 5 ? '#dcfce7;color:#166534' : pct < 30 ? '#fef9c3;color:#854d0e' : '#fee2e2;color:#991b1b';
  const badge = document.createElement('span');
  badge.style.cssText = `display:inline-block;padding:2px 8px;font-size:12px;font-weight:600;background:${badgeColor};`;
  badge.textContent = `${pct.toFixed(1)}%`;
  title.appendChild(badge);

  if (!wrap.wrappingMatch) {
    const wrapBadge = document.createElement('span');
    wrapBadge.style.cssText = 'display:inline-block;padding:2px 8px;font-size:12px;font-weight:600;background:#fee2e2;color:#991b1b;';
    wrapBadge.textContent = `WRAPPING FAIL (${wrap.canvasLineCount} vs ${wrap.domLineCount} lines)`;
    title.appendChild(wrapBadge);
  }

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'margin-left:12px;font-size:12px;padding:2px 8px;cursor:pointer;';
  closeBtn.onclick = () => section.remove();
  title.appendChild(closeBtn);
  section.appendChild(title);

  if (!wrap.wrappingMatch) {
    const wrapInfo = document.createElement('div');
    wrapInfo.style.cssText = 'background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;font-family:monospace;white-space:pre-wrap;';
    const diffLines = wrap.differentLines.slice(0, 5).map(d =>
      `Line ${d.lineIndex}:\n  canvas: "${d.canvas.substring(0, 60)}"\n  dom:    "${d.dom.substring(0, 60)}"`
    ).join('\n');
    wrapInfo.textContent = diffLines;
    section.appendChild(wrapInfo);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;overflow-x:auto;';

  addColumn(row, `Diff: ${pct.toFixed(1)}% (${filled}% filled)`, result.diffCanvas, PIXEL_RATIO);
  addColumn(row, 'html-to-svg', result.domCanvas, PIXEL_RATIO);

  const libCol = document.createElement('div');
  libCol.style.flexShrink = '0';
  const libH3 = document.createElement('h3');
  libH3.textContent = 'Canvas (lib) — click to compare';
  libH3.style.cssText = 'margin:0 0 6px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;cursor:pointer;';
  libCol.appendChild(libH3);

  const libCanvas = result.libCanvas;
  libCanvas.style.border = '1px solid #ccc';
  libCanvas.style.width = `${libCanvas.width / PIXEL_RATIO}px`;
  libCanvas.style.height = `${libCanvas.height / PIXEL_RATIO}px`;
  libCanvas.style.cursor = 'pointer';

  const iframe = createIsolatedDOM(variant);
  iframe.style.display = 'none';

  let showingCanvas = true;
  const swapContainer = document.createElement('div');
  swapContainer.appendChild(libCanvas);
  swapContainer.appendChild(iframe);

  const toggleView = () => {
    showingCanvas = !showingCanvas;
    if (showingCanvas) {
      libCanvas.style.display = '';
      iframe.style.display = 'none';
      libH3.textContent = 'Canvas (lib) — click to compare';
    } else {
      libCanvas.style.display = 'none';
      iframe.style.display = '';
      libH3.textContent = 'DOM (live) — click to compare';
    }
  };
  libH3.addEventListener('click', toggleView);
  swapContainer.addEventListener('click', toggleView);
  libCol.appendChild(swapContainer);
  row.appendChild(libCol);

  const diffLabelEl = row.firstElementChild!.querySelector('h3') as HTMLElement;
  diffLabelEl.style.color = pct < 5 ? '#16a34a' : pct < 30 ? '#ca8a04' : '#dc2626';

  section.appendChild(row);

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
  const headerCells = fontNames.map(n => `<th>${n}</th>`).join('');
  let rows = '';

  for (let ti = 0; ti < cases.length; ti++) {
    let cells = '';
    let rowHasFailure = false;
    for (let fi = 0; fi < fonts.length; fi++) {
      const cell = grid[ti][fi];
      if (cell === null) {
        cells += '<td class="pending">...</td>';
      } else if (cell.wrappingFail) {
        cells += `<td class="wrap-fail" data-test="${ti}" data-font="${fi}">WRAP</td>`;
        rowHasFailure = true;
      } else {
        const pct = cell.mismatch;
        const cls = pct < 5 ? 'good' : pct < 30 ? 'warn' : 'bad';
        if (pct >= 30) { rowHasFailure = true; }
        cells += `<td class="${cls}" data-test="${ti}" data-font="${fi}">${pct.toFixed(1)}</td>`;
      }
    }
    const rowCls = rowHasFailure ? ' class="has-failure"' : '';
    rows += `<tr${rowCls}><td class="test-name">${cases[ti].name}</td>${cells}</tr>`;
  }

  table.innerHTML = `
    <table class="results-table grid-table">
      <thead><tr><th>Test Case</th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

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
  const status = document.getElementById('status')!;
  const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
  const tableContainer = document.getElementById('table-container')!;
  const detailContainer = document.getElementById('detail-container')!;

  // Pause/Resume button
  btnPause.addEventListener('click', () => {
    if (paused) {
      resume();
      btnPause.textContent = 'Pause';
    } else {
      paused = true;
      btnPause.textContent = 'Resume';
    }
  });

  _multiFontCss = await loadMultiFontCss();
  const basicCases = await loadBasicCases();
  allCases = [...basicCases, polotnoCase, polotnoListsCase];

  // Preload fonts
  status.textContent = 'Loading fonts...';
  const allCss = [_multiFontCss];
  for (const tc of allCases) {
    if (tc.css) allCss.push(tc.css);
  }
  const fontFaceOnly = allCss.join('\n').match(/@font-face\s*\{[^}]*\}/g) || [];
  const preloadStyle = document.createElement('style');
  preloadStyle.textContent = fontFaceOnly.join('\n');
  document.head.appendChild(preloadStyle);
  const fontProbe = document.createElement('div');
  fontProbe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;';
  fontProbe.innerHTML = FONT_VARIANTS.map(f =>
    `<span style="font-family:${f.family}">Mg</span>`
  ).join('');
  document.body.appendChild(fontProbe);
  await document.fonts.ready;
  fontProbe.remove();

  const fonts = FONT_VARIANTS;
  const grid: ResultGrid = allCases.map(() => fonts.map(() => null));

  renderResultsTable(allCases, fonts, grid, tableContainer, detailContainer);

  const total = allCases.length * fonts.length;
  let done = 0;
  const failedCells: { ti: number; fi: number }[] = [];

  btnPause.hidden = false;

  for (let ti = 0; ti < allCases.length; ti++) {
    for (let fi = 0; fi < fonts.length; fi++) {
      // Wait if paused
      await waitIfPaused();

      const tc = allCases[ti];
      const variant = withFont(tc, fonts[fi].family);
      try {
        const result = await compareRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
        const wrap = await compareWrapping(variant.html, variant.css, variant.width, variant.height, result.canvasLines);
        const wrappingFail = !wrap.wrappingMatch;
        grid[ti][fi] = { mismatch: result.contentMismatchPercentage, wrappingFail };

        if (wrappingFail || result.contentMismatchPercentage >= 30) {
          failedCells.push({ ti, fi });
        }
      } catch (e) {
        grid[ti][fi] = { mismatch: -1, wrappingFail: false };
      }
      done++;
      status.textContent = `Running: ${done}/${total} (${(done / total * 100).toFixed(0)}%)`;
      renderResultsTable(allCases, fonts, grid, tableContainer, detailContainer);
    }
  }

  btnPause.hidden = true;

  // Summary
  const allResults = grid.flat().filter((c): c is CellResult => c !== null && c.mismatch >= 0);
  const good = allResults.filter(r => !r.wrappingFail && r.mismatch < 5).length;
  const warn = allResults.filter(r => !r.wrappingFail && r.mismatch >= 5 && r.mismatch < 30).length;
  const bad = allResults.filter(r => r.mismatch >= 30).length;
  const wrapFails = allResults.filter(r => r.wrappingFail).length;
  const avg = allResults.reduce((s, r) => s + r.mismatch, 0) / allResults.length;
  status.innerHTML = `Done: ${allResults.length} cells | ` +
    `<span style="color:#16a34a">${good} &lt;5%</span> | ` +
    `<span style="color:#ca8a04">${warn} 5-30%</span> | ` +
    `<span style="color:#dc2626">${bad} &gt;30%</span> | ` +
    `<span style="color:#dc2626;font-weight:700">${wrapFails} WRAP</span> | ` +
    `avg ${avg.toFixed(1)}%`;

  if (failedCells.length > 0) {
    const { ti, fi } = failedCells[0];
    showDetail(allCases[ti], fonts[fi].family, detailContainer);
  }
}

main().catch(console.error);
