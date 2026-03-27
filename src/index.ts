import type { RenderOptions, RenderResult } from './types.ts';
import { parseHTML } from './parse.ts';
import { resolveStyles } from './style-resolver.ts';
import { buildLayoutTree } from './layout.ts';
import { renderNode } from './render.ts';

export type { RenderOptions, RenderResult };

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
  const { width, height, css: extraCSS, pixelRatio = 1 } = options;

  // 1. Parse HTML and extract CSS
  const { fragment, css } = parseHTML(html, extraCSS);

  // 2. Resolve styles using hidden DOM (getComputedStyle only, no measurements)
  const { tree, cleanup } = resolveStyles(fragment, css, width, height);

  // 3. Create canvas
  const canvas = options.canvas || document.createElement('canvas');
  const tmpCanvas = document.createElement('canvas');
  const ctx = tmpCanvas.getContext('2d')!;

  // 4. Build layout tree using pure canvas measurement
  const { root, height: contentHeight } = buildLayoutTree(ctx, tree, width);

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

  // 7. Cleanup
  cleanup();

  return { canvas, height: finalHeight };
}
