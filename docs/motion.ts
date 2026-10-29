import { layout, drawLayout, type LayoutResult, type TextUnitLevel, type TextUnitPaint } from 'render-tag';
import type { Frame } from './motion/frame.ts';
import { highlightCode } from './site-utils.ts';
import * as assemble from './motion/assemble.ts';
import * as captions from './motion/captions.ts';
import * as rise from './motion/rise.ts';
import * as typewriter from './motion/typewriter.ts';
import * as wipe from './motion/wipe.ts';
import assembleSource from './motion/assemble.ts?raw';
import captionsSource from './motion/captions.ts?raw';
import riseSource from './motion/rise.ts?raw';
import typewriterSource from './motion/typewriter.ts?raw';
import wipeSource from './motion/wipe.ts?raw';

interface Sample {
  html: string;
  textUnits: TextUnitLevel;
  restMs: number;
  paintTextUnit(paint: TextUnitPaint, frame: Frame): void;
}

// Each card shows the file it runs.
const SAMPLES: Record<string, [Sample, string]> = {
  assemble: [assemble, assembleSource],
  captions: [captions, captionsSource],
  rise: [rise, riseSource],
  typewriter: [typewriter, typewriterSource],
  wipe: [wipe, wipeSource],
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

interface Card { step(dt: number): boolean }

const playing = new Set<Card>();
let previous = 0;
function tick(now: number): void {
  const dt = previous ? Math.min(64, now - previous) : 0;
  previous = now;
  for (const card of playing) if (!card.step(dt)) playing.delete(card);
  if (playing.size) requestAnimationFrame(tick);
  else previous = 0;
}
function play(card: Card): void {
  if (!playing.size) requestAnimationFrame(tick);
  playing.add(card);
}

function motionCard(element: HTMLElement, sample: Sample, source: string): void {
  const stage = element.querySelector<HTMLElement>('.motion-stage')!;
  const meta = element.querySelector<HTMLElement>('[data-frame-time]')!;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  stage.replaceChildren(canvas);
  highlightCode(element.querySelector<HTMLElement>('.feature-source code')!, source.trim());

  let result: LayoutResult | undefined;
  let width = 0;
  let pad = 0;
  let top = 0;
  let ratio = 1;
  // With reduced motion a card shows its text at rest and moves only on Replay.
  let time = reducedMotion.matches ? sample.restMs : 0;
  let visible = false;
  let hovering = false;
  const pointer = { x: 0, y: 0, strength: 0 };
  let cost = 0;
  let frames = 0;
  let shownAt = 0;

  function paint(): void {
    if (!result) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, pad * ratio, top * ratio);
    const frame: Frame = {
      time, units: result.textUnits ?? [], width, height: result.height,
      pointer: pointer.strength > 0.001 ? pointer : null,
    };
    const start = performance.now();
    drawLayout({ layout: result, width, ctx, pixelRatio: ratio, paintTextUnit: paint => sample.paintTextUnit(paint, frame) });
    cost += performance.now() - start;
    frames++;
    const now = performance.now();
    if (now - shownAt > 500) {
      const average = cost / frames;
      meta.textContent = average < 0.1 ? '<0.1 ms' : `${average.toFixed(1)} ms`;
      cost = frames = 0;
      shownAt = now;
    }
  }

  function resize(): void {
    const stageWidth = stage.clientWidth;
    if (!stageWidth) return;
    pad = stageWidth > 600 ? 40 : 28;
    if (stageWidth - pad * 2 !== width || !result) {
      width = stageWidth - pad * 2;
      try {
        result = layout({ html: sample.html, width, textUnits: sample.textUnits });
      } catch (error) {
        stage.textContent = 'Preview unavailable.';
        console.warn('Could not lay out a motion sample', error);
        return;
      }
      const needed = Math.ceil(result.height + pad * 2);
      if (stage.clientHeight < needed) stage.style.minHeight = `${needed}px`;
    }
    ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(stageWidth * ratio);
    canvas.height = Math.round(stage.clientHeight * ratio);
    top = (stage.clientHeight - result.height) / 2;
    paint();
  }

  const card: Card = {
    step(dt) {
      time += dt;
      pointer.strength += ((hovering ? 1 : 0) - pointer.strength) * Math.min(1, dt / 150);
      const settled = reducedMotion.matches && time >= sample.restMs;
      if (settled) time = sample.restMs;
      paint();
      return visible && !settled;
    },
  };

  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !reducedMotion.matches) play(card);
  }, { threshold: 0.2 }).observe(stage);
  element.querySelector('.motion-replay')!.addEventListener('click', () => {
    time = 0;
    play(card);
  });
  stage.addEventListener('pointermove', event => {
    if (reducedMotion.matches) return;
    const box = stage.getBoundingClientRect();
    pointer.x = event.clientX - box.left - pad;
    pointer.y = event.clientY - box.top - top;
    hovering = true;
  });
  stage.addEventListener('pointerleave', () => { hovering = false; });
}

export function initMotion(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-motion]')) {
    const entry = SAMPLES[element.dataset.motion ?? ''];
    if (entry) motionCard(element, ...entry);
  }
  const loop = document.getElementById('motion-loop');
  if (loop) highlightCode(loop, loop.textContent ?? '');
}
