// Text units: the laid-out text cut into lines, words or graphemes in reading order, for
// `drawLayout`'s `paintTextUnit`. Built once per call after layout, from the runs as they
// paint: a cut is measured in the run's own state, so a piece lands where the run's own
// fillText puts those glyphs. Each run gets its pieces (`RUN_PIECES`); paint draws them.
import type {
  LayoutBox, LayoutLineBox, LayoutText, TextUnit, TextUnitLevel,
} from '../types.js';
import { levelRuns, visualOrder } from '../bidi.js';
import {
  CLAMP_ELLIPSIS, INLINE_BLOCK, LINE_BASELINE, LINE_BOX, LIST_MARKER, RUN_LEVELS, RUN_PIECES, SPACE_WRAP,
  type LayoutSession, type PrivateLineBox, type PrivateText,
} from './session.js';
import {
  breakFlags, graphemes, needsSegmenter, SEG_CJK, SEG_CLOSING_PUNCT, SEG_OPENING_PUNCT, segmenter, shapesAsRun,
  textFlags,
} from './segment.js';
import { textEdges, withDirection } from './util.js';

/** The part of one run one unit paints. */
export interface UnitPiece {
  unit: TextUnit;
  /** The run as paint draws this piece: the run itself, or a copy cut to the piece. */
  readonly run: LayoutText;
  /** The piece's slice of its line, left to right: its decoration bands are clipped to it. */
  left: number;
  right: number;
  /** White space only: it carries the unit's slice and paints no glyph. */
  readonly space: boolean;
}

export type UnitRun = LayoutText & { [RUN_PIECES]?: UnitPiece[] };

/** Never a unit: it paints with a unit beside it. JavaScript's white space, what `trim()`
 * strips: no-break spaces included (an editor's empty paragraph is `&nbsp;`). */
const WHITE_SPACE = /\s/;
/** An inline-block in a stream's text: a unit of its own. */
const TOKEN = '\uFFFC';
/** Keeps the words on either side of a wrap at white space apart. */
const SEPARATOR = '\n';

interface LineInfo {
  box: PrivateLineBox;
  direction: 'ltr' | 'rtl';
}

/** One item of the reading-order stream. */
type Entry =
  | { type: 'text'; run: PrivateText; line: number }
  | { type: 'marker'; run: PrivateText; line: number }
  | { type: 'atomic'; box: LayoutBox; runs: PrivateText[]; line: number }
  | { type: 'break' };

/** A unit's claim on entry `entry`: `[start, end)` of a text run; a marker or atomic whole. */
interface Claim { entry: number; start: number; end: number; space: boolean }

interface Draft { unit: TextUnit; claims: Claim[] }

/**
 * Cut `root`'s text into units of `level`, in reading order, and give each run its pieces.
 * Measures with the call's measurer, so a unit's geometry is the layout's own.
 */
export function buildTextUnits(session: LayoutSession, root: LayoutBox, level: TextUnitLevel): TextUnit[] {
  const { entries, lines } = collectEntries(root);
  const drafts = level === 'line' ? lineDrafts(entries, lines) : textDrafts(entries, lines, level);
  placePieces(session, entries, lines, drafts, level === 'line');
  return drafts.map((draft, index) => {
    draft.unit.index = index;
    return draft.unit;
  });
}

// ── The reading-order stream ──

/** A box emitted beside its line's runs: an inline background or an inline-block's shell. */
function isInlineBox(box: LayoutBox): boolean {
  const display = box.style.display;
  return box.children.length === 0 && (display === 'inline' || display === 'inline-block');
}

