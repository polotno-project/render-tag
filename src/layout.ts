import type { StyledNode, LayoutNode, LayoutBox, LayoutText, ResolvedStyle, LayoutLine } from './types.js';

// Module-level flag controlling DOM measurement usage.
// Set by buildLayoutTree() based on the useDomMeasurements option.
let _useDomMeasurements = true;
let _debug: ((entry: import('./types.ts').DebugEntry) => void) | undefined;

// Lines emitted during layout. Reset at the start of buildLayoutTree();
// layoutInlineContent appends one entry per committed line.
let _lines: LayoutLine[] = [];

// ─── measureText width cache ──────────────────────────────────────────
// Caches ctx.measureText(text).width keyed by "font\0text".
// Cleared at the start of each buildLayoutTree() call.
const _measureCache = new Map<string, number>();

function cachedMeasureWidth(ctx: CanvasRenderingContext2D, text: string): number {
  // ctx.font and ctx.letterSpacing must already be set by caller.
  // letterSpacing is part of the key because it changes measured width.
  const key = ctx.font + '\0' + (ctx.letterSpacing || '') + '\0' + text;
  const cached = _measureCache.get(key);
  if (cached !== undefined) return cached;
  const w = ctx.measureText(text).width;
  _measureCache.set(key, w);
  return w;
}


/**
 * Check if a line has mixed fonts (different fontFamily/fontSize/fontWeight/fontStyle).
 */
function hasMixedFonts(words: Word[]): boolean {
  let font = '';
  for (const w of words) {
    if (!w.text || w.isSpace) continue;
    const f = buildCanvasFont(w.style);
    if (font && f !== font) return true;
    font = f;
  }
  return false;
}

// ─── Canvas font helpers ───────────────────────────────────────────────

/**
 * Set canvas font and kerning from resolved style.
 */
export function applyFont(ctx: CanvasRenderingContext2D, style: ResolvedStyle): void {
  ctx.font = buildCanvasFont(style);
  ctx.fontKerning = style.fontKerning === 'none' ? 'none' : 'normal';
}

/** Format a letter-spacing value (px) as a canvas `ctx.letterSpacing` string. */
function formatLetterSpacing(value: number): string {
  // Negative letter-spacing is valid and narrows text — Chrome applies it per
  // character (trailing included). Clamping it to 0 measured text wider than
  // the browser renders it, causing earlier/extra line wraps. Guard against
  // non-finite values (undefined/NaN), which would produce an invalid
  // "undefinedpx"/"NaNpx" string that canvas silently ignores.
  return Number.isFinite(value) && value !== 0 ? `${value}px` : '0px';
}

/**
 * Build a canvas font string from resolved style. Results are cached.
 */
const _fontStringCache = new Map<string, string>();
export function buildCanvasFont(style: ResolvedStyle): string {
  const key = `${style.fontStyle}|${style.fontVariantCaps}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}`;
  const cached = _fontStringCache.get(key);
  if (cached) return cached;
  const parts: string[] = [];
  // CSS font shorthand order: style, variant, weight, size, family.
  if (style.fontStyle !== 'normal') parts.push(style.fontStyle);
  if (style.fontVariantCaps === 'small-caps') parts.push('small-caps');
  if (style.fontWeight !== 400) parts.push(String(style.fontWeight));
  parts.push(`${style.fontSize}px`);
  parts.push(style.fontFamily);
  const result = parts.join(' ');
  _fontStringCache.set(key, result);
  return result;
}

/**
 * Cache for DOM-measured line heights.
 * Key: "font|lineHeight|probeType" → actual pixel height from the browser.
 */
const _lineHeightCache = new Map<string, number>();

// Probe elements: a <div> for general use, and a <ul><li> for unordered list items.
// Firefox renders <ul><li> with bullet markers (disc/circle/square) 1.5px taller
// than other elements for the same line-height, due to the ::marker pseudo-element.
// <ol><li> items do NOT have this extra height.
let _blockProbe: HTMLDivElement | null = null;
let _ulProbeContainer: HTMLUListElement | null = null;
let _ulProbeLi: HTMLLIElement | null = null;

const BULLET_MARKERS = new Set(['disc', 'circle', 'square']);

/**
 * Measure the actual line height using a hidden DOM element.
 * Uses an actual <li> inside a <ul> when listStyleType is a bullet marker
 * (disc/circle/square) to capture Firefox's ::marker line box contribution.
 * Results are cached per font+lineHeight+probeType combination.
 */
function measureDomLineHeight(font: string, lineHeight: string, useBulletProbe = false): number {
  const key = `${font}|${lineHeight}|${useBulletProbe ? 'ul-li' : 'block'}`;
  const cached = _lineHeightCache.get(key);
  if (cached !== undefined) return cached;

  if (typeof document === 'undefined' || !document.body) {
    throw new Error(
      "render-tag: accuracy 'balanced' requires a browser DOM for line-height probes; use the default 'performance' mode in non-browser environments."
    );
  }

  let probe: HTMLElement;
  if (useBulletProbe) {
    if (!_ulProbeContainer) {
      _ulProbeContainer = document.createElement('ul');
      _ulProbeContainer.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;visibility:hidden;padding:0;margin:0;border:0;list-style:disc;';
      _ulProbeLi = document.createElement('li');
      _ulProbeLi.style.cssText = 'white-space:nowrap;padding:0;margin:0;border:0;';
      _ulProbeLi.textContent = 'Mg';
      _ulProbeContainer.appendChild(_ulProbeLi);
      document.body.appendChild(_ulProbeContainer);
    }
    probe = _ulProbeLi!;
  } else {
    if (!_blockProbe) {
      _blockProbe = document.createElement('div');
      _blockProbe.style.cssText =
        'position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;padding:0;margin:0;border:0;';
      _blockProbe.textContent = 'Mg';
      document.body.appendChild(_blockProbe);
    }
    probe = _blockProbe;
  }

  probe.style.font = font;
  probe.style.lineHeight = lineHeight;
  const height = probe.getBoundingClientRect().height;

  _lineHeightCache.set(key, height);
  return height;
}

/**
 * Get the effective line height for a style.
 * Uses DOM measurement for accuracy across browsers (Firefox vs Chrome).
 * Falls back to canvas metrics for "normal" line-height.
 */
function getLineHeight(ctx: CanvasRenderingContext2D, style: ResolvedStyle, useBulletProbe = false): number {
  if (style.lineHeight > 0) {
    if (_useDomMeasurements) {
      const font = buildCanvasFont(style);
      return measureDomLineHeight(font, `${style.lineHeight}px`, useBulletProbe);
    }
    // Canvas-only: use the CSS line-height value directly
    return style.lineHeight;
  }

  if (_useDomMeasurements) {
    const font = buildCanvasFont(style);
    return measureDomLineHeight(font, 'normal', useBulletProbe);
  }

  // Canvas-only fallback for "normal" line-height: use font bounding box
  // fontBoundingBoxAscent + fontBoundingBoxDescent already represents the
  // full line box height, no multiplier needed.
  const { ascent, descent } = getFontMetrics(ctx, style);
  return ascent + descent;
}

/**
 * Compute the baseline Y offset within a line.
 * Uses the Konva approach: center (ascent - descent) within lineHeight.
 */
function computeBaselineY(ctx: CanvasRenderingContext2D, style: ResolvedStyle, lineHeight: number): number {
  const { ascent, descent } = getFontMetrics(ctx, style);
  return (ascent - descent) / 2 + lineHeight / 2;
}

function applyTextTransform(text: string, transform: string): string {

  switch (transform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    // Capitalize the first letter of each word. A mid-word apostrophe is NOT a
    // word boundary (UAX#29), so "o'clock" → "O'clock", not "O'Clock".
    case 'capitalize': return text.replace(/(^|[\s\p{P}])(\p{L})/gu, (m, p, c) =>
      p === "'" || p === '’' ? m : p + c.toUpperCase());
    default: return text;
  }
}

function isInline(node: StyledNode): boolean {
  if (node.tagName === '#text') return true;
  const d = node.style.display;
  return d === 'inline' || d === 'inline-block';
}

function hasOnlyInlineChildren(node: StyledNode): boolean {
  return node.children.length > 0 && node.children.every(isInline);
}

export function isTransparent(color: string): boolean {
  return !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
}

/**
 * Get font ascent and descent metrics. Results are cached per font string.
 */
const _fontMetricsCache = new Map<string, { ascent: number; descent: number }>();
export function getFontMetrics(ctx: CanvasRenderingContext2D, style: ResolvedStyle): { ascent: number; descent: number } {
  const font = buildCanvasFont(style);
  const cached = _fontMetricsCache.get(font);
  if (cached) return cached;
  ctx.font = font;
  const m = ctx.measureText('M');
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  const result = { ascent, descent };
  _fontMetricsCache.set(font, result);
  return result;
}

/**
 * Baseline shift (canvas pixels, positive = downward) for a vertical-align
 * value, applied on top of the line baseline. Returns 0 for 'baseline' and for
 * the line-box-relative keywords 'top'/'bottom' — those need a second layout
 * pass (the box position depends on the final line box it helps size), so they
 * fall back to baseline rather than being approximated wrongly.
 *
 *  - super/sub        legacy fixed fractions of the parent font size
 *  - text-top/-bottom align the box's ascent/descent edge with the line's
 *  - middle           box midpoint at parent baseline + half the x-height
 *  - <length>/<%>     raise (positive value) by the length / % of line-height
 */
function verticalAlignShift(
  va: string,
  wAscent: number, wDescent: number,
  parentFontSize: number, maxAscent: number, maxDescent: number,
  lineHeight: number,
): number {
  switch (va) {
    case 'super': return -parentFontSize * 0.4;
    case 'sub': return parentFontSize * 0.26;
    case 'text-top': return -(maxAscent - wAscent);
    case 'text-bottom': return maxDescent - wDescent;
    case 'middle': return -(parentFontSize * 0.25) - (wDescent - wAscent) / 2;
    default: {
      // baseline / top / bottom / '' all parseFloat to NaN → 0 (callers gate
      // on isShiftedVAlign, so those never actually reach here).
      const n = parseFloat(va);
      if (!Number.isFinite(n)) return 0;
      return va.endsWith('%') ? -(n / 100) * lineHeight : -n;
    }
  }
}

/** True when a vertical-align value moves content off the baseline. */
function isShiftedVAlign(va: string): boolean {
  return va !== 'baseline' && va !== 'top' && va !== 'bottom' && va !== '';
}

/** Same decoration set: entries must match pairwise (line, color, style) so
 * runs whose decorations differ only in color/style don't merge and paint
 * with the wrong one. */
