/**
 * render-tag in Node on `@napi-rs/canvas` (Skia; its 'system' text renderer, the stress test's
 * closest to Chrome), as a vitest browser command: the browser loads a corpus case and hands it
 * here, the fonts its `@font-face` rules name registered from disk. cross-browser.bench's Node lane.
 */
import type { BrowserCommand } from 'vitest/node';
import path from 'node:path';
import { stripFontFaces } from './css-text.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const registered = new Set<string>();

export interface NodeRender {
  lines: { y: number; text: string; bounds: { x: number; width: number } }[];
  /** The canvas, a base64 PNG. */
  png: string;
}

export const renderInNode: BrowserCommand<[html: string, css: string, width: number, height: number]> = async (
  _context, html, css, width, height,
): Promise<NodeRender> => {
  const { createCanvas, GlobalFonts, setTextRenderer } = await import('@napi-rs/canvas');
  const { DOMParser } = await import('linkedom');
  const { render, setDOMParser } = await import('../../src/index.ts');
  setTextRenderer('system');
  setDOMParser(new DOMParser() as never);
  // A family's first face is the one Skia matches: its Latin subset, the other unicode-range
  // subsets after it for per-character fallback.
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, face]) => ({
    family: /font-family:\s*['"]?([^'";]+?)['"]?\s*;/.exec(face)?.[1],
    url: /url\(\s*['"]?([^'")]+)/.exec(face)?.[1],
  })).sort((a, b) => Number(!/-latin-(?!ext)/.test(a.url ?? '')) - Number(!/-latin-(?!ext)/.test(b.url ?? '')));
  for (const { family, url } of faces) {
    if (!family || !url) continue;
    const file = path.join(ROOT, decodeURIComponent(new URL(url, 'http://localhost').pathname));
    if (registered.has(`${family}\0${file}`)) continue;
    registered.add(`${family}\0${file}`);
    GlobalFonts.registerFromPath(file, family);
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const result = render({
    html: `<style>${stripFontFaces(css)}</style>${html}`, width, height, ctx,
    createCanvas: (w, h) => createCanvas(Math.max(1, w), Math.max(1, h)) as never,
  });
  return {
    lines: result.lines.map((line) => ({ y: line.y, text: line.text, bounds: { x: line.bounds.x, width: line.bounds.width } })),
    png: canvas.toBuffer('image/png').toString('base64'),
  };
};

declare module 'vitest/browser' {
  interface BrowserCommands {
    renderInNode(html: string, css: string, width: number, height: number): Promise<NodeRender>;
  }
}
