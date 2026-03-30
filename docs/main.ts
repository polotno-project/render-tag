import { render } from 'render-tag';

declare const Quill: any;

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
  <p style="font-size: 28px; font-weight: 700; font-family: 'IBM Plex Sans', sans-serif; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #ff0844, #ffb199); margin: 0 0 6px 0;">Gradient headline</p>
  <p style="font-size: 22px; font-weight: 600; font-family: 'Playfair Display', serif; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #0061ff, #60efff); margin: 0 0 6px 0;">Blue to cyan sweep</p>
  <p style="font-size: 20px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #f5af19, #f12711); margin: 0;">Orange to crimson</p>
</div>`,

  },
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

const DEMO_BASE_CSS = `body { font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.5; color: #161616; }`;

function wrapCSS(html: string, css?: string): string {
  return css ? `<style>${css}</style>${html}` : html;
}

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    document.fonts.load('400 16px "IBM Plex Sans"'),
    document.fonts.load('500 16px "IBM Plex Sans"'),
    document.fonts.load('600 16px "IBM Plex Sans"'),
    document.fonts.load('italic 400 16px "IBM Plex Sans"'),
    document.fonts.load('400 16px "IBM Plex Mono"'),
    document.fonts.load('500 16px "IBM Plex Mono"'),
    document.fonts.load('400 20px "Instrument Serif"'),
    document.fonts.load('italic 400 20px "Instrument Serif"'),
    document.fonts.load('400 16px "Playfair Display"'),
    document.fonts.load('700 16px "Playfair Display"'),
    document.fonts.load('italic 400 16px "Playfair Display"'),
    document.fonts.load('400 16px "Roboto"'),
    document.fonts.load('700 16px "Roboto"'),
    document.fonts.load('italic 400 16px "Roboto"'),
    document.fonts.load('400 16px "Merriweather"'),
    document.fonts.load('700 16px "Merriweather"'),
    document.fonts.load('italic 400 16px "Merriweather"'),
    document.fonts.load('400 16px "Lobster"'),
    document.fonts.load('700 16px "Caveat"'),
  ]);

  initScrollReveal();
  initHeroAnimation();
  initDemo();
  renderFeatureGallery();
  initBenchmark();
  initCopyButtons();
  initFeatureToggles();
});

// ── Scroll Reveal ──

function initScrollReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.05, rootMargin: '0px 0px -60px 0px' },
  );
  document.querySelectorAll('.section').forEach(s => observer.observe(s));
}

// ── Hero Animation ──

const HERO_STAGES: { html: string; duration: number }[] = [
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); font-weight: 600; line-height: 1.1; letter-spacing: -0.03em; font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #111827;">HTML rich text,<br>drawn on canvas.</p>`,
  },
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; font-family: 'Playfair Display', serif; color: #111827;">HTML rich text,<br>drawn on canvas.</p>`,
  },
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); font-weight: 600; line-height: 1.1; letter-spacing: -0.03em; font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #111827;">HTML <span style="color: #da1e28;">rich</span> <span style="color: #0f62fe;">text</span>,<br><span style="color: #198038;">drawn</span> on <span style="color: #6a0dad;">canvas</span>.</p>`,
  },
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); font-weight: 600; line-height: 1.1; letter-spacing: -0.03em; font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #111827;">HTML <span style="text-decoration: underline wavy #e74c3c;">rich</span> <span style="text-decoration: underline dotted #0f62fe;">text</span>,<br><span style="background: #ffeaa7; padding: 0 6px;">drawn</span> on <span style="text-decoration: line-through #da1e28;">canvas</span>.</p>`,
  },
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); line-height: 1.1; letter-spacing: -0.03em; font-family: 'Lobster', cursive; color: #6a0dad;">HTML rich text,<br>drawn on canvas.</p>`,
  },
  {
    duration: 2500,
    html: `<p style="font-size: clamp(2.5rem, 7vw, 5rem); font-weight: 700; line-height: 1.1; letter-spacing: -0.03em; font-family: 'Merriweather', serif; font-style: italic; color: #333;">HTML rich text,<br>drawn on canvas.</p>`,
  },
];

