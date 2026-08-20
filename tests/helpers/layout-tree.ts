import type { LayoutBox, LayoutNode, LayoutText } from '../../src/types.ts';

/**
 * Every text run in a layout tree, in order.
 *
 * Five suites had written this walk out; a layout assertion almost always
 * starts with it, so it lives here once.
 */
export function collectTexts(node: LayoutNode): LayoutText[] {
  if (node.type === 'text') return [node];
  const texts: LayoutText[] = [];
  for (const child of node.children) texts.push(...collectTexts(child));
  return texts;
}

/** Every inline box (a `LayoutBox` whose tagName is `span`) in the tree. */
export function collectInlineBoxes(node: LayoutNode): LayoutBox[] {
  if (node.type === 'text') return [];
  const boxes: LayoutBox[] = node.tagName === 'span' ? [node] : [];
  for (const child of node.children) boxes.push(...collectInlineBoxes(child));
  return boxes;
}
