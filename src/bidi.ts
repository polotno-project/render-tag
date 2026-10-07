/**
 * UAX #9 for line layout: paragraph levels (X1–X10, W1–W7, N0–N2, I1–I2), L1 and L2.
 * Canvas reorders only inside one fillText call, so a line of several runs is cut
 * into level-uniform pieces ordered here. Forced breaks are paragraph separators.
 * Bidi_Class comes from a generated UCD table (JS has no `\p{Bidi_Class}`).
 */

import { BIDI_RUN_CLASSES, BIDI_RUN_STARTS } from './bidi-class-data.js';

type BidiClass =
  | 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN'
  | 'B' | 'S' | 'WS' | 'ON'
  | 'LRE' | 'LRO' | 'RLE' | 'RLO' | 'PDF' | 'LRI' | 'RLI' | 'FSI' | 'PDI';

const LRE = '‪';
const RLE = '‫';
const PDF = '‬';
const LRO = '‭';
const RLO = '‮';
const LRI = '⁦';
const RLI = '⁧';
const FSI = '⁨';
const PDI = '⁩';

// Index order of the letters in `BIDI_RUN_CLASSES` (scripts/gen-bidi-class.mjs).
const CLASS_NAMES: readonly BidiClass[] = [
  'L', 'R', 'AL', 'EN', 'ES', 'ET', 'AN', 'CS', 'NSM', 'BN', 'B', 'S', 'WS', 'ON',
  'LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI',
];
let runStarts: Uint32Array | undefined;

function decodeRunStarts(): Uint32Array {
  const starts = new Uint32Array(BIDI_RUN_CLASSES.length);
  for (let i = 0, k = 0, cp = 0, delta = 0; i < BIDI_RUN_STARTS.length; i++) {
    const c = BIDI_RUN_STARTS.charCodeAt(i);
    if (c >= 97) {
      delta = delta * 26 + c - 97;
    } else {
      starts[k++] = cp += delta * 26 + c - 65;
      delta = 0;
    }
  }
  return runStarts = starts;
}

/** Bidi_Class of one code point (DerivedBidiClass, Unicode 17). */
export function bidiClass(cp: number): BidiClass {
  if (cp < 0x80 && (cp >= 0x41 && cp <= 0x5A || cp >= 0x61 && cp <= 0x7A)) return 'L';
  const starts = runStarts ?? decodeRunStarts();
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return CLASS_NAMES[BIDI_RUN_CLASSES.charCodeAt(lo) - 65];
}

/** Bidi_Paired_Bracket pairs (BidiBrackets.txt), opener → closer. */
const BRACKET_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0x28, 0x29], [0x5B, 0x5D], [0x7B, 0x7D], [0x0F3A, 0x0F3B], [0x0F3C, 0x0F3D],
  [0x169B, 0x169C], [0x2045, 0x2046], [0x207D, 0x207E], [0x208D, 0x208E],
  [0x2308, 0x2309], [0x230A, 0x230B], [0x2329, 0x232A], [0x2768, 0x2769],
  [0x276A, 0x276B], [0x276C, 0x276D], [0x276E, 0x276F], [0x2770, 0x2771],
  [0x2772, 0x2773], [0x2774, 0x2775], [0x27C5, 0x27C6], [0x27E6, 0x27E7],
  [0x27E8, 0x27E9], [0x27EA, 0x27EB], [0x27EC, 0x27ED], [0x27EE, 0x27EF],
  [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988], [0x2989, 0x298A],
  [0x298B, 0x298C], [0x298D, 0x2990], [0x298F, 0x298E], [0x2991, 0x2992],
  [0x2993, 0x2994], [0x2995, 0x2996], [0x2997, 0x2998], [0x29D8, 0x29D9],
  [0x29DA, 0x29DB], [0x29FC, 0x29FD], [0x2E22, 0x2E23], [0x2E24, 0x2E25],
  [0x2E26, 0x2E27], [0x2E28, 0x2E29], [0x2E55, 0x2E56], [0x2E57, 0x2E58],
  [0x2E59, 0x2E5A], [0x2E5B, 0x2E5C], [0x3008, 0x3009], [0x300A, 0x300B],
  [0x300C, 0x300D], [0x300E, 0x300F], [0x3010, 0x3011], [0x3014, 0x3015],
  [0x3016, 0x3017], [0x3018, 0x3019], [0x301A, 0x301B], [0xFE59, 0xFE5A],
  [0xFE5B, 0xFE5C], [0xFE5D, 0xFE5E], [0xFF08, 0xFF09], [0xFF3B, 0xFF3D],
  [0xFF5B, 0xFF5D], [0xFF5F, 0xFF60], [0xFF62, 0xFF63],
];
const OPENERS = new Map<number, number>();
const CLOSERS = new Map<number, number>();
for (const [open, close] of BRACKET_PAIRS) {
  OPENERS.set(open, close);
  CLOSERS.set(close, open);
}
/** Canonical equivalents that pair with each other (U+2329/232A ≡ U+3008/3009). */
const canonicalBracket = (cp: number): number =>
  cp === 0x2329 ? 0x3008 : cp === 0x232A ? 0x3009 : cp;

