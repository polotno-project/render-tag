import type { RenderOptions, RenderResult, LayoutLine, LayoutNode } from './types.ts';
import { parseHTML } from './parse.ts';
import { resolveStyles } from './style-resolver.ts';
import { buildLayoutTree } from './layout.ts';
import { renderNode } from './render.ts';

export type { RenderOptions, RenderResult, LayoutLine };

/**
 * Render an HTML string onto a canvas element using pure 2D canvas API.
 * Fonts must already be loaded on the page before calling this function.
 *
 * @param html - HTML string to render
 * @param options - Rendering options (width is required)
 * @returns The canvas element and computed content height
 */
export function renderHTML(
  html: string,
  options: RenderOptions,
): RenderResult {
  const { width, height, css: extraCSS, pixelRatio = 1, useDomMeasurements = true, debug } = options;

  // 1. Parse HTML and extract CSS
  const { fragment, css } = parseHTML(html, extraCSS);

  // 2. Resolve styles using hidden DOM (getComputedStyle only, no measurements)
  const { tree, cleanup } = resolveStyles(fragment, css, width, height);

  // 3. Create canvas
  const canvas = options.canvas || document.createElement('canvas');
  const tmpCanvas = document.createElement('canvas');
  const ctx = tmpCanvas.getContext('2d')!;
  ctx.fontKerning = 'normal';

  // 4. Build layout tree using pure canvas measurement
  const { root, height: contentHeight } = buildLayoutTree(ctx, tree, width, useDomMeasurements, debug);

  // 5. Size the output canvas
  const finalHeight = height || contentHeight;
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(finalHeight * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${finalHeight}px`;

  const renderCtx = canvas.getContext('2d')!;
  renderCtx.scale(pixelRatio, pixelRatio);

  // 6. Render to canvas
  renderNode(renderCtx, root);

  // 7. Extract lines from layout tree — group by Y with tolerance.
  // Use fontSize as proxy for height when grouping. Sub/sup text has
  // different Y but belongs on the same visual line as parent text.
  const wordPositions: { y: number; fontSize: number; text: string }[] = [];
  function walkLines(node: LayoutNode) {
    if (node.type === 'text' && node.text.trim()) {
      wordPositions.push({ y: node.y, fontSize: node.style.fontSize, text: node.text });
    }
    if (node.type === 'box') {
      for (const child of node.children) walkLines(child);
    }
  }
  walkLines(root);
  wordPositions.sort((a, b) => a.y - b.y);

  const lines: LayoutLine[] = [];
  let lineMaxFontSize = 0;
  for (const wp of wordPositions) {
    const lastLine = lines[lines.length - 1];
    const tolerance = Math.max(lineMaxFontSize, wp.fontSize) * 0.5;
    if (lastLine && Math.abs(wp.y - lastLine.y) < tolerance) {
      lastLine.text += wp.text;
      lineMaxFontSize = Math.max(lineMaxFontSize, wp.fontSize);
    } else {
      lines.push({ y: Math.round(wp.y), text: wp.text });
      lineMaxFontSize = wp.fontSize;
    }
  }

  // 8. Cleanup
  cleanup();

  return { canvas, height: finalHeight, layoutRoot: root, lines };
}
