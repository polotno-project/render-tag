/**
 * Selectors: parsing, specificity and matching, on an ALLOWLIST. A selector
 * that uses anything not listed here is unsupported and never matches — it is
 * not stripped down to the parts that are understood (that made `:root {}`
 * hit every element and `p:first-of-type` every `<p>`).
 *
 * Supported:
 * - type (case-insensitive), `*`, `#id`, `.class`;
 * - attributes `[a]`, `[a=v]`, `[a~=v]`, `[a|=v]`, `[a^=v]`, `[a$=v]`, `[a*=v]`,
 *   with the `i`/`s` flags and HTML's case-insensitive attribute values;
 * - combinators: descendant, `>`, `+`, `~`;
 * - `:root`, `:empty`, `:first-child`, `:last-child`, `:only-child`,
 *   `:nth-child(An+B)`, `:nth-last-child(An+B)`, `:first-of-type`,
 *   `:last-of-type`, `:only-of-type`, `:nth-of-type(An+B)`,
 *   `:nth-last-of-type(An+B)`, `:link`/`:any-link` (`a`/`area` with `href`);
 * - `:not()`, `:is()`, `:where()` over complex selectors; `:is()`/`:where()`
 *   take a forgiving list (an invalid or unsupported argument drops alone);
 * - `::marker` at the end (its declarations style the list marker);
 * - dynamic states (`:hover`, `:focus`, `:visited`, ...) are never active in a
 *   static render: `a:hover` never matches, `p:not(:hover)` always does.
 *
 * Valid but unsupported, so the selector never matches: `:has()`,
 * `:nth-child(An+B of S)`, `:lang()`, `:dir()`, form states, other
 * pseudo-elements, namespaces.
 *
 * INVALID and UNSUPPORTED are kept apart (Selectors 4 §3.1): an invalid
 * selector (`p:foo`, `::bogus`, `]`) makes its whole selector list invalid, so
 * the rule is dropped; an unsupported one drops only itself from the list.
 *
 * The root context stands for BOTH `html` and `body` (render-tag's synthetic
 * container), so `html`, `body` and `:root` match it, and a chain may climb
 * one step above it to a virtual `html` (`html > body > p`).
 */

export interface ElementContext {
  /** Lower-case tag name. */
  tagName: string;
  classes: Set<string>;
  /** null for the root container. */
  parent: ElementContext | null;
  el: Element;
}

type AttrOp = '' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';

interface AttrTest {
  name: string;
  op: AttrOp;
  value: string;
  /** Compare the value ASCII case-insensitively. */
  ci: boolean;
}

type Pseudo =
  | { kind: 'nth'; a: number; b: number; fromEnd: boolean; ofType: boolean }
  | { kind: 'only'; ofType: boolean }
  | { kind: 'root' | 'empty' | 'link' }
  /** A dynamic state, never active in a static render (`:hover`). */
  | { kind: 'never' }
  /** `:where()` matches like `:is()` but adds no specificity. */
  | { kind: 'not' | 'is' | 'where'; list: ParsedSelector[] };

export interface Compound {
  /** Lower-case tag, or '' for any. */
  tag: string;
  /** `html`/`body`: matches the root context only. */
  rootAlias: boolean;
  id: string | null;
  classes: string[];
  attrs: AttrTest[];
  pseudos: Pseudo[];
}

type Combinator = ' ' | '>' | '+' | '~';

export interface ParsedSelector {
  /** Compound selectors, rightmost first. */
  compounds: Compound[];
  /** `combinators[i]` relates `compounds[i]` to `compounds[i + 1]` (its left). */
  combinators: Combinator[];
  /** Specificity packed as ids·1e6 + classes·1e3 + types. */
  spec: number;
  pseudoElement?: 'marker';
  /** The rightmost compound targets the root as `html`/`:root` or as `body`. */
  rootKind: 'html' | 'body' | null;
}

// ─── Parsing ────────────────────────────────────────────────────────

