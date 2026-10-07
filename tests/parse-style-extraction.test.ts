/**
 * `parseHTML` lifts LEADING `<style>` blocks out of the html as text before
 * DOMParser runs (a 321 KB @font-face sheet costs DOMParser ~1.7 ms; the
 * string split ~20 µs). That shortcut is only allowed to be faster, never
 * different: every input here must produce exactly what the plain DOM path
 * produces — the same css text and the same parsed content — in this
 * engine's own HTML parser, which is the oracle.
 */
import { describe, expect, it } from 'vitest';
import { parseHTML, splitLeadingStyles } from '../src/parse.ts';

/** The DOM-only path: DOMParser, collect and remove every <style>, normalize. */
function reference(html: string): { css: string; content: string } {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head></head><body>${html}</body></html>`, 'text/html');
  let css = '';
  for (const tag of doc.querySelectorAll('style')) {
    // HTML: a sheet with a non-CSS type or a media list the page does not
    // match is not applied. (Cases avoid media features: render-tag does not
    // evaluate them.)
    const type = tag.getAttribute('type');
    const media = tag.getAttribute('media');
    if ((type === null || type === '' || type.toLowerCase() === 'text/css') &&
        (media === null || media.trim() === '' || matchMedia(media).matches)) {
      css += tag.textContent + '\n';
    }
    tag.remove();
  }
  doc.body.normalize();
  return { css, content: serialize(doc.body.childNodes) };
}

/** Node structure, text and attributes — including whitespace-only text. */
function serialize(nodes: NodeListOf<ChildNode> | ChildNode[]): string {
  return JSON.stringify([...nodes].map(function walk(n: ChildNode): unknown {
    if (n.nodeType === 3) return { text: n.textContent };
    if (n.nodeType !== 1) return { type: n.nodeType, data: n.textContent };
    const el = n as Element;
    return {
      tag: el.tagName,
      attrs: [...el.attributes].map((a) => [a.name, a.value]),
      children: [...el.childNodes].map(walk),
    };
  }));
}

const FACE = `@font-face { font-family: "X"; src: url(data:font/woff2;base64,AAAA) format("woff2"); }`;

const CASES: Record<string, string> = {
  'one leading sheet': `<style>${FACE} p { color: red }</style><p>a</p>`,
  'whitespace around sheets': ` \n\t<style>p{color:red}</style>\n  <style media="all">b{x:y}</style>  text <b>b</b>`,
  'CRLF and CR in the sheet': `<style>p{color:red}\r\n.a{x:y}\rb{}</style><p>a</p>`,
  'NUL in the sheet': `<style>p{content:"\u0000"}</style><p>a</p>`,
  'markup and entities inside the sheet stay text': `<style>p::before{content:"<b>&amp;</b>"} </p></style><p>a</p>`,
  'end tag with case, space and slash': `<style>a{}</STYLE ><style>b{}</style/><p>c</p>`,
  'start tag with attributes': `<style type=text/css media=screen>p{}</style><p>a</p>`,
  'print and non-css sheets are not applied': `<style media=print>a{}</style><style type=text/x>b{}</style><style media=all type=TEXT/CSS>c{}</style><p>a</p>`,
  'repeated media attribute: the first wins': `<style media=print media=screen>a{}</style><style>b{}</style><p>a</p>`,
  'print sheet (DOM path)': `<style media="print">a{}</style><style media="not print">b{}</style><p>a</p>`,
  'self-closing start tag still raw text': `<style/>p{}</style><p>a</p>`,
  'character reference in an unquoted attribute': `<style>p{color:black}</style><style media=scr&#101;en>p{color:red}</style><p>x</p>`,
  'quoted attribute (DOM path)': `<style data-x="a>b">p{}</style><p>a</p>`,
  'end tag with attributes (DOM path)': `<style>p{}</style x="y"><p>a</p>`,
  'unterminated sheet (DOM path)': `<style>p{color:red}`,
  '</styles> does not end the sheet': `<style>a{}</styles>b{}</style><p>a</p>`,
  'later sheet (DOM path)': `<p>a</p><style>p{color:red}</style><p>b</p>`,
  'leading and later sheets': `<style>a{}</style><p>a</p><style>b{}</style>`,
  'sheet then text': `<style>a{}</style>tail`,
  'only a sheet': `<style>a{}</style>`,
  'BOM before the sheet (DOM path)': `﻿<style>a{}</style><p>a</p>`,
  'comment before the sheet (DOM path)': `<!-- c --><style>a{}</style><p>a</p>`,
  'no sheet': `<p>plain <i>text</i></p>`,
  'empty': '',
};

describe('parseHTML leading <style> extraction', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(name, () => {
      const { fragment, css } = parseHTML(html);
      const expected = reference(html);
      expect({ css, content: serialize([...fragment.childNodes]) }).toEqual(expected);
      // Not vacuous: the shortcut really took every plain leading sheet.
      const lifted = !name.includes('(DOM path)') && /^\s*<style/i.test(html);
      expect(splitLeadingStyles(html).css !== '', 'took the string shortcut').toBe(lifted);
    });
  }
});
