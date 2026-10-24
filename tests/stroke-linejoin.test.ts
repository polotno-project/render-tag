/**
 * Tests for `stroke-linejoin` on -webkit-text-stroke'd text.
 *
 * Browsers always paint HTML text-stroke corners round and expose no property
 * to change it. render-tag draws the stroke itself, so it honors a
 * `stroke-linejoin` declaration (round | miter | bevel) — letting callers get
 * squared corners (e.g. varsity/block lettering). Default is round, matching
 * the browser.
 */
import { describe, it, expect } from 'vitest';
import { render } from '../src/index.ts';
import { countMatching, isOpaqueRed } from './helpers/pixels.ts';

describe('stroke-linejoin rendering', () => {
  // Transparent fill + thick red stroke → red pixels ARE the stroke.
  // 'M' has sharp outer vertices where the join shape matters most.
  const base =
    'font-size: 120px; font-weight: 900; font-family: sans-serif; color: transparent;';
  const stroke = '-webkit-text-stroke: 12px red;';

  const redFor = (joinDecl: string): number => {
    const html = `<span style="${base} ${stroke} ${joinDecl}">M</span>`;
    return countMatching(render({ html, width: 400, pixelRatio: 1 }).canvas, isOpaqueRed);
  };

  it('miter join extends the corners beyond round (more stroke area)', () => {
    const round = redFor('stroke-linejoin: round;');
    const miter = redFor('stroke-linejoin: miter;');
    // Miter spikes at the sharp vertices add coverage a round join clips off.
    expect(miter).toBeGreaterThan(round);
  });

  it('bevel differs from both round and miter', () => {
    const round = redFor('stroke-linejoin: round;');
    const miter = redFor('stroke-linejoin: miter;');
    const bevel = redFor('stroke-linejoin: bevel;');
    expect(bevel).not.toBe(round);
    expect(bevel).not.toBe(miter);
  });

  it('defaults to round when unset', () => {
    expect(redFor('')).toBe(redFor('stroke-linejoin: round;'));
  });
});