function initHeroAnimation() {
  const title = document.querySelector('.hero-title') as HTMLElement;
  if (!title) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'hero-canvas-wrap';
  title.parentNode!.insertBefore(wrapper, title);
  wrapper.appendChild(title);

  const canvasEl = document.createElement('canvas');
  canvasEl.className = 'hero-canvas';
  wrapper.appendChild(canvasEl);

  let stage = 0;
  let opacity = 1;
  let fadeDir: 'in' | 'out' | 'hold' = 'hold';
  let holdTimer = 0;
  const FADE_MS = 400;

  function renderStage() {
    const width = title.offsetWidth;
    const computedSize = getComputedStyle(title).fontSize;
    const stageHtml = HERO_STAGES[stage].html.replace(/clamp\([^)]+\)/g, computedSize);
    const { canvas, height } = render({ html: stageHtml, width });

    canvasEl.width = canvas.width;
    canvasEl.height = canvas.height;
    canvasEl.style.width = width + 'px';
    canvasEl.style.height = height + 'px';

    const ctx = canvasEl.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = opacity;
    ctx.drawImage(canvas, 0, 0);
  }

  renderStage();
  title.style.visibility = 'hidden';

  let lastTime = performance.now();

  function animate(now: number) {
    const dt = now - lastTime;
    lastTime = now;

    if (fadeDir === 'hold') {
      holdTimer += dt;
      if (holdTimer >= HERO_STAGES[stage].duration) {
        fadeDir = 'out';
        holdTimer = 0;
      }
    } else if (fadeDir === 'out') {
      opacity = Math.max(0, opacity - dt / FADE_MS);
      if (opacity <= 0) {
        stage = (stage + 1) % HERO_STAGES.length;
        fadeDir = 'in';
      }
    } else if (fadeDir === 'in') {
      opacity = Math.min(1, opacity + dt / FADE_MS);
      if (opacity >= 1) {
        fadeDir = 'hold';
        holdTimer = 0;
      }
    }

    renderStage();
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
  window.addEventListener('resize', renderStage);
}

// ── Interactive Demo ──

