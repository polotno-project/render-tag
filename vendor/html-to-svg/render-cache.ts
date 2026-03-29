import { LRUCache } from './lru-cache.js';
import type { HtmlToSvgOptions } from './index.js';
import { htmlToSvg } from './index.js';

export type HtmlToImageOptions = HtmlToSvgOptions;

interface CachedImage {
  image: ImageBitmap | HTMLImageElement;
}

let imageLru: LRUCache<string, CachedImage> | undefined;

function evictImage(_key: string, entry: CachedImage): void {
  if ('close' in entry.image && typeof entry.image.close === 'function') {
    entry.image.close();
  }
}

function getCacheKey(opts: HtmlToImageOptions): string {
  return `${opts.html}\0${opts.css ?? ''}\0${opts.width}\0${opts.height}\0${opts.pixelRatio ?? 1}`;
}

function getImageLru(maxEntries: number): LRUCache<string, CachedImage> {
  if (!imageLru) {
    imageLru = new LRUCache(maxEntries);
  } else if (imageLru.maxEntries !== maxEntries) {
    imageLru.resize(maxEntries);
  }
  return imageLru;
}

async function renderSvgToImage(svg: string): Promise<CachedImage> {
  // Data URLs are dramatically faster than Blob URLs for large SVG image loading
  // (e.g. 11ms vs 230ms for a 43MB SVG). The encodeURIComponent cost (~85ms) is
  // far less than the Blob URL overhead (~260ms for blob creation + image loading).
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load SVG as image'));
  });

  return { image: img };
}

/**
 * Convert HTML + CSS to a rendered image (ImageBitmap or HTMLImageElement).
 * When `cache` is enabled, results are cached in an LRU cache keyed on inputs.
 */
export async function htmlToImage(opts: HtmlToImageOptions): Promise<ImageBitmap | HTMLImageElement> {
  const useCache = !!opts.cache;
  const maxEntries = typeof opts.cache === 'object' ? opts.cache.maxEntries ?? 50 : 50;

  if (useCache) {
    const lru = getImageLru(maxEntries);
    const key = getCacheKey(opts);
    const cached = lru.get(key);
    if (cached) return cached.image;

    const svg = await htmlToSvg(opts);
    const entry = await renderSvgToImage(svg);
    lru.setWithEviction(key, entry, evictImage);
    return entry.image;
  }

  const svg = await htmlToSvg(opts);
  const entry = await renderSvgToImage(svg);
  return entry.image;
}

/**
 * Clear the image cache, revoking all blob URLs and closing ImageBitmaps.
 */
export function clearImageCache(): void {
  if (imageLru) {
    imageLru.forEach((entry) => evictImage('', entry));
    imageLru.clear();
  }
}