/** Every run in reading order (each block's lines in turn), with its line. */
function collectEntries(root: LayoutBox): { entries: Entry[]; lines: LineInfo[] } {
  const entries: Entry[] = [];
  const lines: LineInfo[] = [];
  const lineIds = new Map<LayoutLineBox, number>();
  // A marker waits for its item's first line.
  let pendingMarkers: Extract<Entry, { type: 'marker' }>[] = [];

  const lineOf = (box: LayoutLineBox, direction: 'ltr' | 'rtl'): number => {
    let id = lineIds.get(box);
    if (id === undefined) {
      id = lines.length;
      lineIds.set(box, id);
      lines.push({ box, direction });
      for (const marker of pendingMarkers) marker.line = id;
      pendingMarkers = [];
    }
    return id;
  };
  const separate = () => {
    if (entries.length && entries[entries.length - 1].type !== 'break') entries.push({ type: 'break' });
  };

  const walk = (box: LayoutBox) => {
    const direction = box.style.direction === 'rtl' ? 'rtl' : 'ltr';
    let ownMarker: Extract<Entry, { type: 'marker' }> | undefined;
    let atomic: Extract<Entry, { type: 'atomic' }> | undefined;

    for (const child of box.children) {
      if (child.type === 'box') {
        if (isInlineBox(child)) continue;
        separate();
        atomic = undefined;
        walk(child);
        separate();
        continue;
      }
      const run = child as PrivateText;
      if (run[LIST_MARKER] !== undefined) {
        const marker = { type: 'marker' as const, run, line: -1 };
        entries.push(marker);
        pendingMarkers.push(marker);
        ownMarker = marker;
        continue;
      }
      const owner = run[INLINE_BLOCK];
      if (!owner) {
        atomic = undefined;
        entries.push({ type: 'text', run, line: lineOf(run[LINE_BOX]!, direction) });
      } else if (atomic?.box === owner.box) {
        atomic.runs.push(run);
      } else {
        entries.push(atomic = { type: 'atomic', box: owner.box, runs: [run], line: lineOf(owner.line, direction) });
      }
    }
    // An item with nothing in flow keeps its marker on the marker's own line.
    if (ownMarker?.line === -1) lineOf(ownMarker.run[LIST_MARKER]!, direction);
  };
  walk(root);
  return { entries, lines };
}

/** A wrap at white space or a forced break parts the words on either side of it. */
function partsWords(box: PrivateLineBox): boolean {
  return box.endedByHardBreak || box[SPACE_WRAP] === true;
}

/** An inline-block's text: a space where its own wraps part words. */
function atomicText(runs: PrivateText[]): string {
  return runs.map((run, i) => {
    const before = runs[i - 1]?.[LINE_BOX];
    return before && before !== run[LINE_BOX] && partsWords(before) ? ' ' + run.text : run.text;
  }).join('');
}

// ── Units ──

function newUnit(word: number | null, kind: TextUnit['kind'], text: string, grouped = false): TextUnit {
  return { index: 0, word, text, kind, grouped, x: 0, y: 0, width: 0, height: 0, fragments: [] };
}

const WHOLE = Infinity;

/** One unit per line with text, everything on it whole; a blank line is white space. */
function lineDrafts(entries: Entry[], lines: LineInfo[]): Draft[] {
  const drafts: Draft[] = lines.map(() => ({ unit: newUnit(null, 'text', ''), claims: [] }));
  const markers: string[][] = lines.map(() => []);
  entries.forEach((entry, i) => {
    if (entry.type === 'break') return;
    const { unit, claims } = drafts[entry.line];
    claims.push({ entry: i, start: 0, end: WHOLE, space: false });
    if (entry.type === 'marker') markers[entry.line].push(entry.run.text);
    else unit.text += entry.type === 'text' ? entry.run.text : atomicText(entry.runs);
  });
  drafts.forEach(({ unit }, line) => {
    unit.text = [...markers[line], unit.text.trim()].filter(Boolean).join(' ');
  });
  return drafts.filter(draft => draft.unit.text);
}

/** Word or grapheme units, stream by stream (a block's inline content is one stream). */
function textDrafts(entries: Entry[], lines: LineInfo[], level: 'word' | 'grapheme'): Draft[] {
  const drafts: Draft[] = [];
  let word = 0;
  for (let start = 0; start < entries.length;) {
    let end = start;
    while (end < entries.length && entries[end].type !== 'break') end++;
    word = streamDrafts(entries, lines, start, end, level, word, drafts);
    start = end + 1;
  }
  return drafts;
}

