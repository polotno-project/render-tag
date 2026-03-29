/**
 * Font inliner — fetches external font URLs from @font-face CSS rules and replaces
 * them with base64 data URIs to produce self-contained SVGs.
 *
 * Two caches work together:
 *
 * 1. `fontCache` (Map<url, Promise<dataUri>>)
 *    Caches individual font URL → base64 conversions. Prevents re-fetching the same
 *    font file across different CSS strings. Grows with unique font URLs (typically
 *    10–20 per app session). Unbounded but each entry is one fetch result.
 *
 * 2. `cssCache` (Map<fingerprint, Promise<css>>)
 *    Caches the full inlined CSS result. Prevents re-running regex replacement on
 *    large CSS strings every render. The key is a cheap fingerprint (length + head +
 *    mid + tail samples, ~300 chars) to avoid iterating multi-MB CSS strings.
 *    This matters when CSS already contains base64 fonts (can be 43MB+).
 */

/** Maps font URL → Promise resolving to its base64 data URI. */
const fontCache = new Map<string, Promise<string>>();

/** Maps CSS fingerprint → Promise resolving to CSS with all fonts inlined. */
const cssCache = new Map<string, Promise<string>>();

const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
const UNICODE_RANGE_RE = /unicode-range:\s*([^;}]+)/i;

// ── Unicode-range filtering ─────────────────────────────────────────────────
//
// Google Fonts (and other providers) split fonts into subsets by unicode-range
// (latin, cyrillic, CJK, etc.). Each subset is a separate woff2 file. Without
// filtering, we'd fetch and embed ALL subsets even if the HTML only uses Latin
// characters. This can mean fetching 20+ unnecessary font files.
//
// The filtering works by:
// 1. Scanning the HTML text to collect which Unicode codepoints are actually used
// 2. Parsing the unicode-range descriptor from each @font-face block
// 3. Skipping blocks whose range doesn't intersect with the used codepoints

/**
 * Parse a CSS unicode-range descriptor into an array of [start, end] pairs.
 * Handles: U+XXXX, U+XXXX-YYYY, U+XX?? (wildcard).
 */
function parseUnicodeRange(rangeStr: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim();
    const match = trimmed.match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/i);
    if (!match) continue;

    if (match[2]) {
      ranges.push([parseInt(match[1], 16), parseInt(match[2], 16)]);
    } else if (match[1].includes('?')) {
      ranges.push([
        parseInt(match[1].replace(/\?/g, '0'), 16),
        parseInt(match[1].replace(/\?/g, 'F'), 16),
      ]);
    } else {
      const cp = parseInt(match[1], 16);
      ranges.push([cp, cp]);
    }
  }
  return ranges;
}

/**
 * Check if any codepoint in the set falls within any of the unicode ranges.
 */
function unicodeRangeIntersects(
  ranges: Array<[number, number]>,
  codepoints: Set<number>,
): boolean {
  for (const cp of codepoints) {
    for (const [start, end] of ranges) {
      if (cp >= start && cp <= end) return true;
    }
  }
  return false;
}

/**
 * Decide whether to keep a @font-face block based on unicode-range.
 * Returns true (keep) if there's no unicode-range or if it overlaps with used codepoints.
 */
function shouldKeepFontFaceBlock(block: string, codepoints?: Set<number>): boolean {
  if (!codepoints) return true;
  const rangeMatch = block.match(UNICODE_RANGE_RE);
  if (!rangeMatch) return true;
  const ranges = parseUnicodeRange(rangeMatch[1]);
  if (ranges.length === 0) return true;
  return unicodeRangeIntersects(ranges, codepoints);
}

/**
 * Extract deduplicated external font URLs from @font-face blocks,
 * skipping blocks filtered out by unicode-range.
 */
function extractFontUrls(css: string, codepoints?: Set<number>): string[] {
  const urls = new Set<string>();

  for (const block of css.matchAll(FONT_FACE_RE)) {
    if (!shouldKeepFontFaceBlock(block[0], codepoints)) continue;
    for (const match of block[0].matchAll(URL_RE)) {
      const url = match[2];
      if (url && !url.startsWith('data:')) {
        urls.add(url);
      }
    }
  }

  return Array.from(urls);
}

// ── Font fetching ───────────────────────────────────────────────────────────

/**
 * Fetch a single font URL and return it as a base64 data URI.
 * On failure, returns the original URL unchanged (graceful degradation).
 */
async function fetchFontAsDataUri(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return url;
    }

    const mime = response.headers.get('Content-Type') || 'font/woff2';
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return `data:${mime};base64,${base64}`;
  } catch {
    return url;
  }
}

/**
 * Get or create a cached promise for the given font URL.
 * Deduplicates concurrent requests for the same URL.
 */
function getCachedDataUri(url: string): Promise<string> {
  let cached = fontCache.get(url);
  if (!cached) {
    cached = fetchFontAsDataUri(url);
    fontCache.set(url, cached);
  }
  return cached;
}

// ── CSS cache ───────────────────────────────────────────────────────────────
//
// The CSS cache key must be cheap to compute because CSS can be very large
// (e.g. 43MB when fonts are already base64-encoded in the CSS). Hashing the
// entire string would take ~200ms for 43MB. Instead we use a fingerprint:
// length + 100 chars from start + 100 from middle + 100 from end.
//
// Collision risk: two CSS strings would need the same length AND the same
// content at start, middle, and end. In practice this doesn't happen with
// real font CSS because the base64 payload differs throughout.

