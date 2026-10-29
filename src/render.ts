import type { ShadowOptions, LayoutNode, LayoutBox, LayoutText, ResolvedStyle, TextUnit, TextUnitPaint } from './types.js';
import {
  hasStrokeImage,
  hasTextClip,
  layoutFontMetrics,
  paintLineSnap,
  hasVisibleBorder, paintsBoxBackground,
  RUN_PIECES,
  startsMeasuredRun,
  textEdges,
  type UnitPiece,
  type UnitRun,
} from './layout.js';
import { isOpaque, isTransparent, paintOrderHasStrokeFirst } from './css-resolver.js';
import { castCanvasShadow, hasCanvasShadow, hasTextShadow, paintTextShadows, shadowBounds, shadowsOf, textPaintBounds, unionBounds, withCanvasShadow, withoutCanvasShadow, type PaintBounds, type ScratchPool, type ShadowPiece, type TextShadow } from './shadow.js';
import { PaintState, withDraw } from './paint-state.js';
import { fragmentBands, paintBand, type Band } from './decoration.js';
import { BLINK_TEXT_RUN_SHAPING, STROKE_CASTS_TEXT_SHADOW } from './engine.js';

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

/** What paints a run's glyphs and its clip-painted bands. */
export interface TextPaints {
  /** The glyph fill; null paints none. */
  fill: CanvasGradient | string | null;
  /** The nearest background-clip:text paint, which a transparent band shows. */
  clip: CanvasGradient | string | null;
  stroked: boolean;
  /** The --rt-text-stroke-image gradient, over the stroke color. */
  strokeImage: CanvasGradient | null;
}

/**
 * Both renderers' precedence. The clip paint fills a run that declares the
 * clip, or whose own fill is transparent under a declaring ancestor. A
 * transparent fill paints nothing (Chrome, even with a stroke) except on a
 * coverage mask, where every glyph is its own shadow's shape; Blink's mask
 * omits the stroke (STROKE_CASTS_TEXT_SHADOW).
 */
export function glyphPaints(
  ps: PaintState, style: ResolvedStyle, clip: CanvasGradient | string | null, strokeImage: CanvasGradient | null,
): TextPaints {
  const clipped = hasTextClip(style) || (clip != null && fillIsTransparent(style));
  const fill = clipped ? clip || style.color
    : !fillIsTransparent(style) || ps.coverage ? textFillColor(style) : null;
  const stroked = style.webkitTextStrokeWidth > 0 && (!ps.coverage || STROKE_CASTS_TEXT_SHADOW);
  return { fill, clip, stroked, strokeImage };
}

/** A fragment's paints: an inline declarer's (layout's fragment box) beats a declaring block's. */
function textPaints(
  ps: PaintState,
  node: LayoutText,
  gradientFill: CanvasGradient | string | null | undefined,
  strokeGradient: CanvasGradient | null | undefined,
): TextPaints {
  const { clip: box, strokeImage } = node;
  const inlineClip = box
    ? (box.image ? ps.linearGradient(box.image, box.x, box.width, box.y, box.height) : null) ?? box.color ?? null
    : null;
  const inlineStroke = strokeImage
    ? ps.linearGradient(strokeImage.image, strokeImage.x, strokeImage.width, strokeImage.y, strokeImage.height)
    : null;
  return glyphPaints(ps, node.style, inlineClip ?? gradientFill ?? null, inlineStroke ?? strokeGradient ?? null);
}

/** Fill and stroke `text` at (x, y) with `paints`, in the style's paint order. */
export function paintGlyphs(
  ps: PaintState, style: ResolvedStyle, text: string, x: number, y: number, paints: TextPaints,
): void {
  const { ctx } = ps;
  const fill = () => { if (paints.fill) { ps.fill(paints.fill); ctx.fillText(text, x, y); } };
  const stroke = () => { if (paints.stroked) { ps.textStroke(style, paints.strokeImage); ctx.strokeText(text, x, y); } };
  if (paintOrderHasStrokeFirst(style.paintOrder)) { stroke(); fill(); }
  else { fill(); stroke(); }
}

/** One text fragment: same style, no measured-run seam, same baseline, touching. */
function sameTextFragment(a: LayoutText, b: LayoutText): boolean {
  if (b.style !== a.style || startsMeasuredRun(b) || b.y !== a.y || b.lineBaselineY !== a.lineBaselineY) return false;
  const [al, ar] = textEdges(a), [bl, br] = textEdges(b);
  return Math.abs(bl - ar) <= 0.5 || Math.abs(al - br) <= 0.5;
}

