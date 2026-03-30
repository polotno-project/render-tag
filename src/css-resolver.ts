import type { ResolvedStyle, StyledNode } from './types.js';

// ─── CSS Parser ──────────────────────────────────────────────────────

interface CSSDeclaration {
  property: string;
  value: string;
}

interface CSSRule {
  selectors: string[];
  declarations: CSSDeclaration[];
}

/**
 * Parse a simple CSS string into rules.
 * Supports: tag, .class, parent > child, comma-separated selectors.
 * Extracts @font-face rules separately for injection into the document.
 */
function parseCSS(css: string): { rules: CSSRule[]; fontFaceRules: string[] } {
  const rules: CSSRule[] = [];
  const fontFaceRules: string[] = [];
  // Remove comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');

  let i = 0;
  while (i < css.length) {
    // Skip whitespace
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;

    // Handle at-rules (@font-face, @media, etc.)
    if (css[i] === '@') {
      const atStart = i;
      let braceDepth = 0;
      while (i < css.length) {
        if (css[i] === '{') braceDepth++;
        if (css[i] === '}') {
          braceDepth--;
          if (braceDepth <= 0) { i++; break; }
        }
        i++;
      }
      // Capture @font-face rules for injection
      const atRule = css.slice(atStart, i);
      if (atRule.startsWith('@font-face')) {
        fontFaceRules.push(atRule);
      }
      continue;
    }

    // Read selector(s) up to '{'
    const selectorStart = i;
    while (i < css.length && css[i] !== '{') i++;
    if (i >= css.length) break;
    const selectorStr = css.slice(selectorStart, i).trim();
    i++; // skip '{'

    // Read declarations up to '}'
    const declStart = i;
    while (i < css.length && css[i] !== '}') i++;
    const declStr = css.slice(declStart, i).trim();
    i++; // skip '}'

    if (!selectorStr) continue;

    // Parse selectors (comma-separated)
    const selectors = selectorStr.split(',').map(s => s.trim()).filter(Boolean);

    // Parse declarations
    const declarations: CSSDeclaration[] = [];
    for (const decl of declStr.split(';')) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) continue;
      const property = decl.slice(0, colonIdx).trim().toLowerCase();
      const value = decl.slice(colonIdx + 1).trim();
      if (property && value) {
        declarations.push({ property, value });
      }
    }

    if (selectors.length > 0 && declarations.length > 0) {
      rules.push({ selectors, declarations });
    }
  }

  return { rules, fontFaceRules };
}

// ─── Selector Matching ───────────────────────────────────────────────

interface ElementContext {
  tagName: string;
  classes: Set<string>;
  parent: ElementContext | null;
  el: Element;
}

/**
 * Compute specificity for a simple selector.
 * Returns [ids, classes, tags] tuple.
 */
function selectorSpecificity(selector: string): [number, number, number] {
  // Remove pseudo-elements for specificity calculation
  const sel = selector.replace(/::[\w-]+/g, '');
  const parts = sel.split(/\s*>\s*|\s+/);
  let ids = 0, classes = 0, tags = 0;
  for (const part of parts) {
    // Count #id
    const idMatches = part.match(/#[\w-]+/g);
    if (idMatches) ids += idMatches.length;
    // Count .class
    const classMatches = part.match(/\.[\w-]+/g);
    if (classMatches) classes += classMatches.length;
    // Count tag (strip classes/ids/pseudo)
    const tagPart = part.replace(/[#.][\w-]+/g, '').replace(/:[\w-]+/g, '').trim();
    if (tagPart && tagPart !== '*') tags++;
  }
  return [ids, classes, tags];
}

/**
 * Check if a simple selector part matches an element context.
 * Supports: tag, .class, tag.class
 */
function matchesPart(part: string, ctx: ElementContext): boolean {
  // Split into tag and classes: "ul.foo.bar" → tag="ul", classes=[".foo", ".bar"]
  const classMatches = part.match(/\.[\w-]+/g) || [];
  const tag = part.replace(/\.[\w-]+/g, '').replace(/:[\w-]+/g, '').trim();

  if (tag && tag !== '*' && tag !== ctx.tagName) return false;
  for (const cls of classMatches) {
    if (!ctx.classes.has(cls.slice(1))) return false;
  }
  return true;
}

/**
 * Check if a full selector matches an element.
 * Supports descendant (space) and child (>) combinators.
 * Skips selectors with pseudo-elements (::before, ::after).
 */
function matchesSelector(selector: string, ctx: ElementContext): boolean {
  // Skip pseudo-element selectors — we handle list markers separately
  if (selector.includes('::')) return false;

  // Skip pseudo-class selectors that we can't evaluate statically
  // (:nth-child, :hover, :focus, etc.)
  if (/:(?:nth-|hover|focus|active|visited|first-child|last-child)/.test(selector)) return false;

  // Split by child combinator first, then by descendant
  const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean);
  // Detect which are child combinators vs descendant
  const combinators: ('>' | ' ')[] = [];
  {
    const tokens = selector.trim().split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '>') {
        combinators.push('>');
        i++; // skip the next token (already in parts)
      } else if (tokens[i - 1] === '>') {
        // already handled
      } else {
        combinators.push(' ');
      }
    }
  }

  // Re-tokenize properly
  return matchesSelectorTokenized(selector, ctx);
}

