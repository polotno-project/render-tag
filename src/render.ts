import type { DecorationEntry, LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.js';
import {
  BLINK_TEXT_RUN_SHAPING,
  buildCanvasFont,
  getFontMetrics,
  hasTextClip,
  isShiftedVAlign,
  isTransparent,
} from './layout.js';
import { paintOrderHasStrokeFirst } from './css-resolver.js';

/**
 * Parse a CSS text-shadow string into individual shadow values.
 * Format: "2px 2px 4px rgba(0,0,0,0.3), ..."
 */
export function parseTextShadows(shadow: string): Array<{
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
 * Corner radii [TL, TR, BR, BL] as ellipse radii for `roundRect`, or null
 * when every corner is square. Percentages resolve here: the horizontal
 * component against the box width, the vertical against its height — a bare
 * `border-radius: 50%` on a non-square box is an ellipse per corner, as in
 * the DOM. Overlapping radii shrink UNIFORMLY by the largest factor that
 * fits (css-backgrounds §4.5, per axis): scaling all corners together is
 * what keeps a pill (`border-radius: 999px`) a pill instead of a lens.
 */
function cornerRadii(
  style: ResolvedStyle, width: number, height: number,
): { x: number; y: number }[] | null {
  const {
    borderTopLeftRadius: tl, borderTopRightRadius: tr,
    borderBottomRightRadius: br, borderBottomLeftRadius: bl,
  } = style;
  // Nearly every box is square on every corner, and this runs once per
  // rendered box — bail before allocating anything.
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) return null;
  const corners = [tl, tr, br, bl].map((r) => {
    if (typeof r === 'number') return { x: r, y: r };
    const k = r.pct / 100;
    return { x: k * width, y: k * height };
  });
  const [ctl, ctr, cbr, cbl] = corners;
  let f = 1;
  for (const [side, sum] of [
    [width, ctl.x + ctr.x], [width, cbl.x + cbr.x],
    [height, ctl.y + cbl.y], [height, ctr.y + cbr.y],
  ]) {
    if (sum > side) f = Math.min(f, side / sum);
  }
  return corners.map((c) => ({ x: c.x * f, y: c.y * f }));
}

/**
 * Draw a decoration line with the given style (solid, dotted, dashed, double, wavy).
 */
export function drawDecorationLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  lineWidth: number,
  decoStyle: string,
  color: string | CanvasGradient,
): void {
  // Chrome paints decorations as crisp integer-pixel bands. Snap the stroke
  // center so the band edges land on the pixel grid.
  y = Math.round(y - lineWidth / 2) + lineWidth / 2;
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
export function parseLinearGradient(
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

/** The solid fill color for text: -webkit-text-fill-color if set, else color. */
export function textFillColor(style: ResolvedStyle): string {
  return style.webkitTextFillColor && style.webkitTextFillColor !== 'transparent'
    ? style.webkitTextFillColor : style.color;
}

/**
 * Text decoration thickness for `auto`. Chromium paints an integer-pixel
 * band of max(1, floor(fontSize / 10)) regardless of font (measured across
 * 6 fonts × 16-64px against the DOM raster).
 */
export function decorationThickness(fontSize: number): number {
  return Math.max(1, Math.floor(fontSize / 10));
}

/**
 * The band width for one decoration entry: the declarer's explicit
 * text-decoration-thickness when set (Chrome draws round(T) rows; a declared
 * 0 hides the band — callers skip on 0), else the auto thickness from the
 * declarer's font size. Shared by both renderers.
 */
export function bandWidthFor(deco: DecorationEntry): number {
  const t = deco.declarer.textDecorationThickness;
  if (t === null) return decorationThickness(deco.declarer.fontSize);
  return t <= 0 ? 0 : Math.max(1, Math.round(t));
}

/**
 * Band-center delta below the baseline for EXPLICIT underline geometry, or
 * null for auto (each renderer keeps its own auto formula). Chrome-measured:
 * an explicit offset puts the band TOP at baseline + offset; auto offset
 * with an explicit thickness T puts it at baseline + ceil(T/2) — measured
 * exactly for T ∈ {1, 3, 4, 5, 8, 10}.
 */
export function explicitUnderlineDelta(
  deco: DecorationEntry,
  lineWidth: number,
): number | null {
  const offset = deco.declarer.textUnderlineOffset;
  if (offset !== null) return offset + lineWidth / 2;
  if (deco.declarer.textDecorationThickness !== null)
    return Math.ceil(lineWidth / 2) + lineWidth / 2;
  return null;
}

/** Apply the canvas stroke settings for -webkit-text-stroke. A gradient stroke
 * (webkitTextStrokeImage, pre-resolved to a CanvasGradient) wins over the solid
 * stroke color, mirroring how a background-clip:text gradient wins over `color`
 * for the fill. */
export function applyTextStroke(
  ctx: CanvasRenderingContext2D,
  style: ResolvedStyle,
  strokeGradient?: CanvasGradient | null,
): void {
  ctx.strokeStyle = strokeGradient || style.webkitTextStrokeColor || style.color;
  ctx.lineWidth = style.webkitTextStrokeWidth;
  const join = style.strokeLinejoin;
  ctx.lineJoin = join === 'miter' || join === 'bevel' ? join : 'round';
}

/**
 * Render a single text node to canvas.
 * @param gradientFill — pre-computed gradient for background-clip:text spanning full element
 * @param strokeGradient — pre-computed gradient for -webkit-text-stroke-image spanning full element
 */
function renderText(
  ctx: CanvasRenderingContext2D,
  node: LayoutText,
  gradientFill?: CanvasGradient | string | null,
  strokeGradient?: CanvasGradient | null,
): void {
  const { style } = node;

  ctx.save();
  ctx.font = buildCanvasFont(style);
  ctx.textBaseline = 'alphabetic';
  ctx.fontKerning = style.fontKerning === 'none' ? 'none' : 'normal';
  if (Number.isFinite(style.letterSpacing) && style.letterSpacing !== 0) {
    ctx.letterSpacing = `${style.letterSpacing}px`;
  }
  if (style.wordSpacing) {
    (ctx as any).wordSpacing = `${style.wordSpacing}px`;
  }
  if (style.direction === 'rtl') {
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
  }

  const hasOwnClip = hasTextClip(style);
  const isStrokedText = style.webkitTextStrokeWidth > 0;
  const isFillTransparent = style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent';

  // The background-clip:text paint from a declaring INLINE ancestor (e.g.
  // <span>/<s>) whose non-inheriting background this run's own style doesn't
  // carry: a gradient and/or solid color. Layout resolves the geometry — a box
  // spanning the declaring element's fragment on this line (see
  // assignInlineFragmentBoxes) — and this paint wins over any ancestor block
  // `gradientFill`, because Chrome clips the NEAREST declaring element's
  // background to the glyphs.
  const inlineClipPaint: CanvasGradient | string | null = node.clip
    ? (node.clip.image
        ? parseLinearGradient(
            ctx, node.clip.image,
            node.clip.x, node.clip.width,
            node.clip.y, node.clip.height,
          )
        : null) ?? node.clip.color ?? null
    : null;

  // An ancestor's clip paint only shows when this run's own fill is
  // transparent — an opaque own color paints over the clipped background and
  // wins.
  const isGradientText = hasOwnClip ||
    ((gradientFill != null || inlineClipPaint != null) && isFillTransparent);

  // What actually fills this run's glyphs (and any clipped decoration band):
  // the nearest inline declarer's paint if present, else the ancestor block's.
  const effectiveGradient = inlineClipPaint ?? gradientFill ?? null;

  // Same for the stroke gradient: an inline --rt-text-stroke-image declarer's
  // fragment gradient wins over an ancestor block's threaded one.
  const inlineStrokeGradient = node.strokeImage
    ? parseLinearGradient(
        ctx, node.strokeImage.image,
        node.strokeImage.x, node.strokeImage.width,
        node.strokeImage.y, node.strokeImage.height,
      )
    : null;
  const effectiveStrokeGradient = inlineStrokeGradient ?? strokeGradient ?? null;

  // Text shadow (drawn behind the text). Cast the shadow from the shape that
  // is actually painted: the fill when it's visible, and/or the stroke. This
  // matters for stroked text with a transparent fill (color:transparent +
  // -webkit-text-stroke), where CSS casts the shadow from the stroke outline
  // rather than the invisible fill.
  const shadows = parseTextShadows(style.textShadow);
  if (shadows.length > 0) {
    const hasVisibleFill = isGradientText || !isFillTransparent;
    for (const shadow of shadows) {
      ctx.save();
      ctx.shadowOffsetX = shadow.offsetX;
      ctx.shadowOffsetY = shadow.offsetY;
      ctx.shadowBlur = shadow.blur;
      ctx.shadowColor = shadow.color;
      if (hasVisibleFill) {
        ctx.fillStyle = isGradientText && effectiveGradient ? effectiveGradient : textFillColor(style);
        ctx.fillText(node.text, node.x, node.y);
      }
      if (isStrokedText) {
        applyTextStroke(ctx, style, effectiveStrokeGradient);
        ctx.strokeText(node.text, node.x, node.y);
      }
      ctx.restore();
    }
  }

  const drawFill = () => {
    if (isGradientText) {
      ctx.save();
      ctx.fillStyle = effectiveGradient || style.color;
      ctx.fillText(node.text, node.x, node.y);
      ctx.restore();
    } else if (!isFillTransparent) {
      // Normal text fill. A transparent fill paints NOTHING, stroked or not —
      // Chrome hides the glyphs entirely for `-webkit-text-fill-color:
      // transparent` (or `color: transparent`) even without a stroke.
      ctx.fillStyle = textFillColor(style);
      ctx.fillText(node.text, node.x, node.y);
    }
  };

  const drawStroke = () => {
    if (!isStrokedText) return;
    ctx.save();
    applyTextStroke(ctx, style, effectiveStrokeGradient);
    ctx.strokeText(node.text, node.x, node.y);
    ctx.restore();
  };

  if (paintOrderHasStrokeFirst(style.paintOrder)) {
    drawStroke();
    drawFill();
  } else {
    drawFill();
    drawStroke();
  }

  // Text decorations — use font metrics for accurate positioning.
  // Each entry paints with its ORIGIN element's color/style (ancestors first,
  // so a child's own decoration lands on top), matching Chrome's non-inherited
  // decoration propagation.
  //
  // Geometry splits, measured against Chrome for `30px ABC + 80px Tale` under
  // one declaration (see tests/decorating-box-geometry.test.ts):
  //  - THICKNESS is the decorating box's for all three lines — the band over
  //    the 80px child stays 3px, the 30px declarer's.
  //  - The UNDERLINE also takes its position from the decorating box: one flat
  //    band at rows 225-227 across both runs. It hangs off the alphabetic
  //    baseline, which every fragment on the line shares.
  //  - The OVERLINE and the LINE-THROUGH do NOT: Chrome steps them per
  //    fragment (193-195 vs 148-150, and 213-215 vs 168-170), because each
  //    hangs off the crossed fragment's own ascent, not a shared line.
  //
  // `vertical-align` splits the same way: an underline declared ABOVE a
  // `super` child stays flat across it (measured: one band, x 0-228), while
  // the overline and the strike step up with the child. So the underline
  // hangs off the DECLARER's baseline — the line's own, unless the declarer
  // is the shifted element itself, which then carries the band up with it.
  const textWidth = node.width;
  // For RTL text, node.x is the right edge (textAlign='right').
  // Decoration lines need the left edge as start position.
  const decoX = style.direction === 'rtl' ? node.x - textWidth : node.x;

  if (style.textDecorations.length > 0) {
    for (const deco of style.textDecorations) {
      const decoWidth = bandWidthFor(deco);
      if (decoWidth <= 0) continue; // declared text-decoration-thickness: 0
      // A transparent decoration inside a background-clip:text element shows
      // the clipped background through the band (Chrome includes decorations
      // in the clip region), so paint it with the gradient — REGARDLESS of
      // this run's own glyph fill: a solid-colored span inside a gradient
      // element still gets the gradient band across it. Transparent with no
      // gradient ancestor paints nothing.
      let color: string | CanvasGradient = deco.color;
      if (isTransparent(deco.color)) {
        if (effectiveGradient) {
          color = effectiveGradient;
        } else {
          continue;
        }
      }
      const decoStyle = deco.style || 'solid';

      // Chrome strokes decorations with -webkit-text-stroke, same as glyphs
      // (measured: red text + 3px blue stroke + underline adds only blue
      // pixels — the stroke swallows the thin band). Approximate the outline
      // with a thicker stroke-colored underlay; the decoration paint on top
      // keeps whatever the stroke leaves visible (decoWidth - strokeWidth).
      const strokeW = style.webkitTextStrokeWidth > 0 ? style.webkitTextStrokeWidth : 0;
      const strokeColor: string | CanvasGradient =
        effectiveStrokeGradient || style.webkitTextStrokeColor || style.color;
      const paintBand = (y: number) => {
        // A gradient stroke (CanvasGradient) is never transparent; a solid
        // stroke color still gets the transparent check below.
        const strokeIsTransparent =
          typeof strokeColor === 'string' && isTransparent(strokeColor);
        if (strokeW > 0 && !strokeIsTransparent) {
          drawDecorationLine(ctx, decoX, y, textWidth, decoWidth + strokeW, decoStyle, strokeColor);
          const inner = decoWidth - strokeW;
          if (inner > 0) {
            drawDecorationLine(ctx, decoX, y, textWidth, inner, decoStyle, color);
          }
        } else {
          drawDecorationLine(ctx, decoX, y, textWidth, decoWidth, decoStyle, color);
        }
      };

      if (deco.line === 'underline') {
        // The line's own baseline when this run was moved off it by
        // vertical-align and the DECLARER stayed behind; `node.lineBaselineY`
        // is set only on a shifted run.
        const baseline =
          node.lineBaselineY !== undefined && !isShiftedVAlign(deco.declarer.verticalAlign)
            ? node.lineBaselineY
            : node.y;
        const explicitDelta = explicitUnderlineDelta(deco, decoWidth);
        if (explicitDelta !== null) {
          paintBand(baseline + explicitDelta);
        } else {
          // Chrome centers the underline ~0.105em below the baseline for every
          // font tested (measured against the DOM raster sweep). The -0.2px is a
          // rounding tiebreak: at fractional baselines (line-height 1.6/1.8/2.0)
          // Chrome resolves the pixel row downward less often than plain
          // rounding; empirically this cuts row-off-by-one cases 39 → 12 across
          // the sweep without disturbing integer baselines.
          paintBand(baseline + deco.declarer.fontSize * 0.105 - 0.2);
        }
      } else if (deco.line === 'line-through') {
        // Chrome positions the strike from the font's OS/2 strikeout metric,
        // which canvas can't read. 0.33em above the baseline is the closest
        // single-formula fit (tuned against the native DOM raster sweep; ±1px
        // for most fonts, 3px worst case for Lobster at 64px).
        paintBand(node.y - style.fontSize * 0.33);
      } else if (deco.line === 'overline') {
        // Chrome hangs the overline band above the ascent line: its bottom
        // edge sits on the floored ascent pixel row, growing upward. The
        // ascent is the crossed run's, not the declarer's.
        const { ascent: decoAscent } = getFontMetrics(ctx, style);
        const overlineY = Math.floor(node.y - decoAscent) - decoWidth / 2;
        paintBand(overlineY);
      }
    }
  }

  ctx.restore();
}

const ORDINARY_SHAPING_TEXT =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Mark}\p{Number}\p{Punctuation}\p{Separator}]+$/u;

