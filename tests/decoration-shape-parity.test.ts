/**
 * Decoration SHAPES (double, dotted, dashed, wavy) against the engine's own
 * pixels, Chromium and WebKit lanes.
 *
 * The text is transparent and skip-ink is off, so each image holds the
 * decoration alone. Both images are reduced to a red-coverage mask and
 * compared two ways:
 *  - `shift`: the vertical offset that best aligns the masks — the band's
 *    POSITION error;
 *  - `error`: Σ|lib − dom| / Σ dom at that alignment — the SHAPE error (dash
 *    lengths and phase, wave period and amplitude, the double gap).
 *
 * The rules, and the DOM measurements behind them, live in src/decoration.ts.
 * Gecko keeps its own (unmeasured) shapes, so the Firefox lane skips this.
 */
import { describe, it, expect } from 'vitest';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';

function mask(canvas: HTMLCanvasElement): Float32Array {
  const { width, height } = canvas;
  const d = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const m = new Float32Array(width * height);
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Red over transparent: alpha is the coverage. Anything else is not band.
    m[p] = r > g + 60 && r > b + 60 ? d[i + 3] / 255 : 0;
  }
  return m;
}

/** Best vertical alignment of `lib` onto `dom` within ±8 device px, and its error. */
function align(lib: Float32Array, dom: Float32Array, width: number, height: number) {
  let total = 0;
  for (const v of dom) total += v;
  let best = { shift: 0, error: Infinity };
  for (let shift = -8; shift <= 8; shift++) {
    let diff = 0;
    for (let y = 0; y < height; y++) {
      const ly = y - shift;
      for (let x = 0; x < width; x++) {
        const a = ly >= 0 && ly < height ? lib[ly * width + x] : 0;
        diff += Math.abs(a - dom[y * width + x]);
      }
    }
    const error = total ? diff / total : Infinity;
    if (error < best.error - 1e-9 || (Math.abs(error - best.error) < 1e-9 && Math.abs(shift) < Math.abs(best.shift))) {
      best = { shift, error };
    }
  }
  return best;
}

/** Shift (device px) and shape error of one fixture at `dpr`. */
async function measure(html: string, width: number, height: number, dpr: number) {
  const css = await loadMultiFontCss();
  const r = await compareNativeRenders(html, css, width, height, 0.1, dpr);
  return align(mask(r.libCanvas), mask(r.domCanvas), width * dpr, height * dpr);
}

/** Both device scales the corpus and Polotno render at: Blink rounds a wave
 * tile, and WebKit a band, on the DEVICE grid. */
const DPRS = [1, 2];

const FONTS = [['Open Sans', "'Open Sans'"], ['Roboto', 'Roboto']] as const;
const SIZES = [12, 16, 20, 25, 32, 48];
const LINES = ['underline', 'overline', 'line-through'] as const;
const STYLES = ['double', 'dotted', 'dashed', 'wavy'] as const;

/**
 * Shape error budget per style and engine.
 */
const SHAPE_BUDGET: Record<(typeof STYLES)[number], number> = browserName === 'webkit'
  // WebKit's wave has the right size and period but strokes a little
  // differently (measured mean 0.40, max 0.71 — the old shape: mean 0.73).
  ? { double: 0.01, dotted: 0.01, dashed: 0.01, wavy: 0.75 }
  // Blink's dashes and double bands are pixel-exact; its wave is painted
  // from a cached tile (measured max 0.08 at DPR 1, 0.02 at DPR 2).
  : { double: 0.01, dotted: 0.01, dashed: 0.01, wavy: 0.1 };

/** The one position WebKit takes from a font table canvas cannot read
 * (src/decoration.ts: a fit, up to a CSS pixel off), in device px. */
const positionBudget = (line: string, dpr: number) =>
  browserName === 'webkit' && line === 'line-through' ? dpr : 0;

const lane = browserName === 'firefox' ? describe.skip : describe;

lane('decoration shapes match the engine', () => {
  for (const dpr of DPRS) for (const [fontName, family] of FONTS) for (const style of STYLES) for (const line of LINES) {
    it.each(SIZES)(`${fontName} ${line} ${style} @ %ipx, DPR ${dpr}`, async (size) => {
      const html =
        `<div style="font-family:${family};font-size:${size}px;line-height:${size * 2}px;color:transparent;padding:${size / 2}px 0 0 10px">` +
        `<span style="text-decoration:${line} ${style} red;text-decoration-skip-ink:none">` +
        `${'M'.repeat(Math.max(4, Math.floor(400 / size)))}</span></div>`;
      const { shift, error } = await measure(html, 480, size * 3, dpr);
      expect(Math.abs(shift), 'band position').toBeLessThanOrEqual(positionBudget(line, dpr));
      expect(error, 'band shape').toBeLessThanOrEqual(SHAPE_BUDGET[style]);
    });
  }
});

lane('a decoration restarts at each text fragment, like the engine', () => {
  // Three text fragments under one declarer: the dash fit and the wave phase
  // restart at each, and continue across the spaces inside each.
  for (const dpr of DPRS) for (const style of ['dotted', 'dashed', 'wavy'] as const) for (const pad of [10, 13.5]) {
    it(`${style}, offset ${pad}px, DPR ${dpr}`, async () => {
      const html =
        `<div style="font-family:'Open Sans';font-size:32px;line-height:64px;color:transparent;padding:10px 0 0 ${pad}px">` +
        `II<span style="text-decoration:underline ${style} red;text-decoration-skip-ink:none">MMMM <b>MMMM</b> MMMM</span></div>`;
      const { shift, error } = await measure(html, 480, 100, dpr);
      expect(Math.abs(shift), 'band position').toBe(0);
      expect(error, 'band shape').toBeLessThanOrEqual(SHAPE_BUDGET[style]);
    });
  }
});
