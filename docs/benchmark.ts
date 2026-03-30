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

  // Isolate button — updates URL to run only this case on reload
  const isolateBtn = document.createElement('button');
  const isIsolated = new URLSearchParams(window.location.search).has('case');
  isolateBtn.textContent = isIsolated ? 'Show all' : 'Isolate';
  isolateBtn.style.cssText = 'margin-left:8px;font-size:12px;padding:2px 8px;cursor:pointer;';
  isolateBtn.onclick = () => {
    if (isIsolated) {
      window.location.search = '';
    } else {
      const params = new URLSearchParams();
      params.set('case', tc.name);
      params.set('font', fontFamily);
      window.location.search = params.toString();
    }
  };
  title.appendChild(isolateBtn);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;';
  closeBtn.onclick = () => {
    section.remove();
    // Clear URL params when closing in isolated mode
    if (isIsolated) window.location.search = '';
  };
  title.appendChild(closeBtn);
  section.appendChild(title);

  // Always show debug info: canvas lines vs DOM lines + word widths
  {
    const domLines = extractDomLines(variant.html, variant.css, variant.width);
    const canvasLines = result.canvasLines;

    let debugText = '=== Canvas lines ===\n';
    canvasLines.forEach((l, i) => { debugText += `  ${i}: y=${l.y} "${l.text}"\n`; });
    debugText += '\n=== DOM lines ===\n';
    domLines.forEach((l, i) => { debugText += `  ${i}: y=${l.y} "${l.text}"\n`; });

    if (!wrap.wrappingMatch) {
      debugText += '\n=== Wrapping differences ===\n';
      wrap.differentLines.slice(0, 10).forEach(d => {
        debugText += `  Line ${d.lineIndex}:\n    canvas: "${d.canvas}"\n    dom:    "${d.dom}"\n`;
      });
    }

    // Word-by-word width measurement for each text in DOM lines
    const debugCanvas = document.createElement('canvas');
    const debugCtx = debugCanvas.getContext('2d')!;
    debugCtx.font = `400 18px ${fontFamily}`;
    debugCtx.fontKerning = 'normal';
    debugText += `\n=== Word widths (font: ${debugCtx.font}) ===\n`;
    const spaceWidth = debugCtx.measureText(' ').width;

    // Measure all text from the DOM lines that wrap
    for (let li = 0; li < domLines.length; li++) {
      const lineText = domLines[li].text;
      const words = lineText.split(' ').filter(w => w);
      let lineWidth = 0;
      for (const word of words) {
        const w = debugCtx.measureText(word).width;
        if (lineWidth > 0) lineWidth += spaceWidth;
        lineWidth += w;
      }
      debugText += `  line ${li}: "${lineText.substring(0, 70)}${lineText.length > 70 ? '...' : ''}" totalW=${lineWidth.toFixed(2)}/${variant.width}\n`;
    }

    // Detailed word-by-word for the diverging line (if any)
    if (wrap.differentLines.length > 0) {
      const diffIdx = wrap.differentLines[0].lineIndex;
      const domLine = domLines[diffIdx]?.text || '';
      const prevDomLine = diffIdx > 0 ? domLines[diffIdx - 1]?.text || '' : '';
      const combinedText = (prevDomLine ? prevDomLine + ' ' : '') + domLine;
      debugText += `\n=== Word-by-word for diverging region ===\n`;
      debugText += `  contentWidth: ${variant.width}\n`;
      const lineWords = combinedText.split(' ').filter(w => w);
      let cumW = 0;
      for (const word of lineWords) {
        const w = debugCtx.measureText(word).width;
        const sw = cumW > 0 ? spaceWidth : 0;
        cumW += sw + w;
        debugText += `  "${word}" w=${w.toFixed(2)} space=${sw.toFixed(2)} cumLine=${cumW.toFixed(2)}${cumW > variant.width ? ' OVERFLOW' : ''}\n`;
      }
    }

    // Font metrics and baseline calculation debug
    {
      // Get CSS from the variant
      const css = variant.css;
      // Find font-size from CSS (look for body font-size)
      const fontSizeMatch = css.match(/font-size:\s*([\d.]+)px/);
      const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 16;

      // Canvas font metrics
      const metricsCtx = debugCanvas.getContext('2d')!;
      metricsCtx.font = `400 ${fontSize}px ${fontFamily}`;
      metricsCtx.fontKerning = 'normal';
      const mM = metricsCtx.measureText('M');
      const canvasAscent = mM.fontBoundingBoxAscent ?? mM.actualBoundingBoxAscent;
      const canvasDescent = mM.fontBoundingBoxDescent ?? mM.actualBoundingBoxDescent;

      debugText += `\n=== Font metrics (${fontSize}px ${fontFamily}) ===\n`;
      debugText += `  canvas fontBoundingBoxAscent: ${mM.fontBoundingBoxAscent}\n`;
      debugText += `  canvas fontBoundingBoxDescent: ${mM.fontBoundingBoxDescent}\n`;
      debugText += `  canvas actualBoundingBoxAscent: ${mM.actualBoundingBoxAscent}\n`;
      debugText += `  canvas actualBoundingBoxDescent: ${mM.actualBoundingBoxDescent}\n`;
      debugText += `  canvas ascent (used): ${canvasAscent.toFixed(2)}\n`;
      debugText += `  canvas descent (used): ${canvasDescent.toFixed(2)}\n`;
      debugText += `  canvas textHeight (a+d): ${(canvasAscent + canvasDescent).toFixed(2)}\n`;

      // DOM line height probe
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;top:-9999px;left:-9999px;visibility:hidden;font:400 ${fontSize}px ${fontFamily};white-space:nowrap;padding:0;margin:0;border:0;`;
      probe.textContent = 'Mg';
      document.body.appendChild(probe);
      const domLineHeight = probe.getBoundingClientRect().height;
      probe.style.lineHeight = 'normal';
      const domNormalLH = probe.getBoundingClientRect().height;
      document.body.removeChild(probe);

      debugText += `  DOM probe height (Mg): ${domLineHeight.toFixed(2)}\n`;
      debugText += `  DOM probe height (normal LH): ${domNormalLH.toFixed(2)}\n`;

      // Baseline calculation (mirrors layout.ts computeBaselineY)
      const lineHeight = domNormalLH; // this is what getLineHeight returns with DOM measurement
      const textBlockHeight = canvasAscent + canvasDescent;
      const baselineY = (canvasAscent - canvasDescent) / 2 + lineHeight / 2;
      const baselineY2 = (lineHeight - textBlockHeight) / 2 + canvasAscent;
      debugText += `  computed lineHeight: ${lineHeight.toFixed(2)}\n`;
      debugText += `  computeBaselineY (Konva): ${baselineY.toFixed(2)}\n`;
      debugText += `  layoutInlineContent baselineY: ${baselineY2.toFixed(2)}\n`;

      // DOM first element position for comparison
      const domProbe = document.createElement('div');
      domProbe.id = '__debug_probe__';
      domProbe.style.cssText = `position:absolute;left:-9999px;width:${variant.width}px;overflow:hidden;`;
      const scopedCss = css.replace(/(^|[},;\s])(\s*)(html|body)\b/gm, (m, before, space) => `${before}${space}#__debug_probe__`);
      const styleEl = document.createElement('style');
      styleEl.textContent = scopedCss;
      domProbe.appendChild(styleEl);
      const content = document.createElement('div');
      content.style.cssText = 'margin:0;padding:0;';
      content.innerHTML = variant.html;
      domProbe.appendChild(content);
      document.body.appendChild(domProbe);
      const containerTop = content.getBoundingClientRect().top;

      const allP = content.querySelectorAll('p');
      debugText += `\n=== DOM <p> positions ===\n`;
      for (let i = 0; i < Math.min(allP.length, 15); i++) {
        const p = allP[i];
        const rect = p.getBoundingClientRect();
        const text = (p.textContent || '').trim().substring(0, 40);
        debugText += `  p[${i}]: top=${(rect.top - containerTop).toFixed(1)} h=${rect.height.toFixed(1)} "${text || '(empty)'}"\n`;
      }
      document.body.removeChild(domProbe);
    }

    const debugWrap = document.createElement('div');
    debugWrap.style.cssText = 'position:relative;margin-bottom:12px;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy log';
    copyBtn.style.cssText = 'position:absolute;top:6px;right:6px;padding:2px 10px;font-size:11px;cursor:pointer;background:#fff;border:1px solid #bae6fd;border-radius:4px;z-index:1;';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(debugText).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy log'; }, 1500);
      });
    };
    debugWrap.appendChild(copyBtn);

    const debugInfo = document.createElement('div');
    debugInfo.style.cssText = 'background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:8px 12px;font-size:11px;font-family:monospace;white-space:pre-wrap;max-height:400px;overflow:auto;';
    debugInfo.textContent = debugText;
    debugWrap.appendChild(debugInfo);
    section.appendChild(debugWrap);
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

  // Isolated debug mode: ?case=Name&font=Family skips the grid
  const urlParams = new URLSearchParams(window.location.search);
  const debugCase = urlParams.get('case');
  const debugFont = urlParams.get('font');
  if (debugCase) {
    const tc = allCases.find(c => c.name === debugCase);
    const fontFamily = debugFont || fonts[0].family;
    if (tc) {
      status.textContent = `Debug: ${debugCase} — ${fontFamily}`;
      showDetail(tc, fontFamily, detailContainer);
      return;
    }
    status.textContent = `Case "${debugCase}" not found. Running full benchmark...`;
  }

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
