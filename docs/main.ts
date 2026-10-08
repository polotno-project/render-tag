import { render } from 'render-tag';
import { initShowcase, renderPathExample, pathExampleSource } from './showcase.ts';
import { initLayoutDemo } from './layout-demo.ts';
import { initBenchmark } from './performance.ts';
import { loadSiteFonts, initCopyButtons, initCodeTabs, highlightCode } from './site-utils.ts';

// ── Feature demos ──

const FEATURES: Record<string, { html: string; css?: string }> = {
  'rich-text': {
    html: `<p style="font-size: 16px; line-height: 1.6;">
  <strong>Bold text</strong>, <em>italic text</em>,
  <span style="color: #e74c3c;">red color</span>,
  <span style="background: #ffeaa7; padding: 1px 4px;">highlighted</span>, and
  <span style="font-size: 22px; font-weight: 700; color: #2d3436;">large bold</span> inline.
</p>`,

  },
  'text-decorations': {
    html: `<p style="font-size: 15px; line-height: 2;"><span style="text-decoration: underline;">Underline</span> <span style="text-decoration: line-through;">Strikethrough</span> <span style="text-decoration: overline;">Overline</span><br><span style="text-decoration: underline wavy #e74c3c;">Wavy red</span> <span style="text-decoration: underline dotted #3498db;">Dotted blue</span> <span style="text-decoration: underline dashed #27ae60;">Dashed green</span></p>`,

  },
  lists: {
    html: `<ul style="font-size: 14px; padding-left: 20px;">
  <li>First item</li>
  <li>Second item
    <ol style="padding-left: 20px;">
      <li>Nested ordered</li>
      <li>Another nested</li>
    </ol>
  </li>
  <li><strong>Bold</strong> list item</li>
</ul>`,

  },
  'mixed-fonts': {
    html: `<div style="line-height: 1.7;">
  <p style="font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700; margin: 0 0 4px 0;">Playfair Display</p>
  <p style="font-family: 'Roboto', sans-serif; font-size: 15px; margin: 0 0 4px 0;">Roboto regular and <strong>bold</strong></p>
  <p style="font-family: 'Merriweather', serif; font-size: 14px; font-style: italic; margin: 0 0 4px 0;">Merriweather italic serif</p>
  <p style="font-family: 'Lobster', cursive; font-size: 20px; color: #6a0dad; margin: 0;">Lobster cursive</p>
</div>`,

  },
  rtl: {
    html: `<div style="font-size: 15px; line-height: 1.8;">
  <p dir="rtl" style="margin: 0 0 4px 0;">مرحبا بالعالم - مرحبا</p>
  <p dir="rtl" style="margin: 0 0 4px 0;">שלום עולם - Hello</p>
  <p style="margin: 0;">Mixed: Hello مرحبا World عالم</p>
</div>`,

  },
  'text-alignment': {
    html: `<div style="font-size: 14px; line-height: 1.7;">
  <p style="text-align: left; margin: 0 0 4px 0;">Left-aligned text is the default for most content and feels natural to read.</p>
  <p style="text-align: center; margin: 0 0 4px 0; font-style: italic; color: #555;">Centered text works great for headings, quotes, and captions.</p>
  <p style="text-align: right; margin: 0 0 4px 0; color: #8e44ad;">Right-aligned text is used for dates, signatures, and metadata.</p>
  <p style="text-align: justify; margin: 0;">Justified text stretches words to fill the full width of each line, creating clean edges on both sides like a printed book or newspaper column.</p>
</div>`,

  },
  'gradient-text': {
    html: `<div style="line-height: 1.4;">
  <p style="font-size: 28px; font-weight: 700; font-family: Roboto, sans-serif; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #ff0844, #ffb199); margin: 0 0 6px 0;">Gradient headline</p>
  <p style="font-size: 22px; font-weight: 600; font-family: 'Playfair Display', serif; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #0061ff, #60efff); margin: 0 0 6px 0;">Blue to cyan sweep</p>
  <p style="font-size: 20px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #f5af19, #f12711); margin: 0;">Orange to crimson</p>
</div>`,

  },
  'gradient-stroke': {
    html: `<p style="font-family:Roboto;font-size:60px;font-weight:900;line-height:1.1;margin:0;color:#e5eeff;-webkit-text-stroke:2px #0057ff;paint-order:stroke fill">STAND</p><p style="font-family:Roboto;font-size:60px;font-weight:900;line-height:1.1;margin:0;background-image:linear-gradient(90deg,#0057ff,#a84bff);background-clip:text;color:transparent">OUT.</p>`,
  },
  'text-on-path': { html: '<span style="font-family:Playfair Display;font-size:30px">Words take <i style="color:#0057ff">shape.</i></span>' },
  'text-shadows': {
    html: `<div style="line-height: 1.5;">
  <p style="font-size: 26px; font-weight: 700; color: #2c3e50; text-shadow: 2px 2px 0 #bdc3c7; margin: 0 0 6px 0;">Hard drop shadow</p>
  <p style="font-size: 24px; font-weight: 700; color: #e74c3c; text-shadow: 0 0 10px rgba(231,76,60,0.5); margin: 0 0 6px 0;">Neon red glow</p>
  <p style="font-size: 22px; font-weight: 600; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.6), 0 0 20px rgba(52,152,219,0.4); background: #1a1a2e; padding: 6px 10px; margin: 0;">Light on dark</p>
</div>`,

  },
  spacing: {
    html: `<div style="line-height: 1.8;">
  <p style="font-size: 13px; letter-spacing: 4px; text-transform: uppercase; font-weight: 600; color: #555; margin: 0 0 4px 0;">Wide tracked caps</p>
  <p style="font-size: 18px; letter-spacing: -0.5px; font-weight: 700; margin: 0 0 4px 0;">Tight headline kerning</p>
  <p style="font-size: 14px; word-spacing: 8px; margin: 0 0 4px 0;">Extra wide word spacing applied</p>
  <p style="font-size: 14px; text-transform: capitalize; margin: 0 0 4px 0;">capitalize transforms each word</p>
  <p style="font-size: 15px; text-transform: uppercase; letter-spacing: 2px; color: #e74c3c; font-weight: 600; margin: 0;">spaced uppercase label</p>
</div>`,

  },
  headings: {
    html: `<div style="line-height: 1.3;">
  <h1 style="font-family: 'Playfair Display', serif; font-size: 28px; margin: 0 0 4px 0; color: #1a1a2e;">Main Heading</h1>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 4px 0; color: #2d3436;">Section Title</h2>
  <h3 style="font-size: 16px; font-weight: 600; color: #636e72; margin: 0 0 4px 0;">Subsection</h3>
  <p style="font-size: 14px; line-height: 1.6; color: #555; margin: 0;">Body text beneath the headings, showing the visual hierarchy from large serif heading down through sans-serif subheads to regular paragraph text.</p>
</div>`,

  },
};

