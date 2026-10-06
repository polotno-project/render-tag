/**
 * Tier-2 geometry oracle: WHERE render-tag puts each line and word, against
 * the browser's own layout of the same fixture — not how many pixels differ.
 *
 * A pixel score says a case is 4% off; this says "line 3 baseline +0.8px" or
 * "token `world` x −2.1px". It reads the same in-page mount the wrap oracle
 * uses (`mountFixture`, the fixture CSS minus its faces, fonts registered by
 * `prepareComparisonFonts`) and the same word walk (`collectDomWords`: Range
 * rects per word, the LAST character rect for a word wrapped mid-word).
 *
 * Both sides are cut into lines by ONE rule, `groupDomLines`: the DOM's words
 * and render-tag's `LayoutText` runs (markers excluded — the DOM has no text
 * node for `::marker`) go through the same grouping, so a line difference is
 * a layout difference, not a grouping one.
 *
 * Membership here is ORDER-AWARE. Each line is compared as the logical
 * (document-order) string of its glyphs; `wrap-comparison.ts` sorts code
 * points instead, which cannot see a glyph reordered inside a line. Visual
 * order is checked separately: the paired tokens of a line sorted by x must
 * come in the same sequence on both sides (the bidi check).
 *
 * Pairing. The two sides tokenize differently — the DOM per word, render-tag
 * per run (a bidi run is ONE `LayoutText`) — so tokens are paired through a
 * character alignment (Myers diff over the whitespace-free glyph streams). A
 * DOM word and a run pair when their FIRST characters align; position is
 * compared at the start edge in the run's direction (left LTR, right RTL),
 * width only when both cover exactly the same characters.
 *
 * Baseline. The DOM exposes no baseline, and a probe inserted into the
 * fixture would add a break opportunity to the layout under test. A word's
 * Range rect is its font's CONTENT AREA, so baseline = rect.top + the engine's
 * own ascent for that computed font, measured ONCE per font OUTSIDE the
 * fixture with the zero-size inline-block probe `line-baseline-parity` uses.
 * Calibrating per engine is the point: Blink rounds the content-area ascent to
 * a whole px (`SimpleFontData`), so `rect.top + canvas fontBoundingBoxAscent`
 * would sit up to ~0.5px off the real baseline in Chrome; WebKit snaps to
 * 1/64px LayoutUnits. Each pair also records `dAscent` (canvas ascent minus
 * the calibrated DOM ascent) so that rounding stays visible rather than
 * folded into the baseline error. Assumes a word's rect uses its element's
 * PRIMARY font metrics, which holds when a fallback face paints the glyphs.
 *
 * Line `top` is the content-area top (the highest word rect), on the canvas
 * side `baseline − canvas ascent`; line-box top/height is not observable in
 * the DOM without probes (`line-box-parity` gates it on its own fixtures).
 *
 * Shadow mode: nothing here asserts. It returns numbers for a report.
 */
import { layout } from '../../src/index.ts';
import { buildCanvasFont } from '../../src/layout.ts';
import type { LayoutNode, LayoutText } from '../../src/types.ts';
import {
  canvasFixtureHtml,
  collectDomWords,
  groupDomLines,
  mountFixture,
  type LineToken,
} from './compare.ts';
import { compareLineMembership } from './wrap-comparison.ts';

interface GeoToken extends LineToken {
  /** Source order on its side. */
  index: number;
  /** Line index after `groupDomLines`. */
  line: number;
  baseline: number;
  rtl: boolean;
  /** Whitespace- and invisible-free glyphs, by code point. */
  chars: string[];
  /** Stored in visual order (an RTL bidi override): its line's order is unknown. */
  visualOrder?: boolean;
}

export interface TokenDelta {
  text: string;
  line: number;
  /** The DOM word's advance. */
  width: number;
  /** canvas − DOM at the start edge (left LTR, right RTL). */
  dx: number;
  /** canvas − DOM baseline. */
  dy: number;
  /** canvas − DOM advance; null unless both cover the same characters. */
  dw: number | null;
  /** canvas ascent − calibrated DOM ascent (the content-area rounding). */
  dAscent: number;
  sameLine: boolean;
}

export interface LineDelta {
  line: number;
  /** canvas − DOM baseline of the line's longest paired token. */
  dBaseline: number | null;
  /** canvas − DOM content-area top. */
  dTop: number;
  dLeft: number;
  dRight: number;
}

