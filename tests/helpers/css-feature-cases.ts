/**
 * Generated CSS-feature fixtures for the computed-style oracle
 * (`tests/computed-style-parity.test.ts`).
 *
 * The pixel corpus (`test-cases.ts`) is real-world rich text; it contains no
 * `rem`, no `font:` shorthand, no `<small>`/`<mark>`/`<font>`, no structural
 * pseudo-classes. These fixtures exist to exercise exactly those CSS features,
 * one per case, so a resolver bug shows up as a named field on a named element
 * instead of as an unattributed pixel residual. They are NOT pixel cases.
 *
 * Every case is `css` (a stylesheet) plus `html` (the body content). The
 * oracle compares every element. Keep each case small and its name stable:
 * the known-failure list is keyed by case name.
 */
export interface CssFeatureCase {
  name: string;
  css?: string;
  html: string;
  /** Layout width in CSS px; also the oracle's viewport width (for `vw`). */
  width?: number;
}

export const DEFAULT_WIDTH = 400;

// ─── Units ──────────────────────────────────────────────────────────

/**
 * One value per unit. The parent chain is 20px → 24px so `em` (the element's
 * own or its parent's size), `rem` (always the 16px root) and `%` are
 * distinguishable in every property.
 */
const UNITS: Record<string, string> = {
  px: '13px',
  em: '1.5em',
  rem: '1.5rem',
  pt: '12pt',
  percent: '150%',
  vw: '5vw',
  ch: '2ch',
  calc: 'calc(1em + 2px)',
  ex: '2ex',
  vh: '4vh',
  mm: '5mm',
  // No %: the browser reports a percentage calc() unresolved for some properties.
  'calc mixed': 'calc((2em + 1rem) / 2 - 1px)',
};

const UNIT_PROPERTIES = [
  'font-size',
  'line-height',
  'margin-left',
  'padding-top',
  'letter-spacing',
  'word-spacing',
  'text-indent',
];

function unitCases(): CssFeatureCase[] {
  const cases: CssFeatureCase[] = [];
  for (const property of UNIT_PROPERTIES) {
    for (const [unit, value] of Object.entries(UNITS)) {
      const own = property === 'font-size' ? '' : 'font-size:24px;';
      cases.push({
        name: `unit ${property} ${unit}`,
        css: `.k { ${property}: ${value} }`,
        // The first <p> declares inline, the second through the sheet; the
        // spans show what the computed value inherits as.
        html:
          `<div style="font-size:20px">` +
          `<p style="${own}${property}:${value}">inline <span>child</span></p>` +
          `<p class="k" style="${own}">sheet <span>child</span></p>` +
          `</div>`,
      });
    }
  }
  // Unitless line-height inherits as a FACTOR, not as px.
  for (const value of ['1.5', '0', 'normal']) {
    cases.push({
      name: `unit line-height ${value}`,
      html:
        `<div style="font-size:20px;line-height:${value}">` +
        `<p style="font-size:30px">a <span style="font-size:10px">b</span></p></div>`,
    });
  }
  return cases;
}

// ─── font shorthand ─────────────────────────────────────────────────

const FONT_SHORTHANDS: Record<string, string> = {
  'size family': '20px serif',
  'style weight size/line-height families': 'italic bold 24px/1.5 Georgia, serif',
  'variant weight size/px line-height quoted family':
    'small-caps 700 18px/30px "Open Sans", sans-serif',
  'em size and percent line-height': '2em/120% monospace',
  'pt size': '12pt sans-serif',
  'all normal keywords': 'normal normal 400 16px/normal serif',
  'rem size': 'bold 1rem sans-serif',
  'with font-stretch': 'italic small-caps bold condensed 16px/2 cursive',
  'keyword size': 'large serif',
  'invalid (no family)': '20px',
};

