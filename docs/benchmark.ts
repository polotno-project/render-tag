import { compareWrapping, extractDomLines } from '../tests/helpers/compare.ts';
import { compareSvgRenders } from '../tests/helpers/svg-compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, FONT_VARIANTS, loadMultiFontCss } from '../tests/helpers/test-cases.ts';
import type { BenchmarkCase } from '../tests/helpers/test-cases.ts';
import { layout } from '../src/index.ts';

// ─── Accurate canvas-vs-DOM word-level debug (runs in THIS browser) ───────
// Compares the canvas engine's per-word widths/positions against the real DOM
// rendered in the same browser, so a metric divergence (e.g. test Chromium vs
// real Chrome) shows up as per-word width deltas. Logs to console too.
function logWordLevelDebug(variant: BenchmarkCase): string {
  const W = variant.width;
  const L: string[] = [];
  const p = (s: string) => L.push(s);

  p(`========== WORD-LEVEL DEBUG ==========`);
  p(`UA: ${navigator.userAgent}`);
  p(`devicePixelRatio: ${window.devicePixelRatio}`);
  p(`width: ${W}px`);
  // Which fonts are actually available right now?
  const fams = ["'Merriweather'", "'Roboto'", "'Lobster'", "'Playfair Display'"];
  for (const f of fams) {
    for (const variant2 of [`400 16px ${f}`, `700 16px ${f}`, `italic 400 16px ${f}`]) {
      p(`  fonts.check(${variant2}) = ${document.fonts.check(variant2)}`);
    }
  }

  // ── Canvas engine output (lines) — MUST include the CSS (font override) ──
  const fullHtml = variant.css ? `<style>${variant.css}</style>${variant.html}` : variant.html;
  const lr = layout({ html: fullHtml, width: W, height: variant.height });

  // ── DOM words (real browser layout in a scoped container) ──
  const id = `__wld_${Date.now()}__`;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = `position:absolute;left:-9999px;top:0;width:${W}px;overflow:hidden;`;
  const scoped = (variant.css || '').replace(/(^|[},;\s])(\s*)(html|body)\b/gm, (m, b, s) => `${b}${s}#${id}`);
  const st = document.createElement('style'); st.textContent = scoped; host.appendChild(st);
  const content = document.createElement('div'); content.style.cssText = 'margin:0;padding:0;'; content.innerHTML = variant.html;
  host.appendChild(content);
  document.body.appendChild(host);
  const cTop = content.getBoundingClientRect().top;
  const cLeft = content.getBoundingClientRect().left;
  interface DWord { x: number; top: number; bot: number; w: number; t: string; font: string }
  const dWords: DWord[] = [];
  const wlk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const rg = document.createRange();
  let tn: Node | null;
  while ((tn = wlk.nextNode())) {
    const text = tn.textContent || '';
    if (!text.trim()) continue;
    const parent = (tn as Text).parentElement!;
    if (/^(style|script)$/i.test(parent.tagName)) continue;
    const font = getComputedStyle(parent).font;
    let off = 0;
    for (const wd of text.split(/(\s+)/)) {
      if (wd && wd.trim()) {
        rg.setStart(tn, off); rg.setEnd(tn, off + wd.length);
        const rc = rg.getBoundingClientRect();
        dWords.push({ x: +(rc.left - cLeft).toFixed(2), top: +(rc.top - cTop).toFixed(2), bot: +(rc.bottom - cTop).toFixed(2), w: +rc.width.toFixed(2), t: wd, font });
      }
      off += wd.length;
    }
  }
  document.body.removeChild(host);

  // ── AUTHORITATIVE wrap verdict (what the benchmark badge uses) ──
  const cmp = compareWrapping(variant.html, variant.css, W, variant.height);
  const realDomLines = extractDomLines(variant.html, variant.css, W);
  p(`\n*** AUTHORITATIVE compareWrapping: match=${cmp.wrappingMatch} (canvas ${cmp.canvasLineCount} / dom ${cmp.domLineCount}) ***`);
  if (!cmp.wrappingMatch) {
    p(`  DIFFERING LINES:`);
    cmp.differentLines.forEach(d => p(`    line ${d.lineIndex}: canvas="${d.canvas}" dom="${d.dom}"`));
  }

  // ── PER-CHARACTER line check: for every non-space char, which visual line
  // is it on in the canvas vs the real DOM? The first char whose line differs
  // is the exact wrap divergence (no line-grouping ambiguity). ──
  {
    // Canvas: char -> line index from the engine's lines.
    const cLines = (lr as any).lines || [];
    const cChars: string[] = []; const cIdx: number[] = [];
    cLines.forEach((l: any, i: number) => { for (const ch of l.text) if (!/\s/.test(ch)) { cChars.push(ch); cIdx.push(i); } });
    // DOM: group words into visual lines by BASELINE (rect bottom, tolerant of
    // tall mixed-size spans), ordered top-to-bottom; then char -> line index.
    const byBaseline: { bot: number; words: DWord[] }[] = [];
    for (const w of [...dWords].sort((a, b) => a.bot - b.bot || a.x - b.x)) {
      const g = byBaseline.find(b => Math.abs(b.bot - w.bot) < 10);
      if (g) { g.words.push(w); g.bot = (g.bot + w.bot) / 2; } else byBaseline.push({ bot: w.bot, words: [w] });
    }
    byBaseline.sort((a, b) => a.bot - b.bot);
    const dChars: string[] = []; const dIdx: number[] = [];
    byBaseline.forEach((g, i) => g.words.sort((a, b) => a.x - b.x).forEach(w => { for (const ch of w.t) if (!/\s/.test(ch)) { dChars.push(ch); dIdx.push(i); } }));

    p(`\n=== PER-CHARACTER line check (canvas vs DOM) ===`);
    p(`  canvas chars=${cChars.length} (${cIdx[cIdx.length - 1] + 1} lines), dom chars=${dChars.length} (${(dIdx[dIdx.length - 1] ?? -1) + 1} lines)`);
    const n = Math.min(cChars.length, dChars.length);
    let firstDiff = -1; let diffCount = 0;
    for (let k = 0; k < n; k++) {
      if (cChars[k] !== dChars[k]) { p(`  ⚠ char sequence diverged at #${k}: canvas '${cChars[k]}' vs dom '${dChars[k]}' (can't align further)`); break; }
      if (cIdx[k] !== dIdx[k]) { diffCount++; if (firstDiff < 0) firstDiff = k; }
    }
    if (firstDiff < 0) p(`  ✓ every character is on the SAME line in canvas and DOM`);
    else {
      const ctx = cChars.slice(Math.max(0, firstDiff - 12), firstDiff + 12).join('');
      p(`  ✗ FIRST DIVERGENCE at char #${firstDiff}: '${cChars[firstDiff]}' is on canvas line ${cIdx[firstDiff]} but DOM line ${dIdx[firstDiff]}`);
      p(`     context: "...${ctx}..."`);
      p(`     (${diffCount} of ${n} chars are on different lines)`);
    }
  }

  p(`\n=== CANVAS lines (engine) ===`);
  const canvasLines = (lr as any).lines || [];
  for (let i = 0; i < canvasLines.length; i++) p(`  ${i}: y=${canvasLines[i].y} w=${(canvasLines[i].bounds?.width ?? 0).toFixed(2)} "${canvasLines[i].text}"`);

  p(`\n=== REAL extractDomLines (what compareWrapping compares against) ===`);
  realDomLines.forEach((l, i) => p(`  ${i}: "${l.text}"`));

  // ── Per-word width: canvas measureText (with the word's computed font) vs
  // the DOM-rendered rect width — IN THIS BROWSER. If these differ, the canvas
  // and the real DOM disagree on glyph metrics → that's the wrap cause. If they
  // match (Δ≈0), any wrap difference is a logic/grouping issue, not metrics.
  const mctx = document.createElement('canvas').getContext('2d')!;
  mctx.fontKerning = 'normal';
  p(`\n=== Per-word width: canvas measureText vs DOM rect (same font, this browser) ===`);
  let maxDelta = 0; let sumCanvas = 0; let sumDom = 0;
  for (const dw of dWords) {
    mctx.font = dw.font;          // the DOM's computed font for this word
    (mctx as any).letterSpacing = '0px';
    const cwid = mctx.measureText(dw.t).width;
    const delta = cwid - dw.w;
    sumCanvas += cwid; sumDom += dw.w;
    if (Math.abs(delta) > Math.abs(maxDelta)) maxDelta = delta;
    const flag = Math.abs(delta) > 0.3 ? '  <-- DELTA' : '';
    p(`  "${dw.t}" canvasMeasure=${cwid.toFixed(2)} domRect=${dw.w.toFixed(2)} Δ=${delta.toFixed(2)}${flag}  font=${dw.font}`);
  }
  p(`\nSUM canvasMeasure=${sumCanvas.toFixed(2)} domRect=${sumDom.toFixed(2)} Δtotal=${(sumCanvas - sumDom).toFixed(2)}`);
  p(`Max single-word Δ (canvas - dom): ${maxDelta.toFixed(2)}px`);
  p(`\nINTERPRETATION:`);
  p(`  • If Δs are ~0 but canvas/DOM lines differ → grouping/logic (not metrics).`);
  p(`  • If Δs are nonzero → canvas measureText disagrees with the DOM in YOUR`);
  p(`    browser (font version / hinting / not-loaded). Check fonts.check above.`);
  return L.join('\n');
}

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
  const result = await compareSvgRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
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

    // Show the actual compareWrapping result from this detail view recompute
    let debugText = `=== Wrap check (detail view recompute) ===\n`;
    debugText += `  match: ${wrap.wrappingMatch} | canvas: ${wrap.canvasLineCount} dom: ${wrap.domLineCount}\n`;
    if (wrap.differentLines.length > 0) {
      wrap.differentLines.forEach(d => {
        debugText += `  line ${d.lineIndex}: canvas="${d.canvas.substring(0,50)}" dom="${d.dom.substring(0,50)}"\n`;
      });
    }
    debugText += '\n=== Canvas lines ===\n';
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

    // Accurate per-word canvas-vs-DOM comparison (the key signal for a
    // test-vs-real-browser metric divergence). Runs in THIS browser.
    try {
      const wordDebug = logWordLevelDebug(variant);
      debugText += '\n\n' + wordDebug;
      console.log(`\n### ${tc.name} @ ${fontFamily} ###\n` + wordDebug);
    } catch (e) {
      debugText += `\n\n[word-level debug error: ${e}]`;
      console.error('word-level debug error', e);
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
  // Explicitly load every variant family at the weights/styles the cases use,
  // then await. `document.fonts.ready` alone can resolve before URL-based
  // Google fonts finish, leaving the SYNCHRONOUS render() measuring a fallback
  // font (different metrics → false wrapping mismatches vs the DOM). render()
  // requires fonts to be loaded first, so guarantee it here.
  const famNames = ['Open Sans', 'Roboto', 'Playfair Display', 'Merriweather', 'Lobster', 'Inconsolata'];
  const weights = ['300', '400', '600', '700', '900'];
  const styles = ['normal', 'italic'];
  const loadJobs: Promise<unknown>[] = [];
  for (const fam of famNames)
    for (const w of weights)
      for (const st of styles)
        loadJobs.push(document.fonts.load(`${st} ${w} 24px '${fam}'`, 'Mg 0123').catch(() => {}));
  await Promise.all(loadJobs);
  await document.fonts.ready;
  // Warn loudly if any variant still failed (e.g. Google Fonts unreachable) —
  // wrapping comparisons are unreliable when the canvas falls back.
  const missing = FONT_VARIANTS.filter(f => !document.fonts.check(`400 24px ${f.family.split(',')[0]}`));
  if (missing.length) {
    console.warn('[benchmark] fonts NOT loaded (wrapping checks unreliable):', missing.map(f => f.name));
    // Persistent banner (the status text gets overwritten in isolated mode).
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:8px 16px;font:600 13px system-ui;border:1px solid #fca5a5;';
    banner.textContent = `⚠ Fonts NOT loaded: ${missing.map(f => f.name).join(', ')}. Canvas falls back → wrapping checks are unreliable. Check Network tab for blocked fonts.gstatic.com requests.`;
    document.body.insertBefore(banner, document.body.firstChild);
  } else {
    console.log('[benchmark] all variant fonts loaded ✓');
  }

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
        const result = await compareSvgRenders(variant.html, variant.css, variant.width, variant.height, 0.1, PIXEL_RATIO);
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