export interface Stat {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface GeometryComparison {
  domLineCount: number;
  canvasLineCount: number;
  /**
   * Order-aware line membership. Lines holding a bidi-override run compare
   * order-insensitively (their logical order is not stored); see `visualOrderLines`.
   */
  membership: boolean;
  /** Lines compared order-insensitively because of a bidi override. */
  visualOrderLines: number[];
  /** The same membership with code points sorted per line (the legacy rule). */
  sortedMembership: boolean;
  /** `compareLineMembership` over `layout().lines` — the shipped wrap gate. */
  legacyMembership: boolean;
  /** First line whose logical glyph string differs. */
  firstLineDiff: { line: number; dom: string; canvas: string } | null;
  /** Lines whose paired tokens come in a different x order. */
  visualOrderMismatches: number[];
  /** Glyphs present on one side only (ellipsis, generated content, fallback). */
  unmatchedChars: { dom: number; canvas: number };
  tokens: { dom: number; canvas: number; paired: number; offLine: number };
  dx: Stat;
  dy: Stat;
  dw: Stat;
  dAscent: Stat;
  /** Same-span pairs whose advance differs by >max(1px, 5%): fallback/shaping. */
  widthOutliers: number;
  lines: LineDelta[];
  worst: { dx: TokenDelta[]; dy: TokenDelta[]; dw: TokenDelta[] };
}

const INVISIBLE = /[\s­​]/gu;
const RTL_RE = /[֐-ࣿﭐ-﷿ﹰ-﻿]/;

function glyphs(text: string): string[] {
  return [...text.replace(INVISIBLE, '')];
}

// ─── DOM side ──────────────────────────────────────────────────────────────

const domAscents = new Map<string, number>();

/**
 * The engine's content-area ascent for a computed font: baseline (a zero-size
 * baseline-aligned inline-block's top) minus the text Range rect's top.
 */
function domAscent(style: CSSStyleDeclaration): number {
  const key = `${style.fontStyle}|${style.fontWeight}|${style.fontStretch}|${style.fontSize}|${style.fontFamily}`;
  const cached = domAscents.get(key);
  if (cached !== undefined) return cached;
  const host = document.createElement('div');
  host.style.cssText =
    'position:absolute;left:-99999px;top:0;line-height:normal;white-space:nowrap;';
  const span = document.createElement('span');
  span.style.fontStyle = style.fontStyle;
  span.style.fontWeight = style.fontWeight;
  span.style.fontStretch = style.fontStretch;
  span.style.fontSize = style.fontSize;
  span.style.fontFamily = style.fontFamily;
  const text = document.createTextNode('Hxg');
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  span.append(text, probe);
  host.appendChild(span);
  document.body.appendChild(host);
  try {
    const range = document.createRange();
    range.selectNodeContents(text);
    const ascent = probe.getBoundingClientRect().top - range.getClientRects()[0].top;
    domAscents.set(key, ascent);
    return ascent;
  } finally {
    host.remove();
  }
}

function domTokens(container: HTMLElement, content: HTMLElement): GeoToken[] {
  // render-tag's origin is the container: a first child's top margin
  // collapses through `content`, so content's own top already sits below it.
  const origin = container.getBoundingClientRect();
  const contentTop = content.getBoundingClientRect().top - origin.top;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const tokens: GeoToken[] = [];
  for (const word of collectDomWords(content)) {
    const chars = glyphs(word.text);
    if (chars.length === 0) continue;
    const parent = word.node.parentElement!;
    let style = styles.get(parent);
    if (!style) {
      style = getComputedStyle(parent);
      styles.set(parent, style);
    }
    tokens.push({
      x: word.x - origin.left,
      y: word.y + contentTop,
      width: word.width,
      height: word.height,
      text: word.text,
      index: tokens.length,
      line: -1,
      baseline: word.y + contentTop + domAscent(style),
      rtl: RTL_RE.test(word.text),
      chars,
    });
  }
  return tokens;
}

// ─── canvas side ───────────────────────────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;
const canvasMetrics = new Map<string, { ascent: number; descent: number }>();

function canvasFontMetrics(font: string): { ascent: number; descent: number } {
  const cached = canvasMetrics.get(font);
  if (cached) return cached;
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = font;
  const m = measureCtx.measureText('Hxg');
  const metrics = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
  canvasMetrics.set(font, metrics);
  return metrics;
}

function canvasTokens(root: LayoutNode): GeoToken[] {
  const tokens: GeoToken[] = [];
  const visit = (node: LayoutNode) => {
    if (node.type === 'text') {
      addRun(node);
      return;
    }
    node.children.forEach((child, i) => {
      // addListMarker unshifts the marker as the li's first child.
      const isMarker = i === 0 && node.listMarker !== undefined &&
        child.type === 'text' && child.text === node.listMarker;
      if (!isMarker) visit(child);
    });
  };
  const addRun = (run: LayoutText) => {
    const rtl = run.style.direction === 'rtl';
    const chars = glyphs(run.text);
    if (chars.length === 0) return;
    // An RTL bidi override stores its runs in VISUAL order: characters
    // reversed, run order reversed, direction reset to ltr (layout.ts
    // `overrideRtl`), so the run no longer says it was reversed. Un-reverse
    // the characters of a run that declares the override, which lets its
    // glyphs pair; its line is compared order-insensitively (`visualOrder`),
    // because run order and nested runs are not recoverable. An LTR override
    // (never reversed) is reversed here too — the corpus has none.
    const visualOrder = run.style.unicodeBidi === 'bidi-override' ||
      run.style.unicodeBidi === 'isolate-override';
    if (visualOrder) chars.reverse();
    const { ascent, descent } = canvasFontMetrics(buildCanvasFont(run.style));
    tokens.push({
      // RTL runs are anchored at their right edge (textAlign = 'right').
      x: rtl ? run.x - run.width : run.x,
      y: run.y - ascent,
      width: run.width,
      height: ascent + descent,
      text: run.text,
      index: tokens.length,
      line: -1,
      baseline: run.y,
      rtl,
      chars,
      visualOrder,
    });
  };
  visit(root);
  return tokens;
}

// ─── alignment ─────────────────────────────────────────────────────────────

/** Past this many edits the glyph streams are not the same text; give up. */
const MAX_EDITS = 1500;

/**
 * Myers diff over two glyph streams: index pairs of the characters common to
 * both, in order, or null when they differ by more than MAX_EDITS.
 */
function alignChars(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
  }
  if (found < 0) return null;
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])
      ? k + 1
      : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) pairs.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