/**
 * Check if a part matches, treating 'html' and 'body' as matching the root container.
 */
function matchesPartOrRoot(part: string, ctx: ElementContext, isRoot: boolean): boolean {
  const tag = part.replace(/\.[\w-]+/g, '').replace(/:[\w-]+/g, '').trim();
  if ((tag === 'html' || tag === 'body') && isRoot) return true;
  return matchesPart(part, ctx);
}

/**
 * Properly tokenize and match a selector against an element context.
 */
function matchesSelectorTokenized(selector: string, ctx: ElementContext): boolean {
  // Tokenize: split into parts and combinators
  const tokens: string[] = [];
  const combinators: string[] = [];

  const raw = selector.trim().split(/\s+/);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '>') {
      combinators.push('>');
    } else {
      if (tokens.length > combinators.length + 1) {
        // implicit descendant combinator
        combinators.push(' ');
      }
      tokens.push(raw[i]);
    }
  }

  // Ensure combinators length = tokens.length - 1
  while (combinators.length < tokens.length - 1) {
    combinators.push(' ');
  }

  // Match right-to-left
  let current: ElementContext | null = ctx;
  for (let ti = tokens.length - 1; ti >= 0; ti--) {
    if (!current) return false;

    const isRoot = current.parent === null;

    if (ti === tokens.length - 1) {
      // Rightmost part must match current element
      if (!matchesPartOrRoot(tokens[ti], current, isRoot)) return false;
      current = current.parent;
    } else {
      const combinator = combinators[ti]; // combinator between tokens[ti] and tokens[ti+1]
      if (combinator === '>') {
        // Direct child: parent must match
        if (!current || !matchesPartOrRoot(tokens[ti], current, current.parent === null)) return false;
        current = current.parent;
      } else {
        // Descendant: any ancestor must match
        let found = false;
        while (current) {
          if (matchesPartOrRoot(tokens[ti], current, current.parent === null)) {
            current = current.parent;
            found = true;
            break;
          }
          current = current.parent;
        }
        if (!found) return false;
      }
    }
  }

  return true;
}

// ─── Style Resolution ────────────────────────────────────────────────

/** Properties that inherit from parent to child */
const INHERITED_PROPERTIES = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style',
  'color', 'text-align', 'text-transform',
  'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'letter-spacing', 'word-spacing', 'font-kerning',
  'line-height', 'white-space', 'word-break', 'overflow-wrap',
  'direction', 'text-shadow', 'list-style-type',
  'vertical-align',
]);

/** Default values for all ResolvedStyle properties */
function defaultStyle(): ResolvedStyle {
  return {
    fontFamily: 'sans-serif',
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    color: 'rgb(0, 0, 0)',
    textAlign: 'start',
    textTransform: 'none',
    textDecorationLine: 'none',
    textDecorationStyle: 'solid',
    textDecorationColor: 'rgb(0, 0, 0)',
    textShadow: 'none',
    webkitTextStrokeWidth: 0,
    webkitTextStrokeColor: '',
    webkitTextFillColor: '',
    webkitBackgroundClip: '',
    backgroundImage: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    fontKerning: 'auto',
    lineHeight: 0,
    verticalAlign: 'baseline',
    whiteSpace: 'normal',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    direction: 'ltr',
    display: 'block',
    width: 0,
    minHeight: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: 0,
    borderTopColor: 'rgb(0, 0, 0)',
    borderTopStyle: 'none',
    borderRightWidth: 0,
    borderRightColor: 'rgb(0, 0, 0)',
    borderRightStyle: 'none',
    borderBottomWidth: 0,
    borderBottomColor: 'rgb(0, 0, 0)',
    borderBottomStyle: 'none',
    borderLeftWidth: 0,
    borderLeftColor: 'rgb(0, 0, 0)',
    borderLeftStyle: 'none',
    flexDirection: 'row',
    gap: 0,
    flexGrow: 0,
    listStyleType: 'disc',
  };
}

