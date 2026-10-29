// Block flow: margin collapsing (CSS 2.1 §8.3.1), the block, table and flex container
// layouts (mutually recursive, so one module) and the list marker.
import type { StyledNode, LayoutNode, LayoutBox, ResolvedStyle } from '../types.js';
import {
  borderBoxSize, contentBoxSize, intrinsicStyle, OVERFLOW_X, OVERFLOW_Y, resolvePercentages,
} from '../css-resolver.js';
import { MARKER_LINE_WITHOUT_CONTENT, MIN_HEIGHT_END_MARGINS } from '../engine.js';
import { BULLET_MARKERS, LINE_BASELINE, LINE_TOP, LIST_MARKER, type LayoutSession, type PrivateText } from './session.js';
import {
  appendAll, createsLineBox, hasOnlyInlineChildren, horizontalFrame, isCollapsibleWhitespace, isInline,
  resolveChildPercentages,
} from './util.js';
import { clampSpent, type LineClampState } from './flow.js';
import { layoutInlineContent } from './emit.js';
import { contentSize, flexItems, isFlexRow, minimumContribution } from './prepare.js';
import { flexBaseSize, resolveFlexibleLengths } from './flex.js';

// ── Block layout ──

/**
 * Adjoining vertical margins (CSS 2.1 §8.3.1): the largest positive plus the most negative,
 * which pairwise folding misses (10, -5, 20 is 15).
 */
interface MarginStrut { positive: number; negative: number }

const NO_MARGIN: MarginStrut = { positive: 0, negative: 0 };

function withMargin(strut: MarginStrut, margin: number): MarginStrut {
  return {
    positive: Math.max(strut.positive, margin),
    negative: Math.min(strut.negative, margin),
  };
}

function joinStruts(a: MarginStrut, b: MarginStrut): MarginStrut {
  return {
    positive: Math.max(a.positive, b.positive),
    negative: Math.min(a.negative, b.negative),
  };
}

function strutSize(strut: MarginStrut): number {
  return strut.positive + strut.negative;
}

/**
 * Whether the box roots a block formatting context (its margins never collapse with its
 * children's). Flex items, table cells and the root are told so by their caller.
 */
function establishesBfc(style: ResolvedStyle): boolean {
  const d = style.display;
  if (d !== 'block' && d !== 'list-item') return true; // flex, table, flow-root, ...
  // `overflow` (either axis) other than visible/clip. Private resolver fields.
  const { [OVERFLOW_X]: x, [OVERFLOW_Y]: y } = style as { [OVERFLOW_X]?: string; [OVERFLOW_Y]?: string };
  const scrolls = (v: string | undefined) => v === 'hidden' || v === 'auto' || v === 'scroll';
  return scrolls(x) || scrolls(y);
}

/** A list item whose marker is painted: the marker is content of its own. */
function hasVisibleMarker(node: StyledNode): boolean {
  return node.style.display === 'list-item' && !!node.listMarker && !node.markerHidden;
}

/** An empty list item still holds a line box: its marker's. */
function hasMarkerLine(node: StyledNode): boolean {
  return hasVisibleMarker(node) && node.children.length === 0;
}

/** A block's top margin adjoins its first in-flow child's. */
function topAdjoinsChildren(style: ResolvedStyle): boolean {
  return !establishesBfc(style) && style.paddingTop === 0 && style.borderTopWidth === 0;
}

/** A block's bottom margin can adjoin its last in-flow child's. */
function bottomAdjoinsChildren(style: ResolvedStyle): boolean {
  return !establishesBfc(style) && style.paddingBottom === 0 &&
    style.borderBottomWidth === 0;
}

/**
 * A block whose top and bottom margins adjoin: no line box, padding, border or min-height,
 * and every in-flow child collapses through too.
 */