const MAX_DEPTH = 125;

const isIsolateInit = (t: BidiClass) => t === 'LRI' || t === 'RLI' || t === 'FSI';
const isRemovedByX9 = (t: BidiClass) =>
  t === 'RLE' || t === 'LRE' || t === 'RLO' || t === 'LRO' || t === 'PDF' || t === 'BN';
const isNI = (t: BidiClass) =>
  t === 'B' || t === 'S' || t === 'WS' || t === 'ON' || isIsolateInit(t) || t === 'PDI';

/** A resolved paragraph: one level and one ORIGINAL class per UTF-16 unit. */
interface BidiParagraph {
  paragraphLevel: number;
  levels: Uint8Array;
  classes: BidiClass[];
}

/** Embedding levels for `text` (paragraphs split at B) at a fixed paragraph level (CSS `direction`, not P2/P3). */
export function resolveBidi(text: string, paragraphLevel: 0 | 1): BidiParagraph {
  const units = text.length;
  const classes: BidiClass[] = new Array(units);
  // The algorithm runs over code points; `unit[k]` is where code point k starts.
  const cps: number[] = [];
  const unit: number[] = [];
  for (let i = 0; i < units; i++) {
    const cp = text.codePointAt(i)!;
    const c = bidiClass(cp);
    cps.push(cp);
    unit.push(i);
    classes[i] = c;
    if (cp > 0xFFFF) classes[++i] = c;
  }
  const types = cps.map((_, k) => classes[unit[k]]);
  const cpLevels = new Uint8Array(cps.length);
  let start = 0;
  for (let k = 0; k <= cps.length; k++) {
    if (k === cps.length || types[k] === 'B') {
      if (k > start) {
        resolveParagraph(
          types.slice(start, k), cps.slice(start, k), paragraphLevel,
        ).forEach((level, j) => { cpLevels[start + j] = level; });
      }
      if (k < cps.length) cpLevels[k] = paragraphLevel;
      start = k + 1;
    }
  }
  const levels = new Uint8Array(units);
  for (let k = 0; k < cps.length; k++) {
    levels[unit[k]] = cpLevels[k];
    if (cps[k] > 0xFFFF) levels[unit[k] + 1] = cpLevels[k];
  }
  return { paragraphLevel, levels, classes };
}

