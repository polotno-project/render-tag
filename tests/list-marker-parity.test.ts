/**
 * List-marker parity harness (maintainer tool — NOT part of `npm test`).
 *
 * Goal: prove render-tag's canvas list markers match the REAL Chrome DOM
 * (native ::marker) for canonical <ul>/<ol> HTML, across fonts and sizes —
 * the same canvas-vs-DOM screenshot discipline used for underline/strikethrough.
 *
 * Method: compareRenders renders the SAME html+css through both an independent
 * native browser page (ground truth, native markers) and render-tag's canvas. To judge the MARKER
 * (not the line), we split each render at the list gutter and measure ink bboxes:
 *   - text bbox  (x >= gutter): "Header" — its shift = line-placement error
 *                                (line-height/baseline; a SEPARATE concern).
 *   - marker bbox (x <  gutter): the bullet/number glyph.
 * markerΔrel = (lib.marker − dom.marker) − (lib.text − dom.text)  → pure marker
 * geometry error, independent of where the line sits.
 *
 * Run:    npx vitest run tests/list-marker-parity.test.ts
 * Report: tests/list-marker-report.chrome.html   (git-ignored, images + numbers)
 */
import { describe, it } from 'vitest';
import { commands } from 'vitest/browser';
import { compareNativeRenders as compareRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';

const PR = 2;
import { browserName } from './helpers/browser-name.ts';

// Canonical native-marker reset — mirrors @polotno/core wrapHtmlForRenderTag.
const RESET = `<style>
  p { margin:0; padding:0; overflow-wrap:break-word; white-space:pre-wrap; }
  ul, ol { padding-inline-start:2.1em; margin:0; display:block; width:100%; box-sizing:border-box; text-decoration:inherit; }
  li { padding-inline-start:0; margin:0; overflow-wrap:break-word; white-space:pre-wrap; }
  ol { list-style-type: decimal; }
  ul { list-style-type: disc; }
  code, pre, kbd, samp { font-size: inherit; }
</style>`;

const FONTS = [
  { name: 'Roboto', family: "'Roboto', sans-serif" },
  { name: 'Open Sans', family: "'Open Sans', sans-serif" },
  { name: 'Playfair Display', family: "'Playfair Display', serif" },
  { name: 'Merriweather', family: "'Merriweather', serif" },
  { name: 'Lobster', family: "'Lobster', cursive" },
];
const SIZES = [16, 24, 40, 77, 120];

type Marker = 'bullet' | 'number' | 'number2digit' | 'bulletColor';

function caseHtml(marker: Marker, family: string, size: number, fontCss: string): string {
  const decoration = marker === 'bulletColor' ? `<style>li::marker{color:#c21c1c}</style>` : '';
  const body =
    marker === 'number'
      ? `<ol><li>Header</li></ol>`
      : marker === 'number2digit'
        ? `<ol>${'<li>x</li>'.repeat(9)}<li>Header</li></ol>`
        : `<ul><li>Header</li></ul>`;
  return (
    `<style>${fontCss}</style>` + RESET + decoration +
    `<div style="font-family:${family};font-size:${size}px;line-height:1.2;color:#000">${body}</div>`
  );
}

// Ink bbox of non-near-white pixels within [x0,x1) of an ImageData.
function inkBBox(data: Uint8ClampedArray, W: number, H: number, x0: number, x1: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const white = a === 0 || (r > 245 && g > 245 && b > 245);
      if (!white) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        count++;
      }
    }
  }
  if (!count) return null;
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function ctxData(canvas: HTMLCanvasElement) {
  const c = canvas.getContext('2d')!;
  return { data: c.getImageData(0, 0, canvas.width, canvas.height).data, W: canvas.width, H: canvas.height };
}

