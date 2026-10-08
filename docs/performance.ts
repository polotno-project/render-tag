import { render } from 'render-tag';

const WIDTH = 400;
const BENCH_HTML = `<div style="font-family:Roboto;font-size:16px;line-height:normal;letter-spacing:0;font-weight:400;font-style:normal;color:#101113;background:#fff">
<h2 style="font-family:Playfair Display;font-size:32px;font-weight:700;line-height:1.2;letter-spacing:0;margin:0 0 16px">The art of <i>rich text.</i></h2>
<p style="font-family:Roboto;font-size:16px;line-height:1.7;margin:0 0 12px">Start with a <strong>bold idea</strong>. Add an <em>italic thought</em>, a <span style="color:#0057ff;font-weight:700">splash of color</span>, and a <span style="background:#fff0a6">detail worth highlighting.</span> <u>Good typography</u> brings it all together.</p>
<p style="font-family:Merriweather;font-size:15px;line-height:1.8;margin:0 0 12px">A serif voice for longer reading, with <i>quiet emphasis</i>, <strong>confident weight</strong>, and a <span style="font-family:Roboto;font-size:18px;color:#9955cc">different rhythm</span> inside the same paragraph.</p>
<ul style="font-size:15px;line-height:1.6;padding-left:24px;margin:0 0 12px"><li><strong>Layout</strong> — measure, fit, and position.</li><li><em>Rich styles</em> — fonts and formatting together.</li><li><u>Drawing</u> — native commands, your context.</li></ul>
<p style="font-family:Lobster;font-size:28px;line-height:1.4;color:#0057ff;margin:0 0 12px">A little character goes a long way.</p>
<p style="font-family:Playfair Display;font-size:16px;line-height:1.6;text-align:center;margin:0">Roboto. <i>Playfair Display.</i> <span style="font-family:Merriweather;font-size:14px">Merriweather.</span> <span style="font-family:Lobster;font-size:20px">Lobster.</span></p>
</div>`;

type Capture = (element: HTMLElement) => HTMLCanvasElement | Promise<HTMLCanvasElement>;
type CanvasExporter = (element: HTMLElement, options: Record<string, unknown>) => Promise<HTMLCanvasElement>;
interface Runner { id: string; load: () => Promise<Capture>; }
const CLONE_STYLE = { position: 'static', left: 'auto', top: 'auto', margin: '0', visibility: 'visible' };

const RUNNERS: Runner[] = [
  {
    id: 'render-tag',
    load: async () => () => render({ html: BENCH_HTML, width: WIDTH, pixelRatio: 1 }).canvas as HTMLCanvasElement,
  },
  {
    id: 'snapdom',
    load: async () => {
      const url = 'https://esm.sh/@zumer/snapdom@3.3.0';
      const mod = await import(/* @vite-ignore */ url) as { snapdom: (element: HTMLElement, options: Record<string, unknown>) => Promise<{ toCanvas: () => Promise<HTMLCanvasElement> }> };
      return async element => (await mod.snapdom(element, { embedFonts: true, scale: 1, dpr: 1, backgroundColor: '#fff', invalidate: true, cache: false })).toCanvas();
    },
  },
  {
    id: 'modern-screenshot',
    load: async () => {
      const url = 'https://esm.sh/modern-screenshot@4.7.0';
      const mod = await import(/* @vite-ignore */ url) as { domToCanvas: CanvasExporter };
      return element => mod.domToCanvas(element, {
        scale: 1, backgroundColor: '#fff',
        onCloneNode: (node: Node) => {
          if (node instanceof HTMLElement && node.classList.contains('bench-fixture')) Object.assign(node.style, CLONE_STYLE);
        },
      });
    },
  },
  {
    id: 'html2canvas',
    load: async () => {
      const url = 'https://esm.sh/html2canvas@1.4.1';
      const mod = await import(/* @vite-ignore */ url) as { default: CanvasExporter };
      return element => mod.default(element, { scale: 1, logging: false, backgroundColor: '#fff' });
    },
  },
  {
    id: 'dom-to-image-more',
    load: async () => {
      const url = 'https://esm.sh/dom-to-image-more@3.11.0';
      const mod = await import(/* @vite-ignore */ url) as { default: { toCanvas: CanvasExporter } };
      return element => mod.default.toCanvas(element, { scale: 1, pixelRatio: 1, bgcolor: '#fff', style: CLONE_STYLE, copyDefaultStyles: false });
    },
  },
];

