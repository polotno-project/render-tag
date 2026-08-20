import type { LayoutNode, LayoutText } from '../../src/types.ts';

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
