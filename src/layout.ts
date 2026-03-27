import type { StyledNode, LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.ts';

/**
 * Build a canvas font string from resolved style.
 */
export function buildCanvasFont(style: ResolvedStyle): string {
  const parts: string[] = [];
  if (style.fontStyle !== 'normal') parts.push(style.fontStyle);
  if (style.fontWeight !== 400) parts.push(String(style.fontWeight));
  parts.push(`${style.fontSize}px`);
  parts.push(style.fontFamily);
  return parts.join(' ');
}

/**
 * Get the effective line height for a style.
 * If lineHeight is 0 (meaning "normal"), compute from font metrics.
 */
function getLineHeight(ctx: CanvasRenderingContext2D, style: ResolvedStyle): number {
  if (style.lineHeight > 0) return style.lineHeight;
  // "normal" line-height: use font metrics
  ctx.font = buildCanvasFont(style);
  const metrics = ctx.measureText('Mgy');
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
  return ascent + descent;
}

/**
 * Compute the baseline Y offset within a line.
 * Uses the Konva approach: center (ascent - descent) within lineHeight.
 */
function computeBaselineY(ctx: CanvasRenderingContext2D, style: ResolvedStyle, lineHeight: number): number {
  ctx.font = buildCanvasFont(style);
  const metrics = ctx.measureText('M');
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
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

function isTransparent(color: string): boolean {
  return !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
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
}

interface Word {
  text: string;
  width: number;
  style: ResolvedStyle;
  isSpace: boolean;
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
    const isBox = isInline(n) && hasVisibleBoxStyles(n.style);
    const isInlineBlock = n.style.display === 'inline-block';
    const newBoxStyle = isBox ? n.style : boxStyle;
    const hasHorizSpacing = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    // Inline-block margin-left as spacing
    if (isInlineBlock && n.style.marginLeft > 0) {
      runs.push({ text: '', style: n.style, boxStyle });
    }

    if (hasHorizSpacing || (isInlineBlock && (n.style.paddingLeft > 0 || n.style.paddingRight > 0))) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style });
    }

    for (const child of n.children) {
      walk(child, isBox ? newBoxStyle : boxStyle);
    }

    if (hasHorizSpacing || (isInlineBlock && (n.style.paddingLeft > 0 || n.style.paddingRight > 0))) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style });
    }

    // Inline-block margin-right as spacing
    if (isInlineBlock && n.style.marginRight > 0) {
      runs.push({ text: '', style: n.style, boxStyle });
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
function tokenizeString(
  ctx: CanvasRenderingContext2D, text: string, run: TextRun, allWords: Word[],
  cumState: { cumText: string; cumWidth: number } = { cumText: '', cumWidth: 0 },
): { cumText: string; cumWidth: number } {
  // Split on zero-width spaces and soft hyphens (break opportunities)
  if (text.includes('\u200B') || text.includes('\u00AD')) {
    const parts = text.split(/[\u200B\u00AD]/);
    for (const part of parts) {
      if (part) cumState = tokenizeString(ctx, part, run, allWords, cumState);
    }
    return cumState;
  }

  const isPreserve = run.style.whiteSpace === 'pre' ||
    run.style.whiteSpace === 'pre-wrap' ||
    run.style.whiteSpace === 'pre-line';

  if (isPreserve) {
    // Split on spaces and tabs, keeping delimiters
    const words = text.split(/( +|\t)/);
    const tabWidth = ctx.measureText(' ').width * 8; // tab = 8 spaces
    for (const w of words) {
      if (w === '') continue;
      if (w === '\t') {
        allWords.push({
          text: ' ',
          width: tabWidth,
          style: run.style,
          isSpace: true,
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

    // Use cumulative measurement to avoid rounding error accumulation.
    // cumState persists across runs with the same font, eliminating
    // errors at color/decoration boundaries.
    for (const w of words) {
      if (w === '') continue;
      const isSpace = /^[ \t\n\r\f\v]+$/.test(w);

      if (isSpace) {
        const prevCum = cumState.cumWidth;
        cumState.cumText += ' ';
        cumState.cumWidth = ctx.measureText(cumState.cumText).width;
        allWords.push({
          text: ' ',
          width: cumState.cumWidth - prevCum,
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
            const prevCum = cumState.cumWidth;
            cumState.cumText += s;
            cumState.cumWidth = ctx.measureText(cumState.cumText).width;
            allWords.push({
              text: s,
              width: cumState.cumWidth - prevCum,
              style: run.style,
              isSpace: false,
              boxStyle: run.boxStyle,
            });
          }
          continue;
        }
      }

      const prevCum = cumState.cumWidth;
      cumState.cumText += w;
      cumState.cumWidth = ctx.measureText(cumState.cumText).width;
      allWords.push({
        text: w,
        width: cumState.cumWidth - prevCum,
        style: run.style,
        isSpace: false,
        boxStyle: run.boxStyle,
      });
    }
  }
  return cumState;
}

/**
 * Check if two styles use the same font for measurement purposes.
 * Color, background, decoration don't affect text width — only font properties do.
 */
function sameMeasurementFont(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.letterSpacing === b.letterSpacing;
}

/**
 * Tokenize text runs into words for line wrapping.
 */
function tokenizeRuns(ctx: CanvasRenderingContext2D, runs: TextRun[]): Word[] {
  const allWords: Word[] = [];

  // Track cumulative measurement across runs with the same font.
  // Only reset when the font actually changes (not just color).
  let cumText = '';
  let cumWidth = 0;
  let cumFont = '';

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

    const newFont = buildCanvasFont(run.style);
    // Reset cumulative state when font changes (color doesn't matter for measurement)
    if (newFont !== cumFont) {
      cumText = '';
      cumWidth = 0;
      cumFont = newFont;
      ctx.font = newFont;
      ctx.letterSpacing = run.style.letterSpacing > 0 ? `${run.style.letterSpacing}px` : '0px';
    }

    const text = applyTextTransform(run.text, run.style.textTransform);

    // Handle explicit newlines (from <br> or pre-wrap) — always force line break
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          allWords.push({ text: '\n', width: 0, style: run.style, isSpace: false, boxStyle: run.boxStyle });
          cumText = ''; cumWidth = 0; // reset after newline
        }
        if (parts[i]) {
          const state = tokenizeString(ctx, parts[i], run, allWords, { cumText, cumWidth });
          cumText = state.cumText;
          cumWidth = state.cumWidth;
        }
      }
    } else {
      const state = tokenizeString(ctx, text, run, allWords, { cumText, cumWidth });
      cumText = state.cumText;
      cumWidth = state.cumWidth;
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

  // Check if word needs break-word splitting
  const needsBreak = word.width > contentWidth &&
    (word.style.overflowWrap === 'break-word' || word.style.wordBreak === 'break-all');

  if (!hasCJK && !needsBreak) return [word];

  // Split into characters
  ctx.font = buildCanvasFont(word.style);
  const chars = [...word.text];
  const pieces: Word[] = [];

  let current = '';
  let currentWidth = 0;

  for (const char of chars) {
    const charWidth = ctx.measureText(char).width;

    // CJK chars always get their own word for wrapping
    if (isCJK(char)) {
      if (current) {
        pieces.push({ ...word, text: current, width: currentWidth });
        current = '';
        currentWidth = 0;
      }
      pieces.push({ ...word, text: char, width: charWidth });
      continue;
    }

    // For break-word: break when adding this char would exceed container
    if (needsBreak && currentWidth + charWidth > contentWidth && current) {
      pieces.push({ ...word, text: current, width: currentWidth });
      current = '';
      currentWidth = 0;
    }

    current += char;
    currentWidth += charWidth;
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
): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let currentLine: PositionedLine = { words: [], totalWidth: 0, lineHeight: 0 };
  const noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';

  function pushLine() {
    // Trim trailing spaces
    while (currentLine.words.length > 0 && currentLine.words[currentLine.words.length - 1].isSpace) {
      currentLine.totalWidth -= currentLine.words[currentLine.words.length - 1].width;
      currentLine.words.pop();
    }
    if (currentLine.words.length > 0) {
      lines.push(currentLine);
    }
    currentLine = { words: [], totalWidth: 0, lineHeight: 0 };
  }

  let afterHardBreak = true; // start of content is like after a hard break

  for (const word of words) {
    const wordLineHeight = getLineHeight(ctx, word.style);

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
      // Would this piece overflow?
      if (!piece.isSpace && currentLine.words.length > 0 &&
        currentLine.totalWidth + piece.width > contentWidth) {
        pushLine();
        afterHardBreak = false;
      }

      // Skip leading spaces after soft wraps, but preserve after hard breaks (\n)
      if (piece.isSpace && currentLine.words.length === 0 && !afterHardBreak) continue;

      currentLine.words.push(piece);
      currentLine.totalWidth += piece.width;
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
): { nodes: LayoutNode[]; height: number } {
  const results: LayoutNode[] = [];
  const runs = collectTextRuns(node);
  if (runs.length === 0) return { nodes: results, height: 0 };

  const words = tokenizeRuns(ctx, runs);
  const lines = flowWordsIntoLines(ctx, words, contentWidth, node.style.whiteSpace);
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

    // Two-pass: first collect inline background boxes, then text.
    // This ensures backgrounds are rendered before (behind) text.

    // Pass 1: find inline background box regions
    {
      let scanX = curX;
      let boxStartX = scanX;
      let currentBoxStyle: ResolvedStyle | undefined;

      const emitBox = (style: ResolvedStyle, startX: number, endX: number) => {
        // Inline box height = font em-box + vertical padding/border, NOT line-height
        ctx.font = buildCanvasFont(style);
        const metrics = ctx.measureText('Mgy');
        const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
        const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
        const emHeight = ascent + descent;
        const boxHeight = emHeight + style.paddingTop + style.paddingBottom
          + style.borderTopWidth + style.borderBottomWidth;
        // Center the inline box vertically within the line
        const boxY = curY + (lineHeight - boxHeight) / 2;

        results.push({
          type: 'box',
          style,
          x: startX,
          y: boxY,
          width: endX - startX,
          height: boxHeight,
          tagName: 'span',
          children: [],
        });
      };

      for (const word of line.words) {
        if (word.boxStyle !== currentBoxStyle) {
          if (currentBoxStyle) {
            emitBox(currentBoxStyle, boxStartX, scanX);
          }
          currentBoxStyle = word.boxStyle;
          boxStartX = scanX;
        }
        scanX += word.width + (word.isSpace ? justifyExtraPerSpace : 0);
      }
      if (currentBoxStyle) {
        emitBox(currentBoxStyle, boxStartX, scanX);
      }
    }

    // Compute a single shared baseline for the entire line.
    // Exclude sub/sup words — they sit above/below the baseline and
    // shouldn't influence where the baseline is positioned.
    let maxAscent = 0;
    let maxDescent = 0;
    for (const word of line.words) {
      if (word.text === '') continue;
      const va = word.style.verticalAlign;
      if (va === 'super' || va === 'sub') continue; // skip sub/sup for baseline calc
      ctx.font = buildCanvasFont(word.style);
      const m = ctx.measureText('M');
      const a = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
      const d = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
      if (a > maxAscent) maxAscent = a;
      if (d > maxDescent) maxDescent = d;
    }
    // If only sub/sup words on the line, use the first word's metrics
    if (maxAscent === 0) {
      for (const word of line.words) {
        if (word.text === '') continue;
        ctx.font = buildCanvasFont(word.style);
        const m = ctx.measureText('M');
        maxAscent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
        maxDescent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
        break;
      }
    }
    // Center the text block (ascent + descent) within the lineHeight
    const textBlockHeight = maxAscent + maxDescent;
    const lineBaselineY = curY + (lineHeight - textBlockHeight) / 2 + maxAscent;

    // Pass 2: emit text
    // For RTL lines with uniform style, emit as a single text node
    // so the canvas can handle BiDi glyph shaping and connected letters.
    const textWords = line.words.filter(w => w.text !== '');
    const allSameStyle = textWords.length > 0 && textWords.every(w =>
      w.style.fontFamily === textWords[0].style.fontFamily &&
      w.style.fontSize === textWords[0].style.fontSize &&
      w.style.fontWeight === textWords[0].style.fontWeight &&
      w.style.fontStyle === textWords[0].style.fontStyle &&
      w.style.color === textWords[0].style.color
    );

    if (isRTL) {
      // RTL: render words right-to-left
      // Join consecutive words with same style into groups for proper glyph shaping
      let rtlX = curX + line.totalWidth; // start from right edge

      interface StyledGroup { text: string; style: ResolvedStyle; width: number; }
      const groups: StyledGroup[] = [];
      let currentGroup: StyledGroup | null = null;

      for (const word of line.words) {
        if (word.text === '') {
          // Padding marker — flush current group and add spacing
          if (currentGroup) { groups.push(currentGroup); currentGroup = null; }
          rtlX -= word.width;
          continue;
        }
        if (currentGroup &&
            currentGroup.style.fontFamily === word.style.fontFamily &&
            currentGroup.style.fontSize === word.style.fontSize &&
            currentGroup.style.fontWeight === word.style.fontWeight &&
            currentGroup.style.fontStyle === word.style.fontStyle &&
            currentGroup.style.color === word.style.color) {
          currentGroup.text += word.text;
          currentGroup.width += word.width;
        } else {
          if (currentGroup) groups.push(currentGroup);
          currentGroup = { text: word.text, style: word.style, width: word.width };
        }
      }
      if (currentGroup) groups.push(currentGroup);

      // Emit groups right-to-left
      for (const group of groups) {
        ctx.font = buildCanvasFont(group.style);
        const measuredWidth = ctx.measureText(group.text).width;
        rtlX -= measuredWidth;

        results.push({
          type: 'text',
          text: group.text,
          x: rtlX + measuredWidth, // x = right edge for RTL textAlign
          y: lineBaselineY,
          width: measuredWidth,
          style: { ...group.style, direction: 'rtl' },
        });
      }
    } else {
      // LTR: word by word
      for (const word of line.words) {
        if (word.text === '') {
          curX += word.width;
          continue;
        }

        // Adjust baseline for vertical-align
        let baselineY = lineBaselineY;
        const va = word.style.verticalAlign;
        if (va === 'super' || va === 'sub') {
          // Find parent font size (the normal-sized text on this line)
          const normalWords = textWords.filter(w =>
            w.style.verticalAlign !== 'super' && w.style.verticalAlign !== 'sub');
          const parentFontSize = normalWords.length > 0
            ? Math.max(...normalWords.map(w => w.style.fontSize))
            : word.style.fontSize;
          if (va === 'super') {
            // Browser raises super by ~0.33em of parent
            baselineY -= parentFontSize * 0.33;
          } else {
            // Browser lowers sub by ~0.25em of parent
            baselineY += parentFontSize * 0.25;
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

    curY += lineHeight;
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

  // Empty block elements (e.g. <p></p>) get min-height or one line of height
  if (node.children.length === 0 && node.tagName !== 'div') {
    const contentHeight = style.minHeight > 0 ? style.minHeight : getLineHeight(ctx, style);
    box.height = borderTop + padTop + contentHeight + padBottom + borderBottom;
    if (style.minHeight > 0) box.height = Math.max(box.height, style.minHeight);
    return { box, height: box.height, marginBottomOut: style.marginBottom };
  }

  // Layout children
  if (hasOnlyInlineChildren(node)) {
    // Inline formatting context
    const { nodes, height } = layoutInlineContent(ctx, node, contentX, contentStartY, contentWidth);
    box.children = nodes;
    box.height = borderTop + padTop + height + padBottom + borderBottom;
  } else {
    // Block formatting context — stack children vertically
    let curY = contentStartY;
    let prevMarginBottom = 0;
    let hasContent = false; // tracks whether we've placed any content

    for (const child of node.children) {
      if (child.tagName === '#text') {
        // Standalone text in block context
        if (child.textContent && child.textContent.trim()) {
          const lineHeight = getLineHeight(ctx, child.style);
          const baselineY = curY + computeBaselineY(ctx, child.style, lineHeight);
          ctx.font = buildCanvasFont(child.style);
          const text = applyTextTransform(child.textContent.trim(), child.style.textTransform);
          box.children.push({
            type: 'text',
            text,
            x: contentX,
            y: baselineY,
            width: ctx.measureText(text).width,
            style: child.style,
          });
          curY += lineHeight;
          prevMarginBottom = 0;
          hasContent = true;
        }
        continue;
      }

      if (isInline(child)) {
        const inlineGroup: StyledNode = {
          element: null,
          tagName: 'div',
          style: { ...node.style, display: 'block', marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0 },
          children: [child],
          textContent: null,
        };
        const { nodes, height } = layoutInlineContent(ctx, inlineGroup, contentX, curY, contentWidth);
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
      const isBFC = style.display === 'flex' || style.display === 'table' ||
        node.tagName === 'div' && node.element === null; // synthetic wrapper = skip
      if (!hasContent && padTop === 0 && borderTop === 0 && !isBFC &&
          (node.tagName === 'li' || node.tagName === 'ul' || node.tagName === 'ol' ||
           node.tagName === 'dd' || node.tagName === 'dt')) {
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

    // Last child's margin-bottom collapses through parent if no bottom border/padding
    let marginBottomOut = style.marginBottom;
    const canCollapseThrough = padBottom === 0 && borderBottom === 0 &&
      (node.tagName === 'li' || node.tagName === 'ul' || node.tagName === 'ol' ||
       node.tagName === 'dd' || node.tagName === 'dt');
    if (canCollapseThrough && prevMarginBottom > 0) {
      // Last child's margin passes through to become parent's effective margin-bottom
      marginBottomOut = Math.max(style.marginBottom, prevMarginBottom);
    }

    box.height = borderTop + padTop + (curY - contentStartY) + padBottom + borderBottom;
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
  // Content starts at box.x + borderLeft + paddingLeft
  // Place marker right-aligned within the padding area, with a small gap before content
  const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
  const gap = style.fontSize * 0.15; // small gap between marker and content
  const markerX = contentStartX - markerWidth - gap;

  box.children.unshift({
    type: 'text',
    text: node.listMarker,
    x: markerX,
    y: baselineY,
    width: markerWidth,
    style: { ...style, textDecorationLine: 'none', fontWeight: 400, fontStyle: 'normal' },
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
): { root: LayoutBox; height: number } {
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
