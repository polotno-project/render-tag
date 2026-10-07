/**
 * The CSS tokenizer shared by stylesheets and inline styles (src/css-syntax.ts),
 * and the resolver behaviour that depends on it. Node only: no fonts, no
 * canvas — the resolver runs over a linkedom tree.
 *
 * The cases are the ones a `split(';')` / first-`}` parser got wrong: a `;`
 * or `}` inside a string or `url()`, comments, `!important`, block @-rules
 * with nested braces, statement @-rules, nested style rules.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { parseDeclarationList, parseStylesheet } from '../../src/css-syntax.ts';
import { parseHTML } from '../../src/parse.ts';
import { resolveStylesFromCSS } from '../../src/css-resolver.ts';
import { setDOMParser } from '../../src/dom.ts';
import type { StyledNode } from '../../src/types.ts';

afterAll(() => setDOMParser(null));

const DATA_URL = 'url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")';
const BARE_DATA_URL = 'url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)';

describe('parseDeclarationList', () => {
  it('splits declarations and lower-cases the property', () => {
    expect(parseDeclarationList('COLOR: red; margin:0 auto ;;')).toEqual([
      { property: 'color', value: 'red', important: false },
      { property: 'margin', value: '0 auto', important: false },
    ]);
  });

  it('keeps a ; inside url() and strings', () => {
    expect(parseDeclarationList(`background-image: ${DATA_URL}; color: red`)).toEqual([
      { property: 'background-image', value: DATA_URL, important: false },
      { property: 'color', value: 'red', important: false },
    ]);
    expect(parseDeclarationList(`background-image:${BARE_DATA_URL};color:red`)[0].value).toBe(BARE_DATA_URL);
    expect(parseDeclarationList(`font-family: "a;b", serif; color: red`)).toEqual([
      { property: 'font-family', value: '"a;b", serif', important: false },
      { property: 'color', value: 'red', important: false },
    ]);
  });

  it('separates !important from the value', () => {
    expect(parseDeclarationList('color: red !important; margin: 1px ! IMPORTANT')).toEqual([
      { property: 'color', value: 'red', important: true },
      { property: 'margin', value: '1px', important: true },
    ]);
  });

  it('drops comments, and a comment cannot hide a terminator', () => {
    expect(parseDeclarationList('/* a; b */ color: /* ; */ red; /* x: y */ margin: 1px/**/2px')).toEqual([
      { property: 'color', value: 'red', important: false },
      { property: 'margin', value: '1px 2px', important: false },
    ]);
  });

  it('drops a declaration without a colon, a property or a value', () => {
    expect(parseDeclarationList('color red; : red; color:; margin: 1px')).toEqual([
      { property: 'margin', value: '1px', important: false },
    ]);
  });

  it('drops a stray } with the rest of its item, up to the next ;', () => {
    // CSS Syntax 3: the bad item is consumed to the next top-level `;`, so the
    // declaration glued after the `}` goes with it (Chromium and WebKit agree).
    expect(parseDeclarationList('color:red; } font-size:20px; margin-left:7px')).toEqual([
      { property: 'color', value: 'red', important: false },
      { property: 'margin-left', value: '7px', important: false },
    ]);
  });

  it('rejects a value with a leftover ! (a second !important, an !ie hack)', () => {
    expect(parseDeclarationList('color: red !important !important; margin: 1px !ie; padding: 2px')).toEqual([
      { property: 'padding', value: '2px', important: false },
    ]);
    // Inside a string or url() a ! is just text; a custom property may hold one.
    expect(parseDeclarationList('font-family: "a!b"; --x: a!b').map(d => d.value)).toEqual(['"a!b"', 'a!b']);
  });

  it('treats an escaped ; as part of the value', () => {
    expect(parseDeclarationList('font-family: a\\;b; color: red')).toEqual([
      { property: 'font-family', value: 'a\\;b', important: false },
      { property: 'color', value: 'red', important: false },
    ]);
  });
});