function resolveParagraph(
  orig: BidiClass[], cps: number[], paragraphLevel: number,
): Uint8Array {
  const len = orig.length;
  const types: BidiClass[] = orig.slice();
  const lv = new Uint8Array(len);

  // BD9: matching PDI for each isolate initiator (and its inverse).
  const matchingPDI = new Int32Array(len).fill(-1);
  const matchingInit = new Int32Array(len).fill(-1);
  {
    const stack: number[] = [];
    for (let i = 0; i < len; i++) {
      if (isIsolateInit(types[i])) stack.push(i);
      else if (types[i] === 'PDI' && stack.length > 0) {
        const open = stack.pop()!;
        matchingPDI[open] = i;
        matchingInit[i] = open;
      }
    }
  }

  // FSI: direction of the first strong char up to its matching PDI (P2/P3).
  const firstStrong = (from: number, to: number): 0 | 1 | -1 => {
    for (let i = from; i < to; i++) {
      const t = types[i];
      if (t === 'L') return 0;
      if (t === 'R' || t === 'AL') return 1;
      if (isIsolateInit(t)) {
        i = matchingPDI[i] < 0 ? to : matchingPDI[i];
      }
    }
    return -1;
  };

  // ── X1–X8: explicit levels and directions ──
  interface Entry { level: number; override: '' | 'L' | 'R'; isolate: boolean }
  const stack: Entry[] = [{ level: paragraphLevel, override: '', isolate: false }];
  let overflowIsolates = 0;
  let overflowEmbeddings = 0;
  let validIsolates = 0;
  for (let i = 0; i < len; i++) {
    const t = types[i];
    const top = stack[stack.length - 1];
    switch (t) {
      case 'RLE': case 'LRE': case 'RLO': case 'LRO': {
        const rtl = t === 'RLE' || t === 'RLO';
        const next = rtl ? (top.level + 1) | 1 : (top.level + 2) & ~1;
        if (next <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
          stack.push({
            level: next,
            override: t === 'RLO' ? 'R' : t === 'LRO' ? 'L' : '',
            isolate: false,
          });
        } else if (overflowIsolates === 0) {
          overflowEmbeddings++;
        }
        lv[i] = top.level;
        break;
      }
      case 'RLI': case 'LRI': case 'FSI': {
        lv[i] = top.level;
        if (top.override) types[i] = top.override;
        let rtl = t === 'RLI';
        if (t === 'FSI') {
          const end = matchingPDI[i] < 0 ? len : matchingPDI[i];
          rtl = firstStrong(i + 1, end) === 1;
        }
        const next = rtl ? (top.level + 1) | 1 : (top.level + 2) & ~1;
        if (next <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
          validIsolates++;
          stack.push({ level: next, override: '', isolate: true });
        } else {
          overflowIsolates++;
        }
        break;
      }
      case 'PDI': {
        if (overflowIsolates > 0) {
          overflowIsolates--;
        } else if (validIsolates > 0) {
          overflowEmbeddings = 0;
          while (!stack[stack.length - 1].isolate) stack.pop();
          stack.pop();
          validIsolates--;
        }
        const now = stack[stack.length - 1];
        lv[i] = now.level;
        if (now.override) types[i] = now.override;
        break;
      }
      case 'PDF': {
        if (overflowIsolates > 0) {
          // nothing
        } else if (overflowEmbeddings > 0) {
          overflowEmbeddings--;
        } else if (!top.isolate && stack.length >= 2) {
          stack.pop();
        }
        lv[i] = top.level;
        break;
      }
      case 'B':
        lv[i] = paragraphLevel;
        break;
      case 'BN':
        lv[i] = top.level;
        break;
      default:
        lv[i] = top.level;
        if (top.override) types[i] = top.override;
    }
  }

  // ── X9/X10: level runs over the chars X9 keeps, chained into isolating run sequences ──
  const kept: number[] = [];
  for (let i = 0; i < len; i++) if (!isRemovedByX9(orig[i])) kept.push(i);
  const runs: number[][] = [];
  for (const i of kept) {
    const last = runs[runs.length - 1];
    if (last && lv[last[last.length - 1]] === lv[i]) last.push(i);
    else runs.push([i]);
  }
  const runOf = new Map<number, number[]>();
  for (const run of runs) runOf.set(run[0], run);
  const sequences: number[][] = [];
  for (const run of runs) {
    const first = run[0];
    // A run that starts with a PDI matching an initiator continues that sequence.
    if (orig[first] === 'PDI' && matchingInit[first] >= 0) continue;
    const seq: number[] = [];
    let current: number[] | undefined = run;
    while (current) {
      for (const i of current) seq.push(i);
      const lastChar = current[current.length - 1];
      if (isIsolateInit(orig[lastChar]) && matchingPDI[lastChar] >= 0) {
        current = runOf.get(matchingPDI[lastChar]);
      } else {
        current = undefined;
      }
    }
    sequences.push(seq);
  }

  // X10 reads neighbours' explicit levels; I1/I2 below overwrite `lv` sequence by sequence.
  const explicit = lv.slice();
  for (const seq of sequences) {
    resolveSequence(seq, types, orig, lv, explicit, cps, paragraphLevel, len);
  }

  // X9 removed chars take the level of the preceding char (or the paragraph's).
  for (let i = 0; i < len; i++) {
    if (isRemovedByX9(orig[i])) lv[i] = i > 0 ? lv[i - 1] : paragraphLevel;
  }

  return lv;
}

