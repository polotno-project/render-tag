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
    const newBoxStyle = isBox ? n.style : boxStyle;
    const hasPad = isBox && (n.style.paddingLeft > 0 || n.style.paddingRight > 0 ||
      n.style.borderLeftWidth > 0 || n.style.borderRightWidth > 0);

    if (hasPad) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxOpen: n.style });
    }

    for (const child of n.children) {
      walk(child, newBoxStyle);
    }

    if (hasPad) {
      runs.push({ text: '', style: n.style, boxStyle: newBoxStyle, boxClose: n.style });
    }
  }

  for (const child of node.children) {
    walk(child);
  }
  return runs;
}

/**
 * Tokenize text runs into words for line wrapping.
 */
function tokenizeRuns(ctx: CanvasRenderingContext2D, runs: TextRun[]): Word[] {
  const allWords: Word[] = [];

  for (const run of runs) {
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

    ctx.font = buildCanvasFont(run.style);
    const text = applyTextTransform(run.text, run.style.textTransform);
    const isPreserve = run.style.whiteSpace === 'pre' ||
      run.style.whiteSpace === 'pre-wrap' ||
      run.style.whiteSpace === 'pre-line';

    if (isPreserve) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          allWords.push({ text: '\n', width: 0, style: run.style, isSpace: false, boxStyle: run.boxStyle });
        }
        const words = parts[i].split(/( +)/);
        for (const w of words) {
          if (w === '') continue;
          const isSpace = /^ +$/.test(w);
          allWords.push({
            text: w,
            width: ctx.measureText(w).width + (run.style.letterSpacing * w.length),
            style: run.style,
            isSpace,
            boxStyle: run.boxStyle,
          });
        }
      }
    } else {
      const words = text.split(/(\s+)/);
      for (const w of words) {
        if (w === '') continue;
        const isSpace = /^\s+$/.test(w);
        const displayText = isSpace ? ' ' : w;
        allWords.push({
          text: displayText,
          width: isSpace
            ? ctx.measureText(' ').width + run.style.letterSpacing
            : ctx.measureText(w).width + (run.style.letterSpacing * w.length),
          style: run.style,
          isSpace,
          boxStyle: run.boxStyle,
        });
      }
    }
  }

  return allWords;
}

/**
 * Flow words into lines that fit within contentWidth.
 */
function flowWordsIntoLines(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  contentWidth: number,
): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let currentLine: PositionedLine = { words: [], totalWidth: 0, lineHeight: 0 };

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

  for (const word of words) {
    const wordLineHeight = getLineHeight(ctx, word.style);

    if (word.text === '\n') {
      if (currentLine.words.length === 0) {
        // Empty line — push a placeholder for line height
        currentLine.lineHeight = wordLineHeight;
        lines.push(currentLine);
        currentLine = { words: [], totalWidth: 0, lineHeight: 0 };
      } else {
        pushLine();
      }
      continue;
    }

    // Would this word overflow?
    if (!word.isSpace && currentLine.words.length > 0 &&
      currentLine.totalWidth + word.width > contentWidth) {
      pushLine();
    }

    // Skip leading spaces on a new line
    if (word.isSpace && currentLine.words.length === 0) continue;

    currentLine.words.push(word);
    currentLine.totalWidth += word.width;
    currentLine.lineHeight = Math.max(currentLine.lineHeight, wordLineHeight);
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
  const lines = flowWordsIntoLines(ctx, words, contentWidth);
  const textAlign = node.style.textAlign;

  let curY = y;

  for (const line of lines) {
    if (line.words.length === 0) {
      curY += line.lineHeight;
      continue;
    }

    const lineHeight = line.lineHeight;

    // text-align
    let curX = x;
    if (textAlign === 'center') {
      curX = x + (contentWidth - line.totalWidth) / 2;
    } else if (textAlign === 'right' || textAlign === 'end') {
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
        scanX += word.width;
      }
      if (currentBoxStyle) {
        emitBox(currentBoxStyle, boxStartX, scanX);
      }
    }

    // Pass 2: emit text words (skip empty padding markers)
    for (const word of line.words) {
      if (word.text === '') {
        // Padding marker — advance position but don't render text
        curX += word.width;
        continue;
      }

      const baselineY = curY + computeBaselineY(ctx, word.style, lineHeight);

      results.push({
        type: 'text',
        text: word.text,
        x: curX,
        y: baselineY,
        width: word.width,
        style: word.style,
      });

      curX += word.width;
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
): { box: LayoutBox; height: number } {
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
    return { box, height: box.height };
  }

  // Table layout
  if (style.display === 'table') {
    const result = layoutTable(ctx, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height };
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
        }
        continue;
      }

      if (isInline(child)) {
        // Wrap consecutive inline children in an anonymous inline context
        // Find all consecutive inline siblings
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
        continue;
      }

      // Block child — collapse margins
      const childMarginTop = child.style.marginTop;
      const collapsed = collapseMargins(prevMarginBottom, childMarginTop);
      curY += collapsed;

      const { box: childBox, height: childTotalHeight } = layoutBlock(
        ctx, child, contentX, curY, contentWidth,
      );
      box.children.push(childBox);
      curY += childTotalHeight;
      prevMarginBottom = child.style.marginBottom;
    }

    // Apply last child's margin-bottom (collapses with parent's padding-bottom in some cases)
    box.height = borderTop + padTop + (curY - contentStartY) + padBottom + borderBottom;
  }

  return { box, height: box.height };
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