/** A fragment's bands across its runs' extent, colored; a transparent entry shows the clip paint or nothing. */
function coloredBands(
  ps: PaintState, head: LayoutText, left: number, right: number, snap: number, paints: TextPaints,
): { band: Band; color: string | CanvasGradient }[] {
  // `lineBaselineY` is set only on a vertical-align-shifted run.
  const lineBaseline = head.lineBaselineY === undefined ? undefined : head.lineBaselineY + snap;
  const bands: { band: Band; color: string | CanvasGradient }[] = [];
  for (const { band, deco } of fragmentBands(ps, head.style, left, right - left, head.y + snap, snap, lineBaseline)) {
    const color = isTransparent(deco.color) ? paints.clip : deco.color;
    if (color) bands.push({ band, color });
  }
  return bands;
}

/**
 * Paint `glyphs` with the bands of the fragment `runs` in engine order: under/overlines,
 * glyphs, line-throughs. `slice` clips the bands to a text unit's part of the fragment.
 */
function paintRuns(
  ps: PaintState, runs: LayoutText[], glyphs: LayoutText[], paints: TextPaints, slice?: UnitPiece[],
): void {
  let bands: { band: Band; color: string | CanvasGradient }[] | null = null;
  let left = Infinity, right = -Infinity;
  if (runs[0].style.textDecorations.length) {
    for (const run of runs) {
      const [l, r] = textEdges(run);
      if (l < left) left = l;
      if (r > right) right = r;
    }
    bands = coloredBands(ps, runs[0], left, right, paintLineSnap(runs[0]), paints);
  }
  if (bands) paintBands(ps, bands, false, left, right, slice);
  for (const run of glyphs) {
    ps.text(run.style);
    paintGlyphs(ps, run.style, run.text, run.x, run.y + paintLineSnap(run), paints);
  }
  if (bands) paintBands(ps, bands, true, left, right, slice);
}

/** The line-throughs of `bands` (`through`), else the rest; `slice` clips them. */
function paintBands(
  ps: PaintState, bands: { band: Band; color: string | CanvasGradient }[], through: boolean,
  left: number, right: number, slice?: UnitPiece[],
): void {
  const own = bands.filter(({ band }) => (band.line === 'line-through') === through);
  if (!own.length) return;
  // A gradient's stops are not read here: not opaque.
  if (slice) clipToSlice(ps, slice, left, right, own.every(({ color }) => typeof color === 'string' && isOpaque(color)));
  for (const { band, color } of own) paintBand(ps, band, color);
  if (slice) ps.restore();
}

const ORDINARY_SHAPING_TEXT =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Mark}\p{Number}\p{Punctuation}\p{Separator}]+$/u;

/** `runs` is one `sameTextFragment`: one style for all of them. */
function canShapeAsRun(runs: LayoutText[]): boolean {
  if (!BLINK_TEXT_RUN_SHAPING) return false;
  const { style } = runs[0];
  if (style.direction !== 'ltr' || style.textAlign === 'justify' ||
    style.textDecorations.length !== 0 || style.webkitTextStrokeWidth !== 0) return false;
  return runs.every((node) => !node.clip && !node.strokeImage && ORDINARY_SHAPING_TEXT.test(node.text));
}

/** Called before each text fragment's paint, with its original head. */
type BeforeText = (ctx: CanvasRenderingContext2D, node: LayoutText) => void;

/**
 * Visit the runs one fillText paints, each merged run with its first original. `runs` is
 * one `sameTextFragment` (one style, one baseline, no seam), so only adjacency splits it.
 */