function initDemo() {
  const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
  const widthValue = document.getElementById('width-value')!;
  const canvasFrame = document.getElementById('canvas-frame')!;
  const toolbar = document.getElementById('demo-toolbar')!;
  const panels = document.querySelectorAll<HTMLElement>('.demo-panel');

  const quill = new Quill('#editor', { modules: { toolbar: false } });

  quill.root.innerHTML = `<h2 style="font-family: 'Playfair Display', serif;">The Art of Typography</h2>
<p style="font-family: 'Roboto', sans-serif; font-size: 14px; line-height: 1.7;"><strong>Bold</strong> and <em>italic</em> and <strong><em>both</em></strong>. <span style="color: #da1e28;">Red text</span>, <span style="color: #0f62fe;">blue text</span>, <span style="background: #ffeaa7; padding: 1px 4px;">yellow highlight</span>, <span style="background: #d4efdf; padding: 1px 4px;">green highlight</span>. <u>Underlined</u>, <s>strikethrough</s>, <span style="text-decoration: underline wavy #e74c3c;">wavy underline</span>, <span style="text-decoration: underline dotted #0f62fe;">dotted underline</span>. Sizes: <span style="font-size: 10px;">10px tiny</span>, <span style="font-size: 18px;">18px</span>, <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">24px bold</span>. Fonts: <span style="font-family: 'Merriweather', serif; font-style: italic;">Merriweather italic</span>, <span style="font-family: 'Lobster', cursive; font-size: 18px; color: #6a0dad;">Lobster</span>, <span style="font-weight: 300;">light 300</span>, <span style="font-weight: 900;">black 900</span>.</p>
<ul style="font-size: 13px;">
  <li><strong>Bold item</strong> with <span style="background: #fadbd8; padding: 1px 4px;">pink bg</span></li>
  <li style="color: #8e44ad;"><span style="font-family: 'Playfair Display', serif;">Playfair</span> in purple</li>
</ul>
<p style="font-size: 13px;"><span dir="rtl">مرحبا</span> · 你好世界 · 한국어 · 🎨🚀✨</p>`;

  toolbar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const fmt = btn.dataset.fmt;
    if (!fmt) return;

    if (fmt === 'header' || fmt === 'list') {
      const val = btn.dataset.val!;
      const current = quill.getFormat()[fmt];
      quill.format(fmt, current === val || current === Number(val) ? false : val === '1' || val === '2' ? Number(val) : val);
    } else {
      const current = quill.getFormat()[fmt];
      quill.format(fmt, !current);
    }
    quill.focus();
    updateToolbarState();
  });

  const colorInput = toolbar.querySelector('input[type="color"]') as HTMLInputElement;
  colorInput.addEventListener('input', () => {
    quill.format('color', colorInput.value);
    quill.focus();
  });

  function updateToolbarState() {
    const fmt = quill.getFormat();
    toolbar.querySelectorAll<HTMLButtonElement>('button[data-fmt]').forEach(btn => {
      const f = btn.dataset.fmt!;
      const v = btn.dataset.val;
      if (v) {
        btn.classList.toggle('active', fmt[f] === v || fmt[f] === Number(v));
      } else {
        btn.classList.toggle('active', !!fmt[f]);
      }
    });
  }
  quill.on('selection-change', updateToolbarState);

  function updateCanvas() {
    const html = quill.root.innerHTML;
    const width = parseInt(widthSlider.value);
    widthValue.textContent = String(width);

    const cardWidth = width + 34;
    panels.forEach(c => c.style.width = cardWidth + 'px');

    try {
      const debugLogs: { type: string; message: string }[] = [];
      const t0 = performance.now();
      const { canvas } = render({
        html: wrapCSS(html, DEMO_BASE_CSS),
        width,
        debug: (entry) => { debugLogs.push(entry); },
      });
      const elapsed = performance.now() - t0;
      console.groupCollapsed(`[render-tag] width=${width}, ${debugLogs.length} entries`);
      for (const log of debugLogs) {
        if (log.type === 'line-commit' || log.type === 'line-wrap') {
          console.log(log.type, log.message);
        }
      }
      console.groupEnd();
      canvasFrame.innerHTML = '';
      canvasFrame.appendChild(canvas);

      const ticker = document.getElementById('render-speed');
      if (ticker) ticker.textContent = elapsed.toFixed(1);
    } catch (e) {
      canvasFrame.innerHTML = `<p style="color: #ef4444; font-size: 13px;">${(e as Error).message}</p>`;
    }
  }

  function updateSliderMax() {
    const section = canvasFrame.closest('.container') as HTMLElement;
    const available = section ? section.clientWidth - 34 : 800; // 34 = panel border + padding
    const max = Math.max(200, Math.min(800, available));
    widthSlider.max = String(max);
    if (parseInt(widthSlider.value) > max) {
      widthSlider.value = String(max);
    }
  }

  updateSliderMax();
  window.addEventListener('resize', () => { updateSliderMax(); updateCanvas(); });

  quill.on('text-change', updateCanvas);
  widthSlider.addEventListener('input', updateCanvas);
  updateCanvas();
}

// ── Benchmark ──

