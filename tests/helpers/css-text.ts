/**
 * `@font-face` blocks in test CSS, and the `<style>` elements of test HTML, in one place.
 *
 * Both sides of the oracle need to take font faces apart: the canvas side
 * registers them, the native capture serves them ahead of the fixture. A
 * font-face body never nests braces, so a flat match is exact here.
 */
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;

export function matchFontFaces(css: string): string[] {
  return css.match(FONT_FACE) || [];
}

/** The family an `@font-face` block declares, unquoted; '' without one. */
export function faceFamily(face: string): string {
  return face.match(/font-family:\s*['"]?([^;'"\n]+)/i)?.[1]?.trim() || '';
}

export function stripFontFaces(css: string): string {
  return css.replace(FONT_FACE, '');
}

/** Rewrite each `@font-face` block; return `''` from `replacer` to drop it. */
export function replaceFontFaces(
  css: string,
  replacer: (face: string) => string,
): string {
  return css.replace(FONT_FACE, replacer);
}

/** The CSS of the `<style>` elements in `html`. */
export function inlineStyles(html: string): string {
  return (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
    .map((style) => style.replace(/<\/?style[^>]*>/gi, ''))
    .join('\n');
}
