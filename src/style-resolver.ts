import type { ResolvedStyle, StyledNode } from './types.ts';

let containerId = 0;

function parsePixels(value: string): number {
  if (!value || value === 'normal' || value === 'auto' || value === 'none') return 0;
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

function parseFontWeight(value: string): number {
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num;
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  return 400;
}

/**
 * Resolve line-height to a pixel value.
 * "normal" is resolved using font metrics via a canvas context.
 */
function resolveLineHeight(cs: CSSStyleDeclaration, fontSize: number): number {
  const raw = cs.lineHeight;
  if (raw && raw !== 'normal') {
    const px = parseFloat(raw);
    if (!isNaN(px)) return px;
  }
  // "normal" — approximate as fontSize * 1.2 (will be refined in layout with actual font metrics)
  return 0; // 0 signals "normal" — layout will compute from font metrics
}

function extractStyle(cs: CSSStyleDeclaration): ResolvedStyle {
  const fontSize = parsePixels(cs.fontSize);
  return {
    fontFamily: cs.fontFamily,
    fontSize,
    fontWeight: parseFontWeight(cs.fontWeight),
    fontStyle: cs.fontStyle || 'normal',
    color: cs.color,
    textAlign: cs.textAlign || 'left',
    textTransform: cs.textTransform || 'none',
    textDecorationLine: cs.textDecorationLine || 'none',
    textDecorationStyle: cs.textDecorationStyle || 'solid',
    textDecorationColor: cs.textDecorationColor || cs.color,
    textShadow: cs.textShadow || 'none',
    webkitTextStrokeWidth: parsePixels((cs as any).webkitTextStrokeWidth),
    webkitTextStrokeColor: (cs as any).webkitTextStrokeColor || '',
    webkitTextFillColor: (cs as any).webkitTextFillColor || '',
    webkitBackgroundClip: (cs as any).webkitBackgroundClip || cs.backgroundClip || '',
    backgroundImage: cs.backgroundImage || 'none',
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : parsePixels(cs.letterSpacing),
    lineHeight: resolveLineHeight(cs, fontSize),
    verticalAlign: cs.verticalAlign || 'baseline',
    whiteSpace: cs.whiteSpace || 'normal',
    wordBreak: cs.wordBreak || 'normal',
    overflowWrap: cs.overflowWrap || 'normal',
    direction: cs.direction || 'ltr',

    display: cs.display || 'block',
    width: parsePixels(cs.width),
    paddingTop: parsePixels(cs.paddingTop),
    paddingRight: parsePixels(cs.paddingRight),
    paddingBottom: parsePixels(cs.paddingBottom),
    paddingLeft: parsePixels(cs.paddingLeft),
    marginTop: parsePixels(cs.marginTop),
    marginRight: parsePixels(cs.marginRight),
    marginBottom: parsePixels(cs.marginBottom),
    marginLeft: parsePixels(cs.marginLeft),
    backgroundColor: cs.backgroundColor,

    borderTopWidth: parsePixels(cs.borderTopWidth),
    borderTopColor: cs.borderTopColor,
    borderTopStyle: cs.borderTopStyle || 'none',
    borderRightWidth: parsePixels(cs.borderRightWidth),
    borderRightColor: cs.borderRightColor,
    borderRightStyle: cs.borderRightStyle || 'none',
    borderBottomWidth: parsePixels(cs.borderBottomWidth),
    borderBottomColor: cs.borderBottomColor,
    borderBottomStyle: cs.borderBottomStyle || 'none',
    borderLeftWidth: parsePixels(cs.borderLeftWidth),
    borderLeftColor: cs.borderLeftColor,
    borderLeftStyle: cs.borderLeftStyle || 'none',

    flexDirection: cs.flexDirection || 'row',
    gap: parsePixels(cs.gap),
    flexGrow: parseFloat(cs.flexGrow) || 0,
    flexShrink: parseFloat(cs.flexShrink) || 1,

    listStyleType: cs.listStyleType || 'disc',
    listStylePosition: cs.listStylePosition || 'outside',
  };
}

/**
 * Detect list marker text for a <li> element.
 */
function getListMarker(el: Element, _cs: CSSStyleDeclaration): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'li') return undefined;

  const beforeStyle = window.getComputedStyle(el, '::before');
  const content = beforeStyle.content;

  if (content && content !== 'none' && content !== 'normal') {
    // Skip counter() functions — browser doesn't resolve them in getComputedStyle
    if (!content.includes('counter(')) {
      // Clean up quotes and string delimiters
      const cleaned = content.replace(/^["']|["']$/g, '');
      if (cleaned) return cleaned;
    }
  }

  // Determine marker from parent list type
  const parent = el.parentElement;
  if (!parent) return '•';

  const parentTag = parent.tagName.toLowerCase();
  if (parentTag === 'ol') {
    // Count preceding <li> siblings to get the index
    let index = 0;
    for (const child of parent.children) {
      if (child.tagName.toLowerCase() === 'li') {
        index++;
        if (child === el) break;
      }
    }
    return `${index}.`;
  }

  if (parentTag === 'ul') {
    return '•';
  }

  return undefined;
}

/**
 * Rewrite CSS so that `body` and `html` selectors target our container instead.
 */
function scopeCSS(css: string, containerId: string): string {
  const selector = `#${containerId}`;
  return css.replace(
    /(^|[},;\s])(\s*)(html|body)\b/gm,
    (match, before, space, _tag) => `${before}${space}${selector}`,
  );
}

/**
 * Insert HTML into a hidden offscreen container, walk the DOM tree,
 * and extract computed styles for every element. No measurements — only CSS values.
 */
export async function resolveStyles(
  fragment: DocumentFragment,
  css: string,
  width: number,
  height?: number,
): { tree: StyledNode; cleanup: () => void } {
  const id = `__html_canvas_${containerId++}__`;

  const container = document.createElement('div');
  container.id = id;
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '-99999px';
  container.style.visibility = 'hidden';
  container.style.width = `${width}px`;
  container.style.margin = '0';
  container.style.padding = '0';

  if (css) {
    const styleEl = document.createElement('style');
    styleEl.textContent = scopeCSS(css, id);
    container.appendChild(styleEl);
  }

  container.appendChild(fragment);
  document.body.appendChild(container);

  await document.fonts.ready;

  function walkNode(node: Node): StyledNode | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!text || text.trim() === '') return null;

      const parent = node.parentElement;
      if (!parent) return null;

      const parentCS = window.getComputedStyle(parent);

      return {
        element: null,
        tagName: '#text',
        style: extractStyle(parentCS),
        children: [],
        textContent: text,
      };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return null;

    const cs = window.getComputedStyle(el);
    const style = extractStyle(cs);
    const marker = getListMarker(el, cs);

    const children: StyledNode[] = [];
    for (const child of el.childNodes) {
      const childNode = walkNode(child);
      if (childNode) {
        children.push(childNode);
      }
    }

    return {
      element: el,
      tagName: tag,
      style,
      children,
      textContent: null,
      listMarker: marker,
    };
  }

  const tree = walkNode(container)!;

  const cleanup = () => {
    container.remove();
  };

  return { tree, cleanup };
}