function sameDecorations(a: ResolvedStyle, b: ResolvedStyle): boolean {
  const da = a.textDecorations, db = b.textDecorations;
  if (da === db) return true;
  if (!da || !db || da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) {
    if (
      da[i].line !== db[i].line ||
      da[i].color !== db[i].color ||
      da[i].style !== db[i].style
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Check if two styles have the same text rendering properties.
 */
function sameTextStyle(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.textDecorationLine === b.textDecorationLine &&
    sameDecorations(a, b) &&
    a.backgroundColor === b.backgroundColor;
}

function hasVisibleBoxStyles(style: ResolvedStyle): boolean {
  if (!isTransparent(style.backgroundColor)) return true;
  if (style.borderTopWidth > 0 && style.borderTopStyle !== 'none') return true;
  if (style.borderRightWidth > 0 && style.borderRightStyle !== 'none') return true;
  if (style.borderBottomWidth > 0 && style.borderBottomStyle !== 'none') return true;
  if (style.borderLeftWidth > 0 && style.borderLeftStyle !== 'none') return true;
  return false;
}

/** True for an element declaring `background-clip:text` with a visible
 * background (gradient image or solid color) — the fill/decorations of every
 * glyph it covers must sample that background instead of painting it as a box. */
export function hasTextClip(style: ResolvedStyle): boolean {
  return style.webkitBackgroundClip === 'text' &&
    ((!!style.backgroundImage && style.backgroundImage !== 'none') ||
      !isTransparent(style.backgroundColor));
}

// ─── Inline text run types ─────────────────────────────────────────────

interface TextRun {
  text: string;
  style: ResolvedStyle;
  /** If this run came from an inline element with visible box styles */
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box */
  boxClose?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
}

interface Word {
  text: string;
  width: number;
  style: ResolvedStyle;
  isSpace: boolean;
  /** Tab character — width computed dynamically based on position */
  isTab?: boolean;
  /** Word came from soft-hyphen split — show '-' if this word ends a line */
  isSoftHyphenBreak?: boolean;
  /**
   * No soft-wrap opportunity before this word: it abuts the previous word with
   * no whitespace (e.g. adjacent inline spans `<span>a</span><span>b</span>`),
   * so the browser treats them as one unbreakable unit at that boundary.
   */
  noBreakBefore?: boolean;
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box (adds left padding/border) */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box (adds right padding/border) */
  boxClose?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring background-clip:text + background */
  clipStyle?: ResolvedStyle;
  /** Nearest inline ancestor-or-self declaring --rt-text-stroke-image */
  strokeImageStyle?: ResolvedStyle;
}

interface PositionedLine {
  words: Word[];
  totalWidth: number;
  lineHeight: number;
  /** True if this line ends at a forced break (\n or <br>). Such a line is
   *  treated as a "last line" for text-align — never justified. */
  endedByHardBreak?: boolean;
}

/** True for atomic inline-block words (boxOpen && boxClose && text together). */
function isAtomicInlineBlock(w: Word): boolean {
  return !!(w.boxOpen && w.boxClose && w.text);
}

/**
 * Truncate a PositionedLine's trailing words and append "…" so the line
 * fits within maxWidth. Used by `-webkit-line-clamp` to mark the visible
 * cut-off on the Nth line.
 *
 * Trim strategy:
 *  1. Pick the style of the last NON-empty, NON-atomic-inline-block word
 *     — so the ellipsis font matches the surrounding text, not the button
 *     or pill it was sitting next to.
 *  2. Drop trailing isSpace words (genuine spaces only — box markers carry
 *     padding/border that we must keep).
 *  3. Back-trim: pop trailing non-space words until ellipsis fits. If we
 *     end up with a single text word that STILL doesn't fit, pop it too —
 *     the ellipsis stands alone rather than overflowing the container.
 *     Box-open markers earlier on the line stay; they preserve inline-box
 *     padding/border that the emit loop needs.
 *  4. Inherit boxStyle from the trailing context so inline `<span>`
 *     backgrounds/borders extend across the ellipsis.
 */
function applyEllipsisToLine(
  ctx: CanvasRenderingContext2D,
  line: PositionedLine,
  maxWidth: number,
): void {
  // 1. Find the last word whose style should drive the ellipsis.
  //    Skip empty-text markers AND atomic inline-blocks (their style is
  //    the inline-block element's, not the surrounding text).
  let styleIdx = line.words.length - 1;
  while (
    styleIdx >= 0 &&
    (line.words[styleIdx].text === '' || isAtomicInlineBlock(line.words[styleIdx]))
  ) styleIdx--;
  if (styleIdx < 0) return;
  const lastStyle = line.words[styleIdx].style;
  const boxStyle = line.words[styleIdx].boxStyle;
  applyFont(ctx, lastStyle);
  // ALWAYS assign (don't gate on truthy) — otherwise a previous segment's
  // non-zero letter-spacing leaks into the ellipsis measurement.
  ctx.letterSpacing = `${lastStyle.letterSpacing || 0}px` as any;
  const ellipsisWidth = cachedMeasureWidth(ctx, '…');

  // Helper: pop trailing isSpace words. Box markers (text === '' with
  // boxOpen/boxClose) are NOT popped — they carry inline-box padding the
  // emit loop relies on.
  const popTrailingSpaces = () => {
    while (
      line.words.length > 0 &&
      line.words[line.words.length - 1].isSpace
    ) {
      const r = line.words.pop()!;
      line.totalWidth -= r.width;
    }
  };

  // 2. Strip purely trailing whitespace.
  popTrailingSpaces();

  // 3. Back-trim non-space text words until the ellipsis fits.
  //    Atomic inline-blocks are non-space too; they pop along with words.
  const isTrimmableText = (w: Word) =>
    !w.isSpace && w.text !== '' && !w.boxOpen && !w.boxClose;
  while (
    line.totalWidth + ellipsisWidth > maxWidth &&
    line.words.length > 0
  ) {
    const last = line.words[line.words.length - 1];
    if (!isTrimmableText(last) && !isAtomicInlineBlock(last)) break;
    line.totalWidth -= last.width;
    line.words.pop();
    popTrailingSpaces();
  }

  // 4. Append the ellipsis. Inherit boxStyle so inline-span backgrounds /
  //    borders extend over the ellipsis.
  const ellipsisWord: Word = {
    text: '…',
    width: ellipsisWidth,
    style: lastStyle,
    isSpace: false,
    boxStyle,
  };
  line.words.push(ellipsisWord);
  line.totalWidth += ellipsisWidth;
}

// ─── Inline layout ─────────────────────────────────────────────────────

/**
 * Collect text runs from inline children, preserving style and tracking
 * inline elements with visible backgrounds. Emits open/close markers
 * for inline boxes so padding/border can be applied.
 */
function collectTextRuns(node: StyledNode): TextRun[] {
  const runs: TextRun[] = [];

  function walk(
    n: StyledNode,
    boxStyle?: ResolvedStyle,
    clipStyle?: ResolvedStyle,
    strokeImageStyle?: ResolvedStyle,
  ) {
    if (n.tagName === '#text' && n.textContent) {
      runs.push({ text: n.textContent, style: n.style, boxStyle, clipStyle, strokeImageStyle });
      return;
    }
    const isInlineBlock = n.style.display === 'inline-block';
    // Inline-block always needs box treatment (padding/margin affect layout)
    const isBox = isInlineBlock || (isInline(n) && hasVisibleBoxStyles(n.style));
    const newBoxStyle = isBox ? n.style : boxStyle;
    // Track the nearest inline element declaring a background-clip:text
    // background or a --rt-text-stroke-image, so those paints reach descendant
    // runs that don't carry the (non-inheriting) properties themselves.
    const newClipStyle = isInline(n) && hasTextClip(n.style) ? n.style : clipStyle;
    const newStrokeImageStyle =
      isInline(n) && n.style.webkitTextStrokeImage && n.style.webkitTextStrokeImage !== 'none'
        ? n.style : strokeImageStyle;
    const hasHorizSpacing = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    if (isInlineBlock) {
      // Inline-block is fully atomic — the entire element (margins + padding + text)
      // wraps as one unit. We emit a single "atomic" TextRun with a special marker
      // so the tokenizer creates one non-splittable word with the full box width.
      const allText = n.element?.textContent || '';
      runs.push({
        text: allText,
        style: n.style,
        boxStyle: newBoxStyle,
        clipStyle: newClipStyle,
        strokeImageStyle: newStrokeImageStyle,
        // Store the full box info for atomic inline-block handling
        boxOpen: n.style,  // signals this is a boxed element
        boxClose: n.style,
      });
      return;
    }

    // unicode-bidi: bidi-override (e.g. <bdo dir="rtl">) forces visual order.
    // For an RTL override, reverse both the characters of each descendant run
    // and the order of the runs, so the subtree renders right-to-left.
    const ub = n.style.unicodeBidi;
    const overrideRtl = (ub === 'bidi-override' || ub === 'isolate-override') &&
      n.style.direction === 'rtl';
    const overrideStart = runs.length;

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style });
    }

    for (const child of n.children) {
      walk(child, isBox ? newBoxStyle : boxStyle, newClipStyle, newStrokeImageStyle);
    }

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style });
    }

    if (overrideRtl && runs.length > overrideStart) {
      const seg = runs.splice(overrideStart);
      for (const r of seg) {
        if (r.text) {
          r.text = [...r.text].reverse().join('');
          // The glyphs are now in visual (reversed) order, so render them
          // left-to-right; otherwise renderText would right-anchor x and the
          // LTR emission (which set x as the left edge) would misposition them.
          r.style = { ...r.style, direction: 'ltr' };
        }
      }
      seg.reverse();
      runs.push(...seg);
    }
  }

  for (const child of node.children) {
    walk(child);
  }
  return runs;
}

/**
 * Check if text needs Intl.Segmenter for word breaking (Thai, Khmer, Lao, Myanmar).
 * These scripts don't use spaces between words.
 */
function needsSegmenter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (
      (code >= 0x0E00 && code <= 0x0E7F) ||  // Thai
      (code >= 0x0E80 && code <= 0x0EFF) ||  // Lao
      (code >= 0x1000 && code <= 0x109F) ||  // Myanmar
      (code >= 0x1780 && code <= 0x17FF)     // Khmer
    ) return true;
    if (code > 0xFFFF) i++; // skip surrogate pair
  }
  return false;
}

let _segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter) return _segmenter;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return _segmenter;
  }
  return null;
}

/**
 * Tokenize a single string into words based on whitespace mode.
 */
function tokenizeString(ctx: CanvasRenderingContext2D, text: string, run: TextRun, allWords: Word[], cumState?: { cumText: string; cumWidth: number }): void {
  // Split on zero-width spaces and soft hyphens (break opportunities).
  // Pass cumulative state through so pieces are measured as one text run
  // (preserving kerning accuracy across break points).
  if (text.includes('\u200B') || text.includes('\u00AD')) {
    const parts = text.split(/(\u200B|\u00AD)/);
    // Share cumulative state across all sub-parts for accurate measurement
    const sharedState = cumState ?? { cumText: '', cumWidth: 0 };
    let nextIsSoftHyphen = false;
    for (const part of parts) {
      if (part === '\u00AD') {
        nextIsSoftHyphen = true;
        continue;
      }
      if (part === '\u200B' || part === '') {
        nextIsSoftHyphen = false;
        continue;
      }
      const prevLen = allWords.length;
      tokenizeString(ctx, part, run, allWords, sharedState);
      if (nextIsSoftHyphen && prevLen > 0) {
        allWords[prevLen - 1].isSoftHyphenBreak = true;
      }
      nextIsSoftHyphen = false;
    }
    if (nextIsSoftHyphen && allWords.length > 0) {
      allWords[allWords.length - 1].isSoftHyphenBreak = true;
    }
    return;
  }

  // `pre-line` preserves newlines (handled by the \n pre-split in
  // tokenizeRuns) but collapses spaces and tabs — so it goes through the
  // non-preserving branch below, same as `normal`.
  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'break-spaces';

  if (isPreserve) {
    // Split on spaces and tabs, keeping delimiters
    const words = text.split(/( +|\t)/);
    const tabStopInterval = cachedMeasureWidth(ctx, ' ') * 8; // CSS default: 8 spaces
    for (const w of words) {
      if (w === '') continue;
      if (w === '\t') {
        // Tab width depends on current position — mark it for dynamic calculation
        allWords.push({
          text: '\t',
          width: tabStopInterval, // placeholder — recalculated in flowWordsIntoLines
          style: run.style,
          isSpace: true,
          isTab: true,
          boxStyle: run.boxStyle,
          clipStyle: run.clipStyle,
          strokeImageStyle: run.strokeImageStyle,
        });
        continue;
      }
      const isSpace = /^ +$/.test(w);
      allWords.push({
        text: w,
        width: cachedMeasureWidth(ctx, w),
        style: run.style,
        isSpace,
        boxStyle: run.boxStyle,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
      });
    }
  } else {
    // Split on whitespace but NOT on non-breaking spaces (\u00A0).
    // Then add a break opportunity AFTER "?" inside an otherwise-unbreakable
    // token (the URL query delimiter): Chrome wraps "\u2026/q3?" | "lang=ar&\u2026"
    // even with overflow-wrap:normal. It does NOT break at "/", "&", "=", "."
    // or ":" (verified against the browser), so only "?" is split here. The
    // "?" stays with the preceding fragment; a trailing "?" (no follower) is
    // left intact. Fragments measure cumulatively so kerning stays accurate.
    const words = text
      .split(/([ \t\n\r\f\v]+)/)
      .flatMap((w) =>
        /^[ \t\n\r\f\v]+$/.test(w) ? [w] : w.split(/(?<=\?)(?=.)/),
      );

    // Use cumulative measurement to avoid rounding error accumulation
    // within a single text run. When cumState is provided (from \u200B/\u00AD
    // split), continue from the previous cumulative position to preserve
    // kerning accuracy across break points.
    let cumText = cumState?.cumText ?? '';
    let cumWidth = cumState?.cumWidth ?? 0;

    for (const w of words) {
      if (w === '') continue;
      const isSpace = /^[ \t\n\r\f\v]+$/.test(w);

      if (isSpace) {
        const prevCum = cumWidth;
        cumText += ' ';
        cumWidth = ctx.measureText(cumText).width;
        const spaceWidth = cumWidth - prevCum + (run.style.wordSpacing || 0);
        allWords.push({
          text: ' ',
          width: spaceWidth,
          style: run.style,
          isSpace: true,
          boxStyle: run.boxStyle,
          clipStyle: run.clipStyle,
          strokeImageStyle: run.strokeImageStyle,
        });
        continue;
      }

      // Use Intl.Segmenter for scripts without spaces (Thai, Khmer, etc.)
      if (needsSegmenter(w)) {
        const segmenter = getSegmenter();
        if (segmenter) {
          for (const seg of segmenter.segment(w)) {
            const s = seg.segment;
            const prevCum = cumWidth;
            cumText += s;
            cumWidth = ctx.measureText(cumText).width;
            allWords.push({
              text: s,
              width: cumWidth - prevCum,
              style: run.style,
              isSpace: false,
              boxStyle: run.boxStyle,
              clipStyle: run.clipStyle,
              strokeImageStyle: run.strokeImageStyle,
            });
          }
          continue;
        }
      }

      const prevCum = cumWidth;
      cumText += w;
      cumWidth = ctx.measureText(cumText).width;
      let width = cumWidth - prevCum;
      const directWidth = cachedMeasureWidth(ctx, w);
      if (_debug) {
        _debug({
          type: 'measure-word',
          message: `"${w}" delta=${width.toFixed(2)} direct=${directWidth.toFixed(2)} diff=${(width - directWidth).toFixed(2)} cumText="${cumText}"`,
          data: { text: w, deltaWidth: width, directWidth, cumWidth, prevCum, font: run.style.fontFamily, fontSize: run.style.fontSize },
        });
      }
      allWords.push({
        text: w,
        width,
        style: run.style,
        isSpace: false,
        boxStyle: run.boxStyle,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
      });
    }

    // Propagate cumulative state back to caller (for \u200B/\u00AD splits)
    if (cumState) {
      cumState.cumText = cumText;
      cumState.cumWidth = cumWidth;
    }
  }
}