function fontShorthandCases(): CssFeatureCase[] {
  const cases: CssFeatureCase[] = Object.entries(FONT_SHORTHANDS).map(([name, value]) => ({
    name: `font shorthand ${name}`,
    css: `.k { font: ${value} }`,
    html:
      `<div style="font-size:10px">` +
      `<p style="font:${value}">inline <b>child</b></p>` +
      `<p class="k">sheet <b>child</b></p></div>`,
  }));
  // The shorthand resets every sub-property it does not name, so an
  // inherited line-height and weight do not survive it.
  cases.push({
    name: 'font shorthand resets line-height and weight',
    html:
      `<div style="line-height:40px;font-weight:700;font-style:italic">` +
      `<p style="font:20px serif">a <span>b</span></p></div>`,
  });
  cases.push({
    name: 'font shorthand then longhand override',
    css: `.k { font: italic 20px serif; font-style: normal; font-weight: 600 }`,
    html: `<p class="k">a <span>b</span></p>`,
  });
  return cases;
}

// ─── !important ─────────────────────────────────────────────────────

function importantCases(): CssFeatureCase[] {
  return [
    {
      name: 'important sheet beats inline',
      css: `.a { color: blue !important; padding-left: 7px !important }`,
      html: `<p class="a" style="color:red;padding-left:3px">a <span>b</span></p>`,
    },
    {
      name: 'important inline beats sheet',
      css: `.a { color: blue; padding-left: 7px }`,
      html: `<p class="a" style="color:red !important;padding-left:3px !important">a</p>`,
    },
    {
      name: 'important inline beats important sheet',
      css: `.a { color: blue !important }`,
      html: `<p class="a" style="color:red !important">a</p>`,
    },
    {
      name: 'important inline font-size',
      html: `<p style="font-size:30px !important;line-height:1.2 !important">a <span>b</span></p>`,
    },
    {
      name: 'important beats higher specificity',
      css: `p.a { color: green } .a { color: blue !important } p.a.b { color: red }`,
      html: `<p class="a b">a</p>`,
    },
    {
      name: 'important later normal does not win',
      css: `.a { font-weight: 700 !important } .a { font-weight: 300 }`,
      html: `<p class="a">a</p>`,
    },
  ];
}

// ─── background ─────────────────────────────────────────────────────

function backgroundCases(): CssFeatureCase[] {
  return [
    { name: 'background none', html: `<p style="background:none">a</p>` },
    { name: 'background NONE uppercase', html: `<p style="background:NONE">a</p>` },
    { name: 'background color', html: `<p style="background:red">a</p>` },
    { name: 'background transparent', html: `<p style="background:transparent">a</p>` },
    {
      name: 'background color resets image',
      css: `.g { background-image: linear-gradient(red, blue) }`,
      html: `<p class="g" style="background:yellow">a</p>`,
    },
    {
      name: 'background none resets color from sheet',
      css: `.g { background-color: red }`,
      html: `<p class="g" style="background:none">a</p>`,
    },
    { name: 'background gradient', html: `<p style="background:linear-gradient(90deg, red, blue)">a</p>` },
    {
      name: 'background color and gradient',
      html: `<p style="background:#fc0 linear-gradient(red, blue)">a</p>`,
    },
    {
      name: 'background url with position',
      html: `<p style="background:url(data:image/png;base64,iVBORw0KGgo=) no-repeat center / 10px 10px">a</p>`,
    },
    { name: 'background rgb with spaces', html: `<p style="background: rgb(10 20 30 / 50%)">a</p>` },
  ];
}

// ─── currentcolor ───────────────────────────────────────────────────

