import pixelmatch from 'pixelmatch';
import { htmlToImage } from 'html-to-svg';
import { render } from '../../src/index.ts';

// ─── Canvas-based font loading detection ────────────────────────────────

const FONT_PROBE_TEXT = 'BESbswy 0123456789 Il1Ww';
const FALLBACK_FONTS = ['sans-serif', 'serif', 'monospace'] as const;
const FONT_POLL_INTERVAL = 50;
const FONT_POLL_TIMEOUT = 5000;

let _measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCanvas(): CanvasRenderingContext2D {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  return _measureCanvas.getContext('2d')!;
}

function measureFontWidth(fontFamily: string, fallback: string, weight: string, style: string): number {
  const ctx = getMeasureCanvas();
  ctx.font = `${style} ${weight} 40px '${fontFamily}', ${fallback}`;
  return ctx.measureText(FONT_PROBE_TEXT).width;
}

function measureFallbackWidth(fallback: string, weight: string, style: string): number {
  const ctx = getMeasureCanvas();
  ctx.font = `${style} ${weight} 40px ${fallback}`;
  return ctx.measureText(FONT_PROBE_TEXT).width;
}

function isFontAvailable(fontFamily: string, weight = '400', style = 'normal'): boolean {
  return FALLBACK_FONTS.some(fallback => {
    const withFont = measureFontWidth(fontFamily, fallback, weight, style);
    const withoutFont = measureFallbackWidth(fallback, weight, style);
    return Math.abs(withFont - withoutFont) > 0.01;
  });
}

async function waitForFont(fontFamily: string, weight = '400', style = 'normal'): Promise<void> {
  if (isFontAvailable(fontFamily, weight, style)) return;

  // Try document.fonts.load first (fast path)
  try {
    await document.fonts.load(`${style} ${weight} 16px '${fontFamily}'`);
    if (isFontAvailable(fontFamily, weight, style)) return;
  } catch {}

  // Poll canvas metrics until font appears or timeout
  const maxAttempts = FONT_POLL_TIMEOUT / FONT_POLL_INTERVAL;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, FONT_POLL_INTERVAL));
    if (isFontAvailable(fontFamily, weight, style)) return;
  }
}

export interface ComparisonResult {
  mismatchedPixels: number;
  totalPixels: number;
  contentPixels: number;
  mismatchPercentage: number;
  contentMismatchPercentage: number;
  domCanvas: HTMLCanvasElement;
  libCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  referenceTime: number;
  canvasLibTime: number;
  /** Text lines from the canvas layout (for wrapping comparison) */
  canvasLines: { y: number; text: string }[];
}

/**
 * Render HTML+CSS using html-to-svg (foreignObject-based, pixel-perfect with browser).
 */
export async function renderToDOM(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): Promise<HTMLCanvasElement> {
  const pixelWidth = Math.ceil(width * pixelRatio);
  const pixelHeight = Math.ceil(height * pixelRatio);

  // overflow:hidden creates a BFC, preventing first-child margin collapse.
  // This ensures consistent rendering across Chrome and Firefox foreignObject.
  const fullHTML = `<div style="margin:0;padding:0;overflow:hidden">${html}</div>`;
  const fullCSS = `html, body { margin: 0; padding: 0; }\n${css || ''}`;

  const img = await htmlToImage({
    html: fullHTML,
    css: fullCSS,
    width,
    height,
    pixelRatio,
  });

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);

  return canvas;
}

/**
 * Render HTML using our library.
 */
export function renderToCanvas(
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio = 1,
): { canvas: HTMLCanvasElement; lines: { y: number; text: string }[] } {
  const fullHtml = css ? `<style>${css}</style>${html}` : html;
  const result = render({
    html: fullHtml,
    width,
    height,
    pixelRatio,
  });
  return { canvas: result.canvas as HTMLCanvasElement, lines: result.lines };
}

