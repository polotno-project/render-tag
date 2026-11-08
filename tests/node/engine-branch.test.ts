/**
 * Which engine branch a user agent selects.
 *
 * Blink is the DEFAULT: a server-side render targets headless Chrome, so
 * anything render-tag cannot positively identify takes Chrome's canvas branch.
 * Only Gecko and Safari opt out. jsdom is the trap this pins — it borrows
 * WebKit's UA verbatim and read naively looks exactly like Safari, which would
 * give a Node export WebKit's canvas workarounds.
 *
 * The flags are module-level consts, so each case re-imports the module with
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
const HAPPY_DOM = 'Mozilla/5.0 (X11; Darwin arm64) AppleWebKit/537.36 (KHTML, like Gecko) HappyDOM/21.0.4';
const NODE = 'Node.js/25.6.1';
const LINUX_HEADLESS =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
const CHROME_OS =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const JSDOM_LINUX = 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.0.1';

async function engineUnder(userAgent: string | null) {
  vi.resetModules();
  if (userAgent === null) vi.stubGlobal('navigator', undefined);
  else vi.stubGlobal('navigator', { userAgent });
  return import('../../src/engine.ts');
}

afterEach(() => vi.unstubAllGlobals());

describe('engine branch', () => {
  it.each([
    ['Chrome', CHROME, 'blink'],
    ['headless Chrome', HEADLESS, 'blink'],
    ['jsdom', JSDOM, 'blink'],
    ['happy-dom', HAPPY_DOM, 'blink'],
    ['Node', NODE, 'blink'],
    ['no navigator', null, 'blink'],
    ['Firefox', FIREFOX, 'gecko'],
    ['Safari', SAFARI, 'webkit'],
  ] as const)('%s is the %s canvas', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).ENGINE).toBe(expected);
  });

  // A single-paint bidi line stays one fillText where the engine's Canvas
  // lays it out like its DOM (Blink, measured; Gecko, its old path,
  // unmeasured). WebKit's Canvas does not, so WebKit gets ordered level runs.
  it.each([
    ['Chrome', CHROME, true],
    ['headless Chrome', HEADLESS, true],
    ['jsdom', JSDOM, true],
    ['Node', NODE, true],
    ['no navigator', null, true],
    ['Firefox', FIREFOX, true],
    ['Safari', SAFARI, false],
  ] as const)('%s paints a single-paint bidi line as one run: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).CANVAS_BIDI_LINE).toBe(expected);
  });

  // Only macOS Blink reports a glyph's painted ink in measureText; elsewhere it
  // rounds the box to whole pixels (engine-probe marker-ink, CI). Without a
  // browser (Node, jsdom, HappyDOM) there is no canvas to read the paint from.
  it.each([
    ['Chrome', CHROME, false],
    ['headless Chrome', HEADLESS, false],
    ['headless Chrome on Linux', LINUX_HEADLESS, true],
    ['Chrome on Windows', WINDOWS, true],
    ['Chrome on Android', ANDROID, true],
    ['Chrome on ChromeOS', CHROME_OS, true],
    ['jsdom', JSDOM, false],
    ['jsdom on Linux', JSDOM_LINUX, false],
    ['HappyDOM', HAPPY_DOM, false],
    ['Node', NODE, false],
    ['no navigator', null, false],
    ['Firefox', FIREFOX, true],
    ['Safari', SAFARI, true],
  ] as const)('%s reads a bullet\'s ink off its paint: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).INK_BOX_FROM_PAINT).toBe(expected);
  });
});
