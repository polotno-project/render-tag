/**
 * DOM parser resolution — the only place render-tag looks for a DOM.
 *
 * Resolution order:
 *   1. A parser injected via setDOMParser() (explicit always wins).
 *   2. The ambient global DOMParser (browsers, jsdom/happy-dom environments).
 *   3. Throw with guidance — render-tag has zero dependencies, so in Node the
 *      consumer must inject a parser (e.g. linkedom's or jsdom's DOMParser).
 */

export interface DOMParserLike {
  /**
   * Must behave like the standard DOMParser for 'text/html' input. The return
   * type is intentionally loose so non-browser DOM libraries (linkedom,
   * jsdom) type-check without casts — their Document types are structurally
   * different from the TS lib's.
   */
  parseFromString(markup: string, type: string): unknown;
}

let explicitParser: DOMParserLike | null = null;
let ambientParser: DOMParserLike | null = null;

/**
 * Inject the DOM parser render-tag uses to parse HTML input.
 * Required in non-browser environments (Node.js). Pass null to reset.
 *
 *   import { DOMParser } from 'linkedom';
 *   setDOMParser(new DOMParser());
 */
export function setDOMParser(parser: DOMParserLike | null): void {
  explicitParser = parser;
  // Reset the ambient cache too, so tests/harnesses that tear down a DOM
  // polyfill (jsdom etc.) don't keep measuring against a stale realm.
  if (parser === null) ambientParser = null;
}

/**
 * Create a measurement 2D context from whatever canvas source the environment
 * offers. `preferDocument` preserves each entry point's historical source
 * (block layout: document canvas; path: OffscreenCanvas) so existing pixel
 * baselines don't move.
 */
export function createFallbackMeasureCtx(preferDocument: boolean): CanvasRenderingContext2D {
  const hasDocument = typeof document !== 'undefined';
  const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
  if (hasDocument && (preferDocument || !hasOffscreen)) {
    return document.createElement('canvas').getContext('2d')! as CanvasRenderingContext2D;
  }
  if (hasOffscreen) {
    return new OffscreenCanvas(1, 1).getContext('2d')! as unknown as CanvasRenderingContext2D;
  }
  throw new Error(
    'render-tag: no canvas available for text measurement. ' +
      'In a non-browser environment, pass config.ctx (a 2D context).'
  );
}

/** @internal */
export function resolveDOMParser(): DOMParserLike {
  if (explicitParser) return explicitParser;
  if (typeof DOMParser !== 'undefined') {
    // DOMParser instances are stateless — cache one.
    if (!ambientParser) ambientParser = new DOMParser();
    return ambientParser;
  }
  throw new Error(
    'render-tag: no DOM parser available. In a non-browser environment, ' +
      'inject one via setDOMParser(new DOMParser()) using a DOM library ' +
      'such as linkedom or jsdom.'
  );
}