function collapsesThrough(node: StyledNode): boolean {
  const s = node.style;
  if (establishesBfc(s) || hasVisibleMarker(node) || s.paddingTop !== 0 || s.paddingBottom !== 0 ||
      s.borderTopWidth !== 0 || s.borderBottomWidth !== 0 || s.minHeight > 0) {
    return false;
  }
  return node.children.every((child) =>
    isInline(child) ? !createsLineBox(child) : collapsesThrough(child));
}

/**
 * Every margin adjoining this block's top: its own and, unless padding, border or a BFC
 * intervene, its first in-flow child's, recursively.
 */
function leadingStrut(node: StyledNode, strut: MarginStrut = NO_MARGIN): MarginStrut {
  strut = withMargin(strut, node.style.marginTop);
  if (!topAdjoinsChildren(node.style)) return strut;
  for (const child of node.children) {
    if (isInline(child)) {
      if (!createsLineBox(child)) continue;
      return strut;
    }
    strut = leadingStrut(child, strut);
    if (!collapsesThrough(child)) return strut;
    strut = withMargin(strut, child.style.marginBottom);
  }
  return strut;
}

/**
 * Lay out a block and its children. `y` is the border-box top (the caller resolved the
 * margins above, `leadingStrut`); margins leaving the bottom return as `marginBottomOut`.
 * `bfcRoot`: a BFC root by position (the root, a flex item, a table cell).
 * `usedWidth`: `availableWidth` is the margin box the caller already sized (a flex-row
 * item, a table cell), so a declared width does not override it.
 */