/**
 * Tokenize text runs into words for line wrapping.
 */
function tokenizeRuns(ctx: CanvasRenderingContext2D, runs: TextRun[]): Word[] {
  const allWords: Word[] = [];

  for (const run of runs) {
    // Handle inline-block margins (empty text, no boxOpen/boxClose)
    if (run.text === '' && !run.boxOpen && !run.boxClose) {
      const margin = run.style.display === 'inline-block'
        ? (run.style.marginLeft || run.style.marginRight || 0)
        : 0;
      if (margin > 0) {
        allWords.push({ text: '', width: margin, style: run.style, isSpace: false, boxStyle: run.boxStyle });
      }
      continue;
    }

    // Atomic inline-block: entire element (margin + padding + text) is one word
    // Must check before boxOpen/boxClose handlers since atomic has both set.
    if (run.boxOpen && run.boxClose && run.text) {
      applyFont(ctx, run.style);
      ctx.letterSpacing = formatLetterSpacing(run.style.letterSpacing);
      const text = applyTextTransform(run.text, run.style.textTransform);
      const s = run.style;
      const textWidth = cachedMeasureWidth(ctx, text);
      const totalWidth = s.marginLeft + s.borderLeftWidth + s.paddingLeft +
        textWidth + s.paddingRight + s.borderRightWidth + s.marginRight;
      allWords.push({
        text,
        width: totalWidth,
        style: run.style,
        isSpace: false,
        boxStyle: run.boxStyle,
        boxOpen: run.boxOpen,
        boxClose: run.boxClose,
        clipStyle: run.clipStyle,
        strokeImageStyle: run.strokeImageStyle,
      });
      continue;
    }

    // Handle inline box open/close markers (padding)
    if (run.boxOpen) {
      const pad = run.boxOpen.paddingLeft + run.boxOpen.borderLeftWidth;
      if (pad > 0) {
        allWords.push({ text: '', width: pad, style: run.style, isSpace: false, boxStyle: run.boxStyle, boxOpen: run.boxOpen });
      }
      continue;
    }
    if (run.boxClose) {
      const pad = run.boxClose.paddingRight + run.boxClose.borderRightWidth;
      if (pad > 0) {
        allWords.push({ text: '', width: pad, style: run.style, isSpace: false, boxStyle: run.boxStyle, boxClose: run.boxClose });
      }
      continue;
    }

    applyFont(ctx, run.style);
    ctx.letterSpacing = formatLetterSpacing(run.style.letterSpacing);
    const text = applyTextTransform(run.text, run.style.textTransform);

    // Mark the first word produced from `startLen` as having no soft-wrap
    // opportunity before it when it directly abuts real text from a previous
    // run (adjacent inline elements with no whitespace between them). The
    // preceding word must be actual text — not a space, newline, empty
    // box-padding marker, or box edge — so a whitespace/padding boundary still
    // allows a break.
    const markGlue = (startLen: number) => {
      const first = allWords[startLen];
      if (!first || first.isSpace || !first.text || first.text === '\n') return;
      const prev = allWords[startLen - 1];
      if (
        !prev || prev.isSpace || !prev.text.trim() ||
        prev.boxOpen || prev.boxClose
      ) return;
      // CJK and segmenter-driven scripts (Thai/Khmer/…) have break
      // opportunities between characters regardless of element boundaries, so
      // an element edge between them is NOT a no-break point. Only glue when
      // both sides are ordinary (Latin-like) text with no intrinsic break.
      const firstChar = [...first.text][0];
      const prevChar = [...prev.text][prev.text.length - 1];
      if (
        isCJK(firstChar) || isCJK(prevChar) ||
        needsSegmenter(first.text) || needsSegmenter(prev.text)
      ) return;
      first.noBreakBefore = true;
    };

    // Handle explicit newlines (from <br> or pre-wrap) — always force line break
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          allWords.push({ text: '\n', width: 0, style: run.style, isSpace: false, boxStyle: run.boxStyle });
        }
        if (parts[i]) {
          const startLen = allWords.length;
          tokenizeString(ctx, parts[i], run, allWords);
          markGlue(startLen);
        }
      }
    } else {
      const startLen = allWords.length;
      tokenizeString(ctx, text, run, allWords);
      markGlue(startLen);
    }
  }

  return allWords;
}

/**
 * Check if a character is CJK (Chinese/Japanese/Korean) — these wrap at character level.
 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0) || 0;
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
    (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols
    (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
    (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul
    (code >= 0xFF00 && code <= 0xFFEF) ||   // Fullwidth
    (code >= 0x20000 && code <= 0x2A6DF)    // CJK Extension B
  );
}

let _graphemeSegmenter: Intl.Segmenter | undefined;
function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (_graphemeSegmenter) return _graphemeSegmenter;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    _graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return _graphemeSegmenter;
  }
  return null;
}

const EMOJI_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/**
 * Is this grapheme cluster an emoji that creates a line-break opportunity?
 * Restricted to emoji-presentation clusters (emoji planes, regional-indicator
 * flags, and ZWJ/VS16 sequences) so plain text symbols like ©/®/™ — which are
 * Extended_Pictographic but render as text and do NOT break — are excluded.
 */
function isEmojiCluster(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f000) return true; // emoji planes (incl. regional indicators)
  }
  if (s.includes('\u200D') || s.includes('\uFE0F')) {
    return EMOJI_PICTOGRAPHIC.test(s); // ZWJ sequence or VS16 emoji presentation
  }
  return false;
}

/**
 * Break a word into character-level pieces if it contains CJK/emoji or if
 * overflow-wrap: break-word is set and the word is too wide.
 */
