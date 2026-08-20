/**
 * Which engine branch a user agent selects.
 *
 * Blink is the DEFAULT: a server-side render targets headless Chrome, so
 * anything render-tag cannot positively identify must round the way Chrome
 * does. Only Gecko and Safari opt out. jsdom is the trap this pins — it
 * borrows WebKit's UA verbatim and read naively looks exactly like Safari,
 * which would make a Node export stand up to 1px off the canvas it mirrors.
 *
 * The flag is a module-level const, so each case re-imports the module with
 * its own navigator.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADLESS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36';
const FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const JSDOM = 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.0.1';
const NODE = 'Node.js/25.6.1';

async function floorsUnder(userAgent: string | null): Promise<boolean> {
  vi.resetModules();
  if (userAgent === null) vi.stubGlobal('navigator', undefined);
  else vi.stubGlobal('navigator', { userAgent });
  const { FLOORS_LINE_BASELINE } = await import('../../src/layout.ts');
  return FLOORS_LINE_BASELINE;
}

afterEach(() => vi.unstubAllGlobals());

describe('engine branch', () => {
  it.each([
    ['Chrome', CHROME, true],
    ['headless Chrome', HEADLESS, true],
    ['jsdom', JSDOM, true],
    ['Node', NODE, true],
    ['no navigator', null, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, false],
  ] as const)('%s floors the line baseline: %s -> %s', async (_name, ua, expected) => {
    expect(await floorsUnder(ua)).toBe(expected);
  });
});