/** Tag-level default display values and browser default margins */
const TAG_DEFAULTS: Record<string, Partial<ResolvedStyle>> = {
  span: { display: 'inline' },
  a: { display: 'inline' },
  strong: { display: 'inline', fontWeight: 700 },
  b: { display: 'inline', fontWeight: 700 },
  em: { display: 'inline', fontStyle: 'italic' },
  i: { display: 'inline', fontStyle: 'italic' },
  u: { display: 'inline', textDecorationLine: 'underline' },
  s: { display: 'inline', textDecorationLine: 'line-through' },
  strike: { display: 'inline', textDecorationLine: 'line-through' },
  del: { display: 'inline', textDecorationLine: 'line-through' },
  sub: { display: 'inline', verticalAlign: 'sub', fontSize: 0.83 },
  sup: { display: 'inline', verticalAlign: 'super', fontSize: 0.83 },
  code: { display: 'inline', fontFamily: 'monospace' },
  cite: { display: 'inline', fontStyle: 'italic' },
  p: { display: 'block', marginTop: -1, marginBottom: -1 }, // -1 = 1em, resolved later
  div: { display: 'block' },
  h1: { display: 'block', fontSize: 2, fontWeight: 700, marginTop: -0.67, marginBottom: -0.67 },
  h2: { display: 'block', fontSize: 1.5, fontWeight: 700, marginTop: -0.83, marginBottom: -0.83 },
  h3: { display: 'block', fontSize: 1.17, fontWeight: 700, marginTop: -1, marginBottom: -1 },
  h4: { display: 'block', fontSize: 1, fontWeight: 700, marginTop: -1.33, marginBottom: -1.33 },
  h5: { display: 'block', fontSize: 0.83, fontWeight: 700, marginTop: -1.67, marginBottom: -1.67 },
  h6: { display: 'block', fontSize: 0.67, fontWeight: 700, marginTop: -2.33, marginBottom: -2.33 },
  ul: { display: 'block', listStyleType: 'disc', marginTop: -1, marginBottom: -1 },
  ol: { display: 'block', listStyleType: 'decimal', marginTop: -1, marginBottom: -1 },
  li: { display: 'list-item' },
  blockquote: { display: 'block', marginTop: -1, marginBottom: -1, marginLeft: 40, marginRight: 40 },
  pre: { display: 'block', whiteSpace: 'pre', fontFamily: 'monospace', marginTop: -1, marginBottom: -1 },
  table: { display: 'table' },
  tr: { display: 'table-row' },
  td: { display: 'table-cell' },
  th: { display: 'table-cell', fontWeight: 700 },
  br: { display: 'inline' },
};

/**
 * Parse a CSS value to pixels given a parent font size for em/% resolution.
 */
function parseValue(value: string, parentFontSize: number, containerWidth: number): number {
  if (!value || value === 'normal' || value === 'auto' || value === 'none') return 0;
  const trimmed = value.trim();

  if (trimmed.endsWith('em')) {
    const num = parseFloat(trimmed);
    return isNaN(num) ? 0 : num * parentFontSize;
  }
  if (trimmed.endsWith('%')) {
    const num = parseFloat(trimmed);
    return isNaN(num) ? 0 : (num / 100) * containerWidth;
  }
  if (trimmed.endsWith('px')) {
    const num = parseFloat(trimmed);
    return isNaN(num) ? 0 : num;
  }
  // Bare number (for line-height, etc.)
  const num = parseFloat(trimmed);
  return isNaN(num) ? 0 : num;
}

function parseFontWeight(value: string): number {
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  const num = parseInt(value, 10);
  return isNaN(num) ? 400 : num;
}

/**
 * Expand shorthand properties into individual ones.
 * E.g., margin: 10px 20px → marginTop/Right/Bottom/Left
 */
