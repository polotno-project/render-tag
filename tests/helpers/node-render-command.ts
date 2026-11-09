/**
 * render-tag in Node on `@napi-rs/canvas` (Skia; its 'system' text renderer, the stress test's
 * closest to Chrome), as a vitest browser command: the browser loads a corpus case and hands it
 * here, the fonts its `@font-face` rules name registered from disk. cross-browser.bench's Node lane.
 */
import type { BrowserCommand } from 'vitest/node';
import path from 'node:path';
import { faceFamily, inlineStyles, matchFontFaces, stripFontFaces } from './css-text.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const registered = new Set<string>();
/** Each face's registered name, by family and unicode-range: subsets can share a first code point. */
const faceNames = new Map<string, string>();
/** Each family's registered face names, by their range's first code point. */
const familyFaces = new Map<string, { name: string; first: number }[]>();

/**
 * Register every face `css` declares. Skia uses only the first file registered under a family
 * name, so each unicode-range subset is registered under a name of its own and `withFaces`
 * names them all: Skia's per-character fallback through them stands in for unicode-range.
 */
async function registerFaces(css: string): Promise<void> {
  const { GlobalFonts } = await import('@napi-rs/canvas');
  for (const face of matchFontFaces(css)) {
    const family = faceFamily(face);
    const url = /url\(\s*['"]?([^'")]+)/.exec(face)?.[1];
    if (!family || !url) continue;
    const range = /unicode-range:\s*([^;]+)/.exec(face)?.[1].trim() ?? '';
    let name = faceNames.get(`${family}\0${range}`);
    if (!name) {
      faceNames.set(`${family}\0${range}`, name = `rt-face-${faceNames.size}`);
      const faces = familyFaces.get(family) ?? [];
      faces.push({ name, first: Number.parseInt(/U\+([0-9a-f]+)/i.exec(range)?.[1] ?? '0', 16) });
      faces.sort((a, b) => a.first - b.first);
      familyFaces.set(family, faces);
    }
    const file = path.join(ROOT, decodeURIComponent(new URL(url, 'http://localhost').pathname));
    if (registered.has(`${name}\0${file}`)) continue;
    registered.add(`${name}\0${file}`);
    GlobalFonts.registerFromPath(file, name);
  }
}

/** A CSS `font` value with each registered family replaced by its faces, Latin's first. */
function withFaces(font: string): string {
  const match = /^(.*?[\d.]+px\s+)(.+)$/.exec(font);
  if (!match) return font;
  return match[1] + match[2].split(',').flatMap((family) => {
    const faces = familyFaces.get(family.trim().replace(/^(['"])(.*)\1$/, '$2'));
    return faces ? faces.map((face) => `"${face.name}"`) : [family.trim()];
  }).join(', ');
}

/** `canvas` whose contexts resolve families to the registered faces. */
function withFaceFonts<T extends { getContext(type: '2d'): unknown }>(canvas: T): T {
  const ctx = canvas.getContext('2d') as object;
  const font = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), 'font')!;
  Object.defineProperty(ctx, 'font', {
    get: () => font.get!.call(ctx),
    set: (value: string) => font.set!.call(ctx, withFaces(value)),
  });
  return canvas;
}

export interface NodeRender {
  lines: { y: number; text: string; bounds: { x: number; width: number } }[];
  /** The canvas, a base64 PNG. */
  png: string;
}

export const renderInNode: BrowserCommand<[html: string, css: string, width: number, height: number]> = async (
  _context, html, css, width, height,
): Promise<NodeRender> => {
  const { createCanvas, setTextRenderer } = await import('@napi-rs/canvas');
  const { DOMParser } = await import('linkedom');
  const { render, setDOMParser } = await import('../../src/index.ts');
  setTextRenderer('system');
  setDOMParser(new DOMParser() as never);
  await registerFaces(`${css}\n${inlineStyles(html)}`);
  const canvas = withFaceFonts(createCanvas(width, height));
  const result = render({
    html: `<style>${stripFontFaces(css)}</style>${html}`, width, height,
    ctx: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
    createCanvas: (w, h) => withFaceFonts(createCanvas(Math.max(1, w), Math.max(1, h))) as never,
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
