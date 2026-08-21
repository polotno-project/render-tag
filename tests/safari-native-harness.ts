import {
  compareCanvasPixels,
  compareWrapping,
  renderToCanvas,
} from './helpers/compare.ts';
import { decodePng } from './helpers/native-compare.ts';

interface SafariFixture {
  html: string;
  css: string;
  width: number;
  height: number;
}

const FIXTURES = {
  solid: {
    html: '<div class="solid">box</div>',
    css:
      '.solid { background: rgb(12, 34, 56); ' +
      'color: rgb(12, 34, 56); font-family: Arial, sans-serif; ' +
      'font-size: 16px; line-height: 16px; }',
    width: 120,
    height: 40,
  },
  rich: {
    html:
      '<div class="rich">Hello <strong>rich</strong> ' +
      '<em>canvas</em> text<br><span>with a second line.</span></div>',
    css:
      '.rich { width: 360px; font-family: Arial, sans-serif; font-size: 20px; ' +
      'line-height: 24px; color: #111; } ' +
      '.rich em { color: #b21f35; } .rich span { text-decoration: underline; }',
    width: 400,
    height: 100,
  },
  wrapped: {
    html:
      '<div class="wrapped">A formatted <strong>word that crosses</strong> ' +
      '<em>the available line width</em> in native Safari.</div>',
    css:
      '.wrapped { font-family: Arial, sans-serif; font-size: 20px; ' +
      'line-height: 24px; color: #111; }',
    width: 220,
    height: 160,
  },
} satisfies Record<string, SafariFixture>;

type FixtureName = keyof typeof FIXTURES;

let prepared: FixtureName | undefined;

function baseCss(css: string): string {
  return (
    'html, body { margin: 0; padding: 0; background: white; overflow: hidden; } ' +
    css
  );
}

async function setFixture(name: FixtureName): Promise<{
  width: number;
  height: number;
  devicePixelRatio: number;
}> {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`Unknown Safari oracle fixture: ${name}`);

  const style = document.createElement('style');
  style.textContent = baseCss(fixture.css);
  document.head.querySelectorAll('style[data-safari-oracle]').forEach((node) => node.remove());
  style.dataset.safariOracle = '';
  document.head.appendChild(style);

  const root = document.querySelector<HTMLElement>('#fixture')!;
  root.style.cssText =
    `width:${fixture.width}px;height:${fixture.height}px;` +
    'margin:0;padding:0;overflow:hidden';
  root.innerHTML = fixture.html;
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  prepared = name;
  return { width: fixture.width, height: fixture.height, devicePixelRatio };
}

async function compareScreenshot(base64: string) {
  if (!prepared) throw new Error('Call setFixture before compareScreenshot');
  const fixture = FIXTURES[prepared];
  const shot = await decodePng(base64);

  const pixelRatio = shot.width / innerWidth;
  const pixelWidth = Math.ceil(fixture.width * pixelRatio);
  const pixelHeight = Math.ceil(fixture.height * pixelRatio);
  if (shot.height < pixelHeight) {
    throw new Error(
      `Safari screenshot is too short: ${shot.height}px < ${pixelHeight}px`,
    );
  }

  // The driver screenshots the whole window; crop to the fixture box.
  const reference = document.createElement('canvas');
  reference.width = pixelWidth;
  reference.height = pixelHeight;
  reference.getContext('2d')!.drawImage(shot, 0, 0);

  const result = renderToCanvas(
    fixture.html,
    baseCss(fixture.css),
    fixture.width,
    fixture.height,
    pixelRatio,
  );
  const pixels = compareCanvasPixels(reference, result.canvas);
  const wrap = compareWrapping(
    fixture.html,
    baseCss(fixture.css),
    fixture.width,
    fixture.height,
    result.lines,
  );
  return {
    name: prepared,
    mismatchedPixels: pixels.mismatchedPixels,
    contentPixels: pixels.contentPixels,
    contentMismatchPercentage: pixels.contentMismatchPercentage,
    wrapMatches: wrap.wrappingMatch,
    wrapDifferences: wrap.differentLines,
    pixelRatio,
  };
}

window.safariNativeOracle = { setFixture, compareScreenshot };

declare global {
  interface Window {
    safariNativeOracle: {
      setFixture: typeof setFixture;
      compareScreenshot: typeof compareScreenshot;
    };
  }
}
