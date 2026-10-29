import type { TextUnitPaint } from 'render-tag';
import type { Frame } from './frame.ts';

export const textUnits = 'line';
export const html = `<div style="font:500 22px/1.75 Roboto;color:#e9ecf1">
  <p style="margin:0">Every line wipes in its own direction.</p>
  <p dir="rtl" style="margin:0">كل سطر في اتجاهه.</p>
  <p dir="rtl" style="margin:0">כל שורה בכיוון שלה.</p>
  <p style="margin:0">Mixed: hello <span style="color:#7ec6ff">مرحبا</span> world.</p></div>`;
/** A time when every line is revealed. */
export const restMs = 3800;

const LOOP = 5600;
const FADE_AT = 4700;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function paintTextUnit({ unit, ctx, draw }: TextUnitPaint, { time }: Frame) {
  const t = time % LOOP;
  const k = clamp01((t - 250 - unit.index * 420) / 900);
  const p = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
  if (p <= 0) return;
  ctx.globalAlpha *= 1 - clamp01((t - FADE_AT) / 500);
  if (p >= 1) return draw();

  // Reveal from the line's start edge (the left for LTR, the right for RTL)
  // while the line slides in behind the edge.
  const rtl = unit.fragments[0].direction === 'rtl';
  const span = (unit.width + 16) * p;
  const front = rtl ? unit.x + unit.width + 8 - span : unit.x - 8 + span;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rtl ? front : unit.x - 40, unit.y - unit.height / 2, span + 32, unit.height * 2);
  ctx.clip();
  ctx.translate((rtl ? 1 : -1) * 24 * (1 - p), 0);
  draw();
  ctx.restore();

  // A light on the moving edge.
  ctx.globalAlpha *= Math.sin(Math.PI * p);
  ctx.fillStyle = '#7aa7ff';
  ctx.fillRect(front - 1, unit.y + unit.height * 0.15, 2, unit.height * 0.7);
}
