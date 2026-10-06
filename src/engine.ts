/**
 * Which engine's line rules to follow. Only the UA string can say, because
 * `accuracy: 'performance'` promises not to touch the DOM.
 *
 * Blink is the DEFAULT, and the other two are what we detect: a server-side
 * render (no navigator, or jsdom) targets headless Chrome, so anything we
 * cannot positively identify has to round the way Chrome does.
 *
 * - Gecko is the one engine that still sends a real `Gecko/<date>` product
 *   token; Blink and WebKit carry only the "like Gecko" comment, no slash.
 * - Safari is WebKit that says neither `Chrome/` nor `jsdom/`. jsdom borrows
 *   WebKit's UA and would otherwise be mistaken for it.
 * - `Chrome/` is matched with NO word boundary, because headless Chrome sends
 *   `HeadlessChrome/`.
 */
const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
export const IS_GECKO = /\bGecko\/\d/.test(UA);
export const IS_SAFARI =
  /AppleWebKit/.test(UA) && !/Chrome\/\d/.test(UA) && !/\bjsdom\//.test(UA);

/**
 * True where a PERCENTAGE line-height is an integer percentage: Blink and
 * WebKit truncate it before they multiply (162.9% of 100px computes to
 * 162px, 133.3% acts as 133%; it is the percentage that is truncated, not
 * the product — 162.5% of 8px is a 12.953125px Blink line, 8 x 1.62 on its
 * grid). Measured in Chromium and Playwright WebKit (line-baseline-parity).
 * Gecko keeps the exact percentage (not measured here; UNVERIFIED).
 */
export const INTEGER_PERCENT_LINE_HEIGHT = !IS_GECKO;
