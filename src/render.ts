import type { ShadowOptions, LayoutNode, LayoutBox, LayoutText, ResolvedStyle } from './types.js';
import {
  hasStrokeImage,
  hasTextClip,
  layoutFontMetrics,
  isShiftedVAlign,
  paintLineSnap,
  paintsBoxBackground,
  startsMeasuredRun,
  textEdges,
} from './layout.js';
import { isTransparent, paintOrderHasStrokeFirst } from './css-resolver.js';
import { paintTextShadows, shadowBounds, shadowsOf, textPaintBounds, unionBounds, withCanvasShadow, type PaintBounds, type ShadowPiece, type TextShadow } from './shadow.js';
import { PaintState, withDraw } from './paint-state.js';
import { decorationBand, paintBand, type Band } from './decoration.js';
import { BLINK_TEXT_RUN_SHAPING, STROKE_CASTS_TEXT_SHADOW } from './engine.js';

function hasBorder(style: ResolvedStyle, side: 'Top' | 'Right' | 'Bottom' | 'Left'): boolean {
  const width = style[`border${side}Width` as keyof ResolvedStyle] as number;
  const borderStyle = style[`border${side}Style` as keyof ResolvedStyle] as string;
  return width > 0 && borderStyle !== 'none';
}

/**
 * Corner radii [TL, TR, BR, BL] for `roundRect`, or null when all square.
 * Percentages resolve per axis; overlapping radii shrink uniformly
 * (css-backgrounds §4.5), which keeps a pill a pill.
 */