/** Appends the units of `entries[from, to)` to `drafts`; returns the next word id. */
function streamDrafts(
  entries: Entry[], lines: LineInfo[], from: number, to: number,
  level: 'word' | 'grapheme', firstWord: number, drafts: Draft[],
): number {
  // The stream's text; for each code unit, the entry and offset it came from (-1: separator).
  let text = '';
  const owner: number[] = [];
  const offset: number[] = [];
  const push = (chars: string, entry: number) => {
    text += chars;
    for (let k = 0; k < chars.length; k++) { owner.push(entry); offset.push(k); }
  };
  let previousLine = -1;
  for (let i = from; i < to; i++) {
    const entry = entries[i];
    if (entry.type === 'break') continue;
    if (entry.type === 'marker') {
      drafts.push({ unit: newUnit(null, 'marker', entry.run.text), claims: [{ entry: i, start: 0, end: WHOLE, space: false }] });
      continue;
    }
    // A blank inline-block is white space: painted in place, never a unit.
    if (entry.type === 'atomic' && !atomicText(entry.runs).trim()) continue;
    if (previousLine >= 0 && entry.line !== previousLine && partsWords(lines[previousLine].box)) push(SEPARATOR, -1);
    previousLine = entry.line;
    push(entry.type === 'atomic' ? TOKEN : entry.run.text, i);
  }

  /** Claim `[a, b)` of the stream for `draft`, entry by entry. */
  const claim = (draft: Draft, a: number, b: number, space: boolean) => {
    for (let k = a; k < b;) {
      if (owner[k] < 0) { k++; continue; }
      let end = k;
      while (end < b && owner[end] === owner[k]) end++;
      draft.claims.push({ entry: owner[k], start: offset[k], end: offset[end - 1] + 1, space });
      k = end;
    }
  };

  const spans = wordSpans(text);
  let word = firstWord;
  spans.forEach(([a, b], s) => {
    const first = drafts.length;
    const entry = entries[owner[a]];
    if (entry.type === 'atomic') {
      drafts.push({
        unit: newUnit(word, 'atomic', atomicText(entry.runs).trim()),
        claims: [{ entry: owner[a], start: 0, end: WHOLE, space: false }],
      });
    } else {
      const cuts: [number, number, boolean][] = level === 'word' ? [[a, b, false]] : graphemeSpans(text, owner, a, b);
      for (const [ca, cb, grouped] of cuts) {
        const run = (entries[owner[cb - 1]] as { run: PrivateText }).run;
        const ellipsis = level === 'grapheme' && run[CLAMP_ELLIPSIS] === true && offset[cb - 1] === run.text.length - 1;
        const draft: Draft = { unit: newUnit(word, ellipsis ? 'ellipsis' : 'text', text.slice(ca, cb), grouped), claims: [] };
        claim(draft, ca, cb, false);
        drafts.push(draft);
      }
    }
    // White space after a word is its last unit's; before the stream's first word, its first's.
    if (s === 0) claim(drafts[first], 0, a, true);
    claim(drafts[drafts.length - 1], b, s + 1 < spans.length ? spans[s + 1][0] : text.length, true);
    word++;
  });
  return word;
}

/**
 * Word spans `[start, end)` of `text`: runs between white space, an inline-block alone,
 * and in scripts written without spaces the segmenter's words, their punctuation glued as
 * the line breaker glues it: an opener to the word after, a closer to the word before.
 */
function wordSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const words = segmenter('word');
  for (let i = 0; i < text.length;) {
    if (WHITE_SPACE.test(text[i])) { i++; continue; }
    if (text[i] === TOKEN) { spans.push([i, i + 1]); i++; continue; }
    const start = i;
    while (i < text.length && !WHITE_SPACE.test(text[i]) && text[i] !== TOKEN) i++;
    const run = text.slice(start, i);
    // CJK, Thai, Khmer, Lao and Myanmar set no spaces between words.
    if (!words || !(needsSegmenter(run) || (breakFlags(run) & SEG_CJK))) { spans.push([start, i]); continue; }
    let joinNext = false;
    for (const s of words.segment(run)) {
      const from = start + s.index;
      const flags = s.isWordLike ? 0 : textFlags(s.segment);
      if (joinNext || ((flags & SEG_CLOSING_PUNCT) && s.index > 0)) spans[spans.length - 1][1] = from + s.segment.length;
      else spans.push([from, from + s.segment.length]);
      joinNext = (flags & SEG_OPENING_PUNCT) !== 0;
    }
  }
  return spans;
}

