/**
 * Tier-1 computed-style oracle: render-tag's `ResolvedStyle` against the
 * browser's own `getComputedStyle`, element by element, over the generated
 * CSS-feature fixtures in `helpers/css-feature-cases.ts`.
 *
 * No fonts, no canvas, no screenshots: a resolver bug shows up here as a named
 * field on a named element ("unit font-size rem › 1:p › fontSize"), long before
 * it becomes an unattributed pixel residual.
 *
 * ## The reference document
 *
 * Each case is written into one reused same-origin iframe, laid out like the
 * native pixel oracle (`native-dom-command.ts`): a harness sheet zeroes the
 * html/body margins, the case's sheet follows it, and the content sits in a
 * plain `<div>` that stands for render-tag's own synthetic root container. The
 * iframe is exactly the layout width wide and FRAME_HEIGHT tall, and
 * render-tag resolves with that viewport, as `layout()` does with its
 * `width` x `height`: `1vw` is 1% of the layout width. ch/ex are measured
 * through a real canvas, as in `layout()`.
 *
 * ## Mapping render-tag's encoding to computed values
 *
 * `ResolvedStyle` is not a 1:1 copy of computed style. Each field is mapped
 * explicitly (see FIELDS below):
 *
 * - `lineHeight: 0` is `normal` (a real zero is carried by the private
 *   LINE_HEIGHT_MULTIPLIER === 0); otherwise px, as the browser resolves it.
 * - `width: 0` is `auto`; `minWidth: null` is `auto`; `minHeight: 0` is
 *   `auto`/none; `flexBasis: null` is `auto`/`content`. These four are read
 *   from the browser's COMPUTED value (a final `* { display: none !important }`
 *   pass turns resolved values into computed ones), and a percentage there is
 *   resolved against the element's containing block as laid out.
 * - Margins, paddings and border widths are the browser's used px, so a
 *   percentage is already resolved against the real containing block.
 * - `textDecorationLine` is render-tag's union with every ancestor's line; it
 *   is compared as the element's OWN lines (entries it declared), which is
 *   what computed `text-decoration-line` is.
 * - `webkitTextStrokeColor` / `webkitTextFillColor`: `''` is `currentcolor`,
 *   resolved against render-tag's own `color`.
 * - `webkitBackgroundClip: ''` is `border-box`; `lineClamp: 0` is `none`;
 *   `letterSpacing`/`wordSpacing` `normal` is 0; `textUnderlineOffset` and
 *   `textDecorationThickness` `null` is `auto` (`from-font` also maps to
 *   null — a documented canvas limitation).
 * - Colors, images, shadows and families are free-form strings render-tag
 *   hands to canvas. They are normalized by assigning render-tag's value to a
 *   probe element in the TOP document (no fixture CSS there) and reading its
 *   computed value back; the probe's own color is a sentinel, so a
 *   `currentcolor` render-tag failed to resolve cannot pass by accident. A
 *   value the browser rejects, or a CSS-wide keyword left as a literal, is
 *   reported as `INVALID(value)`.
 * - Keyword fields (`display`, `whiteSpace`, ...) are compared raw: render-tag
 *   compares them with `===`, so a value the browser would normalize is still
 *   a render-tag bug.
 *
 * Not compared: `textDecorations` (derived structure; its own lines are
 * covered above), `webkitTextStrokeImage` (render-tag's custom property) and
 * `strokeLinejoin` (render-tag's own extension; the SVG property it borrows
 * has a different initial value).
 *
 * ## The ratchet
 *
 * Today many fields diverge. `computed-style-known-failures.json` records the
 * failing keys per browser, so the suite is green and every later resolver
 * step must SHRINK the list: a newly failing key fails, and so does a key that
 * now passes but is still listed (remove it — same philosophy as the pixel
 * baselines). Re-record deliberately with
 * `npm run test:update-computed-style-failures[:webkit|:firefox]`.
 *
 * Firefox has no recorded list yet (it could not launch where this was
 * written): its entry is `null`, so that lane runs every case and reports
 * the divergence count without gating the set until someone records it.
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { parseHTML } from '../src/parse.ts';
import { resolveStylesFromCSS, LINE_HEIGHT_MULTIPLIER } from '../src/css-resolver.ts';
import { Measurer } from '../src/layout.ts';
import type { ResolvedStyle, StyledNode } from '../src/types.ts';
import { CSS_FEATURE_CASES, DEFAULT_WIDTH, type CssFeatureCase } from './helpers/css-feature-cases.ts';
import { browserName } from './helpers/browser-name.ts';
import { gateResidualBaseline } from './helpers/baselines.ts';
import knownFailures from './computed-style-known-failures.json';

const KNOWN_FAILURES_FILE = './tests/computed-style-known-failures.json';

/** px agreement: one layout unit. Used margins and paddings are snapped to
 * 1/64px in Blink and WebKit (0.83em of 24px reads back as 19.90625), while
 * any wrong unit or keyword is off by far more. */
