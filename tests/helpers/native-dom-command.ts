import type { BrowserCommand } from 'vitest/node';
import '@vitest/browser-playwright';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

export interface NativeDomCaptureOptions {
  html: string;
  css: string;
  width: number;
  height: number;
  pixelRatio: number;
}

/** Reference PNGs live here; `npm run test:clear-native-cache` empties it. */
export const NATIVE_DOM_CACHE_ROOT = path.resolve(
  import.meta.dirname,
  '../../node_modules/.cache/render-tag/native-dom',
);

/**
 * Two unrelated Firefox limitations, kept apart so a third one does not get
 * folded into whichever check it happens to resemble.
 */
const ENGINE_QUIRKS: Record<string, { reopensRunnerOrigin: boolean; omitsBackground: boolean }> = {
  // Firefox cannot reopen Vitest's runner origin in a second context, so the
  // capture page stays on an opaque origin — `server: { cors: true }` in
  // vitest.browser.config.ts is what lets its absolute font URLs still load.
  // omitBackground asks Firefox to change the page background, an operation its
  // Playwright transport does not implement. Pixel comparison normalizes both
  // images onto white anyway, so an opaque screenshot is equivalent.
  firefox: { reopensRunnerOrigin: false, omitsBackground: false },
};

const DEFAULT_QUIRKS = { reopensRunnerOrigin: true, omitsBackground: true };

function quirks(browserName: string) {
  return ENGINE_QUIRKS[browserName] || DEFAULT_QUIRKS;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureHtml(options: NativeDomCaptureOptions): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    options.css +
    '</style></head><body><div>' +
    '<div style="margin:0;padding:0;overflow:hidden">' +
    options.html +
    '</div></div></body></html>'
  );
}

let environmentKey: Promise<string> | undefined;

/**
 * Everything outside the fixture that can change what the engine paints. A
 * render-tag source change deliberately does NOT appear here: the reference
 * has to stay independent of the library it judges.
 */
function environmentDigest(
  browserName: string,
  browser: Browser,
): Promise<string> {
  environmentKey ||= Promise.all([
    readFile(new URL('../../package-lock.json', import.meta.url)),
    readFile(new URL('../../vitest.browser.config.ts', import.meta.url)),
    readFile(new URL(import.meta.url)),
  ]).then(async (implementation) => {
    const key = digest(JSON.stringify({
      schema: 1,
      browserName,
      browserVersion: browser.version(),
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      implementation: digest(Buffer.concat(implementation)),
    }));
    await pruneSupersededEnvironments(path.join(NATIVE_DOM_CACHE_ROOT, browserName), key);
    return key;
  });
  return environmentKey;
}

/**
 * References captured under a previous environment can never be read again, so
 * drop them rather than let every dependency bump add another copy of the
 * corpus to the CI cache tarball.
 */
async function pruneSupersededEnvironments(
  browserDirectory: string,
  current: string,
): Promise<void> {
  const entries = await readdir(browserDirectory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry !== current)
      .map((entry) => rm(path.join(browserDirectory, entry), { recursive: true, force: true })),
  );
}

async function readCached(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function writeCached(file: string, image: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Rename so a killed run leaves no half-written PNG behind to be read back.
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, image);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * One host page per device scale factor, reused for the whole run — creating a
 * context and navigating it costs more than every fixture put together. Each
 * fixture still gets a fresh `<iframe>` document, so its styles, its CSSOM and
 * its `FontFaceSet` cannot reach the next fixture; only the HTTP cache carries
 * over, which is exactly the part worth keeping.
 */
interface CaptureHost {
  page: Page;
  /** Captures share one page, so they cannot overlap on it. */
  tail: Promise<unknown>;
}

const hostsByBrowser = new WeakMap<Browser, Map<number, Promise<CaptureHost>>>();

async function createHost(
  browser: Browser,
  browserName: string,
  runnerOrigin: string,
  pixelRatio: number,
): Promise<CaptureHost> {
  const context = await browser.newContext({
    deviceScaleFactor: pixelRatio,
    viewport: { width: 1, height: 1 },
  });
  const page = await context.newPage();
  if (quirks(browserName).reopensRunnerOrigin) {
    await page.goto(runnerOrigin, { waitUntil: 'domcontentloaded' });
  }
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    '</style></head><body></body></html>',
    { waitUntil: 'load' },
  );
  // One throwaway shot so the first measured capture is never also this page's
  // first paint — glyph rasterization is lazy, and a reference is cached to
  // disk the moment it is taken.
  await page.screenshot();
  return { page, tail: Promise.resolve() };
}

