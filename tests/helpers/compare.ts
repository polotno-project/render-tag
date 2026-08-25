import pixelmatch from 'pixelmatch';
import { layout, render } from '../../src/index.ts';
import {
  compareLineMembership,
  type LayoutComparisonResult,
} from './wrap-comparison.ts';
import { keepUsedFontFaces } from './test-cases.ts';
import { matchFontFaces, stripFontFaces } from './css-text.ts';

/**
 * Point a fixture's `html`/`body` rules at the offscreen container instead, so
 * the DOM reference and the canvas see the same cascade.
 */
function scopeCss(css: string, containerId: string): string {
  return css.replace(
    /(^|[},;\s])(\s*)(html|body)\b/gm,
    (_match, before, space) => `${before}${space}#${containerId}`,
  );
}

export type { LayoutComparisonResult } from './wrap-comparison.ts';

// Font faces are document-scoped. Keep each unique rule registered for the
// browser test session so a pixel comparison and its following DOM wrap check
// cannot observe different font sets.
const registeredFontFaces = new Set<string>();
let fontLoadQueue = Promise.resolve();
let fontWarmId = 0;

async function registerFonts(css: string): Promise<void> {
  const blocks = matchFontFaces(css);
  const newBlocks = [...new Set(
    blocks.filter((block) => !registeredFontFaces.has(block)),
  )];
  if (newBlocks.length === 0) return;

  const existingFaces = new Set(document.fonts);
  const style = document.createElement('style');
  style.dataset.renderTagComparisonFonts = '';
  style.textContent = newBlocks.join('\n');
  document.head.appendChild(style);

  // Force CSSOM registration before taking the FontFaceSet snapshot.
  void style.sheet?.cssRules.length;
  const addedFaces = [...document.fonts].filter((face) => !existingFaces.has(face));

  // Load through CSS selection instead of FontFace.load(). A variable family
  // has several overlapping Unicode-range faces; forcing all of them to load
  // can make Blink cache whichever subset finishes first, changing advances.
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-99999px;top:-99999px;visibility:hidden;white-space:nowrap;';
  const sample =
    'BESbswy Привет Tiếng Việt 한글 日本語 中文 العربية हिन्दी မြန်မာ ខ្មែរ ไทย 👨‍👩‍👧‍👦';
  const selections = new Map<string, FontFace>();
  for (const face of addedFaces) {
    const weight = face.weight === '700' ? '700' : '400';
    selections.set(`${face.family}|${face.style}|${weight}`, face);
  }
  for (const face of selections.values()) {
    const span = document.createElement('span');
    span.style.fontFamily = face.family;
    span.style.fontSize = '48px';
    span.style.fontStyle = face.style === 'italic' ? 'italic' : 'normal';
    span.style.fontWeight = face.weight === '700' ? '700' : '400';
    span.textContent = sample;
    probe.appendChild(span);
  }
  document.body.appendChild(probe);
  try {
    void probe.getBoundingClientRect();
    await document.fonts.ready;
  } finally {
    probe.remove();
  }

  const failed = addedFaces
    .filter((face) => face.status === 'error')
    .map((face) => `${face.family} ${face.weight} ${face.style}`);
  if (failed.length > 0) {
    style.remove();
    throw new Error(
      `prepareComparisonFonts: @font-face failed to load: ${failed.join(', ')}`,
    );
  }

  for (const block of newBlocks) registeredFontFaces.add(block);
}

function ensureFontsLoaded(css: string): Promise<void> {
  const result = fontLoadQueue.then(() => registerFonts(css));
  fontLoadQueue = result.catch(() => {});
  return result;
}

