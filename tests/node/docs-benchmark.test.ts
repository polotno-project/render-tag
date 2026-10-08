/// <reference types="vite/client" />
import { afterEach, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import siteHtml from '../../docs/index.html?raw';

const captures = vi.hoisted(() => {
  const calls: { id: string; element?: HTMLElement; options: Record<string, unknown> }[] = [];
  const canvases: HTMLCanvasElement[] = [];
  function capture(id: string, element?: HTMLElement, options: Record<string, unknown> = {}): HTMLCanvasElement {
    calls.push({ id, element, options });
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 100;
    Object.defineProperty(canvas, 'getContext', { value: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) });
    canvases.push(canvas);
    return canvas;
  }
  return { calls, canvases, capture };
});

vi.mock('render-tag', () => ({ render: () => ({ canvas: captures.capture('render-tag') }) }));
vi.mock('https://esm.sh/@zumer/snapdom@3.3.0', () => ({
  snapdom: async (element: HTMLElement, options: Record<string, unknown>) => ({
    toCanvas: async () => captures.capture('snapdom', element, options),
  }),
}));
vi.mock('https://esm.sh/modern-screenshot@4.7.0', () => ({
  domToCanvas: async (element: HTMLElement, options: Record<string, unknown>) => captures.capture('modern-screenshot', element, options),
}));
vi.mock('https://esm.sh/html2canvas@1.4.1', () => ({
  default: async (element: HTMLElement, options: Record<string, unknown>) => captures.capture('html2canvas', element, options),
}));
vi.mock('https://esm.sh/dom-to-image-more@3.11.0', () => ({
  default: { toCanvas: async (element: HTMLElement, options: Record<string, unknown>) => captures.capture('dom-to-image-more', element, options) },
}));

afterEach(() => vi.unstubAllGlobals());

test('benchmark prevents cross-sample capture and layout reuse', async () => {
  const { document } = parseHTML(siteHtml);
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() } });
  vi.stubGlobal('document', document);
  const { initBenchmark } = await import('../../docs/performance.ts');
  initBenchmark();
  const button = document.getElementById('run-benchmark') as HTMLButtonElement;
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 });

  expect(captures.calls).toHaveLength(45);
  expect(new Set(captures.canvases).size).toBe(45);
  for (const id of ['snapdom', 'modern-screenshot', 'html2canvas', 'dom-to-image-more']) {
    const calls = captures.calls.filter(call => call.id === id);
    expect(calls).toHaveLength(9);
    expect(new Set(calls.map(call => call.element)).size).toBe(9);
    expect(calls.every(call => !call.element?.isConnected)).toBe(true);
  }
  for (const call of captures.calls.filter(call => call.id === 'snapdom')) {
    expect(call.options).toMatchObject({ invalidate: true, cache: false });
  }
  for (const call of captures.calls.filter(call => call.id === 'dom-to-image-more')) {
    expect(call.options.copyDefaultStyles).toBe(false);
  }
  expect(document.querySelectorAll('#perf-outputs canvas')).toHaveLength(5);
  expect(document.querySelector('.bench-fixture')).toBeNull();
});
