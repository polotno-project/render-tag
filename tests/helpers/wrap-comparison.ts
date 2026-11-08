export interface ComparableLine {
  y: number;
  text: string;
}

export interface LayoutComparisonResult {
  wrappingMatch: boolean;
  canvasLineCount: number;
  domLineCount: number;
  differentLines: { lineIndex: number; canvas: string; dom: string }[];
}

const ROMAN = 'M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})';
const LETTER_MARKER = `(?:[a-zA-Z]|(?=[MDCLXVI])${ROMAN}|(?=[mdclxvi])${ROMAN.toLowerCase()})\\.`;
/**
 * An alphabetic or roman list marker at a line's start (or end: an RTL item's
 * marker sits at its right). Alphabetic ones only as single letters: two-letter
 * words end sentences.
 */
const EDGE_MARKER = new RegExp(`^\\s*${LETTER_MARKER}(?:\\s+|$)|\\s+${LETTER_MARKER}\\s*$`);

/**
 * Normalize paint-only differences while preserving exact line membership.
 * render-tag's lines carry list-marker text; DOM ranges never report `::marker`.
 */
export function normalizeLineText(text: string): string {
  let normalized = text.replace(EDGE_MARKER, '').replace(/\s+/g, '');
  normalized = normalized.replace(/[•○■▪▸▹◦]/g, '');
  normalized = normalized.replace(/(?:^|\b)(\d+)\./g, '');
  // DOM ranges report visual order while LayoutLine stores logical order.
  // Sorting code points makes that distinction irrelevant without allowing a
  // glyph to cross a line boundary.
  return [...normalized].sort().join('');
}

export function compareLineMembership(
  rawCanvasLines: ComparableLine[],
  rawDomLines: ComparableLine[],
): LayoutComparisonResult {
  const canvasLines = rawCanvasLines.filter(
    (line) => normalizeLineText(line.text).length > 0,
  );
  const domLines = rawDomLines.filter(
    (line) => normalizeLineText(line.text).length > 0,
  );
  const differentLines: LayoutComparisonResult['differentLines'] = [];
  const lineCount = Math.max(canvasLines.length, domLines.length);

  for (let index = 0; index < lineCount; index++) {
    const canvas = canvasLines[index]?.text || '';
    const dom = domLines[index]?.text || '';
    if (normalizeLineText(canvas) !== normalizeLineText(dom)) {
      differentLines.push({ lineIndex: index, canvas, dom });
    }
  }

  return {
    wrappingMatch:
      canvasLines.length === domLines.length && differentLines.length === 0,
    canvasLineCount: canvasLines.length,
    domLineCount: domLines.length,
    differentLines,
  };
}