export function layoutBlock(
  session: LayoutSession,
  node: StyledNode,
  x: number,
  y: number,
  availableWidth: number,
  clamp?: LineClampState,
  bfcRoot = false,
  usedWidth = false,
): { box: LayoutBox; height: number; marginBottomOut: MarginStrut } {
  const style = node.style;

  // `-webkit-line-clamp` here starts a line budget shared with descendants (Chrome legacy
  // -webkit-box); an ancestor's clamp wins.
  if (!clamp && style.lineClamp > 0) {
    clamp = { remaining: style.lineClamp, exhausted: false, followed: false };
  }

  const borderTop = style.borderTopWidth;
  const borderBottom = style.borderBottomWidth;
  const padTop = style.paddingTop;
  const padBottom = style.paddingBottom;
  const boxX = x + style.marginLeft;
  // An explicit width sizes the box `box-sizing` names; otherwise the box fills the width.
  let boxWidth: number;
  let contentWidth: number;
  if (style.width > 0 && !usedWidth) {
    const frame = horizontalFrame(style);
    boxWidth = borderBoxSize(style, style.width, frame);
    contentWidth = contentBoxSize(style, style.width, frame);
  } else {
    boxWidth = availableWidth - style.marginLeft - style.marginRight;
    contentWidth = Math.max(0, boxWidth - style.borderLeftWidth - style.borderRightWidth - style.paddingLeft - style.paddingRight);
  }
  const contentX = boxX + style.borderLeftWidth + style.paddingLeft;
  // Its own text-indent/gap and its children's percentages, against the
  // width just settled.
  resolvePercentages(style, contentWidth, true);
  resolveChildPercentages(node, contentWidth);
  const minHeight = style.minHeight > 0
    ? borderBoxSize(style, style.minHeight, borderTop + padTop + padBottom + borderBottom)
    : 0;

  const contentStartY = y + borderTop + padTop;
  const ownMarginOut = withMargin(NO_MARGIN, style.marginBottom);

  const box: LayoutBox = {
    type: 'box',
    style,
    x: boxX,
    y,
    width: boxWidth,
    height: 0, // computed below
    tagName: node.tagName,
    children: [],
    listMarker: node.listMarker,
  };

  if (style.display === 'flex' || style.display === 'table') {
    const result = (style.display === 'flex' ? layoutFlex : layoutTable)(session, node, contentX, contentStartY, contentWidth);
    box.children = result.children;
    box.height = borderTop + padTop + result.height + padBottom + borderBottom;
    return { box, height: box.height, marginBottomOut: ownMarginOut };
  }

  // An empty block has no line boxes, except a list item's outside marker (Chrome, WebKit).
  if (node.children.length === 0) {
    const markerLine = hasMarkerLine(node)
      ? session.measurer.lineHeight(style)
      : 0;
    box.height = borderTop + padTop + markerLine + padBottom + borderBottom;
    if (minHeight > 0) box.height = Math.max(box.height, minHeight);
    return { box, height: box.height, marginBottomOut: ownMarginOut };
  }

  if (hasOnlyInlineChildren(node)) {
    const { nodes, height, lines, lineBoxes } = layoutInlineContent(
      session, node, contentX, contentStartY, contentWidth, clamp);
    appendAll(session.lines, lines);
    box.children = nodes;
    box.lineBoxes = lineBoxes;
    box.height = borderTop + padTop + height + padBottom + borderBottom;
  } else {
    // Stack block children, collapsing margins (CSS 2.1 §8.3.1).
    let curY = contentStartY;
    // Margins collapsed so far and not yet placed: a previous child's bottom
    // margins plus any child that collapsed through since.
    let pending = NO_MARGIN;
    // While no content separates them, the children's top margins adjoin this
    // box's own. The caller folded those into this box's position
    // (`leadingStrut`), so such a child sits at the content top.
    let atTop = !bfcRoot && topAdjoinsChildren(style);
    // The margins of children that collapsed through while `atTop`: they
    // adjoin this box's top, and — when nothing else is in flow — its bottom.
    let throughStrut = NO_MARGIN;
    // Whether content follows this box inside the clamping box; each child adds its later
    // siblings. Chrome counts any box after the cut, even an empty one, but not collapsible
    // white space (WebKit and Gecko count only line boxes; Chrome-first).
    const followedOutside = clamp?.followed ?? false;
    let lastContent = -1;
    if (clamp) {
      lastContent = node.children.length - 1;
      while (lastContent >= 0 && isCollapsibleWhitespace(node.children[lastContent])) lastContent--;
    }

    for (let ci = 0; ci < node.children.length; ci++) {
      const child = node.children[ci];

      // Line-clamp spent: drop everything below the cut, its trailing margin too.
      if (clampSpent(clamp)) {
        pending = NO_MARGIN;
        break;
      }

      if (isInline(child)) {
        const inlineChildren: StyledNode[] = [child];
        while (ci + 1 < node.children.length && isInline(node.children[ci + 1])) inlineChildren.push(node.children[++ci]);
        // Content that makes no line box (collapsible whitespace, an empty
        // inline), so margins keep collapsing across it.
        if (!inlineChildren.some(createsLineBox)) continue;

        if (!atTop) curY += strutSize(pending);
        pending = NO_MARGIN;
        atTop = false;

        const inlineGroup: StyledNode = {
          element: null,
          tagName: 'div',
          style: { ...node.style, display: 'block', marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0 },
          children: inlineChildren,
          textContent: null,
        };
        if (clamp) clamp.followed = followedOutside || ci < lastContent;
        const { nodes, height, lines, lineBoxes } = layoutInlineContent(
          session, inlineGroup, contentX, curY, contentWidth, clamp);
        appendAll(session.lines, lines);
        appendAll(box.children, nodes);
        appendAll(box.lineBoxes ??= [], lineBoxes);
        curY += height;
        continue;
      }

      if (clamp) clamp.followed = followedOutside || ci < lastContent;
      const top = leadingStrut(child);
      if (collapsesThrough(child)) {
        // Its top and bottom margins adjoin: they join the pending run. Its
        // border box sits where it would with a bottom border (§8.3.1) — or
        // at this box's top when its margins collapse with this box's.
        const childY = atTop ? curY : curY + strutSize(joinStruts(pending, top));
        const { box: childBox } = layoutBlock(session, child, contentX, childY, contentWidth, clamp);
        box.children.push(childBox);
        if (!atTop) pending = withMargin(joinStruts(pending, top), child.style.marginBottom);
        else throughStrut = withMargin(joinStruts(throughStrut, top), child.style.marginBottom);
        continue;
      }

      const childY = atTop ? curY : curY + strutSize(joinStruts(pending, top));
      atTop = false;
      const { box: childBox, height: childHeight, marginBottomOut } = layoutBlock(
        session, child, contentX, childY, contentWidth, clamp,
      );
      box.children.push(childBox);
      curY = childY + childHeight;
      // A child truncated by line-clamp clips its trailing margin too.
      pending = clamp?.exhausted ? NO_MARGIN : marginBottomOut;
    }

    // The last child's bottom margins leave through this box's bottom edge
    // unless padding, border or a BFC holds them inside (the layout root
    // holds them: it defines the content height). What a min-height does
    // here is an engine rule: MIN_HEIGHT_END_MARGINS.
    let marginBottomOut = ownMarginOut;
    let contentEnd = curY - contentStartY;
    // A list item with nothing in flow but its marker (MARKER_LINE_WITHOUT_CONTENT).
    if (atTop && hasVisibleMarker(node)) {
      if (!bfcRoot && bottomAdjoinsChildren(style)) pending = throughStrut;
      if (MARKER_LINE_WITHOUT_CONTENT) {
        contentEnd = Math.max(contentEnd, session.measurer.lineHeight(style));
      }
    }
    const raisesBox = style.minHeight > 0 &&
      contentBoxSize(style, style.minHeight, borderTop + padTop + padBottom + borderBottom) > Math.max(0, contentEnd);
    if (!bfcRoot && bottomAdjoinsChildren(style) &&
        !(MIN_HEIGHT_END_MARGINS === 'contain' && style.minHeight > 0)) {
      if (MIN_HEIGHT_END_MARGINS === 'collapse' || !raisesBox) {
        marginBottomOut = withMargin(pending, style.marginBottom);
      }
    } else {
      contentEnd += strutSize(pending);
    }
    contentEnd = Math.max(0, contentEnd);
    box.height = borderTop + padTop + contentEnd + padBottom + borderBottom;
    if (minHeight > 0) box.height = Math.max(box.height, minHeight);
    return { box, height: box.height, marginBottomOut };
  }

  if (minHeight > 0) box.height = Math.max(box.height, minHeight);
  return { box, height: box.height, marginBottomOut: ownMarginOut };
}

