const STYLE_TAG_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * Extract all <style> tag contents from an HTML string.
 * Returns the combined CSS and the HTML with <style> tags removed.
 */
export function extractStyleTags(html: string): { css: string; html: string } {
  const cssBlocks: string[] = [];

  const cleanHtml = html.replace(STYLE_TAG_RE, (_match, cssContent: string) => {
    cssBlocks.push(cssContent);
    return '';
  });

  return { css: cssBlocks.join('\n'), html: cleanHtml };
}