/**
 * Extract text lines from DOM using Range API.
 * Groups words by their Y position to detect line breaks.
 */
export function extractDomLines(
  html: string,
  css: string,
  width: number,
): { y: number; text: string }[] {
  // Create a container matching the exact structure used for the DOM toggle
  // view — same CSS scoping, same overflow, same wrapper structure.
  const containerId = `__wrap_check_${Date.now()}__`;
  const container = document.createElement('div');
  container.id = containerId;
  container.style.cssText = `position:absolute;left:-9999px;width:${width}px;overflow:hidden;`;
  const scopedCss = css.replace(
    /(^|[},;\s])(\s*)(html|body)\b/gm,
    (match, before, space) => `${before}${space}#${containerId}`,
  );
  const styleEl = document.createElement('style');
  styleEl.textContent = scopedCss;
  container.appendChild(styleEl);
  const content = document.createElement('div');
  content.style.cssText = 'margin:0;padding:0;';
  content.innerHTML = html;
  container.appendChild(content);
  document.body.appendChild(container);

  // Caller must ensure fonts are loaded before calling.
  // In the demo, all fonts are preloaded upfront.
  // In tests, compareRenders handles font loading before rendering.

  const cTop = content.getBoundingClientRect().top;

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // Skip text inside <style>, <script>, and other non-visual elements
      const parent = node.parentElement;
      if (parent && /^(style|script|noscript)$/i.test(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  // Collect word positions using getClientRects() on word-level ranges.
  // getClientRects() returns one rect per visual line when a word wraps
  // mid-word (overflow-wrap: break-word), handling long unbroken words.
  const wordPositions: { x: number; y: number; height: number; text: string }[] = [];
  const range = document.createRange();
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!text.trim()) continue;
    const words = text.split(/(\s+)/);
    let offset = 0;
    for (const w of words) {
      if (!w || !w.trim()) { offset += w.length; continue; }
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + w.length);
      const rects = range.getClientRects();
      // Strip invisible characters (soft hyphens, zero-width spaces) from display text
      const stripInvisible = (s: string) => s.replace(/[\u00AD\u200B]/g, '');

      const hasShy = w.includes('\u00AD') || w.includes('\u200B');

      // For words with soft hyphens / zero-width spaces, getClientRects() may
      // return only 1 rect even when the word visually wraps. In that case,
      // scan character-by-character to detect line breaks by Y position.
      const hasSoftBreaks = w.includes('\u00AD') || w.includes('\u200B');

      if (hasShy) {
        // Char-by-char scan: group by Y position to find line breaks.
        // getClientRects() on shy words can return multiple rects on the
        // same Y line, so rect-based splitting doesn't work reliably.
        const charGroups: { y: number; x: number; height: number; chars: string }[] = [];
        for (let ci = 0; ci < w.length; ci++) {
          const ch = w[ci];
          if (ch === '\u00AD' || ch === '\u200B') continue;
          range.setStart(textNode, offset + ci);
          range.setEnd(textNode, offset + ci + 1);
          const charRect = range.getClientRects()[0];
          if (!charRect) continue;
          const charY = charRect.top - cTop;
          const last = charGroups[charGroups.length - 1];
          if (last && Math.abs(charY - last.y) < last.height * 0.5) {
            last.chars += ch;
          } else {
            charGroups.push({ y: charY, x: charRect.left, height: charRect.height, chars: ch });
          }
        }
        for (const g of charGroups) {
          if (g.chars) {
            wordPositions.push({ x: g.x, y: g.y, height: g.height, text: g.chars });
          }
        }
      } else if (rects.length <= 1) {
        const rect = rects[0] || range.getBoundingClientRect();
        const clean = stripInvisible(w);
        if (clean) {
          wordPositions.push({ x: rect.left, y: rect.top - cTop, height: rect.height, text: clean });
        }
      } else {
        let charIdx = 0;
        for (let ri = 0; ri < rects.length; ri++) {
          const rectY = rects[ri].top - cTop;
          let fragment = '';
          while (charIdx < w.length) {
            range.setStart(textNode, offset + charIdx);
            range.setEnd(textNode, offset + charIdx + 1);
            const charRect = range.getClientRects()[0];
            if (!charRect) { charIdx++; continue; }
            const charY = charRect.top - cTop;
            if (ri + 1 < rects.length && Math.abs(charY - rects[ri + 1].top + cTop) < Math.abs(charY - rectY)) {
              break;
            }
            fragment += w[charIdx];
            charIdx++;
          }
          const clean = stripInvisible(fragment);
          if (clean) {
            wordPositions.push({ x: rects[ri].left, y: rectY, height: rects[ri].height, text: clean });
          }
        }
      }
      offset += w.length;
    }
  }

  document.body.removeChild(container);

  // Group words into lines by Y position. Words on the same visual line
  // can have different Y values due to mixed font sizes (baseline alignment).
  // Use the word's vertical midpoint for grouping, with a tolerance based
  // on word height. This avoids merging overlapping lines (tight line-height)
  // while still grouping mixed-size words on the same baseline.
  wordPositions.sort((a, b) => a.y - b.y);
  const lineGroups: { yMid: number; maxHeight: number; words: typeof wordPositions }[] = [];
  for (const wp of wordPositions) {
    const wpMid = wp.y + wp.height / 2;
    const lastLine = lineGroups[lineGroups.length - 1];
    // Use the tallest word in the line for tolerance — small fonts next to
    // large fonts on the same baseline have very different midpoints, but
    // the large font's height covers the range.
    const tolerance = lastLine ? Math.max(lastLine.maxHeight, wp.height) * 0.5 : 0;
    if (lastLine && Math.abs(wpMid - lastLine.yMid) < tolerance) {
      lastLine.words.push(wp);
      lastLine.maxHeight = Math.max(lastLine.maxHeight, wp.height);
    } else {
      lineGroups.push({ yMid: wpMid, maxHeight: wp.height, words: [wp] });
    }
  }
  // Sort words within each line by X position
  return lineGroups.map(l => {
    l.words.sort((a, b) => a.x - b.x);
    return { y: Math.round(l.yMid), text: l.words.map(w => w.text).join(' ') };
  });
}

