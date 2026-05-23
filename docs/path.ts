import { drawTextOnPath } from '../src/path/index.ts';

/**
 * Visual sandbox for render-tag/path. Each demo:
 *  1. Renders the canvas version via drawTextOnPath.
 *  2. Renders an SVG ground-truth side-by-side using <textPath>.
 *  3. Optionally overlays the raw path so you can see how text follows it.
 */

interface Demo {
  title: string;
  html: string;
  path: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  width: number;
  height: number;
  bg?: string;
}

const DEMOS: Demo[] = [
  {
    title: 'Plain text on a quadratic arc',
    html: `<span style="font: 600 32px 'Playfair Display', serif; color: #1a1a1a">Hello, curves</span>`,
    path: 'M40,160 Q300,40 560,160',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Rich-text colors + bold inline',
    html: `<span style="font: 28px 'Merriweather', serif; color: #444">The <b style="color:#d33">red</b> fox jumps <i style="color:#37a">over</i> the path</span>`,
    path: 'M40,160 C140,40 460,40 560,160',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Semicircle (top arc) — align: center',
    html: `<span style="font: 500 26px sans-serif; color: #1a1a1a">RENDER · TAG · ON · PATH</span>`,
    path: 'M80,180 A180,180 0 0 1 520,180',
    align: 'center',
    width: 600, height: 220,
  },
  {
    title: 'Semicircle (bottom arc) — text reads under the curve',
    html: `<span style="font: 500 26px sans-serif; color: #1a1a1a">curves are wonderful</span>`,
    path: 'M80,40 A180,180 0 0 0 520,40',
    align: 'center',
    width: 600, height: 220,
  },
  {
    title: 'Background-color on inline span',
    html: `<span style="font: 600 28px sans-serif">Highlight <span style="background-color:#ffd54a;color:#222;padding:0 4px">important</span> words</span>`,
    path: 'M40,140 Q300,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Text-shadow (multi-shadow stack)',
    html: `<span style="font: 700 36px 'Lobster', cursive; color: #ff5e5b; text-shadow: 2px 2px 0 #fff, 4px 4px 0 #2a2a2a">Sunset boulevard</span>`,
    path: 'M40,160 Q300,80 560,160',
    align: 'center',
    width: 600, height: 220,
  },
  {
    title: 'Underline + line-through + overline',
    html: `<span style="font: 26px sans-serif; color:#222"><span style="text-decoration:underline">underline</span> <span style="text-decoration:line-through;text-decoration-color:#d33">struck</span> <span style="text-decoration:overline">over</span></span>`,
    path: 'M40,140 Q300,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Wavy decoration',
    html: `<span style="font: 30px sans-serif; color:#222; text-decoration:underline; text-decoration-style:wavy; text-decoration-color:#d33">wavy thoughts</span>`,
    path: 'M40,140 C140,40 460,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Dotted + dashed decorations',
    html: `<span style="font: 28px sans-serif; color:#222"><span style="text-decoration:underline;text-decoration-style:dotted">dotted</span> and <span style="text-decoration:underline;text-decoration-style:dashed">dashed</span></span>`,
    path: 'M40,140 Q300,60 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Gradient text along the path',
    html: `<span style="font:800 64px 'Playfair Display', serif; -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-image:linear-gradient(to right, #ff5e5b, #ffd54a, #4ecdc4)">Sunset</span>`,
    path: 'M40,180 C140,60 460,60 560,180',
    align: 'center',
    width: 600, height: 240,
  },
  {
    title: 'Stroke + fill paint-order',
    html: `<span style="font:800 48px sans-serif; color: #fff; -webkit-text-stroke-width:6px; -webkit-text-stroke-color:#2a2a2a; paint-order:stroke">BOLD</span>`,
    path: 'M40,140 Q300,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Letter-spacing along the curve',
    html: `<span style="font: 600 26px sans-serif; letter-spacing: 4px; color:#1a1a1a">S P A C E D</span>`,
    path: 'M40,140 C140,40 460,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Arabic — cursive joining preserved',
    html: `<span style="font: 36px sans-serif; color:#1a1a1a">مرحبا بك في العالم</span>`,
    path: 'M40,160 Q300,60 560,160',
    align: 'center',
    width: 600, height: 220,
  },
  {
    title: 'Hebrew — RTL on a curve',
    html: `<span style="font: 32px sans-serif; color:#1a1a1a">שלום עולם</span>`,
    path: 'M40,140 Q300,60 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Thai — combining marks',
    html: `<span style="font: 32px sans-serif; color:#1a1a1a">สวัสดีชาวโลก</span>`,
    path: 'M40,140 C140,40 460,40 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Hindi (Devanagari) — reordering + conjuncts',
    html: `<span style="font: 32px sans-serif; color:#1a1a1a">नमस्ते दुनिया</span>`,
    path: 'M40,140 Q300,60 560,140',
    align: 'center',
    width: 600, height: 200,
  },
  {
    title: 'Closed path (circle) — text wrapping around',
    html: `<span style="font: 500 22px sans-serif; color:#1a1a1a">render • tag • on • a • circular • path • again • and • again • </span>`,
    path: 'M300,30 A170,170 0 1 1 299,30 Z',
    align: 'left',
    width: 600, height: 380,
  },
  {
    title: 'Spiral — long curving path',
    html: `<span style="font: 500 18px sans-serif; color:#1a1a1a">spiraling text follows the curve, glyph by glyph, smoothly along the tangent direction</span>`,
    path: 'M300,200 m-10,0 a10,10 0 1 1 20,0 a30,30 0 1 1 -40,-10 a50,50 0 1 1 60,30 a90,90 0 1 1 -120,-60 a140,140 0 1 1 200,90',
    align: 'left',
    width: 600, height: 400,
  },
  {
    title: 'align: left vs justify (justify spreads to fill)',
    html: `<span style="font: 26px sans-serif; color:#1a1a1a">spread out evenly</span>`,
    path: 'M40,140 L560,140',
    align: 'justify',
    width: 600, height: 200,
  },
];