function breakWordIfNeeded(
  ctx: CanvasRenderingContext2D,
  word: Word,
  contentWidth: number,
  currentLineWidth: number,
): Word[] {
  // Check if word has CJK characters — always break at character level
  const hasCJK = [...word.text].some(isCJK);

  // Emoji form their own break opportunities (a run of emoji wraps between
  // clusters). Only meaningful when a grapheme segmenter is available so ZWJ
  // sequences / skin-tone / flag pairs stay intact.
  const hasEmoji = EMOJI_PICTOGRAPHIC.test(word.text) && !!getGraphemeSegmenter();

  // Check if word needs break-word splitting — when it won't fit on a fresh line
  const needsBreak = word.width > contentWidth &&
    (word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all');

  if (!hasCJK && !hasEmoji && !needsBreak) return [word];

  // overflow-wrap:break-word is a LAST RESORT — the browser first uses any
  // normal break opportunity inside the word (a hyphen) before breaking
  // mid-character. So split a hyphenated word at its hyphens first and only
  // char-break the segments that are themselves still too wide. (word-break:
  // break-all genuinely allows breaking between any two characters, so it
  // skips this and falls through to the char loop below.)
  if (needsBreak && word.style.wordBreak !== 'break-all' &&
      word.style.overflowWrap === 'break-word') {
    const segTexts = word.text.split(/(?<=-)(?!\d)|(?<=[^\d]-)/).filter((s) => s.length);
    if (segTexts.length > 1) {
      ctx.font = buildCanvasFont(word.style);
      ctx.letterSpacing = formatLetterSpacing(word.style.letterSpacing);
      const out: Word[] = [];
      for (const segText of segTexts) {
        const segWidth = cachedMeasureWidth(ctx, segText);
        if (segWidth <= contentWidth) {
          out.push({ ...word, text: segText, width: segWidth });
        } else {
          // Segment still overflows — char-break just this segment.
          out.push(...breakWordIfNeeded(ctx, { ...word, text: segText, width: segWidth }, contentWidth, 0));
        }
      }
      return out;
    }
  }

  // Split into characters using cumulative measurement for accuracy.
  // Measuring each char individually ignores kerning — the sum of individual
  // widths diverges from the true string width over many characters.
  ctx.font = buildCanvasFont(word.style);
  // Re-assert letter-spacing: tokenizeRuns may have left ctx at a later run's
  // value, but break points must use THIS word's letter-spacing.
  ctx.letterSpacing = formatLetterSpacing(word.style.letterSpacing);
  // When the word contains emoji, iterate by GRAPHEME cluster so multi-codepoint
  // emoji (ZWJ families, skin tones, flags) are never split mid-cluster.
  const seg = hasEmoji ? getGraphemeSegmenter() : null;
  const chars = seg
    ? [...seg.segment(word.text)].map((s) => s.segment)
    : [...word.text];
  const pieces: Word[] = [];

  let current = '';
  let currentWidth = 0;

  for (const char of chars) {
    // Emoji clusters each get their own word — a break opportunity between
    // adjacent emoji, matching the browser line breaker.
    if (hasEmoji && isEmojiCluster(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      pieces.push({ ...word, text: char, width: cachedMeasureWidth(ctx, char) });
      continue;
    }

    // CJK chars always get their own word for wrapping
    if (isCJK(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      const charWidth = cachedMeasureWidth(ctx, char);
      pieces.push({ ...word, text: char, width: charWidth });
      continue;
    }

    // Use cumulative measurement: measure the growing string, not individual chars
    const candidateText = current + char;
    const candidateWidth = cachedMeasureWidth(ctx, candidateText);

    // For break-word: break when adding this char would exceed container
    if (needsBreak && candidateWidth > contentWidth && current) {
      pieces.push({ ...word, text: current, width: currentWidth });
      current = char;
      currentWidth = cachedMeasureWidth(ctx, char);
      continue;
    }

    current = candidateText;
    currentWidth = candidateWidth;
  }

  if (current) {
    pieces.push({ ...word, text: current, width: currentWidth });
  }

  return pieces;
}

/** Punctuation that cannot start a line — stays with the preceding word. */
const TRAILING_PUNCT = /^[,.\;:!?\)\]\}'"»›]+$/;

/**
 * Flow words into lines that fit within contentWidth.
 * Handles: word wrapping, nowrap, break-word, CJK character wrapping.
 */
function flowWordsIntoLines(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  contentWidth: number,
  whiteSpace: string,
  useBulletProbe = false,
  textIndent = 0,
  tabMetrics?: { interval: number; halfSpace: number },
): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let currentLine: PositionedLine = { words: [], totalWidth: 0, lineHeight: 0 };
  const noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
  // text-indent reduces the first line's width budget; subsequent lines use full width.
  const effWidth = () => contentWidth - (lines.length === 0 ? textIndent : 0);

  const isPreWrap = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';
  // `pre`, `pre-wrap`, and `break-spaces` preserve author whitespace
  // (leading and trailing); the others collapse it.
  const preservesWhitespace =
    whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';

  function pushLine(isSoftWrap = false) {
    const hadWords = currentLine.words.length > 0;
    // Trim trailing spaces. `break-spaces` preserves them even at soft wraps;
    // `pre`/`pre-wrap` preserve them at hard breaks and end-of-content but not
    // at soft wraps (per CSS Text 3 §4.1.1).
    const preserveTrailing = whiteSpace === 'break-spaces'
      || (preservesWhitespace && !isSoftWrap);
    if (!preserveTrailing) {
      while (currentLine.words.length > 0 && currentLine.words[currentLine.words.length - 1].isSpace) {
        currentLine.totalWidth -= currentLine.words[currentLine.words.length - 1].width;
        currentLine.words.pop();
      }
    }
    // Soft hyphen: if this is a soft wrap and the last word has a soft-hyphen
    // break, append a visible '-' since the word is being broken here.
    if (isSoftWrap && currentLine.words.length > 0) {
      const lastWord = currentLine.words[currentLine.words.length - 1];
      if (lastWord.isSoftHyphenBreak) {
        applyFont(ctx, lastWord.style);
        const hyphenWidth = cachedMeasureWidth(ctx, '-');
        currentLine.words.push({
          text: '-',
          width: hyphenWidth,
          style: lastWord.style,
          isSpace: false,
        });
        currentLine.totalWidth += hyphenWidth;
      }
    }
    // In pre-wrap mode, space-only lines still need height (they are content)
    if (currentLine.words.length > 0 || (hadWords && isPreWrap)) {
      if (_debug) {
        const text = currentLine.words.map(w => w.text).join('');
        _debug({
          type: 'line-commit',
          message: `Line ${lines.length}: "${text}" width=${currentLine.totalWidth.toFixed(2)} / ${contentWidth}`,
          data: { lineIndex: lines.length, text, totalWidth: currentLine.totalWidth, contentWidth },
        });
      }
      lines.push(currentLine);
    }
    currentLine = { words: [], totalWidth: 0, lineHeight: 0 };
  }

  let afterHardBreak = true; // start of content is like after a hard break

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex];
    let wordLineHeight = getLineHeight(ctx, word.style, useBulletProbe);
    // Inline-block elements expand line height with their vertical padding+margin
    if (word.boxStyle && word.boxStyle.display === 'inline-block') {
      const bs = word.boxStyle;
      wordLineHeight = Math.max(wordLineHeight,
        wordLineHeight + bs.paddingTop + bs.paddingBottom + bs.marginTop + bs.marginBottom
        + bs.borderTopWidth + bs.borderBottomWidth);
    }

    if (word.text === '\n') {
      if (currentLine.words.length === 0) {
        currentLine.lineHeight = wordLineHeight;
        currentLine.endedByHardBreak = true;
        lines.push(currentLine);
        currentLine = { words: [], totalWidth: 0, lineHeight: 0 };
      } else {
        currentLine.endedByHardBreak = true;
        pushLine();
      }
      afterHardBreak = true;
      continue;
    }

    // No wrapping mode — everything on one line
    if (noWrap) {
      currentLine.words.push(word);
      currentLine.totalWidth += word.width;
      currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
      continue;
    }

    // Breaking a word that is split across a run boundary. A single word split
    // across adjacent inline runs (e.g. <span>E</span>xperience, a font-size
    // change mid-word, or <span>wel</span>l-being) is several Words glued by
    // `noBreakBefore`. Per-word break logic can't see the whole word, so its
    // internal break opportunities — hyphens, and break-word char points — are
    // lost and the unit overflows the edge. Detect the maximal glued chain
    // starting here and break it across the run boundaries like the browser.
    if (!word.isSpace && word.text && !word.noBreakBefore && !word.boxOpen && !word.boxClose) {
      let end = wordIndex;
      while (end + 1 < words.length) {
        const nx = words[end + 1];
        if (!nx.text || nx.isSpace || nx.boxOpen || nx.boxClose || !nx.noBreakBefore) break;
        end++;
      }
      if (end > wordIndex) {
        const breakWord = word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all';
        let combined = 0;
        for (let j = wordIndex; j <= end; j++) combined += words[j].width;
        // Flatten the chain into styled characters (per-run style retained).
        const cells: { ch: string; style: ResolvedStyle }[] = [];
        for (let j = wordIndex; j <= end; j++)
          for (const ch of [...words[j].text]) cells.push({ ch, style: words[j].style });
        const combinedText = cells.map((c) => c.ch).join('');
        // Hyphen break opportunities (same rule as the single-word hyphen path).
        const segTexts = combinedText.split(/(?<=-)(?!\d)|(?<=[^\d]-)/).filter((s) => s.length);
        const hyphenMode = segTexts.length > 1;
        const fitsLine = currentLine.totalWidth + combined <= effWidth();
        // A hyphen is an ordinary break opportunity — intervene whenever the
        // unit doesn't fit the remaining space. break-word is last-resort —
        // only when the unit can't fit a full line at all (otherwise the normal
        // flow + glued-tail fit check correctly wraps it whole to a fresh line).
        const enter = !fitsLine && (hyphenMode || (breakWord && combined > effWidth()));
        if (enter) {
          // Atomic units for breaking: hyphen segments, else the whole chain.
          const segs: { ch: string; style: ResolvedStyle }[][] = [];
          let ci = 0;
          for (const st of segTexts) {
            const len = [...st].length;
            segs.push(cells.slice(ci, ci + len));
            ci += len;
          }
          // Place a segment's cells onto the current line, splitting same-style
          // runs into pieces. When `chars` is set, wrap at the line edge between
          // characters (break-word); otherwise place atomically (it may overflow
          // its own line, e.g. a hyphen prefix wider than the container).
          const placeCells = (cs: { ch: string; style: ResolvedStyle }[], chars: boolean) => {
            let i = 0;
            while (i < cs.length) {
              const st = cs[i].style;
              applyFont(ctx, st);
              ctx.letterSpacing = formatLetterSpacing(st.letterSpacing);
              const lh = getLineHeight(ctx, st, useBulletProbe);
              const run: { ch: string; style: ResolvedStyle }[] = [];
              let cur = '';
              let curW = 0;
              while (i < cs.length && cs[i].style === st) {
                const ch = cs[i].ch;
                const candW = cachedMeasureWidth(ctx, cur + ch);
                if (chars && currentLine.totalWidth + candW > effWidth() &&
                    (currentLine.words.length > 0 || cur)) {
                  if (cur) {
                    currentLine.words.push({ text: cur, width: curW, style: st, isSpace: false });
                    currentLine.totalWidth += curW;
                    currentLine.lineHeight = Math.max(currentLine.lineHeight, lh);
                  }
                  pushLine(true);
                  afterHardBreak = false;
                  cur = ch;
                  curW = cachedMeasureWidth(ctx, ch);
                } else {
                  cur += ch;
                  curW = candW;
                }
                i++;
              }
              if (cur) {
                currentLine.words.push({ text: cur, width: curW, style: st, isSpace: false });
                currentLine.totalWidth += curW;
                currentLine.lineHeight = Math.max(currentLine.lineHeight, lh);
                afterHardBreak = false;
              }
            }
          };
          const measureSeg = (cs: { ch: string; style: ResolvedStyle }[]) => {
            let w = 0;
            let i = 0;
            while (i < cs.length) {
              const st = cs[i].style;
              let txt = '';
              while (i < cs.length && cs[i].style === st) { txt += cs[i].ch; i++; }
              applyFont(ctx, st);
              ctx.letterSpacing = formatLetterSpacing(st.letterSpacing);
              w += cachedMeasureWidth(ctx, txt);
            }
            return w;
          };
          // Pure break-word (no hyphen) is last-resort: move the whole word to a
          // fresh line first (using the preceding space), then break it there.
          if (!hyphenMode && currentLine.words.length > 0) {
            pushLine(true);
            afterHardBreak = false;
          }
          for (const seg of segs) {
            const segW = measureSeg(seg);
            if (currentLine.words.length > 0 && currentLine.totalWidth + segW > effWidth()) {
              pushLine(true);
              afterHardBreak = false;
            }
            // Char-break a segment only when break-word and it can't fit a line.
            placeCells(seg, breakWord && segW > effWidth());
          }
          wordIndex = end;
          continue;
        }
      }
    }

    // Break long words / CJK characters if needed
    const pieces = (!word.isSpace && word.text.length > 1)
      ? breakWordIfNeeded(ctx, word, effWidth(), currentLine.totalWidth)
      : [word];

    // Glued tail: content immediately after this word that cannot start a new
    // line — trailing punctuation (",.)]}…"), an inline span's right
    // padding/border (empty boxClose markers), and a word continuation that
    // abuts this word across a run boundary with no soft-wrap opportunity
    // (noBreakBefore — e.g. one word split across two inline spans with
    // different font sizes). The browser includes all of it when deciding
    // whether this word fits, so the unit wraps together: if "Music Experie"
    // doesn't leave room for the glued "nce", the whole word wraps as one.
    // Stops at whitespace or the next breakable word.
    let gluedTailWidth = 0;
    for (let j = wordIndex + 1; j < words.length; j++) {
      const nw = words[j];
      if (nw.isSpace || nw.text === '\n') break;
      const isPunct = !!nw.text && TRAILING_PUNCT.test(nw.text);
      const isCloseMarker = !nw.text && !!nw.boxClose;
      const isGluedCont = !!nw.text && !!nw.noBreakBefore;
      if (isPunct || isCloseMarker || isGluedCont) { gluedTailWidth += nw.width; continue; }
      break;
    }

    for (const piece of pieces) {
      const isLastPiece = piece === pieces[pieces.length - 1];
      // Only the last piece of the word carries the glued tail.
      const tail = isLastPiece ? gluedTailWidth : 0;
      // Trailing punctuation (e.g. comma after </span>) should not wrap
      // independently — browsers keep it with the preceding word.
      const isTrailingPunct = !piece.isSpace && piece.text.length > 0 &&
        TRAILING_PUNCT.test(piece.text) &&
        currentLine.words.length > 0 &&
        !currentLine.words[currentLine.words.length - 1].isSpace;

      // A word that abuts the previous run with no whitespace has no soft-wrap
      // opportunity before it — keep it with the preceding word like trailing
      // punctuation. Only the FIRST piece carries the flag; a break-word split
      // inside the word may still wrap mid-word.
      const isGlued = piece === pieces[0] && piece.noBreakBefore &&
        currentLine.words.length > 0 &&
        !currentLine.words[currentLine.words.length - 1].isSpace;

      // Leading inline padding/border (an empty boxOpen marker) must not be
      // stranded at the end of a line — it belongs with the span's following
      // content (CSS applies padding-left at the box's start). Include the next
      // content word's width in this marker's fit test so the two wrap together
      // and the left padding lands on the new line with the content.
      let headExtra = 0;
      if (!piece.text && piece.boxOpen) {
        const next = words[wordIndex + 1];
        if (next && !next.isSpace && next.text) {
          // Only the next word's first BREAKABLE unit must stay with the leading
          // padding — the whole word for unbreakable Latin, but just the first
          // character for CJK / break-word (which wrap per character). Using the
          // whole word here would over-wrap a long CJK run that follows padding.
          const np = next.text.length > 1
            ? breakWordIfNeeded(ctx, next, effWidth(), 0)
            : [next];
          headExtra = np[0].width;
        }
      }

      // A soft-hyphen break point draws a visible '-' when the line breaks
      // right after this piece. Chrome only allows a break there if the prefix
      // PLUS the hyphen fits, so reserve the hyphen advance in the overflow
      // test — otherwise we pack one extra segment and the appended hyphen
      // overflows the line (breaking one segment later than the browser).
      let shReserve = 0;
      if (piece.isSoftHyphenBreak) {
        applyFont(ctx, piece.style);
        ctx.letterSpacing = formatLetterSpacing(piece.style.letterSpacing);
        shReserve = cachedMeasureWidth(ctx, '-');
      }

      // Would this piece overflow?
      if (!piece.isSpace && !isTrailingPunct && !isGlued && currentLine.words.length > 0 &&
        currentLine.totalWidth + piece.width + shReserve + tail + headExtra > effWidth()) {
        const overflow = currentLine.totalWidth + piece.width + shReserve + tail + headExtra - effWidth();

        // For borderline cases (overflow < 1px), word-by-word delta
        // accumulation may introduce rounding errors. Re-measure the
        // full candidate line as a single string for accuracy.
        // Only works for single-font lines — mixed fonts can't be
        // measured as one string.
        let reallyOverflows = true;
        if (overflow < 1 && !hasMixedFonts([...currentLine.words, piece])) {
          applyFont(ctx, piece.style);
          const fullText = currentLine.words.map(w => w.text).join('') + piece.text +
            (piece.isSoftHyphenBreak ? '-' : '');
          // Empty-text words carry non-glyph advance (inline padding/border
          // markers, inline-block margins) that measureText(fullText) misses —
          // add them back so padded inline spans aren't under-measured.
          let markerWidth = 0;
          for (const w of currentLine.words) if (!w.text) markerWidth += w.width;
          if (!piece.text) markerWidth += piece.width;
          const fullWidth = cachedMeasureWidth(ctx, fullText) + markerWidth + tail + headExtra;
          // Allow only a hair of sub-pixel overflow. measureText matches the
          // browser's rendered width to ~0.01px, so a larger slack would keep
          // lines the browser actually wraps (packing one extra word per
          // borderline line and drifting the whole document's breaks).
          if (fullWidth <= effWidth() + 0.02) {
            reallyOverflows = false;
          }
        }

        // Hyphen break on current line: before wrapping the whole word,
        // try fitting a hyphen prefix on the current line. Browsers prefer
        // keeping content on the current line by splitting at hyphens.
        if (reallyOverflows && piece.text.includes('-')) {
          const parts = piece.text.split(/(?<=-)(?!\d)|(?<=[^\d]-)/);
          if (parts.length > 1) {
            applyFont(ctx, piece.style);
            let fitted = '';
            let fittedWidth = 0;
            let partIdx = 0;
            const available = effWidth() - currentLine.totalWidth;
            for (; partIdx < parts.length; partIdx++) {
              const candidate = fitted + parts[partIdx];
              const candidateWidth = cachedMeasureWidth(ctx, candidate);
              if (candidateWidth > available) break;
              fitted = candidate;
              fittedWidth = candidateWidth;
            }
            if (partIdx > 0 && partIdx < parts.length) {
              currentLine.words.push({ ...piece, text: fitted, width: fittedWidth });
              currentLine.totalWidth += fittedWidth;
              currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
              pushLine(true);
              afterHardBreak = false;
              const remainder = parts.slice(partIdx).join('');
              const remainderWidth = cachedMeasureWidth(ctx, remainder);
              currentLine.words.push({ ...piece, text: remainder, width: remainderWidth });
              currentLine.totalWidth += remainderWidth;
              currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
              continue;
            }
          }
        }

        if (reallyOverflows) {
          if (_debug) {
            const lineText = currentLine.words.map(w => w.text).join('');
            _debug({
              type: 'line-wrap',
              message: `"${piece.text}" overflow=${overflow.toFixed(2)} wrap=true lineWidth=${currentLine.totalWidth.toFixed(2)} pieceWidth=${piece.width.toFixed(2)} contentWidth=${contentWidth}  line="${lineText}"`,
              data: { text: piece.text, overflow, lineWidth: currentLine.totalWidth, pieceWidth: piece.width, contentWidth, lineText },
            });
          }
          pushLine(true);
          afterHardBreak = false;
        }
      }

      // Skip leading spaces at the start of a line. Preserving modes
      // (pre/pre-wrap/break-spaces) keep them after hard breaks; collapsing
      // modes (normal/nowrap/pre-line) drop them in all cases.
      if (piece.isSpace && currentLine.words.length === 0
          && (!afterHardBreak || !preservesWhitespace)) continue;

      // Tab: advance to the next tab stop (stops measured from the content
      // edge). Chrome rule: when the next stop is closer than half a space
      // width, skip to the following stop (Blink Font::TabWidth).
      let pieceWidth = piece.width;
      if (piece.isTab) {
        const interval = tabMetrics?.interval || piece.width;
        const halfSpace = tabMetrics?.halfSpace ?? 0;
        const currentPos = (lines.length === 0 ? textIndent : 0) + currentLine.totalWidth;
        let advance = interval - (currentPos % interval);
        if (advance < halfSpace) advance += interval;
        pieceWidth = advance;
        piece.width = pieceWidth;
      }

      // Hyphen break on a fresh line when word still too wide.
      if (currentLine.words.length === 0 && pieceWidth > effWidth() &&
          !piece.isSpace && piece.text.includes('-')) {
        const subParts = piece.text.split(/(?<=-)(?!\d)|(?<=[^\d]-)/);
        if (subParts.length > 1) {
          applyFont(ctx, piece.style);
          // Inject sub-parts as individual pieces — they'll flow through
          // the normal overflow/wrap logic on subsequent iterations.
          const newPieces: Word[] = subParts.filter(p => p).map(p => ({
            ...piece,
            text: p,
            width: cachedMeasureWidth(ctx, p),
          }));
          // Replace current piece with the sub-parts by splicing into the pieces array
          // Since we're iterating `pieces`, we push remaining sub-parts after the first
          // onto the current line normally, letting the overflow check handle wrapping.
          let first = true;
          for (const sp of newPieces) {
            if (first) {
              first = false;
              // First sub-part: add to current line (it fits since it's smaller)
              currentLine.words.push(sp);
              currentLine.totalWidth += sp.width;
              currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
            } else if (currentLine.totalWidth + sp.width > effWidth()) {
              // Overflow: wrap to next line
              pushLine(true);
              afterHardBreak = false;
              currentLine.words.push(sp);
              currentLine.totalWidth += sp.width;
              currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
            } else {
              currentLine.words.push(sp);
              currentLine.totalWidth += sp.width;
              currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
            }
          }
          continue;
        }
      }

      currentLine.words.push(piece);
      currentLine.totalWidth += pieceWidth;
      currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
      if (!piece.isSpace) afterHardBreak = false;
    }
  }
  pushLine();
  return lines;
}