function createFixture(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'bench-fixture';
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = BENCH_HTML;
  document.body.appendChild(element);
  return element;
}

function pause(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out. Try again or check your connection.')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

export function initBenchmark(): void {
  const button = document.getElementById('run-benchmark') as HTMLButtonElement;
  const note = document.getElementById('benchmark-note')!;
  const outputs = document.getElementById('perf-outputs')!;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Comparing…';
    outputs.replaceChildren();
    for (const row of document.querySelectorAll<HTMLElement>('[data-bench]')) {
      row.querySelector<HTMLElement>('.bench-time')!.textContent = '—';
      row.querySelector<HTMLElement>('.bench-status')!.textContent = 'Waiting';
      row.querySelector<HTMLElement>('.bench-bar')!.style.width = '0';
    }
    const results: { id: string; milliseconds: number }[] = [];
    try {
      await document.fonts.ready;
      for (const runner of RUNNERS) {
        const row = document.querySelector<HTMLElement>(`[data-bench="${runner.id}"]`)!;
        const status = row.querySelector<HTMLElement>('.bench-status')!;
        let preview: HTMLCanvasElement | undefined;
        try {
          status.textContent = 'Loading';
          note.textContent = `Loading ${runner.id}…`;
          const capture = await withTimeout(runner.load(), 20000);
          status.textContent = 'Measuring';
          note.textContent = `Measuring ${runner.id}…`;
          await pause();
          const samples: number[] = [];
          for (let i = 0; i < 9; i++) {
            const start = performance.now();
            // A new root prevents caches keyed by DOM identity from crossing samples.
            const element = runner.id === 'render-tag' ? undefined : createFixture();
            let canvas: HTMLCanvasElement | undefined;
            try {
              const output = capture(element ?? document.body);
              canvas = output instanceof Promise ? await withTimeout(output, 15000) : output;
              if (canvas.width !== WIDTH || canvas.height < 1) throw new Error(`Expected ${WIDTH}px output, got ${canvas.width} × ${canvas.height}.`);
              canvas.getContext('2d')!.getImageData(0, 0, 1, 1);
              if (i >= 2) samples.push(performance.now() - start);
              if (i === 8) preview = canvas;
            } finally {
              element?.remove();
              if (canvas && canvas !== preview) { canvas.width = 0; canvas.height = 0; }
            }
            await pause();
          }
          samples.sort((a, b) => a - b);
          const milliseconds = samples[3];
          results.push({ id: runner.id, milliseconds });
          row.querySelector<HTMLElement>('.bench-time')!.textContent = `${milliseconds.toFixed(2)} ms`;
          status.textContent = 'Complete';
          const figure = document.createElement('figure');
          figure.className = 'perf-output';
          const caption = document.createElement('figcaption');
          caption.textContent = runner.id;
          figure.append(caption, preview!);
          outputs.appendChild(figure);
        } catch (error) {
          status.textContent = 'Unavailable';
          const message = error instanceof Error ? error.message : String(error);
          status.title = message;
          const explanation = document.createElement('p');
          explanation.className = 'perf-output';
          explanation.textContent = `${runner.id}: ${message}`;
          outputs.appendChild(explanation);
        }
        const maximum = Math.max(...results.map(result => result.milliseconds), 0.01);
        for (const result of results) {
          const bar = document.querySelector<HTMLElement>(`[data-bench="${result.id}"] .bench-bar`)!;
          bar.style.width = `${Math.max(1, result.milliseconds / maximum * 100)}%`;
        }
      }
      note.textContent = `${results.length} of ${RUNNERS.length} libraries measured · median of 7 fresh renders · no cached render results · 400px · 1× · pixel readback included. See method and outputs below.`;
    } finally {
      button.disabled = false;
      button.textContent = 'Run comparison again →';
    }
  });
}