function buildCacheKey(css: string, codepoints?: Set<number>): string {
  const len = css.length;
  const head = css.slice(0, 100);
  const mid = len > 200 ? css.slice((len >> 1) - 50, (len >> 1) + 50) : '';
  const tail = len > 100 ? css.slice(-100) : '';
  let key = `${len}|${head}|${mid}|${tail}`;
  if (codepoints && codepoints.size > 0) {
    // Hash codepoints with djb2 to keep the key small
    let cpHash = 5381;
    const sorted = [...codepoints].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      cpHash = ((cpHash << 5) + cpHash + sorted[i]) | 0;
    }
    key += '\0' + (cpHash >>> 0);
  }
  return key;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Replace all external font URLs in CSS @font-face rules with base64 data URIs.
 * When codepoints are provided, @font-face blocks whose unicode-range doesn't
 * intersect with any used codepoint are removed entirely (not fetched or inlined).
 */
export function inlineFontsInCss(css: string, codepoints?: Set<number>): Promise<string> {
  const key = buildCacheKey(css, codepoints);
  const cached = cssCache.get(key);
  if (cached) return cached;

  const promise = inlineFontsInCssUncached(css, codepoints);
  cssCache.set(key, promise);
  return promise;
}

async function inlineFontsInCssUncached(css: string, codepoints?: Set<number>): Promise<string> {
  const urls = extractFontUrls(css, codepoints);
  if (urls.length === 0 && !codepoints) return css;

  // Kick off all fetches in parallel
  const entries = await Promise.all(
    urls.map(async (url) => [url, await getCachedDataUri(url)] as const),
  );
  const urlToDataUri = new Map(entries);

  // Replace each @font-face block: inline kept blocks, remove skipped ones
  return css.replace(FONT_FACE_RE, (block) => {
    if (!shouldKeepFontFaceBlock(block, codepoints)) {
      return '';
    }
    return block.replace(URL_RE, (original, _quote: string, url: string) => {
      if (!url || url.startsWith('data:')) {
        return original;
      }
      const dataUri = urlToDataUri.get(url);
      return dataUri ? `url("${dataUri}")` : original;
    });
  });
}

// ── Font-weight normalization ────────────────────────────────────────────────
//
// Browsers do NOT apply font synthesis (faux bold/italic) inside SVG
// <foreignObject>. When an @font-face declares font-weight: 100 but the
// element requests font-weight: normal (400), regular DOM synthesizes the
// missing weight automatically while foreignObject renders at the native
// (thin) weight — causing a visible mismatch.
//
// Fix: for font families that ship only a single weight, expand the
// font-weight descriptor to `1 999` so the browser uses the font file
// directly for any requested weight. No synthesis needed → consistent
// rendering in both DOM and foreignObject.

const FAMILY_RE = /font-family:\s*(['"]?)([^'";]+)\1/i;
const WEIGHT_RE = /font-weight:\s*([^;}]+)/i;

/**
 * Expand font-weight to `1 999` for font families that have only one weight.
 * This eliminates the need for font synthesis, which doesn't work in foreignObject.
 */
export function normalizeFontWeights(css: string): string {
  // Collect distinct font-weight values per family
  const weightsByFamily = new Map<string, Set<string>>();
  for (const match of css.matchAll(FONT_FACE_RE)) {
    const block = match[0];
    const familyMatch = block.match(FAMILY_RE);
    if (!familyMatch) continue;
    const family = familyMatch[2].trim().toLowerCase();
    const weightMatch = block.match(WEIGHT_RE);
    const weight = weightMatch ? weightMatch[1].trim() : 'normal';

    if (!weightsByFamily.has(family)) weightsByFamily.set(family, new Set());
    weightsByFamily.get(family)!.add(weight);
  }

  // Find families with a single weight value
  const expandFamilies = new Set<string>();
  for (const [family, weights] of weightsByFamily) {
    if (weights.size === 1) expandFamilies.add(family);
  }

  if (expandFamilies.size === 0) return css;

  return css.replace(FONT_FACE_RE, (block) => {
    const familyMatch = block.match(FAMILY_RE);
    if (!familyMatch) return block;
    const family = familyMatch[2].trim().toLowerCase();
    if (!expandFamilies.has(family)) return block;

    const weightMatch = block.match(WEIGHT_RE);
    if (weightMatch) {
      // Already a range (e.g. "100 900")? Leave it alone.
      if (weightMatch[1].trim().includes(' ')) return block;
      return block.replace(WEIGHT_RE, 'font-weight: 1 999');
    }
    // No font-weight — default is 'normal'. Expand it.
    return block.replace('}', 'font-weight: 1 999; }');
  });
}

/**
 * Pre-fetch and cache font URLs from CSS.
 */
export async function prefetchFonts(css: string): Promise<void> {
  const urls = extractFontUrls(css);
  await Promise.all(urls.map((url) => getCachedDataUri(url)));
}

/**
 * Clear all font caches (URL→base64 and CSS→inlined result).
 */
export function clearFontCache(): void {
  fontCache.clear();
  cssCache.clear();
}