/** Attributes whose values HTML matches case-insensitively in selectors. */
const CASE_INSENSITIVE_ATTRS = new Set([
  'accept', 'accept-charset', 'align', 'alink', 'axis', 'bgcolor', 'charset', 'checked', 'clear',
  'codetype', 'color', 'compact', 'declare', 'defer', 'dir', 'direction', 'disabled', 'enctype',
  'face', 'frame', 'hreflang', 'http-equiv', 'lang', 'language', 'link', 'media', 'method',
  'multiple', 'nohref', 'noresize', 'noshade', 'nowrap', 'readonly', 'rel', 'rev', 'rules',
  'scope', 'scrolling', 'selected', 'shape', 'target', 'text', 'type', 'valign', 'valuetype', 'vlink',
]);

/** Dynamic user/element states: valid, and never active in a static render. */
const NEVER_ACTIVE = new Set([
  'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited', 'target', 'target-within',
  'user-valid', 'user-invalid', 'autofill', '-webkit-autofill', 'fullscreen', '-webkit-full-screen',
  'modal', 'popover-open', 'picture-in-picture', 'playing', 'paused', 'seeking', 'buffering',
  'stalled', 'muted', 'volume-locked', '-webkit-drag',
]);

/**
 * Other pseudo-classes (and the legacy one-colon pseudo-elements) that a
 * browser parses: valid, so they do not invalidate a selector list, but
 * render-tag does not evaluate them.
 */
const VALID_UNSUPPORTED_PSEUDO_CLASSES = new Set([
  'checked', 'default', 'defined', 'disabled', 'enabled', 'indeterminate', 'in-range', 'out-of-range',
  'invalid', 'valid', 'optional', 'required', 'placeholder-shown', 'read-only', 'read-write', 'blank',
  'current', 'past', 'future', 'local-link', 'host', 'open', 'closed', 'first', 'left', 'right',
  'before', 'after', 'first-line', 'first-letter', 'state', 'xr-overlay', 'focus-within-visible',
]);
const VALID_UNSUPPORTED_FUNCTIONAL = new Set([
  'has', 'lang', 'dir', 'host', 'host-context', 'state', 'nth-col', 'nth-last-col', 'current',
  'active-view-transition-type',
]);

/** Pseudo-elements a browser parses (besides `::marker`, the one render-tag styles). */
const VALID_PSEUDO_ELEMENTS = new Set([
  'before', 'after', 'first-line', 'first-letter', 'placeholder', 'selection', 'backdrop',
  'file-selector-button', 'cue', 'cue-region', 'grammar-error', 'spelling-error', 'target-text',
  'view-transition', 'details-content', 'search-text', 'scroll-marker', 'scroll-marker-group',
  'column', 'checkmark', 'picker-icon',
]);
const VALID_FUNCTIONAL_PSEUDO_ELEMENTS = new Set([
  'highlight', 'part', 'slotted', 'cue', 'cue-region', 'view-transition-group', 'view-transition-image-pair',
  'view-transition-old', 'view-transition-new', 'scroll-button', 'picker',
]);

class SelectorParser {
  i = 0;
  /** Set when the selector is valid so far but uses something render-tag does not evaluate. */
  unsupported = false;
  constructor(readonly s: string) {}

  private peek(): string { return this.s[this.i] ?? ''; }

  ws(): boolean {
    const start = this.i;
    while (/\s/.test(this.peek()) && this.i < this.s.length) this.i++;
    return this.i > start;
  }

  /** A CSS identifier (escapes decoded), or null. */
  ident(): string | null {
    const s = this.s;
    let out = '';
    const start = this.i;
    if (s[this.i] === '-') { out += '-'; this.i++; }
    if (s[this.i] === '-') { out += '-'; this.i++; }
    for (;;) {
      const c = s[this.i];
      if (c === undefined) break;
      if (c === '\\') {
        if (this.i + 1 >= s.length) return null;
        out += this.escape();
      } else if (/[\w\u0080-￿-]/.test(c)) {
        out += c;
        this.i++;
      } else break;
    }
    // An identifier cannot start with a digit, or a hyphen and a digit
    // (unless escaped, which the raw text shows).
    if (!out || out === '-' || /^-?\d/.test(s.slice(start, this.i))) { this.i = start; return null; }
    return out;
  }

