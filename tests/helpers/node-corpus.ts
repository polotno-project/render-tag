import type { BenchmarkCase } from './test-cases.ts';

/**
 * The browser corpus (`test-cases.ts`), loaded in Node for the DOM-free gates.
 *
 * `test-cases.ts` fetches the pinned @fontsource CSS relative to
 * `location.href`, and in Node its `?url` imports resolve to nothing. The
 * gates that use this measure with a synthetic ctx and never load a font, so
 * every face is replaced by one inert `@font-face` (labelled so the Arabic
 * subset filter still finds it). Everything else — each case's HTML, its own
 * CSS, the reset, the fallback stack — is the corpus exactly as the browser
 * lanes see it.
 */
export async function loadNodeCorpus(): Promise<BenchmarkCase[]> {
  const g = globalThis as { location?: unknown; fetch: typeof fetch };
  const hadLocation = 'location' in g;
  const prevLocation = g.location;
  const prevFetch = g.fetch;
  g.location = { href: 'http://localhost/' };
  g.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => `/* noto-sans-arabic-arabic-wght-normal */\n@font-face { font-family: 'RT Inert'; src: url(inert.woff2); }`,
  })) as unknown as typeof fetch;
  try {
    const { loadBasicCases, loadFlexCases, polotnoCase, polotnoListsCase } = await import('./test-cases.ts');
    return [...await loadBasicCases(), ...await loadFlexCases(), polotnoCase, polotnoListsCase];
  } finally {
    g.fetch = prevFetch;
    if (hadLocation) g.location = prevLocation;
    else delete g.location;
  }
}

/** The single HTML string render-tag receives for a corpus case. */
export function caseHtml(c: BenchmarkCase): string {
  return c.css ? `<style>${c.css}</style>${c.html}` : c.html;
}
