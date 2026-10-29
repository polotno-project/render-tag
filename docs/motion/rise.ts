import type { TextUnitPaint } from 'render-tag';
import type { Frame } from './frame.ts';

export const textUnits = 'word';
export const html = `<p style="margin:0;font:400 25px/1.5 'Playfair Display';color:#e9ecf1">
  Every word rises with its <b>weight</b>, its <i>slant</i>, its
  <span style="background-image:linear-gradient(90deg,#4d8dff,#c46bff);
    background-clip:text;color:transparent">gradient</span>,
  its <span style="text-decoration:underline wavy #ff6b8b">underline</span>
  and its <span style="color:#fff;text-shadow:0 0 12px #4d8dff,0 0 2px #4d8dff">glow.</span></p>`;
/** A time when every word has risen. */
export const restMs = 3800;

const LOOP = 5600;
const FADE_AT = 4700;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function paintTextUnit({ unit, ctx, draw }: TextUnitPaint, { time }: Frame) {
  const t = time % LOOP;
  const p = 1 - (1 - clamp01((t - 200 - unit.index * 80) / 900)) ** 3;
  const out = clamp01((t - FADE_AT - unit.index * 20) / 450) ** 2;
  if (p <= 0 || out >= 1) return;
  ctx.globalAlpha *= p * (1 - out);
  ctx.translate(0, 24 * (1 - p) - 10 * out);
  const blur = 8 * (1 - p) + 4 * out;
  if (blur > 0.1) ctx.filter = `blur(${blur}px)`;
  draw();
}
