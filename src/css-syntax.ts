// The one CSS tokenizer, for stylesheets and `style=""`. Follows CSS Syntax 3 block
// structure (strings, escapes, comments, url(), nested brackets) so `;`/`}` end
// things only where the spec says; @-rules and nested rules are skipped whole.
// Produces strings, not tokens: comments become a space, `!important` a flag.

interface CSSDeclaration {
  /** Lower-cased property name. */
  property: string;
  /** Trimmed value, `!important` removed. Never empty. */
  value: string;
  important: boolean;
}

interface CSSStyleRule {
  /** The selector list as written, comments removed, trimmed. */
  prelude: string;
  declarations: CSSDeclaration[];
}

const TAB = 9, LF = 10, FF = 12, CR = 13, SPACE = 32;
const QUOTE = 34, APOSTROPHE = 39, OPEN_PAREN = 40, CLOSE_PAREN = 41;
const STAR = 42, HYPHEN = 45, SLASH = 47, SEMICOLON = 59;
const LESS = 60, AT = 64, OPEN_SQUARE = 91, BACKSLASH = 92;
const CLOSE_SQUARE = 93, OPEN_CURLY = 123, CLOSE_CURLY = 125;

function isWhitespace(c: number): boolean {
  return c === SPACE || c === LF || c === TAB || c === CR || c === FF;
}

/** Index just past the comment that starts at `i` (`/*`), or `end`. */
function skipComment(s: string, i: number, end: number): number {
  const close = s.indexOf('*/', i + 2);
  return close === -1 || close + 2 > end ? end : close + 2;
}

/**
 * Index just past the string that starts at `i`. An unescaped newline ends a
 * (bad) string without being consumed, as in the tokenizer.
 */
function skipString(s: string, i: number, end: number): number {
  const quote = s.charCodeAt(i);
  for (let j = i + 1; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === quote) return j + 1;
    if (c === BACKSLASH) j++;
    else if (c === LF || c === CR || c === FF) return j;
  }
  return end;
}

/**
 * At `open` (a `(`): when it opens an unquoted `url(`, that url is ONE token up to
 * the next unescaped `)`, whatever it holds (`;`, `{`). Returns the index just
 * past that `)`, or -1 for anything else (a quoted url is an ordinary function).
 */
function unquotedUrlEnd(s: string, open: number, end: number): number {
  if (!isUrlOpen(s, open)) return -1;
  let j = open + 1;
  while (j < end && isWhitespace(s.charCodeAt(j))) j++;
  const c = s.charCodeAt(j);
  if (c === QUOTE || c === APOSTROPHE) return -1;
  for (; j < end; j++) {
    const d = s.charCodeAt(j);
    if (d === CLOSE_PAREN) return j + 1;
    if (d === BACKSLASH) j++;
  }
  return end;
}

/** Does `url(` (any case) end at `i - 1` as a whole identifier? */
function isUrlOpen(s: string, i: number): boolean {
  if (i < 3) return false;
  const c0 = s.charCodeAt(i - 3) | 0x20, c1 = s.charCodeAt(i - 2) | 0x20, c2 = s.charCodeAt(i - 1) | 0x20;
  if (c0 !== 0x75 || c1 !== 0x72 || c2 !== 0x6c) return false; // u r l
  if (i === 3) return true;
  const p = s.charCodeAt(i - 4);
  // Part of a longer identifier (`my-url(`) is an ordinary function.
  return !(p === HYPHEN || p === 95 || (p >= 48 && p <= 57) || ((p | 0x20) >= 97 && (p | 0x20) <= 122) || p >= 0x80);
}

/** Set by `scan`: it stopped just past a top-level `{…}` block, which the index it returns does not tell. */
let stoppedAfterBlock = false;

/** Characters `scan` must look at; every other one is skipped by table. */
const SPECIAL = new Uint8Array(128);
for (const c of [SEMICOLON, OPEN_CURLY, CLOSE_CURLY, OPEN_PAREN, CLOSE_PAREN, OPEN_SQUARE,
  CLOSE_SQUARE, QUOTE, APOSTROPHE, SLASH, BACKSLASH]) SPECIAL[c] = 1;

/** Closers expected by the open blocks, innermost last (reused: `scan` never nests). */
const closers: number[] = [];

/**
 * Index of the next top-level `stop` (`;`, `{` or `}`) or enclosing `}`, skipping
 * strings, escapes, comments, urls and balanced brackets. `stopAfterBlock` also
 * stops just past a top-level `{…}` and sets `stoppedAfterBlock`.
 */
function scan(s: string, i: number, end: number, stop: number, stopAfterBlock: boolean): number {
  let depth = 0;
  stoppedAfterBlock = false;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c >= 128 || SPECIAL[c] === 0) { i++; continue; }
    if (depth === 0 && (c === stop || c === CLOSE_CURLY)) return i;
    switch (c) {
      case SLASH:
        if (s.charCodeAt(i + 1) === STAR) { i = skipComment(s, i, end); continue; }
        break;
      case QUOTE:
      case APOSTROPHE:
        i = skipString(s, i, end);
        continue;
      case BACKSLASH:
        i += 2;
        continue;
      case OPEN_PAREN: {
        const after = unquotedUrlEnd(s, i, end);
        if (after !== -1) { i = after; continue; }
        closers[depth++] = CLOSE_PAREN;
        break;
      }
      case OPEN_SQUARE: closers[depth++] = CLOSE_SQUARE; break;
      case OPEN_CURLY: closers[depth++] = CLOSE_CURLY; break;
      case CLOSE_PAREN:
      case CLOSE_SQUARE:
      case CLOSE_CURLY:
        // A closer that matches no open block is an ordinary token.
        if (depth > 0 && closers[depth - 1] === c) {
          depth--;
          if (stopAfterBlock && c === CLOSE_CURLY && depth === 0) {
            stoppedAfterBlock = true;
            return i + 1;
          }
        }
        break;
    }
    i++;
  }
  return end;
}

