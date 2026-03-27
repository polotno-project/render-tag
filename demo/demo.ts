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
  // Display high-DPI canvases at their natural CSS size (canvas.width / pixelRatio)
  if (content instanceof HTMLCanvasElement) {
    content.style.width = `${content.width / pixelRatio}px`;
    content.style.height = `${content.height / pixelRatio}px`;
  }
  col.appendChild(content);
  row.appendChild(col);
}

/**
 * Create a live DOM preview inside an iframe for full CSS isolation.
 */
function createIsolatedDOM(tc: BenchmarkCase): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.style.width = `${tc.width}px`;
  iframe.style.height = `${tc.height}px`;
  iframe.style.border = '1px solid #ccc';
  iframe.style.overflow = 'hidden';
  iframe.scrolling = 'no';

  // Write content after iframe is in the DOM
  iframe.srcdoc = `<!DOCTYPE html>
<html><head><style>${tc.css || ''}</style></head>
<body style="margin:0;padding:0">${tc.html}</body></html>`;

  return iframe;
}

async function renderComparison(tc: BenchmarkCase, container: HTMLElement) {
  const section = document.createElement('div');
  section.className = 'case';

  const title = document.createElement('h2');
  title.textContent = tc.name;
  section.appendChild(title);

  const row = document.createElement('div');
  row.className = 'comparison';

  // 1. Live DOM render — inside iframe for complete style isolation
  const iframe = createIsolatedDOM(tc);
  addColumn(row, 'DOM', iframe, 1);

  // 2-4. rasterizeHTML, canvas, diff — via compareRenders
  try {
    const result = await compareRenders(tc.html, tc.css, tc.width, tc.height, 0.1, PIXEL_RATIO);

    addColumn(row, 'rasterizeHTML', result.domCanvas, PIXEL_RATIO);
    addColumn(row, 'Canvas (lib)', result.libCanvas, PIXEL_RATIO);
    addColumn(row, `Diff (${result.mismatchPercentage.toFixed(2)}%)`, result.diffCanvas, PIXEL_RATIO);

    // Color the diff label based on quality
    const diffLabel = row.lastElementChild!.querySelector('h3') as HTMLElement;
    if (result.mismatchPercentage < 3) {
      diffLabel.style.color = '#16a34a';
    } else if (result.mismatchPercentage < 10) {
      diffLabel.style.color = '#ca8a04';
    } else {
      diffLabel.style.color = '#dc2626';
    }
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.color = 'red';
    errDiv.textContent = `Error: ${err}`;
    row.appendChild(errDiv);
  }

  section.appendChild(row);
  container.appendChild(section);
}

async function main() {
  const app = document.getElementById('app')!;

  const basicCases = await loadBasicCases();
  const googleFontCase = await loadGoogleFontCase();
  const allCases = [...basicCases, googleFontCase, polotnoCase, polotnoListsCase];

  for (const tc of allCases) {
    await renderComparison(tc, app);
  }
}

main().catch(console.error);
