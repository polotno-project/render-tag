/**
 * UAX #9 core (src/bidi.ts): levels, L1 and L2 on hand-checked strings.
 *
 * Upper-case Latin stands for Hebrew (R) so the expectations stay readable:
 * `visual()` maps A–Z to U+05D0.. before resolving and back afterwards. The
 * result is the code-point order left to right — mirroring is Canvas's job,
 * so a mirrored bracket shows here as its logical code point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resolveBidi, lineLevels, visualOrder, bidiClass, BidiTextBuilder, bidiContextFor,
} from '../../src/bidi.ts';

const toHebrew = (s: string) =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(0x05D0 + c.charCodeAt(0) - 65));
const fromHebrew = (s: string) =>
  s.replace(/[א-ת]/g, (c) => String.fromCharCode(65 + c.charCodeAt(0) - 0x05D0));

function visual(text: string, base: 0 | 1): string {
  const t = toHebrew(text);
  const par = resolveBidi(t, base);
  const levels = lineLevels(par, 0, t.length);
  return fromHebrew(visualOrder(levels).map((i) => t[i]).join(''));
}

describe('bidiClass', () => {
  it('classifies the weak and strong types render-tag meets', () => {
    expect(bidiClass('a'.codePointAt(0)!)).toBe('L');
    expect(bidiClass(0x05D0)).toBe('R');
    expect(bidiClass(0x0627)).toBe('AL');
    expect(bidiClass('5'.codePointAt(0)!)).toBe('EN');
    expect(bidiClass(0x0665)).toBe('AN'); // Arabic-Indic five
    expect(bidiClass(0x06F5)).toBe('EN'); // Extended Arabic-Indic five
    expect(bidiClass('$'.codePointAt(0)!)).toBe('ET');
    expect(bidiClass(0x20AA)).toBe('ET'); // new shekel sign
    expect(bidiClass(','.codePointAt(0)!)).toBe('CS');
    expect(bidiClass('-'.codePointAt(0)!)).toBe('ES');
    expect(bidiClass(' '.codePointAt(0)!)).toBe('WS');
    expect(bidiClass('('.codePointAt(0)!)).toBe('ON');
    expect(bidiClass(0x064E)).toBe('NSM'); // fatha
    expect(bidiClass(0x4E2D)).toBe('L'); // 中
    expect(bidiClass(0x3002)).toBe('ON'); // 。
    expect(bidiClass(0x0939)).toBe('L'); // Devanagari
  });

  it('follows the UCD where General_Category and block disagree with Bidi_Class', () => {
    expect(bidiClass(0x02C8)).toBe('ON'); // ˈ modifier letter vertical line (Lm)
    expect(bidiClass(0x0964)).toBe('L'); // Devanagari danda (Po)
    expect(bidiClass(0xFDFD)).toBe('ON'); // ﷽ in the Arabic presentation forms
    expect(bidiClass(0x070F)).toBe('AL'); // Syriac abbreviation mark (Cf)
    expect(bidiClass(0x2800)).toBe('L'); // Braille blank (So)
    expect(bidiClass(0x1F190)).toBe('L'); // 🆐 square DJ (So)
    expect(bidiClass(0x10FFFF)).toBe('BN'); // a noncharacter
    expect(bidiClass(0x0590)).toBe('R'); // unassigned in Hebrew: the @missing default
  });
});

describe('visual order (L2)', () => {
  it('adjacent RTL words in an LTR paragraph read right to left as one run', () => {
    expect(visual('car is THE CAR in hebrew', 0)).toBe('car is RAC EHT in hebrew');
  });

  it('LTR words in an RTL paragraph keep their own order; trailing punctuation goes left', () => {
    expect(visual('CAR MEANS car.', 1)).toBe('.car SNAEM RAC');
  });

  it('numbers inside RTL text stay left to right', () => {
    expect(visual('PRICE 123 DOLLARS', 1)).toBe('SRALLOD 123 ECIRP');
    // EN after R in an LTR paragraph stays EN (level 2) and joins the RTL run.
    expect(visual('ABC 123 def', 0)).toBe('123 CBA def');
  });

  it('a European number after Arabic letters becomes AN (W2)', () => {
    const t = 'عدد 12';
    const par = resolveBidi(t, 0);
    expect(Array.from(par.levels)).toEqual([1, 1, 1, 1, 2, 2]);
  });

  it('separators between numbers join them (W4) and terminators attach (W5)', () => {
    expect(visual('ABC 1,000.50$ DEF', 1)).toBe('FED 1,000.50$ CBA');
  });

  it('a bracket pair takes the embedding direction when the context is (N0)', () => {
    // Inside is L, before the opener is R = the embedding direction.
    expect(visual('ABC (def) GHI', 1)).toBe('IHG )def( CBA');
  });

  it('a bracket pair around RTL text in an LTR paragraph after RTL context goes RTL (N0)', () => {
    expect(visual('ABC (DEF) ghi', 0)).toBe(')FED( CBA ghi');
  });

  it('trailing whitespace returns to the paragraph level (L1)', () => {
    expect(visual('abc ', 1)).toBe(' abc');
  });

  it('a paragraph separator splits paragraphs', () => {
    expect(visual('ABC\nDEF', 0)).toBe('CBA\nFED');
  });
});

describe('BidiTextBuilder', () => {
  it('wraps an isolate in RLI…PDI, closing and reopening around a paragraph break', () => {
    const outer = bidiContextFor('isolate', 'rtl', null);
    const b = new BidiTextBuilder();
    b.push('a ', null);
    b.push('X', outer);
    b.paragraphBreak();
    b.push('Y', outer);
    b.enter(null);
    expect(b.text).toBe('a ⁧X⁩\n⁧Y⁩');
  });

  it('an RTL isolate is a neutral to its surroundings', () => {
    // "1 <rtl>ABC</rtl> 2" in LTR: the isolate does not pull the numbers in.
    const b = new BidiTextBuilder();
    b.push('x 1 ', null);
    const at = b.push(toHebrew('AB'), bidiContextFor('isolate', 'rtl', null));
    b.push(' 2', null);
    b.enter(null);
    const par = resolveBidi(b.text, 0);
    expect(par.levels[at]).toBe(1);
    // The digits stay at 0: W7 sees "x" (L), and the isolate is a neutral.
    expect(par.levels[b.text.indexOf('1')]).toBe(0);
    expect(par.levels[b.text.indexOf('2')]).toBe(0);
  });
});

/** Code-point levels after L1 and the visual order of the non-`x` ones, as the UCD tests state them. */
function conformance(cps: number[], dir: 0 | 1, want: string[]): { levels: string; order: string } {
  const text = String.fromCodePoint(...cps);
  const units = lineLevels(resolveBidi(text, dir), 0, text.length);
  const cpLevels: number[] = [];
  let u = 0;
  for (const cp of cps) {
    cpLevels.push(units[u]);
    u += cp > 0xFFFF ? 2 : 1;
  }
  const kept = cps.map((_, k) => k).filter((k) => want[k] !== 'x');
  return {
    levels: cpLevels.map((l, k) => want[k] === 'x' ? 'x' : String(l)).join(' '),
    order: visualOrder(kept.map((k) => cpLevels[k])).map((i) => kept[i]).join(' '),
  };
}