const BENCH_HTML = `
<h2 style="font-family: 'Playfair Display', serif; color: #1a1a2e; margin: 0 0 12px 0;">
  The Future of Digital Typography
</h2>
<p style="font-family: 'Roboto', sans-serif; font-size: 15px; line-height: 1.7; color: #333; margin: 0 0 10px 0;">
  In the evolving landscape of web design, <strong>rich text rendering</strong> remains
  a fundamental challenge. From <em>ancient calligraphy</em> to modern screens,
  the art of displaying <span style="color: #e74c3c;">beautifully formatted text</span>
  has always pushed technology forward.
</p>
<ul style="font-family: 'Roboto', sans-serif; font-size: 14px; padding-left: 24px; margin: 0 0 10px 0; color: #555;">
  <li><strong>Performance</strong> — sub-5ms rendering</li>
  <li><em>Accuracy</em> — pixel-perfect layout</li>
  <li><span style="text-decoration: underline;">Compatibility</span> — works everywhere</li>
</ul>
<p style="font-family: 'Playfair Display', serif; font-size: 13px; text-align: center; color: #888; margin: 0;">
  Typography is the craft of endowing human language with a durable visual form.
</p>`;

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 50));
}

function createBenchContainer(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;font-family:system-ui,sans-serif;';
  el.innerHTML = BENCH_HTML;
  document.body.appendChild(el);
  return el;
}

interface BenchRunner {
  name: string;
  load: () => Promise<(container: HTMLDivElement) => Promise<void>>;
}

const BENCH_RUNNERS: BenchRunner[] = [
  {
    name: 'render-tag',
    load: async () => {
      return async () => {
        render({ html: BENCH_HTML, width: 400 });
      };
    },
  },
  {
    name: 'snapdom',
    load: async () => {
      const mod = await import(/* @vite-ignore */ 'https://esm.sh/@zumer/snapdom@latest');
      const snapdom = mod.snapdom || mod.default;
      return async (container) => {
        const result = await snapdom(container, { embedFonts: true, scale: 1 });
        await result.toCanvas();
      };
    },
  },
  {
    name: 'modern-screenshot',
    load: async () => {
      const mod = await import(/* @vite-ignore */ 'https://esm.sh/modern-screenshot@4.5.5');
      return async (container) => {
        await mod.domToCanvas(container, { scale: 1 });
      };
    },
  },
  {
    name: 'html2canvas',
    load: async () => {
      const mod = await import(/* @vite-ignore */ 'https://esm.sh/html2canvas@1.4.1');
      const html2canvas = mod.default;
      return async (container) => {
        await html2canvas(container, { scale: 1, logging: false });
      };
    },
  },
  {
    name: 'dom-to-image-more',
    load: async () => {
      const mod = await import(/* @vite-ignore */ 'https://esm.sh/dom-to-image-more@3.7.2');
      const domToImage = mod.default || mod;
      let fontCSS: string | undefined;
      if (domToImage.getFontEmbedCSS) {
        fontCSS = await domToImage.getFontEmbedCSS(document.body);
      }
      return async (container) => {
        await domToImage.toCanvas(container, {
          preferredFontFormat: 'woff2',
          ...(fontCSS ? { fontEmbedCSS: fontCSS } : {}),
        });
      };
    },
  },
];

const PRELOADED_RESULTS: { name: string; ms: number }[] = [
  { name: 'render-tag', ms: 1.3 },
  { name: 'snapdom', ms: 4.6 },
  { name: 'modern-screenshot', ms: 33.4 },
  { name: 'html2canvas', ms: 249.3 },
  { name: 'dom-to-image-more', ms: 8.3 },
];

