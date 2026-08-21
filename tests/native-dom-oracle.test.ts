import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { compareNativeRenders, decodePng } from './helpers/native-compare.ts';
import { loadBasicCases } from './helpers/test-cases.ts';

describe('native DOM oracle', () => {
  it('captures real browser paint at the requested device-pixel ratio', async () => {
    const base64 = await commands.captureNativeDom({
      html: '<div class="probe"></div>',
      css: '.probe { width: 20px; height: 10px; background: rgb(12, 34, 56); }',
      width: 40,
      height: 30,
      pixelRatio: 2,
    });

    const canvas = await decodePng(base64);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(60);
    expect([...canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data])
      .toEqual([12, 34, 56, 255]);
  });

  it('matches render-tag when both paint the same supported rich text', async () => {
    const result = await compareNativeRenders(
      '<div>Hello <strong>rich</strong> text</div>',
      'body { font-family: Arial, sans-serif; font-size: 20px; line-height: 24px; color: #000; }',
      300,
      80,
      0.1,
      2,
    );

    // Blink's DOM and Canvas text paths disagree on one antialias edge pixel
    // in this fixture. Keep that transport-level residue explicit and tiny.
    expect(result.mismatchedPixels).toBeLessThanOrEqual(1);
    expect(result.contentMismatchPercentage).toBeLessThan(0.04);
  });

  it('detects paint that render-tag does not implement', async () => {
    const result = await compareNativeRenders(
      '<div>Blurred text</div>',
      'body { font-family: Arial, sans-serif; font-size: 24px; line-height: 29px; } div { filter: blur(2px); }',
      300,
      80,
      0.1,
      2,
    );

    expect(result.mismatchedPixels).toBeGreaterThan(0);
  });

  it('loads a pinned corpus font without replacing the capture realm', async () => {
    const testCase = (await loadBasicCases()).find(
      ({ name }) => name === 'Styled table',
    )!;
    const base64 = await commands.captureNativeDom({
      html: testCase.html,
      css: testCase.css,
      width: testCase.width,
      height: testCase.height,
      pixelRatio: 2,
    });
    const canvas = await decodePng(base64);

    expect(canvas.width).toBe(testCase.width * 2);
    expect(canvas.height).toBe(testCase.height * 2);
  });
});