export async function prepareComparisonFonts(html: string, css: string): Promise<void> {
  const inlineCss = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
    .map((style) => style.replace(/<\/?style[^>]*>/gi, ''))
    .join('\n');
  await ensureFontsLoaded(`${css || ''}\n${inlineCss}`);

  const containerId = `__font_warm_${fontWarmId++}__`;
  const container = document.createElement('div');
  container.id = containerId;
  container.style.cssText =
    'position:absolute;left:-99999px;top:-99999px;visibility:hidden;';
  const style = document.createElement('style');
  const withoutFaces = stripFontFaces(css);
  style.textContent = scopeCss(withoutFaces, containerId);
  const content = document.createElement('div');
  content.innerHTML = stripFontFaces(html);
  container.append(style, content);
  document.body.appendChild(container);
  try {
    void content.getBoundingClientRect();
    await document.fonts.ready;
  } finally {
    container.remove();
  }
}

export interface PixelComparisonResult {
  mismatchedPixels: number;
  totalPixels: number;
  contentPixels: number;
  mismatchPercentage: number;
  contentMismatchPercentage: number;
  /** Rendered on first access — diagnostic callers only. */
  readonly diffCanvas: HTMLCanvasElement;
}

export interface ComparisonResult extends PixelComparisonResult {
  domCanvas: HTMLCanvasElement;
  libCanvas: HTMLCanvasElement;
  /** Text lines from the canvas layout (for wrapping comparison) */
  canvasLines: { y: number; text: string }[];
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
 * Corpus cases whose wrapping cannot be compared through `extractDomLines`.
 * It produces ONE global line stream, but these layouts contain independent
 * cell/column flows whose rows cannot be paired against a single stream — a
 * mismatch here is the comparison method, not a render-tag bug. Shared so the
 * sweep gates and the debug harness agree on what is out of scope.
 */
export const UNPAIRABLE_WRAP_CASES = new Set<string>([
  'Very narrow container', // 1ch container, browser-specific min-content
  'Styled table',
  'Multi-column layout',
]);

/** Cases whose wrapping only Firefox gets to skip — one home, three gates. */
export const FIREFOX_WRAP_SKIPS = ['Long unbroken word overflow-wrap'];

/**
 * Mount a fixture off-screen at a fixed width, laid out by the browser itself.
 * Callers must ensure fonts are loaded first (prepareComparisonFonts), and
 * must remove the returned container when done.
 */
function mountFixture(
  html: string,
  css: string,
  width: number,
): { container: HTMLElement; content: HTMLElement } {
  // Create a container matching the exact structure used for the DOM toggle
  // view — same CSS scoping, same overflow, same wrapper structure.
  const containerId = `__wrap_check_${Date.now()}__`;
  const container = document.createElement('div');
  container.id = containerId;
  container.style.cssText = `position:absolute;left:-9999px;width:${width}px;overflow:hidden;`;
  // prepareComparisonFonts registers every face globally before this runs.
  // Re-declaring @font-face in a short-lived style creates a fresh cold face
  // and can make the DOM measure fallback glyphs for this one comparison.
  const loadedFaceCss = stripFontFaces(css);
  const scopedCss = scopeCss(loadedFaceCss, containerId);
  const styleEl = document.createElement('style');
  styleEl.textContent = scopedCss;
  container.appendChild(styleEl);
  const content = document.createElement('div');
  content.style.cssText = 'margin:0;padding:0;';
  content.innerHTML = html;
  container.appendChild(content);
  document.body.appendChild(container);
  return { container, content };
}

/**
 * Border-box geometry of every element matching `selector`, in document order,
 * relative to the fixture's content origin.
 *
 * Flex sizing is a width question, and only the boxes answer it directly: two
 * columns are independent flows, so the line oracle cannot pair them, while
 * their widths compare exactly.
 */
export function extractDomBoxes(
  html: string,
  css: string,
  width: number,
  selector: string,
): { x: number; width: number }[] {
  const { container, content } = mountFixture(html, css, width);
  const origin = content.getBoundingClientRect().left;
  const boxes = [...content.querySelectorAll(selector)].map((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - origin, width: rect.width };
  });
  container.remove();
  return boxes;
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
  const { container, content } = mountFixture(html, css, width);
  try {
    return collectDomLines(content);
  } finally {
    document.body.removeChild(container);
  }
}

/** A word's trailing edge in reading order: right edge LTR, left edge RTL. */
function trailingEdge(wp: { x: number; width: number }, rtl: boolean): number {
  return rtl ? wp.x : wp.x + wp.width;
}