function expandShorthand(property: string, value: string): CSSDeclaration[] {
  if (property === 'margin' || property === 'padding') {
    const parts = value.trim().split(/\s+/);
    let top: string, right: string, bottom: string, left: string;
    if (parts.length === 1) {
      top = right = bottom = left = parts[0];
    } else if (parts.length === 2) {
      top = bottom = parts[0];
      right = left = parts[1];
    } else if (parts.length === 3) {
      top = parts[0]; right = left = parts[1]; bottom = parts[2];
    } else {
      top = parts[0]; right = parts[1]; bottom = parts[2]; left = parts[3];
    }
    return [
      { property: `${property}-top`, value: top },
      { property: `${property}-right`, value: right },
      { property: `${property}-bottom`, value: bottom },
      { property: `${property}-left`, value: left },
    ];
  }

  if (property === 'border' || property === 'border-top' || property === 'border-right' ||
      property === 'border-bottom' || property === 'border-left') {
    const parts = value.trim().split(/\s+/);
    const borderStyles = ['solid', 'dashed', 'dotted', 'double', 'none', 'hidden'];
    const width = parts.find(p => p.endsWith('px') || /^\d/.test(p)) || '0';
    const style = parts.find(p => borderStyles.includes(p)) || 'none';
    const color = parts.find(p => !p.endsWith('px') && !/^\d/.test(p) && !borderStyles.includes(p)) || 'currentColor';
    const result: CSSDeclaration[] = [];
    const sides = property === 'border'
      ? ['top', 'right', 'bottom', 'left']
      : [property.replace('border-', '')];
    for (const side of sides) {
      result.push({ property: `border-${side}-width`, value: width });
      result.push({ property: `border-${side}-style`, value: style });
      result.push({ property: `border-${side}-color`, value: color });
    }
    return result;
  }

  if (property === 'list-style') {
    // list-style: none → list-style-type: none
    if (value === 'none') {
      return [{ property: 'list-style-type', value: 'none' }];
    }
    return [{ property: 'list-style-type', value }];
  }

  if (property === 'text-decoration') {
    const v = value.trim();
    if (v === 'inherit' || v === 'none') {
      return [{ property: 'text-decoration-line', value: 'none' }];
    }
    const parts = v.split(/\s+/);
    const lineValues = ['underline', 'overline', 'line-through'];
    const styleValues = ['solid', 'double', 'dotted', 'dashed', 'wavy'];
    const result: CSSDeclaration[] = [];
    const lines: string[] = [];
    for (const p of parts) {
      if (lineValues.includes(p)) lines.push(p);
      else if (styleValues.includes(p)) result.push({ property: 'text-decoration-style', value: p });
      else if (p.startsWith('#') || p.startsWith('rgb') || p.startsWith('hsl'))
        result.push({ property: 'text-decoration-color', value: p });
    }
    if (lines.length > 0) result.unshift({ property: 'text-decoration-line', value: lines.join(' ') });
    return result;
  }

  if (property === '-webkit-text-stroke') {
    // -webkit-text-stroke: 1px #1e40af → width + color
    const parts = value.trim().split(/\s+/);
    const width = parts.find(p => p.endsWith('px') || /^\d/.test(p)) || '0';
    const color = parts.find(p => !p.endsWith('px') && !/^\d/.test(p)) || 'currentColor';
    return [
      { property: '-webkit-text-stroke-width', value: width },
      { property: '-webkit-text-stroke-color', value: color },
    ];
  }

  if (property === 'flex') {
    // flex: 1 → flex-grow: 1
    const parts = value.trim().split(/\s+/);
    const grow = parseFloat(parts[0]);
    if (!isNaN(grow)) {
      return [{ property: 'flex-grow', value: String(grow) }];
    }
    return [];
  }

  if (property === 'border-collapse' || property === 'border-spacing') {
    // Ignored — table-specific properties we don't handle
    return [];
  }

  return [{ property, value }];
}

/**
 * Apply a CSS declaration to a ResolvedStyle, resolving units.
 */