function currentColorCases(): CssFeatureCase[] {
  const cases: CssFeatureCase[] = [];
  for (const spelling of ['currentcolor', 'currentColor', 'CURRENTCOLOR']) {
    cases.push({
      name: `currentcolor border ${spelling}`,
      html: `<p style="color:red;border:4px solid ${spelling}">a <span style="color:blue">b</span></p>`,
    });
  }
  cases.push(
    {
      name: 'currentcolor decoration',
      html: `<p style="color:green;text-decoration:underline currentcolor">a <span style="color:blue">b</span></p>`,
    },
    {
      name: 'currentcolor background-color',
      html: `<p style="color:green;background-color:currentcolor">a</p>`,
    },
    {
      name: 'currentcolor text stroke',
      html: `<p style="color:green;-webkit-text-stroke:1px currentcolor">a <span style="color:blue">b</span></p>`,
    },
    {
      name: 'currentcolor border-color inherits as keyword',
      css: `.p { color: red; border: 2px solid; border-color: currentcolor } .p > span { border: 2px solid; border-color: inherit; color: blue; display: inline-block }`,
      html: `<p class="p">a <span>b</span></p>`,
    },
    {
      name: 'currentcolor in sheet',
      css: `.k { color: purple; border-left: 3px solid CurrentColor; text-decoration-color: currentColor }`,
      html: `<p class="k">a</p>`,
    },
  );
  return cases;
}

// ─── url(data:…) with semicolons ────────────────────────────────────

function dataUrlCases(): CssFeatureCase[] {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return [
    {
      name: 'data url in inline style keeps later declarations',
      html: `<p style="background-image:url(${png});color:red;padding-left:5px">a</p>`,
    },
    {
      name: 'data url quoted in inline style',
      html: `<p style='background-image:url("${png}");color:red'>a</p>`,
    },
    {
      name: 'data url in sheet keeps later declarations',
      css: `.u { background-image: url("${png}"); color: green; padding-left: 6px }`,
      html: `<p class="u">a</p>`,
    },
    {
      name: 'semicolon in quoted string in sheet',
      css: `.q { font-family: "a;b", serif; color: blue }`,
      html: `<p class="q">a</p>`,
    },
  ];
}

// ─── Phrasing, legacy and unknown elements ──────────────────────────

const PHRASING_TAGS = [
  'small', 'mark', 'label', 'abbr', 'cite', 'q', 'kbd', 'var', 'time', 'data',
  'bdi', 'ins', 'dfn', 'samp', 'tt', 'big', 'sub', 'sup', 'code', 'span',
  'a', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'strike', 'nobr', 'wbr',
  'img', 'x-foo', 'my-element', 'unknowntag',
];

const BLOCK_TAGS = [
  'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'figure',
  'figcaption', 'address', 'center', 'dl', 'dt', 'dd', 'details', 'summary',
  'hgroup', 'search', 'menu', 'fieldset', 'legend', 'h1', 'h4', 'h6', 'pre',
  'blockquote', 'hr',
];

function elementCases(): CssFeatureCase[] {
  const cases: CssFeatureCase[] = [];
  for (const tag of PHRASING_TAGS) {
    const inner = tag === 'wbr' || tag === 'img' ? `<${tag}>` : `<${tag}>x</${tag}>`;
    cases.push({
      name: `element <${tag}>`,
      html: `<p style="font-size:20px">a ${inner} b</p>`,
    });
  }
  for (const tag of BLOCK_TAGS) {
    const html = tag === 'dt' || tag === 'dd'
      ? `<dl><${tag}>x</${tag}></dl>`
      : tag === 'summary'
        ? `<details open><summary>x</summary>y</details>`
        : tag === 'legend'
          ? `<fieldset><legend>x</legend>y</fieldset>`
          : tag === 'hr'
            ? `<p>a</p><hr><p>b</p>`
            : `<${tag}>x <span>y</span></${tag}>`;
    cases.push({ name: `element <${tag}>`, html: `<div style="font-size:20px">${html}</div>` });
  }
  // <font> is what document.execCommand emits.
  cases.push(
    { name: 'font color attribute', html: `<p>a <font color="red">b</font> c</p>` },
    { name: 'font face attribute', html: `<p>a <font face="Georgia, serif">b</font> c</p>` },
    {
      name: 'font size attributes',
      html:
        `<p>` +
        ['1', '2', '3', '4', '5', '6', '7', '+1', '-1', '+4']
          .map((size) => `<font size="${size}">${size}</font>`)
          .join(' ') +
        `</p>`,
    },
    {
      name: 'font attribute loses to css',
      css: `font { color: blue }`,
      html: `<p><font color="red">b</font></p>`,
    },
    { name: 'element <span>-like custom element in block', html: `<div>a <x-chip class="c">b</x-chip> c</div>` },
  );
  return cases;
}

