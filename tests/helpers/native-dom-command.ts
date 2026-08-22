import type { BrowserCommand } from 'vitest/node';
import '@vitest/browser-playwright';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { matchFontFaces, stripFontFaces } from './css-text.ts';

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

function fixtureHtml(fontCss: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    '</style><style data-fonts>' + fontCss +
    '</style><style data-fixture></style></head><body><div>' +
    '<div data-content style="margin:0;padding:0;overflow:hidden"></div>' +
    '</div></body></html>'
  );
}

function splitCss(css: string): { fontCss: string; fixtureCss: string } {
  return {
    fontCss: matchFontFaces(css).join('\n'),
    fixtureCss: stripFontFaces(css),
  };
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
    readFile(new URL('./css-text.ts', import.meta.url)),
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
 * One browser context per device scale factor, reused for the whole run.
 * Capture documents persist by exact font set so fonts load only once, and
 * WebKit puts each font set in its own top-level page as well.
 *
 * That second layer was added when frames were discarded per fixture, which
 * could poison a later face with the same family/source. Frames now persist,
 * so the original trigger is gone: disabling the page split passed a cold
 * WebKit run of the full lane. It is kept because a font-cache regression here
 * is silent — it caches a wrong reference PNG — and one green run is not
 * enough evidence to remove it. Delete it if CI stays green without it.
 */
interface CaptureHost {
  page: Page;
  runnerOrigin: string;
  fontPages: Map<string, Promise<Page>>;
  /** Captures mutate persistent documents, so serialize them. */
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
  await initializePage(page, browserName, runnerOrigin);
  return {
    page,
    runnerOrigin,
    fontPages: new Map(),
    tail: Promise.resolve(),
  };
}

async function initializePage(
  page: Page,
  browserName: string,
  runnerOrigin: string,
): Promise<void> {
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
}

async function pageForFontSet(
  host: CaptureHost,
  browserName: string,
  fontCss: string,
): Promise<Page> {
  if (browserName !== 'webkit') return host.page;
  const existing = host.fontPages.get(fontCss);
  if (existing) return existing;

  const page = host.fontPages.size === 0
    ? Promise.resolve(host.page)
    : host.page.context().newPage().then(async (created) => {
      await initializePage(created, browserName, host.runnerOrigin);
      return created;
    });
  host.fontPages.set(fontCss, page);
  page.catch(() => host.fontPages.delete(fontCss));
  return page;
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
  const { fontCss, fixtureCss } = splitCss(options.css);
  const page = await pageForFontSet(host, browserName, fontCss);
  await page.setViewportSize({ width: options.width, height: options.height });

  const fontErrors = await page.evaluate(async ({ documentHtml, fontCss, fixtureCss, contentHtml, width, height }) => {
    type CaptureWindow = Window & {
      __renderTagCaptureFrames?: Map<string, HTMLIFrameElement>;
    };
    const captureWindow = window as CaptureWindow;
    const frames = captureWindow.__renderTagCaptureFrames ||= new Map();
    for (const existing of frames.values()) existing.style.display = 'none';

    let frame = frames.get(fontCss);
    let loaded: Promise<unknown> | undefined;
    if (!frame) {
      frame = document.createElement('iframe');
      loaded = new Promise((resolve) =>
        frame!.addEventListener('load', resolve, { once: true }),
      );
      frame.srcdoc = documentHtml;
      document.body.appendChild(frame);
      frames.set(fontCss, frame);
    }
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText =
      `position:absolute;left:0;top:0;border:0;margin:0;padding:0;` +
      `width:${width}px;height:${height}px;background:transparent;`;
    if (loaded) await loaded;

    const fixture = frame.contentDocument!;
    if (loaded) {
      // WebKit aborts some concurrently selected fallback subsets (notably
      // CJK and emoji). The fixture CSS has already been reduced to faces that
      // cover its text, so load those faces once, in source order, before the
      // persistent document receives content.
      for (const face of fixture.fonts) {
        if (face.status === 'unloaded') await face.load().catch(() => {});
      }
    }
    fixture.querySelector<HTMLStyleElement>('style[data-fixture]')!.textContent = fixtureCss;
    fixture.querySelector<HTMLElement>('[data-content]')!.innerHTML = contentHtml;
    fixture.body.getBoundingClientRect();
    await fixture.fonts.ready;
    return [...fixture.fonts]
      .filter((face) => face.status === 'error')
      .map((face) => `${face.family} ${face.weight} ${face.style}`);
  }, {
    documentHtml: fixtureHtml(fontCss),
    fontCss,
    fixtureCss,
    contentHtml: options.html,
    width: options.width,
    height: options.height,
  });
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
  return page.screenshot(screenshotOptions);
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
