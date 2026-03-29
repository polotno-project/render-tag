import type { RenderConfig, RenderOptions, RenderResult, LayoutLine, LayoutNode, AnyCanvas, AnyContext } from './types.js';
import { parseHTML } from './parse.js';
import { resolveStyles } from './style-resolver.js';
import { buildLayoutTree } from './layout.js';
import { renderNode } from './render.js';

export type { RenderConfig, RenderOptions, RenderResult, LayoutLine };

/**
 * Render an HTML string onto a canvas using pure 2D canvas API.
 * Fonts must already be loaded before calling this function.
 */
export function render(config: RenderConfig): RenderResult {
  const {
    html,
    width,
    height,
    pixelRatio = globalThis.devicePixelRatio ?? 1,
    accuracy = 'balanced',
    debug,
  } = config;

  if (!width || width <= 0 || Number.isNaN(width)) {
    throw new TypeError(`render: width must be a positive number, got ${width}`);
  }
  if (config.ctx && config.canvas) {
    throw new TypeError('render: ctx and canvas are mutually exclusive — provide one or neither');
  }

  const useDomMeasurements = accuracy === 'balanced';

  // 1. Parse HTML and extract CSS from <style> tags
  const { fragment, css } = parseHTML(html);

  // 2. Resolve styles using hidden DOM (getComputedStyle only, no measurements)
  const { tree, cleanup } = resolveStyles(fragment, css, width, height);

  // 3. Create temporary canvas for text measurement
  const tmpCanvas = document.createElement('canvas');
  const measureCtx = tmpCanvas.getContext('2d')!;
  measureCtx.fontKerning = 'normal';

  // 4. Build layout tree using pure canvas measurement
  const { root, height: contentHeight } = buildLayoutTree(measureCtx, tree, width, useDomMeasurements, debug);

  // 5. Resolve output canvas and context
  const finalHeight = height || contentHeight;
  let canvas: AnyCanvas;
  let renderCtx: AnyContext;

  if (config.ctx) {
    // User owns the canvas — do NOT resize or scale
    renderCtx = config.ctx;
    canvas = config.ctx.canvas;
  } else if (config.canvas) {
    canvas = config.canvas;
    canvas.width = Math.ceil(width * pixelRatio);
    canvas.height = Math.ceil(finalHeight * pixelRatio);
    if ('style' in canvas) {
      (canvas as HTMLCanvasElement).style.width = `${width}px`;
      (canvas as HTMLCanvasElement).style.height = `${finalHeight}px`;
    }
    renderCtx = canvas.getContext('2d')! as AnyContext;
    renderCtx.scale(pixelRatio, pixelRatio);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * pixelRatio);
    canvas.height = Math.ceil(finalHeight * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${finalHeight}px`;
    renderCtx = canvas.getContext('2d')!;
    renderCtx.scale(pixelRatio, pixelRatio);
  }

  // 6. Render to canvas
  renderNode(renderCtx as CanvasRenderingContext2D, root);

  // 7. Extract lines from layout tree — group by Y with tolerance.
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

/**
 * @deprecated Use `render()` instead.
 */
export function renderHTML(
  html: string,
  options: RenderOptions,
): RenderResult {
  return render({
    html: options.css ? `<style>${options.css}</style>${html}` : html,
    width: options.width,
    height: options.height,
    canvas: options.canvas,
    pixelRatio: options.pixelRatio ?? 1,
    accuracy: options.useDomMeasurements === false ? 'performance' : 'balanced',
    debug: options.debug,
  });
}