// ─── Selectors ──────────────────────────────────────────────────────

const LIST = `<div><p>1</p><p>2</p><p>3</p><p>4</p><p>5</p></div>`;
const MIXED = `<div><span>s1</span><p>p1</p><span>s2</span><p>p2</p><p class="a">p3</p><span>s3</span></div>`;

function selectorCases(): CssFeatureCase[] {
  return [
    { name: 'selector :root', css: `:root { color: red; padding-left: 5px }`, html: `<p>a <span>b</span></p>` },
    { name: 'selector html', css: `html { color: red; padding-left: 5px }`, html: `<p>a <span>b</span></p>` },
    { name: 'selector body', css: `body { color: red; font-size: 20px }`, html: `<p>a <span>b</span></p>` },
    { name: 'selector :first-child', css: `p:first-child { color: red }`, html: LIST },
    { name: 'selector :last-child', css: `p:last-child { color: red }`, html: LIST },
    { name: 'selector :nth-child(2n+1)', css: `p:nth-child(2n+1) { color: red }`, html: LIST },
    { name: 'selector :nth-child(odd)', css: `p:nth-child(odd) { color: red }`, html: LIST },
    { name: 'selector :nth-child(3)', css: `p:nth-child(3) { color: red }`, html: LIST },
    { name: 'selector :nth-child(-n+2)', css: `p:nth-child(-n+2) { color: red }`, html: LIST },
    { name: 'selector :nth-last-child(1)', css: `p:nth-last-child(1) { color: red }`, html: LIST },
    { name: 'selector :first-of-type', css: `p:first-of-type { color: red } span:first-of-type { color: blue }`, html: MIXED },
    { name: 'selector :last-of-type', css: `p:last-of-type { color: red }`, html: MIXED },
    { name: 'selector :only-child', css: `span:only-child { color: red }`, html: `<p><span>a</span></p><p><span>b</span><span>c</span></p>` },
    { name: 'selector :empty', css: `span:empty { padding-left: 5px }`, html: `<p><span></span><span>c</span></p>` },
    { name: 'selector :not()', css: `p:not(.a) { color: red }`, html: MIXED },
    { name: 'selector :is()', css: `:is(p, span).a { color: red }`, html: MIXED },
    { name: 'selector :hover never matches', css: `p:hover { color: red } p:focus { color: blue }`, html: LIST },
    { name: 'selector :link', css: `a:link { color: red } a:visited { color: blue }`, html: `<p><a href="https://example.com/">a</a> <a>b</a></p>` },
    {
      name: 'selector attribute presence',
      css: `[data-x] { color: red }`,
      html: `<p data-x>a</p><p>b</p><p data-x="1">c</p>`,
    },
    {
      name: 'selector attribute value operators',
      css:
        `[data-x="1"] { color: red } [data-y~="b"] { font-weight: 700 } ` +
        `[lang|=en] { font-style: italic } a[href^="http"] { padding-left: 3px } ` +
        `a[href$=".pdf"] { padding-right: 4px } a[href*="mid"] { letter-spacing: 1px } ` +
        `[data-z="Q" i] { color: blue }`,
      html:
        `<p data-x="1">a</p><p data-y="a b c">b</p><p lang="en-US">c</p>` +
        `<p><a href="https://mid.example/x.pdf">d</a> <a href="/y">e</a></p><p data-z="q">f</p>`,
    },
    { name: 'selector #id', css: `#x { color: red } p#y.a { color: blue }`, html: `<p id="x">a</p><p id="y" class="a">b</p>` },
    { name: 'selector uppercase tag', css: `P { color: red } SPAN { color: blue }`, html: `<p>a <span>b</span></p>` },
    { name: 'selector universal', css: `* { padding-left: 2px }`, html: `<p>a <span>b</span></p>` },
    { name: 'selector descendant', css: `div p { color: red } div span { color: blue }`, html: `<div><p>a <span>b</span></p></div><p>c</p>` },
    { name: 'selector child', css: `div > p { color: red } p > em { color: blue }`, html: `<div><p>a <span><em>x</em></span><em>y</em></p></div>` },
    { name: 'selector adjacent sibling', css: `h2 + p { color: red }`, html: `<h2>t</h2><p>a</p><p>b</p>` },
    { name: 'selector general sibling', css: `h2 ~ p { color: red }`, html: `<p>z</p><h2>t</h2><p>a</p><span>s</span><p>b</p>` },
    {
      name: 'selector specificity ordering',
      css:
        `.a.b { color: red } .b { color: blue } ` +
        `p .x { font-weight: 700 } .x { font-weight: 300 } ` +
        `span { letter-spacing: 3px } span { letter-spacing: 1px }`,
      html: `<p class="a b">a <span class="x">b</span></p>`,
    },
    {
      name: 'selector list with one unsupported member',
      css: `p, p::before { color: red } span, p:has(> span) { color: blue }`,
      html: `<p>a <span>b</span></p>`,
    },
    { name: 'selector invalid is dropped', css: `p[ { color: red } p { padding-left: 3px }`, html: `<p>a</p>` },
    {
      name: 'selector compound class and tag',
      css: `p.a { color: red } span.a { color: blue } .a.b.c { padding-left: 4px }`,
      html: `<p class="a">a <span class="a b c">b</span></p><div class="a">c</div>`,
    },
  ];
}