export interface LayoutComparisonResult {
  wrappingMatch: boolean;
  canvasLineCount: number;
  domLineCount: number;
  differentLines: { lineIndex: number; canvas: string; dom: string }[];
}

/**
 * Compare text wrapping between our canvas layout and the DOM.
 * Normalizes whitespace — only flags when different words appear on different lines.
 *
 * @param canvasLines - Pre-computed canvas lines from render().lines.
 *   If not provided, runs render internally (may differ from displayed canvas
 *   if font loading state changed).
 */
export function compareWrapping(
  html: string,
  css: string,
  width: number,
  height: number,
  precomputedCanvasLines?: { y: number; text: string }[],
): LayoutComparisonResult {
  const rawCanvasLines = precomputedCanvasLines || render({ html: css ? `<style>${css}</style>${html}` : html, width, height }).lines;
  const rawDomLines = extractDomLines(html, css, width);

  // Normalize: strip whitespace and list markers, sort characters.
  // We only care that the same characters appear on the same line,
  // not their order (RTL) or spacing differences.
  // Strip whitespace, then remove list markers (bullet chars and "N." patterns).
  // Use global replace since multi-column layouts put multiple list items on one line.
  const normalize = (s: string) => {
    let n = s.replace(/\s+/g, '');
    // Remove bullet markers
    n = n.replace(/[•○■▪▸▹◦]/g, '');
    // Remove ordered list markers like "1." "2." "10." — but only when
    // they appear as standalone markers (followed by text, not mid-number)
    n = n.replace(/(?:^|\b)(\d+)\./g, '');
    // Remove trailing hyphens — canvas adds visible '-' at soft-hyphen breaks
    n = n.replace(/-$/, '');
    return n.split('').sort().join('');
  };

  // Filter out empty lines (e.g. list markers without content)
  const canvasLines = rawCanvasLines.filter(l => normalize(l.text).length > 0);
  const domLines = rawDomLines.filter(l => normalize(l.text).length > 0);

  // Different line count = definite wrapping failure
  if (canvasLines.length !== domLines.length) {
    const differentLines: LayoutComparisonResult['differentLines'] = [];
    const maxLines = Math.max(canvasLines.length, domLines.length);
    for (let i = 0; i < maxLines; i++) {
      const cText = canvasLines[i]?.text || '';
      const dText = domLines[i]?.text || '';
      if (normalize(cText) !== normalize(dText)) {
        differentLines.push({ lineIndex: i, canvas: cText, dom: dText });
      }
    }
    return {
      wrappingMatch: false,
      canvasLineCount: canvasLines.length,
      domLineCount: domLines.length,
      differentLines,
    };
  }

  // Same line count — check if break points shifted significantly.
  // Compare cumulative character count at each line boundary.
  // A few chars shifting at a break point is normal measureText imprecision.
  // Only flag when >10% of a line's content moves between lines.
  const differentLines: LayoutComparisonResult['differentLines'] = [];
  let canvasCum = 0;
  let domCum = 0;
  for (let i = 0; i < canvasLines.length; i++) {
    const cLen = normalize(canvasLines[i].text).length;
    const dLen = normalize(domLines[i].text).length;
    canvasCum += cLen;
    domCum += dLen;
    const drift = Math.abs(canvasCum - domCum);
    const lineLen = Math.max(cLen, dLen, 1);
    // Allow at least 2 chars drift — soft-hyphen and sub-pixel measurement
    // differences can shift 1-2 characters between lines at break points.
    if (drift > Math.max(lineLen * 0.1, 2)) {
      differentLines.push({
        lineIndex: i,
        canvas: canvasLines[i].text,
        dom: domLines[i].text,
      });
    }
  }

  return {
    wrappingMatch: differentLines.length === 0,
    canvasLineCount: canvasLines.length,
    domLineCount: domLines.length,
    differentLines,
  };
}

