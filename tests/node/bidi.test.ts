/**
 * UAX #9 core (src/bidi.ts): levels, L1 and L2 on hand-checked strings.
 *
 * Upper-case Latin stands for Hebrew (R) so the expectations stay readable:
 * `visual()` maps A–Z to U+05D0.. before resolving and back afterwards. The
 * result is the code-point order left to right — mirroring is Canvas's job,
 * so a mirrored bracket shows here as its logical code point.
 */
import { describe, it, expect } from 'vitest';
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