// ─── Inheritance ────────────────────────────────────────────────────

/** Inherited properties: the parent declares, every descendant computes it. */
const INHERITED: Record<string, string> = {
  'font-family': 'Georgia, serif',
  'font-size': '22px',
  'font-weight': '700',
  'font-style': 'italic',
  'font-variant-caps': 'small-caps',
  'font-variant': 'small-caps',
  color: 'rgb(200, 10, 10)',
  'text-align': 'center',
  'text-align-last': 'right',
  'text-indent': '12px',
  'text-transform': 'uppercase',
  'white-space': 'pre-wrap',
  'word-break': 'break-all',
  'overflow-wrap': 'anywhere',
  direction: 'rtl',
  'letter-spacing': '2px',
  'word-spacing': '5px',
  'line-height': '30px',
  'text-shadow': '1px 1px 2px red',
  'font-kerning': 'none',
  'list-style-type': 'square',
  'text-underline-offset': '3px',
  'paint-order': 'stroke',
  '-webkit-text-stroke-width': '1px',
  '-webkit-text-stroke-color': 'blue',
  '-webkit-text-fill-color': 'green',
  'text-decoration-line': 'underline',
};

/** NOT inherited in CSS. Descendants must compute the initial value. */
const NOT_INHERITED: Record<string, string> = {
  'vertical-align': 'super',
  'background-color': 'yellow',
  'padding-left': '9px',
  'border-left': '3px solid red',
  'text-decoration-style': 'wavy',
  'text-decoration-thickness': '3px',
  'unicode-bidi': 'isolate',
  'line-clamp': '2',
  '-webkit-line-clamp': '2',
  'background-clip': 'text',
  'flex-grow': '2',
  'border-top-left-radius': '5px',
};

