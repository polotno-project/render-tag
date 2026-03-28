export interface RenderOptions {
  /** Target canvas element (created if not provided) */
  canvas?: HTMLCanvasElement;
  /** Width of the rendering area in CSS pixels */
  width: number;
  /** Height of the rendering area in CSS pixels (auto-sized if not set) */
  height?: number;
  /** Additional CSS to apply */
  css?: string;
  /** Device pixel ratio (default: 1) */
  pixelRatio?: number;
  /**
   * Use DOM measurements for improved cross-browser consistency (default: true).
   * When enabled, uses hidden DOM elements to measure line heights and verify
   * text wrapping at font boundaries. When disabled, uses pure canvas API
   * measurements only — faster and DOM-free, but may have slight differences
   * across browsers (e.g. Firefox list item heights).
   */
  useDomMeasurements?: boolean;
}

/** A text line extracted from the layout tree */
export interface LayoutLine {
  /** Y coordinate of the text baseline */
  y: number;
  /** Concatenated text content on this line */
  text: string;
}

export interface RenderResult {
  canvas: HTMLCanvasElement;
  /** Actual content height after layout */
  height: number;
  /** The layout tree root (for debugging/comparison) */
  layoutRoot: LayoutBox;
  /** Text lines extracted from the layout tree, grouped by Y coordinate */
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
  flexShrink: number;

  // List
  listStyleType: string;
  listStylePosition: string;
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
