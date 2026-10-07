import type { PaintBounds } from './shadow.js';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Scratch surfaces for shadow composition. Required outside browsers; return
 * a fresh, compatible canvas (for example, from the caller's canvas library). */
export type CanvasFactory = (width: number, height: number) => AnyCanvas;

export interface ShadowOptions {
  /** Render CSS and caller-supplied canvas shadows (default true).
   * Only shadows are rasterized; foreground stays drawing commands in both modes.
   * Set false to omit shadows without allocating buffers or requiring image and
   * transform APIs. The caller is responsible for any omitted effects. */
  renderShadows?: boolean;
  /** Scratch surfaces for shadows. Required in non-browser environments. */
  createCanvas?: CanvasFactory;
}

interface LayoutInput {
  /** HTML string to render (include <style> tags for CSS) */
  html: string;
  /** Width of the rendering area in CSS pixels */
  width: number;
  /** Height of the rendering area in CSS pixels (auto-sized from content if omitted) */
  height?: number;
  /** 'performance' (default): canvas measurement only, consistent across
   * browsers. 'balanced': hidden DOM probes for line heights, closer to each
   * browser's own DOM. */
  accuracy?: 'balanced' | 'performance';
  /** Receives layout diagnostics: measurement, wrapping, positioning. */
  debug?: (entry: DebugEntry) => void;
}

interface DrawTarget {
  /** Context to draw onto, unresized and unscaled. Exclusive with `canvas`. */
  ctx?: AnyContext;
  /** Target canvas element (created if not provided). Mutually exclusive with `ctx`. */
  canvas?: AnyCanvas;
  /** Device pixel ratio (default: globalThis.devicePixelRatio ?? 1) */
  pixelRatio?: number;
}

export interface RenderConfig extends LayoutInput, DrawTarget, ShadowOptions {}

export interface LayoutConfig extends LayoutInput {
  /**
   * 2D context used for text measurement. Optional in the browser (a hidden
   * canvas is created); required in non-browser environments. render-tag
   * mutates its font, fontKerning and letterSpacing state, resets a non-zero
   * wordSpacing to 0px, and performs no save/restore.
   */
  ctx?: AnyContext;
}

export interface LayoutResult {
  /** Conservative local paint rectangle, including overflow, strokes,
   * decorations and CSS shadows. Measured on first access and reused.
   * Excludes destination transforms, clipping and canvas effects.
   * Load fonts first; create a new layout after changing content or fonts. */
  readonly paintBounds: PaintBounds;
  /** The complete layout `drawLayout` paints: every run with its own style,
   * position and baseline. Build renderers from this, never from `lines`. */
  layoutRoot: LayoutBox;
  /** Content height in CSS pixels */
  height: number;
  /** A lossy per-line summary for wrap inspection and tests. */
  lines: LayoutLine[];
}

export interface DrawConfig extends DrawTarget, ShadowOptions {
  /** Layout result from layout() */
  layout: LayoutResult;
  /** Width used during layout (must match) */
  width: number;
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
  /** Baseline y, rounded to a whole px; exact baselines are in `layoutRoot`. */
  y: number;
  /** The line's text; flows sharing a row (cells, markers) merge with a space. */
  text: string;
  /** Union of the line boxes: `y` is the top, `height` the effective line
   * height. Use `LayoutBox.lineBoxes` for per-line geometry. */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface RenderResult extends LayoutResult {
  /** The canvas that was rendered onto */
  canvas: AnyCanvas;
}

/**
 * One text decoration with its declaring element's color and style. Entries
 * ride down the tree by reference so descendants paint their ancestors' bands
 * (CLAUDE.md "Text paint propagation").
 */
export interface DecorationEntry {
  /** 'underline' | 'line-through' | 'overline' */
  line: string;
  color: string;
  /** 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy' */
  style: string;
  /** The declaring element's style (by identity): it sets the band's thickness
   * and the underline's position. See `fragmentBands` in render.ts. */
  declarer: ResolvedStyle;
}

/** A corner radius: a px length, or a percentage of the border box. */
export type BorderRadius = number | { pct: number };

/**
 * Resolved style for a single element — all values in px / concrete strings,
 * except corner radii, which may stay a symbolic percentage until paint.
 */
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
  /** Own and ancestor decorations, ancestors first. */
  textDecorations: DecorationEntry[];
  /** text-underline-offset in px; null = `auto`. Inherited; a percentage
   * re-resolves against each element's font size. */
  textUnderlineOffset: number | null;
  /** text-decoration-thickness in px; null = `auto` or `from-font`. */
  textDecorationThickness: number | null;
  textShadow: string;
  webkitTextStrokeWidth: number;
  webkitTextStrokeColor: string;
  /** The `--rt-text-stroke-image` gradient for -webkit-text-stroke over the
   * declaring element; 'none' = solid `webkitTextStrokeColor`. */
  webkitTextStrokeImage: string;
  webkitTextFillColor: string;
  paintOrder: string;
  /** -webkit-text-stroke corner join: 'round' (default) | 'miter' | 'bevel'. */
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
  /** px, sizing the box `box-sizing` names (content box by default); 0 = auto. */
  width: number;
  /** null = auto (the flex automatic min-content floor); number = explicit CSS min-width. */
  minWidth: number | null;
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
  /** Corner radii: px, or `{ pct }` of the border box, resolved at paint. */
  borderTopLeftRadius: BorderRadius;
  borderTopRightRadius: BorderRadius;
  borderBottomRightRadius: BorderRadius;
  borderBottomLeftRadius: BorderRadius;

  // Flex
  flexDirection: string;
  gap: number;
  flexGrow: number;
  flexShrink: number;
  /** `flex-basis` in px — the box `box-sizing` names, like `width` — or `null` for `auto`. */
  flexBasis: number | null;

  // List
  listStyleType: string;

  /** `(-webkit-)line-clamp` line count; 0 = none. */
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
  /** For list items: properties set by `::marker` rules (unset keys fall back to the `<li>`). */
  markerStyle?: Partial<ResolvedStyle>;
  /** For list items: `::marker { content: none }` hides the marker. */
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
  /** The line's own baseline, present only when `vertical-align` moved `y`. */
  lineBaselineY?: number;
  /** background-clip:text paint of the nearest INLINE declarer, over its
   * fragment on this line (block declarers thread down at paint). */
  clip?: { image?: string; color?: string; x: number; y: number; width: number; height: number };
  /** --rt-text-stroke-image of the nearest INLINE declarer, like `clip`. */
  strokeImage?: { image: string; x: number; y: number; width: number; height: number };
}

/** A line box in canvas coordinates, before the lossy `result.lines` merge. */
export interface LayoutLineBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ends at <br> or a preserved newline; false for a wrap, end of content or clamp. */
  endedByHardBreak: boolean;
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
  /** This box's own inline lines, blank ones included (width 0). */
  lineBoxes?: LayoutLineBox[];
  listMarker?: string;
}

export type LayoutNode = LayoutText | LayoutBox;