  /** A quoted string (escapes decoded), or null. */
  string(): string | null {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") return null;
    let out = '';
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === quote) { this.i++; return out; }
      if (c === '\\') out += this.escape();
      else { out += c; this.i++; }
    }
    return null;
  }

  /** The escape at `\` (hex or one literal character), decoded and consumed. */
  private escape(): string {
    const hex = /^[0-9a-f]{1,6}\s?/i.exec(this.s.slice(this.i + 1));
    if (hex) {
      const ch = String.fromCodePoint(parseInt(hex[0], 16) || 0xfffd);
      this.i += 1 + hex[0].length;
      return ch;
    }
    this.i += 2;
    return this.s[this.i - 1] ?? '';
  }

  /** The text of a `( ... )` argument, the `(` already consumed; balanced, string-aware. */
  argument(): string | null {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"' || c === "'") { if (this.string() === null) return null; continue; }
      if (c === '\\') { this.i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) { this.i++; return this.s.slice(start, this.i - 1); }
        depth--;
      }
      this.i++;
    }
    return null;
  }

  /**
   * One compound selector, or null when it is invalid or there is nothing
   * here. Something valid but unsupported sets `unsupported` and parses on.
   */
  compound(): Compound | null {
    const c: Compound = { tag: '', rootAlias: false, id: null, classes: [], attrs: [], pseudos: [] };
    let any = false;
    // Namespaces: `*|p` and `|p` are valid (unsupported); a prefix is
    // invalid, since no @namespace rule is ever honoured to declare it.
    if (this.peek() === '|' && this.s[this.i + 1] !== '=') {
      this.i++;
      this.unsupported = true;
    } else if (this.peek() === '*' && this.s[this.i + 1] === '|' && this.s[this.i + 2] !== '=') {
      this.i += 2;
      this.unsupported = true;
    }
    if (this.peek() === '*') { this.i++; any = true; }
    else {
      const tag = this.ident();
      if (tag !== null) {
        c.tag = tag.toLowerCase();
        c.rootAlias = c.tag === 'html' || c.tag === 'body';
        any = true;
      }
    }
    if (this.peek() === '|') return null; // a namespace prefix
    for (;;) {
      const ch = this.peek();
      if (ch === '#') {
        this.i++;
        const id = this.ident();
        if (id === null) return null;
        // `#a#b` is valid and matches nothing.
        if (c.id !== null && c.id !== id) this.unsupported = true;
        c.id = id;
      } else if (ch === '.') {
        this.i++;
        const cls = this.ident();
        if (cls === null) return null;
        c.classes.push(cls);
      } else if (ch === '[') {
        this.i++;
        const attr = this.attribute();
        if (!attr) return null;
        c.attrs.push(attr);
      } else if (ch === ':' && this.s[this.i + 1] !== ':') {
        this.i++;
        const pseudo = this.pseudoClass();
        if (!pseudo) return null;
        c.pseudos.push(pseudo);
      } else break;
      any = true;
    }
    return any ? c : null;
  }

  private attribute(): AttrTest | null {
    this.ws();
    const name = this.ident();
    if (name === null) return null;
    this.ws();
    let op: AttrOp = '';
    let value = '';
    let ci = false;
    if (this.peek() !== ']') {
      const m = /^(=|~=|\|=|\^=|\$=|\*=)/.exec(this.s.slice(this.i));
      if (!m) return null;
      op = m[1] as AttrOp;
      this.i += m[1].length;
      this.ws();
      const v = this.string() ?? this.ident();
      if (v === null) return null;
      value = v;
      this.ws();
      const flag = /^[is](?![\w-])/i.exec(this.s.slice(this.i));
      if (flag) {
        ci = flag[0].toLowerCase() === 'i';
        this.i++;
        this.ws();
      } else {
        ci = CASE_INSENSITIVE_ATTRS.has(name.toLowerCase());
      }
    }
    if (this.peek() !== ']') return null;
    this.i++;
    return { name: name.toLowerCase(), op, value: ci ? value.toLowerCase() : value, ci };
  }

  /**
   * After `:`. A pseudo-class, or null when it is invalid. A valid one
   * render-tag does not evaluate sets `unsupported` (and returns a stand-in).
   */
  pseudoClass(): Pseudo | null {
    const name = this.ident()?.toLowerCase();
    if (!name) return null;
    if (this.peek() !== '(') {
      switch (name) {
        case 'root': case 'scope': return { kind: 'root' };
        case 'empty': return { kind: 'empty' };
        case 'link': case 'any-link': case '-webkit-any-link': return { kind: 'link' };
        case 'first-child': return nth(0, 1, false, false);
        case 'last-child': return nth(0, 1, true, false);
        case 'first-of-type': return nth(0, 1, false, true);
        case 'last-of-type': return nth(0, 1, true, true);
        case 'only-child': return { kind: 'only', ofType: false };
        case 'only-of-type': return { kind: 'only', ofType: true };
      }
      if (NEVER_ACTIVE.has(name)) return { kind: 'never' };
      if (VALID_UNSUPPORTED_PSEUDO_CLASSES.has(name)) return this.unsupportedPseudo();
      return null; // unknown: invalid
    }
    this.i++;
    const arg = this.argument();
    if (arg === null) return null;
    switch (name) {
      case 'nth-child': case 'nth-last-child': case 'nth-of-type': case 'nth-last-of-type': {
        // `An+B of S` (child forms only) is valid; render-tag does not filter by S.
        const of = /^(.*?)\s+of\s+(.+)$/is.exec(arg);
        if (of && !name.endsWith('of-type')) {
          if (!parseNth(of[1]) || parseSelectorListResult(of[2]) === INVALID) return null;
          return this.unsupportedPseudo();
        }
        const ab = parseNth(arg);
        return ab && nth(ab[0], ab[1], name.includes('last'), name.endsWith('of-type'));
      }
      case 'not': case 'is': case 'where': case 'matches': case '-webkit-any': {
        const forgiving = name !== 'not';
        const list: ParsedSelector[] = [];
        for (const part of splitList(arg)) {
          const sel = parseComplex(part, false);
          if (sel === INVALID || sel === UNSUPPORTED) {
            // :is()/:where() take a forgiving list: the argument drops alone.
            if (forgiving) continue;
            if (sel === INVALID) return null;
            return this.unsupportedPseudo();
          }
          list.push(sel);
        }
        // An empty forgiving list is valid and matches nothing.
        return { kind: name === 'not' ? 'not' : name === 'where' ? 'where' : 'is', list };
      }
    }
    if (VALID_UNSUPPORTED_FUNCTIONAL.has(name)) return this.unsupportedPseudo();
    return null;
  }

  private unsupportedPseudo(): Pseudo {
    this.unsupported = true;
    return { kind: 'never' };
  }
}

