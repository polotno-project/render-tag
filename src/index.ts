import type {
  RenderConfig, RenderResult,
  LayoutConfig, LayoutResult, DrawConfig,
  LayoutLine, AnyCanvas, AnyContext,
} from './types.js';
import { parseHTML } from './parse.js';
import { resolveStylesFromCSS } from './css-resolver.js';
import { buildLayoutTree, Measurer } from './layout.js';
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

// Default measurement context, created lazily and reused across layout()
// calls — safe because font/letterSpacing state is set before every
// measurement anyway. Browser-first source keeps measurement identical to
// previous releases.
let defaultMeasureCtx: CanvasRenderingContext2D | null = null;

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

  // Caller-provided ctx is mutated (font, fontKerning, letterSpacing, and a
  // non-zero wordSpacing reset to 0px) and intentionally NOT save/restored —
  // save/restore is not free on all contexts (e.g. PDF proxies emit stream
  // operators for it). A `Measurer` is the only writer.
  const measureCtx =
    (config.ctx as CanvasRenderingContext2D | undefined) ??
    (defaultMeasureCtx ??= createFallbackMeasureCtx(true));

  const { fragment, css } = parseHTML(html);
  // The viewport (vw/vh) is the layout box: `width` x `height`. Without a
  // height there is no viewport height yet (the content decides it), so vh
  // falls back to the width — a square viewport.
  let unitMeasurer: Measurer | undefined;
  const tree = resolveStylesFromCSS(fragment, css, width, {
    viewport: { width, height: height || width },
    // ch/ex: measured only when a declaration uses them.
    fontUnits: (style) => (unitMeasurer ??= new Measurer(measureCtx, new Map())).fontUnits(style),
  });

  const { root, height: contentHeight, lines } = buildLayoutTree(measureCtx, tree, width, useDomMeasurements, debug);
  const finalHeight = height || contentHeight;

  let paintBounds: PaintBounds | undefined;
  return {
    layoutRoot: root, height: finalHeight, lines,
    get paintBounds() {
      return paintBounds ??= measurePaintBounds(measureCtx, () => getNodePaintBounds(measureCtx, root));
    },
  };
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

  // The output ctx doubles as the measurement ctx (same font resolution for
  // measuring and drawing — required in non-browser environments).
  const layoutResult = layout({
    html: config.html,
    width: config.width,
    height: config.height,
    accuracy: config.accuracy,
    debug: config.debug,
    ctx: config.ctx,
  });

  const { canvas } = drawLayout({
    layout: layoutResult,
    width: config.width,
    ctx: config.ctx,
    canvas: config.canvas,
    pixelRatio: config.pixelRatio,
    createCanvas: config.createCanvas,
    renderShadows: config.renderShadows,
  });

  return Object.assign(layoutResult, { canvas });
}