function applyDeclaration(
  style: ResolvedStyle,
  property: string,
  value: string,
  parentFontSize: number,
  containerWidth: number,
  direction: string,
): void {
  // Resolve the font-size first if that's what we're setting, since
  // em values for other properties depend on the element's own font-size
  const fontSize = style.fontSize || parentFontSize;

  switch (property) {
    // Font & text
    case 'font-family': style.fontFamily = value.trim(); break;
    case 'font-size': {
      const v = value.trim();
      if (v.endsWith('em')) {
        style.fontSize = parseFloat(v) * parentFontSize;
      } else if (v.endsWith('%')) {
        style.fontSize = (parseFloat(v) / 100) * parentFontSize;
      } else {
        style.fontSize = parseFloat(v) || parentFontSize;
      }
      break;
    }
    case 'font-weight': style.fontWeight = parseFontWeight(value); break;
    case 'font-style': style.fontStyle = value.trim(); break;
    case 'color': style.color = value.trim(); break;
    case 'text-align': style.textAlign = value.trim(); break;
    case 'text-transform': style.textTransform = value.trim(); break;
    case 'text-decoration-line': style.textDecorationLine = value.trim(); break;
    // text-decoration is expanded in expandShorthand, should not reach here
    // but handle just in case
    case 'text-decoration': break;
    case 'text-decoration-style': style.textDecorationStyle = value.trim(); break;
    case 'text-decoration-color': style.textDecorationColor = value.trim(); break;
    case 'text-shadow': style.textShadow = value.trim(); break;
    case '-webkit-text-stroke-width': style.webkitTextStrokeWidth = parseValue(value, fontSize, containerWidth); break;
    case '-webkit-text-stroke-color': style.webkitTextStrokeColor = value.trim(); break;
    case '-webkit-text-fill-color': style.webkitTextFillColor = value.trim(); break;
    case '-webkit-background-clip':
    case 'background-clip': style.webkitBackgroundClip = value.trim(); break;
    case 'background-image': style.backgroundImage = value.trim(); break;
    case 'letter-spacing':
      style.letterSpacing = value.trim() === 'normal' ? 0 : parseValue(value, fontSize, containerWidth); break;
    case 'word-spacing':
      style.wordSpacing = value.trim() === 'normal' ? 0 : parseValue(value, fontSize, containerWidth); break;
    case 'font-kerning': style.fontKerning = value.trim(); break;
    case 'line-height': {
      const v = value.trim();
      if (v === 'normal') {
        style.lineHeight = 0; // 0 signals "normal"
      } else if (v.endsWith('px')) {
        style.lineHeight = parseFloat(v) || 0;
      } else if (v.endsWith('em')) {
        style.lineHeight = parseFloat(v) * fontSize;
      } else {
        // Unitless multiplier — compute for this element's font size
        // and mark as unitless so children re-compute
        const num = parseFloat(v);
        if (!isNaN(num)) {
          style.lineHeight = num * fontSize;
          (style as any)._lineHeightMultiplier = num;
        }
      }
      break;
    }
    case 'vertical-align': style.verticalAlign = value.trim(); break;
    case 'white-space': style.whiteSpace = value.trim(); break;
    case 'word-break': style.wordBreak = value.trim(); break;
    case 'overflow-wrap':
    case 'word-wrap': style.overflowWrap = value.trim(); break;
    case 'direction': style.direction = value.trim(); break;

    // Box model
    case 'display': style.display = value.trim(); break;
    case 'width': {
      const v = value.trim();
      if (v === '100%') style.width = containerWidth;
      else if (v !== 'auto') style.width = parseValue(v, fontSize, containerWidth);
      break;
    }
    case 'min-height': style.minHeight = parseValue(value, fontSize, containerWidth); break;
    case 'padding-top': style.paddingTop = parseValue(value, fontSize, containerWidth); break;
    case 'padding-right': style.paddingRight = parseValue(value, fontSize, containerWidth); break;
    case 'padding-bottom': style.paddingBottom = parseValue(value, fontSize, containerWidth); break;
    case 'padding-left': style.paddingLeft = parseValue(value, fontSize, containerWidth); break;
    case 'margin-top': style.marginTop = parseValue(value, fontSize, containerWidth); break;
    case 'margin-right': style.marginRight = parseValue(value, fontSize, containerWidth); break;
    case 'margin-bottom': style.marginBottom = parseValue(value, fontSize, containerWidth); break;
    case 'margin-left': style.marginLeft = parseValue(value, fontSize, containerWidth); break;
    case 'background-color': style.backgroundColor = value.trim(); break;
    case 'background': {
      const v = value.trim();
      if (v.includes('gradient(')) {
        // background: linear-gradient(...) → backgroundImage
        style.backgroundImage = v;
      } else if (v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl') ||
          ['transparent', 'none', 'inherit'].includes(v) ||
          /^[a-z]+$/.test(v)) {
        style.backgroundColor = v;
      }
      break;
    }

    // Logical properties → physical (based on direction)
    case 'padding-inline-start':
      if (direction === 'rtl') style.paddingRight = parseValue(value, fontSize, containerWidth);
      else style.paddingLeft = parseValue(value, fontSize, containerWidth);
      break;
    case 'padding-inline-end':
      if (direction === 'rtl') style.paddingLeft = parseValue(value, fontSize, containerWidth);
      else style.paddingRight = parseValue(value, fontSize, containerWidth);
      break;
    case 'margin-inline-start':
      if (direction === 'rtl') style.marginRight = parseValue(value, fontSize, containerWidth);
      else style.marginLeft = parseValue(value, fontSize, containerWidth);
      break;
    case 'margin-inline-end':
      if (direction === 'rtl') style.marginLeft = parseValue(value, fontSize, containerWidth);
      else style.marginRight = parseValue(value, fontSize, containerWidth);
      break;

    // Border
    case 'border-top-width': style.borderTopWidth = parseValue(value, fontSize, containerWidth); break;
    case 'border-top-color': style.borderTopColor = value.trim(); break;
    case 'border-top-style': style.borderTopStyle = value.trim(); break;
    case 'border-right-width': style.borderRightWidth = parseValue(value, fontSize, containerWidth); break;
    case 'border-right-color': style.borderRightColor = value.trim(); break;
    case 'border-right-style': style.borderRightStyle = value.trim(); break;
    case 'border-bottom-width': style.borderBottomWidth = parseValue(value, fontSize, containerWidth); break;
    case 'border-bottom-color': style.borderBottomColor = value.trim(); break;
    case 'border-bottom-style': style.borderBottomStyle = value.trim(); break;
    case 'border-left-width': style.borderLeftWidth = parseValue(value, fontSize, containerWidth); break;
    case 'border-left-color': style.borderLeftColor = value.trim(); break;
    case 'border-left-style': style.borderLeftStyle = value.trim(); break;

    // Flex
    case 'flex-direction': style.flexDirection = value.trim(); break;
    case 'gap': style.gap = parseValue(value, fontSize, containerWidth); break;
    case 'flex-grow': style.flexGrow = parseFloat(value) || 0; break;

    // List
    case 'list-style-type': style.listStyleType = value.trim(); break;

    // Ignored properties (not relevant for our layout)
    case 'position':
    case 'top':
    case 'left':
    case 'right':
    case 'bottom':
    case 'inset-inline-start':
    case 'inset-inline-end':
    case 'content':
    case 'counter-reset':
    case 'counter-increment':
    case 'border-radius':
    case 'border-top-left-radius':
    case 'border-top-right-radius':
    case 'border-bottom-left-radius':
    case 'border-bottom-right-radius':
    case 'cursor':
    case 'opacity':
    case 'overflow':
    case 'box-sizing':
    case 'outline':
    case 'transition':
    case 'transform':
    case 'text-indent':
    case 'font-stretch':
    case 'font-display':
    case 'src':
    case 'unicode-range':
      break;
  }
}