function forEachBatch(runs: LayoutText[], visit: (run: LayoutText, head: LayoutText) => void): void {
  for (let i = 0; i < runs.length; i++) {
    const head = runs[i];
    const first = i;
    let text = head.text, width = head.width;
    while (i + 1 < runs.length && Math.abs(runs[i + 1].x - (head.x + width)) <= 0.01) {
      text += runs[i + 1].text;
      width += runs[++i].width;
    }
    visit(i === first ? head : { ...head, text, width }, head);
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

/**
 * Group a box's text children into the fragments `paintRuns` paints. On
 * Blink a plain fragment paints one fillText per measured run (`forEachBatch`),
 * which keeps shaping across its spaces; `head` is the original first node
 * behind `runs` (a merged run is a copy). `batched: false` visits whole fragments.
 */
function forEachFragment(
  children: LayoutNode[],
  visitBox: (box: LayoutBox) => void,
  visitText: (runs: LayoutText[], head: LayoutText) => void,
  batched = true,
): void {
  for (let i = 0; i < children.length;) {
    const child = children[i];
    if (child.type === 'box') {
      visitBox(child);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < children.length && children[j].type === 'text' &&
      sameTextFragment(children[j - 1] as LayoutText, children[j] as LayoutText)) j++;
    const runs = children.slice(i, j) as LayoutText[];
    if (batched && canShapeAsRun(runs)) forEachBatch(runs, (run, head) => visitText([run], head));
    else visitText(runs, child);
    i = j;
  }
}

/** A box's background and border. */
function paintSurface(ps: PaintState, box: LayoutBox): void {
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

  // A uniform border is one stroke on its centerline: four side strokes would
  // double a translucent color at the corners. Per-side borders on rounded
  // corners stay straight lines (rare, and per-corner color joins are not
  // reproducible with strokes).
  const w = style.borderTopWidth, line = style.borderTopStyle, color = style.borderTopColor;
  const uniformBorder = w > 0 && line !== 'none' &&
    style.borderRightWidth === w && style.borderBottomWidth === w && style.borderLeftWidth === w &&
    style.borderRightStyle === line && style.borderBottomStyle === line && style.borderLeftStyle === line &&
    style.borderRightColor === color && style.borderBottomColor === color && style.borderLeftColor === color;
  if (uniformBorder) {
    ps.stroke(color, w);
    if (radii) {
      ctx.beginPath();
      ctx.roundRect(
        box.x + w / 2, box.y + w / 2, box.width - w, box.height - w,
        radii.map((r) => ({ x: Math.max(0, r.x - w / 2), y: Math.max(0, r.y - w / 2) })),
      );
      ctx.stroke();
    } else {
      ctx.strokeRect(box.x + w / 2, box.y + w / 2, box.width - w, box.height - w);
    }
  } else if (style.borderTopWidth || style.borderRightWidth || style.borderBottomWidth || style.borderLeftWidth) {
    const { borderTopWidth: t, borderRightWidth: r, borderBottomWidth: b, borderLeftWidth: l } = style;
    const borders: [width: number, line: string, color: string, x1: number, y1: number, x2: number, y2: number][] = [
      [t, style.borderTopStyle, style.borderTopColor, box.x, box.y + t / 2, box.x + box.width, box.y + t / 2],
      [r, style.borderRightStyle, style.borderRightColor, box.x + box.width - r / 2, box.y, box.x + box.width - r / 2, box.y + box.height],
      [b, style.borderBottomStyle, style.borderBottomColor, box.x, box.y + box.height - b / 2, box.x + box.width, box.y + box.height - b / 2],
      [l, style.borderLeftStyle, style.borderLeftColor, box.x + l / 2, box.y, box.x + l / 2, box.y + box.height],
    ];
    for (const [width, sideLine, sideColor, x1, y1, x2, y2] of borders) {
      if (!(width > 0 && sideLine !== 'none')) continue;
      ps.stroke(sideColor, width);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
}

/** Paint a node and its descendants; clip and stroke paints reach text from declaring blocks. */
function paintNode(ps: PaintState, node: LayoutNode, beforeText?: BeforeText): void {
  // Fragments under one declarer chain share its arrays: resolve its paints once.
  let declarers: TextFragment | undefined;
  let paints: ReturnType<typeof blockPaints> = [null, null];
  walkPaintRegions(node, true, box => paintSurface(ps, box), (fragment, head) => {
    if (fragment.clips !== declarers?.clips || fragment.stroke !== declarers.stroke) {
      declarers = fragment;
      paints = blockPaints(ps, fragment);
    }
    // A batch's first original run anchors shadow insertion; batches keep its LINE_TOP.
    beforeText?.(ps.ctx, head);
    paintRuns(ps, fragment.runs, fragment.runs, textPaints(ps, fragment.runs[0], paints[0], paints[1]));
  });
}

/** A text fragment and the blocks declaring its clip and stroke paints, resolved per ctx
 * (`blockPaints`): a mask or a canvas-shadow layer makes its own gradients. */
interface TextFragment {
  runs: LayoutText[];
  /** background-clip:text declarers, outermost first. */
  clips: readonly LayoutBox[];
  stroke: LayoutBox | null;
}

interface ShadowFragment extends TextFragment {
  bounds?: PaintBounds;
}

type ShadowGroup = {
  fragments: ShadowFragment[];
  shadows: TextShadow[];
};

/** Each run's shadow groups, keyed by the run they paint before. */
type ShadowPasses = Map<LayoutText, Map<string, ShadowGroup>>;

/** A text-shadow somewhere under `node`. */
function castsTextShadow(node: LayoutNode): boolean {
  return node.type === 'text' ? hasTextShadow(node.style) : node.children.some(castsTextShadow);
}

/** Every shadow group in one walk, so a mask repaints only its fragments. */
function collectShadowPasses(root: LayoutNode): ShadowPasses {
  const passes: ShadowPasses = new Map();
  if (!castsTextShadow(root)) return passes;
  const parsed = new Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>();
  let first: LayoutText | undefined;
  walkPaintRegions(root, true, () => { first = undefined; }, (fragment, head) => {
    first ??= head;
    const entry = shadowsOf(parsed, fragment.runs[0].style);
    if (!entry.shadows.length) return;
    let groups = passes.get(first);
    if (!groups) passes.set(first, groups = new Map());
    let group = groups.get(entry.key);
    if (!group) groups.set(entry.key, group = { fragments: [], shadows: entry.shadows });
    group.fragments.push(fragment);
  });
  return passes;
}

/**
 * `root` in paint order: `surface` at each box that paints a background or border (it may
 * cover earlier text, so it starts a new paint region), `text` at each fragment with its
 * declarers. `batched` visits Blink's paint batches (`forEachFragment`), else whole fragments.
 */
function walkPaintRegions(
  root: LayoutNode, batched: boolean,
  surface: (box: LayoutBox) => void,
  text: (fragment: TextFragment, head: LayoutText) => void,
): void {
  const box = (node: LayoutBox, clips: readonly LayoutBox[], stroke: LayoutBox | null) => {
    const { style } = node;
    if (paintsBoxBackground(style) || hasVisibleBorder(style)) surface(node);
    if (hasTextClip(style)) clips = [...clips, node];
    if (hasStrokeImage(style)) stroke = node;
    forEachFragment(node.children, child => box(child, clips, stroke),
      (runs, head) => text({ runs, clips, stroke }, head), batched);
  };
  if (root.type === 'text') text({ runs: [root], clips: [], stroke: null }, root);
  else box(root, [], null);
}

/** A fragment's block clip and stroke paints, resolved on `ps`'s ctx. */
function blockPaints(ps: PaintState, fragment: TextFragment): [CanvasGradient | string | null, CanvasGradient | null] {
  let fill: CanvasGradient | string | null = null;
  for (const block of fragment.clips) fill = blockClipPaint(ps, block) ?? fill;
  return [fill, fragment.stroke ? blockStrokePaint(ps, fragment.stroke) : null];
}

/** A fragment with its `blockPaints`, on a ctx of its own (a mask, a layer). */
function paintTextFragment(ps: PaintState, fragment: TextFragment): void {
  paintRuns(ps, fragment.runs, fragment.runs, textPaints(ps, fragment.runs[0], ...blockPaints(ps, fragment)));
}

/** Measured through `ps`, which keeps the ctx state the paint may share. */
function foregroundBounds(ps: PaintState, node: LayoutNode): PaintBounds {
  if (node.type === 'box') {
    let bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
    const add = (child: LayoutNode) => { bounds = unionBounds(bounds, foregroundBounds(ps, child)); };
    forEachFragment(node.children, add, runs => runs.forEach(add));
    return bounds;
  }
  const y = node.y + paintLineSnap(node);
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
 * The caller's canvas shadow belongs to the completed result (per unit with
 * `paintTextUnit`). */
export function renderNode(
  ctx: CanvasRenderingContext2D, node: LayoutNode,
  options: ShadowOptions & { pixelRatio?: number; paintTextUnit?: (paint: TextUnitPaint) => void } = {},
): void {
  const scale = options.pixelRatio ?? 1;
  const fontMetrics = layoutFontMetrics.get(node);
  // A tracker for a scratch layer: pooled canvases are reused within a draw.
  const layerState = (target: CanvasRenderingContext2D, coverage = false) =>
    new PaintState(target, scale, coverage, fontMetrics);
  withDraw(ctx, options, scale, fontMetrics, (stateOf, pool) => {
    if (options.paintTextUnit) return new UnitPainter(stateOf(ctx), pool, layerState, options.paintTextUnit).draw(node);
    if (!pool) return paintNode(stateOf(ctx), node);
    const passes = collectShadowPasses(node);
    const measure = stateOf(ctx);
    const beforeText: BeforeText = (destination, run) => {
      const groups = passes.get(run);
      if (!groups) return;
      for (const group of groups.values()) {
        paintTextShadows(destination, shadowPieces(measure, group), group.shadows, (mask, pieces) => {
          const ps = layerState(mask, true);
          for (const piece of pieces) paintTextFragment(ps, piece);
        }, pool);
      }
    };
    withCanvasShadow(ctx, () => getNodePaintBounds(ctx, node, passes, measure), target => {
      paintNode(stateOf(target), node, passes.size ? beforeText : undefined);
    }, pool);
  });
}

// ── Text units (`paintTextUnit`) ──

/** One unit's part of a paint region: per fragment, its pieces in reading order and whether
 * the fragment paints in Blink's batches (`canShapeAsRun`). */
type UnitShare = { fragment: TextFragment; pieces: UnitPiece[]; batched: boolean }[];

/**
 * Paints a layout made with text units: the paint walk (`walkPaintRegions`), but a paint
 * region's text (everything between two box surfaces) is held, then painted unit by unit
 * through the caller's callback: every unit's shadows (text-shadows and the ctx's own, from
 * the unit's paint), then every unit's text. Box surfaces paint in place.
 */
class UnitPainter {
  private readonly held: TextFragment[] = [];
  private readonly shadowCache = new Map<ResolvedStyle, { shadows: TextShadow[]; key: string }>();

  constructor(
    private readonly ps: PaintState,
    private readonly pool: ScratchPool | null,
    private readonly layerState: (target: CanvasRenderingContext2D, coverage?: boolean) => PaintState,
    private readonly paint: (paint: TextUnitPaint) => void,
  ) {}

  draw(root: LayoutNode): void {
    walkPaintRegions(root, false, box => {
      this.flush();
      this.withCanvasShadow(() => box, ps => paintSurface(ps, box));
    }, fragment => this.held.push(fragment));
    this.flush();
  }

  /** Paint the held region: shadows of every unit, then text of every unit. */
  private flush(): void {
    if (!this.held.length) return;
    const { ps, pool } = this;
    const shares = new Map<TextUnit, UnitShare>();
    // Runs no unit claims (white space only): painted in place, after the units.
    const unclaimed: TextFragment[] = [];
    for (const fragment of this.held) {
      const loose = fragment.runs.filter(run => !(run as UnitRun)[RUN_PIECES]);
      if (loose.length) unclaimed.push({ ...fragment, runs: loose });
      const batched = canShapeAsRun(fragment.runs);
      for (const run of fragment.runs) {
        for (const piece of (run as UnitRun)[RUN_PIECES] ?? []) {
          let share = shares.get(piece.unit);
          if (!share) shares.set(piece.unit, share = []);
          if (share.at(-1)?.fragment !== fragment) share.push({ fragment, pieces: [], batched });
          share.at(-1)!.pieces.push(piece);
        }
      }
    }
    this.held.length = 0;
    const units = [...shares].sort(([a], [b]) => a.index - b.index);
    // A shadow phase for every unit: a callback may set the ctx shadow itself.
    if (pool) for (const [unit, share] of units) this.call(unit, 'shadow', () => this.drawShadows(share, pool));
    for (const [unit, share] of units) {
      this.call(unit, 'text', fill => {
        const paint = () => { for (const entry of share) paintPieces(ps, entry, fill); };
        if (hasCanvasShadow(ps.ctx)) withoutCanvasShadow(ps.ctx, paint);
        else paint();
      });
    }
    // The callbacks' restores undid what render-tag wrote inside them.
    ps.forget();
    for (const fragment of unclaimed) {
      this.withCanvasShadow(() => fragment.runs.map(run => foregroundBounds(ps, run)).reduce(unionBounds),
        target => paintTextFragment(target, fragment));
    }
  }

  /** The caller's callback, in a save/restore; each draw forgets what render-tag knew of the ctx. */
  private call(unit: TextUnit, phase: 'shadow' | 'text', draw: (fill?: string | CanvasGradient) => void): void {
    const { ps } = this;
    ps.ctx.save();
    try {
      this.paint({ unit, ctx: ps.ctx, phase, draw: (override) => { ps.forget(); draw(override?.fill); } });
    } finally {
      ps.ctx.restore();
    }
  }

  /** `paint` on the ctx, its canvas shadow (if any) cast from it alone. */
  private withCanvasShadow(bounds: () => PaintBounds, paint: (ps: PaintState) => void): void {
    const { ps, pool } = this;
    // Without a pool, `withDraw` already holds the ctx shadow off.
    if (!pool) return paint(ps);
    withCanvasShadow(ps.ctx, bounds, target => paint(target === ps.ctx ? ps : this.layerState(target)), pool);
  }

  /** A unit's text-shadows, and the ctx's own shadow cast from the unit's whole paint. */
  private drawShadows(share: UnitShare, pool: ScratchPool): void {
    const { ps } = this;
    const groups = new Map<string, { shadows: TextShadow[]; items: (ShadowPiece & UnitShare[number])[] }>();
    for (const entry of share) {
      const { shadows, key } = shadowsOf(this.shadowCache, entry.fragment.runs[0].style);
      if (!shadows.length) continue;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { shadows, items: [] });
      group.items.push({ ...entry, bounds: this.inkOf([entry]) });
    }
    const cast = (target: PaintState) => {
      for (const { shadows, items } of groups.values()) {
        paintTextShadows(target.ctx, items, shadows, (mask, inside) => {
          const coverage = this.layerState(mask, true);
          for (const item of inside) paintPieces(coverage, item);
        }, pool);
      }
    };
    const bounds = () => [...groups.values()]
      .map(({ shadows, items }) => shadowBounds(items.map(item => item.bounds).reduce(unionBounds), shadows))
      .reduce(unionBounds, this.inkOf(share));
    castCanvasShadow(ps.ctx, bounds, target => {
      const layer = this.layerState(target);
      cast(layer);
      for (const entry of share) paintPieces(layer, entry);
    }, pool);
    if (groups.size) withoutCanvasShadow(ps.ctx, () => cast(ps));
  }

  /** The ink of a share's pieces (layout px). */
  private inkOf(share: UnitShare): PaintBounds {
    return share.flatMap(({ pieces }) => pieces.map(piece => foregroundBounds(this.ps, piece.run))).reduce(unionBounds);
  }
}

/** A unit's pieces of one fragment (`paintRuns`): bands keep the whole fragment's geometry,
 * so dashes and waves keep their phase, clipped to the unit's slice. */
function paintPieces(ps: PaintState, { fragment, pieces, batched }: UnitShare[number], fill?: string | CanvasGradient): void {
  const paints = textPaints(ps, fragment.runs[0], ...blockPaints(ps, fragment));
  const unit = pieces[0].unit;
  const sliced = !fragment.runs.every(run => (run as UnitRun)[RUN_PIECES]?.every(piece => piece.unit === unit));
  const own = pieces.filter(piece => !piece.space).map(piece => piece.run);
  const glyphs: LayoutText[] = batched ? [] : own;
  if (batched) forEachBatch(own, run => glyphs.push(run));
  paintRuns(ps, fragment.runs, glyphs, fill && paints.fill ? { ...paints, fill } : paints, sliced ? pieces : undefined);
}

/**
 * Clip to the pieces' slices of the fragment from `start` to `end`. Only edges between units
 * are cut: axis-aligned, on the device grid, so resting neighbours meet without a seam; rotated
 * or skewed, a device pixel past the edge, under the neighbour, when the paint is `opaque` at
 * full alpha (a translucent overlap would darken more than the seam lightens). Unbounded
 * across the line, as no band's shape is guessed. Leaves a `ps.save()` open.
 */
function clipToSlice(ps: PaintState, pieces: UnitPiece[], start: number, end: number, opaque: boolean): void {
  const { ctx } = ps;
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const aligned = !m || (m.b === 0 && m.c === 0 && m.a !== 0);
  const toGrid = m && aligned
    ? (x: number) => (Math.round(m.a * x + m.e) - m.e) / m.a
    : (x: number) => x;
  const scale = m ? Math.hypot(m.a, m.b) : 1;
  const reach = aligned || !opaque || ctx.globalAlpha < 1 || !scale ? 0 : 1 / scale;
  const slices = pieces.map(piece => [piece.left, piece.right]).sort((a, b) => a[0] - b[0]);
  ps.save();
  ctx.beginPath();
  for (let i = 0; i < slices.length;) {
    const left = slices[i][0];
    let right = slices[i][1];
    while (++i < slices.length && slices[i][0] <= right + 0.5) right = Math.max(right, slices[i][1]);
    const x0 = left <= start ? -1e6 : toGrid(left) - reach;
    const x1 = right >= end ? 1e6 : toGrid(right) + reach;
    ctx.rect(x0, -1e6, x1 - x0, 2e6);
  }
  ctx.clip();
}
