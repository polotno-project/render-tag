// CSS value parsers: lengths (absolute, font-relative, viewport units), calc/min/max/clamp,
// font-size keywords and weights. NaN means unparseable and the declaration is ignored.
// Unsupported: var/attr/env, other math functions, container units, lh/rlh/ic/cap, rch/rex.
import type { ResolvedStyle } from './types.js';

/** The layout viewport, for vw/vh/vmin/vmax. */
export interface Viewport {
  width: number;
  height: number;
}

/** Font-relative units measured from a real font: the advance of `0` and the x-height. */
export interface FontUnits {
  ch: number;
  ex: number;
}

/** What one declaration's relative lengths resolve against. */
export interface LengthBasis {
  em: number;
  rem: number; // root element's font-size
  percent: number; // px of 100%; NaN where a percentage is not allowed
  viewport: Viewport | null; // null (text on a path): viewport units are invalid
  fontStyle: ResolvedStyle | null; // the font `em`, `ch` and `ex` refer to
  measure: ((style: ResolvedStyle) => FontUnits) | undefined; // undefined: ch/ex = 0.5em (CSS Values 4)
}

/** A typed numeric value: a length (in px, percentages already resolved) or a plain number. */
interface Typed {
  value: number;
  number: boolean;
}

const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

/** px for `n` of `unit` (lower-cased), or NaN for an unknown unit. */
function unitToPx(n: number, unit: string, b: LengthBasis): number {
  switch (unit) {
    case 'px': return n;
    case 'em': return n * b.em;
    case 'rem': return n * b.rem;
    case '%': return (n / 100) * b.percent;
    case 'pt': return (n * 4) / 3;
    case 'pc': return n * 16;
    case 'in': return n * 96;
    case 'cm': return (n * 96) / 2.54;
    case 'mm': return (n * 96) / 25.4;
    case 'q': return (n * 96) / 101.6;
    case 'ch': return n * (b.measure && b.fontStyle ? b.measure(b.fontStyle).ch : b.em / 2);
    case 'ex': return n * (b.measure && b.fontStyle ? b.measure(b.fontStyle).ex : b.em / 2);
  }
  const vp = b.viewport;
  // The small/large/dynamic variants equal the plain unit: a canvas has no
  // collapsing browser chrome. vi/vb are vw/vh in horizontal writing.
  const m = /^[sld]?v(w|h|i|b|min|max)$/.exec(unit);
  if (!m || !vp) return NaN;
  switch (m[1]) {
    case 'w': case 'i': return (n * vp.width) / 100;
    case 'h': case 'b': return (n * vp.height) / 100;
    case 'min': return (n * Math.min(vp.width, vp.height)) / 100;
    default: return (n * Math.max(vp.width, vp.height)) / 100;
  }
}

/** A number, length or percentage token, or null. */
function dimension(text: string, b: LengthBasis): Typed | null {
  const m = DIMENSION.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!m[2]) return { value: n, number: true };
  const px = unitToPx(n, m[2].toLowerCase(), b);
  return Number.isFinite(px) ? { value: px, number: false } : null;
}

// ─── Math functions ─────────────────────────────────────────────────

/** Recursive-descent evaluator over one math function's text. */
class MathParser {
  i = 0;
  constructor(readonly s: string, readonly b: LengthBasis) {}

  private ws(): boolean {
    const start = this.i;
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
    return this.i > start;
  }

  /** `fn(` already consumed: its comma-separated sums up to `)`. */
  args(): Typed[] | null {
    const out: Typed[] = [];
    for (;;) {
      const v = this.sum();
      if (!v) return null;
      out.push(v);
      this.ws();
      const c = this.s[this.i++];
      if (c === ')') return out;
      if (c !== ',') return null;
    }
  }

  sum(): Typed | null {
    let left = this.product();
    while (left) {
      const before = this.i;
      const spaced = this.ws();
      const op = this.s[this.i];
      // `+`/`-` must have whitespace on both sides (`1px -2px` is two values).
      if ((op !== '+' && op !== '-') || !spaced) { this.i = before; break; }
      this.i++;
      if (!this.ws()) return null;
      const right = this.product();
      if (!right || right.number !== left.number) return null;
      left = { value: op === '+' ? left.value + right.value : left.value - right.value, number: left.number };
    }
    return left;
  }