/** Inheritable property names (CSS kebab-case) mapped to ResolvedStyle keys */
const INHERITABLE_KEYS: [string, keyof ResolvedStyle][] = [
  ['font-family', 'fontFamily'],
  ['font-size', 'fontSize'],
  ['font-weight', 'fontWeight'],
  ['font-style', 'fontStyle'],
  ['color', 'color'],
  ['text-align', 'textAlign'],
  ['text-transform', 'textTransform'],
  ['white-space', 'whiteSpace'],
  ['word-break', 'wordBreak'],
  ['overflow-wrap', 'overflowWrap'],
  ['direction', 'direction'],
  ['letter-spacing', 'letterSpacing'],
  ['word-spacing', 'wordSpacing'],
  ['line-height', 'lineHeight'],
  ['text-shadow', 'textShadow'],
  ['font-kerning', 'fontKerning'],
  ['list-style-type', 'listStyleType'],
  ['vertical-align', 'verticalAlign'],
];

/**
 * Inherit properties from parent style to child style for properties
 * not explicitly set (tracked via setProps).
 */
function inheritFrom(child: ResolvedStyle, parent: ResolvedStyle, setProps: Set<string>): void {
  for (const [cssProp, key] of INHERITABLE_KEYS) {
    if (!setProps.has(cssProp)) {
      if (key === 'lineHeight') {
        // Unitless line-height: re-compute relative to child's font-size
        const multiplier = (parent as any)._lineHeightMultiplier;
        if (multiplier !== undefined) {
          child.lineHeight = multiplier * child.fontSize;
          (child as any)._lineHeightMultiplier = multiplier;
        } else {
          child.lineHeight = parent.lineHeight;
        }
      } else {
        (child as any)[key] = (parent as any)[key];
      }
    }
  }
}

// ─── Main resolver ───────────────────────────────────────────────────

interface MatchedDeclaration {
  property: string;
  value: string;
  specificity: [number, number, number];
  order: number;
  important: boolean;
}

/**
 * Detect list marker text for a <li> element based on tree position.
 */