// ─── comparison ────────────────────────────────────────────────────────────

function stat(values: number[]): Stat {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const abs = values.map(Math.abs).sort((p, q) => p - q);
  const at = (q: number) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { n: abs.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(abs[abs.length - 1]) };
}

function assignLines(tokens: GeoToken[]): GeoToken[][] {
  const lines = groupDomLines(tokens).map((line) => line.words);
  lines.forEach((words, index) => {
    for (const token of words) token.line = index;
  });
  // Logical (source) order inside each line.
  return lines.map((words) => [...words].sort((p, q) => p.index - q.index));
}

const lineString = (words: GeoToken[]) => words.map((t) => t.chars.join('')).join('');
const sortedString = (text: string) => [...text].sort().join('');

/**
 * Compare render-tag's layout of a fixture with the browser's at one width.
 * Fonts must already be registered and warmed (prepareComparisonFonts,
 * warmNativeLayout), as for every DOM oracle.
 */
export function compareGeometry(
  html: string,
  css: string,
  width: number,
  height: number,
): GeometryComparison {
  // DOM first: some font backends finalize a face on its first DOM use.
  const { container, content } = mountFixture(html, css, width);
  let dom: GeoToken[];
  let legacyDomLines: { y: number; text: string }[];
  try {
    dom = domTokens(container, content);
    legacyDomLines = groupDomLines(collectDomWords(content)).map((line) => ({
      y: Math.round(line.top),
      text: line.words.map((w) => w.text).join(' '),
    }));
  } finally {
    container.remove();
  }
  const result = layout({ html: canvasFixtureHtml(html, css), width, height });
  const canvas = canvasTokens(result.layoutRoot);

  const domLines = assignLines(dom);
  const canvasLines = assignLines(canvas);
  const lineCount = Math.max(domLines.length, canvasLines.length);
  let membership = domLines.length === canvasLines.length;
  let sortedMembership = membership;
  let firstLineDiff: GeometryComparison['firstLineDiff'] = null;
  const visualOrderLines: number[] = [];
  for (let line = 0; line < lineCount; line++) {
    const d = lineString(domLines[line] ?? []);
    const c = lineString(canvasLines[line] ?? []);
    const unordered = (canvasLines[line] ?? []).some((t) => t.visualOrder);
    if (unordered) visualOrderLines.push(line);
    if (unordered ? sortedString(d) !== sortedString(c) : d !== c) {
      membership = false;
      firstLineDiff ??= { line, dom: d, canvas: c };
    }
    if (sortedString(d) !== sortedString(c)) sortedMembership = false;
  }

  // Character streams in source order, each glyph pointing at its token.
  const stream = (tokens: GeoToken[]) => {
    const chars: string[] = [];
    const owner: number[] = [];
    const first: boolean[] = [];
    tokens.forEach((token, t) => token.chars.forEach((char, i) => {
      chars.push(char);
      owner.push(t);
      first.push(i === 0);
    }));
    return { chars, owner, first };
  };
  const ds = stream(dom);
  const cs = stream(canvas);
  // No alignment (streams too different) pairs nothing; `unmatchedChars` then
  // equals both stream lengths, which is how a report reader sees it.
  const aligned = alignChars(ds.chars, cs.chars) ?? [];

  // Token pairs: a DOM word and a canvas run whose first glyphs align. A pair
  // spans the same characters when every glyph of both maps onto the other.
  const matchedTo = new Map<number, number>();
  for (const [d, c] of aligned) matchedTo.set(d, c);
  const deltas: TokenDelta[] = [];
  const pairsByLine = new Map<number, Array<{ dom: GeoToken; canvas: GeoToken }>>();
  for (const [d, c] of aligned) {
    if (!ds.first[d] || !cs.first[c]) continue;
    const dt = dom[ds.owner[d]];
    const ct = canvas[cs.owner[c]];
    let sameSpan = dt.chars.length === ct.chars.length;
    for (let i = 0; sameSpan && i < dt.chars.length; i++) {
      if (matchedTo.get(d + i) !== c + i) sameSpan = false;
    }
    const domStart = ct.rtl ? dt.x + dt.width : dt.x;
    const canvasStart = ct.rtl ? ct.x + ct.width : ct.x;
    const domAscentPx = dt.baseline - dt.y;
    const canvasAscentPx = ct.baseline - ct.y;
    deltas.push({
      text: dt.text,
      line: dt.line,
      width: dt.width,
      dx: canvasStart - domStart,
      dy: ct.baseline - dt.baseline,
      dw: sameSpan ? ct.width - dt.width : null,
      dAscent: canvasAscentPx - domAscentPx,
      sameLine: dt.line === ct.line,
    });
    if (dt.line === ct.line) {
      const list = pairsByLine.get(dt.line) ?? [];
      list.push({ dom: dt, canvas: ct });
      pairsByLine.set(dt.line, list);
    }
  }

  const visualOrderMismatches: number[] = [];
  const lines: LineDelta[] = [];
  for (let line = 0; line < Math.min(domLines.length, canvasLines.length); line++) {
    const pairs = pairsByLine.get(line) ?? [];
    const byDom = [...pairs].sort((p, q) => p.dom.x - q.dom.x);
    const byCanvas = [...pairs].sort((p, q) => p.canvas.x - q.canvas.x);
    if (byDom.some((pair, i) => pair !== byCanvas[i])) visualOrderMismatches.push(line);

    const longest = pairs.reduce<(typeof pairs)[number] | null>(
      (best, pair) => (!best || pair.dom.chars.length > best.dom.chars.length ? pair : best),
      null,
    );
    const extent = (words: GeoToken[]) => ({
      top: Math.min(...words.map((t) => t.y)),
      left: Math.min(...words.map((t) => t.x)),
      right: Math.max(...words.map((t) => t.x + t.width)),
    });
    const d = extent(domLines[line]);
    const c = extent(canvasLines[line]);
    lines.push({
      line,
      dBaseline: longest ? longest.canvas.baseline - longest.dom.baseline : null,
      dTop: c.top - d.top,
      dLeft: c.left - d.left,
      dRight: c.right - d.right,
    });
  }

  const widths = deltas.filter((t) => t.dw !== null);
  const worst = (key: 'dx' | 'dy' | 'dw', from: TokenDelta[]) =>
    [...from].sort((p, q) => Math.abs(q[key] ?? 0) - Math.abs(p[key] ?? 0)).slice(0, 3);
  const onLine = deltas.filter((t) => t.sameLine);
  return {
    domLineCount: domLines.length,
    canvasLineCount: canvasLines.length,
    membership,
    visualOrderLines,
    sortedMembership,
    legacyMembership: compareLineMembership(result.lines, legacyDomLines).wrappingMatch,
    firstLineDiff,
    visualOrderMismatches,
    unmatchedChars: {
      dom: ds.chars.length - aligned.length,
      canvas: cs.chars.length - aligned.length,
    },
    tokens: {
      dom: dom.length,
      canvas: canvas.length,
      paired: deltas.length,
      offLine: deltas.length - onLine.length,
    },
    dx: stat(onLine.map((t) => t.dx)),
    dy: stat(onLine.map((t) => t.dy)),
    dw: stat(widths.map((t) => t.dw!)),
    dAscent: stat(deltas.map((t) => t.dAscent)),
    widthOutliers: widths.filter((t) => Math.abs(t.dw!) > Math.max(1, 0.05 * t.width)).length,
    lines,
    worst: { dx: worst('dx', onLine), dy: worst('dy', onLine), dw: worst('dw', widths) },
  };
}