function nth(a: number, b: number, fromEnd: boolean, ofType: boolean): Pseudo {
  return { kind: 'nth', a, b, fromEnd, ofType };
}

/** Split a selector list at top-level commas (outside parens, brackets, strings). */
function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** `An+B` (Selectors 4 §13), `odd`, `even`; null when invalid or `of S`. */
function parseNth(arg: string): [number, number] | null {
  const v = arg.trim().toLowerCase();
  if (v === 'odd') return [2, 1];
  if (v === 'even') return [2, 0];
  const int = /^[+-]?\d+$/.exec(v);
  if (int) return [0, parseInt(v, 10)];
  const m = /^([+-]?)(\d*)n(?:\s*([+-])\s*(\d+))?$/.exec(v);
  if (!m) return null;
  const a = (m[1] === '-' ? -1 : 1) * (m[2] === '' ? 1 : parseInt(m[2], 10));
  const b = m[3] ? (m[3] === '-' ? -1 : 1) * parseInt(m[4], 10) : 0;
  return [a, b];
}

function compoundSpecificity(c: Compound): number {
  let spec = (c.id !== null ? 1e6 : 0) + (c.classes.length + c.attrs.length) * 1e3 + (c.tag ? 1 : 0);
  for (const p of c.pseudos) {
    if (p.kind === 'where') continue;
    if (p.kind === 'not' || p.kind === 'is') {
      // The most specific argument.
      let max = 0;
      for (const arg of p.list) max = Math.max(max, arg.spec);
      spec += max;
    } else spec += 1e3;
  }
  return spec;
}