/**
 * The grapheme units of word span `[a, b)`: one per grapheme, across style runs, except that
 * graphemes of a script fillText must shape whole stay one shaped run (`shapesAsRun`), within
 * one run.
 */
function graphemeSpans(text: string, owner: number[], a: number, b: number): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  let at = a;
  let group = -1;
  for (const g of graphemes(text.slice(a, b))) {
    const shaped = shapesAsRun(g);
    if (shaped && group >= 0 && owner[at] === owner[out[group][0]]) {
      out[group][1] = at + g.length;
      out[group][2] = true;
    } else {
      out.push([at, at + g.length, false]);
      group = shaped ? out.length - 1 : -1;
    }
    at += g.length;
  }
  return out;
}

// ── Pieces and geometry ──

/** A unit's visible extent on one line. */
interface Extent { unit: TextUnit; line: number; left: number; right: number; rtl: boolean }

function placePieces(
  session: LayoutSession, entries: Entry[], lines: LineInfo[], drafts: Draft[], byLine: boolean,
): void {
  const byEntry: { unit: TextUnit; claim: Claim }[][] = [];
  for (const { unit, claims } of drafts) for (const claim of claims) (byEntry[claim.entry] ??= []).push({ unit, claim });
  const extents: Extent[] = [];
  const onLine: UnitPiece[][] = lines.map(() => []);
  const add = (run: UnitRun, piece: UnitPiece, line: number, extent = !piece.space) => {
    (run[RUN_PIECES] ??= []).push(piece);
    onLine[line].push(piece);
    if (extent) extents.push({ unit: piece.unit, line, left: piece.left, right: piece.right, rtl: piece.run.style.direction === 'rtl' });
  };
  // In stream order, so each run's pieces are in reading order. A break is never claimed.
  byEntry.forEach((list, i) => {
    const entry = entries[i] as Exclude<Entry, { type: 'break' }>;
    if (entry.type === 'atomic') {
      // One unit claims an inline-block; its extent is the box.
      const [{ unit }] = list;
      for (const run of entry.runs) add(run, wholePiece(unit, run, false), entry.line, false);
      extents.push({ unit, line: entry.line, left: entry.box.x, right: entry.box.x + entry.box.width, rtl: entry.box.style.direction === 'rtl' });
    } else if (list.length === 1 && (byLine || !entry.run[RUN_LEVELS])) {
      // A stream's text is all claimed: a run's one claim is all of it. A word over two
      // levels is cut so its fragments keep their directions.
      add(entry.run, wholePiece(list[0].unit, entry.run, list[0].claim.space), entry.line);
    } else {
      list.sort((x, y) => x.claim.start - y.claim.start);
      for (const piece of cutRun(session, entry.run, list)) add(entry.run, piece, entry.line);
    }
  });
  // Left to right, a run of spaces keeps its unit while that unit is beside it, else joins the
  // unit before it: across a direction change, its reading-order unit may sit elsewhere.
  for (const pieces of onLine) {
    pieces.sort((a, b) => a.left - b.left);
    for (let i = 0; i < pieces.length;) {
      if (!pieces[i].space) { i++; continue; }
      let j = i;
      while (j < pieces.length && pieces[j].space) j++;
      const before = pieces[i - 1]?.unit, after = pieces[j]?.unit;
      for (let k = i; k < j; k++) {
        if (pieces[k].unit !== before && pieces[k].unit !== after) pieces[k].unit = before ?? after ?? pieces[k].unit;
      }
      i = j;
    }
  }
  setGeometry(drafts, extents, lines, byLine);
}

function wholePiece(unit: TextUnit, run: LayoutText, space: boolean): UnitPiece {
  const [left, right] = textEdges(run);
  return { unit, run, left, right, space };
}

/**
 * `run`'s level-uniform spans in logical order, each with the x its glyphs start from (an RTL
 * span's right edge). Only a single-paint bidi line holds more than one level (`RUN_LEVELS`);
 * its spans are placed as Canvas orders them.
 */
