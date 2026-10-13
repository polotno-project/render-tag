/**
 * Border strokes on the recording ctx: a uniform square border is ONE
 * strokeRect (four side strokes would double a translucent color at the
 * corners); a uniform rounded border is one stroked path; mixed borders stay
 * one stroke per side.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, drawLayout, setDOMParser } from '../../src/index.ts';
import { recordingCtx } from '../helpers/recording-ctx.ts';

afterAll(() => setDOMParser(null));

function strokes(css: string): string[] {
  setDOMParser(new LinkedomDOMParser());
  const html = `<div style="${css};padding:4px">box</div>`;
  const result = layout({ html, width: 200, ctx: recordingCtx(200, 100).ctx });
  const painted = recordingCtx(200, 100);
  drawLayout({ layout: result, width: 200, ctx: painted.ctx, createCanvas: painted.createCanvas });
  return painted.paints.filter((p) => p.startsWith('stroke')).map((p) => p.slice(0, p.indexOf('(')));
}

describe('border strokes', () => {
  it('a uniform square border is one strokeRect', () => {
    expect(strokes('border:3px solid rgba(255,0,0,0.5)')).toEqual(['strokeRect']);
  });

  it('a uniform rounded border is one stroked path', () => {
    expect(strokes('border:2px solid #333;border-radius:8px')).toEqual(['stroke']);
  });

  it('mixed borders stroke each side', () => {
    expect(strokes('border:2px solid #333;border-left:5px solid red')).toEqual(['stroke', 'stroke', 'stroke', 'stroke']);
    expect(strokes('border-bottom:1px solid #ccc')).toEqual(['stroke']);
  });
});