/**
 * Shared line budget for `-webkit-line-clamp` on a block container whose
 * text lives in block descendants (Chrome legacy `-webkit-box` semantics:
 * line boxes are counted across ALL descendants; the Nth line gets an
 * ellipsis and everything after it is dropped). Created in layoutBlock at
 * the clamped element and threaded through descendant layout calls.
 *
 * Known limitation: when the budget runs out exactly at a paragraph
 * boundary (Nth line is a paragraph's last line), following content is
 * dropped but the already-emitted Nth line gets no ellipsis — its layout
 * nodes were positioned before we learned more content follows.
 */
interface LineClampState {
  /** Line boxes still allowed before the cut. */
  remaining: number;
  /** Truncation point reached — all subsequent content is dropped. */
  exhausted: boolean;
}

/**
 * Layout inline content: text wrapping + positioning using pure canvas measurement.
 * Returns layout nodes and the total height consumed.
 */
function layoutInlineContent(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  x: number,
  y: number,
  contentWidth: number,
  useBulletProbe = false,
  clamp?: LineClampState,
): { nodes: LayoutNode[]; height: number } {
  const results: LayoutNode[] = [];
  // Text nodes covered by an inline element declaring background-clip:text
  // (clipRuns) or --rt-text-stroke-image (strokeImageRuns), mapped to that
  // declaring element's style. A post-pass turns each per-line run of
  // same-declarer nodes into a fragment-spanning paint box.
  const clipRuns = new Map<LayoutText, ResolvedStyle>();
  const strokeImageRuns = new Map<LayoutText, ResolvedStyle>();
  if (clamp && (clamp.exhausted || clamp.remaining <= 0)) {
    // An ancestor's clamp already used its line budget — drop this content.
    clamp.exhausted = true;
    return { nodes: results, height: 0 };
  }
  const runs = collectTextRuns(node);
  if (runs.length === 0) return { nodes: results, height: 0 };

  const words = tokenizeRuns(ctx, runs);
  const textIndent = node.style.textIndent || 0;
  // Tab stops follow the BLOCK's style, not the inline run the tab sits in:
  // Chrome sizes the interval as tab-size(8) × the block font's space advance
  // plus letter- and word-spacing (css-text-3 §tab-size) — verified against
  // the DOM: a tab inside a bold span still uses the regular-weight space.
  applyFont(ctx, node.style);
  const prevLetterSpacing = ctx.letterSpacing;
  ctx.letterSpacing = '0px';
  const blockSpaceWidth = cachedMeasureWidth(ctx, ' ');
  ctx.letterSpacing = prevLetterSpacing;
  const tabMetrics = {
    interval: (blockSpaceWidth + (node.style.letterSpacing || 0) + (node.style.wordSpacing || 0)) * 8,
    halfSpace: blockSpaceWidth / 2,
  };
  const lines = flowWordsIntoLines(ctx, words, contentWidth, node.style.whiteSpace, useBulletProbe, textIndent, tabMetrics);

  // `-webkit-line-clamp` / `line-clamp`: truncate to N lines and append a
  // CSS-style ellipsis ("…") to the Nth line, back-trimming trailing words
  // until the ellipsis fits within contentWidth. The budget comes from an
  // ancestor's shared clamp state when one is active (clamp on a block
  // container with block children), else from this element's own style.
  const clampN = clamp ? clamp.remaining : node.style.lineClamp;
  if (clampN > 0 && lines.length > clampN) {
    lines.length = clampN;
    const lastLine = lines[clampN - 1];
    // First line has reduced width because of text-indent; a cut on this
    // element's first line (effective budget of 1) hits it.
    const lineMaxForEllipsis = contentWidth - (clampN === 1 ? textIndent : 0);
    applyEllipsisToLine(ctx, lastLine, lineMaxForEllipsis);
    // Tag the truncated line so per-line alignment (text-align vs
    // text-align-last) still picks the right branch.
    lastLine.endedByHardBreak = true;
    if (clamp) {
      clamp.remaining = 0;
      clamp.exhausted = true;
    }
  } else if (clamp) {
    clamp.remaining -= lines.length;
  }

  const isRTL = node.style.direction === 'rtl';
  const resolveDir = (a: string) => {
    if (a === 'start') return isRTL ? 'right' : 'left';
    if (a === 'end') return isRTL ? 'left' : 'right';
    return a;
  };
  let textAlign = resolveDir(node.style.textAlign);
  // text-align-last: 'auto' inherits from text-align except when text-align is
  // 'justify', then defaults to 'start' (CSS Text 3 §7.2).
  let textAlignLast = node.style.textAlignLast || 'auto';
  if (textAlignLast === 'auto') {
    textAlignLast = node.style.textAlign === 'justify' ? (isRTL ? 'right' : 'left') : textAlign;
  } else {
    textAlignLast = resolveDir(textAlignLast);
  }

  let curY = y;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line.words.length === 0) {
      curY += line.lineHeight;
      continue;
    }

    const lineHeight = line.lineHeight;
    const isLastLine = lineIdx === lines.length - 1;
    const isFirstLine = lineIdx === 0;

    // Per-line alignment: lines ending at a forced break or the last line
    // use text-align-last; all others use text-align (CSS Text 3 §7.1, §7.2).
    const useLast = isLastLine || line.endedByHardBreak;
    const align = useLast ? textAlignLast : textAlign;

    // text-indent narrows the first line's available width.
    const indent = isFirstLine ? textIndent : 0;
    const lineMaxWidth = contentWidth - indent;

    // Justify: expand spaces to fill the line.
    let justifyExtraPerSpace = 0;
    if (align === 'justify' && line.totalWidth < lineMaxWidth) {
      const spaceCount = line.words.filter(w => w.isSpace).length;
      if (spaceCount > 0) {
        justifyExtraPerSpace = (lineMaxWidth - line.totalWidth) / spaceCount;
      }
    }

    // text-align (with first-line indent baked into curX).
    // When the line overflows its container, browsers fall back to start
    // alignment (per CSS Text 3 §7.1) instead of pushing the line outside
    // the box. Common trigger: wide letter-spacing on text that doesn't
    // wrap at letter boundaries (no break-word/break-all), where centering
    // would put glyphs at negative x. Sub-pixel tolerance avoids switching
    // to start for rounding noise on lines that visually fit.
    // Start edge differs by direction. LTR lines start at the left (x+indent).
    // RTL lines are anchored at the right, inset from the content's right edge
    // by text-indent — and lineMaxWidth already subtracts indent, so the RTL
    // right edge is x+lineMaxWidth. `align` here is physically resolved
    // (start/end → left/right via resolveDir), so RTL with align==='left'
    // (explicit left, or end) correctly falls through to left alignment.
    const overflows = line.totalWidth > lineMaxWidth + 0.5;
    let curX = x + indent;
    if (overflows) {
      // Overflow fallback: pin to the start edge (CSS Text 3 §7.1).
      curX = isRTL ? x + lineMaxWidth - line.totalWidth : x + indent;
    } else if (align === 'center') {
      curX = x + indent + (lineMaxWidth - line.totalWidth) / 2;
    } else if (align === 'right') {
      curX = (isRTL ? x + lineMaxWidth : x + indent + lineMaxWidth) - line.totalWidth;
    } else if (align === 'justify' && isRTL) {
      // RTL justify: anchor the right edge at the inset start; spaces expand left.
      curX = x + lineMaxWidth - line.totalWidth;
    }
    // Snapshot the line's left edge before LTR emission advances curX.
    const lineLeftX = curX;

    // Inline background boxes and text are emitted after baseline computation
    // (below) so that emitInlineBox can use line-level metrics for alignment.

    // Compute a single shared baseline for the entire line.
    // Exclude sub/sup words — they sit above/below the baseline and
    // shouldn't influence where the baseline is positioned.
    let maxAscent = 0;
    let maxDescent = 0;
    for (const word of line.words) {
      if (word.text === '') continue;
      // Off-baseline content (sub/sup/middle/lengths/...) does not establish
      // the line's baseline position — only baseline-aligned content does.
      if (isShiftedVAlign(word.style.verticalAlign)) continue;
      const { ascent: a, descent: d } = getFontMetrics(ctx, word.style);
      if (a > maxAscent) maxAscent = a;
      if (d > maxDescent) maxDescent = d;
    }
    // If only off-baseline words on the line, use the first word's metrics
    if (maxAscent === 0) {
      for (const word of line.words) {
        if (word.text === '') continue;
        const { ascent, descent } = getFontMetrics(ctx, word.style);
        maxAscent = ascent;
        maxDescent = descent;
        break;
      }
    }
    // Center the text block (ascent + descent) within the lineHeight
    const textBlockHeight = maxAscent + maxDescent;
    let lineBaselineY = curY + (lineHeight - textBlockHeight) / 2 + maxAscent;

    // Parent font size for vertical-align positioning (used in expansion + text
    // emit) — the largest baseline-aligned font on the line.
    const lineNormalWords = line.words.filter(w =>
      w.text !== '' && !isShiftedVAlign(w.style.verticalAlign));
    const parentFontSize = lineNormalWords.length > 0
      ? Math.max(...lineNormalWords.map(w => w.style.fontSize)) : 0;

    // Expand line height if vertically-shifted content extends beyond the line
    // box. Browsers grow the line box to fit all content, but keep the normal
    // text baseline position unchanged.
    let lineTop = curY;
    let lineBottom = curY + lineHeight;
    for (const word of line.words) {
      if (word.text === '') continue;
      const va = word.style.verticalAlign;
      if (!isShiftedVAlign(va)) continue;
      if (parentFontSize === 0) break;

      const { ascent: wAscent, descent: wDescent } = getFontMetrics(ctx, word.style);
      const shiftedBaseline = lineBaselineY +
        verticalAlignShift(va, wAscent, wDescent, parentFontSize, maxAscent, maxDescent, lineHeight);

      const wordTop = shiftedBaseline - wAscent;
      const wordBottom = shiftedBaseline + wDescent;
      if (wordTop < lineTop) lineTop = wordTop;
      if (wordBottom > lineBottom) lineBottom = wordBottom;
    }
    const effectiveLineHeight = lineBottom - lineTop;

    // Emit inline background box using line-level baseline for vertical alignment.
    // Uses the line's ascent/descent (not the box's own font) so box aligns with text.
    const emitInlineBox = (style: ResolvedStyle, bx: number, bw: number) => {
      // Use the box's OWN font for height (not the line's largest font),
      // but align vertically to the line's baseline.
      const { ascent: boxAscent, descent: boxDescent } = getFontMetrics(ctx, style);
      const padTop = style.paddingTop + style.borderTopWidth;
      const padBottom = style.paddingBottom + style.borderBottomWidth;
      const boxHeight = boxAscent + boxDescent + padTop + padBottom;
      let boxY: number;
      if (style.display === 'inline-block') {
        boxY = curY + style.marginTop;
      } else {
        boxY = lineBaselineY - boxAscent - padTop;
      }
      results.push({
        type: 'box', style, x: bx, y: boxY, width: bw, height: boxHeight,
        tagName: 'span', children: [],
      });
    };

    // LTR: emit inline background boxes (Pass 1) before text.
    if (!isRTL) {
      let scanX = curX;
      let boxStartX = scanX;
      let currentBoxStyle: ResolvedStyle | undefined;
      let boxHasText = false;

      for (const word of line.words) {
        if (word.boxOpen && word.boxClose && word.text) {
          if (currentBoxStyle) {
            if (boxHasText) emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX);
            currentBoxStyle = undefined;
            boxHasText = false;
          }
          const s = word.style;
          const textWidth = word.width - s.marginLeft - s.borderLeftWidth - s.paddingLeft
            - s.paddingRight - s.borderRightWidth - s.marginRight;
          const boxX = scanX + s.marginLeft;
          const boxW = s.borderLeftWidth + s.paddingLeft + textWidth + s.paddingRight + s.borderRightWidth;
          emitInlineBox(s, boxX, boxW);
          boxHasText = false;
          scanX += word.width;
          continue;
        }

        if (word.boxStyle !== currentBoxStyle) {
          if (currentBoxStyle && boxHasText) {
            emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX);
          }
          currentBoxStyle = word.boxStyle;
          boxStartX = scanX;
          boxHasText = false;
        }
        if (word.text && !word.isSpace) boxHasText = true;
        scanX += word.width + (word.isSpace ? justifyExtraPerSpace : 0);
      }
      if (currentBoxStyle && boxHasText) {
        emitInlineBox(currentBoxStyle, boxStartX, scanX - boxStartX);
      }
    }

    // Emit text nodes.
    const textWords = line.words.filter(w => w.text !== '');
    const allSameStyle = textWords.length > 0 && textWords.every(w =>
      sameTextStyle(w.style, textWords[0].style)
    );

    if (isRTL) {
      // RTL: build groups, compute positions, emit boxes then text.
      // Groups join consecutive same-style words for proper glyph shaping.
      // Padding markers between groups create spacing.
      interface StyledGroup {
        text: string; style: ResolvedStyle; width: number;
        boxStyle?: ResolvedStyle; clipStyle?: ResolvedStyle;
        strokeImageStyle?: ResolvedStyle; x: number;
        padBefore: number; // padding before this group (from boxOpen/boxClose markers)
      }
      const groups: StyledGroup[] = [];
      let currentGroup: StyledGroup | null = null;
      let pendingPad = 0;

      for (const word of line.words) {
        if (word.text === '') {
          // Padding marker — accumulate for the next group boundary
          if (currentGroup) { groups.push(currentGroup); currentGroup = null; }
          pendingPad += word.width;
          continue;
        }
        if (word.isSpace && justifyExtraPerSpace > 0) {
          // Justify only: break the shaping group at the space and fold the
          // expansion into the inter-group advance so the line fills the width.
          // (Arabic does not join across spaces, so this is shaping-safe.)
          // When not justifying, spaces stay merged into the group text below
          // so the canvas BiDi engine can reorder embedded LTR runs/numbers.
          if (currentGroup) { groups.push(currentGroup); currentGroup = null; }
          pendingPad += word.width + justifyExtraPerSpace;
          continue;
        }
        if (currentGroup && sameTextStyle(currentGroup.style, word.style)) {
          currentGroup.text += word.text;
          currentGroup.width += word.width;
        } else {
          if (currentGroup) groups.push(currentGroup);
          currentGroup = { text: word.text, style: word.style, width: word.width, boxStyle: word.boxStyle, clipStyle: word.clipStyle, strokeImageStyle: word.strokeImageStyle, x: 0, padBefore: pendingPad };
          pendingPad = 0;
        }
      }
      if (currentGroup) groups.push(currentGroup);

      // Compute positions right-to-left: group-level measureText for accuracy,
      // with padding markers creating spacing between groups.
      let rtlX = curX + line.totalWidth;
      for (const group of groups) {
        rtlX -= group.padBefore; // spacing from padding markers
        applyFont(ctx, group.style);
        const measuredWidth = cachedMeasureWidth(ctx, group.text);
        rtlX -= measuredWidth;
        group.x = rtlX;
        group.width = measuredWidth;
      }

      // Emit inline boxes first (behind text).
      // Include padding/border from boxStyle in box dimensions.
      for (const group of groups) {
        if (group.boxStyle && hasVisibleBoxStyles(group.boxStyle)) {
          const bs = group.boxStyle;
          const padLeft = bs.paddingLeft + bs.borderLeftWidth;
          const padRight = bs.paddingRight + bs.borderRightWidth;
          emitInlineBox(bs, group.x - padLeft, group.width + padLeft + padRight);
        }
      }

      // Emit text groups
      for (const group of groups) {
        const node: LayoutText = {
          type: 'text',
          text: group.text,
          x: group.x + group.width, // x = right edge for RTL textAlign
          y: lineBaselineY,
          width: group.width,
          style: { ...group.style, direction: 'rtl' },
        };
        results.push(node);
        if (group.clipStyle) clipRuns.set(node, group.clipStyle);
        if (group.strokeImageStyle) strokeImageRuns.set(node, group.strokeImageStyle);
      }
    } else {
      // LTR with mixed BiDi scripts: emit the entire line as one fillText call
      // so the canvas engine handles BiDi reordering (Arabic/Hebrew in LTR).
      // Only do this when the line contains RTL characters — pure LTR lines
      // are more accurate with word-by-word positioning.
      const lineText = line.words.map(w => w.text).join('');
      const hasBidiMix = allSameStyle && /[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(lineText) &&
        !line.words.some(w => w.boxOpen || w.boxClose ||
          w.style.verticalAlign === 'super' || w.style.verticalAlign === 'sub');
      if (hasBidiMix) {
        applyFont(ctx, textWords[0].style);
        const measuredWidth = cachedMeasureWidth(ctx, lineText);
        // This line belongs to an LTR block (we're in the !isRTL branch), so it
        // must be painted with an LTR base direction even when its first word is
        // RTL (an RTL span that wrapped onto this line). Without forcing LTR the
        // node inherits the first word's direction:'rtl' and the paint path
        // right-aligns the whole line at the left edge (x=curX), drawing it
        // off-screen. The canvas BiDi engine still reorders the embedded
        // Arabic/Hebrew runs within the LTR line.
        const node: LayoutText = {
          type: 'text',
          text: lineText,
          x: curX,
          y: lineBaselineY,
          width: measuredWidth,
          style: { ...textWords[0].style, direction: 'ltr' },
        };
        results.push(node);
        if (textWords[0].clipStyle) clipRuns.set(node, textWords[0].clipStyle);
        if (textWords[0].strokeImageStyle) strokeImageRuns.set(node, textWords[0].strokeImageStyle);
      } else {
        // Mixed styles: word by word
        for (const word of line.words) {
          if (word.text === '') {
            curX += word.width;
            continue;
          }

          // Atomic inline-block: position text inside the box (after margin + padding)
          if (word.boxOpen && word.boxClose) {
            const s = word.style;
            const textX = curX + s.marginLeft + s.borderLeftWidth + s.paddingLeft;
            const node: LayoutText = {
              type: 'text',
              text: word.text,
              x: textX,
              y: lineBaselineY,
              width: cachedMeasureWidth(ctx, word.text),
              style: word.style,
            };
            results.push(node);
            if (word.clipStyle) clipRuns.set(node, word.clipStyle);
            if (word.strokeImageStyle) strokeImageRuns.set(node, word.strokeImageStyle);
            curX += word.width;
            continue;
          }

          // Adjust baseline for vertical-align
          let baselineY = lineBaselineY;
          const va = word.style.verticalAlign;
          if (isShiftedVAlign(va)) {
            const pfs = parentFontSize || word.style.fontSize;
            const { ascent: wA, descent: wD } = getFontMetrics(ctx, word.style);
            baselineY += verticalAlignShift(va, wA, wD, pfs, maxAscent, maxDescent, lineHeight);
          }
          const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);

          const node: LayoutText = {
            type: 'text',
            text: word.text,
            x: curX,
            y: baselineY,
            width: effectiveWidth,
            style: word.style,
          };
          results.push(node);
          if (word.clipStyle) clipRuns.set(node, word.clipStyle);
          if (word.strokeImageStyle) strokeImageRuns.set(node, word.strokeImageStyle);

          curX += effectiveWidth;
        }
      }
    }

    // Emit a public LayoutLine record for this committed line.
    // bounds.width: justified lines fill lineMaxWidth (spaces expanded);
    // others use the measured words width.
    const lineWidth =
      align === 'justify' && justifyExtraPerSpace > 0
        ? lineMaxWidth
        : line.totalWidth;
    _lines.push({
      y: Math.round(lineBaselineY),
      text: line.words.map(w => w.text).join(''),
      bounds: {
        x: lineLeftX,
        // Use the actual visual top (may be < curY when a super pushes the
        // line box upward) so the rect covers ascenders/super content.
        y: lineTop,
        width: lineWidth,
        height: effectiveLineHeight,
      },
    });

    curY += effectiveLineHeight;
  }

  assignInlineFragmentBoxes(ctx, results, clipRuns, (node, s, box) => {
    node.clip = {
      image: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : undefined,
      color: !isTransparent(s.backgroundColor) ? s.backgroundColor : undefined,
      ...box,
    };
  });
  assignInlineFragmentBoxes(ctx, results, strokeImageRuns, (node, s, box) => {
    node.strokeImage = { image: s.webkitTextStrokeImage, ...box };
  });

  return { nodes: results, height: curY - y };
}