const DEMO_BASE_CSS = `body { font-family: Roboto, system-ui, sans-serif; font-size: 16px; line-height: 1.6; color: #101113; } p { margin: 0 0 12px; } h1 { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 40px; line-height: 1.2; margin: 0 0 14px; } h2 { font-family: 'Playfair Display', serif; font-weight: 400; font-size: 32px; line-height: 1.2; margin: 0 0 14px; } ul, ol { padding-left: 24px; }`;

function wrapCSS(html: string, css?: string): string {
  return css ? `<style>${css}</style>${html}` : html;
}

// ── Init ──

async function init(): Promise<void> {
  for (const code of document.querySelectorAll<HTMLElement>('.api-code-panels code')) highlightCode(code, code.textContent ?? '');
  initCopyButtons();
  initCodeTabs();
  initFeatureToggles();
  try {
    await loadSiteFonts();
  } catch (error) {
    console.warn('Showcase fonts could not load; using fallback fonts.', error);
  }
  initShowcase();
  initLayoutDemo();
  initDemo();
  renderFeatureGallery();
  initBenchmark();
}
void init();

// ── Interactive Demo ──

function initDemo(): void {
  const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
  const widthValue = document.getElementById('width-value')!;
  const editor = document.getElementById('editor')!;
  const editorFrame = document.getElementById('editor-frame')!;
  const canvasFrame = document.getElementById('canvas-frame')!;
  const toolbar = document.getElementById('demo-toolbar')!;

  editor.innerHTML = `<h2>Make something <em>worth reading.</em></h2>
<p>A little <strong>bold</strong>. A little <em>italic</em>. A whole lot of <span style="color:#0057ff">possibility.</span></p>
<p><span style="background:#fff0a6;padding:1px 4px">A thought worth highlighting.</span> <u>A point worth making.</u></p>
<ul><li>Mix fonts, colors and styles.</li><li>Give every word its place.</li></ul>`;

  toolbar.addEventListener('mousedown', event => {
    if ((event.target as HTMLElement).closest('button')) event.preventDefault();
  });
  toolbar.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-fmt]');
    if (!button) return;
    editor.focus();
    document.execCommand(button.dataset.fmt!, false, button.dataset.val);
    updateCanvas();
    updateToolbarState();
  });
  const color = toolbar.querySelector<HTMLInputElement>('input[type="color"]')!;
  let savedSelection: Range | undefined;
  color.addEventListener('pointerdown', () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) savedSelection = selection.getRangeAt(0).cloneRange();
  });
  color.addEventListener('input', () => {
    editor.focus();
    if (savedSelection) {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(savedSelection);
    }
    document.execCommand('foreColor', false, color.value);
    updateCanvas();
  });
  function updateToolbarState(): void {
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>('button[data-fmt]')) {
      const active = document.queryCommandState(button.dataset.fmt!);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
      savedSelection = selection.getRangeAt(0).cloneRange();
      updateToolbarState();
    }
  });
  function updateCanvas(): void {
    const width = Number(widthSlider.value);
    widthValue.textContent = String(width);
    editor.style.width = `${width}px`;
    try {
      const start = performance.now();
      const { canvas } = render({ html: wrapCSS(editor.innerHTML, DEMO_BASE_CSS), width });
      document.getElementById('render-speed')!.textContent = (performance.now() - start).toFixed(1);
      canvasFrame.replaceChildren(canvas as HTMLCanvasElement);
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'demo-error';
      message.textContent = error instanceof Error ? error.message : String(error);
      canvasFrame.replaceChildren(message);
    }
  }
  const resize = () => {
    const maximum = Math.max(200, Math.min(800, editorFrame.clientWidth - 48));
    widthSlider.max = String(maximum);
    if (Number(widthSlider.value) > maximum) widthSlider.value = String(maximum);
    updateCanvas();
  };
  let previousWidth = editorFrame.clientWidth;
  new ResizeObserver(() => {
    if (editorFrame.clientWidth === previousWidth) return;
    previousWidth = editorFrame.clientWidth;
    resize();
  }).observe(editorFrame);
  editor.addEventListener('input', updateCanvas);
  editor.addEventListener('paste', event => {
    // Keep pasted demo content as text rather than accepting external markup.
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    event.preventDefault();
    document.execCommand('insertText', false, text);
    updateCanvas();
  });
  widthSlider.addEventListener('input', updateCanvas);
  resize();
}