/**
 * Read the browser's own line membership out of an already-mounted fixture.
 * Separate from the mount so a width sweep can mount once and reflow per
 * width instead of re-parsing the fixture ~30k times.
 */
function collectDomLines(content: HTMLElement): { y: number; text: string }[] {
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
  const wordPositions: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
  }[] = [];
  const range = document.createRange();
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!text.trim()) continue;
    const transform = getComputedStyle(textNode.parentElement!).textTransform;
    const paintedText = (value: string) => {
      if (transform === 'uppercase') return value.toUpperCase();
      if (transform === 'lowercase') return value.toLowerCase();
      if (transform === 'capitalize') {
        return value.replace(/(^|\s)(\p{L})/gu, (_match, space, letter) =>
          space + letter.toUpperCase());
      }
      return value;
    };

    const words = text.split(/(\s+)/);
    let offset = 0;
    for (const w of words) {
      if (!w || !w.trim()) {
        offset += w.length;
        continue;
      }
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + w.length);
      const rects = range.getClientRects();
      // Strip invisible characters (soft hyphens, zero-width spaces) from display text
      const stripInvisible = (s: string) => s.replace(/[\u00AD\u200B]/g, '');

      // For words with soft hyphens / zero-width spaces, getClientRects() may
      // return only 1 rect even when the word visually wraps. In that case,
      // scan character-by-character to detect line breaks by Y position.
      const hasShy = w.includes('\u00AD') || w.includes('\u200B');

      if (hasShy || rects.length > 1) {
        // Per character, the transform has to be read off the WHOLE word: `^`
        // in the capitalize rule matches inside every single-character string,
        // which would upper-case every letter. A transform that changes length
        // has no character-to-character mapping, so fall back to the source.
        const paintedWord = paintedText(w);
        const paintedChar = (index: number) =>
          paintedWord.length === w.length ? paintedWord[index] : w[index];
        // Char-by-char scan: group by Y position to find line breaks.
        // getClientRects() on shy words can return multiple rects on the
        // same Y line, so rect-based splitting doesn't work reliably.
        const charGroups: {
          y: number;
          x: number;
          right: number;
          height: number;
          chars: string;
        }[] = [];
        // A soft hyphen taken as a break makes the engine paint a '-' that it
        // reports as an EXTRA rect on the previous line, ahead of the following
        // character's own box. Taking the first rect put that character on the
        // wrong line and hid the hyphen; the character's own box is the last.
        const characterRect = (index: number): DOMRect | undefined => {
          range.setStart(textNode, offset + index);
          range.setEnd(textNode, offset + index + 1);
          const rects = range.getClientRects();
          return rects[rects.length - 1];
        };
        for (let ci = 0; ci < w.length; ci++) {
          const ch = w[ci];
          if (ch === '\u00AD') {
            const last = charGroups[charGroups.length - 1];
            let next = ci + 1;
            while (next < w.length && /[\u00AD\u200B]/.test(w[next])) next++;
            if (last && next < w.length) {
              const nextRect = characterRect(next);
              if (nextRect && Math.abs(nextRect.top - cTop - last.y) >= last.height * 0.5) {
                last.chars += '-';
              }
            }
            continue;
          }
          if (ch === '\u200B') continue;
          const charRect = characterRect(ci);
          if (!charRect) continue;
          const charY = charRect.top - cTop;
          const last = charGroups[charGroups.length - 1];
          if (last && Math.abs(charY - last.y) < last.height * 0.5) {
            last.chars += paintedChar(ci);
            last.right = Math.max(last.right, charRect.right);
          } else {
            charGroups.push({
              y: charY,
              x: charRect.left,
              right: charRect.right,
              height: charRect.height,
              chars: paintedChar(ci),
            });
          }
        }
        for (const g of charGroups) {
          if (g.chars) {
            wordPositions.push({
              x: g.x,
              y: g.y,
              width: g.right - g.x,
              height: g.height,
              text: g.chars,
            });
          }
        }
      } else {
        const rect = rects[0] || range.getBoundingClientRect();
        const clean = paintedText(stripInvisible(w));
        if (clean) {
          wordPositions.push({
            x: rect.left,
            y: rect.top - cTop,
            width: rect.width,
            height: rect.height,
            text: clean,
          });
        }
      }
      offset += w.length;
    }
  }

  // Group words into lines by Y position. Words on the same visual line
  // can have different Y values due to mixed font sizes (baseline alignment).
  // Use the word's vertical midpoint for grouping, with a tolerance based
  // on word height. This avoids merging overlapping lines (tight line-height)
  // while still grouping mixed-size words on the same baseline.
  // Group words into visual lines using DOCUMENT (reading) order, not a Y sort.
  //
  // A word continues the current line only when BOTH hold:
  //   1. its vertical band overlaps the line's band (anchored on the first
  //      word, never expanded by tall outliers), and
  //   2. its left edge advances in the line's reading direction (LTR: x grows,
  //      RTL: x shrinks) — a line wrap resets x to the opposite margin.
  //
  // The x-reset signal is what makes this robust where pure Y-clustering fails:
  //   • vertical-align / sup / sub / mixed font sizes: x keeps advancing, so
  //     a 30px text-top glyph stays on its baseline line (no phantom line).
  //   • tight line-height (lines whose glyph boxes overlap): the wrapped word
  //     resets x, so it still starts a new line despite the vertical overlap.
  //   • multi-column / separate flows: a new column starts above (no vertical
  //     overlap) → new line, matching the canvas LayoutLine stream which keeps
  //     columns separate.
  const TOL_X = 4;
  const RTL_RE = /[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const lineGroups: {
    top: number;
    bottom: number;
    lastX: number;
    rtl: boolean;
    words: typeof wordPositions;
  }[] = [];
  for (const wp of wordPositions) {
    const top = wp.y;
    const bottom = wp.y + wp.height;
    const last = lineGroups[lineGroups.length - 1];
    if (last) {
      const overlap = Math.min(bottom, last.bottom) - Math.max(top, last.top);
      const minH = Math.min(bottom - top, last.bottom - last.top);
      const ratio = overlap / minH;
      // Near-full vertical overlap → same line unconditionally. This covers
      // baseline-aligned text of mixed font sizes AND bidi (LTR+RTL) lines,
      // where x is non-monotonic and the reading-direction test below would
      // wrongly split. Partial overlap is the ambiguous zone — a tall
      // vertical-align glyph (same line) vs a tight-line-height wrap (new
      // line) — disambiguated by whether x advances in the reading direction
      // (a wrap resets x to the opposite margin).
      let join = false;
      if (ratio >= 0.7) {
        join = true;
      } else if (ratio > 0.2) {
        // Advance is judged against the previous word's TRAILING edge in
        // reading order (LTR: right edge; RTL: left edge). Comparing against
        // its left edge wrongly joined a wrapped word whenever the previous
        // line held a single word flush at the margin — under line-height
        // <= 1 that merged real DOM lines and misreported render-tag.
        join = last.rtl
          ? wp.x + wp.width <= last.lastX + TOL_X
          : wp.x >= last.lastX - TOL_X;
      }
      if (join) {
        last.words.push(wp);
        last.lastX = trailingEdge(wp, last.rtl);
        if (!last.rtl && RTL_RE.test(wp.text)) last.rtl = true;
        continue;
      }
    }
    const rtl = RTL_RE.test(wp.text);
    lineGroups.push({
      top,
      bottom,
      lastX: trailingEdge(wp, rtl),
      rtl,
      words: [wp],
    });
  }
  // Second pass: merge reading-order lines that share the SAME visual row but
  // belong to different flows (flex/multi-column). The canvas emits one
  // LayoutLine per Y row spanning all columns, so two lines whose vertical
  // bands FULLY overlap (parallel columns at the same Y) are one visual row
  // here too. Partially-overlapping lines (tight line-height within one flow)
  // are left separate — that's the single-flow wrap signal we must preserve.
  lineGroups.sort((a, b) => a.top - b.top);
  const merged: typeof lineGroups = [];
  for (const g of lineGroups) {
    const target = merged.find((m) => {
      const overlap =
        Math.min(g.bottom, m.bottom) - Math.max(g.top, m.top);
      const minH = Math.min(g.bottom - g.top, m.bottom - m.top);
      return overlap / minH >= 0.7;
    });
    if (target) {
      target.words.push(...g.words);
    } else {
      merged.push(g);
    }
  }
  // Sort lines top-to-bottom, and words within each line by X position.
  merged.sort((a, b) => a.top - b.top);
  return merged.map((l) => {
    l.words.sort((a, b) => a.x - b.x);
    return {
      y: Math.round(l.top),
      text: l.words.map((w) => w.text).join(' '),
    };
  });
}