function resolveSequence(
  seq: number[], types: BidiClass[], orig: BidiClass[], lv: Uint8Array, explicit: Uint8Array,
  cps: number[], paragraphLevel: number, len: number,
): void {
  const level = lv[seq[0]];
  const lastChar = seq[seq.length - 1];
  // sos/eos: the higher of this level and the neighbouring one (X10).
  let prevLevel = paragraphLevel;
  for (let i = seq[0] - 1; i >= 0; i--) {
    if (!isRemovedByX9(orig[i])) { prevLevel = explicit[i]; break; }
  }
  // Ending on an (unmatched) isolate initiator: eos compares with the paragraph level.
  let nextLevel = paragraphLevel;
  if (!isIsolateInit(orig[lastChar])) {
    for (let i = lastChar + 1; i < len; i++) {
      if (!isRemovedByX9(orig[i])) { nextLevel = explicit[i]; break; }
    }
  }
  const sos: BidiClass = Math.max(prevLevel, level) % 2 ? 'R' : 'L';
  const eos: BidiClass = Math.max(nextLevel, lv[lastChar]) % 2 ? 'R' : 'L';
  const t = seq.map((i) => types[i]);
  const n = t.length;

  // W1: NSM takes the previous type (ON after an isolate initiator or PDI).
  for (let k = 0; k < n; k++) {
    if (t[k] === 'NSM') {
      if (k === 0) t[k] = sos;
      else t[k] = isIsolateInit(t[k - 1]) || t[k - 1] === 'PDI' ? 'ON' : t[k - 1];
    }
  }
  // W2: EN after AL becomes AN. W3: AL → R.
  let lastStrong: BidiClass = sos;
  for (let k = 0; k < n; k++) {
    const c = t[k];
    if (c === 'L' || c === 'R' || c === 'AL') lastStrong = c;
    else if (c === 'EN' && lastStrong === 'AL') t[k] = 'AN';
  }
  for (let k = 0; k < n; k++) if (t[k] === 'AL') t[k] = 'R';
  // W4: a single ES between ENs → EN; a single CS between same numbers → that number.
  for (let k = 1; k < n - 1; k++) {
    if (t[k] === 'ES' && t[k - 1] === 'EN' && t[k + 1] === 'EN') t[k] = 'EN';
    else if (t[k] === 'CS' && t[k - 1] === 'EN' && t[k + 1] === 'EN') t[k] = 'EN';
    else if (t[k] === 'CS' && t[k - 1] === 'AN' && t[k + 1] === 'AN') t[k] = 'AN';
  }
  // W5: ET sequences next to EN → EN.
  for (let k = 0; k < n; k++) {
    if (t[k] !== 'ET') continue;
    let e = k;
    while (e < n && t[e] === 'ET') e++;
    const touches = (k > 0 && t[k - 1] === 'EN') || (e < n && t[e] === 'EN');
    if (touches) for (let j = k; j < e; j++) t[j] = 'EN';
    k = e - 1;
  }
  // W6: remaining separators and terminators → ON.
  for (let k = 0; k < n; k++) {
    if (t[k] === 'ES' || t[k] === 'ET' || t[k] === 'CS') t[k] = 'ON';
  }
  // W7: EN after L (or sos L) → L.
  lastStrong = sos;
  for (let k = 0; k < n; k++) {
    const c = t[k];
    if (c === 'L' || c === 'R') lastStrong = c;
    else if (c === 'EN' && lastStrong === 'L') t[k] = 'L';
  }

  const embeddingDir: BidiClass = level % 2 ? 'R' : 'L';
  const strongDir = (c: BidiClass): BidiClass | null =>
    c === 'L' ? 'L' : c === 'R' || c === 'EN' || c === 'AN' ? 'R' : null;

  // N0: bracket pairs (BD16), only on chars still ON whose ORIGINAL type was ON.
  {
    const pairs: Array<[number, number]> = [];
    const stack: Array<{ close: number; pos: number }> = [];
    let overflow = false;
    for (let k = 0; k < n && !overflow; k++) {
      if (t[k] !== 'ON') continue;
      const cp = canonicalBracket(cps[seq[k]]);
      const close = OPENERS.get(cp);
      if (close !== undefined) {
        if (stack.length === 63) { overflow = true; break; }
        stack.push({ close: canonicalBracket(close), pos: k });
      } else if (CLOSERS.has(cp)) {
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].close === cp) {
            pairs.push([stack[s].pos, k]);
            stack.length = s;
            break;
          }
        }
      }
    }
    if (!overflow) {
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [o, c] of pairs) {
        let foundEmbedding = false;
        let foundOpposite = false;
        for (let k = o + 1; k < c; k++) {
          const d = strongDir(t[k]);
          if (!d) continue;
          if (d === embeddingDir) { foundEmbedding = true; break; }
          foundOpposite = true;
        }
        let dir: BidiClass | null = null;
        if (foundEmbedding) dir = embeddingDir;
        else if (foundOpposite) {
          // Context before the opener: the first strong type found backwards.
          let before: BidiClass = sos;
          for (let k = o - 1; k >= 0; k--) {
            const d = strongDir(t[k]);
            if (d) { before = d; break; }
          }
          dir = before !== embeddingDir ? before : embeddingDir;
        }
        if (dir) {
          t[o] = dir;
          t[c] = dir;
          // NSMs after a bracket that changed take its type.
          for (const b of [o, c]) {
            for (let k = b + 1; k < n && orig[seq[k]] === 'NSM'; k++) t[k] = dir;
          }
        }
      }
    }
  }

  // N1/N2: sequences of NIs take the surrounding strong direction, else the embedding's.
  for (let k = 0; k < n; k++) {
    if (!isNI(t[k])) continue;
    let e = k;
    while (e < n && isNI(t[e])) e++;
    const before: BidiClass = k === 0 ? sos : strongDir(t[k - 1]) ?? embeddingDir;
    const after: BidiClass = e === n ? eos : strongDir(t[e]) ?? embeddingDir;
    const dir = before === after ? before : embeddingDir;
    for (let j = k; j < e; j++) t[j] = dir;
    k = e - 1;
  }

  // I1/I2.
  for (let k = 0; k < n; k++) {
    const i = seq[k];
    const c = t[k];
    if (level % 2 === 0) {
      if (c === 'R') lv[i] = level + 1;
      else if (c === 'AN' || c === 'EN') lv[i] = level + 2;
      else lv[i] = level;
    } else {
      lv[i] = c === 'L' || c === 'EN' || c === 'AN' ? level + 1 : level;
    }
  }
}