// ── Feature Gallery ──

function renderFeatureCard(card: HTMLElement) {
  const key = card.dataset.feature;
  if (!key || !FEATURES[key]) return;

  const { html, css } = FEATURES[key];
  const el = card.querySelector<HTMLElement>('.feature-canvas');
  if (!el) return;

  try {
    const inset = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight);
    const width = Math.max(1, (el.clientWidth || 320) - inset);
    const fullCss = DEMO_BASE_CSS + (css ? '\n' + css : '');
    const canvas = key === 'text-on-path' ? renderPathExample(width) : render({ html: wrapCSS(html, fullCss), width }).canvas;
    el.innerHTML = '';
    el.appendChild(canvas as HTMLCanvasElement);
  } catch (error) {
    el.textContent = 'Preview unavailable.';
    console.warn(`Could not render ${key}`, error);
  }
}

function renderFeatureGallery() {
  for (const card of document.querySelectorAll<HTMLElement>('.feature-card')) {
    renderFeatureCard(card);
    const source = card.querySelector<HTMLElement>('.feature-source');
    const key = card.dataset.feature;
    if (source && key && FEATURES[key]) source.textContent = key === 'text-on-path' ? pathExampleSource() : wrapCSS(FEATURES[key].html.trim(), DEMO_BASE_CSS + (FEATURES[key].css ?? ''));
  }

  // Re-render on resize if card widths change
  const prevWidths = new Map<HTMLElement, number>();
  for (const card of document.querySelectorAll<HTMLElement>('.feature-card')) {
    const el = card.querySelector<HTMLElement>('.feature-canvas');
    if (el) prevWidths.set(card, el.clientWidth);
  }

  window.addEventListener('resize', () => {
    for (const card of document.querySelectorAll<HTMLElement>('.feature-card')) {
      const el = card.querySelector<HTMLElement>('.feature-canvas');
      if (!el) continue;
      const w = el.clientWidth;
      if (w !== prevWidths.get(card)) {
        prevWidths.set(card, w);
        renderFeatureCard(card);
      }
    }
  });
}

// ── Feature toggles ──

function initFeatureToggles() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.feature-toggle')) {
    btn.addEventListener('click', () => {
      const src = btn.nextElementSibling as HTMLElement;
      if (!src) return;
      src.hidden = !src.hidden;
      btn.textContent = src.hidden ? 'View source ↗' : 'Hide source ↑';
      btn.setAttribute('aria-expanded', String(!src.hidden));
    });
  }
}
