/**
 * Extract font-family names from @font-face rules.
 */
export function extractFontFaces(css: string): string[] {
  const families: string[] = [];
  const regex = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"]+)['"]?\s*;/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    const name = match[1].trim();
    if (!families.includes(name)) {
      families.push(name);
    }
  }
  return families;
}

/**
 * Extract only @font-face blocks from CSS (to avoid injecting other rules globally).
 */
function extractFontFaceBlocks(css: string): string {
  const blocks: string[] = [];
  const regex = /@font-face\s*\{[^}]*\}/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    blocks.push(match[0]);
  }
  return blocks.join('\n');
}

/**
 * Load all fonts referenced in CSS @font-face rules.
 * Only injects @font-face blocks (not other CSS rules) into the document.
 * Explicitly triggers font loading for each declared family.
 */
export async function loadFonts(css: string): Promise<() => void> {
  if (!css.includes('@font-face')) {
    return () => {};
  }

  // Only inject @font-face rules, not the entire CSS
  const fontFaceCSS = extractFontFaceBlocks(css);
  if (!fontFaceCSS) {
    return () => {};
  }

  const style = document.createElement('style');
  style.textContent = fontFaceCSS;
  document.head.appendChild(style);

  // Explicitly trigger loading for each font family
  const families = extractFontFaces(css);
  const loadPromises = families.map(family =>
    document.fonts.load(`16px "${family}"`).catch(() => {
      // Font might not be available, continue
    })
  );
  await Promise.all(loadPromises);
  await document.fonts.ready;

  return () => {
    style.remove();
  };
}
