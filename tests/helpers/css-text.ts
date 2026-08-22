/**
 * `@font-face` blocks in test CSS, in one place.
 *
 * Both sides of the oracle need to take font faces apart: the canvas side
 * registers them, the native capture serves them ahead of the fixture. A
 * font-face body never nests braces, so a flat match is exact here.
 */
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;

export function matchFontFaces(css: string): string[] {
  return css.match(FONT_FACE) || [];
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