function levelSpans(run: PrivateText, width: (s: string) => number) {
  const { text } = run;
  const rtl = run.style.direction === 'rtl';
  const levels = run[RUN_LEVELS];
  if (!levels) return [{ start: 0, end: text.length, rtl, edge: run.x }];
  const spans = levelRuns(levels).map(([start, end]) =>
    ({ start, end, rtl: levels[start] % 2 === 1, edge: 0, width: width(text.slice(start, end)) }));
  const [left, right] = textEdges(run);
  let x = rtl ? right - spans.reduce((sum, s) => sum + s.width, 0) : left;
  for (const k of visualOrder(spans.map(s => levels[s.start]))) {
    spans[k].edge = spans[k].rtl ? x + spans[k].width : x;
    x += spans[k].width;
  }
  return spans;
}

/** Cut `run` at its claims; each piece measured in the run's own state, where it paints. */
function cutRun(session: LayoutSession, run: LayoutText, claims: { unit: TextUnit; claim: Claim }[]): UnitPiece[] {
  const m = session.measurer;
  const state = m.stateOf(run.style);
  // Paint sets the style's word-spacing on the ctx; measuring does not.
  const spacing = run.style.wordSpacing || 0;
  const width = (s: string) => {
    let w = m.width(state, s);
    if (spacing) for (const ch of s) if (ch === ' ') w += spacing;
    return w;
  };
  const text = run.text;
  const spans = levelSpans(run, width);
  const pieces: UnitPiece[] = [];
  for (const { unit, claim } of claims) {
    for (const span of spans) {
      const a = Math.max(claim.start, span.start), b = Math.min(claim.end, span.end);
      if (a >= b) continue;
      const before = width(text.slice(span.start, a));
      const through = width(text.slice(span.start, b));
      const piece = text.slice(a, b);
      const w = width(piece);
      // An RTL span runs leftward from its right edge.
      const left = span.rtl ? span.edge - through : span.edge + before;
      const right = span.rtl ? span.edge - before : span.edge + through;
      const cut: PrivateText = {
        ...run, text: piece, width: w, style: withDirection(session, run.style, span.rtl ? 'rtl' : 'ltr'),
        // Where the whole run's fillText puts these glyphs: the piece ends at its slice end.
        x: span.rtl ? left + w : right - w,
      };
      pieces.push({ unit, run: cut, left, right, space: claim.space });
    }
  }
  // The pieces tile the run's own extent, so the bands of neighbouring units meet.
  const [left, right] = textEdges(run);
  pieces.reduce((a, b) => (b.left < a.left ? b : a)).left = left;
  pieces.reduce((a, b) => (b.right > a.right ? b : a)).right = right;
  return pieces;
}

/**
 * Each unit's fragments and their union. Left to right on a line, a unit's pieces join while
 * no other unit's piece sits between them and the direction holds (a line's is its block's).
 */
function setGeometry(drafts: Draft[], extents: Extent[], lines: LineInfo[], byLine: boolean): void {
  let previous: Extent | undefined;
  for (const e of extents.sort((a, b) => a.line - b.line || a.left - b.left)) {
    const { box } = lines[e.line];
    const direction = byLine ? lines[e.line].direction : e.rtl ? 'rtl' : 'ltr';
    const last = e.unit.fragments.at(-1);
    if (last && previous?.unit === e.unit && previous.line === e.line && last.direction === direction) {
      last.width = Math.max(last.x + last.width, e.right) - last.x;
    } else {
      e.unit.fragments.push({
        line: e.line, x: e.left, y: box.y, width: e.right - e.left, height: box.height,
        baseline: box[LINE_BASELINE]!, direction,
      });
    }
    previous = e;
  }
  for (const { unit } of drafts) {
    const { fragments } = unit;
    unit.x = Math.min(...fragments.map(f => f.x));
    unit.y = Math.min(...fragments.map(f => f.y));
    unit.width = Math.max(...fragments.map(f => f.x + f.width)) - unit.x;
    unit.height = Math.max(...fragments.map(f => f.y + f.height)) - unit.y;
  }
}
