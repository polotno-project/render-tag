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

/** Normalize paint-only differences while preserving exact line membership. */
export function normalizeLineText(text: string): string {
  let normalized = text.replace(/\s+/g, '');
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
