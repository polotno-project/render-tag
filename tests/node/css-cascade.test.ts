/**
 * Resolver CSS correctness: units, the font shorthand, `!important`, the
 * background shorthand, `currentcolor`, the HTML UA defaults (incl. `<font>`
 * presentational hints and `<q>` quotes) and selectors. Node only — the
 * resolver runs over a linkedom tree; no fonts, no canvas.
 *
 * Each expectation is the browser's computed value (checked in Chromium and
 * WebKit by tests/computed-style-parity.test.ts where a fixture exists).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { parseHTML } from '../../src/parse.ts';
import { resolveStylesFromCSS, type ResolveOptions } from '../../src/css-resolver.ts';
import { setDOMParser } from '../../src/dom.ts';
import type { StyledNode } from '../../src/types.ts';

afterAll(() => setDOMParser(null));

const VIEWPORT = { width: 400, height: 300 };

/** The resolved root (the synthetic container standing for html/body). */
function root(html: string, options: ResolveOptions = { viewport: VIEWPORT }): StyledNode {
  setDOMParser(new LinkedomDOMParser());
  const { fragment, css } = parseHTML(html);
  return resolveStylesFromCSS(fragment, css, 400, options);
}

/** Every element node under the root, in document order. */
function elements(html: string, options?: ResolveOptions): StyledNode[] {
  const out: StyledNode[] = [];
  const walk = (n: StyledNode) => {
    for (const c of n.children) {
      if (c.tagName === '#text') continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root(html, options));
  return out;
}

/** The first element matching `tag` (document order). */
function el(html: string, tag: string, options?: ResolveOptions): StyledNode {
  const found = elements(html, options).find((n) => n.tagName === tag);
  if (!found) throw new Error(`no <${tag}>`);
  return found;
}

const colors = (html: string) => elements(html).map((n) => n.style.color);

describe('units', () => {
  it('rem resolves against the root font-size, not the parent', () => {
    expect(el('<div style="font-size:40px"><p style="font-size:2rem;padding-left:1rem">x</p></div>', 'p').style)
      .toMatchObject({ fontSize: 32, paddingLeft: 16 });
  });

  it('rem follows html/:root font-size, but not body', () => {
    expect(el('<style>html { font-size: 20px }</style><p style="padding-left:1rem">x</p>', 'p').style.paddingLeft).toBe(20);
    expect(el('<style>:root { font-size: 10px }</style><p style="padding-left:2rem">x</p>', 'p').style.paddingLeft).toBe(20);
    const p = el('<style>body { font-size: 30px }</style><p style="padding-left:1rem">x</p>', 'p');
    expect(p.style).toMatchObject({ fontSize: 30, paddingLeft: 16 });
  });

  it('absolute units', () => {
    const s = (v: string) => el(`<p style="padding-left:${v}">x</p>`, 'p').style.paddingLeft;
    expect(s('12pt')).toBeCloseTo(16, 9);
    expect(s('1pc')).toBeCloseTo(16, 9);
    expect(s('1in')).toBeCloseTo(96, 9);
    expect(s('2.54cm')).toBeCloseTo(96, 9);
    expect(s('25.4mm')).toBeCloseTo(96, 9);
    expect(s('101.6Q')).toBeCloseTo(96, 9);
    expect(el('<p style="font-size:12pt">x</p>', 'p').style.fontSize).toBeCloseTo(16, 9);
  });

  it('viewport units against the layout viewport', () => {
    const s = (v: string) => el(`<p style="padding-left:${v}">x</p>`, 'p').style.paddingLeft;
    expect(s('5vw')).toBe(20);
    expect(s('10vh')).toBe(30);
    expect(s('10vmin')).toBe(30);
    expect(s('10vmax')).toBe(40);
    expect(el('<p style="font-size:5vw">x</p>', 'p').style.fontSize).toBe(20);
  });

  it('a viewport unit without a viewport is ignored, like any invalid value', () => {
    expect(el('<p style="padding-left:3px;padding-left:5vw">x</p>', 'p', {}).style.paddingLeft).toBe(3);
  });

  it('ch/ex measure the element\'s own final font (declared after the length)', () => {
    const seen: string[] = [];
    const options: ResolveOptions = {
      viewport: VIEWPORT,
      fontUnits: (style) => {
        seen.push(`${style.fontFamily} ${style.fontSize}`);
        return { ch: style.fontSize * 0.6, ex: style.fontSize * 0.45 };
      },
    };
    const p = el('<p style="padding-left:2ch;margin-left:2ex;font:20px monospace">x</p>', 'p', options);
    expect(p.style.paddingLeft).toBeCloseTo(24, 9);
    expect(p.style.marginLeft).toBeCloseTo(18, 9);
    expect(seen).toContain('monospace 20');
  });

  it('font-size in ch measures the PARENT font', () => {
    const options: ResolveOptions = {
      fontUnits: (style) => ({ ch: style.fontSize / 2, ex: style.fontSize / 2 }),
    };
    expect(el('<div style="font-size:30px"><p style="font-size:2ch">x</p></div>', 'p', options).style.fontSize).toBe(30);
  });

  it('ch/ex fall back to 0.5em without a measurer (CSS Values 4)', () => {
    expect(el('<p style="font-size:20px;padding-left:2ch;margin-left:3ex">x</p>', 'p', {}).style)
      .toMatchObject({ paddingLeft: 20, marginLeft: 30 });
  });

  it('calc() with + - * / and mixed units', () => {
    const s = (v: string, extra = '') => el(`<p style="font-size:20px;${extra}padding-left:${v}">x</p>`, 'p').style.paddingLeft;
    expect(s('calc(1em + 2px)')).toBe(22);
    expect(s('calc(50% - 10px)')).toBe(190);
    expect(s('calc(2 * 3px)')).toBe(6);
    expect(s('calc(3px*2)')).toBe(6);
    expect(s('calc((1rem + 4px) / 2)')).toBe(10);
    expect(s('calc(1px + calc(2px * 2))')).toBe(5);
    expect(s('calc(10vw - 1em)')).toBe(20);
    expect(s('min(10px, 1em)')).toBe(10);
    expect(s('max(10px, 1em)')).toBe(20);
    expect(s('clamp(5px, 50%, 30px)')).toBe(30);
    expect(s('CALC(1PX + 1Em)')).toBe(21);
  });

  it('calc() in font-size and line-height', () => {
    const p = el('<div style="font-size:20px"><p style="font-size:calc(1em + 2px);line-height:calc(1em + 4px)">x</p></div>', 'p');
    expect(p.style).toMatchObject({ fontSize: 22, lineHeight: 26 });
    // A unitless calc() is a line-height NUMBER: it inherits as a factor.
    const div = el('<div style="font-size:10px;line-height:calc(1.5 * 2)"><p style="font-size:20px">x</p></div>', 'div');
    expect(div.style.lineHeight).toBe(30);
    expect(div.children.find((c) => c.tagName === 'p')!.style.lineHeight).toBe(60);
  });

  it('an invalid length is ignored instead of becoming 0', () => {
    for (const bad of ['banana', 'calc(1px + 2)', 'calc(1px +2px)', '5', 'calc(1px / 0px)', '10vq']) {
      expect(el(`<p style="padding-left:7px;padding-left:${bad}">x</p>`, 'p').style.paddingLeft, bad).toBe(7);
    }
    // A bare 0 is a length; a unitless number is not (standards mode).
    expect(el('<p style="padding-left:7px;padding-left:0">x</p>', 'p').style.paddingLeft).toBe(0);
  });

  it('letter-spacing and word-spacing percentages are of the font-size', () => {
    expect(el('<p style="font-size:24px;letter-spacing:150%;word-spacing:50%">x</p>', 'p').style)
      .toMatchObject({ letterSpacing: 36, wordSpacing: 12 });
  });
});

describe('font-size, font-weight keywords and the font shorthand', () => {
  it('absolute keywords use the UA table (medium = 16px)', () => {
    const sizes = ['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large']
      .map((k) => el(`<p style="font-size:${k}">x</p>`, 'p').style.fontSize);
    expect(sizes).toEqual([9, 10, 13, 16, 18, 24, 32, 48]);
  });

  it('larger/smaller scale the parent by 1.2', () => {
    const span = el('<p style="font-size:20px"><span style="font-size:larger"><i style="font-size:smaller">x</i></span></p>', 'span');
    expect(span.style.fontSize).toBeCloseTo(24, 9);
    expect(span.children.find((c) => c.tagName === 'i')!.style.fontSize).toBeCloseTo(20, 9);
  });

  it('bolder/lighter follow the CSS Fonts 4 table', () => {
    const w = (parent: number, kw: string) =>
      el(`<p style="font-weight:${parent}"><span style="font-weight:${kw}">x</span></p>`, 'span').style.fontWeight;
    expect([w(100, 'bolder'), w(400, 'bolder'), w(600, 'bolder'), w(900, 'bolder')]).toEqual([400, 700, 900, 900]);
    expect([w(100, 'lighter'), w(400, 'lighter'), w(600, 'lighter'), w(900, 'lighter')]).toEqual([100, 100, 400, 700]);
  });

  it('font shorthand with keyword, pt and rem sizes', () => {
    expect(el('<div style="font-size:10px"><p style="font:large serif">x</p></div>', 'p').style.fontSize).toBe(18);
    expect(el('<div style="font-size:10px"><p style="font:12pt sans-serif">x</p></div>', 'p').style.fontSize).toBeCloseTo(16, 9);
    expect(el('<div style="font-size:10px"><p style="font:bold 1rem sans-serif">x</p></div>', 'p').style)
      .toMatchObject({ fontSize: 16, fontWeight: 700, fontFamily: 'sans-serif' });
    expect(el('<p style="font:italic small-caps bold condensed 16px/2 cursive">x</p>', 'p').style)
      .toMatchObject({ fontSize: 16, lineHeight: 32, fontStyle: 'italic', fontVariantCaps: 'small-caps', fontWeight: 700 });
  });

  it('font-variant-caps inherits', () => {
    expect(el('<div style="font-variant:small-caps"><p>x</p></div>', 'p').style.fontVariantCaps).toBe('small-caps');
  });
});

describe('CSS-wide keywords', () => {
  const PROPS = ['line-height', 'font-weight', 'padding-left', 'color', 'font-family', 'letter-spacing', 'display', 'font-size'];
  const tree = (keyword: string) => el(
    `<style>.k { ${PROPS.map((p) => `${p}: ${keyword}`).join('; ')} }</style>` +
    '<div style="line-height:33px;font-weight:700;padding-left:11px;color:red;font-family:monospace;' +
    'letter-spacing:3px;font-size:21px"><p class="k">a</p></div>', 'p');

  it('initial is the initial value, inherited property or not', () => {
    expect(tree('initial').style).toMatchObject({
      lineHeight: 0, fontWeight: 400, paddingLeft: 0, color: 'rgb(0, 0, 0)', fontFamily: 'serif',
      letterSpacing: 0, display: 'inline', fontSize: 16, marginTop: 16,
    });
  });

  it('inherit is the parent value, inherited property or not', () => {
    expect(tree('inherit').style).toMatchObject({
      lineHeight: 33, fontWeight: 700, paddingLeft: 11, color: 'red', fontFamily: 'monospace',
      letterSpacing: 3, display: 'block', fontSize: 21,
    });
  });

  it('unset inherits an inherited property and resets the others', () => {
    expect(tree('unset').style).toMatchObject({
      lineHeight: 33, fontWeight: 700, paddingLeft: 0, color: 'red', fontFamily: 'monospace',
      letterSpacing: 3, display: 'inline', fontSize: 21,
    });
  });

  it('a unitless line-height inherited explicitly stays a factor', () => {
    const p = el('<div style="font-size:10px;line-height:2"><p style="font-size:20px;line-height:3px;line-height:inherit">x</p></div>', 'p');
    expect(p.style.lineHeight).toBe(40);
  });
});

describe('!important', () => {
  it('a stylesheet !important beats an inline normal declaration', () => {
    const p = el('<style>.a { color: blue !important; padding-left: 7px !important; font-size: 30px !important }</style>' +
      '<p class="a" style="color:red;padding-left:3px;font-size:10px">x</p>', 'p');
    expect(p.style).toMatchObject({ color: 'blue', paddingLeft: 7, fontSize: 30 });
  });

  it('inline !important beats a stylesheet !important', () => {
    const p = el('<style>.a { color: blue !important; font-size: 30px !important }</style>' +
      '<p class="a" style="color:red !important;font-size:10px !important">x</p>', 'p');
    expect(p.style).toMatchObject({ color: 'red', fontSize: 10 });
  });

  it('!important beats higher specificity and later rules', () => {
    expect(el('<style>p.a { color: green } .a { color: blue !important } p.a.b { color: red }</style><p class="a b">x</p>', 'p')
      .style.color).toBe('blue');
    expect(el('<style>.a { font-weight: 700 !important } .a { font-weight: 300 }</style><p class="a">x</p>', 'p')
      .style.fontWeight).toBe(700);
  });

  it('never leaves !important in a value', () => {
    const p = el('<p style="color: red ! IMPORTANT; background: yellow!important">x</p>', 'p');
    expect([p.style.color, p.style.backgroundColor]).toEqual(['red', 'yellow']);
  });
});

describe('background shorthand and currentcolor', () => {
  it('background:none is transparent, in any case, and resets a sheet color', () => {
    for (const html of [
      '<p style="background:none">x</p>',
      '<p style="background:NONE">x</p>',
      '<style>.g { background-color: red }</style><p class="g" style="background:none">x</p>',
    ]) {
      const p = el(html, 'p');
      expect(p.style.backgroundColor, html).toBe('transparent');
      expect(p.style.backgroundImage, html).toBe('none');
    }
  });

  it('a color resets the image; color and image together set both', () => {
    const reset = el('<style>.g { background-image: linear-gradient(red, blue) }</style><p class="g" style="background:yellow">x</p>', 'p');
    expect([reset.style.backgroundColor, reset.style.backgroundImage]).toEqual(['yellow', 'none']);
    const both = el('<p style="background:#fc0 linear-gradient(red, blue)">x</p>', 'p');
    expect([both.style.backgroundColor, both.style.backgroundImage]).toEqual(['#fc0', 'linear-gradient(red, blue)']);
    const gradient = el('<p style="background:linear-gradient(90deg, red, blue)">x</p>', 'p');
    expect([gradient.style.backgroundColor, gradient.style.backgroundImage])
      .toEqual(['transparent', 'linear-gradient(90deg, red, blue)']);
  });

  it('reads an image with position, size and repeat, and a spaced color function', () => {
    const url = 'url(data:image/png;base64,iVBORw0KGgo=)';
    expect(el(`<p style="background:${url} no-repeat center / 10px 10px">x</p>`, 'p').style.backgroundImage).toBe(url);
    expect(el('<p style="background: rgb(10 20 30 / 50%) ">x</p>', 'p').style.backgroundColor).toBe('rgb(10 20 30 / 50%)');
  });

  it('the shorthand resets background-clip, and its box keywords set it', () => {
    const p = el('<style>.t { -webkit-background-clip: text; background: red }</style><p class="t">x</p>', 'p');
    expect(p.style.webkitBackgroundClip).toBe('border-box');
    const q = el('<style>.t { background: linear-gradient(red, blue); -webkit-background-clip: text }</style><p class="t">x</p>', 'p');
    expect(q.style.webkitBackgroundClip).toBe('text');
    expect(el('<p style="background: red padding-box content-box">x</p>', 'p').style.webkitBackgroundClip).toBe('content-box');
  });

  it('currentcolor resolves in background-color, case-insensitively', () => {
    expect(el('<p style="color:green;background-color:CurrentColor">x</p>', 'p').style.backgroundColor).toBe('green');
    expect(el('<p style="color:green;background:currentcolor">x</p>', 'p').style.backgroundColor).toBe('green');
  });

  it('an inherited currentcolor stays the keyword; an inherited concrete color stays the color', () => {
    const css = '.p { color: red; border: 2px solid; border-color: currentcolor } ' +
      '.q { color: red; border: 2px solid green } span { border: 2px solid; border-color: inherit; color: blue }';
    const kids = elements(`<style>${css}</style><p class="p">a <span>b</span></p><p class="q">c <span>d</span></p>`)
      .filter((n) => n.tagName === 'span');
    expect(kids.map((n) => n.style.borderTopColor)).toEqual(['blue', 'green']);
  });

  it('color: currentcolor is the parent color', () => {
    expect(el('<div style="color:blue"><p style="color:CURRENTCOLOR">x</p></div>', 'p').style.color).toBe('blue');
  });
});

describe('HTML UA defaults', () => {
  it('unknown and phrasing elements are inline', () => {
    for (const tag of ['small', 'mark', 'label', 'abbr', 'q', 'kbd', 'var', 'time', 'data', 'ins', 'dfn',
      'samp', 'tt', 'big', 'nobr', 'img', 'x-foo', 'my-element', 'unknowntag', 'font']) {
      const html = tag === 'img' ? `<p>a <${tag}> b</p>` : `<p>a <${tag}>x</${tag}> b</p>`;
      expect(el(html, tag).style.display, tag).toBe('inline');
    }
  });

  it('block elements of the HTML UA sheet are blocks', () => {
    for (const tag of ['section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'figure', 'figcaption',
      'address', 'center', 'dl', 'dt', 'dd', 'details', 'summary', 'hgroup', 'search', 'menu', 'fieldset',
      'legend', 'form', 'dialog', 'listing', 'xmp']) {
      const html = tag === 'dt' || tag === 'dd' ? `<dl><${tag}>x</${tag}></dl>` : `<${tag}>x</${tag}>`;
      expect(el(html, tag).style.display, tag).toBe('block');
    }
  });

  it('non-rendered elements and [hidden] generate no box', () => {
    const kids = root('<p>a</p><template><p>t</p></template><p hidden>h</p><p style="display:block" hidden>v</p>')
      .children.map((c) => c.tagName);
    expect(kids).toEqual(['p', 'p']);
  });

  it('phrasing UA styles', () => {
    const at = (tag: string) => el(`<p style="font-size:24px;font-weight:400">a <${tag}>x</${tag}></p>`, tag).style;
    expect(at('small').fontSize).toBeCloseTo(20, 9);
    expect(at('big').fontSize).toBeCloseTo(28.8, 9);
    expect(at('mark')).toMatchObject({ backgroundColor: 'yellow', color: 'black' });
    for (const tag of ['kbd', 'samp', 'tt', 'code']) expect(at(tag).fontFamily, tag).toBe('monospace');
    for (const tag of ['var', 'dfn', 'cite', 'em', 'i']) expect(at(tag).fontStyle, tag).toBe('italic');
    expect(at('ins').textDecorationLine).toBe('underline');
    expect(at('nobr').whiteSpace).toBe('nowrap');
    expect(at('b').fontWeight).toBe(700);
    expect(at('sub')).toMatchObject({ verticalAlign: 'sub' });
  });

  it('block UA styles', () => {
    expect(el('<div style="font-size:20px"><dl><dt>a</dt><dd>b</dd></dl></div>', 'dl').style)
      .toMatchObject({ marginTop: 20, marginBottom: 20 });
    expect(el('<dl><dd>b</dd></dl>', 'dd').style.marginLeft).toBe(40);
    expect(el('<div style="font-size:20px"><figure>x</figure></div>', 'figure').style)
      .toMatchObject({ marginTop: 20, marginBottom: 20, marginLeft: 40, marginRight: 40 });
    expect(el('<menu><li>x</li></menu>', 'menu').style).toMatchObject({ paddingLeft: 40, marginTop: 16, listStyleType: 'disc' });
    expect(el('<address>x</address>', 'address').style.fontStyle).toBe('italic');
    expect(el('<center>x</center>', 'center').style.textAlign).toBe('center');
  });

  it('<font color/face/size> are presentational hints, below every author rule', () => {
    expect(el('<p>a <font color="red" face="Georgia, serif">b</font></p>', 'font').style)
      .toMatchObject({ color: 'red', fontFamily: 'Georgia, serif', display: 'inline' });
    expect(el('<style>* { color: blue }</style><p><font color="red">b</font></p>', 'font').style.color).toBe('blue');
    expect(el('<p><font color="ff0000">b</font></p>', 'font').style.color).toBe('rgb(255, 0, 0)');
    const sizes = ['1', '2', '3', '4', '5', '6', '7', '+1', '-1', '+4', '9', '0']
      .map((size) => el(`<p><font size="${size}">x</font></p>`, 'font').style.fontSize);
    expect(sizes).toEqual([10, 13, 16, 18, 24, 32, 48, 18, 13, 48, 48, 10]);
  });

  it('a link (a/area with href) is blue and underlined; an author rule wins', () => {
    expect(el('<p><a href="#x">a</a></p>', 'a').style).toMatchObject({ color: '#0000ee', textDecorationLine: 'underline' });
    expect(el('<p><a>a</a></p>', 'a').style).toMatchObject({ color: 'rgb(0, 0, 0)', textDecorationLine: 'none' });
    expect(el('<style>a { color: red; text-decoration: none }</style><p><a href="">a</a></p>', 'a').style)
      .toMatchObject({ color: 'red', textDecorationLine: 'none' });
  });

  it('border-width, border-style and border-color take 1-4 values', () => {
    const p = el('<p style="border-style:solid;border-width:1px 2px 3px 4px;border-color:red green blue orange">x</p>', 'p');
    expect([p.style.borderTopWidth, p.style.borderRightWidth, p.style.borderBottomWidth, p.style.borderLeftWidth])
      .toEqual([1, 2, 3, 4]);
    expect([p.style.borderTopColor, p.style.borderRightColor, p.style.borderBottomColor, p.style.borderLeftColor])
      .toEqual(['red', 'green', 'blue', 'orange']);
    expect(p.style.borderLeftStyle).toBe('solid');
    const q = el('<p style="border-width:thin medium;border-style:solid dashed;border-color:rgb(1, 2, 3) red">x</p>', 'p');
    expect([q.style.borderTopWidth, q.style.borderLeftWidth, q.style.borderLeftStyle, q.style.borderTopColor])
      .toEqual([1, 3, 'dashed', 'rgb(1, 2, 3)']);
  });

  it('<wbr> is a break opportunity (a zero-width space), not a box', () => {
    const p = el('<p>super<wbr>word</p>', 'p');
    expect(p.children.map((c) => [c.tagName, c.textContent])).toEqual([
      ['#text', 'super'], ['#text', '\u200B'], ['#text', 'word'],
    ]);
  });

  it('<q> gets quotation marks, alternating with nesting depth', () => {
    const q = el('<p><q>a <q>b</q></q></p>', 'q');
    const text = (n: StyledNode): string =>
      n.tagName === '#text' ? n.textContent! : n.children.map(text).join('');
    expect(text(q)).toBe('“a ‘b’”');
    // The quotes are the <q>'s own text: they share its style object.
    expect(q.children[0].style).toBe(q.style);
  });
});

describe('selectors', () => {
  const LIST = '<div><p>1</p><p>2</p><p>3</p><p>4</p><p>5</p></div>';
  const MIXED = '<div><span>s1</span><p>p1</p><span>s2</span><p>p2</p><p class="a">p3</p><span>s3</span></div>';
  /** Colors of the <p> (or `tag`) elements only. */
  const pick = (css: string, html: string, tag = 'p') =>
    elements(`<style>${css}</style>${html}`).filter((n) => n.tagName === tag).map((n) => n.style.color);
  const R = 'red', K = 'rgb(0, 0, 0)';

  it('an unsupported pseudo-class never matches (it is not stripped)', () => {
    expect(pick('p:hover { color: red } p:focus { color: red } p:frobnicate { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('p::before { color: red }', LIST)).toEqual([K, K, K, K, K]);
    // Only the unsupported member of a list is dropped.
    expect(pick('p::before, p:nth-child(2) { color: red }', LIST)).toEqual([K, R, K, K, K]);
  });

  it(':root matches the root only', () => {
    const r = root('<style>:root { padding-left: 5px; color: red }</style><p>a <span>b</span></p>');
    expect(r.style.paddingLeft).toBe(5);
    expect(r.children[0].style.paddingLeft).toBe(0);
    expect(r.children[0].style.color).toBe('red');
  });

  it('html and body chains match the root', () => {
    expect(pick('html > body > p { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('html body p { color: red }', LIST)).toEqual([R, R, R, R, R]);
    expect(pick('body > div > p:first-child { color: red }', LIST)).toEqual([R, K, K, K, K]);
  });

  it('child-indexed pseudo-classes', () => {
    expect(pick('p:first-child { color: red }', LIST)).toEqual([R, K, K, K, K]);
    expect(pick('p:last-child { color: red }', LIST)).toEqual([K, K, K, K, R]);
    expect(pick('p:nth-child(2n+1) { color: red }', LIST)).toEqual([R, K, R, K, R]);
    expect(pick('p:nth-child(odd) { color: red }', LIST)).toEqual([R, K, R, K, R]);
    expect(pick('p:nth-child( EVEN ) { color: red }', LIST)).toEqual([K, R, K, R, K]);
    expect(pick('p:nth-child(3) { color: red }', LIST)).toEqual([K, K, R, K, K]);
    expect(pick('p:nth-child(-n+2) { color: red }', LIST)).toEqual([R, R, K, K, K]);
    expect(pick('p:nth-child(n+4) { color: red }', LIST)).toEqual([K, K, K, R, R]);
    expect(pick('p:nth-child(- n + 2) { color: red }', LIST)).toEqual([K, K, K, K, K]); // invalid: dropped
    expect(pick('p:nth-last-child(1) { color: red }', LIST)).toEqual([K, K, K, K, R]);
    expect(pick('p:nth-last-child(2n) { color: red }', LIST)).toEqual([K, R, K, R, K]);
    expect(pick('span:only-child { color: red }', '<p><span>a</span></p><p><span>b</span><span>c</span></p>', 'span'))
      .toEqual([R, K, K]);
  });

  it('typed pseudo-classes', () => {
    expect(pick('p:first-of-type { color: red }', MIXED)).toEqual([R, K, K]);
    expect(pick('span:first-of-type { color: red }', MIXED, 'span')).toEqual([R, K, K]);
    expect(pick('p:last-of-type { color: red }', MIXED)).toEqual([K, K, R]);
    expect(pick('p:nth-of-type(2) { color: red }', MIXED)).toEqual([K, R, K]);
    expect(pick('p:nth-last-of-type(3) { color: red }', MIXED)).toEqual([R, K, K]);
    expect(pick('i:only-of-type { color: red }', '<p><i>a</i><b>b</b></p><p><i>c</i><i>d</i></p>', 'i')).toEqual([R, K, K]);
  });

  it(':empty, :not(), :is(), :where()', () => {
    const spans = elements('<style>span:empty { padding-left: 5px }</style><p><span></span><span>c</span><span><!-- x --></span></p>')
      .filter((n) => n.tagName === 'span').map((n) => n.style.paddingLeft);
    expect(spans).toEqual([5, 0, 5]);
    expect(pick('p:not(.a) { color: red }', MIXED)).toEqual([R, R, K]);
    expect(pick('p:not(.a, :first-of-type) { color: red }', MIXED)).toEqual([K, R, K]);
    expect(pick(':is(p, span).a { color: red }', MIXED)).toEqual([K, K, R]);
    // :where() adds no specificity; :is() adds its most specific argument.
    expect(pick(':where(p.a) { color: red } p { color: blue }', MIXED)).toEqual(['blue', 'blue', 'blue']);
    expect(pick(':is(p.a) { color: red } p.a { color: blue }', MIXED)).toEqual([K, K, 'blue']);
    // A complex selector inside :not() is unsupported: the rule never matches.
    expect(pick('p:not(div > p) { color: red }', MIXED)).toEqual([K, K, K]);
  });

  it(':link and :any-link match a/area with href; :visited never', () => {
    expect(pick('a:link { color: red } a:visited { color: blue }', '<p><a href="#x">a</a> <a>b</a></p>', 'a')).toEqual([R, K]);
    expect(pick(':any-link { color: red }', '<p><a href="">a</a></p>', 'a')).toEqual([R]);
  });

  it('attribute selectors', () => {
    const html =
      '<p data-x="1">a</p><p data-y="a b c">b</p><p lang="en-US">c</p><p data-z="q">d</p><p data-x>e</p>' +
      '<p title="https://mid.example/x.pdf">f</p>';
    const colorsFor = (css: string) => pick(css, html);
    expect(colorsFor('[data-x] { color: red }')).toEqual([R, K, K, K, R, K]);
    expect(colorsFor('[data-x="1"] { color: red }')).toEqual([R, K, K, K, K, K]);
    expect(colorsFor('[data-y~=b] { color: red }')).toEqual([K, R, K, K, K, K]);
    expect(colorsFor('[lang|=en] { color: red }')).toEqual([K, K, R, K, K, K]);
    // `lang` is one of HTML's case-insensitive attribute values.
    expect(colorsFor('[lang|="EN"] { color: red }')).toEqual([K, K, R, K, K, K]);
    expect(colorsFor('[title^="https"] { color: red }')).toEqual([K, K, K, K, K, R]);
    expect(colorsFor('[title$=".pdf"] { color: red }')).toEqual([K, K, K, K, K, R]);
    expect(colorsFor('[title*=mid] { color: red }')).toEqual([K, K, K, K, K, R]);
    expect(colorsFor('[data-z="Q" i] { color: red }')).toEqual([K, K, K, R, K, K]);
    expect(colorsFor('[data-z="Q"] { color: red }')).toEqual([K, K, K, K, K, K]);
    expect(colorsFor('[title^=""] { color: red }')).toEqual([K, K, K, K, K, K]);
    expect(colorsFor('[data-y="a > b"] { color: red }')).toEqual([K, K, K, K, K, K]);
  });

  it('#id, uppercase type selectors, sibling combinators', () => {
    expect(pick('#x { color: red } p#y.a { color: blue }', '<p id="x">a</p><p id="y" class="a">b</p>')).toEqual([R, 'blue']);
    expect(pick('P { color: red }', '<p>a</p>')).toEqual([R]);
    expect(pick('h2 + p { color: red }', '<h2>t</h2><p>a</p><p>b</p>')).toEqual([R, K]);
    expect(pick('h2 ~ p { color: red }', '<p>z</p><h2>t</h2><p>a</p><span>s</span><p>b</p>')).toEqual([K, R, R]);
    expect(pick('h2+p{color:red}', '<h2>t</h2><p>a</p>')).toEqual([R]);
    expect(pick('div>p:first-child{color:red}', LIST)).toEqual([R, K, K, K, K]);
  });

  it('specificity: ids, then classes/attributes/pseudo-classes, then types', () => {
    expect(pick('#x { color: red } .a.b.c.d { color: blue }', '<p id="x" class="a b c d">a</p>')).toEqual([R]);
    expect(pick('p:first-child { color: red } p { color: blue }', LIST)).toEqual([R, 'blue', 'blue', 'blue', 'blue']);
    expect(pick('[data-x] { color: red } p { color: blue }', '<p data-x>a</p>')).toEqual([R]);
    expect(pick('p:not(#x) { color: red } p.a.b { color: blue }', '<p class="a b">a</p>')).toEqual([R]);
  });

  it('::marker still routes to the marker', () => {
    const li = el('<style>li::marker { color: red }</style><ul><li>a</li></ul>', 'li');
    expect(li.markerStyle).toEqual({ color: 'red' });
    expect(li.style.color).toBe('rgb(0, 0, 0)');
  });

  it('an INVALID member drops the whole selector list; an unsupported one only itself', () => {
    // Selectors 4 §3.1: a list with one invalid selector is invalid. `:hover`,
    // `::before` and `*|p` are valid (they just never match here); `:foo`,
    // `::bogus` and `]` are not.
    expect(pick('p, p:foo { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('p, p::bogus { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('p, ] { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('p:nth-child(1), p:not(:foo) { color: red }', LIST)).toEqual([K, K, K, K, K]);
    expect(pick('p, p:hover { color: red }', LIST)).toEqual([R, R, R, R, R]);
    expect(pick('p, p::before { color: red }', LIST)).toEqual([R, R, R, R, R]);
    expect(pick('p, *|p { color: red }', LIST)).toEqual([R, R, R, R, R]);
    expect(pick('p, p:has(> span) { color: red }', LIST)).toEqual([R, R, R, R, R]);
    // :is()/:where() take a forgiving list: an invalid argument drops alone.
    expect(pick(':is(p:foo, p:first-child) { color: red }', LIST)).toEqual([R, K, K, K, K]);
  });

  it('complex selectors inside :is(), :where() and :not()', () => {
    // (Not `div`: the synthetic root container is a div, as in the oracles.)
    const html = '<article><p>a</p></article><section><p>b</p></section>';
    expect(pick(':is(article p) { color: red }', html)).toEqual([R, K]);
    expect(pick('p:not(article > p) { color: red }', html)).toEqual([K, R]);
    expect(pick(':where(section > p) { color: red }', html)).toEqual([K, R]);
  });

  it('a dynamic state is never active, so :not() of it matches', () => {
    expect(pick('p:not(:hover) { color: red }', '<p>a</p>')).toEqual([R]);
  });

  it('a general-sibling selector matches across a long list', () => {
    // Its cost is ratcheted in tests/node/perf-counters.test.ts.
    const items = '<li>x</li>'.repeat(50);
    const lis = elements(`<style>.x ~ li, .y ~ li { color: red }</style><ul>${items}<li class="y">y</li><li>z</li></ul>`)
      .filter((n) => n.tagName === 'li');
    expect(lis.at(-1)!.style.color).toBe('red');
    expect(lis.at(-2)!.style.color).toBe(K);
    expect(lis[0].style.color).toBe(K);
  });

  it('colors helper sanity', () => {
    expect(colors('<p style="color:red">a</p>')).toEqual(['red']);
  });
});

describe('invalid and uppercase values (a browser drops / lower-cases them)', () => {
  /** The <p>'s style with a sheet rule `.a { <sheet> }` and inline `<inline>`. */
  const over = (sheet: string, inline: string) =>
    el(`<style>.a { ${sheet} }</style><p class="a" style="${inline}">x</p>`, 'p').style;

  it('an invalid inline value does not override a valid sheet value', () => {
    expect(over('color: red', 'color: foo').color).toBe('red');
    expect(over('color: red', 'color: rgb(1,2)').color).toBe('red');
    expect(over('display: inline', 'display: blok').display).toBe('inline');
    expect(over('white-space: pre', 'white-space: bogus').whiteSpace).toBe('pre');
    expect(over('background-color: red', 'background-color: bogus').backgroundColor).toBe('red');
    expect(over('text-shadow: 1px 1px red', 'text-shadow: bogus').textShadow).toBe('1px 1px red');
    expect(over('background-image: linear-gradient(red, blue)', 'background-image: linear-gradient(bogus)').backgroundImage)
      .toBe('linear-gradient(red, blue)');
    expect(over('font-style: italic', 'font-style: obliqe').fontStyle).toBe('italic');
    expect(over('font-family: Arial', 'font-family: 12px').fontFamily).toBe('Arial');
    expect(over('font-family: Arial', 'font-family: Arial,').fontFamily).toBe('Arial');
    expect(over('border-top-style: solid; border-top-width: 2px', 'border-top-style: wobbly').borderTopStyle).toBe('solid');
    expect(over('text-align: center', 'text-align: middle').textAlign).toBe('center');
    expect(over('text-decoration-line: underline', 'text-decoration-line: under').textDecorationLine).toBe('underline');
    expect(over('vertical-align: super', 'vertical-align: up').verticalAlign).toBe('super');
    expect(over('-webkit-text-stroke-color: red', '-webkit-text-stroke-color: nope').webkitTextStrokeColor).toBe('red');
    expect(over('border: 1px solid red', 'border: 1px solid nope').borderTopColor).toBe('red');
    expect(over('text-decoration: underline red', 'text-decoration: underline nope').textDecorationColor).toBe('red');
  });

  it('the same invalid values in a sheet are ignored too', () => {
    const p = el('<style>p { color: foo; display: blok; white-space: bogus; font-style: obliqe }</style><p>x</p>', 'p').style;
    expect(p).toMatchObject({ color: 'rgb(0, 0, 0)', display: 'block', whiteSpace: 'normal', fontStyle: 'normal' });
  });

  it('keyword values are ASCII case-insensitive and stored lower-case', () => {
    const p = el('<p style="COLOR:RED;font-size:2EM;display:INLINE;text-align:CENTER;white-space:PRE;' +
      'text-transform:UPPERCASE;font-style:ITALIC;vertical-align:SUPER;border-top-style:SOLID;' +
      'text-decoration-line:UNDERLINE;font-kerning:NONE;overflow-wrap:BREAK-WORD;direction:RTL">x</p>', 'p').style;
    expect(p).toMatchObject({
      fontSize: 32, display: 'inline', textAlign: 'center', whiteSpace: 'pre', textTransform: 'uppercase',
      fontStyle: 'italic', verticalAlign: 'super', borderTopStyle: 'solid', fontKerning: 'none',
      overflowWrap: 'break-word', direction: 'rtl',
    });
    expect(p.textDecorationLine).toBe('underline');
    expect(p.color.toLowerCase()).toBe('red');
    const s = el('<style>p { DISPLAY: INLINE-BLOCK; TEXT-ALIGN: RIGHT }</style><p>x</p>', 'p').style;
    expect(s).toMatchObject({ display: 'inline-block', textAlign: 'right' });
  });

  it('keeps every valid form the CSSOM accepted', () => {
    const v = (decl: string) => el(`<p style="${decl}">x</p>`, 'p').style;
    expect(v('display: inline flex').display).toBe('inline-flex');
    expect(v('display: block flow-root').display).toBe('flow-root');
    for (const c of ['rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, .5)', 'hsl(120deg 50% 50%)', 'hsla(120, 50%, 50%, 0.2)',
      '#abcd', '#a1b2c3', 'RebeccaPurple', 'transparent', 'color-mix(in srgb, red 40%, blue)',
      'oklch(70% 0.1 200)', 'hwb(10 20% 30%)', 'color(display-p3 1 0 0)', 'rgb(calc(10 + 5) 0 0)', 'rgb(from red r g b)']) {
      expect(v(`color: ${c}`).color, c).toBe(c);
    }
    expect(v('text-shadow: 1px 1px 2px red, 0 0 1em rgb(0 0 255)').textShadow).toBe('1px 1px 2px red, 0 0 1em rgb(0 0 255)');
    expect(v('text-shadow: red 1px 1px').textShadow).toBe('red 1px 1px');
    for (const img of ['linear-gradient(to right, red 0%, blue 100%)', 'linear-gradient(45deg, red, 30%, blue)',
      'linear-gradient(red 10% 20%, blue)', 'linear-gradient(in oklch, red, blue)',
      'radial-gradient(circle at center, red, blue)', 'radial-gradient(red, blue)',
      'conic-gradient(from 90deg, red, blue)', 'repeating-linear-gradient(red 0 10px, blue 10px 20px)',
      'url(x.png)', "url('x.png'), linear-gradient(red, blue)", '-webkit-linear-gradient(top, red, blue)']) {
      expect(v(`background-image: ${img}`).backgroundImage, img).toBe(img);
    }
    expect(v('font-style: oblique 10deg').fontStyle).toBe('oblique 10deg');
    expect(v("font-family: 'Open Sans', Arial, sans-serif").fontFamily).toBe("'Open Sans', Arial, sans-serif");
    expect(v('vertical-align: 3px').verticalAlign).toBe('3px');
    expect(v('list-style-type: lower-roman').listStyleType).toBe('lower-roman');
    expect(v('text-transform: full-width').textTransform).toBe('full-width');
  });

  it('list-style takes the type out of the shorthand', () => {
    expect(el('<ul style="list-style: square inside"><li>a</li></ul>', 'ul').style.listStyleType).toBe('square');
    expect(el('<ol style="list-style: upper-roman"><li>a</li></ol>', 'ol').style.listStyleType).toBe('upper-roman');
    expect(el('<ul style="list-style: none"><li>a</li></ul>', 'ul').style.listStyleType).toBe('none');
    expect(el('<ul style="list-style: outside url(a.png)"><li>a</li></ul>', 'ul').style.listStyleType).toBe('disc');
  });

  it('the text-decoration shorthand resets the color and style it does not name', () => {
    const p = el('<style>.a { text-decoration-color: red; text-decoration-style: wavy; text-decoration: underline }</style>' +
      '<p class="a" style="color: blue">x</p>', 'p').style;
    expect(p.textDecorationColor).toBe('blue');
    expect(p.textDecorationStyle).toBe('solid');
  });

  it('<font color> follows HTML\'s legacy colour parsing', () => {
    const c = (v: string) => el(`<font color="${v}">x</font>`, 'font').style.color;
    expect(c('red')).toBe('red');
    expect(c('#f00')).toBe('rgb(255, 0, 0)');
    expect(c('f00')).toBe('rgb(15, 0, 0)');
    expect(c('chucknorris')).toBe('rgb(192, 0, 0)');
    expect(c('ff0000')).toBe('rgb(255, 0, 0)');
    // `transparent` is a parse failure: the hint is dropped and color inherits.
    expect(c('transparent')).toBe('rgb(0, 0, 0)');
  });
});

describe('percentages resolve against the containing block', () => {
  it('a block child resolves against its parent\'s content width', () => {
    const p = el('<div style="width:300px"><p style="margin-left:calc(50% - 10px);padding-left:calc(10%);width:50%">a</p></div>', 'p');
    expect(p.style).toMatchObject({ marginLeft: 140, paddingLeft: 30, width: 150 });
    expect(el('<div style="padding-left:100px"><p style="padding-left:10%">a</p></div>', 'p').style.paddingLeft).toBe(30);
  });

  it('a flex item resolves against the flex container', () => {
    const items = elements('<div style="display:flex;width:300px"><p style="flex-basis:50%;margin-left:10%">a</p></div>')
      .filter((n) => n.tagName === 'p');
    expect(items[0].style).toMatchObject({ flexBasis: 150, marginLeft: 30 });
  });

  it('an inline element passes its containing block through', () => {
    const b = el('<div style="width:200px"><span><b style="padding-left:10%">a</b></span></div>', 'b');
    expect(b.style.paddingLeft).toBe(20);
  });

  it('the root resolves against the layout width', () => {
    expect(el('<p style="padding-left:10%">a</p>', 'p').style.paddingLeft).toBe(40);
  });
});

describe('<style media>', () => {
  it('applies a sheet only for an empty, all or screen media list', () => {
    const color = (attr: string) => el(`<style${attr}>.a { color: red }</style><p class="a">x</p>`, 'p').style.color;
    expect(color('')).toBe('red');
    expect(color(' media="screen"')).toBe('red');
    expect(color(' media="all"')).toBe('red');
    expect(color(' media="print, screen"')).toBe('red');
    expect(color(' media="not print"')).toBe('red');
    expect(color(' media="print"')).toBe('rgb(0, 0, 0)');
    expect(color(' media=print')).toBe('rgb(0, 0, 0)');
    expect(color(' media="PRINT"')).toBe('rgb(0, 0, 0)');
  });
});