const PX_TOLERANCE = 1 / 64 + 1e-6;

type Value = string | number;

interface ElementFacts {
  /** getComputedStyle while laid out (resolved values: used px for boxes). */
  resolved: CSSStyleDeclaration;
  /** Computed values (every element re-styled `display: none`), filled in
   * the computed pass for the `computedPass` fields only. */
  computed: Record<string, string>;
  /** `display` while laid out (the computed pass hides everything). */
  display: string;
  /** Content-box width of the containing block, for computed percentages. */
  containingWidth: number;
  /** Content-box width of the block container the element is or sits in
   * (text-indent percentages: CSS Text 3 resolves them against it). */
  ownWidth: number;
}

// ─── Normalizing render-tag strings through the browser ─────────────

const SENTINEL_COLOR = 'rgb(1, 2, 3)';
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;
let probe: HTMLElement | null = null;

function viaProbe(property: string, value: string): string {
  if (CSS_WIDE.test(value.trim())) return `INVALID(${value})`;
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(probe);
  }
  probe.style.cssText = `position:absolute;left:-9999px;top:0;color:${SENTINEL_COLOR}`;
  // Clear first: a rejected value must not read back an earlier one (for
  // `color` itself, the sentinel).
  probe.style.removeProperty(property);
  probe.style.setProperty(property, value);
  if (probe.style.getPropertyValue(property) === '') return `INVALID(${value})`;
  return getComputedStyle(probe).getPropertyValue(property);
}

function px(value: string): number | string {
  const n = parseFloat(value);
  return /^-?[\d.]+(e-?\d+)?px$/.test(value.trim()) && !isNaN(n) ? n : value;
}

/** A computed `<length-percentage>` as px against `basis`, else as-is. */
function lengthOrPercent(value: string, basis: number): number | string {
  const v = value.trim();
  if (/^-?[\d.]+%$/.test(v)) return (parseFloat(v) / 100) * basis;
  return px(v);
}

function formatRadius(value: ResolvedStyle['borderTopLeftRadius']): string {
  if (typeof value === 'number') return `${round(value)}px`;
  return `${round(value.pct)}%`;
}

