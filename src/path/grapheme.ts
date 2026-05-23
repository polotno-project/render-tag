/**
 * Split a string into user-perceived characters (grapheme clusters).
 * Uses Intl.Segmenter when available (handles ZWJ emoji sequences, regional
 * indicators, combining marks). Falls back to a surrogate-pair-aware split
 * for older environments.
 *
 * Equivalent in spirit to konva's stringToArray helper.
 */
let _segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter !== undefined) return _segmenter;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      _segmenter = null;
    }
  } else {
    _segmenter = null;
  }
  return _segmenter;
}

export function stringToArray(s: string): string[] {
  if (!s) return [];
  const seg = getSegmenter();
  if (seg) {
    const out: string[] = [];
    for (const piece of seg.segment(s)) out.push(piece.segment);
    return out;
  }
  // Fallback: handle UTF-16 surrogate pairs but not full grapheme clusters.
  return Array.from(s);
}