// ── Table layout ──

function layoutTable(
  session: LayoutSession,
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

  const rowCells = rows.map(r => r.children.filter(c => c.tagName === 'td' || c.tagName === 'th'));
  const colCount = Math.max(...rowCells.map(cells => cells.length));
  if (colCount === 0) return { children, height: 0 };

  // A column is as wide as its widest declared cell (border box), never under its widest
  // min-content; auto columns share what is left equally. Too wide: declared columns give
  // way toward min-content in proportion to their slack. All declared and short of the
  // table: px columns grow in proportion (percent ones only when there are no px ones).
  const declared: number[] = new Array(colCount).fill(0);
  const minimum: number[] = new Array(colCount).fill(0);
  const percent: boolean[] = new Array(colCount).fill(false);
  for (const cells of rowCells) {
    cells.forEach((cell, i) => {
      resolvePercentages(cell.style, contentWidth);
      const s = cell.style;
      const frame = horizontalFrame(s);
      minimum[i] = Math.max(minimum[i], frame + contentSize(session, cell, false));
      if (s.width > 0) {
        declared[i] = Math.max(declared[i], borderBoxSize(s, s.width, frame));
        // A percentage width is 0 in the intrinsic style.
        percent[i] ||= intrinsicStyle(s).width === 0;
      }
    });
  }
  const sum = (ws: number[]) => ws.reduce((total, w) => total + w, 0);
  const isAuto = declared.map(w => w === 0);
  const colWidths = declared.map((w, i) => Math.max(w, minimum[i]));
  const autoCount = isAuto.filter(Boolean).length;
  const excess = sum(colWidths) - contentWidth;
  if (excess > 0) {
    const slack = colWidths.map((w, i) => w - minimum[i]);
    const slackTotal = sum(slack);
    if (slackTotal > 0) {
      const give = Math.min(excess, slackTotal);
      colWidths.forEach((w, i) => { colWidths[i] = w - give * slack[i] / slackTotal; });
    }
  } else if (autoCount > 0) {
    const autoWidth = (contentWidth - sum(colWidths.filter((_, i) => !isAuto[i]))) / autoCount;
    colWidths.forEach((w, i) => { if (isAuto[i]) colWidths[i] = Math.max(w, autoWidth); });
  } else if (excess < 0) {
    const grows = percent.every(Boolean) ? percent : percent.map(p => !p);
    const growTotal = sum(colWidths.filter((_, i) => grows[i]));
    colWidths.forEach((w, i) => { if (grows[i]) colWidths[i] = w - excess * w / growTotal; });
  }
  const colX: number[] = [];
  for (let i = 0, x = contentX; i < colCount; x += colWidths[i++]) colX.push(x);

  let curY = contentY;

  for (const cells of rowCells) {
    let maxCellHeight = 0;
    const cellBoxes: LayoutBox[] = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];

      const { box: cellBox, height: cellHeight } = layoutBlock(session, cell, colX[i], curY, colWidths[i], undefined, true, true);
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

// ── Flex layout ──

function layoutFlex(
  session: LayoutSession,
  node: StyledNode,
  contentX: number,
  contentY: number,
  contentWidth: number,
): { children: LayoutNode[]; height: number } {
  const style = node.style;
  const gap = style.gap;
  const children: LayoutNode[] = [];

  const flexChildren = flexItems(session, node);
  if (flexChildren.length === 0) return { children, height: 0 };

  if (isFlexRow(style)) {
    const totalGaps = gap * (flexChildren.length - 1);
    const available = Math.max(0, contentWidth - totalGaps);
    // If the minima themselves do not fit, they overflow the container exactly
    // as native flex items with min-width:auto do.
    const widths = resolveFlexibleLengths(
      flexChildren.map((child) => child.style),
      flexChildren.map((child) => flexBaseSize(session, child, contentWidth)),
      flexChildren.map((child) => minimumContribution(session, child, child.style)),
      available,
    );

    let curX = contentX;
    let maxHeight = 0;

    for (let index = 0; index < flexChildren.length; index++) {
      const child = flexChildren[index];
      const childWidth = widths[index];

      const { box, height } = layoutBlock(session, child, curX, contentY, childWidth, undefined, true, true);
      children.push(box);
      maxHeight = Math.max(maxHeight, height);
      curX += childWidth + gap;
    }

    return { children, height: maxHeight };
  }

  // Column layout (fallback)
  let curY = contentY;
  for (const child of flexChildren) {
    const { box, height } = layoutBlock(session, child, contentX, curY, contentWidth, undefined, true);
    children.push(box);
    curY += height + gap;
  }
  return { children, height: curY - contentY };
}

// ── List marker layout ──

/** Add list marker to a layout box if applicable. */
export function addListMarker(
  session: LayoutSession,
  box: LayoutBox,
  node: StyledNode,
): void {
  if (!node.listMarker) return;
  // `::marker { content: none }` suppresses the marker.
  if (node.markerHidden) return;

  const style = node.style;
  // `markerStyle` holds only the fields `::marker` rules changed.
  const ms = node.markerStyle;
  const isBullet = BULLET_MARKERS.has(style.listStyleType);
  let markerStyleObj: ResolvedStyle = ms ? { ...style, ...ms } : style;
  // A bullet stands in for Chrome's synthetic disc, which no weight or slant changes.
  if (isBullet && (markerStyleObj.fontWeight !== 400 || markerStyleObj.fontStyle !== 'normal')) {
    markerStyleObj = { ...markerStyleObj, fontWeight: 400, fontStyle: 'normal' };
  }

  // The marker measures in its own style, as it is painted.
  const m = session.measurer;
  const markerState = m.stateOf(markerStyleObj);
  // ascent + descent is the li's line-height by construction, so one call
  // gives both the marker's baseline and the box it reports.
  const strut = m.leadedBox(style);
  const baselineY = box.y + style.borderTopWidth + style.paddingTop + strut.ascent;

  const markerWidth = m.width(markerState, node.listMarker);
  const isRTL = style.direction === 'rtl';
  // Marker gap, matching Chrome: a bullet's ink ends 7px + ascent/3 before the content,
  // centered ascent/3 above the baseline; a text marker ("1.") is one space advance away.
  // `::marker` padding-inline-end overrides the gap.
  const explicitGap = isRTL ? ms?.paddingLeft : ms?.paddingRight;

  let markerX: number;
  let markerY = baselineY;
  let markerDirection = 'ltr';
  // What the glyph is DRAWN at: numbers at the li font-size, bullets scaled (below).
  let markerFontSize = markerStyleObj.fontSize;
  let markerDrawWidth = markerWidth;
  const contentStartX = box.x + style.borderLeftWidth + style.paddingLeft;
  const boxRightEdge = box.x + box.width;
  if (isBullet) {
    const { ascent } = m.metrics(markerStyleObj);
    const ink = m.inkBox(markerState, node.listMarker);
    // Blink's marker unit (a 2/3-ascent box, half-filled): disc diameter, gap and centering.
    const markerUnit = ascent / 3;
    const gap = explicitGap !== undefined ? explicitGap : 7 + markerUnit;
    // Chrome paints a SYNTHETIC disc, larger than the font's '•' (Roboto ~0.22em vs ~0.31em):
    // scale the glyph so its ink height is markerUnit, keeping it a text node.
    const inkH = ink.ascent + ink.descent;
    const scale = inkH > 0 ? markerUnit / inkH : 1;
    const inkRight = ink.right * scale;
    const inkLeft = ink.left * scale;
    const glyphInkCenter = ((ink.ascent - ink.descent) / 2) * scale;
    if (isRTL) {
      // ink.left is positive when ink extends left of origin
      markerX = boxRightEdge + gap + inkLeft;
    } else {
      markerX = contentStartX - gap - inkRight;
    }
    markerY = baselineY - markerUnit + glyphInkCenter;
    markerFontSize = markerStyleObj.fontSize * scale;
    markerDrawWidth = markerWidth * scale;
  } else {
    const gap = explicitGap !== undefined
      ? explicitGap
      : m.width(markerState, ' ');
    if (isRTL) {
      // RTL: marker right of the li; a numbered one paints RTL (".1") with x as its right edge.
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

  const marker: PrivateText = {
    type: 'text',
    text: node.listMarker,
    x: markerX,
    y: markerY,
    width: markerDrawWidth,
    // One spread: the marker's own style object (the paint-runs seam logic keys on identity).
    style: { ...markerStyleObj, fontSize: markerFontSize, textDecorationLine: 'none', textDecorations: [], direction: markerDirection },
  };
  // The marker sits on the item's first line, whose top is the content top. bounds.width is
  // the scaled glyph ADVANCE, not its ink.
  const bounds = {
    x: markerDirection === 'rtl' ? markerX - markerDrawWidth : markerX,
    y: box.y + style.borderTopWidth + style.paddingTop,
    width: markerDrawWidth,
    height: strut.ascent + strut.descent,
  };
  marker[LINE_TOP] = bounds.y;
  if (session.units) marker[LIST_MARKER] = { ...bounds, endedByHardBreak: false, [LINE_BASELINE]: baselineY };
  box.children.unshift(marker);

  // Publish the marker as a LayoutLine too, merged with its item's text by baseline.
  session.lines.push({ y: Math.round(baselineY), text: node.listMarker, bounds });
}