function normalizeDomRadius(value: string): string {
  const parts = value.trim().split(/\s+/);
  const one = parts.length === 2 && parts[0] === parts[1] ? [parts[0]] : parts;
  return one.map((p) => p.replace(/^(-?[\d.]+)/, (n) => `${round(parseFloat(n))}`)).join(' ');
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** render-tag's own decoration lines, i.e. the computed `text-decoration-line`. */
function ownDecorationLines(style: ResolvedStyle): string {
  const own = style.textDecorations.filter((e) => e.declarer === style).map((e) => e.line);
  return own.length ? [...new Set(own)].sort().join(' ') : 'none';
}

function domDecorationLines(value: string): string {
  const lines = value.split(/\s+/).filter((l) => l && l !== 'none');
  return lines.length ? [...new Set(lines)].sort().join(' ') : 'none';
}

function colorOrCurrent(own: ResolvedStyle, value: string): string {
  return value === '' ? viaProbe('color', own.color) : viaProbe('color', value);
}

// ─── Field table ────────────────────────────────────────────────────

interface Field {
  name: keyof ResolvedStyle;
  dom(facts: ElementFacts): Value;
  rt(style: ResolvedStyle, facts: ElementFacts): Value;
  /** Compare only when this holds on the DOM side (read while laid out). */
  when?(facts: ElementFacts): boolean;
  /** Read in the computed-value pass (`facts.computed`), not while laid out. */
  computedPass?: boolean;
}

const SKIP = Symbol('skip');
const PENDING = Symbol('pending');

const cs = (prop: string) => (f: ElementFacts) => f.resolved.getPropertyValue(prop);
const raw = (key: keyof ResolvedStyle) => (s: ResolvedStyle) => String(s[key]);
const usedPx = (prop: string) => (f: ElementFacts) => px(f.resolved.getPropertyValue(prop));
const num = (key: keyof ResolvedStyle) => (s: ResolvedStyle) => s[key] as number;
const probed = (prop: string, key: keyof ResolvedStyle) => (s: ResolvedStyle) =>
  viaProbe(prop, String(s[key]));
const normalOrPx = (prop: string) => (f: ElementFacts) => {
  const v = f.resolved.getPropertyValue(prop);
  return v === 'normal' ? 0 : px(v);
};
/** letter-/word-spacing: a percentage is of the element's own font size
 * (CSS Text 4), and engines keep it as a percentage in computed style. */
const spacing = (prop: string) => (f: ElementFacts) => {
  const v = f.resolved.getPropertyValue(prop);
  return v === 'normal' ? 0 : lengthOrPercent(v, parseFloat(f.resolved.fontSize));
};
const physicalAlign = (align: string, direction: string) =>
  align === 'start' ? (direction === 'rtl' ? 'right' : 'left')
    : align === 'end' ? (direction === 'rtl' ? 'left' : 'right')
      : align;
const blockIsolate = (f: ElementFacts, v: string) =>
  v === 'isolate' && !f.display.startsWith('inline') ? 'normal' : v;
const isBlockish = (f: ElementFacts) =>
  !f.display.startsWith('inline') || f.display === 'inline-block' || f.display === 'inline-flex';

const FIELDS: Field[] = [
  // Text
  {
    name: 'fontFamily',
    // render-tag's root `serif` stands for the UA's initial family, which an
    // engine reports by its own name (Chromium on macOS says "Times").
    dom: (f) => {
      const v = f.resolved.getPropertyValue('font-family');
      return v === uaInitialFamily ? viaProbe('font-family', 'serif') : v;
    },
    rt: probed('font-family', 'fontFamily'),
  },
  { name: 'fontSize', dom: usedPx('font-size'), rt: num('fontSize') },
  { name: 'fontWeight', dom: (f) => Number(f.resolved.fontWeight), rt: num('fontWeight') },
  { name: 'fontStyle', dom: cs('font-style'), rt: raw('fontStyle') },
  { name: 'fontVariantCaps', dom: cs('font-variant-caps'), rt: raw('fontVariantCaps') },
  { name: 'color', dom: cs('color'), rt: probed('color', 'color') },
  {
    name: 'textAlign',
    // `start`/`end` are compared as the side they resolve to under the
    // element's own direction: WebKit's UA sheet gives <li> `match-parent`,
    // which computes to the parent's PHYSICAL side ("left" for `start`).
    dom: (f) => physicalAlign(f.resolved.getPropertyValue('text-align'), f.resolved.direction),
    rt: (s) => physicalAlign(s.textAlign, s.direction),
  },
  { name: 'textAlignLast', dom: cs('text-align-last'), rt: raw('textAlignLast') },
  {
    name: 'textIndent',
    dom: (f) => lengthOrPercent(f.resolved.getPropertyValue('text-indent'), f.ownWidth),
    rt: num('textIndent'),
  },
  { name: 'textTransform', dom: cs('text-transform'), rt: raw('textTransform') },
  { name: 'textDecorationLine', dom: (f) => domDecorationLines(f.resolved.getPropertyValue('text-decoration-line')), rt: ownDecorationLines },
  { name: 'textDecorationStyle', dom: cs('text-decoration-style'), rt: raw('textDecorationStyle') },
  {
    name: 'textDecorationColor',
    // render-tag stores the band's PAINT for an automatic (currentcolor)
    // decoration color: the visible text-stroke color, else the text fill
    // color (Chrome-measured; see resolveElement). Computed style says
    // currentcolor = color. An explicit color is compared as is; one that
    // happens to equal `color` is indistinguishable from currentcolor here.
    dom: (f) => {
      const v = f.resolved.getPropertyValue('text-decoration-color');
      if (v !== f.resolved.color) return v;
      const stroke = f.resolved.getPropertyValue('-webkit-text-stroke-color');
      return parseFloat(f.resolved.getPropertyValue('-webkit-text-stroke-width')) > 0 && !/^rgba\(.*,\s*0\)$/.test(stroke)
        ? stroke
        : f.resolved.getPropertyValue('-webkit-text-fill-color');
    },
    rt: probed('color', 'textDecorationColor'),
  },
  {
    name: 'textUnderlineOffset',
    dom: (f) => {
      const v = f.resolved.getPropertyValue('text-underline-offset');
      return v === 'auto' ? 'auto' : lengthOrPercent(v, parseFloat(f.resolved.fontSize));
    },
    rt: (s) => s.textUnderlineOffset === null ? 'auto' : s.textUnderlineOffset,
  },
  {
    name: 'textDecorationThickness',
    dom: (f) => {
      const v = f.resolved.getPropertyValue('text-decoration-thickness');
      return v === 'auto' || v === 'from-font' ? 'auto' : lengthOrPercent(v, parseFloat(f.resolved.fontSize));
    },
    rt: (s) => s.textDecorationThickness === null ? 'auto' : s.textDecorationThickness,
  },
  { name: 'textShadow', dom: cs('text-shadow'), rt: probed('text-shadow', 'textShadow') },
  { name: 'webkitTextStrokeWidth', dom: usedPx('-webkit-text-stroke-width'), rt: num('webkitTextStrokeWidth') },
  { name: 'webkitTextStrokeColor', dom: cs('-webkit-text-stroke-color'), rt: (s) => colorOrCurrent(s, s.webkitTextStrokeColor) },
  { name: 'webkitTextFillColor', dom: cs('-webkit-text-fill-color'), rt: (s) => colorOrCurrent(s, s.webkitTextFillColor) },
  { name: 'paintOrder', dom: cs('paint-order'), rt: raw('paintOrder') },
  {
    name: 'webkitBackgroundClip',
    dom: (f) => f.resolved.getPropertyValue('-webkit-background-clip') || f.resolved.getPropertyValue('background-clip'),
    rt: (s) => s.webkitBackgroundClip || 'border-box',
  },
  { name: 'backgroundImage', dom: cs('background-image'), rt: probed('background-image', 'backgroundImage') },
  { name: 'letterSpacing', dom: spacing('letter-spacing'), rt: num('letterSpacing') },
  { name: 'wordSpacing', dom: spacing('word-spacing'), rt: num('wordSpacing') },
  { name: 'fontKerning', dom: cs('font-kerning'), rt: raw('fontKerning') },
  {
    name: 'lineHeight',
    dom: (f) => {
      const v = f.resolved.lineHeight;
      return v === 'normal' ? 'normal' : px(v);
    },
    rt: (s) => s.lineHeight === 0 && (s as any)[LINE_HEIGHT_MULTIPLIER] !== 0 ? 'normal' : s.lineHeight,
  },
  { name: 'verticalAlign', dom: cs('vertical-align'), rt: raw('verticalAlign') },
  { name: 'whiteSpace', dom: cs('white-space'), rt: raw('whiteSpace') },
  { name: 'wordBreak', dom: cs('word-break'), rt: raw('wordBreak') },
  { name: 'overflowWrap', dom: cs('overflow-wrap'), rt: raw('overflowWrap') },
  {
    name: 'unicodeBidi',
    // The HTML UA sheet gives div, p, blockquote, ... (and any [dir])
    // `unicode-bidi: isolate`. `isolate` only acts on an INLINE box, so on a
    // block container it is the same as `normal` — on both sides.
    dom: (f) => blockIsolate(f, f.resolved.getPropertyValue('unicode-bidi')),
    rt: (s, f) => blockIsolate(f, s.unicodeBidi),
  },
  { name: 'direction', dom: cs('direction'), rt: raw('direction') },

  // Box
  { name: 'display', dom: cs('display'), rt: raw('display') },
  {
    name: 'width',
    computedPass: true,
    // Width does not apply to non-replaced inline boxes.
    when: isBlockish,
    dom: (f) => {
      const v = f.computed.width;
      return v === 'auto' ? 0 : lengthOrPercent(v, f.containingWidth);
    },
    rt: num('width'),
  },
  {
    name: 'minWidth',
    computedPass: true,
    when: isBlockish,
    // `auto` computes to 0px on a box that is not a flex item (and every box
    // is display:none in the computed pass), so null and 0 are not told apart.
    dom: (f) => {
      const v = f.computed['min-width'];
      return v === 'auto' ? 0 : lengthOrPercent(v, f.containingWidth);
    },
    rt: (s) => s.minWidth ?? 0,
  },
  {
    name: 'minHeight',
    computedPass: true,
    when: isBlockish,
    dom: (f) => {
      const v = f.computed['min-height'];
      // No box here has a definite height: a percentage behaves as `auto`.
      return v === 'auto' || v.endsWith('%') ? 0 : px(v);
    },
    rt: num('minHeight'),
  },
  { name: 'paddingTop', dom: usedPx('padding-top'), rt: num('paddingTop') },
  { name: 'paddingRight', dom: usedPx('padding-right'), rt: num('paddingRight') },
  { name: 'paddingBottom', dom: usedPx('padding-bottom'), rt: num('paddingBottom') },
  { name: 'paddingLeft', dom: usedPx('padding-left'), rt: num('paddingLeft') },
  { name: 'marginTop', dom: usedPx('margin-top'), rt: num('marginTop') },
  { name: 'marginRight', dom: usedPx('margin-right'), rt: num('marginRight') },
  { name: 'marginBottom', dom: usedPx('margin-bottom'), rt: num('marginBottom') },
  { name: 'marginLeft', dom: usedPx('margin-left'), rt: num('marginLeft') },
  { name: 'backgroundColor', dom: cs('background-color'), rt: probed('background-color', 'backgroundColor') },

  // Border
  ...(['Top', 'Right', 'Bottom', 'Left'] as const).flatMap((side): Field[] => {
    const kebab = side.toLowerCase();
    return [
      { name: `border${side}Width`, dom: usedPx(`border-${kebab}-width`), rt: num(`border${side}Width`) },
      { name: `border${side}Style`, dom: cs(`border-${kebab}-style`), rt: raw(`border${side}Style`) },
      { name: `border${side}Color`, dom: cs(`border-${kebab}-color`), rt: probed('color', `border${side}Color`) },
    ];
  }),
  ...(['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const).map((corner): Field => {
    const key = `border${corner}Radius` as const;
    const kebab = corner.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    return {
      name: key,
      dom: (f) => normalizeDomRadius(f.resolved.getPropertyValue(`border${kebab}-radius`)),
      rt: (s) => formatRadius(s[key]),
    };
  }),

  // Flex
  { name: 'flexDirection', dom: cs('flex-direction'), rt: raw('flexDirection') },
  { name: 'gap', dom: normalOrPx('column-gap'), rt: num('gap') },
  { name: 'flexGrow', dom: (f) => Number(f.resolved.flexGrow), rt: num('flexGrow') },
  { name: 'flexShrink', dom: (f) => Number(f.resolved.flexShrink), rt: num('flexShrink') },
  {
    name: 'flexBasis',
    computedPass: true,
    dom: (f) => {
      const v = f.computed['flex-basis'];
      return v === 'auto' || v === 'content' ? 'auto' : lengthOrPercent(v, f.containingWidth);
    },
    rt: (s) => s.flexBasis === null ? 'auto' : s.flexBasis,
  },

  // List
  { name: 'listStyleType', dom: cs('list-style-type'), rt: raw('listStyleType') },
  {
    name: 'lineClamp',
    dom: (f) => {
      const v = f.resolved.getPropertyValue('-webkit-line-clamp');
      return v === 'none' || v === '' ? 0 : Number(v);
    },
    rt: num('lineClamp'),
  },
];

const COMPUTED_PROPS = ['width', 'min-width', 'min-height', 'flex-basis'];

// ─── Reference document ─────────────────────────────────────────────

let frame: HTMLIFrameElement | null = null;
/** The reference iframe's height: the viewport height `vh` resolves against. */
const FRAME_HEIGHT = 600;
/** The UA's initial font-family, read from an unstyled document. */
let uaInitialFamily = '';

function referenceDocument(tc: CssFeatureCase, width: number): Document {
  if (!frame) {
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
  }
  frame.setAttribute('scrolling', 'no');
  frame.style.cssText = `position:absolute;left:0;top:0;border:0;width:${width}px;height:${FRAME_HEIGHT}px;visibility:hidden`;
  const doc = frame.contentDocument!;
  if (!uaInitialFamily) {
    doc.open();
    doc.write('<!doctype html><html><body></body></html>');
    doc.close();
    uaInitialFamily = doc.defaultView!.getComputedStyle(doc.body).fontFamily;
  }
  doc.open();
  doc.write(
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;overflow:hidden}' +
    `</style><style>${tc.css ?? ''}</style></head><body><div>${tc.html}</div></body></html>`,
  );
  doc.close();
  return doc;
}

