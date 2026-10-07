import { resolveDOMParser } from './dom.js';

// HTML "ASCII whitespace", the only text allowed before or between the
// leading sheets. A start tag with no quoted attribute value (a quoted one
// may hold a `>`), and the RAWTEXT end: `</style` then whitespace, `/` or `>`.
const LEADING_STYLE_OPEN = /^[\t\n\f\r ]*<style(?:[\t\n\f\r /][^>"'`]*)?>/i;
const STYLE_END = /<\/style(?=[\t\n\f\r />])/gi;
const STYLE_END_TAIL = /^[\t\n\f\r /]*>/;

/**
 * Split the `<style>` blocks that lead the html (only whitespace around them)
 * off as text, so DOMParser never tokenizes them. A leading `<style>` is RAWTEXT:
 * verbatim up to `</style` + whitespace/`/`/`>`, with CR/CRLF -> LF and NUL ->
 * U+FFFD. Anything less plain stops the split and is left to DOMParser.
 * Held to the engine's parser by `tests/parse-style-extraction.test.ts`.
 */
export function splitLeadingStyles(html: string): { css: string; rest: string } {
  let css = '';
  let whitespace = '';
  let rest = html;
  for (;;) {
    const open = LEADING_STYLE_OPEN.exec(rest);
    if (!open) break;
    STYLE_END.lastIndex = open[0].length;
    const end = STYLE_END.exec(rest);
    if (!end) break;
    const tail = STYLE_END_TAIL.exec(rest.slice(end.index + 7, end.index + 7 + 64));
    if (!tail) break;
    const text = rest.slice(open[0].length, end.index);
    if (styleApplies(unquotedAttributes(open[0]))) {
      css += text.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD') + '\n';
    }
    whitespace += open[0].slice(0, open[0].search(/<style/i));
    rest = rest.slice(end.index + 7 + tail[0].length);
  }
  return css ? { css, rest: whitespace + rest } : { css, rest: html };
}

/** Parse an HTML string into a fragment plus the combined CSS of its `<style>` blocks. */
export function parseHTML(html: string): { fragment: DocumentFragment; css: string } {
  const parser = resolveDOMParser();
  const leading = splitLeadingStyles(html);
  // linkedom needs the body to exist explicitly.
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><head></head><body>${leading.rest}</body></html>`,
    'text/html'
  ) as Document;

  const styleTags = doc.querySelectorAll('style');
  let css = leading.css;
  for (const tag of styleTags) {
    if (styleApplies((name) => tag.getAttribute(name))) css += tag.textContent + '\n';
    tag.remove();
  }

  // linkedom splits text nodes at entities, which would allow breaks at those seams.
  doc.body.normalize();

  // Same-document fragment: non-browser DOMs may not implement adoptNode.
  const fragment = doc.createDocumentFragment();
  while (doc.body.firstChild) {
    fragment.appendChild(doc.body.firstChild);
  }

  return { fragment, css };
}

/**
 * Does a `<style>` sheet apply to a screen render? Only `type` text/css (or
 * none) and media types `all`/`screen`/`not <other>`; a media feature never matches.
 */
function styleApplies(attribute: (name: string) => string | null): boolean {
  const type = attribute('type');
  if (type !== null && type.trim() !== '' && type.trim().toLowerCase() !== 'text/css') return false;
  const media = attribute('media');
  if (media === null || media.trim() === '') return true;
  return media.toLowerCase().split(',').some((query) => {
    const q = query.trim().replace(/^only\s+/, '');
    if (q === 'all' || q === 'screen') return true;
    const not = /^not\s+([a-z-]+)$/.exec(q);
    return not !== null && not[1] !== 'all' && not[1] !== 'screen';
  });
}

/** Unquoted start-tag attributes: names lower-cased, first repeat wins (HTML tokenizer). */
function unquotedAttributes(tag: string): (name: string) => string | null {
  const attrs = new Map<string, string>();
  const re = /[\t\n\f\r /]+([^\t\n\f\r />=][^\t\n\f\r />=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*([^\t\n\f\r >]*))?/g;
  const body = tag.slice(tag.search(/<style/i) + 6, -1);
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? '');
  }
  return (name) => attrs.get(name) ?? null;
}