function inheritanceCases(): CssFeatureCase[] {
  const cases: CssFeatureCase[] = [];
  const tree = (decl: string) =>
    `<div style="${decl}"><p>a <span>b <em>c</em></span></p><ul><li>d</li></ul></div>`;
  for (const [property, value] of Object.entries(INHERITED)) {
    cases.push({ name: `inherit ${property}`, html: tree(`${property}:${value}`) });
  }
  for (const [property, value] of Object.entries(NOT_INHERITED)) {
    cases.push({ name: `not inherited ${property}`, html: tree(`${property}:${value}`) });
  }
  // A line-height in em/% inherits as the parent's COMPUTED px.
  cases.push(
    { name: 'inherit line-height em as px', html: `<div style="font-size:10px;line-height:2em"><p style="font-size:30px">a <span>b</span></p></div>` },
    { name: 'inherit line-height percent as px', html: `<div style="font-size:10px;line-height:150%"><p style="font-size:30px">a <span>b</span></p></div>` },
    { name: 'inherit text-underline-offset percent', html: `<div style="font-size:10px;text-underline-offset:20%"><p style="font-size:30px">a <span>b</span></p></div>` },
  );
  // CSS-wide keywords, on numeric and string properties alike.
  const keywordProps = ['line-height', 'font-weight', 'padding-left', 'color', 'font-family', 'letter-spacing', 'display', 'font-size'];
  for (const keyword of ['inherit', 'initial', 'unset']) {
    cases.push({
      name: `keyword ${keyword}`,
      css: `.k { ${keywordProps.map((p) => `${p}: ${keyword}`).join('; ')} }`,
      html:
        `<div style="line-height:33px;font-weight:700;padding-left:11px;color:red;` +
        `font-family:monospace;letter-spacing:3px;font-size:21px">` +
        `<p class="k">a</p><span class="k">b</span></div>`,
    });
  }
  // Relative keywords.
  cases.push(
    { name: 'keyword bolder lighter', html: `<p style="font-weight:400">a <b style="font-weight:bolder">b <i style="font-weight:lighter">c</i></b> <span style="font-weight:bolder">d</span></p>` },
    { name: 'keyword larger smaller', html: `<p style="font-size:20px">a <span style="font-size:larger">b <i style="font-size:smaller">c</i></span></p>` },
    { name: 'keyword absolute font sizes', html: `<p>${['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large'].map((s) => `<span style="font-size:${s}">${s}</span>`).join(' ')}</p>` },
  );
  return cases;
}

// ─── Percentages and the containing block ───────────────────────────

function percentCases(): CssFeatureCase[] {
  return [
    {
      name: 'percent padding and margin against containing block',
      html:
        `<div style="width:200px"><p style="padding-left:10%;margin-left:50%">a</p></div>` +
        `<p style="padding-left:10%;margin-right:5%">b</p>`,
    },
    {
      name: 'percent width against containing block',
      html: `<div style="width:200px"><p style="width:50%">a</p></div><p style="width:25%">b</p>`,
    },
    {
      name: 'percent nested padded parent',
      html: `<div style="padding-left:100px"><p style="padding-left:10%">a</p></div>`,
    },
    {
      name: 'percent width from stylesheet',
      css: `.w { width: 120px } .h { width: 50% }`,
      html: `<p class="w">a</p><p class="h">b</p>`,
    },
    {
      name: 'percent flex-basis and gap',
      html: `<div style="display:flex;gap:10px;width:300px"><p style="flex-basis:50%;margin:0">a</p><p style="flex:1 1 20%;margin:0">b</p></div>`,
    },
    {
      name: 'percent min-height and min-width',
      html: `<div style="width:200px"><p style="min-height:50%;min-width:25%">a</p><p style="min-height:30px;min-width:40px">b</p></div>`,
    },
  ];
}

// ─── Other resolver gaps from the review ────────────────────────────

