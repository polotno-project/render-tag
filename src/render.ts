import type { LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.js';
import { buildCanvasFont, isTransparent, getFontMetrics } from './layout.js';

/**
 * Parse a CSS text-shadow string into individual shadow values.
 * Format: "2px 2px 4px rgba(0,0,0,0.3), ..."
 */
function parseTextShadows(shadow: string): Array<{
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
}> {
  if (!shadow || shadow === 'none') return [];

  const shadows: Array<{ offsetX: number; offsetY: number; blur: number; color: string }> = [];

  // Split by comma but not within parentheses
  const parts = shadow.split(/,(?![^(]*\))/);

  for (const part of parts) {
    const trimmed = part.trim();
    // Extract color (rgb/rgba or named) and numbers
    const colorMatch = trimmed.match(/(rgb[a]?\([^)]+\)|#[0-9a-fA-F]+|\b[a-z]+\b)(?:\s|$)/i);
    const numMatches = trimmed.match(/-?[\d.]+px/g);

    if (numMatches && numMatches.length >= 2) {
      const nums = numMatches.map(n => parseFloat(n));
      shadows.push({
        offsetX: nums[0],
        offsetY: nums[1],
        blur: nums[2] || 0,
        color: colorMatch ? colorMatch[1] : 'rgba(0,0,0,1)',
      });
    }
  }

  return shadows;
}

/**
 * Check if a border is visible.
 */
function hasBorder(style: ResolvedStyle, side: 'Top' | 'Right' | 'Bottom' | 'Left'): boolean {
  const width = style[`border${side}Width` as keyof ResolvedStyle] as number;
  const borderStyle = style[`border${side}Style` as keyof ResolvedStyle] as string;
  return width > 0 && borderStyle !== 'none';
}

/**
 * Draw a decoration line with the given style (solid, dotted, dashed, double, wavy).
 */
function drawDecorationLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  lineWidth: number,
  decoStyle: string,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  if (decoStyle === 'double') {
    const gap = Math.max(lineWidth, 2);
    ctx.lineWidth = Math.max(0.5, lineWidth * 0.5);
    ctx.beginPath();
    ctx.moveTo(x, y - gap / 2);
    ctx.lineTo(x + width, y - gap / 2);
    ctx.moveTo(x, y + gap / 2);
    ctx.lineTo(x + width, y + gap / 2);
    ctx.stroke();
  } else if (decoStyle === 'wavy') {
    const amplitude = Math.max(1.5, lineWidth);
    const wavelength = amplitude * 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let cx = x; cx < x + width; cx += wavelength) {
      ctx.quadraticCurveTo(cx + wavelength / 4, y - amplitude, cx + wavelength / 2, y);
      ctx.quadraticCurveTo(cx + wavelength * 3 / 4, y + amplitude, cx + wavelength, y);
    }
    ctx.stroke();
  } else {
    // solid, dotted, dashed
    if (decoStyle === 'dotted') ctx.setLineDash([lineWidth, lineWidth * 2]);
    else if (decoStyle === 'dashed') ctx.setLineDash([lineWidth * 3, lineWidth * 2]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Parse a CSS linear-gradient into canvas CanvasGradient.
 */
function parseLinearGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  width: number,
  y: number,
  height: number,
): CanvasGradient | null {
  // Extract content inside linear-gradient(...) handling nested parens
  const startIdx = bgImage.indexOf('linear-gradient(');
  if (startIdx === -1) return null;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx + 16; i < bgImage.length; i++) {
    if (bgImage[i] === '(') depth++;
    else if (bgImage[i] === ')') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx === -1) return null;
  const innerContent = bgImage.slice(startIdx + 16, endIdx);

  // Split by commas not inside parentheses
  const parts: string[] = [];
  depth = 0;
  let start = 0;
  const inner = innerContent;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  // Parse angle/direction
  let angle = 180; // default top to bottom
  let colorStartIdx = 0;
  const firstPart = parts[0];
  if (firstPart.endsWith('deg')) {
    angle = parseFloat(firstPart);
    colorStartIdx = 1;
  } else if (firstPart === 'to right') {
    angle = 90; colorStartIdx = 1;
  } else if (firstPart === 'to left') {
    angle = 270; colorStartIdx = 1;
  } else if (firstPart === 'to bottom') {
    angle = 180; colorStartIdx = 1;
  } else if (firstPart === 'to top') {
    angle = 0; colorStartIdx = 1;
  }

  const rad = (angle - 90) * Math.PI / 180;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const len = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
  const dx = Math.cos(rad) * len / 2;
  const dy = Math.sin(rad) * len / 2;

  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);

  const colors = parts.slice(colorStartIdx);
  for (let i = 0; i < colors.length; i++) {
    const entry = colors[i].trim();
    // Match color followed by optional percentage: "rgb(220, 38, 38) 0%"
    // The percentage is always at the very end after the last space outside parens
    let color = entry;
    let stop = i / Math.max(1, colors.length - 1);
    const percentMatch = entry.match(/\s+([\d.]+%)\s*$/);
    if (percentMatch) {
      stop = parseFloat(percentMatch[1]) / 100;
      color = entry.slice(0, entry.length - percentMatch[0].length).trim();
    }
    try {
      gradient.addColorStop(stop, color);
    } catch {
      // Invalid color, skip
    }
  }

  return gradient;
}

/**
 * Render a single text node to canvas.
 * @param gradientFill — pre-computed gradient for background-clip:text spanning full element
 */