  private product(): Typed | null {
    let left = this.term();
    while (left) {
      const before = this.i;
      this.ws();
      const op = this.s[this.i];
      if (op !== '*' && op !== '/') { this.i = before; break; }
      this.i++;
      const right = this.term();
      if (!right) return null;
      if (op === '*') {
        if (!left.number && !right.number) return null;
        left = { value: left.value * right.value, number: left.number && right.number };
      } else {
        if (!right.number || right.value === 0) return null;
        left = { value: left.value / right.value, number: left.number };
      }
    }
    return left;
  }

  private term(): Typed | null {
    this.ws();
    const s = this.s;
    if (s[this.i] === '(') {
      this.i++;
      const v = this.sum();
      this.ws();
      return v && s[this.i++] === ')' ? v : null;
    }
    const fn = /^([a-z-]+)\(/i.exec(s.slice(this.i));
    if (fn) {
      this.i += fn[0].length;
      return this.call(fn[1].toLowerCase());
    }
    const tok = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*/i.exec(s.slice(this.i));
    if (!tok) return null;
    this.i += tok[0].length;
    return dimension(tok[0], this.b);
  }

  /** A math function whose `name(` was consumed. */
  call(name: string): Typed | null {
    const args = this.args();
    if (!args) return null;
    const kind = args[0].number;
    if (args.some((a) => a.number !== kind)) return null;
    const values = args.map((a) => a.value);
    switch (name) {
      case 'calc': return args.length === 1 ? args[0] : null;
      case 'min': return { value: Math.min(...values), number: kind };
      case 'max': return { value: Math.max(...values), number: kind };
      case 'clamp':
        return args.length === 3
          ? { value: Math.max(values[0], Math.min(values[1], values[2])), number: kind }
          : null;
      default: return null;
    }
  }
}

/** A number or length (percentages resolved), possibly a math function; null when invalid. */
export function resolveNumberOrLength(value: string, b: LengthBasis): Typed | null {
  const v = value.trim();
  const plain = dimension(v, b);
  if (plain) return plain;
  const fn = /^(calc|min|max|clamp)\(/i.exec(v);
  if (!fn) return null;
  const p = new MathParser(v, b);
  p.i = fn[0].length;
  const result = p.call(fn[1].toLowerCase());
  return result && p.i === v.length && Number.isFinite(result.value) ? result : null;
}

/**
 * A `<length-percentage>` in px, or NaN when `value` is not one. A unitless
 * number is not a length (standards mode), except a literal 0.
 */
export function resolveLength(value: string, b: LengthBasis): number {
  const t = resolveNumberOrLength(value, b);
  if (!t) return NaN;
  return !t.number || t.value === 0 ? t.value : NaN;
}

/**
 * The absolute-size keywords at a 16px `medium`, as Blink and WebKit size
 * them (their table, not the CSS ratio: `small` is 13px, not 14.2). Gecko's
 * table has the same values at 16px (unverified here).
 */
export const FONT_SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

/** HTML's legacy `<font size>` 1-7 → its absolute-size keyword's px. */
export const LEGACY_FONT_SIZES = [10, 13, 16, 18, 24, 32, 48];

/** `larger`/`smaller` step, as Blink and WebKit apply it (and CSS Fonts suggests). */
const FONT_SIZE_STEP = 1.2;

/**
 * A `font-size` in px. Relative values (em, %, ch, ex, larger, smaller) are
 * relative to the PARENT's font, which `b` describes. NaN when invalid.
 */
export function resolveFontSize(value: string, parentSize: number, b: LengthBasis): number {
  const v = value.trim().toLowerCase();
  const keyword = FONT_SIZE_KEYWORDS[v];
  if (keyword !== undefined) return keyword;
  if (v === 'larger') return parentSize * FONT_SIZE_STEP;
  if (v === 'smaller') return parentSize / FONT_SIZE_STEP;
  const px = resolveLength(v, b);
  return px >= 0 ? px : NaN;
}

/**
 * A `font-weight` as a number. `bolder`/`lighter` step from the parent's
 * weight by the CSS Fonts 4 table. NaN when invalid.
 */
export function resolveFontWeight(value: string, parentWeight: number): number {
  const v = value.trim().toLowerCase();
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  if (v === 'bolder') return parentWeight < 350 ? 400 : parentWeight < 550 ? 700 : Math.max(900, parentWeight);
  if (v === 'lighter') return parentWeight < 100 ? parentWeight : parentWeight < 550 ? 100 : parentWeight < 750 ? 400 : 700;
  if (!/^[+]?(?:\d+\.?\d*|\.\d+)$/.test(v)) return NaN;
  const n = parseFloat(v);
  return n >= 1 && n <= 1000 ? n : NaN;
}