/**
 * L1 for line `[start, end)`: separators, and whitespace before them or at line end,
 * return to the paragraph level. Returns the line's levels; the paragraph is unchanged.
 */
export function lineLevels(par: BidiParagraph, start: number, end: number): Uint8Array {
  const out = par.levels.slice(start, end);
  const { classes, paragraphLevel } = par;
  const isTrailing = (c: BidiClass) =>
    c === 'WS' || isIsolateInit(c) || c === 'PDI' || isRemovedByX9(c);
  let trailing = true;
  for (let i = end - 1; i >= start; i--) {
    const c = classes[i];
    if (c === 'S' || c === 'B') {
      out[i - start] = paragraphLevel;
      trailing = true;
    } else if (trailing && isTrailing(c)) {
      out[i - start] = paragraphLevel;
    } else {
      trailing = false;
    }
  }
  return out;
}

/** L2: visual order (indices, left to right) of items with the given levels. */
export function visualOrder(levels: ArrayLike<number>): number[] {
  const order = Array.from({ length: levels.length }, (_, i) => i);
  let highest = 0;
  let lowest = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (l > highest) highest = l;
    if (l < lowest) lowest = l;
  }
  const lowestOdd = lowest | 1;
  for (let level = highest; level >= lowestOdd; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]] < level) continue;
      let j = i;
      while (j < order.length && levels[order[j]] >= level) j++;
      for (let a = i, b = j - 1; a < b; a++, b--) {
        const tmp = order[a]; order[a] = order[b]; order[b] = tmp;
      }
      i = j;
    }
  }
  return order;
}