function getListMarker(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'li') return undefined;

  const parent = el.parentElement;
  if (!parent) return '•';

  const parentTag = parent.tagName.toLowerCase();
  if (parentTag === 'ol') {
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
 * Parse inline style attribute into declarations.
 */
function parseInlineStyle(styleAttr: string): CSSDeclaration[] {
  const declarations: CSSDeclaration[] = [];
  for (const decl of styleAttr.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const property = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl.slice(colonIdx + 1).trim();
    if (property && value) {
      declarations.push({ property, value });
    }
  }
  return declarations;
}

/**
 * Resolve styles for a DOM tree without inserting into the document.
 * Parses CSS rules, matches selectors, resolves cascade + inheritance.
 */
export function resolveStylesFromCSS(
  fragment: DocumentFragment,
  css: string,
  containerWidth: number,
): { tree: StyledNode; container: Element; cleanup: () => void } {
  const { rules, fontFaceRules } = parseCSS(css);

  // Inject @font-face rules into the document so fonts can load
  let fontStyleEl: HTMLStyleElement | null = null;
  if (fontFaceRules.length > 0) {
    fontStyleEl = document.createElement('style');
    fontStyleEl.textContent = fontFaceRules.join('\n');
    document.head.appendChild(fontStyleEl);
  }

  // Pre-compute specificity for each rule+selector combination
  const ruleSpecificities: { rule: CSSRule; selector: string; spec: [number, number, number] }[] = [];
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      if (sel.includes('::')) continue; // skip pseudo-element selectors
      ruleSpecificities.push({
        rule,
        selector: sel,
        spec: selectorSpecificity(sel),
      });
    }
  }

  // Wrap fragment in a container div (matching DOM resolver behavior)
  const container = document.createElement('div');
  container.appendChild(fragment);

  function buildContext(el: Element, parent: ElementContext | null): ElementContext {
    const classes = new Set<string>();
    const className = el.getAttribute('class');
    if (className) {
      for (const c of className.split(/\s+/)) {
        if (c) classes.add(c);
      }
    }
    return {
      tagName: el.tagName.toLowerCase(),
      classes,
      parent,
      el,
    };
  }

  function resolveElement(
    el: Element,
    parentStyle: ResolvedStyle,
    parentCtx: ElementContext | null,
  ): StyledNode {
    const tag = el.tagName.toLowerCase();
    const ctx = buildContext(el, parentCtx);

    // Start with defaults
    const style = defaultStyle();

    // Track which properties are explicitly set (tag defaults, CSS rules, inline styles)
    const setProps = new Set<string>();

    // --- Step 1: Determine font-size first (needed for em/multiplier resolution) ---

    // Collect matching CSS rules (needed for both font-size and other properties)
    const matched: MatchedDeclaration[] = [];
    let order = 0;
    for (const { rule, selector, spec } of ruleSpecificities) {
      if (matchesSelector(selector, ctx)) {
        for (const decl of rule.declarations) {
          const isImportant = decl.value.includes('!important');
          const cleanValue = decl.value.replace(/\s*!important\s*/g, '').trim();
          const expanded = expandShorthand(decl.property, cleanValue);
          for (const exp of expanded) {
            matched.push({
              property: exp.property,
              value: exp.value,
              specificity: spec,
              order: order++,
              important: isImportant,
            });
          }
        }
      }
    }

    // Tag default font-size
    const tagDef = TAG_DEFAULTS[tag];
    let fontSizeSet = false;
    if (tagDef?.fontSize !== undefined) {
      const val = tagDef.fontSize as number;
      if (val < 10) {
        style.fontSize = val * parentStyle.fontSize;
      } else {
        style.fontSize = val;
      }
      fontSizeSet = true;
      setProps.add('font-size');
    }

    // Sort by: !important first, then specificity, then source order
    matched.sort((a, b) => {
      if (a.important !== b.important) return a.important ? 1 : -1; // important goes last (wins)
      const sa = a.specificity, sb = b.specificity;
      if (sa[0] !== sb[0]) return sa[0] - sb[0];
      if (sa[1] !== sb[1]) return sa[1] - sb[1];
      if (sa[2] !== sb[2]) return sa[2] - sb[2];
      return a.order - b.order;
    });

    // Apply font-size from CSS rules
    for (const m of matched) {
      if (m.property === 'font-size') {
        applyDeclaration(style, m.property, m.value, parentStyle.fontSize, containerWidth, parentStyle.direction);
        fontSizeSet = true;
      }
    }

    // Apply font-size from inline styles
    if (el instanceof HTMLElement && el.style.cssText) {
      const inlineDecls = parseInlineStyle(el.style.cssText);
      for (const decl of inlineDecls) {
        if (decl.property === 'font-size') {
          applyDeclaration(style, decl.property, decl.value, parentStyle.fontSize, containerWidth, parentStyle.direction);
          fontSizeSet = true;
        }
      }
    }

    // Inherit font-size from parent if not set
    if (!fontSizeSet) {
      style.fontSize = parentStyle.fontSize;
    }

    // Now style.fontSize is the element's computed font-size
    const elemFontSize = style.fontSize;

    // --- Step 2: Apply all other properties using resolved font-size ---

    // Apply non-fontSize tag defaults
    if (tagDef) {
      for (const [key, val] of Object.entries(tagDef)) {
        if (key === 'fontSize') continue; // already handled
        (style as any)[key] = val;
        const cssKey = key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        setProps.add(cssKey);
      }

      // Resolve negative margin values (em multipliers from tag defaults)
      if (style.marginTop < 0) style.marginTop = Math.abs(style.marginTop) * elemFontSize;
      if (style.marginBottom < 0) style.marginBottom = Math.abs(style.marginBottom) * elemFontSize;

      // Default padding-inline-start for lists (direction-aware)
      if (tag === 'ul' || tag === 'ol') {
        const dir = parentStyle.direction;
        if (dir === 'rtl') {
          style.paddingRight = 40;
          setProps.add('padding-right');
        } else {
          style.paddingLeft = 40;
          setProps.add('padding-left');
        }
      }
    }

    // Determine direction from parent for logical property resolution
    const direction = parentStyle.direction;

    // Property aliases: CSS name → canonical name for setProps tracking
    const PROP_ALIASES: Record<string, string> = {
      'word-wrap': 'overflow-wrap',
    };

    // Apply matched CSS declarations (skip font-size, already applied)
    for (const m of matched) {
      if (m.property === 'font-size') continue;
      applyDeclaration(style, m.property, m.value, elemFontSize, containerWidth, direction);
      setProps.add(PROP_ALIASES[m.property] || m.property);
    }

    // Apply inline styles (highest specificity, skip font-size)
    const hasInlineWidth = el instanceof HTMLElement && !!el.style.width;
    if (el instanceof HTMLElement && el.style.cssText) {
      const inlineDecls = parseInlineStyle(el.style.cssText);
      for (const decl of inlineDecls) {
        if (decl.property === 'font-size') {
          setProps.add('font-size');
          continue;
        }
        const expanded = expandShorthand(decl.property, decl.value);
        for (const exp of expanded) {
          applyDeclaration(style, exp.property, exp.value, elemFontSize, containerWidth, direction);
          setProps.add(PROP_ALIASES[exp.property] || exp.property);
        }
      }
    }

    // Only keep explicit width from inline styles (match DOM resolver behavior)
    if (!hasInlineWidth) {
      style.width = 0;
    }

    // Handle `dir` attribute
    const dirAttr = el.getAttribute('dir');
    if (dirAttr) {
      style.direction = dirAttr;
      setProps.add('direction');
    }

    // Inherit from parent for properties not explicitly set
    setProps.add('font-size'); // already resolved
    inheritFrom(style, parentStyle, setProps);

    // Auto-set currentColor defaults (browser default behavior)
    if (!setProps.has('text-decoration-color')) {
      style.textDecorationColor = style.color;
    }
    if (!setProps.has('-webkit-text-stroke-color')) {
      if (style.webkitTextStrokeColor === '' || style.webkitTextStrokeColor === 'currentColor') {
        style.webkitTextStrokeColor = style.color;
      }
    } else if (style.webkitTextStrokeColor === 'currentColor') {
      style.webkitTextStrokeColor = style.color;
    }
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const colorKey = `border${side}Color` as keyof ResolvedStyle;
      const propName = `border-${side.toLowerCase()}-color`;
      if (!setProps.has(propName)) {
        (style as any)[colorKey] = style.color;
      } else if ((style as any)[colorKey] === 'currentColor') {
        (style as any)[colorKey] = style.color;
      }
    }

    // Handle text-decoration inheritance (propagates visually, not via normal inheritance)
    const decoSet = new Set(style.textDecorationLine.split(/\s+/).filter(d => d && d !== 'none'));
    if (parentStyle.textDecorationLine && parentStyle.textDecorationLine !== 'none') {
      for (const d of parentStyle.textDecorationLine.split(/\s+/)) {
        if (d && d !== 'none') decoSet.add(d);
      }
    }
    if (decoSet.size > 0) {
      style.textDecorationLine = [...decoSet].join(' ');
    }

    // List marker
    const marker = getListMarker(el);

    // Walk children
    const children: StyledNode[] = [];
    for (const child of el.childNodes) {
      const childNode = walkNode(child, style, ctx);
      if (childNode) children.push(childNode);
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

  function walkNode(
    node: Node,
    parentStyle: ResolvedStyle,
    parentCtx: ElementContext | null,
  ): StyledNode | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!text) return null;

      if (text.trim() === '' && !text.includes('\u00A0')) {
        const ws = parentStyle.whiteSpace;
        const prev = node.previousSibling;
        const next = node.nextSibling;
        const isInlineSibling = (n: Node | null) => {
          if (!n || n.nodeType !== Node.ELEMENT_NODE) return n?.nodeType === Node.TEXT_NODE;
          const tag = (n as Element).tagName.toLowerCase();
          const def = TAG_DEFAULTS[tag];
          const d = def?.display || 'block';
          return d === 'inline' || d === 'inline-block';
        };

        if (prev && next && !isInlineSibling(prev) && !isInlineSibling(next)) {
          if (ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line') {
            // Keep
          } else {
            return null;
          }
        }

        if (ws !== 'pre' && ws !== 'pre-wrap' && ws !== 'pre-line') {
          if (text.includes('\n')) return null;
        }
      }

      // Clone parent style for text node (text nodes don't match CSS rules)
      const style = { ...parentStyle };

      return {
        element: null,
        tagName: '#text',
        style,
        children: [],
        textContent: text,
      };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return null;

    // <br> → text node with newline
    if (tag === 'br') {
      return {
        element: null,
        tagName: '#text',
        style: { ...parentStyle },
        children: [],
        textContent: '\n',
      };
    }

    return resolveElement(el, parentStyle, parentCtx);
  }

  // Build root style from container's inline styles
  const rootStyle = defaultStyle();

  // Apply any inline style on the container
  if (container instanceof HTMLElement && container.style.cssText) {
    const inlineDecls = parseInlineStyle(container.style.cssText);
    for (const decl of inlineDecls) {
      const expanded = expandShorthand(decl.property, decl.value);
      for (const exp of expanded) {
        applyDeclaration(rootStyle, exp.property, exp.value, 16, containerWidth, 'ltr');
      }
    }
  }

  const tree = resolveElement(container, rootStyle, null);

  const cleanup = () => {
    if (fontStyleEl) fontStyleEl.remove();
  };

  return { tree, container, cleanup };
}
