import type {
  RenderConfig, RenderResult,
  LayoutConfig, LayoutResult, DrawConfig,
  LayoutLine, AnyCanvas, AnyContext,
} from './types.js';
import { buildLayoutTree, styleTree } from './layout.js';
import { renderNode, getNodePaintBounds } from './render.js';
import { measurePaintBounds, type PaintBounds } from './shadow.js';
export type { PaintBounds } from './shadow.js';

export type { RenderConfig, RenderResult, LayoutConfig, LayoutResult, DrawConfig, LayoutLine };
// The layout tree's node types — the shape of `LayoutResult.layoutRoot`, so
// external renderers consume a versioned contract instead of reverse-
// engineering it.
export type {
  LayoutBox, LayoutLineBox, LayoutText, LayoutNode, ResolvedStyle, DecorationEntry, BorderRadius,
  CanvasFactory, ShadowOptions,
} from './types.js';
export { setDOMParser, type DOMParserLike } from './dom.js';
export { lineBaselineOffset, getFontMetrics, tabStopMetrics } from './layout.js';
import { createFallbackMeasureCtx } from './dom.js';

// Reused across layout() calls: every measurement writes its own font state.
let defaultMeasureCtx: CanvasRenderingContext2D | null = null;

/**
 * Compute layout for an HTML string without rendering.
 * Returns a reusable LayoutResult that can be drawn onto multiple targets via drawLayout().
 */
export function layout(config: LayoutConfig): LayoutResult {
  const { html, width, height } = config;

  if (!width || width <= 0 || Number.isNaN(width)) {
    throw new TypeError(`layout: width must be a positive number, got ${width}`);
  }

  // No save/restore on a caller's ctx: it is not free on PDF proxies.
  const measureCtx =
    (config.ctx as CanvasRenderingContext2D | undefined) ??
    (defaultMeasureCtx ??= createFallbackMeasureCtx(true));

  // Without a height, vh falls back to the width (a square viewport).
  const tree = styleTree(html, measureCtx, width, { width, height: height || width });
  const { root, height: contentHeight, lines } =
    buildLayoutTree(measureCtx, tree, width, config.accuracy === 'balanced', config.debug);
  let paintBounds: PaintBounds | undefined;
  return {
    layoutRoot: root, height: height || contentHeight, lines,
    get paintBounds() {
      return paintBounds ??= measurePaintBounds(measureCtx, () => getNodePaintBounds(measureCtx, root));
    },
  };
}

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
    if (!config.canvas && typeof document === 'undefined') {
      throw new Error(
        'render-tag: drawLayout cannot create a canvas in a non-browser environment — pass ctx or canvas.'
      );
    }
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

  // `pixelRatio` doubles as the device scale paint assumes for a caller's
  // ctx too (WebKit decorations round on the device grid).
  renderNode(renderCtx as CanvasRenderingContext2D, layoutResult.layoutRoot, { ...config, pixelRatio });

  return { canvas };
}

/**
 * Render an HTML string onto a canvas using pure 2D canvas API.
 * Convenience function combining layout() + drawLayout().
 * Fonts must already be loaded before calling this function.
 */
export function render(config: RenderConfig): RenderResult {
  if (config.ctx && config.canvas) {
    throw new TypeError('render: ctx and canvas are mutually exclusive — provide one or neither');
  }

  // The output ctx doubles as the measurement ctx.
  const layoutResult = layout(config);
  const { canvas } = drawLayout({ ...config, layout: layoutResult });

  return Object.assign(layoutResult, { canvas });
}