/** Any character that can make a paragraph need reordering (R, AL, AN, RTL controls). */
const RTL_TRIGGER = /[֐-ࣿיִ-﷿ﹰ-﻿‏‫‮⁧⁨؜\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
export function mayNeedBidi(text: string): boolean {
  return RTL_TRIGGER.test(text);
}

/** An inline element's `unicode-bidi` effect, chained to its ancestor's; `null` is the paragraph. */
export interface BidiContext {
  parent: BidiContext | null;
  /** The control that opens it: LRI/RLI/FSI, LRE/RLE, LRO/RLO — or two, for isolate-override. */
  open: string;
  /** Matching closer(s). */
  close: string;
}

/** The context an element opens, or `parent` for `normal`. `plaintext` approximates as FSI. */
export function bidiContextFor(
  unicodeBidi: string, direction: string, parent: BidiContext | null,
): BidiContext | null {
  const rtl = direction === 'rtl';
  switch (unicodeBidi) {
    case 'isolate':
      return { parent, open: rtl ? RLI : LRI, close: PDI };
    case 'plaintext':
      return { parent, open: FSI, close: PDI };
    case 'embed':
      return { parent, open: rtl ? RLE : LRE, close: PDF };
    case 'bidi-override':
      return { parent, open: rtl ? RLO : LRO, close: PDF };
    case 'isolate-override':
      return { parent, open: (rtl ? RLI : LRI) + (rtl ? RLO : LRO), close: PDF + PDI };
    default:
      return parent;
  }
}

/** Builds a paragraph's text wrapped in its contexts' control characters (CSS Writing Modes 3 §2.4.2). */
export class BidiTextBuilder {
  text = '';
  private open: BidiContext[] = [];

  /** Append `piece` inside `context`; returns its offset in `text`. */
  push(piece: string, context: BidiContext | null): number {
    this.enter(context);
    const at = this.text.length;
    this.text += piece;
    return at;
  }

  /** A forced break: close every context and separate paragraphs. */
  paragraphBreak(): void {
    this.enter(null);
    this.text += '\n';
  }

  /** Move the open-context stack to `context`'s chain. */
  enter(context: BidiContext | null): void {
    const chain: BidiContext[] = [];
    for (let c = context; c; c = c.parent) chain.unshift(c);
    let common = 0;
    while (common < chain.length && common < this.open.length &&
      chain[common] === this.open[common]) common++;
    for (let i = this.open.length - 1; i >= common; i--) this.text += this.open[i].close;
    for (let i = common; i < chain.length; i++) this.text += chain[i].open;
    this.open = chain;
  }
}
