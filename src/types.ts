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
   * 2D context used for text measurement. Optional in the browser (a hidden
   * canvas is created); required in non-browser environments. render-tag
   * mutates its font/fontKerning state and performs no save/restore.
   */
  ctx?: AnyContext;
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
  /**
   * Line-box geometry in canvas coordinates. Shape matches `DOMRect` — drop-in
   * replacement for `Range.getClientRects()` when drawing per-line backgrounds.
   * `bounds.y` is the top of the line box (not the baseline); `bounds.height`
   * is the effective line height including any super/sub expansion.
   */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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

/**
 * One text decoration with the color/style of the element that DECLARED it.
 * CSS text-decoration is not inherited: the declaring element paints the line
 * across its in-flow descendants using its own color/style. Descendants carry
 * ancestors' entries (plus their own) so the painter can reproduce that —
 * e.g. a parent's red underline stays red across a blue child <s>.
 */
export interface DecorationEntry {
  /** 'underline' | 'line-through' | 'overline' */
  line: string;
  color: string;
  /** 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy' */
  style: string;
}

/** Resolved style for a single element — all values in px / concrete strings */
export interface ResolvedStyle {
  // Text
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /** font-variant-caps: 'normal' | 'small-caps' (only small-caps is rendered). */
  fontVariantCaps: string;
  color: string;
  textAlign: string;
  textAlignLast: string;
  textIndent: number;
  textTransform: string;
  textDecorationLine: string;
  textDecorationStyle: string;
  textDecorationColor: string;
  /** Own + ancestor decorations, each with its ORIGIN's color/style (paint
   * order: ancestors first). `textDecorationLine` stays the union of entry
   * lines for cheap "has any decoration" checks and run merging. */
  textDecorations: DecorationEntry[];
  textShadow: string;
  webkitTextStrokeWidth: number;
  webkitTextStrokeColor: string;
  /** A gradient to paint the -webkit-text-stroke with (CSS can't put a gradient
   * on a text stroke). Read from the `--rt-text-stroke-image` custom property (a
   * real property name would be dropped from inline cssText by the browser).
   * render-tag builds a CanvasGradient for the stroke, spanning the declaring
   * element like a background-clip:text fill gradient. 'none' = solid stroke via
   * webkitTextStrokeColor. */
  webkitTextStrokeImage: string;
  webkitTextFillColor: string;
  paintOrder: string;
  /** Corner join for -webkit-text-stroke: 'round' (default) | 'miter' | 'bevel'.
   * Not a real CSS property for HTML text-stroke — render-tag reads it so
   * callers can control stroke corner shape (e.g. varsity/block lettering). */
  strokeLinejoin: string;
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
  /** unicode-bidi: 'normal' | 'bidi-override' | 'isolate' | 'isolate-override' | 'embed' */
  unicodeBidi: string;
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

  /**
   * Multi-line ellipsis clamp — positive integer = clamp to N lines and
   * append an ellipsis to the last visible line, 0 = no clamp.
   * Recognized via `-webkit-line-clamp` and `line-clamp` (synonyms in spec).
   */
  lineClamp: number;
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
  /**
   * For list items: explicitly-set properties from `::marker` rules.
   * Only set keys are present (Partial), so unset keys fall back to the
   * `<li>` style at the use site. Empty/undefined when no `::marker` rule matched.
   */
  markerStyle?: Partial<ResolvedStyle>;
  /**
   * For list items: true when `::marker { content: none }` is in effect.
   * The layout engine skips drawing the marker entirely. This matches how
   * the DOM treats `content: none` on `::marker`, and lets the recommended
   * reset (`li::marker { content: none; font-size: 0; line-height: 0 }`)
   * produce the same hidden-marker behavior on canvas.
   */
  markerHidden?: boolean;
}

/** A positioned text run ready for canvas rendering */
export interface LayoutText {
  type: 'text';
  text: string;
  x: number;
  y: number; // baseline y
  width: number;
  style: ResolvedStyle;
  /**
   * background-clip:text background from the nearest declaring INLINE element
   * (e.g. <span>/<s>) — a gradient `image` and/or solid `color`, with a box
   * spanning the declaring element's fragment on this line. Threaded here
   * because those properties don't inherit and inline elements are flattened
   * into runs, not boxes (block declarers thread through renderBox instead).
   */
  clip?: { image?: string; color?: string; x: number; y: number; width: number; height: number };
  /**
   * --rt-text-stroke-image gradient from the nearest declaring INLINE element,
   * with the same fragment-box geometry as `clip`.
   */
  strokeImage?: { image: string; x: number; y: number; width: number; height: number };
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