/**
 * `s[start, end)` with comments (outside strings and urls) replaced: by '' in a selector
 * (`.a` comment `.b` is `.a.b`), by ' ' in a value (`1px` comment `2px` stays two).
 */
function withoutComments(s: string, start: number, end: number, replacement: string): string {
  const text = s.slice(start, end);
  if (!text.includes('/*')) return text;
  let out = '';
  let from = start;
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === QUOTE || c === APOSTROPHE) { i = skipString(s, i, end); continue; }
    if (c === BACKSLASH) { i += 2; continue; }
    if (c === OPEN_PAREN) {
      const after = unquotedUrlEnd(s, i, end);
      if (after !== -1) { i = after; continue; }
    }
    if (c === SLASH && s.charCodeAt(i + 1) === STAR) {
      out += s.slice(from, i) + replacement;
      i = from = skipComment(s, i, end);
      continue;
    }
    i++;
  }
  return out + s.slice(from, Math.min(end, s.length));
}

const IMPORTANT = /!\s*important\s*$/i;
const PROPERTY = /^-{0,2}[a-z_\u0080-\uffff][\w\u0080-\uffff-]*$/;

/** One declaration from `s[start, end)`, or null when it is not one. */
function declaration(s: string, start: number, end: number): CSSDeclaration | null {
  const text = withoutComments(s, start, end, ' ');
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  const property = text.slice(0, colon).trim().toLowerCase();
  if (!PROPERTY.test(property)) return null;
  let value = text.slice(colon + 1).trim();
  let important = false;
  const bang = value.lastIndexOf('!');
  if (bang !== -1 && IMPORTANT.test(value.slice(bang))) {
    important = true;
    value = value.slice(0, bang).trim();
  }
  if (!value) return null;
  return { property, value, important };
}

/**
 * Index just past the @-rule that starts at `i`: after its `{…}` block, or
 * after its `;` for a statement rule. A stray `}` ends it unconsumed.
 */
function skipAtRule(s: string, i: number, end: number): number {
  const stopAt = scan(s, i, end, SEMICOLON, true);
  return stopAt < end && !stoppedAfterBlock && s.charCodeAt(stopAt) === SEMICOLON ? stopAt + 1 : stopAt;
}

/**
 * Declarations of a style attribute, or (`inBlock`) of a block up to its own `}`, into `out`;
 * returns where it stopped (`end`, or that `}`). In an attribute a stray `}` drops up to the
 * next `;`.
 */
function declarationsIn(s: string, start: number, end: number, inBlock: boolean, out: CSSDeclaration[]): number {
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CLOSE_CURLY) {
      if (inBlock) break;
      i = scan(s, i + 1, end, SEMICOLON, false);
      continue;
    }
    if (isWhitespace(c) || c === SEMICOLON) { i++; continue; }
    if (c === SLASH && s.charCodeAt(i + 1) === STAR) { i = skipComment(s, i, end); continue; }
    if (c === AT) { i = skipAtRule(s, i, end); continue; }
    // Only a custom property's value may hold `{}`; otherwise it is a nested rule, dropped.
    const custom = c === HYPHEN && s.charCodeAt(i + 1) === HYPHEN;
    const stopAt = scan(s, i, end, SEMICOLON, !custom);
    if (!stoppedAfterBlock) {
      const decl = declaration(s, i, stopAt);
      if (decl) out.push(decl);
    }
    i = stopAt;
  }
  return i;
}

/** Split at a top-level `separator`: outside parens, brackets, strings and escapes. */
export function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') i++;
    else if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === separator && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out;
}

/** A hex escape's code point as text; zero, a surrogate or past U+10FFFF is U+FFFD (CSS Syntax 3 §4.3.7). */
export function escapedCodePoint(cp: number): string {
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
}

/** Parse a `style=""` attribute (or any declaration list). */
export function parseDeclarationList(text: string): CSSDeclaration[] {
  const out: CSSDeclaration[] = [];
  declarationsIn(text, 0, text.length, false, out);
  return out;
}

/** Parse a stylesheet into its style rules; @-rules are skipped whole. */
export function parseStylesheet(css: string): CSSStyleRule[] {
  const rules: CSSStyleRule[] = [];
  const end = css.length;
  let i = 0;
  while (i < end) {
    const c = css.charCodeAt(i);
    if (isWhitespace(c)) { i++; continue; }
    if (c === SLASH && css.charCodeAt(i + 1) === STAR) { i = skipComment(css, i, end); continue; }
    // CDO/CDC (`<!--`, `-->`) are ignored at the top level of a sheet.
    if (c === LESS && css.startsWith('<!--', i)) { i += 4; continue; }
    if (c === HYPHEN && css.startsWith('-->', i)) { i += 3; continue; }
    if (c === AT) { i = skipAtRule(css, i, end); continue; }
    // A stray `}` belongs to the prelude (CSS Syntax 3), so `} .b { … }` is dropped.
    let open = scan(css, i, end, OPEN_CURLY, false);
    while (open < end && css.charCodeAt(open) === CLOSE_CURLY) open = scan(css, open + 1, end, OPEN_CURLY, false);
    if (open >= end) break; // no block: dropped
    const prelude = withoutComments(css, i, open, '').trim();
    const declarations: CSSDeclaration[] = [];
    i = declarationsIn(css, open + 1, end, true, declarations) + 1;
    if (prelude && declarations.length > 0) rules.push({ prelude, declarations });
  }
  return rules;
}
