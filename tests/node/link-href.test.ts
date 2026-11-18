/**
 * `ResolvedStyle.href`: the enclosing `<a>`'s destination on every laid-out run, for consumers
 * that export links (PDF annotations, SVG `<a>`). Mocked metrics: 10px a character.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as LinkedomDOMParser } from 'linkedom';
import { layout, setDOMParser } from '../../src/index.ts';
import { layoutTextOnPath } from '../../src/path/index.ts';
import { mockCtx } from '../helpers/mock-ctx.ts';
import { collectTexts } from '../helpers/layout-tree.ts';

beforeAll(() => setDOMParser(new LinkedomDOMParser()));
afterAll(() => setDOMParser(null));

const A = 'https://example.org/a', B = 'https://example.org/b';

function texts(html: string, width = 600) {
  return collectTexts(layout({ html, width, ctx: mockCtx() }).layoutRoot)
    .filter((t) => t.text.trim());
}

const runs = (html: string) => texts(html).map((t) => [t.text, t.style.href]);

describe('the enclosing anchor\'s href', () => {
  it('keeps adjacent anchors of one styling apart', () => {
    expect(runs(`<a href="${A}">Terms</a><a href="${B}">Privacy</a>`))
      .toEqual([['Terms', A], ['Privacy', B]]);
    // Right-to-left pieces of one paint merge into one run: not across a link's edge.
    expect(runs(`<p dir="rtl"><a href="${A}">שלום</a><a href="${B}">עולם</a></p>`))
      .toEqual([['שלום', A], ['עולם', B]]);
    expect(runs(`<p dir="rtl"><a href="${A}">שלום</a><a href="${A}">עולם</a></p>`)).toHaveLength(1);
  });

  it('reaches styled descendants, as written, and stops at the anchor\'s end', () => {
    expect(runs(`<a href="guide.html#top">see <b>guide</b></a> now <a>bare</a>`))
      .toEqual([['see', 'guide.html#top'], ['guide', 'guide.html#top'], ['now', undefined], ['bare', undefined]]);
  });

  it('is on the runs of each line of a wrapped anchor', () => {
    const wrapped = texts(`<a href="${A}">one two three four</a>`, 70);
    expect(new Set(wrapped.map((t) => t.y)).size).toBeGreaterThan(1);
    expect(wrapped.every((t) => t.style.href === A)).toBe(true);
  });

  it('is on each glyph of text on a path', () => {
    const { glyphs } = layoutTextOnPath({ html: `x<a href="${A}">ab</a>`, path: 'M0 80 L400 80', ctx: mockCtx() });
    expect(glyphs.map((g) => g.style.href)).toEqual([undefined, A, A]);
  });

  it('leaves a document without anchors as it was', () => {
    const { layoutRoot } = layout({ html: '<p>plain <b>text</b></p>', width: 600, ctx: mockCtx() });
    expect(JSON.stringify(layoutRoot)).not.toContain('href');
  });
});