describe('parseStylesheet', () => {
  const selectors = (css: string) => parseStylesheet(css).map(r => r.prelude);

  it('skips block @-rules with nested braces and strings', () => {
    const css = `
      @font-face { font-family: "x}"; src: url(a.woff2) }
      @media (min-width: 1px) { p { color: blue } .a { color: green } }
      @supports (display: grid) { p { color: blue } }
      @keyframes k { from { opacity: 0 } to { opacity: 1 } }
      p { color: red }`;
    expect(parseStylesheet(css)).toEqual([
      { prelude: 'p', declarations: [{ property: 'color', value: 'red', important: false }] },
    ]);
  });

  it('ends a statement @-rule at its ; without eating the next rule', () => {
    expect(selectors('@import url("a.css"); @charset "utf-8"; p { color: red } div { margin: 0 }'))
      .toEqual(['p', 'div']);
  });

  it('does not end a rule at a } inside a string', () => {
    const rules = parseStylesheet('p { font-family: "}"; color: red } div { margin: 0 }');
    expect(rules.map(r => r.prelude)).toEqual(['p', 'div']);
    expect(rules[0].declarations.map(d => d.property)).toEqual(['font-family', 'color']);
  });

  it('keeps a data url with ; in a rule', () => {
    expect(parseStylesheet(`p { background-image: ${DATA_URL}; color: red }`)[0].declarations).toEqual([
      { property: 'background-image', value: DATA_URL, important: false },
      { property: 'color', value: 'red', important: false },
    ]);
  });

  it('drops a nested rule without losing the declarations after it', () => {
    const rules = parseStylesheet('p { span { color: blue } color: red; margin: 0 } div { margin: 1px }');
    expect(rules.map(r => r.prelude)).toEqual(['p', 'div']);
    expect(rules[0].declarations).toEqual([
      { property: 'color', value: 'red', important: false },
      { property: 'margin', value: '0', important: false },
    ]);
  });

  it('ignores comments and HTML comment tokens between rules', () => {
    expect(selectors('<!-- /* c { } */ p { color: red } --> /* x */ div{margin:0}')).toEqual(['p', 'div']);
  });

  it('removes a comment in a prelude without inserting whitespace', () => {
    // A comment is no token at all: `.a/**/.b` is the compound `.a.b`.
    expect(selectors('.a/**/.b { color: red } .c /**/ .d { color: red }')).toEqual(['.a.b', '.c  .d']);
  });

  it('keeps a stray top-level } in the next prelude, which invalidates it', () => {
    // CSS Syntax 3 "consume a qualified rule": a `}` outside a block is
    // appended to the prelude, so `}} .b` is the selector — and an invalid one.
    expect(selectors('.a{color:red} }} .b{color:blue} ] .c{color:green} .d{color:red}'))
      .toEqual(['.a', '}} .b', '] .c', '.d']);
  });

  it('keeps an unterminated last block, drops an unterminated prelude', () => {
    expect(selectors('p { color: red } div { margin: 0')).toEqual(['p', 'div']);
    expect(selectors('p { color: red } div')).toEqual(['p']);
  });
});

/** Resolve html over linkedom and return the first element under the root. */
function resolve(html: string): StyledNode {
  setDOMParser(new LinkedomDOMParser());
  const { fragment, css } = parseHTML(html);
  return resolveStylesFromCSS(fragment, css, 400).children[0];
}

describe('resolver over the shared tokenizer', () => {
  it('reads an inline data url whole', () => {
    expect(resolve(`<p style='background-image: ${DATA_URL}; color: red'>x</p>`).style.backgroundImage).toBe(DATA_URL);
  });

  it('reads a stylesheet data url whole', () => {
    expect(resolve(`<style>p { background-image: ${DATA_URL}; color: red }</style><p>x</p>`).style.backgroundImage)
      .toBe(DATA_URL);
  });

  it('strips an inline !important from the value', () => {
    expect(resolve('<p style="color: red !important">x</p>').style.color).toBe('red');
  });

  it('reads inline declarations after a comment', () => {
    expect(resolve('<p style="/* note; */ color: red">x</p>').style.color).toBe('red');
  });

  // The raw `style` attribute is the same string in every DOM. Before it was
  // read, WebKit's `cssText` expanded these shorthands into longhands and so
  // hid the resolver's gaps in that engine only.
  it('expands the font shorthand inline and in a sheet', () => {
    for (const p of [
      resolve('<p style="font: italic small-caps bold 20px/1.5 Georgia, &quot;Open Sans&quot;">x</p>'),
      resolve('<style>.k { font: italic small-caps bold 20px / 1.5 Georgia, "Open Sans" }</style><p class="k">x</p>'),
    ]) {
      expect(p.style).toMatchObject({
        fontStyle: 'italic', fontVariantCaps: 'small-caps', fontWeight: 700,
        fontSize: 20, lineHeight: 30, fontFamily: 'Georgia, "Open Sans"',
      });
    }
  });

  it('resets what the font shorthand does not name', () => {
    const p = resolve('<div style="line-height:40px;font-weight:700;font-style:italic"><p style="font:20px serif">x</p></div>')
      .children[0];
    expect(p.style).toMatchObject({ fontSize: 20, fontWeight: 400, fontStyle: 'normal', lineHeight: 0, fontFamily: 'serif' });
    // The size is the element's own before any em resolves: <p>'s 1em margins.
    expect(p.style.marginTop).toBe(20);
  });

  it('ignores a font shorthand without a size or a family', () => {
    expect(resolve('<p style="font: bold serif">x</p>').style).toMatchObject({ fontWeight: 400, fontFamily: 'serif' });
    expect(resolve('<p style="font: 20px">x</p>').style.fontSize).toBe(16);
  });

  it('reads border width keywords and currentcolor in any case', () => {
    const p = resolve('<p style="color: red; border: medium solid CurrentColor">x</p>');
    expect([p.style.borderTopWidth, p.style.borderTopColor, p.style.borderLeftColor]).toEqual([3, 'red', 'red']);
    const q = resolve('<p style="color: red; border: thin solid; border-left: thick dashed currentcolor">x</p>');
    expect([q.style.borderTopWidth, q.style.borderTopColor, q.style.borderLeftWidth, q.style.borderLeftColor])
      .toEqual([1, 'red', 5, 'red']);
  });

  it('gives a text node its parent element\'s style object', () => {
    const p = resolve('<p style="color: red">a<br>b</p>');
    expect(p.children.map(c => c.tagName)).toEqual(['#text', '#text', '#text']);
    for (const child of p.children) expect(child.style).toBe(p.style);
  });
});
