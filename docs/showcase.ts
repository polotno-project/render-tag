import { render } from 'render-tag';
import { drawTextOnPath } from 'render-tag/path';
import { highlightCode } from './site-utils.ts';

const PATH_HTML = '<span style="font-family:Playfair Display;font-size:30px">Words take <i style="color:#0057ff">shape.</i></span>';
const PATH = 'M20,135 Q200,0 380,135';

export function renderPathExample(width = 400): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ratio = window.devicePixelRatio || 1;
  const scale = width / 400;
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(170 * scale * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${170 * scale}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio * scale, ratio * scale);
  ctx.strokeStyle = '#c7d8ff';
  ctx.setLineDash([3, 5]);
  ctx.stroke(new Path2D(PATH));
  ctx.setLineDash([]);
  drawTextOnPath({ html: PATH_HTML, path: PATH, align: 'center', ctx });
  return canvas;
}

export function pathExampleSource(): string {
  return `import { drawTextOnPath } from 'render-tag/path';

const canvas = document.createElement('canvas');
canvas.width = 400;
canvas.height = 170;
const ctx = canvas.getContext('2d');

// Optional guide for the curve.
ctx.strokeStyle = '#c7d8ff';
ctx.setLineDash([3, 5]);
ctx.stroke(new Path2D('${PATH}'));
ctx.setLineDash([]);

drawTextOnPath({
  html: '${PATH_HTML}',
  path: '${PATH}',
  align: 'center',
  ctx,
});`;
}

const EXAMPLES = {
  hello: `<p style="font:48px Playfair Display;
  text-align:center;margin:0;padding:32px 0">
  Hello <strong>world</strong>
</p>`,
  gradient: `<p style="font:900 52px Roboto;
  text-align:center;margin:0;padding:32px 0;
  background-image:linear-gradient(90deg,#0057ff,#b94bff);
  background-clip:text;color:transparent">
  Make it vivid.
</p>`,
};

function initCodeExample(): void {
  const stage = document.getElementById('showcase-render')!;
  const source = document.getElementById('showcase-source')!;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-example]')];
  function select(mode: string): void {
    const path = mode === 'path';
    const html = EXAMPLES[mode as keyof typeof EXAMPLES];
    if (!path && !html) return;
    const canvas = path ? renderPathExample() : render({ html, width: 400, height: 140 }).canvas as HTMLCanvasElement;
    const code = path ? pathExampleSource() : `import { render } from 'render-tag';

const html = \`${html}\`;
const { canvas } = render({ html, width: 400, height: 140 });
document.body.appendChild(canvas);`;
    highlightCode(source, code);
    stage.replaceChildren(canvas);
    document.getElementById('example-dimensions')!.textContent = `400 × ${path ? 170 : 140}`;
    stage.setAttribute('aria-label', path ? 'Canvas example: Words take shape, drawn along a curve.' : `Canvas example: ${mode === 'hello' ? 'Hello world.' : 'Make it vivid, with a gradient fill.'}`);
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.example === mode));
  }
  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.example!));
  select('hello');
}

function initHero(): void {
  const stage = document.getElementById('specimen-stage')!;
  const html = `<div style="padding:22px;color:#101113">
    <p style="font-family:Playfair Display;font-size:42px;line-height:1.18;margin:0 0 24px">Rich <strong>text.</strong><br><i>Canvas 2D.</i></p>
    <p style="font-family:Roboto;font-size:20px;line-height:1.6;margin:0 0 18px">Mix <strong>weights</strong>, <i>styles</i> and <span style="color:#0057ff">colors.</span><br><span style="background:#fff0a6;padding:1px 3px">Highlight</span> <u>what matters.</u></p>
    <p style="font-family:Lobster;font-size:28px;line-height:1.4;color:#0057ff;margin:0">Lobster.</p>
  </div>`;
  const canvas = render({ html, width: 400, height: 300 }).canvas as HTMLCanvasElement;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  stage.replaceChildren(canvas);
}

export function initShowcase(): void {
  initHero();
  initCodeExample();

}
