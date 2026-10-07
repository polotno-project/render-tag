/**
 * The one CSS tokenizer render-tag has, for stylesheets AND `style=""`
 * attributes. It follows the block structure of CSS Syntax 3 — strings,
 * escapes, comments, `url()` and nested `()`/`[]`/`{}` — so a `;` or `}` is a
 * terminator only where the spec says it is:
 *
 * - `url("data:…;base64,…")`, `"a;b"` and `a\;b` stay one value;
 * - a `}` inside a string does not end a rule;
 * - block @-rules (`@font-face`, `@media`, `@supports`, `@keyframes`, …) are
 *   skipped by block depth in one linear pass, statement @-rules
 *   (`@import …;`) at their `;`;
 * - a nested style rule inside a block is dropped without eating the
 *   declarations after it.
 *
 * It produces strings, not tokens: the resolver's value parsers take text.
 * Values keep their original spelling (minus comments, which become a space,
 * and minus `!important`, which becomes a flag).
 */

export interface CSSDeclaration {
  /** Lower-cased property name. */
  property: string;
  /** Trimmed value, `!important` removed. Never empty. */
  value: string;
  important: boolean;
}

export interface CSSStyleRule {
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
 * At `i` (just past `url(`): when the url is unquoted it is ONE token up to
 * the next unescaped `)`, whatever it holds (`;`, `{`). Returns the index just
 * past that `)`, or -1 for a quoted url (an ordinary function).
 */
function skipUnquotedUrl(s: string, i: number, end: number): number {
  let j = i;
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

/** Set by `scan`: it stopped just past a top-level `{…}` block. */
let stoppedAfterBlock = false;
/** Set by `scan`: it skipped a comment (so the text needs `withoutComments`). */
let sawComment = false;

/** Characters `scan` must look at; every other one is skipped by table. */
const SPECIAL = new Uint8Array(128);
for (const c of [SEMICOLON, OPEN_CURLY, CLOSE_CURLY, OPEN_PAREN, CLOSE_PAREN, OPEN_SQUARE,
  CLOSE_SQUARE, QUOTE, APOSTROPHE, SLASH, BACKSLASH]) SPECIAL[c] = 1;

/** Closers expected by the open blocks, innermost last (reused: `scan` never nests). */
const closers: number[] = [];

/**
 * Scan component values from `i` until a top-level `stop` character (or a
 * top-level `}` that would close the enclosing block, or `end`). Strings,
 * escapes, comments, unquoted urls and balanced `()`/`[]`/`{}` are skipped
 * over, so their contents never stop the scan. Returns the stop index.
 * `stop` must be `;`, `{` or `}`.
 *
 * `stopAfterBlock`: also stop right after a top-level `{…}` block closes —
 * the end of a nested rule or of a block @-rule — and say so in
 * `stoppedAfterBlock`.
 */
function scan(s: string, i: number, end: number, stop: number, stopAfterBlock: boolean): number {
  let depth = 0;
  stoppedAfterBlock = false;
  sawComment = false;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c >= 128 || SPECIAL[c] === 0) { i++; continue; }
    if (depth === 0 && (c === stop || c === CLOSE_CURLY)) return i;
    switch (c) {
      case SLASH:
        if (s.charCodeAt(i + 1) === STAR) { i = skipComment(s, i, end); sawComment = true; continue; }
        break;
      case QUOTE:
      case APOSTROPHE:
        i = skipString(s, i, end);
        continue;
      case BACKSLASH:
        i += 2;
        continue;
      case OPEN_PAREN: {
        if (isUrlOpen(s, i)) {
          const after = skipUnquotedUrl(s, i + 1, end);
          if (after !== -1) { i = after; continue; }
        }
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
 * `s[start, end)` with every comment (outside strings) replaced by
 * `replacement`. A comment is no token at all, so in a selector it must
 * vanish (`.a` comment `.b` is the compound `.a.b`); in a value the resolver's
 * text parsers need the space to keep `1px` comment `2px` two components.
 */
function withoutComments(s: string, start: number, end: number, replacement: string): string {
  let out = '';
  let from = start;
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === QUOTE || c === APOSTROPHE) { i = skipString(s, i, end); continue; }
    if (c === BACKSLASH) { i += 2; continue; }
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

/**
 * One declaration from `s[start, end)`, or null when it is not one.
 * `comments`: the range holds a comment (as `scan` reported).
 */
function declaration(s: string, start: number, end: number, comments: boolean): CSSDeclaration | null {
  const text = comments ? withoutComments(s, start, end, ' ') : s.slice(start, end);
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
  // A `!` left in the value (`red !important !important`, the `!ie` hack) is
  // a delim no standard property accepts: the declaration is invalid. Inside
  // a string or url() it is text; a custom property may hold one.
  if (value.includes('!') && !property.startsWith('--') && hasTopLevelBang(value)) return null;
  return { property, value, important };
}

/** Does `value` hold a `!` outside strings and escapes? (Unquoted url() never reaches here with one.) */
function hasTopLevelBang(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === QUOTE || c === APOSTROPHE) { i = skipString(value, i, value.length) - 1; continue; }
    if (c === BACKSLASH) { i++; continue; }
    if (c === OPEN_PAREN && isUrlOpen(value, i)) {
      const after = skipUnquotedUrl(value, i + 1, value.length);
      if (after !== -1) { i = after - 1; continue; }
    }
    if (c === 33) return true;
  }
  return false;
}

/**
 * Index just past the @-rule that starts at `i`: after its `{…}` block, or
 * after its `;` for a statement rule. A stray `}` ends it unconsumed.
 */
function skipAtRule(s: string, i: number, end: number): number {
  const stopAt = scan(s, i, end, SEMICOLON, true);
  return stopAt < end && !stoppedAfterBlock && s.charCodeAt(stopAt) === SEMICOLON ? stopAt + 1 : stopAt;
}

/** Set by `declarationsIn`: where it stopped (`end`, or a block's `}`). */
let declarationsEnd = 0;

/**
 * The declarations of `s[start, end)`: a style attribute, or (`inBlock`) a
 * block's contents, which end at the block's own top-level `}` — the index
 * left in `declarationsEnd`. In a style attribute a stray `}` starts a bad
 * item, which is dropped up to the next top-level `;` (CSS Syntax 3).
 */
function declarationsIn(s: string, start: number, end: number, inBlock: boolean): CSSDeclaration[] {
  const out: CSSDeclaration[] = [];
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CLOSE_CURLY) {
      if (inBlock) break;
      // `color:red; } font-size:20px; margin:0` drops `} font-size:20px`.
      i = scan(s, i + 1, end, SEMICOLON, false);
      continue;
    }
    if (isWhitespace(c) || c === SEMICOLON) { i++; continue; }
    if (c === SLASH && s.charCodeAt(i + 1) === STAR) { i = skipComment(s, i, end); continue; }
    if (c === AT) { i = skipAtRule(s, i, end); continue; }
    // A custom property's value may hold a `{}` block; anything else that
    // reaches one is a nested rule, which ends with its block and is dropped.
    const custom = c === HYPHEN && s.charCodeAt(i + 1) === HYPHEN;
    const stopAt = scan(s, i, end, SEMICOLON, !custom);
    if (!stoppedAfterBlock) {
      const decl = declaration(s, i, stopAt, sawComment);
      if (decl) out.push(decl);
    }
    i = stopAt;
  }
  declarationsEnd = i;
  return out;
}

/** Parse a `style=""` attribute (or any declaration list). */
export function parseDeclarationList(text: string): CSSDeclaration[] {
  return declarationsIn(text, 0, text.length, false);
}

/**
 * Parse a stylesheet into its style rules. @-rules are skipped whole; their
 * contents never reach the cascade.
 */
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
    // A qualified rule: its prelude runs to the top-level `{`. A stray `}` on
    // the way is part of the prelude (CSS Syntax 3), which no selector
    // accepts: `} .b { … }` is dropped, as browsers drop it.
    let open = scan(css, i, end, OPEN_CURLY, false);
    let comments = sawComment;
    while (open < end && css.charCodeAt(open) === CLOSE_CURLY) {
      open = scan(css, open + 1, end, OPEN_CURLY, false);
      comments ||= sawComment;
    }
    if (open >= end) break; // no block: dropped
    const prelude = (comments ? withoutComments(css, i, open, '') : css.slice(i, open)).trim();
    const declarations = declarationsIn(css, open + 1, end, true);
    if (prelude && declarations.length > 0) rules.push({ prelude, declarations });
    i = declarationsEnd + 1;
  }
  return rules;
}
