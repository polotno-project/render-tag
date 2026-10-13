export interface BuildSvgOptions {
  /** XHTML content (already converted from HTML) */
  xhtml: string;
  /** CSS string with fonts already inlined as base64 */
  css: string;
  /** SVG width in px (logical) */
  width: number;
  /** SVG height in px (logical) */
  height: number;
  /** Device pixel ratio for high-DPI rendering (default: 1) */
  pixelRatio?: number;
}

/**
 * Build an SVG string that wraps XHTML content in a foreignObject element.
 *
 * The `xhtml` parameter should be the inner body content (not wrapped in a
 * `<body>` tag). The caller is responsible for extracting innerHTML from the
 * serialized document body.
 *
 * Notes on the template:
 * - `xmlns="http://www.w3.org/1999/xhtml"` on `<html>` is required for
 *   foreignObject.
 * - `<body style="margin: 0;">` resets the default body margin.
 */
/**
 * Escape CSS content so it can be safely embedded inside an XHTML <style> element.
 * In XHTML (XML), <style> content is parsed as #PCDATA, not raw text like in HTML.
 * A literal `</style` sequence in a CSS value (e.g. `content: "</style>"`) would
 * prematurely close the <style> tag and corrupt the SVG.
 */
function escapeCssForXhtml(css: string): string {
  // Replace `</style` (case-insensitive) with CSS-escaped equivalent.
  // `\3c` is the CSS escape sequence for `<`, valid in all CSS contexts.
  return css.replace(/<\/style/gi, '\\3c /style');
}

export function buildSvg({ xhtml, css, width, height, pixelRatio = 1 }: BuildSvgOptions): string {
  const svgWidth = width * pixelRatio;
  const svgHeight = height * pixelRatio;
  const transform = pixelRatio !== 1 ? ` transform="scale(${pixelRatio})"` : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">` +
    `<foreignObject width="${width}" height="${height}"` +
    ` style="float: left;"` +
    `${transform}>` +
    `<html xmlns="http://www.w3.org/1999/xhtml">` +
    `<head><style>${escapeCssForXhtml(css)}</style></head>` +
    `<body style="margin: 0;">${xhtml}</body>` +
    `</html>` +
    `</foreignObject>` +
    `</svg>`
  );
}
