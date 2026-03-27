/**
 * Parse HTML string and extract inline <style> blocks.
 * Returns the content element and combined CSS text.
 */
export function parseHTML(html: string, extraCSS?: string): { fragment: DocumentFragment; css: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Extract all <style> tag contents
  const styleTags = doc.querySelectorAll('style');
  let css = '';
  for (const tag of styleTags) {
    css += tag.textContent + '\n';
    tag.remove();
  }

  if (extraCSS) {
    css = extraCSS + '\n' + css;
  }

  // Move body children into a fragment
  const fragment = document.createDocumentFragment();
  while (doc.body.firstChild) {
    fragment.appendChild(document.adoptNode(doc.body.firstChild));
  }

  return { fragment, css };
}