function cornerRadii(
  style: ResolvedStyle, width: number, height: number,
): { x: number; y: number }[] | null {
  const {
    borderTopLeftRadius: tl, borderTopRightRadius: tr,
    borderBottomRightRadius: br, borderBottomLeftRadius: bl,
  } = style;
  // Hot path: bail before allocating.
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

/** The glyph's own fill paints nothing: both renderers decide clip-paint precedence by it. */
export function fillIsTransparent(style: ResolvedStyle): boolean {
  return isTransparent(style.webkitTextFillColor || style.color);
}

/** What fills and strokes a fragment's glyphs and clip-painted bands. */
interface TextPaints {
  /** Fill with the clip paint. */
  clipped: boolean;
  clip: CanvasGradient | string | null;
  stroke: CanvasGradient | null;
}

/**
 * Resolve a fragment's clip and stroke paints once; `gradientFill` and
 * `strokeGradient` are threaded down from declaring blocks.
 */
function textPaints(
  ps: PaintState,
  node: LayoutText,
  gradientFill: CanvasGradient | string | null | undefined,
  strokeGradient: CanvasGradient | null | undefined,
): TextPaints {
  const { style } = node;

  // An inline declarer's clip paint (layout's fragment box) beats a block's.
  const { clip: box, strokeImage } = node;
  const inlineClipPaint: CanvasGradient | string | null = box
    ? (box.image ? ps.linearGradient(box.image, box.x, box.width, box.y, box.height) : null) ??
      box.color ?? null
    : null;

  const clip = inlineClipPaint ?? gradientFill ?? null;

  // An ancestor's clip paint shows only through a transparent own fill.
  const clipped = hasTextClip(style) ||
    ((gradientFill != null || inlineClipPaint != null) && fillIsTransparent(style));

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
  const isFillTransparent = fillIsTransparent(style);

  const drawFill = () => {
    if (paints.clipped) {
      ps.fill(paints.clip || style.color);
      ctx.fillText(node.text, node.x, y);
    } else if (!isFillTransparent || ps.coverage) {
      // Chrome paints nothing for a transparent fill, even without a stroke.
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

/** One text fragment: same style, no measured-run seam, same baseline, touching. */
function sameTextFragment(a: LayoutText, b: LayoutText): boolean {
  if (b.style !== a.style || startsMeasuredRun(b) || b.y !== a.y || b.lineBaselineY !== a.lineBaselineY) return false;
  const [al, ar] = textEdges(a), [bl, br] = textEdges(b);
  return Math.abs(bl - ar) <= 0.5 || Math.abs(al - br) <= 0.5;
}

/**
 * A fragment's decoration bands, ancestors' first, each in its declarer's
 * color and style. Thickness and the underline's baseline come from the
 * declarer (one flat band, even over a `super` child it does not own); the
 * overline and line-through follow each fragment's own ascent.
 * tests/decorating-box-geometry.test.ts.
 */
function fragmentBands(
  ps: PaintState, runs: LayoutText[], snap: number, paints: TextPaints,
): { band: Band; color: string | CanvasGradient }[] {
  const head = runs[0];
  const { style } = head;
  let left = Infinity, right = -Infinity;
  for (const run of runs) {
    const [l, r] = textEdges(run);
    if (l < left) left = l;
    if (r > right) right = r;
  }
  const baseline = head.y + snap;
  const lineBaseline = head.lineBaselineY === undefined ? undefined : head.lineBaselineY + snap;
  let ascent: number | undefined;
  const bands: { band: Band; color: string | CanvasGradient }[] = [];
  for (const deco of style.textDecorations) {
    // A transparent band shows the clip paint, whatever this run's own fill.
    let color: string | CanvasGradient = deco.color;
    if (isTransparent(deco.color)) {
      if (!paints.clip) continue;
      color = paints.clip;
    }
    // `lineBaselineY` is set only on a vertical-align-shifted run.
    const underlineBaseline =
      lineBaseline !== undefined && !isShiftedVAlign(deco.declarer.verticalAlign) ? lineBaseline : baseline;
    if (deco.line !== 'underline') ascent ??= ps.fontBox(style).ascent;
    const band = decorationBand(deco, {
      baseline, underlineBaseline, fontSize: style.fontSize, ascent: ascent ?? 0, snap,
    }, left, right - left, ps.deviceScale);
    if (band) bands.push({ band, color });
  }
  return bands;
}

/** Paint a fragment in engine order: under/overlines, glyphs, line-throughs.
 * `originals` are the layout nodes behind `runs` (a batched run is a copy). */
function paintFragment(
  ps: PaintState,
  runs: LayoutText[],
  originals: LayoutText[],
  gradientFill: CanvasGradient | string | null | undefined,
  strokeGradient: CanvasGradient | null | undefined,
  beforeText: BeforeText | undefined,
): void {
  if (beforeText) for (const original of originals) beforeText(ps.ctx, original);
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

/** Called before each text fragment's paint, with each of its runs. */
type BeforeText = (ctx: CanvasRenderingContext2D, node: LayoutText) => void;

/** `box`'s children when Blink paints them as shaped runs. */
function batchedRuns(box: LayoutBox): LayoutText[] | null {
  return BLINK_TEXT_RUN_SHAPING &&
    box.children.every(child => child.type === 'text' && canShapeAsRun(child))
    ? box.children as LayoutText[] : null;
}

/** Visit the runs one fillText paints, each merged run with its first original. */
function forEachBatch(runs: LayoutText[], visit: (run: LayoutText, head: LayoutText) => void): void {
  for (let i = 0; i < runs.length; i++) {
    const head = runs[i];
    let text = head.text, width = head.width;
    while (i + 1 < runs.length && runs[i + 1].style === head.style && !startsMeasuredRun(runs[i + 1]) &&
      runs[i + 1].y === head.y && Math.abs(runs[i + 1].x - (head.x + width)) <= 0.01) {
      text += runs[i + 1].text;
      width += runs[++i].width;
    }
    visit({ ...head, text, width }, head);
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

/** Paint a box and its children; clip and stroke paints thread down from declaring blocks. */
function renderBox(
  ps: PaintState,
  box: LayoutBox,
  gradientFill: CanvasGradient | string | null = null,
  strokeGradient: CanvasGradient | null = null,
  beforeText?: BeforeText,
): void {
  const { style } = box;
  const { ctx } = ps;

  const radii = cornerRadii(style, box.width, box.height);

  if (paintsBoxBackground(style)) {
    ps.fill(style.backgroundColor);
    if (radii) {
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, radii);
      ctx.fill();
    } else {
      ctx.fillRect(box.x, box.y, box.width, box.height);
    }
  }

  // A uniform rounded border strokes the rounded path once on its centerline;
  // per-side borders on rounded corners stay straight lines (rare, and per-corner
  // color joins are not reproducible with strokes).
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

  // background-clip:text paints ALL descendant glyphs (CSS painting, not inheritance).
  if (hasTextClip(style)) gradientFill = blockClipPaint(ps, box) ?? gradientFill;

  if (hasStrokeImage(style)) strokeGradient = blockStrokePaint(ps, box);

  // Batched paint: one fillText per source run keeps shaping across spaces.
  const runs = batchedRuns(box);
  if (runs) {
    forEachBatch(runs, (run, head) => paintFragment(ps, [run], [head], gradientFill, strokeGradient, beforeText));
    return;
  }
  forEachFragment(box.children, (child) => {
    if (Array.isArray(child)) paintFragment(ps, child, child, gradientFill, strokeGradient, beforeText);
    else renderBox(ps, child, gradientFill, strokeGradient, beforeText);
  });
}

function paintNode(ps: PaintState, node: LayoutNode, beforeText?: BeforeText): void {
  if (node.type === 'text') paintFragment(ps, [node], [node], null, null, beforeText);
  else renderBox(ps, node, null, null, beforeText);
}

/** A shadowed fragment and the declaring blocks whose paints its mask re-resolves. */
interface ShadowFragment {
  runs: LayoutText[];
  /** Outermost first. */
  clips: readonly LayoutBox[];
  stroke: LayoutBox | null;
  bounds?: PaintBounds;
}

type ShadowGroup = {
  fragments: ShadowFragment[];
  shadows: TextShadow[];
};

/** Each run's shadow groups, keyed by the run they paint before. */
type ShadowPasses = Map<LayoutText, Map<string, ShadowGroup>>;

/** Every shadow group in one walk, so a mask repaints only its fragments. */
function collectShadowPasses(root: LayoutNode): ShadowPasses {
  const passes: ShadowPasses = new Map();
  const parsed = new Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>();
  let first: LayoutText | undefined;
  const fragment = (runs: LayoutText[], clips: readonly LayoutBox[], stroke: LayoutBox | null) => {
    for (const run of runs) first ??= run;
    const { style } = runs[0];
    const entry = shadowsOf(parsed, style);
    if (!entry.shadows.length) return;
    let groups = passes.get(first!);
    if (!groups) passes.set(first!, groups = new Map());
    let group = groups.get(entry.key);
    if (!group) groups.set(entry.key, group = { fragments: [], shadows: entry.shadows });
    group.fragments.push({ runs, clips, stroke });
  };
  const box = (node: LayoutBox, clips: readonly LayoutBox[], stroke: LayoutBox | null) => {
    const { style } = node;
    // A box paint may cover earlier text: it starts a new shadow pass.
    if (paintsBoxBackground(style) ||
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

/** Repaint a shadowed fragment onto a mask with paints resolved on its ctx. */
function paintShadowFragment(ps: PaintState, fragment: ShadowFragment): void {
  let fill: CanvasGradient | string | null = null;
  for (const block of fragment.clips) fill = blockClipPaint(ps, block) ?? fill;
  const stroke = fragment.stroke ? blockStrokePaint(ps, fragment.stroke) : null;
  paintFragment(ps, fragment.runs, fragment.runs, fill, stroke, undefined);
}

/** Measured through `ps`, which keeps the ctx state the paint may share. */
function foregroundBounds(
  ps: PaintState, node: LayoutNode, original: LayoutNode = node,
): PaintBounds {
  if (node.type === 'box') {
    let bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
    const runs = batchedRuns(node);
    if (runs) forEachBatch(runs, (run, head) => { bounds = unionBounds(bounds, foregroundBounds(ps, run, head)); });
    else for (const child of node.children) bounds = unionBounds(bounds, foregroundBounds(ps, child));
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

/** A group's fragments with their foreground ink, measured once. */
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
 * The caller's canvas shadow belongs to the completed result. */
export function renderNode(
  ctx: CanvasRenderingContext2D, node: LayoutNode,
  options: ShadowOptions & { pixelRatio?: number } = {},
): void {
  const scale = options.pixelRatio ?? 1;
  const fontMetrics = layoutFontMetrics.get(node);
  withDraw(ctx, options, scale, fontMetrics, (stateOf, pool) => {
    if (!pool) return paintNode(stateOf(ctx), node);
    const passes = collectShadowPasses(node);
    const measure = stateOf(ctx);
    withCanvasShadow(ctx, () => getNodePaintBounds(ctx, node, passes, measure), target => {
      paintNode(stateOf(target), node, (destination, run) => {
        const groups = passes.get(run);
        if (!groups) return;
        // The mask copies the destination's dash (`prepareLayer`) but its fresh
        // tracker assumes solid: reset the destination first.
        stateOf(destination).finish();
        for (const group of groups.values()) {
          paintTextShadows(destination, shadowPieces(measure, group), group.shadows, (mask, pieces) => {
            const ps = new PaintState(mask, scale, true, fontMetrics);
            for (const piece of pieces) paintShadowFragment(ps, piece);
          }, pool);
        }
      });
    }, pool);
  });
}