/** parseComplex results that are not a selector. */
const INVALID = Symbol('invalid');
const UNSUPPORTED = Symbol('unsupported');

/**
 * Parse one complex selector (one member of a selector list, or one argument
 * of `:is()`/`:not()`, where no pseudo-element is allowed).
 */
function parseComplex(text: string, allowPseudoElement: boolean): ParsedSelector | typeof INVALID | typeof UNSUPPORTED {
  const p = new SelectorParser(text.trim());
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let pseudoElement: 'marker' | undefined;
  for (;;) {
    let comp = p.compound();
    if (p.s.startsWith('::', p.i)) {
      if (!allowPseudoElement) return INVALID;
      p.i += 2;
      const name = p.ident()?.toLowerCase();
      if (!name) return INVALID;
      if (p.s[p.i] === '(') {
        p.i++;
        if (p.argument() === null || !VALID_FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) return INVALID;
        p.unsupported = true;
      } else if (name === 'marker') {
        pseudoElement = 'marker';
      } else if (VALID_PSEUDO_ELEMENTS.has(name) || name.startsWith('-webkit-')) {
        // Blink and WebKit accept any `::-webkit-` pseudo-element.
        p.unsupported = true;
      } else return INVALID;
      comp ??= { tag: '', rootAlias: false, id: null, classes: [], attrs: [], pseudos: [] };
      compounds.push(comp);
      // Only pseudo-classes may follow a pseudo-element (`::before:hover`).
      while (p.s[p.i] === ':' && p.s[p.i + 1] !== ':') {
        p.i++;
        if (p.pseudoClass() === null) return INVALID;
        p.unsupported = true;
      }
      p.ws();
      if (p.i !== p.s.length) return INVALID; // a pseudo-element ends the selector
      break;
    }
    if (!comp) return INVALID;
    compounds.push(comp);
    const spaced = p.ws();
    if (p.i >= p.s.length) break;
    const c = p.s[p.i];
    if (c === '>' || c === '+' || c === '~') {
      p.i++;
      p.ws();
      combinators.push(c);
    } else if (spaced) {
      combinators.push(' ');
    } else return INVALID;
  }
  if (p.unsupported) return UNSUPPORTED;
  compounds.reverse();
  combinators.reverse();
  let spec = pseudoElement ? 1 : 0;
  for (const c of compounds) spec += compoundSpecificity(c);
  const rightmost = compounds[0];
  const rootKind = rightmost.tag === 'body'
    ? 'body'
    : rightmost.tag === 'html' || rightmost.pseudos.some((q) => q.kind === 'root') ? 'html' : null;
  return { compounds, combinators, spec, pseudoElement, rootKind };
}

/** A selector list's supported members, or INVALID when any member is invalid. */
function parseSelectorListResult(prelude: string): ParsedSelector[] | typeof INVALID {
  const out: ParsedSelector[] = [];
  for (const member of splitList(prelude)) {
    const sel = parseComplex(member, true);
    if (sel === INVALID) return INVALID;
    if (sel !== UNSUPPORTED) out.push(sel);
  }
  return out;
}

/**
 * The supported members of a selector list (a rule's prelude). An
 * unsupported member is dropped alone and the others still match; one
 * INVALID member drops the whole list (Selectors 4 §3.1), as browsers do.
 */