const root = document.getElementById('root')!;
const showPathToggle = document.getElementById('showPath') as HTMLInputElement;
const textBaselineSelect = document.getElementById('textBaseline') as HTMLSelectElement;

function mount() {
  root.innerHTML = '';
  for (const d of DEMOS) {
    const section = document.createElement('div');
    section.className = 'demo';
    const heading = document.createElement('h2');
    heading.textContent = d.title;
    section.appendChild(heading);

    const compare = document.createElement('div');
    compare.className = 'compare';

    // Canvas side
    const canvasWrap = document.createElement('div');
    const canvasLabel = document.createElement('div');
    canvasLabel.className = 'demo-label';
    canvasLabel.textContent = 'render-tag/path (canvas)';
    canvasWrap.appendChild(canvasLabel);
    const canvas = document.createElement('canvas');
    canvas.className = 'demo-canvas';
    canvas.width = d.width * 2;
    canvas.height = d.height * 2;
    canvas.style.width = `${d.width}px`;
    canvas.style.height = `${d.height}px`;
    canvasWrap.appendChild(canvas);
    compare.appendChild(canvasWrap);

    // SVG side (ground truth via <textPath>)
    const svgWrap = document.createElement('div');
    const svgLabel = document.createElement('div');
    svgLabel.className = 'demo-label';
    svgLabel.textContent = 'SVG <textPath> (reference)';
    svgWrap.appendChild(svgLabel);
    const svgEl = buildSvg(d);
    svgEl.classList.add('demo-canvas');
    svgWrap.appendChild(svgEl);
    compare.appendChild(svgWrap);

    section.appendChild(compare);
    root.appendChild(section);

    paintCanvas(canvas, d);
  }
}

function paintCanvas(canvas: HTMLCanvasElement, d: Demo) {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(2, 2);

  if (showPathToggle.checked) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 100, 220, 0.25)';
    ctx.lineWidth = 1;
    const p = new Path2D(d.path);
    ctx.stroke(p);
    ctx.restore();
  }

  drawTextOnPath({
    html: d.html,
    path: d.path,
    ctx,
    align: d.align ?? 'left',
    textBaseline: textBaselineSelect.value as any,
  });
}

function buildSvg(d: Demo): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${d.width} ${d.height}`);
  svg.setAttribute('width', String(d.width));
  svg.setAttribute('height', String(d.height));

  // Reusable path
  const defs = document.createElementNS(svgNS, 'defs');
  const pathEl = document.createElementNS(svgNS, 'path');
  const pathId = `p-${Math.random().toString(36).slice(2)}`;
  pathEl.setAttribute('id', pathId);
  pathEl.setAttribute('d', d.path);
  pathEl.setAttribute('fill', 'none');
  defs.appendChild(pathEl);
  svg.appendChild(defs);

  if (showPathToggle.checked) {
    const overlay = document.createElementNS(svgNS, 'use');
    overlay.setAttribute('href', `#${pathId}`);
    overlay.setAttribute('stroke', 'rgba(0, 100, 220, 0.25)');
    overlay.setAttribute('stroke-width', '1');
    svg.appendChild(overlay);
  }

  // Strip outer span styles & render via foreignObject-style — actually
  // textPath only supports limited styling. We'll best-effort by extracting
  // text and applying the outermost inline styles to the textPath element.
  // Most styles we care about (font, color, decoration) are honored as SVG
  // attributes; gradients/shadows differ from CSS canvas behavior so this
  // is a "ground truth" only for the simpler cases.
  const tmp = document.createElement('div');
  tmp.innerHTML = d.html;
  const outer = tmp.firstElementChild as HTMLElement | null;
  const text = document.createElementNS(svgNS, 'text');
  if (outer) text.setAttribute('style', outer.getAttribute('style') || '');

  const textPath = document.createElementNS(svgNS, 'textPath');
  textPath.setAttribute('href', `#${pathId}`);
  if (d.align === 'center') textPath.setAttribute('text-anchor', 'middle');
  if (d.align === 'right') textPath.setAttribute('text-anchor', 'end');
  if (d.align === 'center' || d.align === 'right') textPath.setAttribute('startOffset', d.align === 'center' ? '50%' : '100%');

  textPath.innerHTML = outer?.innerHTML ?? d.html;
  text.appendChild(textPath);
  svg.appendChild(text);
  return svg;
}

showPathToggle.addEventListener('change', mount);
textBaselineSelect.addEventListener('change', mount);
// Re-render once fonts are ready so curve text uses the loaded fonts.
document.fonts.ready.then(mount);
mount();
