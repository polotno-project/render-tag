// Layout entry: the public surface (`src/index.ts`, render, path, tests) and `buildLayoutTree`.
// The phases live in `src/layout/`; imports there only point down session → util → segment →
// flow → prepare → emit → flex → block, so no value import is circular.
import type { StyledNode, LayoutBox, LayoutLine } from './types.js';
import { resolveStylesFromCSS } from './css-resolver.js';
import { parseHTML } from './parse.js';
import { layoutFontMetrics, Measurer, type FontMetricsTable, type LayoutSession, type LayoutStats } from './layout/session.js';
import { isInline } from './layout/util.js';
import { addListMarker, layoutBlock } from './layout/block.js';

export {
  buildCanvasFont, canvasKerning, claimCtx, formatLetterSpacing, getFontMetrics, isShiftedVAlign,
  layoutFontMetrics, lineBaselineOffset, Measurer, nextCtxWriterId, paintLineSnap, startsMeasuredRun,
  tabStopMetrics,
  type FontMetricsTable, type LayoutStats, type MeasureState,
} from './layout/session.js';
export {
  hasStrokeImage, hasTextClip, paintsBoxBackground, sameDecorationBand, textEdges, transformTextRuns,
} from './layout/util.js';
export { graphemes } from './layout/segment.js';

// ── Main entry ──

/** Parse `html` and resolve its styles; ch/ex measure on `ctx` only when used. */
export function styleTree(
  html: string, ctx: CanvasRenderingContext2D, width: number,
  viewport?: { width: number; height: number },
): StyledNode {
  const { fragment, css } = parseHTML(html);
  let unitMeasurer: Measurer | undefined;
  return resolveStylesFromCSS(fragment, css, width, {
    viewport,
    fontUnits: (style) => (unitMeasurer ??= new Measurer(ctx, new Map())).fontUnits(style),
  });
}

/** Build the layout tree from the styled tree with canvas measurement only. */
export function buildLayoutTree(
  ctx: CanvasRenderingContext2D,
  styledTree: StyledNode,
  containerWidth: number,
  useDomMeasurements: boolean,
  debug?: (entry: import('./types.ts').DebugEntry) => void,
  stats?: LayoutStats,
): { root: LayoutBox; height: number; lines: LayoutLine[] } {
  // Everything starts empty with the call: fonts may have loaded since the last one.
  const fontMetrics: FontMetricsTable = new Map();
  const session: LayoutSession = {
    measurer: new Measurer(ctx, fontMetrics, useDomMeasurements),
    debug,
    lines: [],
    minContent: new Map(),
    maxContent: new Map(),
    anonymousFlexItems: new Map(),
    prepared: new Map(),
    flippedDirection: new Map(),
    stats,
  };
  // The styledTree root is our container div — layout its children as a block flow
  const { box, height } = layoutBlock(session, styledTree, 0, 0, containerWidth, undefined, true);

  addListMarkersRecursive(session, box, styledTree);

  // By baseline, then left edge: cross-cell content merges in reading order, markers first.
  const sorted = session.lines.sort((a, b) =>
    (a.y - b.y) || (a.bounds.x - b.bounds.x)
  );
  const lines: LayoutLine[] = [];
  for (const candidate of sorted) {
    const last = lines[lines.length - 1];
    // Two baselines are one row within half the SHORTER line's height, as the DOM reference
    // groups (`overlap / minH`); max() or the candidate alone leaks across rows.
    const tolerance = Math.min(last?.bounds.height ?? Infinity,
      candidate.bounds.height) * 0.5;
    if (last && Math.abs(candidate.y - last.y) < tolerance) {
      // Cross-cell merge: separate with a space unless either side has one.
      const needsSep = last.text.length > 0 && candidate.text.length > 0 &&
        !/\s$/.test(last.text) && !/^\s/.test(candidate.text);
      last.text += (needsSep ? ' ' : '') + candidate.text;
      // Carry the baseline forward so the next comparison uses the group's running edge.
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
  layoutFontMetrics.set(box, fontMetrics);
  return { root: box, height, lines };
}

function addListMarkersRecursive(
  session: LayoutSession,
  box: LayoutBox,
  node: StyledNode,
): void {
  addListMarker(session, box, node);

  // box.children may hold extra text/inline nodes: walk both in parallel.
  let boxChildIdx = 0;
  for (const styledChild of node.children) {
    if (isInline(styledChild)) {
      continue;
    }
    // Find the matching LayoutBox
    while (boxChildIdx < box.children.length) {
      const layoutChild = box.children[boxChildIdx];
      if (layoutChild.type === 'box' && layoutChild.tagName === styledChild.tagName) {
        addListMarkersRecursive(session, layoutChild, styledChild);
        boxChildIdx++;
        break;
      }
      boxChildIdx++;
    }
  }
}
