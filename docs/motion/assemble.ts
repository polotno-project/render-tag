import type { TextUnitPaint } from 'render-tag';
import type { Frame } from './frame.ts';

export const textUnits = 'grapheme';
export const html = `<p style="margin:0;text-align:center;font-family:'Playfair Display';
  font-weight:900;font-size:clamp(34px,10vw,96px);line-height:1.05;
  background-image:linear-gradient(100deg,#4d8dff,#b94bff 55%,#ff6b8b);
  background-clip:text;color:transparent">Every letter<br><i>finds its place.</i></p>`;
/** A time when every letter is in place. */
export const restMs = 3000;

const LOOP = 8400;
const SCATTER_AT = 7200;

// Render-tag may call back more than once a frame: a unit gets the same numbers every time.
const random = (index: number, salt: number) => {
  const s = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function paintTextUnit({ unit, ctx, draw }: TextUnitPaint, { time, width, height, pointer }: Frame) {
  const t = time % LOOP;
  const delay = random(unit.index, 0) * 500;
  const arrive = 1 - (1 - clamp01((t - delay) / 1100)) ** 4;
  const leave = clamp01((t - SCATTER_AT - delay / 2) / 700) ** 3;
  const p = Math.min(arrive, 1 - leave); // 0: scattered, 1: in place
  if (p <= 0) return;
  const q = 1 - p;

  // Letters near the pointer lift and grow.
  const cx = unit.x + unit.width / 2;
  const baseline = unit.fragments[0].baseline;
  const d = pointer ? Math.hypot(cx - pointer.x, unit.y + unit.height / 2 - pointer.y) : Infinity;
  const lift = pointer ? pointer.strength * p * Math.exp(-(d * d) / 9000) : 0;

  const scale = (1 + (random(unit.index, 4) * 2 - 0.8) * q) * (1 + 0.35 * lift);
  ctx.globalAlpha *= Math.min(1, p * 2);
  ctx.translate(
    cx + (random(unit.index, 1) - 0.5) * width * q,
    baseline + (random(unit.index, 2) - 0.5) * height * 3 * q - unit.height * 0.25 * lift,
  );
  ctx.rotate((random(unit.index, 3) - 0.5) * 3 * q);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -baseline);
  // At rest, paint the letter's slice of its shaped run: kerning and ligatures as drawLayout.
  draw({ slice: q === 0 && lift < 0.01 });
}
