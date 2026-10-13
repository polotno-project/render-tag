// Flex sizing (CSS Flexbox §9.7): base sizes and flexible-length resolution over outer widths.
import type { StyledNode, ResolvedStyle } from '../types.js';
import { borderBoxSize, FLEX_BASIS_KEYWORD } from '../css-resolver.js';
import type { LayoutSession } from './session.js';
import { horizontalFrame, horizontalMargins } from './util.js';
import { contentSize, maximumContribution } from './prepare.js';

/**
 * Flex base size as an outer width: `flex-basis` (sizing the `box-sizing` box), or for
 * `auto` the item's max-content. `flex: 1` makes it 0, so grow factors alone split the row.
 * `min-content` is the min-content size; `fit-content` is max-content clamped to the
 * container's `inner` width, but not under min-content.
 */
export function flexBaseSize(session: LayoutSession, node: StyledNode, inner: number): number {
  const style = node.style;
  const keyword = (style as { [FLEX_BASIS_KEYWORD]?: string })[FLEX_BASIS_KEYWORD];
  if (keyword) {
    const outer = horizontalMargins(style) + horizontalFrame(style);
    const min = contentSize(session, node, false);
    return outer + (keyword === 'min-content'
      ? min
      : Math.min(contentSize(session, node, true), Math.max(min, inner - outer)));
  }
  return style.flexBasis !== null
    ? horizontalMargins(style) + borderBoxSize(style, style.flexBasis, horizontalFrame(style))
    : maximumContribution(session, node, style);
}

/**
 * Flexible length resolution over outer widths (CSS Flexbox §9.7): each pass shares the
 * free space and freezes items under their automatic minimum, until none is clamped.
 * flex-parity.
 */
export function resolveFlexibleLengths(
  styles: ResolvedStyle[],
  bases: number[],
  minimums: number[],
  available: number,
): number[] {
  const sizes = bases.map((base, index) => Math.max(base, minimums[index]));
  const growing = sizes.reduce((sum, size) => sum + size, 0) < available;
  const factor = (index: number) =>
    growing ? styles[index].flexGrow : styles[index].flexShrink;
  const frozen = sizes.map((size, index) =>
    factor(index) === 0 || (!growing && bases[index] < size));

  for (;;) {
    const unfrozen = sizes.map((_, index) => index).filter((index) => !frozen[index]);
    if (unfrozen.length === 0) break;
    const used = sizes.reduce(
      (sum, size, index) => sum + (frozen[index] ? size : bases[index]),
      0,
    );
    const remaining = available - used;
    // Shrinking is weighted by base size, so a big item gives up more than a
    // small one at the same shrink factor; growing is not.
    const weights = unfrozen.map((index) =>
      growing ? styles[index].flexGrow : styles[index].flexShrink * bases[index]);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    if (weightSum <= 0) break;
    unfrozen.forEach((index, slot) => {
      sizes[index] = bases[index] + remaining * weights[slot] / weightSum;
    });
    const violators = unfrozen.filter((index) => sizes[index] < minimums[index]);
    if (violators.length === 0) break;
    for (const index of violators) {
      sizes[index] = minimums[index];
      frozen[index] = true;
    }
  }
  return sizes;
}
