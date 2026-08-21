import type { BrowserCommand } from 'vitest/node';
import '@vitest/browser-playwright';

export interface NativeDomCaptureOptions {
  html: string;
  css: string;
  width: number;
  height: number;
  pixelRatio: number;
}

function pageHtml(options: NativeDomCaptureOptions): string {
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

  const configuredBrowser = (ctx.provider as unknown as { browserName?: string })
    .browserName;
  const runnerPage = ctx.context.pages()[0];
  const runnerUrl = runnerPage ? new URL(runnerPage.url()) : null;
  if (!runnerUrl || runnerUrl.origin === 'null') {
    throw new Error('captureNativeDom: cannot resolve the Vitest server origin');
  }
  const browser = ctx.context.browser();
  if (!browser) throw new Error('captureNativeDom: Playwright browser is unavailable');

  const isolated = await browser.newContext({
    deviceScaleFactor: options.pixelRatio,
    viewport: { width: options.width, height: options.height },
  });
  try {
    const page = await isolated.newPage();
    // Firefox cannot reopen Vitest's runner origin from a second context; the
    // test server allows CORS so its absolute font URLs still load here.
    if (configuredBrowser !== 'firefox') {
      await page.goto(runnerUrl.origin, { waitUntil: 'domcontentloaded' });
    }
    await page.setContent(pageHtml(options), { waitUntil: 'load' });

    const fontErrors = await page.evaluate(async () => {
      document.body.getBoundingClientRect();
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === 'error')
        .map((face) => `${face.family} ${face.weight} ${face.style}`);
    });
    if (fontErrors.length > 0) {
      throw new Error(
        `captureNativeDom: fonts failed to load: ${fontErrors.join(', ')}`,
      );
    }

    // omitBackground asks Firefox to change the page background, an operation
    // its Playwright transport does not implement. Pixel comparison already
    // normalizes both images onto white, so an opaque screenshot is equivalent.
    const screenshotOptions = {
      clip: { x: 0, y: 0, width: options.width, height: options.height },
      omitBackground: configuredBrowser !== 'firefox',
      animations: 'disabled' as const,
      scale: 'device' as const,
    };
    // Warm lazily resolved glyph faces before taking the measured image.
    await page.screenshot(screenshotOptions);
    return (await page.screenshot(screenshotOptions)).toString('base64');
  } finally {
    await isolated.close();
  }
};

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureNativeDom(options: NativeDomCaptureOptions): Promise<string>;
  }
}
