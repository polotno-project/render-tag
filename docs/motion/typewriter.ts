import type { TextUnit, TextUnitPaint } from 'render-tag';
import type { Frame } from './frame.ts';

export const textUnits = 'grapheme';
export const html = `<p style="margin:0;font:400 19px/1.65 Merriweather;color:#e9ecf1">
  Typed one grapheme at a time: <b>bold</b>, <i>italic</i>,
  <span style="color:#7ec6ff">color</span>, emoji 👩🏽‍💻 and
  <span style="font:26px Lobster;color:#ffac75">script.</span></p>`;
/** A time when the text is fully typed. */
export const restMs = 7400;

const START = 500;
const TYPING = 6000;
const ERASE_AT = 9000;
const ERASING = 1100;
const LOOP = 10600;

// When each grapheme is typed: a little irregular, with a pause between words.
const typedAt = new WeakMap<TextUnit[], number[]>();
function schedule(units: TextUnit[]): number[] {
  let times = typedAt.get(units);
  if (!times) {
    let at = 0;
    times = units.map((unit, i) => {
      const s = Math.sin(i * 12.9898) * 43758.5453;
      at += 1 + (s - Math.floor(s)) + (i > 0 && unit.word !== units[i - 1].word ? 1.5 : 0);
      return at;
    });
    const total = at;
    times = times.map(at => START + (at / total) * TYPING);
    typedAt.set(units, times);
  }
  return times;
}

export function paintTextUnit({ unit, ctx, draw }: TextUnitPaint, { time, units }: Frame) {
  const t = time % LOOP;
  const times = schedule(units);
  const erased = Math.ceil(Math.max(0, t - ERASE_AT) / ERASING * units.length);
  let shown = 0;
  while (shown < units.length && times[shown] <= t) shown++;
  shown = Math.max(0, Math.min(shown, units.length - erased));

  // Typed graphemes do not move: their slice of the shaped run keeps script joins intact.
  if (unit.index < shown) draw({ slice: true });

  // The caret sits after the last typed grapheme, or before the first one.
  const caretAfter = unit.index === shown - 1;
  if (!caretAfter && !(shown === 0 && unit.index === 0)) return;
  const busy = (t > START && t < START + TYPING) || (t > ERASE_AT && t < ERASE_AT + ERASING);
  if (!busy && Math.floor(t / 500) % 2) return;
  const f = caretAfter ? unit.fragments[unit.fragments.length - 1] : unit.fragments[0];
  const atRight = caretAfter === (f.direction === 'ltr');
  ctx.fillStyle = '#4d8dff';
  ctx.fillRect((atRight ? f.x + f.width : f.x) + 1, f.y + f.height * 0.18, 2, f.height * 0.64);
}
