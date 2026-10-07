/**
 * A recording, counting Canvas 2D stand-in for the DOM-free (Node) gates:
 * `tests/node/determinism.test.ts` compares what it records, and
 * `tests/node/perf-counters.test.ts` ratchets what it counts.
 *
 * Unlike `mock-ctx.ts` (every glyph 10px, whatever the font), widths here
 * depend on everything the canvas state says: the font's size, style, weight
 * and family, `letterSpacing`, `wordSpacing` and `fontKerning` (a pair term,
 * so a string is NOT the sum of its parts). Measuring under a stale font or
 * letter-spacing therefore moves a line break instead of passing unnoticed —
 * that is the leak class a determinism gate exists to catch.
 *
 * Paint is recorded as EFFECTIVE paint: each fillText/fillRect/stroke/... is
 * logged with the state that operation reads (text state on text ops, stroke
 * state and the dash on strokes), plus the transform, the clip and — for
 * fill/stroke — the current path. A redundant `ctx.font = …` that a state
 * tracker later elides cannot change the stream; a missing one that leaves
 * stale state behind does.
 */

import type { CanvasFactory } from '../../src/types.ts';

export interface CtxCounts {
  /** Every method call and property assignment, by name (`set:font`, `fillText`). */
  calls: Record<string, number>;
  /** Total characters passed to measureText. */
  measuredChars: number;
}

/**
 * Scratch-canvas accounting through the `createCanvas` hook. A canvas's
 * pixels count as live from creation until it is resized to 0×0.
 */
export interface ScratchCounts {
  /** Canvases `createCanvas` made. */
  created: number;
  /** width × height summed over live canvases, now and at its highest. */
  livePixels: number;
  peakPixels: number;
  /** Canvases drawn onto the destination ctx (handed to the caller). */
  handed: Set<object>;
  /** Times a handed canvas was resized afterwards — a vector adapter may
   * embed it asynchronously, so this must stay 0. */
  handedThenResized: number;
}

export interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  scratch: ScratchCounts;
  /** Effective paint operations, in order. Scratch canvases record into their own. */
  paints: string[];
  counts: CtxCounts;
  /** Scratch-canvas factory for `createCanvas` — each canvas records too. */
  createCanvas: CanvasFactory;
}

/** A fresh, browser-default canvas state. */
function defaultState(): Record<string, unknown> {
  return {
    font: '10px sans-serif', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal',
    textRendering: 'auto', letterSpacing: '0px', wordSpacing: '0px', textAlign: 'start',
    textBaseline: 'alphabetic', direction: 'inherit', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    miterLimit: 10, lineDashOffset: 0, fillStyle: '#000000', strokeStyle: '#000000',
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
  };
}

type Matrix = [number, number, number, number, number, number];