function initBenchmark() {
  const btn = document.getElementById('run-benchmark') as HTMLButtonElement;
  const chart = document.getElementById('perf-chart')!;
  const preview = document.getElementById('perf-preview')!;
  const deviceNote = document.querySelector('.perf-device-note')!;

  try {
    const { canvas } = render({ html: wrapCSS(BENCH_HTML, DEMO_BASE_CSS), width: 400 });
    preview.appendChild(canvas);
  } catch { /* ignore */ }

  // Show pre-loaded results immediately
  renderChart(chart, PRELOADED_RESULTS);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    chart.innerHTML = '';
    deviceNote.innerHTML = '<span class="perf-status" id="perf-status"></span>';

    const container = createBenchContainer();
    const ROUNDS = 3;
    const results: { name: string; ms: number }[] = [];

    const status = document.getElementById('perf-status')!;

    for (const runner of BENCH_RUNNERS) {
      status.textContent = `Loading ${runner.name}...`;
      await tick();

      try {
        const fn = await runner.load();
        const roundMedians: number[] = [];

        for (let round = 0; round < ROUNDS; round++) {
          status.textContent = `Benchmarking ${runner.name} (round ${round + 1}/${ROUNDS})...`;
          await tick();

          const isSync = runner.name === 'render-tag';
          const iterations = isSync ? 50 : 20;

          for (let i = 0; i < 3; i++) await fn(container);

          const times: number[] = [];
          for (let i = 0; i < iterations; i++) {
            const t0 = performance.now();
            await fn(container);
            times.push(performance.now() - t0);
          }
          roundMedians.push(median(times));
        }
        results.push({ name: runner.name, ms: median(roundMedians) });
      } catch (e) {
        console.warn(`${runner.name} failed:`, e);
        results.push({ name: runner.name, ms: -1 });
      }
    }

    container.remove();
    deviceNote.innerHTML = 'Results from your browser.';
    renderChart(chart, results);
  });
}

function renderChart(container: HTMLElement, results: { name: string; ms: number }[]) {
  const valid = results.filter(r => r.ms > 0);
  const maxLog = Math.log10(Math.max(...valid.map(r => r.ms)));
  const minLog = Math.log10(Math.max(Math.min(...valid.map(r => r.ms)), 0.1));
  const range = maxLog - minLog || 1;

  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'perf-row';

    const name = document.createElement('span');
    name.className = 'perf-name';
    name.textContent = r.name;

    const track = document.createElement('div');
    track.className = 'perf-track';

    const bar = document.createElement('div');
    const logPct = r.ms <= 0 ? 0 : ((Math.log10(r.ms) - minLog) / range) * 92 + 8;
    const fastest = valid.length > 0 && r.ms === Math.min(...valid.map(v => v.ms));
    const colorClass = r.ms < 0 ? 'perf-slow' : fastest ? 'perf-fast' : r.ms < 50 ? 'perf-mid' : 'perf-slow';
    bar.className = `perf-bar ${colorClass}`;

    const ms = document.createElement('span');
    ms.className = 'perf-ms';
    ms.textContent = r.ms < 0 ? 'failed' : `${r.ms.toFixed(1)} ms`;

    bar.appendChild(ms);
    track.appendChild(bar);
    row.appendChild(name);
    row.appendChild(track);
    container.appendChild(row);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bar.style.width = r.ms < 0 ? '100%' : logPct + '%';
      });
    });
  }
}

// ── Feature Gallery ──

function renderFeatureCard(card: HTMLElement) {
  const key = card.dataset.feature;
  if (!key || !FEATURES[key]) return;

  const { html, css } = FEATURES[key];
  const el = card.querySelector<HTMLElement>('.feature-canvas');
  if (!el) return;

  try {
    const width = el.clientWidth || 280;
    const fullCss = DEMO_BASE_CSS + (css ? '\n' + css : '');
    const { canvas } = render({ html: wrapCSS(html, fullCss), width });
    el.innerHTML = '';
    el.appendChild(canvas);
  } catch {
    el.textContent = 'Render error';
  }
}

function renderFeatureGallery() {
  for (const card of document.querySelectorAll<HTMLElement>('.feature-card')) {
    renderFeatureCard(card);
    const source = card.querySelector<HTMLElement>('.feature-source');
    const key = card.dataset.feature;
    if (source && key && FEATURES[key]) source.textContent = FEATURES[key].html.trim();
  }

  // Re-render on resize if card widths change
  let prevWidths = new Map<HTMLElement, number>();
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
      btn.textContent = src.hidden ? 'Source' : 'Hide';
    });
  }
}

// ── Copy buttons ──

function initCopyButtons() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy!;
      try {
        await navigator.clipboard.writeText(text);
        const saved = btn.innerHTML;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.innerHTML = saved; }, 1200);
      } catch { /* ignore */ }
    });
  }
}