export function parseSelectorList(prelude: string): ParsedSelector[] {
  const list = parseSelectorListResult(prelude);
  return list === INVALID ? [] : list;
}

// ─── Matching ───────────────────────────────────────────────────────

/** The virtual `html` above the root context (whose own role is `body`). */
const VIRTUAL_HTML: ElementContext = {
  tagName: 'html', classes: new Set(), parent: null, el: null as unknown as Element,
};

interface Position {
  index: number;
  count: number;
  typeIndex: number;
  typeCount: number;
}

const ONLY: Position = { index: 1, count: 1, typeIndex: 1, typeCount: 1 };

/**
 * Selector matching for ONE resolve call. Caches each parent's child
 * positions and the general-sibling (`~`) answer per element: "does some
 * earlier sibling match the rest of the chain?" is the previous sibling's
 * answer plus one test, so a `~` rule over a long list stays linear (it was
 * quadratic: 610 ms for one rule on 4,000 items). The answer is keyed by the
 * ELEMENT: a sibling's context is rebuilt when asked for, not kept.
 */
export class SelectorMatcher {
  private readonly positions = new Map<Element, Map<Element, Position>>();
  /** Per selector, per combinator index: element → some earlier sibling matches. */
  private readonly siblingMemo = new Map<ParsedSelector, Map<Element, boolean>[]>();

  /** The context of `el`, whose parent context is `parent`. */
  context(el: Element, parent: ElementContext | null): ElementContext {
    const classes = new Set<string>();
    const className = el.getAttribute('class');
    if (className) for (const c of className.split(/\s+/)) if (c) classes.add(c);
    return { tagName: el.tagName.toLowerCase(), classes, parent, el };
  }

  matches(sel: ParsedSelector, ctx: ElementContext): boolean {
    return this.compound(sel.compounds[0], ctx) && this.from(sel, 0, ctx);
  }

  /** compounds[i] matched `ctx`; match the rest of the chain to its left. */
  private from(sel: ParsedSelector, i: number, ctx: ElementContext): boolean {
    if (i === sel.compounds.length - 1) return true;
    const next = sel.compounds[i + 1];
    switch (sel.combinators[i]) {
      case '>': {
        const parent = this.up(ctx);
        return parent !== null && this.compound(next, parent) && this.from(sel, i + 1, parent);
      }
      case ' ':
        for (let a = this.up(ctx); a; a = this.up(a)) {
          if (this.compound(next, a) && this.from(sel, i + 1, a)) return true;
        }
        return false;
      case '+': {
        const prev = this.previous(ctx);
        return prev !== null && this.compound(next, prev) && this.from(sel, i + 1, prev);
      }
      default:
        return this.someEarlierSibling(sel, i, ctx);
    }
  }

  /**
   * `~`: does a sibling before `ctx` match compounds[i + 1] and the chain
   * left of it? Walks back only until a sibling whose own answer is known;
   * every sibling walked past gets the same answer recorded.
   */
  private someEarlierSibling(sel: ParsedSelector, i: number, ctx: ElementContext): boolean {
    let perIndex = this.siblingMemo.get(sel);
    if (!perIndex) this.siblingMemo.set(sel, perIndex = []);
    const memo = perIndex[i] ??= new Map();
    const known = memo.get(ctx.el);
    if (known !== undefined) return known;
    const next = sel.compounds[i + 1];
    const walked: Element[] = [ctx.el];
    let result = false;
    for (let s = this.previous(ctx); s; s = this.previous(s)) {
      if (this.compound(next, s) && this.from(sel, i + 1, s)) { result = true; break; }
      const answer = memo.get(s.el);
      if (answer !== undefined) { result = answer; break; }
      walked.push(s.el);
    }
    for (const w of walked) memo.set(w, result);
    return result;
  }

  private up(ctx: ElementContext): ElementContext | null {
    if (ctx === VIRTUAL_HTML) return null;
    return ctx.parent ?? VIRTUAL_HTML;
  }

