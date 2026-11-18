import type { AnyCanvas, LayoutText, ResolvedStyle } from './types.js';
import type { PaintState } from './paint-state.js';
import { isEmojiCluster } from './layout/segment.js';

// `text-decoration-skip-ink: auto`. Blink asks Skia where each glyph's outline crosses the
// band (`Font::GetTextIntercepts`, cached per glyph); a canvas has no outlines, so a glyph is
// painted into a scratch canvas and the band's rows are read back, once per glyph and draw.

/**
 * Device px per em a glyph is read at. Over 256 Skia paints a glyph as its outline; under it,
 * as a cached mask, which macOS smooths wider than the outline: gaps then differ from Chrome's
 * by a few px wherever a stroke grazes the band (skip-ink-parity).
 */
const GLYPH_PX = 320;
/** Scratch px per layout px at least, for text already that large. */
const MIN_SCALE = 4;
/** Coverage under this is not ink. */
const INK_ALPHA = 12;
/** The scratch canvas's width: one read-back window. */
const SCRATCH_WIDTH = 8192;

/** Blink's `CanTextDecorationSkipInk`: a band never skips these (CJK by script here, not Blink's
 * ideograph-or-symbol table). */
const NEVER_SKIPPED = /[/\\_\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/** One draw's ink reader: a scratch canvas of its own (read back, so kept off the GPU). */
export class InkProbe {
  /** A fragment's crossings per band stripe, by the fragment's first run. */
  readonly crossings = new Map<LayoutText, Map<string, [number, number][]>>();
  /** The read glyphs (`glyphRows`) by rows and `PaintState.face`. */
  private readonly read = new Map<string, Map<string, Float64Array | null>>();
  private canvas?: AnyCanvas;
  private ps?: PaintState;

  constructor(
    private readonly makeCanvas: (width: number, height: number) => AnyCanvas,
    /** A coverage tracker for a scratch ctx. */
    private readonly stateOf: (ctx: CanvasRenderingContext2D) => PaintState,
  ) {}

  /**
   * A reader of where a grapheme in `style` has ink between `top` and `bottom` (from its
   * baseline), from its origin: one span, as Skia's intercept is a glyph's whole extent in the
   * stripe (the two sides of a `g`'s loop are one crossing). Null: none.
   */
  glyphs(style: ResolvedStyle, top: number, bottom: number): (g: string) => readonly [number, number] | null {
    // One read per whole px of rows: each line's sub-pixel position moves its stripe a little.
    const first = Math.floor(top), end = Math.max(first + 1, Math.ceil(bottom));
    // Each element has a style of its own: the read glyphs are shared by font.
    const key = `${first},${end},${this.scratch(1, 1).face(style)}`;
    let known = this.read.get(key);
    if (!known) this.read.set(key, known = new Map());
    return (g) => {
      let rows = known.get(g);
      if (rows === undefined) known.set(g, rows = this.glyphRows(style, g, first, end));
      if (!rows) return null;
      const perPx = rows.length / 2 / (end - first);
      const from = Math.round((top - first) * perPx);
      let left = Infinity, right = -Infinity;
      for (let row = from; row < Math.max(from + 1, Math.round((bottom - first) * perPx)) && row * 2 < rows.length; row++) {
        if (rows[row * 2] < left) left = rows[row * 2];
        if (rows[row * 2 + 1] > right) right = rows[row * 2 + 1];
      }
      return left <= right ? [left, right] : null;
    };
  }

  /** The ink of `g` from `top` to `bottom`: per scratch row its [left, right] from the glyph's
   * origin, [Infinity, -Infinity] where the row has none. Null: no ink at all. */
  private glyphRows(style: ResolvedStyle, g: string, top: number, bottom: number): Float64Array | null {
    // A color glyph has no outline for Skia to cross.
    if (NEVER_SKIPPED.test(g) || isEmojiCluster(g)) return null;
    const measured = this.scratch(1, 1);
    measured.glyph(style);
    // Its ink box first: most glyphs never reach an underline's rows.
    const box = measured.ctx.measureText(g);
    if (box.actualBoundingBoxDescent <= top || -box.actualBoundingBoxAscent >= bottom) return null;
    // WebKit can leave a synthetic italic's shear out of the box: room on both sides.
    const room = style.fontSize / 4;
    const x = -box.actualBoundingBoxLeft - room;
    const scale = Math.max(MIN_SCALE, GLYPH_PX / style.fontSize);
    const width = Math.min(SCRATCH_WIDTH, Math.ceil((box.actualBoundingBoxRight + room - x) * scale));
    const height = Math.round((bottom - top) * scale);
    const data = this.pixels(top, x, width, height, scale, (scratch) => {
      scratch.glyph(style);
      scratch.fill('#000');
      scratch.ctx.fillText(g, 0, 0);
    });
    const rows = new Float64Array(height * 2);
    let inked = false;
    for (let row = 0; row < height; row++) {
      const alpha = row * width * 4 + 3;
      let from = 0, to = width - 1;
      while (from < width && data[alpha + from * 4] < INK_ALPHA) from++;
      while (to > from && data[alpha + to * 4] < INK_ALPHA) to--;
      inked ||= from < width;
      // A partly covered edge column holds its ink on the inner side.
      rows[row * 2] = from < width ? x + (from + 1 - data[alpha + from * 4] / 255) / scale : Infinity;
      rows[row * 2 + 1] = from < width ? x + (to + data[alpha + to * 4] / 255) / scale : -Infinity;
    }
    return inked ? rows : null;
  }

  /**
   * The x spans (layout px, ascending) where what `paint` draws has ink in the
   * rows from `top` to `bottom`, between `left` and `right`, read with an em `GLYPH_PX` tall.
   */
  columns(
    top: number, bottom: number, left: number, right: number, em: number, paint: (ps: PaintState) => void,
  ): [number, number][] {
    const scale = Math.max(MIN_SCALE, GLYPH_PX / em);
    const height = Math.max(1, Math.round((bottom - top) * scale));
    const out: [number, number][] = [];
    for (let x = left; x < right; x += SCRATCH_WIDTH / scale) {
      const width = Math.min(SCRATCH_WIDTH, Math.ceil((right - x) * scale));
      const data = this.pixels(top, x, width, height, scale, paint);
      let start = -1, last = 0;
      for (let column = 0; column <= width; column++) {
        let alpha = 0;
        if (column < width) {
          for (let i = column * 4 + 3; i < data.length; i += width * 4) if (data[i] > alpha) alpha = data[i];
        }
        if (alpha >= INK_ALPHA) {
          // A partly covered edge column holds its ink on the inner side.
          if (start < 0) start = column + 1 - alpha / 255;
          last = alpha;
        } else if (start >= 0) {
          const from = x + start / scale, to = x + (column - 1 + last / 255) / scale;
          // A span cut by the window's edge goes on.
          if (out.length && from - out[out.length - 1][1] < 1 / scale) out[out.length - 1][1] = to;
          else out.push([from, to]);
          start = -1;
        }
      }
    }
    return out;
  }

  /** The pixels of what `paint` draws, `width` by `height` at `scale`, from layout (`x`, `top`). */
  private pixels(
    top: number, x: number, width: number, height: number, scale: number, paint: (ps: PaintState) => void,
  ): Uint8ClampedArray {
    const ps = this.scratch(width, height);
    const { ctx } = ps;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, -x * scale, -top * scale);
    paint(ps);
    return ctx.getImageData(0, 0, width, height).data;
  }

  /** The scratch ctx's tracker, the canvas at least `width` by `height`. */
  private scratch(width: number, height: number): PaintState {
    if (!this.ps || this.canvas!.width < width || this.canvas!.height < height) {
      const canvas = this.canvas ??= this.makeCanvas(width, height);
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error('render-tag: createCanvas must provide a 2D canvas.');
      // Resizing reset the ctx: a new tracker.
      this.ps = this.stateOf(ctx);
    }
    return this.ps;
  }

  dispose(): void {
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
  }
}