function renderText(ctx: CanvasRenderingContext2D, node: LayoutText, gradientFill?: CanvasGradient | null): void {
  const { style } = node;

  ctx.save();
  ctx.font = buildCanvasFont(style);
  ctx.textBaseline = 'alphabetic';
  ctx.fontKerning = style.fontKerning === 'none' ? 'none' : 'normal';
  if (style.letterSpacing > 0) {
    ctx.letterSpacing = `${style.letterSpacing}px`;
  }
  if (style.direction === 'rtl') {
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
  }

  const isGradientText = style.webkitBackgroundClip === 'text' &&
    style.backgroundImage && style.backgroundImage !== 'none';
  const isStrokedText = style.webkitTextStrokeWidth > 0;
  const isFillTransparent = style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent';

  // Text shadow (draw before main text)
  const shadows = parseTextShadows(style.textShadow);
  if (shadows.length > 0) {
    for (const shadow of shadows) {
      ctx.save();
      ctx.shadowOffsetX = shadow.offsetX;
      ctx.shadowOffsetY = shadow.offsetY;
      ctx.shadowBlur = shadow.blur;
      ctx.shadowColor = shadow.color;
      ctx.fillStyle = style.color;
      ctx.fillText(node.text, node.x, node.y);
      ctx.restore();
    }
  }

  // Main text fill
  if (isGradientText) {
    ctx.save();
    if (gradientFill) {
      ctx.fillStyle = gradientFill;
    } else {
      // Fallback: per-word gradient (shouldn't normally reach here)
      const { ascent, descent } = getFontMetrics(ctx, style);
      const gradient = parseLinearGradient(
        ctx, style.backgroundImage,
        node.x, node.width,
        node.y - ascent, ascent + descent,
      );
      ctx.fillStyle = gradient || style.color;
    }
    ctx.fillText(node.text, node.x, node.y);
    ctx.restore();
  } else if (!isFillTransparent || !isStrokedText) {
    // Normal text fill (skip if transparent + stroked, stroke handles it)
    ctx.fillStyle = style.webkitTextFillColor && style.webkitTextFillColor !== 'transparent'
      ? style.webkitTextFillColor : style.color;

    // letterSpacing is set on ctx above — fillText handles it natively
    ctx.fillText(node.text, node.x, node.y);
  }

  // Text stroke (outline text)
  if (isStrokedText) {
    ctx.save();
    ctx.strokeStyle = style.webkitTextStrokeColor || style.color;
    ctx.lineWidth = style.webkitTextStrokeWidth;
    ctx.lineJoin = 'round';
    ctx.strokeText(node.text, node.x, node.y);
    ctx.restore();
  }

  // Text decorations — use font metrics for accurate positioning
  const textWidth = node.width;
  const fontSize = style.fontSize;
  const decoColor = style.textDecorationColor || style.color;
  const decoStyle = style.textDecorationStyle || 'solid';
  const decoWidth = Math.max(1, fontSize / 15);

  if (style.textDecorationLine !== 'none') {
    const { ascent: decoAscent } = getFontMetrics(ctx, style);
    ctx.font = buildCanvasFont(style);
    const xHeight = ctx.measureText('x').actualBoundingBoxAscent;

    if (style.textDecorationLine.includes('underline')) {
      // Underline sits just below the baseline
      const yOffset = fontSize * 0.1;
      drawDecorationLine(ctx, node.x, node.y + yOffset, textWidth, decoWidth, decoStyle, decoColor);
    }

    if (style.textDecorationLine.includes('line-through')) {
      // Strikethrough at ~40% of x-height above baseline
      const yOffset = -(xHeight * 0.5);
      drawDecorationLine(ctx, node.x, node.y + yOffset, textWidth, decoWidth, decoStyle, decoColor);
    }

    if (style.textDecorationLine.includes('overline')) {
      drawDecorationLine(ctx, node.x, node.y - decoAscent, textWidth, decoWidth, decoStyle, decoColor);
    }
  }

  ctx.restore();
}

/**
 * Render a layout box and its children to canvas.
 */
function renderBox(ctx: CanvasRenderingContext2D, box: LayoutBox): void {
  const { style } = box;

  // Background
  if (!isTransparent(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  // Borders
  const borders: [side: 'Top' | 'Right' | 'Bottom' | 'Left', x1: number, y1: number, x2: number, y2: number][] = [
    ['Top', box.x, box.y + style.borderTopWidth / 2, box.x + box.width, box.y + style.borderTopWidth / 2],
    ['Right', box.x + box.width - style.borderRightWidth / 2, box.y, box.x + box.width - style.borderRightWidth / 2, box.y + box.height],
    ['Bottom', box.x, box.y + box.height - style.borderBottomWidth / 2, box.x + box.width, box.y + box.height - style.borderBottomWidth / 2],
    ['Left', box.x + style.borderLeftWidth / 2, box.y, box.x + style.borderLeftWidth / 2, box.y + box.height],
  ];
  for (const [side, x1, y1, x2, y2] of borders) {
    if (!hasBorder(style, side)) continue;
    ctx.strokeStyle = style[`border${side}Color` as keyof ResolvedStyle] as string;
    ctx.lineWidth = style[`border${side}Width` as keyof ResolvedStyle] as number;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Pre-compute gradient for background-clip: text elements
  let gradientFill: CanvasGradient | null = null;
  if (style.webkitBackgroundClip === 'text' && style.backgroundImage && style.backgroundImage !== 'none') {
    gradientFill = parseLinearGradient(ctx, style.backgroundImage, box.x, box.width, box.y, box.height);
  }

  // Children
  for (const child of box.children) {
    renderNode(ctx, child, gradientFill);
  }
}

/**
 * Render any layout node.
 */
export function renderNode(ctx: CanvasRenderingContext2D, node: LayoutNode, gradientFill?: CanvasGradient | null): void {
  if (node.type === 'text') {
    renderText(ctx, node, gradientFill);
  } else {
    renderBox(ctx, node);
  }
}
