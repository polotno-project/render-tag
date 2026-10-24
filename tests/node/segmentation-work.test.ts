import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, setDOMParser } from '../../src/index.ts';
import { layoutTextOnPath } from '../../src/path/index.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterEach(() => vi.restoreAllMocks());
afterAll(() => setDOMParser(null));

it('keeps an ASCII word across inline styles without Unicode segmentation', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  const result = layout({ html: '<p><b>ex</b>perience now</p>', width: 100, ctx: mockCtx() });
  expect(result.lines.map(line => line.text)).toEqual(['experience', 'now']);
  expect(segment).not.toHaveBeenCalled();
});

it('lays ASCII path glyphs without Unicode segmentation', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  const result = layoutTextOnPath({
    html: '<p>The quick brown <b>fox</b> jumps over the <i>lazy</i> dog.</p>',
    path: 'M0,0 H2000', ctx: mockCtx(),
  });
  expect(result.glyphs.map(glyph => glyph.char)).toEqual('The quick brown fox jumps over the lazy dog.'.split(''));
  expect(segment).not.toHaveBeenCalled();
});