/**
 * Lay a fixture out once against the DOM and throw the answer away.
 *
 * The first native layout of a fixture finalizes lazy variable-font shaping in
 * some engines, so a width swept first would be the only one compared against a
 * cold font backend. Sweeps call this at the fixture's natural width first.
 */
export function warmNativeLayout(html: string, css: string, width: number): void {
  extractDomLines(html, css, width);
}

/**
 * Sweep one fixture across container widths and return the widths where the
 * canvas and the DOM disagree on line membership. The fixture is mounted ONCE
 * and reflowed per width — the mount (CSS scoping, style parse, innerHTML) is
 * width-independent and dominated the sweep's runtime when repeated ~30k
 * times. The DOM is read before the canvas at every width: some font
 * backends finalize a face on its first DOM use.
 */
export function sweepWrapWidths(
  html: string,
  css: string,
  maxWidth: number,
  height: number,
  options: { minWidth?: number; step?: number } = {},
): number[] {
  const { minWidth = 100, step = 1 } = options;
  const failed: number[] = [];
  const { container, content } = mountFixture(html, css, maxWidth);
  try {
    for (let width = Math.min(minWidth, maxWidth); width <= maxWidth; width += step) {
      container.style.width = `${width}px`;
      const domLines = collectDomLines(content);
      const canvasLines = layout({
        html: css ? `<style>${css}</style>${html}` : html,
        width,
        height,
      }).lines;
      if (!compareLineMembership(canvasLines, domLines).wrappingMatch) {
        failed.push(width);
      }
    }
  } finally {
    document.body.removeChild(container);
  }
  return failed;
}

