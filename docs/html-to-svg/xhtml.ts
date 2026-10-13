/**
 * Convert HTML string to valid XHTML string.
 * Uses DOMParser to parse HTML and XMLSerializer to serialize as XHTML.
 * This handles self-closing tags (<br> → <br/>), attribute quoting, etc.
 *
 * Returns the serialized inner content of <body> (without the <body> wrapper).
 */
export function htmlToXhtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const serializer = new XMLSerializer();
  let xhtml = '';
  for (const node of Array.from(doc.body.childNodes)) {
    xhtml += serializer.serializeToString(node);
  }
  return xhtml;
}
