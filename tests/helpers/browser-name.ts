/**
 * Engine detection for the test lanes — picks which recorded baseline applies.
 * `src/layout.ts` keeps its own detection for the shipped library; this one is
 * test-only and must stay in a single place so every suite agrees.
 */
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const isFirefox = ua.includes('Firefox');
export const isWebKit = ua.includes('AppleWebKit') && !ua.includes('Chrome');
export const browserName: 'firefox' | 'webkit' | 'chrome' = isFirefox
  ? 'firefox'
  : isWebKit
    ? 'webkit'
    : 'chrome';