  private previous(ctx: ElementContext): ElementContext | null {
    if (ctx === VIRTUAL_HTML || !ctx.parent) return null;
    const prev = ctx.el.previousElementSibling;
    return prev ? this.context(prev, ctx.parent) : null;
  }

  private compound(c: Compound, ctx: ElementContext): boolean {
    if (ctx === VIRTUAL_HTML) {
      return (c.tag === '' || c.tag === 'html') && c.id === null && c.classes.length === 0 &&
        c.attrs.length === 0 && c.pseudos.every((p) => p.kind === 'root');
    }
    if (c.rootAlias) {
      if (ctx.parent !== null) return false;
    } else if (c.tag && c.tag !== ctx.tagName) return false;
    const el = ctx.el;
    if (c.id !== null && el.getAttribute('id') !== c.id) return false;
    for (const cls of c.classes) if (!ctx.classes.has(cls)) return false;
    for (const a of c.attrs) if (!attributeMatches(a, el)) return false;
    for (const p of c.pseudos) if (!this.pseudo(p, ctx)) return false;
    return true;
  }

  private pseudo(p: Pseudo, ctx: ElementContext): boolean {
    switch (p.kind) {
      case 'root': return ctx.parent === null;
      case 'never': return false;
      case 'empty':
        for (const child of ctx.el.childNodes) {
          if (child.nodeType === 1) return false;
          if (child.nodeType === 3 && (child.nodeValue ?? '').length > 0) return false;
        }
        return true;
      case 'link':
        return (ctx.tagName === 'a' || ctx.tagName === 'area') && ctx.el.hasAttribute('href');
      case 'nth': {
        const pos = this.position(ctx);
        const index = p.ofType
          ? (p.fromEnd ? pos.typeCount - pos.typeIndex + 1 : pos.typeIndex)
          : (p.fromEnd ? pos.count - pos.index + 1 : pos.index);
        if (p.a === 0) return index === p.b;
        const n = (index - p.b) / p.a;
        return Number.isInteger(n) && n >= 0;
      }
      case 'only': {
        const pos = this.position(ctx);
        return p.ofType ? pos.typeCount === 1 : pos.count === 1;
      }
      case 'not':
        for (const sel of p.list) if (this.matches(sel, ctx)) return false;
        return true;
      default:
        for (const sel of p.list) if (this.matches(sel, ctx)) return true;
        return false;
    }
  }

  /** `ctx`'s position among its element siblings, numbered once per parent. */
  private position(ctx: ElementContext): Position {
    const parentEl = ctx.parent ? ctx.el.parentElement : null;
    if (!parentEl) return ONLY;
    let table = this.positions.get(parentEl);
    if (!table) {
      table = new Map();
      const typeCounts = new Map<string, number>();
      const children = parentEl.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const type = child.tagName.toLowerCase();
        const typeIndex = (typeCounts.get(type) ?? 0) + 1;
        typeCounts.set(type, typeIndex);
        table.set(child, { index: i + 1, count: children.length, typeIndex, typeCount: 0 });
      }
      for (const [child, pos] of table) pos.typeCount = typeCounts.get(child.tagName.toLowerCase())!;
      this.positions.set(parentEl, table);
    }
    return table.get(ctx.el) ?? ONLY;
  }
}

function attributeMatches(a: AttrTest, el: Element): boolean {
  const raw = el.getAttribute(a.name);
  if (raw === null) return false;
  if (a.op === '') return true;
  const v = a.ci ? raw.toLowerCase() : raw;
  const want = a.value;
  switch (a.op) {
    case '=': return v === want;
    case '~=': return want !== '' && !/\s/.test(want) && v.split(/\s+/).includes(want);
    case '|=': return v === want || v.startsWith(want + '-');
    case '^=': return want !== '' && v.startsWith(want);
    case '$=': return want !== '' && v.endsWith(want);
    default: return want !== '' && v.includes(want);
  }
}
