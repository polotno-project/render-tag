import { layout, drawLayout, type LayoutBox, type LayoutLineBox } from 'render-tag';

function collectLines(box: LayoutBox): LayoutLineBox[] {
  return [
    ...(box.lineBoxes ?? []),
    ...box.children.flatMap(child => child.type === 'box' ? collectLines(child) : []),
  ];
}

export function initLayoutDemo(): void {
  const stage = document.getElementById('layout-preview')!;
  const slider = document.getElementById('layout-width') as HTMLInputElement;
  const widthValue = document.getElementById('layout-width-value')!;
  const dimensions = document.getElementById('layout-dimensions')!;
  const html = '<p style="font-family:Playfair Display;font-size:32px;line-height:1.4;margin:0">Make room for <i>bigger</i>, <strong>bolder ideas.</strong></p>';
  function update(): void {
    const width = Number(slider.value);
    const result = layout({ html, width });
    const lines = collectLines(result.layoutRoot);
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.ceil((width + 32) * ratio);
    canvas.height = Math.ceil((result.height + 32) * ratio);
    canvas.style.width = `${width + 32}px`;
    canvas.style.height = `${result.height + 32}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.translate(16, 16);
    ctx.fillStyle = '#edf3ff';
    ctx.strokeStyle = '#b9ceff';
    ctx.lineWidth = 1;
    for (const line of lines) {
      ctx.fillRect(line.x, line.y, line.width, line.height);
      ctx.strokeRect(line.x, line.y, line.width, line.height);
    }
    drawLayout({ layout: result, width, ctx, pixelRatio: ratio });
    stage.replaceChildren(canvas);
    stage.setAttribute('aria-label', `${lines.length} measured line boxes. Content height: ${result.height.toFixed(1)} pixels.`);
    dimensions.textContent = `height ${result.height.toFixed(1)}px`;
    widthValue.textContent = String(width);
  }
  slider.addEventListener('input', update);
  update();
}
