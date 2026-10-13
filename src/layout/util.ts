// Helpers more than one layout phase reads; nothing here calls into a phase.
import type { StyledNode, LayoutText, ResolvedStyle, DecorationEntry } from '../types.js';
import { isTransparent, resolvePercentages } from '../css-resolver.js';

/**
 * Apply text-transform per run, keeping CSS word context across style boundaries: a later
 * capitalize run must not recase the middle of a word.
 */
export function transformTextRuns<T extends {
  text: string;
  style: { textTransform: string };
  wordBoundaryBefore?: boolean;
}>(
  runs: T[],
): T[] {
  if (!runs.some(run => run.style.textTransform !== 'none')) return runs;

  let source = '';
  const offsets = runs.map(run => {
    if (run.wordBoundaryBefore) source += ' ';
    const offset = source.length;
    source += run.text;
    return offset;
  });
  const capitals = new Set<number>();
  for (const match of source.matchAll(/(^|[\s\p{P}\p{S}])(\p{L})/gu)) {
    const boundary = match[1];
    const index = match.index + boundary.length;
    // Apostrophes within a word do not start a new word; opening quotes do.
    if ((boundary === "'" || boundary === '’') &&
      /[\p{L}\p{N}]\p{M}*$/u.test(source.slice(0, index - 1))) continue;
    capitals.add(index);
  }

  return runs.map((run, runIndex) => {
    const transform = run.style.textTransform;
    const text = transform === 'uppercase' ? run.text.toUpperCase()
      : transform === 'lowercase' ? run.text.toLowerCase()
      : transform === 'capitalize'
        ? run.text.replace(/\p{L}/gu, (letter, index) =>
          capitals.has(offsets[runIndex] + index) ? letter.toUpperCase() : letter)
        : run.text;
    return { ...run, text };
  });
}

/** `dst.push(...src)` without spreading: V8 overflows its stack at ~120k arguments. */
export function appendAll<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

export function isInline(node: StyledNode): boolean {
  if (node.tagName === '#text') return true;
  const d = node.style.display;
  return d === 'inline' || d === 'inline-block';
}

export function hasOnlyInlineChildren(node: StyledNode): boolean {
  return node.children.length > 0 && node.children.every(isInline);
}

/**
 * Two entries draw the same band (geometry only; callers compare color their own way).
 * Identity settles the normal case; separate declarers of the same band still match, which
 * keeps a shaping group whole across siblings.
 */
export function sameDecorationBand(a: DecorationEntry, b: DecorationEntry): boolean {
  if (a === b) return true;
  const da = a.declarer, db = b.declarer;
  return (
    da.fontSize === db.fontSize &&
    da.fontFamily === db.fontFamily &&
    da.fontWeight === db.fontWeight &&
    da.fontStyle === db.fontStyle &&
    da.fontVariantCaps === db.fontVariantCaps &&
    // The declarer's vertical-align picks the baseline an underline hangs off.
    da.verticalAlign === db.verticalAlign &&
    // Explicit offset and thickness are band geometry too.
    da.textUnderlineOffset === db.textUnderlineOffset &&
    da.textDecorationThickness === db.textDecorationThickness
  );
}

export function hasVisibleBoxStyles(style: ResolvedStyle): boolean {
  if (!isTransparent(style.backgroundColor)) return true;
  if (style.borderTopWidth > 0 && style.borderTopStyle !== 'none') return true;
  if (style.borderRightWidth > 0 && style.borderRightStyle !== 'none') return true;
  if (style.borderBottomWidth > 0 && style.borderBottomStyle !== 'none') return true;
  if (style.borderLeftWidth > 0 && style.borderLeftStyle !== 'none') return true;
  return false;
}

/** `background-clip:text` with a visible background (gradient or color): the glyphs it
 * covers sample that background instead of painting it as a box. */
export function hasTextClip(style: ResolvedStyle): boolean {
  return style.webkitBackgroundClip === 'text' &&
    ((!!style.backgroundImage && style.backgroundImage !== 'none') ||
      !isTransparent(style.backgroundColor));
}

export function hasStrokeImage(style: ResolvedStyle): boolean {
  return !!style.webkitTextStrokeImage && style.webkitTextStrokeImage !== 'none';
}

/** A box background painted as a box: background-clip:text clips it to glyphs instead. */
export function paintsBoxBackground(style: ResolvedStyle): boolean {
  return !isTransparent(style.backgroundColor) && style.webkitBackgroundClip !== 'text';
}

/** A run's left and right edges (an RTL run's x is its right edge). */
export function textEdges(node: LayoutText): [left: number, right: number] {
  return node.style.direction === 'rtl' ? [node.x - node.width, node.x] : [node.x, node.x + node.width];
}

/**
 * Re-resolve `node`'s children's percentages against `cbWidth`. Inline boxes pass it on to
 * their children; blocks and inline-blocks resolve their own when laid out.
 */
export function resolveChildPercentages(node: StyledNode, cbWidth: number): void {
  for (const child of node.children) {
    if (child.tagName === '#text') continue;
    resolvePercentages(child.style, cbWidth);
    const display = child.style.display;
    if (display === 'inline' || display === 'contents') resolveChildPercentages(child, cbWidth);
  }
}

/**
 * Whitespace that collapses away (no line box). A newline reaching layout is always a
 * forced break, so it makes one.
 */
function isCollapsibleWhitespace(node: StyledNode): boolean {
  if (node.tagName !== '#text') return false;
  const ws = node.style.whiteSpace;
  const text = node.textContent ?? '';
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return text === '';
  return /^[ \t\f]*$/.test(text);
}

/**
 * Whether inline content makes a line box (CSS 2.1 §9.4.2): text, preserved white space, an
 * atomic inline, or an inline with inline-axis margin/border/padding. An empty `<span>` does not.
 */
export function createsLineBox(node: StyledNode): boolean {
  if (node.tagName === '#text') return !isCollapsibleWhitespace(node);
  const s = node.style;
  if (s.display !== 'inline') return true; // an atomic inline
  if (s.marginLeft !== 0 || s.marginRight !== 0 || s.paddingLeft !== 0 ||
      s.paddingRight !== 0 || s.borderLeftWidth !== 0 || s.borderRightWidth !== 0) {
    return true;
  }
  return node.children.some(createsLineBox);
}

export function horizontalFrame(style: ResolvedStyle): number {
  return style.borderLeftWidth + style.paddingLeft +
    style.paddingRight + style.borderRightWidth;
}

export function horizontalMargins(style: ResolvedStyle): number {
  return style.marginLeft + style.marginRight;
}