const PAINT_OPS = new Set(['fillText', 'strokeText', 'fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'drawImage', 'putImageData']);
const PATH_OPS = new Set(['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'closePath']);

const TEXT_STATE = ['font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering',
  'letterSpacing', 'wordSpacing', 'textAlign', 'textBaseline', 'direction'];
const STROKE_STATE = ['strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset'];
/** State every paint reads (plus the transform). */
const COMMON_STATE = ['globalAlpha', 'globalCompositeOperation', 'filter',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'clip'];
const OP_STATE: Record<string, string[]> = {
  fillText: [...TEXT_STATE, 'fillStyle'],
  strokeText: [...TEXT_STATE, ...STROKE_STATE],
  fillRect: ['fillStyle'],
  fill: ['fillStyle'],
  strokeRect: STROKE_STATE,
  stroke: STROKE_STATE,
  drawImage: ['imageSmoothingEnabled', 'imageSmoothingQuality'],
};
const STROKES = new Set(['strokeText', 'strokeRect', 'stroke']);

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Deterministic width of `text` under a canvas state (see file header). */
export function stateWidth(state: Record<string, unknown>, text: string): number {
  const font = String(state.font);
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '10');
  // A stable per-face factor in [0.9, 1.1): style, weight and family all move it.
  let hash = 0;
  for (const ch of font.replace(/\d+(?:\.\d+)?px/, '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const face = 0.9 + (hash % 200) / 1000;
  const letterSpacing = parseFloat(String(state.letterSpacing)) || 0;
  const wordSpacing = parseFloat(String(state.wordSpacing)) || 0;
  const kern = state.fontKerning !== 'none';
  let width = 0;
  let prev = -1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Combining marks and joiners are zero-advance, as in a real font.
    const zero = (cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f || cp === 0xad;
    if (!zero) width += size * (0.42 + ((cp * 37) % 13) * 0.025) * face;
    width += letterSpacing;
    if (cp === 0x20) width += wordSpacing;
    if (kern && prev >= 0 && (prev * 7 + cp) % 17 === 0) width -= size * 0.06;
    prev = cp;
  }
  return width;
}

/** A canonical string for a recorded argument or state value. Scratch
 * canvases and gradients describe themselves by content, never by identity. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => describe(v)).join(',')}]`;
  if (typeof value === 'object') {
    const self = (value as { __describe?: () => string }).__describe;
    if (self) return self();
    return `{${Object.keys(value).sort().map((k) => `${k}:${describe((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return typeof value;
}

export function recordingCtx(width = 800, height = 800): RecordingCtx {
  const counts: CtxCounts = { calls: {}, measuredChars: 0 };
  const count = (name: string) => { counts.calls[name] = (counts.calls[name] ?? 0) + 1; };

  const scratch: ScratchCounts = { created: 0, livePixels: 0, peakPixels: 0, handed: new Set(), handedThenResized: 0 };

  function makeContext(canvas: { width: number; height: number }, paints: string[], destination = false): CanvasRenderingContext2D {
    let state = defaultState();
    let matrix: Matrix = [1, 0, 0, 1, 0, 0];
    let dash: number[] = [];
    let path: string[] = [];
    const stack: { state: Record<string, unknown>; matrix: Matrix; dash: number[] }[] = [];

    // Only the state an operation actually reads: a font left behind does
    // not change a stroke(), and a stale fillStyle does not change strokeText.
    const snapshot = (op: string) => {
      const keys = [...COMMON_STATE, ...(OP_STATE[op] ?? [])];
      return keys.map((k) => `${k}=${describe(state[k])}`).join(';') +
        `;matrix=${matrix.join(',')}` + (STROKES.has(op) ? `;dash=${dash.join(',')}` : '');
    };

    const methods: Record<string, (...args: any[]) => unknown> = {
      save() { stack.push({ state: { ...state }, matrix: [...matrix] as Matrix, dash: [...dash] }); },
      restore() {
        const top = stack.pop();
        if (top) ({ state, matrix, dash } = top);
      },
      measureText(text: string) {
        counts.measuredChars += text.length;
        const w = stateWidth(state, text);
        const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? '10');
        return {
          width: w,
          actualBoundingBoxAscent: size * 0.72, actualBoundingBoxDescent: size * 0.2,
          fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.25,
          actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
          emHeightAscent: size * 0.8, emHeightDescent: size * 0.2,
          alphabeticBaseline: 0, hangingBaseline: size * 0.6, ideographicBaseline: -size * 0.2,
        };
      },
      scale(x: number, y: number) { matrix = multiply(matrix, [x, 0, 0, y, 0, 0]); },
      translate(x: number, y: number) { matrix = multiply(matrix, [1, 0, 0, 1, x, y]); },
      rotate(a: number) { const c = Math.cos(a), s = Math.sin(a); matrix = multiply(matrix, [c, s, -s, c, 0, 0]); },
      transform(a: number, b: number, c: number, d: number, e: number, f: number) { matrix = multiply(matrix, [a, b, c, d, e, f]); },
      setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
        matrix = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b!, c!, d!, e!, f!];
      },
      resetTransform() { matrix = [1, 0, 0, 1, 0, 0]; },
      getTransform() { const [a, b, c, d, e, f] = matrix; return { a, b, c, d, e, f }; },
      setLineDash(segments: number[]) { dash = [...segments]; },
      getLineDash() { return [...dash]; },
      beginPath() { path = []; },
      clip() { state = { ...state, clip: [...(state.clip as string[] ?? []), path.join(' ')] }; },
      createLinearGradient(...args: number[]) {
        const stops: string[] = [];
        return {
          addColorStop(offset: number, color: string) { stops.push(`${offset} ${color}`); },
          __describe: () => `linear(${args.join(',')}|${stops.join(',')})`,
        };
      },
    };

    const target: Record<string | symbol, unknown> = { canvas };
    return new Proxy(target, {
      get(_t, key) {
        if (key === 'canvas') return canvas;
        if (typeof key !== 'string') return undefined;
        if (Object.hasOwn(methods, key) || PAINT_OPS.has(key) || PATH_OPS.has(key)) {
          return (...args: unknown[]) => {
            count(key);
            if (PATH_OPS.has(key)) {
              path.push(`${key}(${args.map((a) => describe(a)).join(',')})@${matrix.join(',')}`);
              return undefined;
            }
            if (PAINT_OPS.has(key)) {
              if (destination && key === 'drawImage') scratch.handed.add(args[0] as object);
              const shape = key === 'fill' || key === 'stroke' ? ` path=${path.join(' ')}` : '';
              paints.push(`${key}(${args.map((a) => describe(a)).join(',')})${shape} | ${snapshot(key)}`);
              return undefined;
            }
            return methods[key](...args);
          };
        }
        return state[key];
      },
      set(_t, key, value) {
        if (typeof key !== 'string') return false;
        count(`set:${key}`);
        state[key] = value;
        return true;
      },
      has(_t, key) {
        return key === 'canvas' || (typeof key === 'string' &&
          (Object.hasOwn(methods, key) || PAINT_OPS.has(key) || PATH_OPS.has(key) || key in state));
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  const paints: string[] = [];
  const ctx = makeContext({ width, height }, paints, true);

  const createCanvas = (w: number, h: number) => {
    const scratchPaints: string[] = [];
    let size = { width: 0, height: 0 };
    const resize = (next: { width: number; height: number }) => {
      if (scratch.handed.has(canvas)) scratch.handedThenResized++;
      scratch.livePixels += next.width * next.height - size.width * size.height;
      scratch.peakPixels = Math.max(scratch.peakPixels, scratch.livePixels);
      size = next;
    };
    const canvas = {
      get width() { return size.width; },
      set width(value: number) { resize({ ...size, width: value }); },
      get height() { return size.height; },
      set height(value: number) { resize({ ...size, height: value }); },
      getContext: () => scratchContext,
    };
    scratch.created++;
    resize({ width: w, height: h });
    // Described when drawn, by its size and content: a scratch canvas is
    // painted after it is created.
    Object.defineProperty(canvas, '__describe', {
      value: () => `canvas(${canvas.width}x${canvas.height}){${scratchPaints.join(' / ')}}`,
    });
    const scratchContext = makeContext(canvas, scratchPaints);
    return canvas as unknown as OffscreenCanvas;
  };

  return { ctx, scratch, paints, counts, createCanvas };
}
