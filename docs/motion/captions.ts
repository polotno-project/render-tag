import type { TextUnitPaint } from 'render-tag';
import type { Frame } from './frame.ts';

export const textUnits = 'word';
export const html = `<p style="margin:0;text-align:center;font:900 30px/1.3 Roboto;
  text-transform:uppercase;color:#fff;-webkit-text-stroke:7px #101113;
  paint-order:stroke fill">Captions that follow every word you say</p>`;
/** A time when every word has been said. */
export const restMs = 4600;

const LOOP = 5600;
const START = 400;
const WORD = 380;

export function paintTextUnit({ unit, ctx, draw }: TextUnitPaint, { time }: Frame) {
  const t = (time % LOOP) - START;
  const said = Math.floor(t / WORD); // the word being said
  if (unit.index > said) {
    ctx.globalAlpha *= 0.4;
    return draw();
  }
  if (unit.index < said) return draw();

  // The word being said pops and turns yellow; its stroke keeps its color.
  const k = Math.min(1, (t - said * WORD) / 160);
  const pop = 1 + 0.14 * (1 - (1 - k) ** 3) + 0.06 * Math.sin(k * Math.PI);
  const cx = unit.x + unit.width / 2;
  const cy = unit.y + unit.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(-0.035 * k);
  ctx.scale(pop, pop);
  ctx.translate(-cx, -cy);
  draw({ fill: '#ffd60a' });
}
