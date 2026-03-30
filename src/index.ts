import type {
  RenderConfig, RenderResult,
  LayoutConfig, LayoutResult, DrawConfig,
  LayoutLine, LayoutNode, AnyCanvas, AnyContext,
} from './types.js';
import { parseHTML } from './parse.js';
import { resolveStyles } from './style-resolver.js';
import { resolveStylesFromCSS } from './css-resolver.js';
import { buildLayoutTree } from './layout.js';
import { renderNode } from './render.js';

export type { RenderConfig, RenderResult, LayoutConfig, LayoutResult, DrawConfig, LayoutLine };

// ─── Line extraction ─────────────────────────────────────────────────

function extractLines(root: LayoutNode): LayoutLine[] {
  const wordPositions: { y: number; fontSize: number; text: string }[] = [];
  function walk(node: LayoutNode) {
    if (node.type === 'text' && node.text.trim()) {
      wordPositions.push({ y: node.y, fontSize: node.style.fontSize, text: node.text });
    }
    if (node.type === 'box') {
      for (const child of node.children) walk(child);
    }
  }
  walk(root);
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
  return lines;
}

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
    accuracy = 'balanced',
    debug,
  } = config;

  if (!width || width <= 0 || Number.isNaN(width)) {
    throw new TypeError(`layout: width must be a positive number, got ${width}`);
  }

  const useDomMeasurements = accuracy === 'balanced';

  const { fragment, css } = parseHTML(html);

  let tree;
  let cleanup: (() => void) | undefined;

  // Use fast CSS resolver (no DOM insertion of content)
  const resolved = resolveStylesFromCSS(fragment, css, width);
  tree = resolved.tree;
  cleanup = resolved.cleanup;

  const tmpCanvas = document.createElement('canvas');
  const measureCtx = tmpCanvas.getContext('2d')!;
  measureCtx.fontKerning = 'normal';

  const { root, height: contentHeight } = buildLayoutTree(measureCtx, tree, width, useDomMeasurements, debug);
  const finalHeight = height || contentHeight;
  const lines = extractLines(root);

  if (cleanup) cleanup();

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

