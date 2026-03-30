export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderConfig {
  /** HTML string to render (include <style> tags for CSS) */
  html: string;
  /** Width of the rendering area in CSS pixels */
  width: number;
  /** Height of the rendering area in CSS pixels (auto-sized from content if omitted) */
  height?: number;
  /**
   * Existing 2D rendering context to draw onto.
   * When provided, render-tag draws directly onto this context without resizing the canvas.
   * Mutually exclusive with `canvas`.
   */
  ctx?: AnyContext;
  /**
   * Target canvas element (created if not provided).
   * Mutually exclusive with `ctx`.
   */
  canvas?: AnyCanvas;
  /** Device pixel ratio (default: globalThis.devicePixelRatio ?? 1) */
  pixelRatio?: number;
  /**
   * Measurement accuracy mode (default: 'performance').
   * - 'performance' — pure canvas API measurements only. Faster, no DOM touches,
   *   and more consistent canvas output across browsers.
   * - 'balanced' — uses hidden DOM probes for line heights. Matches each browser's
   *   native DOM rendering more closely, but produces slightly different canvas
   *   output in Firefox vs Chrome.
   */
  accuracy?: 'balanced' | 'performance';
  /**
   * Debug callback for layout diagnostics. Receives structured log entries
   * during text measurement, wrapping decisions, and positioning.
   */
  debug?: (entry: DebugEntry) => void;
}

export interface LayoutConfig {
  /** HTML string to render (include <style> tags for CSS) */
  html: string;
  /** Width of the rendering area in CSS pixels */
  width: number;
  /** Height override in CSS pixels (auto-sized from content if omitted) */
  height?: number;
  /**
   * Measurement accuracy mode (default: 'performance').
   * - 'performance' — pure canvas API measurements only.
   * - 'balanced' — uses hidden DOM probes for line heights.
   */
  accuracy?: 'balanced' | 'performance';
  /** Debug callback for layout diagnostics */
  debug?: (entry: DebugEntry) => void;
}

export interface LayoutResult {
  /** The layout tree root */
  layoutRoot: LayoutBox;
  /** Content height in CSS pixels */
  height: number;
  /** Text lines grouped by Y coordinate */
  lines: LayoutLine[];
}

export interface DrawConfig {
  /** Layout result from layout() */
  layout: LayoutResult;
  /** Width used during layout (must match) */
  width: number;
  /**
   * Existing 2D rendering context to draw onto.
   * No resizing or scaling applied. Mutually exclusive with `canvas`.
   */
  ctx?: AnyContext;
  /**
   * Target canvas element (created if not provided).
   * Mutually exclusive with `ctx`.
   */
  canvas?: AnyCanvas;
  /** Device pixel ratio (default: globalThis.devicePixelRatio ?? 1) */
  pixelRatio?: number;
}

export interface DebugEntry {
  type: 'measure-word' | 'line-wrap' | 'line-commit' | 'position-text';
  /** Human-readable description */
  message: string;
  /** Relevant data */
  data: Record<string, unknown>;
}

/** A text line extracted from the layout tree */
export interface LayoutLine {
  /** Y coordinate of the text baseline */
  y: number;
  /** Concatenated text content on this line */
  text: string;
}

export interface RenderResult {
  /** The canvas that was rendered onto */
  canvas: AnyCanvas;
  /** Content height in CSS pixels after layout */
  height: number;
  /** The layout tree root — stable API for inspection and testing */
  layoutRoot: LayoutBox;
  /** Text lines grouped by Y coordinate — stable API */
  lines: LayoutLine[];
}

/** Resolved style for a single element — all values in px / concrete strings */
export interface ResolvedStyle {
  // Text
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  color: string;
  textAlign: string;
  textTransform: string;
  textDecorationLine: string;
  textDecorationStyle: string;
  textDecorationColor: string;
  textShadow: string;
  webkitTextStrokeWidth: number;
  webkitTextStrokeColor: string;
  webkitTextFillColor: string;
  webkitBackgroundClip: string;
  backgroundImage: string;
  letterSpacing: number;
  wordSpacing: number;
  fontKerning: string;
  lineHeight: number;
  verticalAlign: string;
  whiteSpace: string;
  wordBreak: string;
  overflowWrap: string;
  direction: string;

  // Box
  display: string;
  width: number; // 0 = auto
  minHeight: number; // 0 = none
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  backgroundColor: string;

  // Border
  borderTopWidth: number;
  borderTopColor: string;
  borderTopStyle: string;
  borderRightWidth: number;
  borderRightColor: string;
  borderRightStyle: string;
  borderBottomWidth: number;
  borderBottomColor: string;
  borderBottomStyle: string;
  borderLeftWidth: number;
  borderLeftColor: string;
  borderLeftStyle: string;

  // Flex
  flexDirection: string;
  gap: number;
  flexGrow: number;

  // List
  listStyleType: string;
}

/** A node in our styled tree (no positions — layout computes those) */
export interface StyledNode {
  /** Original DOM element (null for text nodes) */
  element: Element | null;
  /** Tag name in lowercase, '#text' for text nodes */
  tagName: string;
  /** Resolved CSS style */
  style: ResolvedStyle;
  /** Child nodes */
  children: StyledNode[];
  /** Text content (only for text nodes) */
  textContent: string | null;
  /** For list items: the marker text (e.g. "•", "1.") */
  listMarker?: string;
}

/** A positioned text run ready for canvas rendering */
export interface LayoutText {
  type: 'text';
  text: string;
  x: number;
  y: number; // baseline y
  width: number;
  style: ResolvedStyle;
}

/** A positioned box (element) */
export interface LayoutBox {
  type: 'box';
  style: ResolvedStyle;
  x: number;
  y: number;
  width: number;
  height: number;
  tagName: string;
  children: LayoutNode[];
  listMarker?: string;
}

export type LayoutNode = LayoutText | LayoutBox;
