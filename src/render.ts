import type { ShadowOptions, LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.js';
import {
  BLINK_TEXT_RUN_SHAPING,
  hasTextClip,
  layoutFontMetrics,
  isShiftedVAlign,
  paintLineSnap,
  startsMeasuredRun,
} from './layout.js';
import { isTransparent, paintOrderHasStrokeFirst } from './css-resolver.js';
import { paintTextShadows, ScratchPool, shadowBounds, textPaintBounds, unionBounds, withCanvasShadow, withoutCanvasShadow, type PaintBounds, type ShadowPiece } from './shadow.js';
import { PaintState } from './paint-state.js';
import { parseLinearGradient } from './gradient.js';
import { decorationBand, paintBand, type Band } from './decoration.js';
import { STROKE_CASTS_TEXT_SHADOW } from './engine.js';

export { parseLinearGradient };
export { bandWidthFor, decorationThickness, drawDecorationLine, explicitUnderlineDelta } from './decoration.js';

/**
 * Parse a CSS text-shadow string into individual shadow values.
 * Format: "2px 2px 4px rgba(0,0,0,0.3), ..."
 */
export function parseTextShadows(shadow: string, currentColor = 'black'): Array<{
  offsetX: number; offsetY: number; blur: number; color: string;
}> {
  if (!shadow || shadow === 'none') return [];
  const shadows: Array<{ offsetX: number; offsetY: number; blur: number; color: string }> = [];
  for (const part of shadow.split(/,(?![^(]*\))/)) {
    const tokens = part.trim().match(/[^\s(]+\([^)]*\)|[^\s]+/g) ?? [];
    const lengths: number[] = [];
    let color = currentColor;
    for (const token of tokens) {
      if (/^[+-]?(?:\d*\.)?\d+(?:px)?$/.test(token)) lengths.push(parseFloat(token));
      else color = token.toLowerCase() === 'currentcolor' ? currentColor : token;
    }
    if (lengths.length < 2 || lengths.length > 3 || (lengths[2] ?? 0) < 0) continue;
    shadows.push({ offsetX: lengths[0], offsetY: lengths[1], blur: lengths[2] ?? 0, color });
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

/** The solid fill color for text: -webkit-text-fill-color if set, else color. */
export function textFillColor(style: ResolvedStyle): string {
  return style.webkitTextFillColor && style.webkitTextFillColor !== 'transparent'
    ? style.webkitTextFillColor : style.color;
}

/** What fills and strokes a fragment's glyphs and clip-painted bands. */
interface TextPaints {
  /** Fill with the clip paint (a gradient or the declarer's color). */
  clipped: boolean;
  /** The nearest declarer's clip paint, if any. */
  clip: CanvasGradient | string | null;
  stroke: CanvasGradient | null;
}

/**
 * Resolve a fragment's clip and stroke paints once — every run of a text
 * fragment shares its style and its declarer's fragment box, so one gradient
 * object serves them all (`PaintState.linearGradient`).
 * @param gradientFill — the clip paint threaded down from a declaring BLOCK
 * @param strokeGradient — the stroke gradient threaded down the same way
 */
function textPaints(
  ps: PaintState,
  node: LayoutText,
  gradientFill: CanvasGradient | string | null | undefined,
  strokeGradient: CanvasGradient | null | undefined,
): TextPaints {
  const { style } = node;
  const isFillTransparent = style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent';

  // The background-clip:text paint from a declaring INLINE ancestor (e.g.
  // <span>/<s>) whose non-inheriting background this run's own style doesn't
  // carry: a gradient and/or solid color. Layout resolves the geometry — a box
  // spanning the declaring element's fragment on this line (see
  // assignInlineFragmentBoxes) — and this paint wins over any ancestor block
  // `gradientFill`, because Chrome clips the NEAREST declaring element's
  // background to the glyphs.
  const { clip: box, strokeImage } = node;
  const inlineClipPaint: CanvasGradient | string | null = box
    ? (box.image ? ps.linearGradient(box.image, box.x, box.width, box.y, box.height) : null) ??
      box.color ?? null
    : null;

  // What actually fills this run's glyphs (and any clipped decoration band):
  // the nearest inline declarer's paint if present, else the ancestor block's.
  const clip = inlineClipPaint ?? gradientFill ?? null;

  // An ancestor's clip paint only shows when this run's own fill is
  // transparent — an opaque own color paints over the clipped background and
  // wins.
  const clipped = hasTextClip(style) ||
    ((gradientFill != null || inlineClipPaint != null) && isFillTransparent);

  // Same for the stroke gradient: an inline --rt-text-stroke-image declarer's
  // fragment gradient wins over an ancestor block's threaded one.
  const inlineStroke = strokeImage
    ? ps.linearGradient(strokeImage.image, strokeImage.x, strokeImage.width, strokeImage.y, strokeImage.height)
    : null;
  return { clipped, clip, stroke: inlineStroke ?? strokeGradient ?? null };
}

/** Fill and stroke one run's glyphs at baseline `y`, in its paint order. */
function drawGlyphs(ps: PaintState, node: LayoutText, y: number, paints: TextPaints): void {
  const { style } = node;
  const { ctx } = ps;
  ps.text(style);
  const isFillTransparent = style.webkitTextFillColor === 'transparent' ||
    style.color === 'transparent';

  const drawFill = () => {
    if (paints.clipped) {
      ps.fill(paints.clip || style.color);
      ctx.fillText(node.text, node.x, y);
    } else if (!isFillTransparent || ps.coverage) {
      // Normal text fill. A transparent fill paints NOTHING, stroked or not —
      // Chrome hides the glyphs entirely for `-webkit-text-fill-color:
      // transparent` (or `color: transparent`) even without a stroke.
      ps.fill(textFillColor(style));
      ctx.fillText(node.text, node.x, y);
    }
  };

  const drawStroke = () => {
    if (style.webkitTextStrokeWidth <= 0 || (ps.coverage && !STROKE_CASTS_TEXT_SHADOW)) return;
    ps.textStroke(style, paints.stroke);
    ctx.strokeText(node.text, node.x, y);
  };

  if (paintOrderHasStrokeFirst(style.paintOrder)) {
    drawStroke();
    drawFill();
  } else {
    drawFill();
    drawStroke();
  }
}

/** A run's left and right edges (an RTL run's x is its right edge). */
function edges(node: LayoutText): [left: number, right: number] {
  return node.style.direction === 'rtl' ? [node.x - node.width, node.x] : [node.x, node.x + node.width];
}

/**
 * Do `a` and `b` belong to one text fragment — the unit the engine paints a
 * decoration across? One text node's pieces on one line: the same style
 * object, no measured-run seam between them (`Hello<!---->World` is two text
 * nodes of one style), the same baseline, touching edges.
 */
function sameTextFragment(a: LayoutText, b: LayoutText): boolean {
  if (b.style !== a.style || startsMeasuredRun(b) || b.y !== a.y || b.lineBaselineY !== a.lineBaselineY) return false;
  const [al, ar] = edges(a), [bl, br] = edges(b);
  return Math.abs(bl - ar) <= 0.5 || Math.abs(al - br) <= 0.5;
}

/**
 * The decoration bands over one text fragment, ancestors' entries first (so
 * a child's own decoration lands on top), each in its ORIGIN element's color
 * and style, matching Chrome's non-inherited decoration propagation.
 *
 * Geometry splits, measured against Chrome for `30px ABC + 80px Tale` under
 * one declaration (see tests/decorating-box-geometry.test.ts):
 *  - THICKNESS is the decorating box's for all three lines — the band over
 *    the 80px child stays 3px, the 30px declarer's.
 *  - The UNDERLINE also takes its position from the decorating box: one flat
 *    band at rows 225-227 across both runs. It hangs off the alphabetic
 *    baseline, which every fragment on the line shares.
 *  - The OVERLINE and the LINE-THROUGH do NOT: Chrome steps them per
 *    fragment (193-195 vs 148-150, and 213-215 vs 168-170), because each
 *    hangs off the crossed fragment's own ascent, not a shared line.
 *
 * `vertical-align` splits the same way: an underline declared ABOVE a
 * `super` child stays flat across it (measured: one band, x 0-228), while
 * the overline and the strike step up with the child. So the underline
 * hangs off the DECLARER's baseline — the line's own, unless the declarer
 * is the shifted element itself, which then carries the band up with it.
 */
function fragmentBands(
  ps: PaintState, runs: LayoutText[], snap: number, paints: TextPaints,
): { band: Band; color: string | CanvasGradient }[] {
  const head = runs[0];
  const { style } = head;
  let left = Infinity, right = -Infinity;
  for (const run of runs) {
    const [l, r] = edges(run);
    if (l < left) left = l;
    if (r > right) right = r;
  }
  const baseline = head.y + snap;
  const lineBaseline = head.lineBaselineY === undefined ? undefined : head.lineBaselineY + snap;
  let ascent: number | undefined;
  const bands: { band: Band; color: string | CanvasGradient }[] = [];
  for (const deco of style.textDecorations) {
    // A transparent decoration inside a background-clip:text element shows
    // the clipped background through the band (Chrome includes decorations
    // in the clip region), so paint it with that paint — REGARDLESS of this
    // run's own glyph fill: a solid-colored span inside a gradient element
    // still gets the gradient band across it. Transparent with no clip paint
    // paints nothing.
    let color: string | CanvasGradient = deco.color;
    if (isTransparent(deco.color)) {
      if (!paints.clip) continue;
      color = paints.clip;
    }
    // The line's own baseline when this run was moved off it by
    // vertical-align and the DECLARER stayed behind (`lineBaselineY` is set
    // only on a shifted run).
    const underlineBaseline =
      lineBaseline !== undefined && !isShiftedVAlign(deco.declarer.verticalAlign) ? lineBaseline : baseline;
    // The overline and the line-through hang off the crossed run's ascent.
    if (deco.line !== 'underline') ascent ??= ps.fontBox(style).ascent;
    const band = decorationBand(deco, {
      baseline, underlineBaseline, fontSize: style.fontSize, ascent: ascent ?? 0, snap,
    }, left, right - left, ps.deviceScale);
    if (band) bands.push({ band, color });
  }
  return bands;
}

/**
 * Paint one text fragment: its underlines and overlines, its glyphs, then
 * its line-throughs — the order the engine paints a text fragment in.
 * `originals` are the layout nodes behind `runs` (a batched run is a copy).
 */
function paintFragment(
  ps: PaintState,
  runs: LayoutText[],
  originals: LayoutText[],
  gradientFill: CanvasGradient | string | null | undefined,
  strokeGradient: CanvasGradient | null | undefined,
  pass: PaintPass | undefined,
): void {
  if (pass) for (const original of originals) pass.beforeText(ps.ctx, original);
  const paints = textPaints(ps, runs[0], gradientFill, strokeGradient);
  const bands = runs[0].style.textDecorations.length
    ? fragmentBands(ps, runs, paintLineSnap(originals[0]), paints)
    : [];
  for (const { band, color } of bands) if (band.line !== 'line-through') paintBand(ps, band, color);
  runs.forEach((run, i) => drawGlyphs(ps, run, run.y + paintLineSnap(originals[i]), paints));
  for (const { band, color } of bands) if (band.line === 'line-through') paintBand(ps, band, color);
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

interface PaintPass {
  /** Called before each text fragment's paint, with each of its runs. */
  beforeText: (ctx: CanvasRenderingContext2D, node: LayoutText) => void;
}

/** The children of `box` when Blink would paint them as shaped runs:
 * every child plain, LTR, undecorated text (`canShapeAsRun`). */
function batchedRuns(box: LayoutBox): LayoutText[] | null {
  return BLINK_TEXT_RUN_SHAPING &&
    box.children.every(child => child.type === 'text' && canShapeAsRun(child))
    ? box.children as LayoutText[] : null;
}

/** Visit the actual foreground runs, retaining their original node for hooks. */
function forEachPaintedChild(
  box: LayoutBox, paint: (node: LayoutNode, original: LayoutNode) => void,
): void {
  const runs = batchedRuns(box);
  if (!runs) {
    box.children.forEach(child => paint(child, child));
    return;
  }
  for (let i = 0; i < runs.length; i++) {
    const head = runs[i];
    let text = head.text, width = head.width;
    // One fillText only for pieces measured as one run (`startsMeasuredRun`).
    while (i + 1 < runs.length && runs[i + 1].style === head.style && !startsMeasuredRun(runs[i + 1]) &&
      runs[i + 1].y === head.y && Math.abs(runs[i + 1].x - (head.x + width)) <= 0.01) {
      text += runs[i + 1].text;
      width += runs[++i].width;
    }
    paint({ ...head, text, width }, head);
  }
}

/** A block's background-clip:text paint: its gradient, else its solid color. */
function blockClipPaint(ps: PaintState, box: LayoutBox): CanvasGradient | string | null {
  const { style } = box;
  const grad = style.backgroundImage && style.backgroundImage !== 'none'
    ? ps.linearGradient(style.backgroundImage, box.x, box.width, box.y, box.height)
    : null;
  return grad ?? (!isTransparent(style.backgroundColor) ? style.backgroundColor : null);
}

function hasStrokeImage(style: ResolvedStyle): boolean {
  return !!style.webkitTextStrokeImage && style.webkitTextStrokeImage !== 'none';
}

/** A block's --rt-text-stroke-image gradient over its box. */
function blockStrokePaint(ps: PaintState, box: LayoutBox): CanvasGradient | null {
  const { style } = box;
  return ps.linearGradient(style.webkitTextStrokeImage, box.x, box.width, box.y, box.height);
}

/** Group a box's text children into the fragments `paintFragment` paints. */
function forEachFragment(
  children: LayoutNode[], visit: (child: LayoutBox | LayoutText[]) => void,
): void {
  for (let i = 0; i < children.length;) {
    const child = children[i];
    if (child.type === 'box') {
      visit(child);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < children.length && children[j].type === 'text' &&
      sameTextFragment(children[j - 1] as LayoutText, children[j] as LayoutText)) j++;
    visit(children.slice(i, j) as LayoutText[]);
    i = j;
  }
}

/** Render a layout box and its children to canvas. */
function renderBox(
  ps: PaintState,
  box: LayoutBox,
  gradientFill: CanvasGradient | string | null = null,
  strokeGradient: CanvasGradient | null = null,
  pass?: PaintPass,
): void {
  const { style } = box;
  const { ctx } = ps;

  const radii = cornerRadii(style, box.width, box.height);

  // Background. With background-clip:text the background is NOT painted as a
  // box — it's clipped to descendant glyphs (threaded below as the text fill).
  if (!isTransparent(style.backgroundColor) && style.webkitBackgroundClip !== 'text') {
    ps.fill(style.backgroundColor);
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
    ps.stroke(style.borderTopColor, w);
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
      ps.stroke(
        style[`border${side}Color` as keyof ResolvedStyle] as string,
        style[`border${side}Width` as keyof ResolvedStyle] as number,
      );
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
  // An unparseable image with no solid color keeps the ancestor's paint.
  if (hasTextClip(style)) gradientFill = blockClipPaint(ps, box) ?? gradientFill;

  // Pre-compute the stroke gradient the same way: it spans the declaring box
  // and threads through descendants (a box declaring its own overrides it).
  // -webkit-text-stroke-image isn't inherited as a value; the computed gradient
  // is threaded down instead — exactly like the background-clip:text fill.
  if (hasStrokeImage(style)) strokeGradient = blockStrokePaint(ps, box);

  // Paint plain LTR words from one source run together. Layout stays
  // word-based (and remains public); only fillText gets the browser's full
  // shaping context across spaces. A box is eligible only when every child is
  // plain text, so a complex fragment cannot change neighboring paint.
  if (batchedRuns(box)) {
    forEachPaintedChild(box, (child, original) => {
      paintFragment(ps, [child as LayoutText], [original as LayoutText], gradientFill, strokeGradient, pass);
    });
    return;
  }
  forEachFragment(box.children, (child) => {
    if (Array.isArray(child)) paintFragment(ps, child, child, gradientFill, strokeGradient, pass);
    else renderBox(ps, child, gradientFill, strokeGradient, pass);
  });
}

/**
 * Render any layout node.
 */
function paintNode(ps: PaintState, node: LayoutNode, pass?: PaintPass): void {
  if (node.type === 'text') paintFragment(ps, [node], [node], null, null, pass);
  else renderBox(ps, node, null, null, pass);
}

/**
 * A text fragment with a text-shadow, as the shadow mask repaints it: its
 * runs, and the declaring blocks whose clip and stroke paints thread down to
 * it (`renderBox`), so the mask resolves the same paints on its own ctx.
 */
interface ShadowFragment {
  runs: LayoutText[];
  /** background-clip:text blocks, outermost first. */
  clips: readonly LayoutBox[];
  /** The nearest --rt-text-stroke-image block. */
  stroke: LayoutBox | null;
  /** Its foreground ink, measured once per draw (`shadowPieces`). */
  bounds?: PaintBounds;
}

type ShadowGroup = {
  fragments: ShadowFragment[];
  shadows: ReturnType<typeof parseTextShadows>;
};

/** Each run's shadow groups, keyed by the run they paint before. */
type ShadowPasses = Map<LayoutText, Map<string, ShadowGroup>>;

/**
 * Collect every shadow group in ONE walk of the tree, recording each
 * shadowed fragment with what its mask needs — the mask then repaints just
 * those fragments, instead of replaying the tree from the root per group.
 */
function collectShadowPasses(root: LayoutNode): ShadowPasses {
  const passes: ShadowPasses = new Map();
  const parsed = new Map<ResolvedStyle, { shadows: ReturnType<typeof parseTextShadows>; key: string }>();
  let first: LayoutText | undefined;
  const fragment = (runs: LayoutText[], clips: readonly LayoutBox[], stroke: LayoutBox | null) => {
    for (const run of runs) first ??= run;
    const { style } = runs[0];
    let entry = parsed.get(style);
    if (!entry) {
      const shadows = parseTextShadows(style.textShadow, style.color);
      parsed.set(style, entry = { shadows, key: JSON.stringify(shadows) });
    }
    if (!entry.shadows.length) return;
    let groups = passes.get(first!);
    if (!groups) passes.set(first!, groups = new Map());
    let group = groups.get(entry.key);
    if (!group) groups.set(entry.key, group = { fragments: [], shadows: entry.shadows });
    group.fragments.push({ runs, clips, stroke });
  };
  const box = (node: LayoutBox, clips: readonly LayoutBox[], stroke: LayoutBox | null) => {
    const { style } = node;
    // A later box paint may cover earlier overflowing text. Keep that order;
    // runs without an intervening background/border share a shadow pass.
    if ((!isTransparent(style.backgroundColor) && style.webkitBackgroundClip !== 'text') ||
      (['Top', 'Right', 'Bottom', 'Left'] as const).some(side => hasBorder(style, side))) first = undefined;
    if (hasTextClip(style)) clips = [...clips, node];
    if (hasStrokeImage(style)) stroke = node;
    // A batched box is plain text throughout: nothing in it casts a shadow.
    if (batchedRuns(node)) {
      for (const child of node.children) first ??= child as LayoutText;
      return;
    }
    forEachFragment(node.children, (child) => {
      if (Array.isArray(child)) fragment(child, clips, stroke);
      else box(child, clips, stroke);
    });
  };
  if (root.type === 'text') fragment([root], [], null);
  else box(root, [], null);
  return passes;
}

/** Repaint one shadowed fragment onto a mask, with its threaded paints
 * resolved on the mask's own ctx. */
function paintShadowFragment(ps: PaintState, fragment: ShadowFragment): void {
  let fill: CanvasGradient | string | null = null;
  for (const block of fragment.clips) fill = blockClipPaint(ps, block) ?? fill;
  const stroke = fragment.stroke ? blockStrokePaint(ps, fragment.stroke) : null;
  paintFragment(ps, fragment.runs, fragment.runs, fill, stroke, undefined);
}

/** Measured on `ps.ctx` with the text state paint uses; `ps` keeps the ctx's
 * state consistent for the paint that may share it. */
function foregroundBounds(
  ps: PaintState, node: LayoutNode, original: LayoutNode = node,
): PaintBounds {
  if (node.type === 'box') {
    let bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
    forEachPaintedChild(node, (child, childOriginal) => {
      bounds = unionBounds(bounds, foregroundBounds(ps, child, childOriginal));
    });
    return bounds;
  }
  const y = node.y + paintLineSnap(original as LayoutText);
  ps.text(node.style);
  let bounds = textPaintBounds(ps.ctx, node.text, node.style, node.x, y, node.width, node.style.direction === 'rtl');
  if (node.lineBaselineY !== undefined) {
    bounds = unionBounds(bounds, { ...bounds, y: bounds.y + node.lineBaselineY - node.y });
  }
  return bounds;
}

/** A shadow group's fragments with their foreground ink: the caller-shadow
 * bounds and the group's own shadow both need it, so it is measured once. */
function shadowPieces(ps: PaintState, group: ShadowGroup): (ShadowFragment & ShadowPiece)[] {
  for (const fragment of group.fragments) {
    fragment.bounds ??= fragment.runs.map(run => foregroundBounds(ps, run)).reduce(unionBounds);
  }
  return group.fragments as (ShadowFragment & ShadowPiece)[];
}

export function getNodePaintBounds(
  ctx: CanvasRenderingContext2D, node: LayoutNode, passes = collectShadowPasses(node),
  ps = new PaintState(ctx, 1, false, layoutFontMetrics.get(node)),
): PaintBounds {
  let bounds = foregroundBounds(ps, node);
  for (const groups of passes.values()) for (const group of groups.values()) {
    const ink = shadowPieces(ps, group).map(piece => piece.bounds).reduce(unionBounds);
    bounds = unionBounds(bounds, shadowBounds(ink, group.shadows));
  }
  return bounds;
}

/** Insert CSS shadows before their text without reordering background paints.
 * The caller's canvas shadow belongs to the completed result.
 *
 * One save/restore around the whole draw hands the caller its ctx state back;
 * inside it, `PaintState` writes what each paint reads, with no per-run pair. */
export function renderNode(
  ctx: CanvasRenderingContext2D, node: LayoutNode,
  options: ShadowOptions & { pixelRatio?: number } = {},
): void {
  const scale = options.pixelRatio ?? 1;
  const fontMetrics = layoutFontMetrics.get(node);
  // Paint and bounds measurement share one tracker per ctx: with no caller
  // shadow they run on the same ctx, interleaved.
  const states = new Map<CanvasRenderingContext2D, PaintState>();
  const stateOf = (target: CanvasRenderingContext2D) => {
    let ps = states.get(target);
    if (!ps) states.set(target, ps = new PaintState(target, scale, false, fontMetrics));
    return ps;
  };
  // Shadow scratch canvases of this draw; none without shadows.
  let pool: ScratchPool | undefined;
  ctx.save();
  try {
    if (options.renderShadows === false) {
      withoutCanvasShadow(ctx, target => paintNode(stateOf(target), node));
      return;
    }
    pool = new ScratchPool(ctx, options.createCanvas);
    const scratch = pool;
    const passes = collectShadowPasses(node);
    const measure = stateOf(ctx);
    withCanvasShadow(ctx, () => getNodePaintBounds(ctx, node, passes, measure), target => {
      paintNode(stateOf(target), node, { beforeText: (destination, run) => {
        const groups = passes.get(run);
        if (!groups) return;
        // A mask copies the destination's dash and cap (`prepareLayer`) but
        // its fresh tracker assumes solid and butt: put the destination back
        // on that assumption first, or a dotted band painted just before
        // dashes the mask's solid strokes.
        stateOf(destination).finish();
        for (const group of groups.values()) {
          paintTextShadows(destination, shadowPieces(measure, group), group.shadows, (mask, pieces) => {
            const ps = new PaintState(mask, scale, true, fontMetrics);
            for (const piece of pieces) paintShadowFragment(ps, piece);
          }, scratch);
        }
      } });
    }, scratch);
  } finally {
    pool?.dispose();
    for (const ps of states.values()) ps.finish();
    ctx.restore();
  }
}