function getHost(
  browser: Browser,
  browserName: string,
  runnerOrigin: string,
  pixelRatio: number,
): Promise<CaptureHost> {
  const hosts = hostsByBrowser.get(browser) ?? new Map<number, Promise<CaptureHost>>();
  hostsByBrowser.set(browser, hosts);
  const existing = hosts.get(pixelRatio);
  if (existing) return existing;

  const host = createHost(browser, browserName, runnerOrigin, pixelRatio);
  hosts.set(pixelRatio, host);
  host.catch(() => hosts.delete(pixelRatio));
  return host;
}

async function capture(
  host: CaptureHost,
  browserName: string,
  options: NativeDomCaptureOptions,
): Promise<Buffer> {
  await host.page.setViewportSize({ width: options.width, height: options.height });

  const fontErrors = await host.page.evaluate(async ({ html, width, height }) => {
    document.querySelector('iframe')?.remove();
    const frame = document.createElement('iframe');
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText =
      `position:absolute;left:0;top:0;border:0;margin:0;padding:0;` +
      `width:${width}px;height:${height}px;background:transparent;`;
    const loaded = new Promise((resolve) =>
      frame.addEventListener('load', resolve, { once: true }),
    );
    frame.srcdoc = html;
    document.body.appendChild(frame);
    await loaded;

    const fixture = frame.contentDocument!;
    fixture.body.getBoundingClientRect();
    await fixture.fonts.ready;
    return [...fixture.fonts]
      .filter((face) => face.status === 'error')
      .map((face) => `${face.family} ${face.weight} ${face.style}`);
  }, { html: fixtureHtml(options), width: options.width, height: options.height });
  if (fontErrors.length > 0) {
    throw new Error(
      `captureNativeDom: fonts failed to load: ${fontErrors.join(', ')}`,
    );
  }

  const screenshotOptions = {
    clip: { x: 0, y: 0, width: options.width, height: options.height },
    omitBackground: quirks(browserName).omitsBackground,
    animations: 'disabled' as const,
    scale: 'device' as const,
  };
  return host.page.screenshot(screenshotOptions);
}

/** Capture an independent native-DOM screenshot in the configured engine. */
export const captureNativeDom: BrowserCommand<
  [NativeDomCaptureOptions],
  string
> = async (ctx, options) => {
  if (ctx.provider.name !== 'playwright') {
    throw new Error(
      `captureNativeDom requires the Playwright provider, got ${ctx.provider.name}`,
    );
  }

  const browserName = (ctx.provider as unknown as { browserName?: string })
    .browserName;
  if (!browserName) {
    throw new Error('captureNativeDom: Playwright did not report its browser name');
  }
  const runnerPage = ctx.context.pages()[0];
  const runnerUrl = runnerPage ? new URL(runnerPage.url()) : null;
  if (!runnerUrl || runnerUrl.origin === 'null') {
    throw new Error('captureNativeDom: cannot resolve the Vitest server origin');
  }
  const browser = ctx.context.browser();
  if (!browser) throw new Error('captureNativeDom: Playwright browser is unavailable');

  // Fixture font URLs are absolute against a runner port that moves between
  // runs; normalizing it keeps the reference cache warm across runs.
  const fixture = digest(
    JSON.stringify(options).replaceAll(runnerUrl.origin, '<runner-origin>'),
  );
  const file = path.join(
    NATIVE_DOM_CACHE_ROOT,
    browserName,
    await environmentDigest(browserName, browser),
    `${fixture}.png`,
  );
  const cached = await readCached(file);
  if (cached) return cached.toString('base64');

  const host = await getHost(browser, browserName, runnerUrl.origin, options.pixelRatio);
  // A failed capture must not cancel the ones queued behind it.
  const capturing = host.tail.catch(() => {}).then(async () => {
    // Another test file may have captured this fixture while we waited in line.
    const duplicate = await readCached(file);
    if (duplicate) return duplicate;
    const image = await capture(host, browserName, options);
    await writeCached(file, image);
    return image;
  });
  host.tail = capturing;
  return (await capturing).toString('base64');
};

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureNativeDom(options: NativeDomCaptureOptions): Promise<string>;
  }
}