describe('list-marker parity (canvas vs native DOM)', () => {
  it('sweeps fonts × sizes × marker types, isolating marker geometry', async () => {
    const fontCss = await loadMultiFontCss();
    await Promise.all(FONTS.map((f) => document.fonts.load(`400 40px '${f.name}'`)));
    await document.fonts.ready;

    const width = 900, height = 240;
    type Row = {
      marker: Marker; font: string; size: number; score: number;
      dxRel: number | null; dyRel: number | null; lineDx: number | null; lineDy: number | null;
      dom: string; lib: string; diff: string;
    };
    const rows: Row[] = [];

    for (const marker of ['bullet', 'bulletColor', 'number', 'number2digit'] as Marker[]) {
      for (const f of FONTS) {
        for (const size of SIZES) {
          const html = caseHtml(marker, f.family, size, fontCss);
          const cmp = await compareRenders(html, '', width, height, 0.1, PR);
          const gutter = Math.round(1.95 * size * PR); // px column splitting marker | text
          const dom = ctxData(cmp.domCanvas), lib = ctxData(cmp.libCanvas);
          const domMk = inkBBox(dom.data, dom.W, dom.H, 0, gutter);
          const libMk = inkBBox(lib.data, lib.W, lib.H, 0, gutter);
          const domTx = inkBBox(dom.data, dom.W, dom.H, gutter, dom.W);
          const libTx = inkBBox(lib.data, lib.W, lib.H, gutter, lib.W);
          let dxRel: number | null = null, dyRel: number | null = null,
            lineDx: number | null = null, lineDy: number | null = null;
          if (domMk && libMk && domTx && libTx) {
            // line placement error (from text ink top-left)
            lineDx = (libTx.minX - domTx.minX) / PR;
            lineDy = (libTx.minY - domTx.minY) / PR;
            // marker error relative to its own line (factor out line shift)
            dxRel = (libMk.maxX - domMk.maxX) / PR - lineDx; // right edge (gap to text)
            dyRel = (libMk.cy - domMk.cy) / PR - lineDy;      // ink vertical center
          }
          rows.push({
            marker, font: f.name, size,
            score: cmp.contentMismatchPercentage,
            dxRel, dyRel, lineDx, lineDy,
            dom: cmp.domCanvas.toDataURL('image/png'),
            lib: cmp.libCanvas.toDataURL('image/png'),
            diff: cmp.diffCanvas.toDataURL('image/png'),
          });
        }
      }
    }

    const fmt = (n: number | null) => (n == null ? '  -  ' : (n >= 0 ? '+' : '') + n.toFixed(1));
    const worst = (r: Row) => Math.max(Math.abs(r.dxRel ?? 0), Math.abs(r.dyRel ?? 0));
    const sorted = rows.slice().sort((a, b) => worst(b) - worst(a));

    // One plain-text table, logged and written to disk (marker Δ relative to
    // line, worst first — line shift factored out; rawScore for context).
    const table =
      'markerΔx markerΔy  lineΔy  rawScore  case\n' +
      sorted.map((r) =>
        `${fmt(r.dxRel).padStart(7)} ${fmt(r.dyRel).padStart(7)} ${fmt(r.lineDy).padStart(7)} ${r.score.toFixed(1).padStart(6)}%  ${r.marker.padEnd(12)} ${r.font.padEnd(18)} ${r.size}px`
      ).join('\n') + '\n';
    console.log('\n=== Marker geometry error (px, relative to line; worst first) ===\n' + table);

    const cell = (r: Row) => `
      <div class="case">
        <div class="hd">${r.marker} · ${r.font} · ${r.size}px —
          marker Δx <b class="${Math.abs(r.dxRel ?? 0) > 2 ? 'bad' : 'ok'}">${fmt(r.dxRel)}</b>,
          Δy <b class="${Math.abs(r.dyRel ?? 0) > 2 ? 'bad' : 'ok'}">${fmt(r.dyRel)}</b> px ·
          <span class=dim>line Δy ${fmt(r.lineDy)} · raw ${r.score.toFixed(1)}%</span></div>
        <div class="imgs">
          <figure><figcaption>DOM (native)</figcaption><img src="${r.dom}"></figure>
          <figure><figcaption>render-tag</figcaption><img src="${r.lib}"></figure>
          <figure><figcaption>diff</figcaption><img src="${r.diff}"></figure>
        </div>
      </div>`;
    const report = `<!doctype html><meta charset=utf8><title>List marker parity — ${browserName}</title>
      <style>
        body{font:13px system-ui;margin:20px;background:#f6f7f9}
        .case{background:#fff;border:1px solid #ddd;border-radius:8px;margin:0 0 14px;padding:10px}
        .hd{font-weight:600;margin-bottom:8px} .dim{color:#888;font-weight:400}
        .imgs{display:flex;gap:16px;flex-wrap:wrap} figure{margin:0}
        figcaption{color:#666;font-size:11px;margin-bottom:3px}
        img{border:1px solid #ccc;background:#fff;max-width:420px;height:auto;display:block}
        .bad{color:#c0392b}.ok{color:#27ae60}
      </style>
      <h1>List-marker parity: render-tag vs native Chrome DOM (${browserName})</h1>
      <p>Sorted worst-first by |marker Δ| <b>relative to its line</b> (line shift factored out).</p>
      ${sorted.map(cell).join('')}`;
    const reportPath = `./tests/list-marker-report.${browserName}.html`;
    await commands.writeFile(reportPath, report);
    await commands.writeFile(`./tests/list-marker-table.${browserName}.txt`, table);
    console.log('Report written:', reportPath);
  });
});