function contentWidth(el: Element, view: Window): number {
  const s = view.getComputedStyle(el);
  return el.getBoundingClientRect().width
    - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
    - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
}

function containingBlockWidth(el: Element, view: Window, rootWidth: number): number {
  let parent = el.parentElement;
  while (parent && view.getComputedStyle(parent).display.startsWith('inline')) {
    parent = parent.parentElement;
  }
  return parent && parent.tagName !== 'BODY' ? contentWidth(parent, view) : rootWidth;
}

/** Inline size of the block container the element is, or sits in. */
function blockContainerWidth(el: Element, view: Window, rootWidth: number): number {
  return view.getComputedStyle(el).display.startsWith('inline')
    ? containingBlockWidth(el, view, rootWidth)
    : contentWidth(el, view);
}

function label(el: Element, index: number): string {
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return `${index}:${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
}

function collectStyles(node: StyledNode, out: Map<Element, ResolvedStyle>): void {
  if (node.element) out.set(node.element, node.style);
  for (const child of node.children) collectStyles(child, out);
}

function same(a: Value, b: Value): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= PX_TOLERANCE || (isNaN(a) && isNaN(b));
  }
  return String(a) === String(b);
}

interface Divergence { key: string; dom: Value; rt: Value }

function compareCase(tc: CssFeatureCase, counter: { compared: number }): Divergence[] {
  const width = tc.width ?? DEFAULT_WIDTH;
  const doc = referenceDocument(tc, width);
  const view = doc.defaultView!;
  const domRoot = doc.body.firstElementChild!;
  const domEls = [domRoot, ...domRoot.querySelectorAll('*')];

  // Facts while laid out.
  const facts = domEls.map((el): ElementFacts => ({
    resolved: view.getComputedStyle(el),
    computed: {},
    display: view.getComputedStyle(el).display,
    containingWidth: el === domRoot ? width : containingBlockWidth(el, view, width),
    ownWidth: blockContainerWidth(el, view, width),
  }));
  // Every resolved-value field is read NOW, while the case is laid out.
  const domValues = facts.map((f) => FIELDS.map((field): Value | symbol =>
    field.when && !field.when(f) ? SKIP : field.computedPass ? PENDING : field.dom(f)));
  // Computed (not used) values: an element that is not rendered resolves to
  // its computed value. A final author rule hides every element, then the
  // computed-pass fields are read.
  const hide = doc.createElement('style');
  hide.textContent = '* { display: none !important }';
  doc.head.appendChild(hide);
  domEls.forEach((el, i) => {
    const s = view.getComputedStyle(el);
    for (const prop of COMPUTED_PROPS) facts[i].computed[prop] = s.getPropertyValue(prop);
    FIELDS.forEach((field, j) => {
      if (domValues[i][j] === PENDING) domValues[i][j] = field.dom(facts[i]);
    });
  });

  // render-tag's side, from the same markup.
  const { fragment, css } = parseHTML(
    (tc.css ? `<style>${tc.css}</style>` : '') + tc.html,
  );
  const rtEls = [...fragment.querySelectorAll('*')];
  // As layout() calls it: the iframe is the viewport, and ch/ex are
  // measured from the real font.
  const measurer = new Measurer(document.createElement('canvas').getContext('2d')!, new Map());
  const tree = resolveStylesFromCSS(fragment, css, width, {
    viewport: { width, height: FRAME_HEIGHT },
    fontUnits: (style) => measurer.fontUnits(style),
  });
  const styles = new Map<Element, ResolvedStyle>();
  collectStyles(tree, styles);

  if (rtEls.length !== domEls.length - 1) {
    throw new Error(`${tc.name}: element count differs (rt ${rtEls.length}, dom ${domEls.length - 1})`);
  }

  const out: Divergence[] = [];
  const rtStyles = [tree.style, ...rtEls.map((el) => styles.get(el))];
  domEls.forEach((el, i) => {
    const elLabel = i === 0 ? 'root' : label(el, i);
    if (i > 0 && rtEls[i - 1].tagName !== el.tagName) {
      throw new Error(`${tc.name}: element ${i} is <${rtEls[i - 1].tagName}> in render-tag, <${el.tagName}> in the DOM`);
    }
    // <br> and <wbr> become text nodes in render-tag; they have no box style.
    if (el.tagName === 'BR' || el.tagName === 'WBR') return;
    const style = rtStyles[i];
    if (!style) {
      // render-tag drops display:none subtrees and the DOM agrees.
      let hidden = false;
      for (let e: Element | null = el; e && e !== domRoot; e = e.parentElement) {
        if (facts[domEls.indexOf(e)].display === 'none') hidden = true;
      }
      if (!hidden) out.push({ key: `${tc.name} › ${elLabel} › present`, dom: 'box', rt: 'dropped' });
      return;
    }
    FIELDS.forEach((field, j) => {
      const dom = domValues[i][j];
      if (typeof dom === 'symbol') return; // SKIP
      const rt = field.rt(style, facts[i]);
      counter.compared++;
      if (!same(dom, rt)) out.push({ key: `${tc.name} › ${elLabel} › ${field.name}`, dom, rt });
    });
  });
  return out;
}

describe('computed-style parity (ResolvedStyle vs getComputedStyle)', () => {
  it('every CSS-feature fixture matches, except the recorded known failures', async () => {
    const names = new Set<string>();
    for (const tc of CSS_FEATURE_CASES) {
      expect(names.has(tc.name), `duplicate case name ${tc.name}`).toBe(false);
      names.add(tc.name);
    }

    const divergences: Divergence[] = [];
    const counter = { compared: 0 };
    for (const tc of CSS_FEATURE_CASES) divergences.push(...compareCase(tc, counter));
    // Not vacuous: at least the root and one element per case, every field.
    expect(counter.compared).toBeGreaterThan(CSS_FEATURE_CASES.length * FIELDS.length);
    const keys = [...new Set(divergences.map((d) => d.key))].sort();
    // Every divergence with both values, for triage (git-ignored).
    await commands.writeFile(
      `./tests/computed-style-report.${browserName}.json`,
      JSON.stringify(divergences, null, 1) + '\n',
    );

    const updateMode = import.meta.env.MODE === 'update-computed-style';
    const recorded = knownFailures as Record<string, string[] | null>;
    if (recorded[browserName] === null && !updateMode) {
      // An explicitly unrecorded lane (Firefox: never run where this suite
      // was written). It still has to run every case without throwing, but
      // its divergence set is not gated until someone records it there.
      console.warn(
        `[computed-style ${browserName}] no recorded list: ${keys.length} divergent fields ` +
        `NOT gated. Record with npm run test:update-computed-style-failures:${browserName}.`,
      );
      return;
    }
    const expected = await gateResidualBaseline({
      file: KNOWN_FAILURES_FILE,
      browserName,
      signatures: keys,
      recorded: recorded as Record<string, string[]>,
      updateMode,
      writeFile: commands.writeFile,
    });
    if (expected === null) return;

    const known = new Set(expected);
    const failing = new Set(keys);
    const newFailures = divergences.filter((d) => !known.has(d.key));
    const nowPassing = expected.filter((k) => !failing.has(k));
    const describeAll = (list: Divergence[]) =>
      list.map((d) => `  ${d.key}: dom=${JSON.stringify(d.dom)} rt=${JSON.stringify(d.rt)}`).join('\n');
    console.log(
      `[computed-style ${browserName}] ${CSS_FEATURE_CASES.length} cases, ` +
      `${counter.compared} fields compared, ${keys.length} divergent (${expected.length} recorded)`,
    );
    // One assertion, so a run reports both directions at once.
    expect(
      { newFailures: newFailures.map((d) => d.key), nowPassing },
      `Computed-style divergences changed.\n` +
      `New (fix the resolver):\n${describeAll(newFailures)}\n` +
      `Now passing (remove from tests/computed-style-known-failures.json — the list only shrinks):\n` +
      nowPassing.map((k) => `  ${k}`).join('\n'),
    ).toEqual({ newFailures: [], nowPassing: [] });
  }, 120_000);
});