/**
 * Pad an ImageData to target dimensions (filling with white).
 */
function padImageData(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  if (imageData.width === targetWidth && imageData.height === targetHeight) {
    return imageData;
  }

  const padded = new ImageData(targetWidth, targetHeight);
  // Fill with white
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;     // R
    padded.data[i + 1] = 255; // G
    padded.data[i + 2] = 255; // B
    padded.data[i + 3] = 255; // A
  }

  // Copy original data
  for (let y = 0; y < imageData.height && y < targetHeight; y++) {
    for (let x = 0; x < imageData.width && x < targetWidth; x++) {
      const srcIdx = (y * imageData.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      padded.data[dstIdx] = imageData.data[srcIdx];
      padded.data[dstIdx + 1] = imageData.data[srcIdx + 1];
      padded.data[dstIdx + 2] = imageData.data[srcIdx + 2];
      padded.data[dstIdx + 3] = imageData.data[srcIdx + 3];
    }
  }

  return padded;
}

/**
 * Compare rasterizeHTML rendering with our canvas rendering using pixelmatch.
 */
export async function compareRenders(
  html: string,
  css: string,
  width: number,
  height: number,
  threshold = 0.1,
  pixelRatio = 1,
): Promise<ComparisonResult> {
  // Pre-load any @font-face fonts before rendering.
  // Check both the css parameter and inline <style> tags in html.
  const allCSS = (css || '') + '\n' + (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
    .map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');

  let fontStyle: HTMLStyleElement | null = null;
  if (allCSS.includes('@font-face')) {
    const fontFaceBlocks = allCSS.match(/@font-face\s*\{[^}]*\}/g) || [];
    if (fontFaceBlocks.length > 0) {
      // Inject @font-face rules
      fontStyle = document.createElement('style');
      fontStyle.textContent = fontFaceBlocks.join('\n');
      document.head.appendChild(fontStyle);

      // Wait for each font variant using canvas-based detection
      const waitPromises: Promise<void>[] = [];
      const fontFaceRegex = /@font-face\s*\{([^}]*)\}/g;
      let ffMatch;
      while ((ffMatch = fontFaceRegex.exec(allCSS)) !== null) {
        const block = ffMatch[1];
        const familyMatch = block.match(/font-family:\s*['"]?([^;'"]+)/);
        const weightMatch = block.match(/font-weight:\s*([^;]+)/);
        const styleMatch = block.match(/font-style:\s*([^;]+)/);
        if (familyMatch) {
          const name = familyMatch[1].trim();
          const weight = weightMatch ? weightMatch[1].trim() : '400';
          const fStyle = styleMatch ? styleMatch[1].trim() : 'normal';
          waitPromises.push(waitForFont(name, weight, fStyle));
        }
      }
      await Promise.all(waitPromises);
    }
  }

  const t0 = performance.now();
  const domCanvas = await renderToDOM(html, css, width, height, pixelRatio);
  const t1 = performance.now();
  const libResult = renderToCanvas(html, css, width, height, pixelRatio);
  const libCanvas = libResult.canvas;
  const canvasLines = libResult.lines;
  const t2 = performance.now();

  // Clean up font style after both renders are done
  if (fontStyle) fontStyle.remove();
  const referenceTime = t1 - t0;
  const canvasLibTime = t2 - t1;

  // Get image data from both
  const domCtx = domCanvas.getContext('2d')!;
  const libCtx = libCanvas.getContext('2d')!;

  // Use the larger dimensions
  const w = Math.max(domCanvas.width, libCanvas.width);
  const h = Math.max(domCanvas.height, libCanvas.height);

  const domData = padImageData(
    domCtx.getImageData(0, 0, domCanvas.width, domCanvas.height), w, h);
  const libData = padImageData(
    libCtx.getImageData(0, 0, libCanvas.width, libCanvas.height), w, h);

  const t3 = performance.now();
  const diffData = new ImageData(w, h);
  const mismatchedPixels = pixelmatch(
    domData.data, libData.data, diffData.data,
    w, h,
    { threshold },
  );
  // Count content pixels: non-white in either image
  let contentPixels = 0;
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const domIsWhite = domData.data[idx] === 255 && domData.data[idx + 1] === 255 &&
      domData.data[idx + 2] === 255 && domData.data[idx + 3] === 255;
    const libIsWhite = libData.data[idx] === 255 && libData.data[idx + 1] === 255 &&
      libData.data[idx + 2] === 255 && libData.data[idx + 3] === 255;
    // Also treat fully transparent as empty
    const domIsEmpty = domIsWhite || domData.data[idx + 3] === 0;
    const libIsEmpty = libIsWhite || libData.data[idx + 3] === 0;
    if (!domIsEmpty || !libIsEmpty) {
      contentPixels++;
    }
  }

  // Create diff canvas
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = w;
  diffCanvas.height = h;
  diffCanvas.getContext('2d')!.putImageData(diffData, 0, 0);

  const totalPixels = w * h;
  // Use content pixels for mismatch %, with a floor to avoid division by zero
  const effectiveContent = Math.max(contentPixels, 1);

  return {
    mismatchedPixels,
    totalPixels,
    contentPixels,
    mismatchPercentage: (mismatchedPixels / totalPixels) * 100,
    contentMismatchPercentage: (mismatchedPixels / effectiveContent) * 100,
    domCanvas,
    libCanvas,
    diffCanvas,
    referenceTime,
    canvasLibTime,
    canvasLines,
  };
}