/**
 * Give each text run covered by an inline paint declarer (background-clip:text
 * background, --rt-text-stroke-image) a paint box spanning the declaring
 * element's fragment on its line.
 *
 * Browsers paint the declaring element's background over its inline fragment
 * (the run of glyphs it covers on one line) and clip it to the text; with
 * `background-size:100% 100%` the gradient fills that fragment box. Consecutive
 * text nodes sharing the same declaring element (same style object) on the
 * same baseline form one fragment; a wrap to the next line starts a new one
 * (box-decoration-break:clone semantics — Chrome's default `slice` continues
 * the gradient across line fragments; accepted approximation), and unlike a
 * per-run gradient it never restarts per word.
 */
function assignInlineFragmentBoxes(
  ctx: CanvasRenderingContext2D,
  results: LayoutNode[],
  runs: Map<LayoutText, ResolvedStyle>,
  assign: (
    node: LayoutText,
    declarer: ResolvedStyle,
    box: { x: number; y: number; width: number; height: number },
  ) => void,
): void {
  if (runs.size === 0) return;
  const edges = (n: LayoutText) =>
    n.style.direction === 'rtl'
      ? { left: n.x - n.width, right: n.x }  // RTL x is the right edge
      : { left: n.x, right: n.x + n.width };
  for (let i = 0; i < results.length;) {
    const first = results[i];
    const declarer = first.type === 'text' ? runs.get(first) : undefined;
    if (!declarer) { i++; continue; }
    let j = i;
    let left = Infinity, right = -Infinity;
    while (j < results.length) {
      const n = results[j];
      if (n.type !== 'text' || runs.get(n) !== declarer || n.y !== first.y) break;
      const e = edges(n);
      if (e.left < left) left = e.left;
      if (e.right > right) right = e.right;
      j++;
    }
    const { ascent, descent } = getFontMetrics(ctx, declarer);
    const box = {
      x: left,
      y: first.y - ascent,
      width: right - left,
      height: ascent + descent,
    };
    for (let k = i; k < j; k++) assign(results[k] as LayoutText, declarer, box);
    i = j;
  }
}