function canShapeAsRun(node: LayoutText): boolean {
  const { style } = node;
  return style.direction === 'ltr' &&
    style.textAlign !== 'justify' &&
    style.textDecorations.length === 0 &&
    style.textShadow === 'none' &&
    style.webkitTextStrokeWidth === 0 &&
    !node.clip && !node.strokeImage &&
    ORDINARY_SHAPING_TEXT.test(node.text);
}

/**
 * Render a layout box and its children to canvas.
 */
function renderBox(
  ctx: CanvasRenderingContext2D,
  box: LayoutBox,
  gradientFill: CanvasGradient | string | null = null,
  strokeGradient: CanvasGradient | null = null,
): void {
  const { style } = box;

  const radii = cornerRadii(style, box.width, box.height);

  // Background. With background-clip:text the background is NOT painted as a
  // box — it's clipped to descendant glyphs (threaded below as the text fill).
  if (!isTransparent(style.backgroundColor) && style.webkitBackgroundClip !== 'text') {
    ctx.fillStyle = style.backgroundColor;
    if (radii) {
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, radii);
      ctx.fill();
    } else {
      ctx.fillRect(box.x, box.y, box.width, box.height);
    }
  }

  // Borders. A rounded box with the same border on all four sides — the only
  // shape browsers give clean corner joins to, and the one authors write —
  // strokes the rounded path once, on the stroke's centerline (radius shrinks
  // by half the width there, matching the border-box outer curve). Rounded
  // corners with per-side borders keep the straight-line paint below: the
  // browser's per-corner color transitions aren't reproducible with strokes,
  // and the combination is vanishingly rare.
  const uniformRoundedBorder = radii !== null && hasBorder(style, 'Top') &&
    (['Right', 'Bottom', 'Left'] as const).every((side) =>
      style[`border${side}Width`] === style.borderTopWidth &&
      style[`border${side}Style`] === style.borderTopStyle &&
      style[`border${side}Color`] === style.borderTopColor);
  if (uniformRoundedBorder) {
    const w = style.borderTopWidth;
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.roundRect(
      box.x + w / 2, box.y + w / 2, box.width - w, box.height - w,
      radii.map((r) => ({ x: Math.max(0, r.x - w / 2), y: Math.max(0, r.y - w / 2) })),
    );
    ctx.stroke();
  } else {
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
  }

  // Pre-compute the paint for background-clip: text elements — a gradient
  // (background-image) or a solid color (background-color). It spans the
  // declaring box and threads through descendant boxes (browsers clip the
  // ancestor's background to ALL descendant glyphs, so text inside block
  // children like <p>/<li> keeps it — the background properties themselves
  // don't inherit); a box declaring its own clipping background overrides it.
  // (Inline declarers are resolved in layout via node.clip, not here.)
  if (hasTextClip(style)) {
    const grad = style.backgroundImage && style.backgroundImage !== 'none'
      ? parseLinearGradient(ctx, style.backgroundImage, box.x, box.width, box.y, box.height)
      : null;
    const solid = !isTransparent(style.backgroundColor) ? style.backgroundColor : null;
    // An unparseable image with no solid color keeps the ancestor's paint.
    gradientFill = grad ?? solid ?? gradientFill;
  }

  // Pre-compute the stroke gradient the same way: it spans the declaring box
  // and threads through descendants (a box declaring its own overrides it).
  // -webkit-text-stroke-image isn't inherited as a value; the computed gradient
  // is threaded down instead — exactly like the background-clip:text fill.
  if (style.webkitTextStrokeImage && style.webkitTextStrokeImage !== 'none') {
    strokeGradient = parseLinearGradient(ctx, style.webkitTextStrokeImage, box.x, box.width, box.y, box.height);
  }

  // Paint plain LTR words from one source run together. Layout stays
  // word-based (and remains public); only fillText gets the browser's full
  // shaping context across spaces. A box is eligible only when every child is
  // plain text, so a complex fragment cannot change neighboring paint.
  const runs = BLINK_TEXT_RUN_SHAPING &&
      box.children.every((child) => child.type === 'text' && canShapeAsRun(child))
    ? box.children as LayoutText[]
    : null;
  if (!runs) {
    for (const child of box.children) {
      renderNode(ctx, child, gradientFill, strokeGradient);
    }
    return;
  }

  for (let i = 0; i < runs.length; i++) {
    const head = runs[i];
    let text = head.text;
    let width = head.width;
    while (
      i + 1 < runs.length &&
      runs[i + 1].style === head.style &&
      runs[i + 1].y === head.y &&
      Math.abs(runs[i + 1].x - (head.x + width)) <= 0.01
    ) {
      text += runs[i + 1].text;
      width += runs[i + 1].width;
      i++;
    }
    renderText(ctx, { ...head, text, width }, gradientFill, strokeGradient);
  }
}

/**
 * Render any layout node.
 */
export function renderNode(
  ctx: CanvasRenderingContext2D,
  node: LayoutNode,
  gradientFill?: CanvasGradient | string | null,
  strokeGradient?: CanvasGradient | null,
): void {
  if (node.type === 'text') {
    renderText(ctx, node, gradientFill, strokeGradient);
  } else {
    renderBox(ctx, node, gradientFill, strokeGradient);
  }
}