function miscCases(): CssFeatureCase[] {
  return [
    {
      name: 'border-width/style/color shorthands',
      html: `<p style="border-style:solid;border-width:1px 2px 3px 4px;border-color:red green blue orange">a</p>`,
    },
    { name: 'border thin solid keyword width', html: `<p style="border:thin solid">a</p><p style="border:medium dashed red">b</p>` },
    { name: 'border none with width', html: `<p style="border-top:3px none red;border-left:5px hidden">a</p>` },
    { name: 'margin auto', html: `<p style="width:100px;margin:0 auto">a</p>` },
    {
      name: 'custom property var()',
      css: `.v { --c: red; --pad: 7px; color: var(--c); padding-left: var(--pad) }`,
      html: `<p class="v">a <span>b</span></p>`,
    },
    {
      name: 'media block',
      css: `@media (min-width: 1px) { p { color: red } } @media (max-width: 1px) { p { padding-left: 9px } }`,
      html: `<p>a</p>`,
    },
    {
      name: 'supports block',
      css: `@supports (display: flex) { p { color: red } }`,
      html: `<p>a</p>`,
    },
    {
      name: 'logical properties use own direction',
      html: `<p dir="rtl" style="padding-inline-start:20px;margin-inline-end:7px">a</p><ul dir="rtl"><li>b</li></ul>`,
    },
    { name: 'list-style shorthand', html: `<ul style="list-style:square inside"><li>a</li></ul><ol style="list-style:upper-roman"><li>b</li></ol>` },
    { name: 'text-decoration shorthand', html: `<p style="text-decoration:underline dotted red 2px">a <span>b</span></p>` },
    { name: 'brace inside string in sheet', css: `p::after { content: "}" } p { color: red }`, html: `<p>a</p>` },
    { name: 'comments and whitespace in sheet', css: `/* x */ p /* y */ { color : red ; /* z */ padding-left : 4px }`, html: `<p>a</p>` },
    { name: 'inline style with comment', html: `<p style="color:red; /* note; with semicolon */ padding-left:4px">a</p>` },
    { name: 'hex and named colors', html: `<p style="color:#f00a;background-color:RebeccaPurple;border:1px solid #0f0">a</p>` },
    { name: 'display none subtree', html: `<p style="display:none">a <span>b</span></p><p>c</p>` },
    { name: 'dir attribute', html: `<p dir="rtl">a <span dir="ltr">b</span> <bdo dir="rtl">c</bdo></p>` },
  ];
}

// ─── Malformed input: what a browser drops or normalizes ──────────────

/**
 * Adversarial input from the Stage 2 review. Inline styles are read from the
 * raw attribute, not the CSSOM, so render-tag itself must drop what a browser
 * drops (an invalid value over a valid sheet value, a stray `}`) and
 * lower-case what it lower-cases (keywords).
 */