// ─── Block layout ──────────────────────────────────────────────────────

/**
 * Collapse margins between two adjacent block elements.
 * Returns the effective spacing (max of the two margins, not sum).
 */
function collapseMargins(prevMarginBottom: number, nextMarginTop: number): number {
  // Both positive: take the larger
  if (prevMarginBottom >= 0 && nextMarginTop >= 0) {
    return Math.max(prevMarginBottom, nextMarginTop);
  }
  // Both negative: take the more negative
  if (prevMarginBottom < 0 && nextMarginTop < 0) {
    return Math.min(prevMarginBottom, nextMarginTop);
  }
  // One positive, one negative: sum them
  return prevMarginBottom + nextMarginTop;
}

/**
 * Check if a node is a block-level display.
 */
function isBlock(node: StyledNode): boolean {
  const d = node.style.display;
  return d === 'block' || d === 'list-item' || d === 'flex' || d === 'table' ||
    d === 'table-row' || d === 'table-cell' || d === 'table-row-group' ||
    d === 'table-header-group' || d === 'table-footer-group';
}

/**
 * Layout a block-level element and all its children.
 * Returns the LayoutBox and total height consumed (including margins).
 */
function layoutBlock(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  x: number,
  y: number,
  availableWidth: number,
  clamp?: LineClampState,
): { box: LayoutBox; height: number; marginBottomOut: number } {
  const style = node.style;

  // `-webkit-line-clamp` on a block container: start a shared line budget
  // here and thread it through descendant layout so the count spans block
  // children (Chrome legacy -webkit-box semantics). An ancestor's active
  // clamp wins over a nested one.
  if (!clamp && style.lineClamp > 0) {
    clamp = { remaining: style.lineClamp, exhausted: false };
  }

  // Box model
  const marginLeft = style.marginLeft;
  const marginRight = style.marginRight;
  const borderLeft = style.borderLeftWidth;
  const borderRight = style.borderRightWidth;
  const borderTop = style.borderTopWidth;
  const borderBottom = style.borderBottomWidth;
  const padLeft = style.paddingLeft;
  const padRight = style.paddingRight;
  const padTop = style.paddingTop;
  const padBottom = style.paddingBottom;

  const boxX = x + marginLeft;
  // If element has explicit width, use it; otherwise fill available width
  const boxWidth = (style.width > 0)
    ? style.width
    : availableWidth - marginLeft - marginRight;
  const contentX = boxX + borderLeft + padLeft;
  const contentWidth = Math.max(0, boxWidth - borderLeft - borderRight - padLeft - padRight);

  const boxY = y;
  const contentStartY = boxY + borderTop + padTop;

  const box: LayoutBox = {
    type: 'box',
    style,
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: 0, // computed below
    tagName: node.tagName,
    children: [],
    listMarker: node.listMarker,
  };

  // Flex layout
  if (style.display === 'flex') {
    const result = layoutFlex(ctx, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: style.marginBottom };
  }

  // Table layout
  if (style.display === 'table') {
    const result = layoutTable(ctx, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: style.marginBottom };
  }

  // Empty block elements: zero content height (CSS spec — no line boxes created).
  // Only min-height or padding/border contribute to height.
  if (node.children.length === 0) {
    box.height = borderTop + padTop + padBottom + borderBottom;
    if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
    return { box, height: box.height, marginBottomOut: style.marginBottom };
  }

  // Layout children
  if (hasOnlyInlineChildren(node)) {
    // Inline formatting context
    const bulletProbe = node.tagName === 'li' && BULLET_MARKERS.has(style.listStyleType);
    const { nodes, height } = layoutInlineContent(ctx, node, contentX, contentStartY, contentWidth, bulletProbe, clamp);
    box.children = nodes;
    box.height = borderTop + padTop + height + padBottom + borderBottom;
  } else {
    // Block formatting context — stack children vertically
    let curY = contentStartY;
    let prevMarginBottom = 0;
    let hasContent = false; // tracks whether we've placed any content
    // Margin collapsing through parent: only for list elements.
    const allowCollapseThrough =
      node.tagName === 'li' || node.tagName === 'ul' || node.tagName === 'ol' ||
      node.tagName === 'dd' || node.tagName === 'dt';

    for (let ci = 0; ci < node.children.length; ci++) {
      const child = node.children[ci];

      // Line-clamp budget exhausted — everything below the cut is dropped,
      // including the margin trailing the cut line.
      if (clamp && (clamp.exhausted || clamp.remaining <= 0)) {
        clamp.exhausted = true;
        prevMarginBottom = 0;
        break;
      }

      if (child.tagName === '#text' || isInline(child)) {
        // Collect ALL consecutive inline/text children into one group
        const inlineChildren: StyledNode[] = [child];
        while (ci + 1 < node.children.length) {
          const next = node.children[ci + 1];
          if (next.tagName === '#text' || isInline(next)) {
            inlineChildren.push(next);
            ci++;
          } else {
            break;
          }
        }

        // Apply pending margin before inline content
        if (prevMarginBottom > 0) {
          curY += prevMarginBottom;
          prevMarginBottom = 0;
        }

        const inlineGroup: StyledNode = {
          element: null,
          tagName: 'div',
          style: { ...node.style, display: 'block', marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0 },
          children: inlineChildren,
          textContent: null,
        };
        const bulletProbe2 = node.tagName === 'li' && BULLET_MARKERS.has(style.listStyleType);
        const { nodes, height } = layoutInlineContent(ctx, inlineGroup, contentX, curY, contentWidth, bulletProbe2, clamp);
        box.children.push(...nodes);
        curY += height;
        prevMarginBottom = 0;
        hasContent = true;
        continue;
      }

      // Block child — collapse margins
      const childMarginTop = child.style.marginTop;

      // First child margin-top collapses through parent if parent has no top border/padding
      // Only for elements that don't establish a new BFC (not root, not flex, not overflow)
      // First child margin-top collapses through parent if parent has no
      // top padding/border and doesn't establish a new BFC.
      if (!hasContent && padTop === 0 && borderTop === 0 && allowCollapseThrough) {
        // Skip — margin collapses with parent's margin
      } else {
        const collapsed = collapseMargins(prevMarginBottom, childMarginTop);
        curY += collapsed;
      }

      const { box: childBox, height: childTotalHeight, marginBottomOut } = layoutBlock(
        ctx, child, contentX, curY, contentWidth, clamp,
      );
      box.children.push(childBox);
      curY += childTotalHeight;
      // A child truncated by line-clamp clips its trailing margin too.
      prevMarginBottom = clamp?.exhausted ? 0 : marginBottomOut;
      hasContent = true;
    }

    // Last child's margin-bottom collapses through parent if no bottom border/padding.
    // Root container does NOT collapse last-child margin (it defines the content height).
    let marginBottomOut = style.marginBottom;
    const canCollapseThrough = padBottom === 0 && borderBottom === 0 && allowCollapseThrough;
    if (canCollapseThrough && prevMarginBottom > 0) {
      // Last child's margin passes through to become parent's effective margin-bottom
      marginBottomOut = Math.max(style.marginBottom, prevMarginBottom);
    }

    // Include last child's margin-bottom in parent height when it can't collapse through
    let contentEnd = curY - contentStartY;
    if (!canCollapseThrough && prevMarginBottom > 0) {
      contentEnd += prevMarginBottom;
    }
    box.height = borderTop + padTop + contentEnd + padBottom + borderBottom;
    if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
    return { box, height: box.height, marginBottomOut };
  }

  if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
  return { box, height: box.height, marginBottomOut: style.marginBottom };
}

// ─── Table layout ──────────────────────────────────────────────────────

