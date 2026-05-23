import type {
  RenderConfig, RenderResult,
  LayoutConfig, LayoutResult, DrawConfig,
  LayoutLine, AnyCanvas, AnyContext,
} from './types.js';
import { parseHTML } from './parse.js';
import { resolveStylesFromCSS } from './css-resolver.js';
import { buildLayoutTree } from './layout.js';
import { renderNode } from './render.js';

export type { RenderConfig, RenderResult, LayoutConfig, LayoutResult, DrawConfig, LayoutLine };

// ─── layout() ────────────────────────────────────────────────────────

/**
 * Compute layout for an HTML string without rendering.
 * Returns a reusable LayoutResult that can be drawn onto multiple targets via drawLayout().
 */
export function layout(config: LayoutConfig): LayoutResult {
  const {
    html,
    width,
    height,
    accuracy = 'performance',
    debug,
  } = config;

  if (!width || width <= 0 || Number.isNaN(width)) {
    throw new TypeError(`layout: width must be a positive number, got ${width}`);
  }

  const useDomMeasurements = accuracy === 'balanced';

  const { fragment, css } = parseHTML(html);
  const { tree, cleanup } = resolveStylesFromCSS(fragment, css, width);

  const tmpCanvas = document.createElement('canvas');
  const measureCtx = tmpCanvas.getContext('2d')!;
  measureCtx.fontKerning = 'normal';

  const { root, height: contentHeight, lines } = buildLayoutTree(measureCtx, tree, width, useDomMeasurements, debug);
  const finalHeight = height || contentHeight;

  cleanup();

  return { layoutRoot: root, height: finalHeight, lines };
}

// ─── drawLayout() ────────────────────────────────────────────────────

/**
 * Draw a pre-computed layout onto a canvas or context.
 * Use with layout() to render the same content onto multiple targets.
 */
export function drawLayout(config: DrawConfig): { canvas: AnyCanvas } {
  const {
    layout: layoutResult,
    width,
    pixelRatio = globalThis.devicePixelRatio ?? 1,
  } = config;

  if (config.ctx && config.canvas) {
    throw new TypeError('drawLayout: ctx and canvas are mutually exclusive — provide one or neither');
  }

  const finalHeight = layoutResult.height;
  let canvas: AnyCanvas;
  let renderCtx: AnyContext;

  if (config.ctx) {
    renderCtx = config.ctx;
    canvas = config.ctx.canvas;
  } else {
    canvas = config.canvas ?? document.createElement('canvas');
    canvas.width = Math.ceil(width * pixelRatio);
    canvas.height = Math.ceil(finalHeight * pixelRatio);
    if ('style' in canvas) {
      (canvas as HTMLCanvasElement).style.width = `${width}px`;
      (canvas as HTMLCanvasElement).style.height = `${finalHeight}px`;
    }
    renderCtx = canvas.getContext('2d')! as AnyContext;
    renderCtx.scale(pixelRatio, pixelRatio);
  }

  renderNode(renderCtx as CanvasRenderingContext2D, layoutResult.layoutRoot);

  return { canvas };
}

// ─── render() ────────────────────────────────────────────────────────

/**
 * Render an HTML string onto a canvas using pure 2D canvas API.
 * Convenience function combining layout() + drawLayout().
 * Fonts must already be loaded before calling this function.
 */
export function render(config: RenderConfig): RenderResult {
  if (config.ctx && config.canvas) {
    throw new TypeError('render: ctx and canvas are mutually exclusive — provide one or neither');
  }

  const layoutResult = layout({
    html: config.html,
    width: config.width,
    height: config.height,
    accuracy: config.accuracy,
    debug: config.debug,
  });

  const { canvas } = drawLayout({
    layout: layoutResult,
    width: config.width,
    ctx: config.ctx,
    canvas: config.canvas,
    pixelRatio: config.pixelRatio,
  });

  return {
    canvas,
    height: layoutResult.height,
    layoutRoot: layoutResult.layoutRoot,
    lines: layoutResult.lines,
  };
}

