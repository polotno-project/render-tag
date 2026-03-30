import type { StyledNode, LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.js';

// Module-level flag controlling DOM measurement usage.
// Set by buildLayoutTree() based on the useDomMeasurements option.
let _useDomMeasurements = true;
let _debug: ((entry: import('./types.ts').DebugEntry) => void) | undefined;


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
function applyFont(ctx: CanvasRenderingContext2D, style: ResolvedStyle): void {
  ctx.font = buildCanvasFont(style);
  ctx.fontKerning = style.fontKerning === 'none' ? 'none' : 'normal';
}

/**
 * Build a canvas font string from resolved style. Results are cached.
 */
const _fontStringCache = new Map<string, string>();
export function buildCanvasFont(style: ResolvedStyle): string {
  const key = `${style.fontStyle}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}`;
  const cached = _fontStringCache.get(key);
  if (cached) return cached;
  const parts: string[] = [];
  if (style.fontStyle !== 'normal') parts.push(style.fontStyle);
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

  // Canvas-only fallback for "normal" line-height: use font metrics
  const { ascent, descent } = getFontMetrics(ctx, style);
  return (ascent + descent) * 1.2;
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
    case 'capitalize': return text.replace(/\b\w/g, c => c.toUpperCase());
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
 * Check if two styles have the same text rendering properties.
 */
function sameTextStyle(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.textDecorationLine === b.textDecorationLine &&
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
  boxStyle?: ResolvedStyle;
  /** Marks the start of an inline box (adds left padding/border) */
  boxOpen?: ResolvedStyle;
  /** Marks the end of an inline box (adds right padding/border) */
  boxClose?: ResolvedStyle;
}

interface PositionedLine {
  words: Word[];
  totalWidth: number;
  lineHeight: number;
}

// ─── Inline layout ─────────────────────────────────────────────────────

/**
 * Collect text runs from inline children, preserving style and tracking
 * inline elements with visible backgrounds. Emits open/close markers
 * for inline boxes so padding/border can be applied.
 */
function collectTextRuns(node: StyledNode): TextRun[] {
  const runs: TextRun[] = [];

  function walk(n: StyledNode, boxStyle?: ResolvedStyle) {
    if (n.tagName === '#text' && n.textContent) {
      runs.push({ text: n.textContent, style: n.style, boxStyle });
      return;
    }
    const isInlineBlock = n.style.display === 'inline-block';
    // Inline-block always needs box treatment (padding/margin affect layout)
    const isBox = isInlineBlock || (isInline(n) && hasVisibleBoxStyles(n.style));
    const newBoxStyle = isBox ? n.style : boxStyle;
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
        // Store the full box info for atomic inline-block handling
        boxOpen: n.style,  // signals this is a boxed element
        boxClose: n.style,
      });
      return;
    }

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style });
    }

    for (const child of n.children) {
      walk(child, isBox ? newBoxStyle : boxStyle);
    }

    if (hasHorizSpacing) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style });
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

  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'pre-line';

  if (isPreserve) {
    // Split on spaces and tabs, keeping delimiters
    const words = text.split(/( +|\t)/);
    const tabStopInterval = ctx.measureText(' ').width * 8; // CSS default: 8 spaces
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
        });
        continue;
      }
      const isSpace = /^ +$/.test(w);
      allWords.push({
        text: w,
        width: ctx.measureText(w).width,
        style: run.style,
        isSpace,
        boxStyle: run.boxStyle,
      });
    }
  } else {
    // Split on whitespace but NOT on non-breaking spaces (\u00A0)
    const words = text.split(/([ \t\n\r\f\v]+)/);

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
        allWords.push({
          text: ' ',
          width: cumWidth - prevCum,
          style: run.style,
          isSpace: true,
          boxStyle: run.boxStyle,
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
            });
          }
          continue;
        }
      }

      const prevCum = cumWidth;
      cumText += w;
      cumWidth = ctx.measureText(cumText).width;
      let width = cumWidth - prevCum;
      const directWidth = ctx.measureText(w).width;
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
      ctx.letterSpacing = run.style.letterSpacing > 0 ? `${run.style.letterSpacing}px` : '0px';
      const text = applyTextTransform(run.text, run.style.textTransform);
      const s = run.style;
      const textWidth = ctx.measureText(text).width;
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
    ctx.letterSpacing = run.style.letterSpacing > 0 ? `${run.style.letterSpacing}px` : '0px';
    const text = applyTextTransform(run.text, run.style.textTransform);

    // Handle explicit newlines (from <br> or pre-wrap) — always force line break
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          allWords.push({ text: '\n', width: 0, style: run.style, isSpace: false, boxStyle: run.boxStyle });
        }
        if (parts[i]) {
          tokenizeString(ctx, parts[i], run, allWords);
        }
      }
    } else {
      tokenizeString(ctx, text, run, allWords);
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

/**
 * Break a word into character-level pieces if it contains CJK or if
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

  // Check if word needs break-word splitting — when it won't fit on a fresh line
  const needsBreak = word.width > contentWidth &&
    (word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all');

  if (!hasCJK && !needsBreak) return [word];

  // Split into characters using cumulative measurement for accuracy.
  // Measuring each char individually ignores kerning — the sum of individual
  // widths diverges from the true string width over many characters.
  ctx.font = buildCanvasFont(word.style);
  const chars = [...word.text];
  const pieces: Word[] = [];

  let current = '';
  let currentWidth = 0;

  for (const char of chars) {
    // CJK chars always get their own word for wrapping
    if (isCJK(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      const charWidth = ctx.measureText(char).width;
      pieces.push({ ...word, text: char, width: charWidth });
      continue;
    }

    // Use cumulative measurement: measure the growing string, not individual chars
    const candidateText = current + char;
    const candidateWidth = ctx.measureText(candidateText).width;

    // For break-word: break when adding this char would exceed container
    if (needsBreak && candidateWidth > contentWidth && current) {
      pieces.push({ ...word, text: current, width: currentWidth });
      current = char;
      currentWidth = ctx.measureText(char).width;
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
): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let currentLine: PositionedLine = { words: [], totalWidth: 0, lineHeight: 0 };
  const noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';

  const isPreWrap = whiteSpace === 'pre-wrap' || whiteSpace === 'pre' || whiteSpace === 'pre-line';

  function pushLine(isSoftWrap = false) {
    const hadWords = currentLine.words.length > 0;
    // Trim trailing spaces
    while (currentLine.words.length > 0 && currentLine.words[currentLine.words.length - 1].isSpace) {
      currentLine.totalWidth -= currentLine.words[currentLine.words.length - 1].width;
      currentLine.words.pop();
    }
    // Soft hyphen: if this is a soft wrap and the last word has a soft-hyphen
    // break, append a visible '-' since the word is being broken here.
    if (isSoftWrap && currentLine.words.length > 0) {
      const lastWord = currentLine.words[currentLine.words.length - 1];
      if (lastWord.isSoftHyphenBreak) {
        applyFont(ctx, lastWord.style);
        const hyphenWidth = ctx.measureText('-').width;
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

  for (const word of words) {
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
        lines.push(currentLine);
        currentLine = { words: [], totalWidth: 0, lineHeight: 0 };
      } else {
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

    // Break long words / CJK characters if needed
    const pieces = (!word.isSpace && word.text.length > 1)
      ? breakWordIfNeeded(ctx, word, contentWidth, currentLine.totalWidth)
      : [word];

    for (const piece of pieces) {
      // Trailing punctuation (e.g. comma after </span>) should not wrap
      // independently — browsers keep it with the preceding word.
      const isTrailingPunct = !piece.isSpace && piece.text.length > 0 &&
        /^[,.\;:!?\)\]\}'"»›]+$/.test(piece.text) &&
        currentLine.words.length > 0 &&
        !currentLine.words[currentLine.words.length - 1].isSpace;

      // Would this piece overflow?
      if (!piece.isSpace && !isTrailingPunct && currentLine.words.length > 0 &&
        currentLine.totalWidth + piece.width > contentWidth) {
        const overflow = currentLine.totalWidth + piece.width - contentWidth;

        // For borderline cases (overflow < 1px), word-by-word delta
        // accumulation may introduce rounding errors. Re-measure the
        // full candidate line as a single string for accuracy.
        // Only works for single-font lines — mixed fonts can't be
        // measured as one string.
        let reallyOverflows = true;
        if (overflow < 1 && !hasMixedFonts([...currentLine.words, piece])) {
          applyFont(ctx, piece.style);
          const fullText = currentLine.words.map(w => w.text).join('') + piece.text;
          const fullWidth = ctx.measureText(fullText).width;
          // Allow tiny sub-pixel overflow — canvas measureText and DOM
          // text layout can differ by fractions of a pixel.
          if (fullWidth <= contentWidth + 0.1) {
            reallyOverflows = false;
          }
        }

        // Hyphen break on current line: before wrapping the whole word,
        // try fitting a hyphen prefix on the current line. Browsers prefer
        // keeping content on the current line by splitting at hyphens.
        if (reallyOverflows && piece.text.includes('-')) {
          const parts = piece.text.split(/(?<=-)/);
          if (parts.length > 1) {
            applyFont(ctx, piece.style);
            let fitted = '';
            let fittedWidth = 0;
            let partIdx = 0;
            const available = contentWidth - currentLine.totalWidth;
            for (; partIdx < parts.length; partIdx++) {
              const candidate = fitted + parts[partIdx];
              const candidateWidth = ctx.measureText(candidate).width;
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
              const remainderWidth = ctx.measureText(remainder).width;
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

      // Skip leading spaces after soft wraps, but preserve after hard breaks (\n)
      if (piece.isSpace && currentLine.words.length === 0 && !afterHardBreak) continue;

      // Tab: snap to next tab stop based on current position
      let pieceWidth = piece.width;
      if (piece.isTab) {
        const tabStop = piece.width; // tabStopInterval stored as width
        const currentPos = currentLine.totalWidth;
        const nextStop = Math.ceil((currentPos + 0.1) / tabStop) * tabStop;
        pieceWidth = nextStop - currentPos;
        piece.width = pieceWidth;
      }

      // Hyphen break on a fresh line when word still too wide.
      if (currentLine.words.length === 0 && pieceWidth > contentWidth &&
          !piece.isSpace && piece.text.includes('-')) {
        const subParts = piece.text.split(/(?<=-)/);
        if (subParts.length > 1) {
          applyFont(ctx, piece.style);
          // Inject sub-parts as individual pieces — they'll flow through
          // the normal overflow/wrap logic on subsequent iterations.
          const newPieces: Word[] = subParts.filter(p => p).map(p => ({
            ...piece,
            text: p,
            width: ctx.measureText(p).width,
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
            } else if (currentLine.totalWidth + sp.width > contentWidth) {
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
): { nodes: LayoutNode[]; height: number } {
  const results: LayoutNode[] = [];
  const runs = collectTextRuns(node);
  if (runs.length === 0) return { nodes: results, height: 0 };

  const words = tokenizeRuns(ctx, runs);
  const lines = flowWordsIntoLines(ctx, words, contentWidth, node.style.whiteSpace, useBulletProbe);
  const isRTL = node.style.direction === 'rtl';
  let textAlign = node.style.textAlign;
  // In RTL, default alignment is right; 'start'='right', 'end'='left'
  if (textAlign === 'start') textAlign = isRTL ? 'right' : 'left';
  if (textAlign === 'end') textAlign = isRTL ? 'left' : 'right';

  let curY = y;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line.words.length === 0) {
      curY += line.lineHeight;
      continue;
    }

    const lineHeight = line.lineHeight;
    const isLastLine = lineIdx === lines.length - 1;

    // Justify: expand spaces to fill the line (except last line)
    let justifyExtraPerSpace = 0;
    if (textAlign === 'justify' && !isLastLine && line.totalWidth < contentWidth) {
      const spaceCount = line.words.filter(w => w.isSpace).length;
      if (spaceCount > 0) {
        justifyExtraPerSpace = (contentWidth - line.totalWidth) / spaceCount;
      }
    }

    // text-align
    let curX = x;
    if (textAlign === 'center') {
      curX = x + (contentWidth - line.totalWidth) / 2;
    } else if (textAlign === 'right' || (textAlign !== 'justify' && isRTL)) {
      curX = x + contentWidth - line.totalWidth;
    } else if (isRTL) {
      curX = x + contentWidth - line.totalWidth;
    }

    // Inline background boxes and text are emitted after baseline computation
    // (below) so that emitInlineBox can use line-level metrics for alignment.

    // Compute a single shared baseline for the entire line.
    // Exclude sub/sup words — they sit above/below the baseline and
    // shouldn't influence where the baseline is positioned.
    let maxAscent = 0;
    let maxDescent = 0;
    for (const word of line.words) {
      if (word.text === '') continue;
      const va = word.style.verticalAlign;
      if (va === 'super' || va === 'sub') continue; // skip sub/sup for baseline calc
      const { ascent: a, descent: d } = getFontMetrics(ctx, word.style);
      if (a > maxAscent) maxAscent = a;
      if (d > maxDescent) maxDescent = d;
    }
    // If only sub/sup words on the line, use the first word's metrics
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

    // Compute parent font size for sub/sup positioning (used in expansion + text emit)
    const lineNormalWords = line.words.filter(w =>
      w.text !== '' && w.style.verticalAlign !== 'super' && w.style.verticalAlign !== 'sub');
    const parentFontSize = lineNormalWords.length > 0
      ? Math.max(...lineNormalWords.map(w => w.style.fontSize)) : 0;

    // Expand line height if sub/sup extends beyond the line box.
    // Browsers grow the line box to fit all content, but keep
    // the normal text baseline position unchanged.
    let effectiveLineHeight = lineHeight;
    {

      let minTop = curY;
      let maxBottom = curY + lineHeight;

      for (const word of line.words) {
        if (word.text === '') continue;
        const va = word.style.verticalAlign;
        if (va !== 'super' && va !== 'sub') continue;
        if (parentFontSize === 0) break;

        const { ascent: wAscent, descent: wDescent } = getFontMetrics(ctx, word.style);

        let shiftedBaseline = lineBaselineY;
        if (va === 'super') {
          shiftedBaseline -= parentFontSize * 0.4;
        } else {
          shiftedBaseline += parentFontSize * 0.26;
        }

        const wordTop = shiftedBaseline - wAscent;
        const wordBottom = shiftedBaseline + wDescent;
        if (wordTop < minTop) minTop = wordTop;
        if (wordBottom > maxBottom) maxBottom = wordBottom;
      }

      effectiveLineHeight = maxBottom - minTop;
    }

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
        boxStyle?: ResolvedStyle; x: number;
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
        if (currentGroup && sameTextStyle(currentGroup.style, word.style)) {
          currentGroup.text += word.text;
          currentGroup.width += word.width;
        } else {
          if (currentGroup) groups.push(currentGroup);
          currentGroup = { text: word.text, style: word.style, width: word.width, boxStyle: word.boxStyle, x: 0, padBefore: pendingPad };
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
        const measuredWidth = ctx.measureText(group.text).width;
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
        results.push({
          type: 'text',
          text: group.text,
          x: group.x + group.width, // x = right edge for RTL textAlign
          y: lineBaselineY,
          width: group.width,
          style: { ...group.style, direction: 'rtl' },
        });
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
        const measuredWidth = ctx.measureText(lineText).width;
        results.push({
          type: 'text',
          text: lineText,
          x: curX,
          y: lineBaselineY,
          width: measuredWidth,
          style: textWords[0].style,
        });
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
            results.push({
              type: 'text',
              text: word.text,
              x: textX,
              y: lineBaselineY,
              width: ctx.measureText(word.text).width,
              style: word.style,
            });
            curX += word.width;
            continue;
          }

          // Adjust baseline for vertical-align
          let baselineY = lineBaselineY;
          const va = word.style.verticalAlign;
          if (va === 'super' || va === 'sub') {
            const pfs = parentFontSize || word.style.fontSize;
            if (va === 'super') {
              baselineY -= pfs * 0.4;
            } else {
              baselineY += pfs * 0.26;
            }
          }
          const effectiveWidth = word.width + (word.isSpace ? justifyExtraPerSpace : 0);

          results.push({
            type: 'text',
            text: word.text,
            x: curX,
            y: baselineY,
            width: effectiveWidth,
            style: word.style,
          });

          curX += effectiveWidth;
        }
      }
    }

    curY += effectiveLineHeight;
  }

  return { nodes: results, height: curY - y };
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
): { box: LayoutBox; height: number; marginBottomOut: number } {
  const style = node.style;

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
    const { nodes, height } = layoutInlineContent(ctx, node, contentX, contentStartY, contentWidth, bulletProbe);
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
        const { nodes, height } = layoutInlineContent(ctx, inlineGroup, contentX, curY, contentWidth, bulletProbe2);
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
        ctx, child, contentX, curY, contentWidth,
      );
      box.children.push(childBox);
      curY += childTotalHeight;
      prevMarginBottom = marginBottomOut;
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

  const style = node.style;
  ctx.font = buildCanvasFont(style);
  const lineHeight = getLineHeight(ctx, style);
  const baselineY = box.y + style.borderTopWidth + style.paddingTop +
    computeBaselineY(ctx, style, lineHeight);

  const markerWidth = ctx.measureText(node.listMarker).width;
  const gap = style.fontSize * 0.15; // small gap between marker and content
  const isRTL = style.direction === 'rtl';

  let markerX: number;
  let markerDirection = 'ltr';
  if (isRTL) {
    // RTL: marker in the parent's right padding area (outside the li box).
    const boxRightEdge = box.x + box.width;
    // Numbered markers ("1.") need RTL direction to display as ".1".
    // With textAlign='right', x is the right edge — so add markerWidth.
    // Bullet markers (•, ○, ■) stay LTR — they're symmetric.
    const isNumbered = /\d/.test(node.listMarker);
    if (isNumbered) {
      markerDirection = 'rtl';
      markerX = boxRightEdge + gap + markerWidth;
    } else {
      markerX = boxRightEdge + gap;
    }
  } else {
    // LTR: marker in the parent's left padding area (outside the li box).
    // Right-aligned within the padding, with a gap before content.
    const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
    markerX = contentStartX - markerWidth - gap;
  }

  box.children.unshift({
    type: 'text',
    text: node.listMarker,
    x: markerX,
    y: baselineY,
    width: markerWidth,
    style: { ...style, textDecorationLine: 'none', fontWeight: 400, fontStyle: 'normal', direction: markerDirection },
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
): { root: LayoutBox; height: number } {
  _useDomMeasurements = useDomMeasurements;
  _debug = debug;

  // Clear caches — fonts may have loaded since last call
  _lineHeightCache.clear();
  _fontMetricsCache.clear();
  _fontStringCache.clear();

  // The styledTree root is our container div — layout its children as a block flow
  const { box, height } = layoutBlock(ctx, styledTree, 0, 0, containerWidth);

  // Add list markers post-layout
  addListMarkersRecursive(ctx, box, styledTree);

  return { root: box, height };
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