/** One representative code point per Bidi_Class, for BidiTest.txt rows. */
const CLASS_CP: Record<string, number> = {
  L: 0x61, R: 0x5D0, AL: 0x627, EN: 0x30, ES: 0x2B, ET: 0x23, AN: 0x660, CS: 0x2C, NSM: 0x300,
  BN: 0xAD, B: 0x2029, S: 0x09, WS: 0x20, ON: 0x21, LRE: 0x202A, RLE: 0x202B, PDF: 0x202C,
  LRO: 0x202D, RLO: 0x202E, LRI: 0x2066, RLI: 0x2067, FSI: 0x2068, PDI: 0x2069,
};

describe('UAX #9 conformance: explicit embeddings', () => {
  // X10: a sequence's sos/eos come from its neighbours' EXPLICIT levels, not the
  // levels an earlier sequence already resolved (here the digits after PDF must
  // not see the embedded Hebrew raised to 3).
  it('sos/eos read the explicit embedding levels', () => {
    const row = (hex: string, dir: 0 | 1, levels: string) =>
      conformance(hex.split(' ').map((h) => parseInt(h, 16)), dir, levels.split(' ')).levels;
    expect(row('05D0 202A 05D1 202C 0020 0031 0020 0032', 0, '1 x 3 x 0 0 0 0')).toBe('1 x 3 x 0 0 0 0');
    expect(row('0061 202B 0062 202C 0020 0031 0020 0032', 1, '2 x 4 x 1 2 1 2')).toBe('2 x 4 x 1 2 1 2');
    const cls = (classes: string, dir: 0 | 1, levels: string) =>
      conformance(classes.split(' ').map((c) => CLASS_CP[c]), dir, levels.split(' ')).levels;
    expect(cls('AN RLE NSM', 0, '2 x 1')).toBe('2 x 1');
  });

  // tests/bidi-embedding-conformance.txt: Unicode 17 rows with LRE/RLE/LRO/RLO.
  it('matches the pinned BidiCharacterTest and BidiTest embedding rows', () => {
    const fixture = readFileSync(new URL('../bidi-embedding-conformance.txt', import.meta.url), 'utf8');
    let section = '';
    const failures: string[] = [];
    let rows = 0;
    for (const line of fixture.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('@')) { section = line; continue; }
      const [input, dir, levels, order] = line.split(';');
      const cps = input.split(' ').map((t) => section === '@chars' ? parseInt(t, 16) : CLASS_CP[t]);
      const got = conformance(cps, Number(dir) as 0 | 1, levels.split(' '));
      rows++;
      if (got.levels !== levels || got.order !== order) {
        failures.push(`${line}  →  ${got.levels};${got.order}`);
      }
    }
    expect(rows).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  });
});
