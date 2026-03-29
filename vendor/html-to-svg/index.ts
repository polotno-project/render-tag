export type { BuildSvgOptions } from './svg-builder.js';
export { clearFontCache, prefetchFonts } from './font-inliner.js';
export { extractStyleTags } from './css-extractor.js';
export { htmlToImage, clearImageCache } from './render-cache.js';

import { LRUCache } from './lru-cache.js';
import { inlineFontsInCss, normalizeFontWeights } from './font-inliner.js';
import { htmlToXhtml } from './xhtml.js';
import { buildSvg } from './svg-builder.js';
import { extractStyleTags } from './css-extractor.js';
import { clearFontCache } from './font-inliner.js';
import { clearImageCache } from './render-cache.js';

export interface CacheOptions {
  maxEntries?: number; // default: 50
}

export interface HtmlToSvgOptions {
  /** HTML string to convert (may contain <style> tags — they will be extracted automatically) */
  html: string;
  /** Optional CSS string with @font-face rules (URLs will be auto-inlined as base64).
   *  Merged with any <style> tags found in the HTML. */
  css?: string;
  /** SVG/viewport width in px */
  width: number;
  /** SVG/viewport height in px */
  height: number;
  /** Device pixel ratio for high-DPI rendering (default: 1) */
  pixelRatio?: number;
  /** Opt-in SVG string caching. `true` uses default LRU (50 entries), or pass options. */
  cache?: boolean | CacheOptions;
}

let svgLru: LRUCache<string, string> | undefined;

function getSvgLru(maxEntries: number): LRUCache<string, string> {
  if (!svgLru) {
    svgLru = new LRUCache(maxEntries);
  } else if (svgLru.maxEntries !== maxEntries) {
    svgLru.resize(maxEntries);
  }
  return svgLru;
}

/**
 * Collect all unique Unicode codepoints from the text content of an HTML string.
 */
function collectCodepoints(html: string): Set<number> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = doc.body.textContent || '';
  const codepoints = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    codepoints.add(cp);
    if (cp > 0xFFFF) i++; // skip surrogate pair
  }
  return codepoints;
}

async function htmlToSvgUncached({ html, css = '', width, height, pixelRatio = 1 }: HtmlToSvgOptions): Promise<string> {
  const extracted = extractStyleTags(html);
  const combinedCss = [css, extracted.css].filter(Boolean).join('\n');

  const codepoints = collectCodepoints(extracted.html);
  const inlinedCss = await inlineFontsInCss(combinedCss, codepoints);
  const normalizedCss = normalizeFontWeights(inlinedCss);
  const xhtml = htmlToXhtml(extracted.html);
  return buildSvg({ xhtml, css: normalizedCss, width, height, pixelRatio });
}

/**
 * Convert HTML + CSS to an SVG string using foreignObject.
 *
 * Any <style> tags in `html` are extracted and merged with the `css` parameter.
 * Font URLs in CSS @font-face rules are fetched, base64-encoded, and cached.
 * Returns a self-contained SVG string ready for rendering.
 */
export async function htmlToSvg(opts: HtmlToSvgOptions): Promise<string> {
  if (opts.cache) {
    const max = typeof opts.cache === 'object' ? opts.cache.maxEntries ?? 50 : 50;
    const lru = getSvgLru(max);
    const key = `${opts.html}\0${opts.css ?? ''}\0${opts.width}\0${opts.height}\0${opts.pixelRatio ?? 1}`;
    const cached = lru.get(key);
    if (cached) return cached;
    const result = await htmlToSvgUncached(opts);
    lru.set(key, result);
    return result;
  }
  return htmlToSvgUncached(opts);
}

/** Clear the SVG string LRU cache. */
export function clearSvgCache(): void {
  if (svgLru) {
    svgLru.clear();
  }
}

/** Clear all caches: font, CSS inlining, SVG string, and rendered image. */
export function clearAllCaches(): void {
  clearFontCache();
  clearSvgCache();
  clearImageCache();
}