function malformedCases(): CssFeatureCase[] {
  return [
    {
      name: 'malformed invalid inline values keep the sheet values',
      css:
        `.a { color: red; display: block; white-space: pre; background-color: red; text-shadow: 1px 1px red; ` +
        `font-style: italic; font-family: Arial; background-image: linear-gradient(red, blue); ` +
        `border-top: 2px solid red; text-decoration: underline red }`,
      html:
        `<span class="a" style="color: foo; display: blok; white-space: bogus; background-color: bogus; ` +
        `text-shadow: bogus; font-style: obliqe; font-family: 12px; background-image: linear-gradient(bogus); ` +
        `border-top-style: wobbly; text-decoration-color: nope">x</span>` +
        `<p class="a" style="color: rgb(1,2); font-size: 40">y</p>`,
    },
    {
      name: 'malformed uppercase inline keywords',
      html:
        `<p style="COLOR:RED;font-size:2EM;display:INLINE;text-align:CENTER">a</p>` +
        `<p style="white-space:PRE;text-transform:UPPERCASE;font-style:ITALIC;vertical-align:SUPER;border-top:2PX SOLID BLUE">b</p>`,
    },
    {
      name: 'malformed uppercase sheet keywords',
      css: `p { DISPLAY: INLINE-BLOCK; TEXT-ALIGN: RIGHT; WHITE-SPACE: NOWRAP; FONT-STYLE: OBLIQUE }`,
      html: `<p>a</p>`,
    },
    {
      name: 'malformed valid modern values',
      html:
        `<p style="display: inline flex; color: rgb(1 2 3 / 50%); background-color: hsl(120deg 50% 50%)">a</p>` +
        `<p style="text-shadow: red 1px 1px, 0 0 1em blue; background-image: linear-gradient(in oklch, red 10% 20%, blue)">b</p>`,
    },
    {
      name: 'malformed shorthands reset what they do not name',
      html:
        `<p style="border: solid red">a</p><p style="border-top: 4px dotted; border-top: blue">b</p>` +
        `<ul style="list-style: none inside"><li>c</li></ul><p style="-webkit-text-stroke: red">d</p>`,
    },
    { name: 'malformed comment between compound selectors', css: `.a/**/.b { color: red }`, html: `<p class="a b">a</p>` },
    {
      name: 'malformed stray brace in a style attribute',
      html: `<p style="color: red; } font-size: 20px; margin-left: 7px">a</p>`,
    },
    {
      name: 'malformed stray top-level brace in a sheet',
      css: `.a { color: red } }} .b { color: blue } ] .c { color: green } .d { padding-left: 3px }`,
      html: `<p class="a">a</p><p class="b">b</p><p class="c">c</p><p class="d">d</p>`,
    },
    {
      name: 'malformed selector list with an invalid member',
      css: `p, p:foo { color: red } span, ] { color: blue } em, em::bogus { padding-left: 3px } i, i:hover { color: green }`,
      html: `<p>a <span>b</span> <em>c</em> <i>d</i></p>`,
    },
    {
      name: 'malformed double important',
      css: `.a { color: green } .a { color: red !important !important } .a { padding-left: 3px !ie }`,
      html: `<p class="a">a</p>`,
    },
    {
      name: 'malformed font color legacy parsing',
      html:
        `<p><font color="f00">a</font> <font color="transparent">b</font> ` +
        `<font color="chucknorris">c</font> <font color="#0f0">d</font> <font color="00ff00">e</font></p>`,
    },
    {
      name: 'malformed text-decoration shorthand resets its color',
      css: `.a { text-decoration-color: red; text-decoration-style: wavy; text-decoration: underline }`,
      html: `<p class="a" style="color: blue">a</p>`,
    },
    {
      name: 'malformed percent calc in a nested block and a flex item',
      html:
        `<div style="width:300px"><p style="margin-left:calc(50% - 10px);padding-left:calc(10%)">a</p></div>` +
        `<div style="display:flex;width:200px"><p style="margin-left:10%;width:100px">b</p></div>`,
    },
    {
      name: 'malformed invalid inline shorthand keeps the earlier value',
      html:
        `<p style="padding:7px;padding:10px bogus;margin:3px;margin:1px 2px 3px 4px 5px">a</p>` +
        `<p style="font:italic 500 24px serif;font:bold 50px nonsense();text-decoration:underline red;text-decoration:overline 5bad">b</p>` +
        `<p style="-webkit-text-stroke:2px red;-webkit-text-stroke:5bad blue">c</p>` +
        `<div style="display:flex"><p style="flex:2 3 10px;flex:1 1 bogus">d</p></div>`,
    },
    {
      name: 'malformed invalid sheet shorthand keeps the earlier value',
      css:
        `.a { padding: 7px; padding: 10px bogus; margin: 3px; margin: 1px 2px 3px 4px 5px } ` +
        `.b { font: italic 500 24px serif; font: bold 50px nonsense(); text-decoration: underline red; text-decoration: overline 5bad } ` +
        `.c { -webkit-text-stroke: 2px red; -webkit-text-stroke: 5bad blue } .d { flex: 2 3 10px; flex: 1 1 bogus }`,
      html: `<p class="a">a</p><p class="b">b</p><p class="c">c</p><div style="display:flex"><p class="d">d</p></div>`,
    },
    {
      name: 'malformed general sibling and complex :is',
      css: `.x ~ p { color: red } :is(section p) { padding-left: 3px } p:not(:hover) { letter-spacing: 1px }`,
      html: `<section><p>a</p><p class="x">b</p><p>c</p></section>`,
    },
  ];
}

export const CSS_FEATURE_CASES: CssFeatureCase[] = [
  ...unitCases(),
  ...fontShorthandCases(),
  ...importantCases(),
  ...backgroundCases(),
  ...currentColorCases(),
  ...dataUrlCases(),
  ...elementCases(),
  ...selectorCases(),
  ...inheritanceCases(),
  ...percentCases(),
  ...miscCases(),
  ...malformedCases(),
];
