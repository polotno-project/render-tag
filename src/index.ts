import type { RenderOptions, RenderResult } from './types.ts';
import { parseHTML } from './parse.ts';
import { loadFonts } from './font-loader.ts';
import { resolveStyles } from './style-resolver.ts';
import { buildLayoutTree } from './layout.ts';
import { renderNode } from './render.ts';

export type { RenderOptions, RenderResult };

/**
 * Render an HTML string onto a canvas element using pure 2D canvas API.
 *
 * @param html - HTML string to render
 * @param options - Rendering options (width is required)
 * @returns The canvas element and computed content height
 */
export async function renderHTML(
  html: string,
  options: RenderOptions,
): Promise<RenderResult> {
  const { width, height, css: extraCSS, pixelRatio = 1 } = options;

  // 1. Parse HTML and extract CSS
  const { fragment, css } = parseHTML(html, extraCSS);

  // 2. Load fonts from CSS @font-face rules
  const cleanupFonts = await loadFonts(css);

  // 3. Resolve styles using hidden DOM (getComputedStyle only, no measurements)
  const { tree, cleanup: cleanupDOM } = await resolveStyles(
    fragment, css, width, height,
  );

  // 4. Create canvas
  const canvas = options.canvas || document.createElement('canvas');
  // Use a temporary canvas for measurement
  const tmpCanvas = document.createElement('canvas');
  const ctx = tmpCanvas.getContext('2d')!;

  // 5. Build layout tree using pure canvas measurement
  const { root, height: contentHeight } = buildLayoutTree(ctx, tree, width);

  // 6. Size the output canvas
  const finalHeight = height || contentHeight;
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(finalHeight * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${finalHeight}px`;

  const renderCtx = canvas.getContext('2d')!;
  renderCtx.scale(pixelRatio, pixelRatio);

  // 7. Render to canvas
  renderNode(renderCtx, root);

  // 8. Cleanup
  cleanupDOM();
  cleanupFonts();

  return { canvas, height: finalHeight };
}