function layoutTable(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const children: LayoutNode[] = [];

  // Collect rows from thead, tbody, tfoot, or direct tr children
  const rows: StyledNode[] = [];
  for (const child of node.children) {
    if (child.tagName === 'tr') {
      rows.push(child);
    } else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) {
      for (const grandchild of child.children) {
        if (grandchild.tagName === 'tr') rows.push(grandchild);
      }
    }
  }

  if (rows.length === 0) return { children, height: 0 };

  // Determine column count from first row
  const colCount = Math.max(...rows.map(r => r.children.filter(c => c.tagName === 'td' || c.tagName === 'th').length));
  if (colCount === 0) return { children, height: 0 };

  // Equal column widths (simple approach)
  const colWidth = contentWidth / colCount;

  let curY = contentY;

  for (const row of rows) {
    const cells = row.children.filter(c => c.tagName === 'td' || c.tagName === 'th');
    let maxCellHeight = 0;
    const cellBoxes: LayoutBox[] = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cellX = contentX + i * colWidth;

      const { box: cellBox, height: cellHeight } = layoutBlock(ctx, cell, cellX, curY, colWidth);
      cellBoxes.push(cellBox);
      maxCellHeight = Math.max(maxCellHeight, cellHeight);
    }

    // Normalize cell heights to the tallest cell in the row
    for (const cellBox of cellBoxes) {
      cellBox.height = maxCellHeight;
      children.push(cellBox);
    }

    curY += maxCellHeight;
  }

  return { children, height: curY - contentY };
}

// ─── Flex layout ───────────────────────────────────────────────────────

function layoutFlex(
  ctx: CanvasRenderingContext2D,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const style = node.style;
  const gap = style.gap;
  const children: LayoutNode[] = [];

  const flexChildren = node.children.filter(c => c.tagName !== '#text' || c.textContent?.trim());
  if (flexChildren.length === 0) return { children, height: 0 };

  if (style.flexDirection === 'row' || style.flexDirection === '') {
    // Row layout
    const totalGaps = gap * (flexChildren.length - 1);
    const totalGrow = flexChildren.reduce((s, c) => s + (c.style.flexGrow || 0), 0);
    const flexBasis = (contentWidth - totalGaps) / (totalGrow || flexChildren.length);

    let curX = contentX;
    let maxHeight = 0;

    for (const child of flexChildren) {
      if (child.tagName === '#text') continue;
      const grow = child.style.flexGrow || (totalGrow === 0 ? 1 : 0);
      const childWidth = flexBasis * grow;

      const { box, height } = layoutBlock(ctx, child, curX, contentY, childWidth);
      children.push(box);
      maxHeight = Math.max(maxHeight, height);
      curX += childWidth + gap;
    }

    return { children, height: maxHeight };
  }

  // Column layout (fallback)
  let curY = contentY;
  for (const child of flexChildren) {
    if (child.tagName === '#text') continue;
    const { box, height } = layoutBlock(ctx, child, contentX, curY, contentWidth);
    children.push(box);
    curY += height + gap;
  }
  return { children, height: curY - contentY };
}

// ─── List marker layout ────────────────────────────────────────────────

/**
 * Add list marker to a layout box if applicable.
 */
function addListMarker(
  ctx: CanvasRenderingContext2D,
  box: LayoutBox,
  node: StyledNode,
): void {
  if (!node.listMarker) return;
  // `::marker { content: none }` suppresses the marker entirely —
  // canonical CSS behavior, matches the DOM reference.
  if (node.markerHidden) return;

  const style = node.style;
  // Marker style = li style with explicit `::marker` overrides applied on top.
  // `markerStyle` holds only keys explicitly set by `::marker` rules, so a
  // missing key falls back to the li style. A present key (incl. 0) wins.
  const ms = node.markerStyle;
  const markerStyleObj: ResolvedStyle = ms ? { ...style, ...ms } : style;

  ctx.font = buildCanvasFont(markerStyleObj);
  const lineHeight = getLineHeight(ctx, style);
  const baselineY = box.y + style.borderTopWidth + style.paddingTop +
    computeBaselineY(ctx, style, lineHeight);

  const markerWidth = cachedMeasureWidth(ctx, node.listMarker);
  const isRTL = style.direction === 'rtl';
  const isBullet = BULLET_MARKERS.has(style.listStyleType);
  // Gap between marker and content, matching Chrome (measured empirically):
  // - bullets: Chrome paints a symbol (diameter ascent/3) whose ink ends
  //   7px + ascent/3 before the content edge, centered ascent/3 above the
  //   baseline. We keep the glyph but position its ink to land there.
  // - text markers ("1."): Chrome's marker text carries a ". " suffix, so
  //   the gap is one space advance and the baseline is the line baseline.
  // `::marker { padding-inline-end: <length> }` overrides the gap — we honor
  // the direction-resolved physical padding (paddingRight in LTR, paddingLeft
  // in RTL) when explicitly set on the marker.
  const explicitGap = isRTL ? ms?.paddingLeft : ms?.paddingRight;

  let markerX: number;
  let markerY = baselineY;
  let markerDirection = 'ltr';
  // Style/width the marker glyph is actually DRAWN with. Numbers draw at the
  // li font (unchanged); bullets scale up (see below), so keep these separate.
  let markerDrawStyle: ResolvedStyle = markerStyleObj;
  let markerDrawWidth = markerWidth;
  const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
  const boxRightEdge = box.x + box.width;
  if (isBullet) {
    const { ascent } = getFontMetrics(ctx, markerStyleObj);
    const m = ctx.measureText(node.listMarker);
    // Blink's marker unit: the disc DIAMETER, the variable part of the gap, and
    // the vertical centering all key off this one value (a 2/3·ascent marker
    // box with a half-filling disc → ascent/3). Named once so tuning one keeps
    // the trio in sync.
    const markerUnit = ascent / 3;
    const gap = explicitGap !== undefined ? explicitGap : 7 + markerUnit;
    // Chrome paints bullet symbols (disc/circle/square) as a SYNTHETIC shape of
    // that diameter, NOT the font's smaller '•'/'○'/'■' glyph (Roboto's '•' ink
    // is ~0.22em vs Chrome's ~0.31em disc). Match it by scaling the glyph so its
    // ink height equals markerUnit. Keeping the marker a text node means fill /
    // stroke / shadow / gradient still apply exactly as before.
    const inkH = (m.actualBoundingBoxAscent ?? 0) + (m.actualBoundingBoxDescent ?? 0);
    const scale = inkH > 0 ? markerUnit / inkH : 1;
    const inkRight = (m.actualBoundingBoxRight ?? markerWidth) * scale;
    const inkLeft = (m.actualBoundingBoxLeft ?? 0) * scale;
    const glyphInkCenter =
      (((m.actualBoundingBoxAscent ?? 0) - (m.actualBoundingBoxDescent ?? 0)) / 2) * scale;
    if (isRTL) {
      // actualBoundingBoxLeft is positive when ink extends left of origin
      markerX = boxRightEdge + gap + inkLeft;
    } else {
      markerX = contentStartX - gap - inkRight;
    }
    markerY = baselineY - markerUnit + glyphInkCenter;
    markerDrawStyle = { ...markerStyleObj, fontSize: markerStyleObj.fontSize * scale };
    markerDrawWidth = markerWidth * scale;
  } else {
    const gap = explicitGap !== undefined
      ? explicitGap
      : cachedMeasureWidth(ctx, ' ');
    if (isRTL) {
      // RTL: marker in the parent's right padding area (outside the li box).
      // Numbered markers ("1.") need RTL direction to display as ".1".
      // With textAlign='right', x is the right edge — so add markerWidth.
      const isNumbered = /\d/.test(node.listMarker);
      if (isNumbered) {
        markerDirection = 'rtl';
        markerX = boxRightEdge + gap + markerWidth;
      } else {
        markerX = boxRightEdge + gap;
      }
    } else {
      // LTR: marker in the parent's left padding area (outside the li box).
      markerX = contentStartX - markerWidth - gap;
    }
  }

  box.children.unshift({
    type: 'text',
    text: node.listMarker,
    x: markerX,
    y: markerY,
    width: markerDrawWidth,
    style: { ...markerDrawStyle, textDecorationLine: 'none', textDecorations: [], fontWeight: ms?.fontWeight ?? 400, fontStyle: ms?.fontStyle ?? 'normal', direction: markerDirection },
  });

  // Also publish the marker through the LayoutLine stream so result.lines
  // sees the bullet/number alongside the item text. Markers are added AFTER
  // inline content is laid out, so they don't go through layoutInlineContent.
  // The buildLayoutTree sort+merge step picks up the marker by its baseline.
  // RTL numbered markers store their right edge in markerX (textAlign trick).
  // bounds.width is the (scaled) glyph ADVANCE, not its ink extent — same
  // convention as numbered markers; the ink right edge itself is pinned to
  // contentStart - gap above.
  const markerLeftX = markerDirection === 'rtl' ? markerX - markerDrawWidth : markerX;
  _lines.push({
    y: Math.round(baselineY),
    text: node.listMarker,
    bounds: {
      x: markerLeftX,
      y: box.y + style.borderTopWidth + style.paddingTop,
      width: markerDrawWidth,
      height: lineHeight,
    },
  });
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Build the layout tree from the styled tree using pure canvas measurement.
 * No DOM measurements used — all positions computed from CSS values + canvas.measureText.
 */
export function buildLayoutTree(
  ctx: CanvasRenderingContext2D,
  styledTree: StyledNode,
  containerWidth: number,
  useDomMeasurements = true,
  debug?: (entry: import('./types.ts').DebugEntry) => void,
): { root: LayoutBox; height: number; lines: LayoutLine[] } {
  _useDomMeasurements = useDomMeasurements;
  _debug = debug;

  // Clear caches — fonts may have loaded since last call
  _lineHeightCache.clear();
  _fontMetricsCache.clear();
  _fontStringCache.clear();
  _measureCache.clear();
  _lines = [];

  // The styledTree root is our container div — layout its children as a block flow
  const { box, height } = layoutBlock(ctx, styledTree, 0, 0, containerWidth);

  // Add list markers post-layout
  addListMarkersRecursive(ctx, box, styledTree);

  // Sort by baseline y, then by left edge so cross-cell content merges in
  // reading order (LTR). List markers sit at smaller x than their content
  // and so come first, producing "• Item" rather than "Item •".
  const sorted = _lines.slice().sort((a, b) =>
    (a.y - b.y) || (a.bounds.x - b.bounds.x)
  );
  const lines: LayoutLine[] = [];
  for (const candidate of sorted) {
    const last = lines[lines.length - 1];
    // Tolerance keys off the candidate's line height (matches the legacy
    // extractLines behavior). Using max(last, candidate) is symmetric but
    // grows after each merge as last.bounds.height becomes the union — that
    // leaks across rows in tight multi-column layouts.
    const tolerance = candidate.bounds.height * 0.5;
    if (last && Math.abs(candidate.y - last.y) < tolerance) {
      // Cross-cell merge: insert a space separator so the text stays
      // readable when N cells of a table row collapse into one LayoutLine.
      // Skip if either side already has a boundary space.
      const needsSep = last.text.length > 0 && candidate.text.length > 0 &&
        !/\s$/.test(last.text) && !/^\s/.test(candidate.text);
      last.text += (needsSep ? ' ' : '') + candidate.text;
      // Carry baseline forward so the next comparison uses the running
      // edge of the group, not the stale first element's baseline.
      last.y = Math.max(last.y, candidate.y);
      const x1 = Math.min(last.bounds.x, candidate.bounds.x);
      const y1 = Math.min(last.bounds.y, candidate.bounds.y);
      const x2 = Math.max(last.bounds.x + last.bounds.width, candidate.bounds.x + candidate.bounds.width);
      const y2 = Math.max(last.bounds.y + last.bounds.height, candidate.bounds.y + candidate.bounds.height);
      last.bounds = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else {
      lines.push({ y: candidate.y, text: candidate.text, bounds: { ...candidate.bounds } });
    }
  }
  return { root: box, height, lines };
}

function addListMarkersRecursive(
  ctx: CanvasRenderingContext2D,
  box: LayoutBox,
  node: StyledNode,
): void {
  addListMarker(ctx, box, node);

  // Match children — box.children may have extra text/inline nodes,
  // so we correlate by walking both in parallel
  let boxChildIdx = 0;
  for (const styledChild of node.children) {
    if (styledChild.tagName === '#text' || isInline(styledChild)) {
      continue;
    }
    // Find the matching LayoutBox
    while (boxChildIdx < box.children.length) {
      const layoutChild = box.children[boxChildIdx];
      if (layoutChild.type === 'box' && layoutChild.tagName === styledChild.tagName) {
        addListMarkersRecursive(ctx, layoutChild, styledChild);
        boxChildIdx++;
        break;
      }
      boxChildIdx++;
    }
  }
}
