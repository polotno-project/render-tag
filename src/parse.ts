import { resolveDOMParser } from './dom.js';

/**
 * Parse HTML string and extract inline <style> blocks.
 * Returns the content element and combined CSS text.
 */
export function parseHTML(html: string): { fragment: DocumentFragment; css: string } {
  const parser = resolveDOMParser();
  // Wrap in a full document: browsers do this implicitly for fragments, but
  // non-browser parsers (linkedom) need the body to exist explicitly.
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
    'text/html'
  ) as Document;

  // Extract all <style> tag contents
  const styleTags = doc.querySelectorAll('style');
  let css = '';
  for (const tag of styleTags) {
    css += tag.textContent + '\n';
    tag.remove();
  }

  // Merge adjacent text nodes. Browsers already parse `big&nbsp;text` into a
  // single text node, but linkedom emits a node per entity boundary — which
  // would let the tokenizer break lines at entity seams. Normalizing in both
  // environments keeps parsing parity by construction. Scoped to body (all
  // content lives there); parseHTML can run in per-pixel fit loops.
  doc.body.normalize();

  // Move body children into a fragment owned by the same document — no
  // adoption needed (and non-browser DOMs may not implement adoptNode).
  const fragment = doc.createDocumentFragment();
  while (doc.body.firstChild) {
    fragment.appendChild(doc.body.firstChild);
  }

  return { fragment, css };
}
