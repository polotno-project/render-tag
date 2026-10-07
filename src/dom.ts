// The only place render-tag looks for a DOM: an injected parser wins, then the
// ambient DOMParser; otherwise throw (Node consumers must inject one).

export interface DOMParserLike {
  /** Behaves like DOMParser for 'text/html'; `unknown` so linkedom/jsdom type-check without casts. */
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
  // Also drop the ambient cache so a torn-down DOM polyfill is not reused.
  if (parser === null) ambientParser = null;
}

/**
 * A measurement 2D context from whatever canvas the environment offers. Block layout
 * prefers the document canvas and path OffscreenCanvas; switching either moves pixel baselines.
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
    if (!ambientParser) ambientParser = new DOMParser();
    return ambientParser;
  }
  throw new Error(
    'render-tag: no DOM parser available. In a non-browser environment, ' +
      'inject one via setDOMParser(new DOMParser()) using a DOM library ' +
      'such as linkedom or jsdom.'
  );
}