/**
 * Compare text wrapping between our canvas layout and the DOM.
 * Ignores paint-only order/marker differences, but requires every source glyph
 * to stay on the same line. There is no character-drift allowance.
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
  // Shape through native layout first. Some browser font backends finalize a
  // newly loaded variable face on its first DOM use; measuring canvas first
  // can otherwise make a width sweep depend on which width happened to run
  // before it.
  const rawDomLines = extractDomLines(html, css, width);
  const rawCanvasLines =
    precomputedCanvasLines ||
    // layout() over render(): only the lines are wanted, and the sweeps that
    // call this run thousands of widths — painting each one is pure waste.
    layout({ html: css ? `<style>${css}</style>${html}` : html, width, height })
      .lines;
  return compareLineMembership(rawCanvasLines, rawDomLines);
}

function pixelsOnWhite(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): ImageData {
  // Normalize through ImageData before drawing. Directly drawing a decoded PNG
  // is color-managed differently in Firefox and changes byte-level baselines.
  const sourcePixels = canvas.getContext('2d')!.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const padded = new ImageData(width, height);
  padded.data.fill(255);
  for (let y = 0; y < Math.min(canvas.height, height); y++) {
    const sourceStart = y * canvas.width * 4;
    padded.data.set(
      sourcePixels.data.subarray(sourceStart, sourceStart + Math.min(canvas.width, width) * 4),
      y * width * 4,
    );
  }
  const normalized = document.createElement('canvas');
  normalized.width = width;
  normalized.height = height;
  normalized.getContext('2d')!.putImageData(padded, 0, 0);

  const composited = document.createElement('canvas');
  composited.width = width;
  composited.height = height;
  const context = composited.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(normalized, 0, 0);
  return context.getImageData(0, 0, width, height);
}

/** Compare two canvases after putting transparent and missing pixels on white. */
export function compareCanvasPixels(
  reference: HTMLCanvasElement,
  actual: HTMLCanvasElement,
  threshold = 0.1,
): PixelComparisonResult {
  const width = Math.max(reference.width, actual.width);
  const height = Math.max(reference.height, actual.height);
  const referencePixels = pixelsOnWhite(reference, width, height);
  const actualPixels = pixelsOnWhite(actual, width, height);
  // No output buffer: pixelmatch writes a pixel for every UNCHANGED pixel too,
  // which costs more than the comparison itself. The count is identical either
  // way, so the diff image is rendered lazily for the few diagnostic callers.
  const mismatchedPixels = pixelmatch(
    referencePixels.data,
    actualPixels.data,
    null,
    width,
    height,
    { threshold },
  );
  let contentPixels = 0;
  for (let offset = 0; offset < referencePixels.data.length; offset += 4) {
    const referenceIsWhite =
      referencePixels.data[offset] === 255 &&
      referencePixels.data[offset + 1] === 255 &&
      referencePixels.data[offset + 2] === 255;
    const actualIsWhite =
      actualPixels.data[offset] === 255 &&
      actualPixels.data[offset + 1] === 255 &&
      actualPixels.data[offset + 2] === 255;
    if (!referenceIsWhite || !actualIsWhite) contentPixels++;
  }

  const totalPixels = width * height;
  return {
    mismatchedPixels,
    totalPixels,
    contentPixels,
    mismatchPercentage: (mismatchedPixels / totalPixels) * 100,
    contentMismatchPercentage:
      (mismatchedPixels / Math.max(contentPixels, 1)) * 100,
    get diffCanvas() {
      const diff = new ImageData(width, height);
      pixelmatch(
        referencePixels.data,
        actualPixels.data,
        diff.data,
        width,
        height,
        { threshold },
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.putImageData(diff, 0, 0);
      return canvas;
    },
  };
}

/**
 * Compare a supplied reference renderer with render-tag using pixelmatch.
 */
export type ReferenceRenderer = (
  html: string,
  css: string,
  width: number,
  height: number,
  pixelRatio?: number,
) => Promise<HTMLCanvasElement>;

export async function compareRendersWithReference(
  html: string,
  css: string,
  width: number,
  height: number,
  threshold = 0.1,
  pixelRatio = 1,
  renderReference: ReferenceRenderer,
  referenceWarmsInternally = false,
): Promise<ComparisonResult> {
  const fixtureCss = keepUsedFontFaces(css, html);
  // Register the complete fixture catalog in a stable order. The isolated
  // native page gets the pruned CSS below, but incrementally adding subsets to
  // the shared canvas document makes face selection depend on test-file order.
  await prepareComparisonFonts(html, css);

  // A reference renderer can resolve glyph paint lazily. One throwaway render
  // down each path keeps the measurement independent of which path happened
  // to paint first. Native screenshot commands warm internally.
  if (!referenceWarmsInternally) {
    await renderReference(html, fixtureCss, width, height, pixelRatio);
  }
  renderToCanvas(html, fixtureCss, width, height, pixelRatio);

  const domCanvas = await renderReference(html, fixtureCss, width, height, pixelRatio);
  const { canvas: libCanvas, lines: canvasLines } = renderToCanvas(
    html,
    fixtureCss,
    width,
    height,
    pixelRatio,
  );

  // Object.defineProperties, not a spread: spreading would evaluate the lazy
  // diffCanvas getter and re-introduce the per-case cost it exists to avoid.
  return Object.defineProperties(
    compareCanvasPixels(domCanvas, libCanvas, threshold) as ComparisonResult,
    {
      domCanvas: { value: domCanvas, enumerable: true },
      libCanvas: { value: libCanvas, enumerable: true },
      canvasLines: { value: canvasLines, enumerable: true },
    },
  );
}
