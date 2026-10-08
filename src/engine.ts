/**
 * The engine whose rules to follow, from the UA alone (`accuracy: 'performance'`
 * never touches the DOM). Blink is the default, so a server-side render matches
 * headless Chrome. Gecko is the only engine with a real `Gecko/<date>` token.
 * Safari is AppleWebKit without `Chrome/` and without `jsdom/` (jsdom borrows
 * WebKit's UA); `Chrome/` has no word boundary because of `HeadlessChrome/`.
 */
const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
export const ENGINE: 'blink' | 'webkit' | 'gecko' = /\bGecko\/\d/.test(UA) ? 'gecko'
  : /AppleWebKit/.test(UA) && !/Chrome\/\d/.test(UA) && !/\bjsdom\//.test(UA) ? 'webkit' : 'blink';

// One flag per engine question, even where two select the same engines today:
// never gate one rule on another's flag.

/** A percentage line-height is truncated to an integer percentage before it
 * multiplies (162.9% acts as 162%). Blink and WebKit; line-baseline-parity. */
export const INTEGER_PERCENT_LINE_HEIGHT = ENGINE !== 'gecko';

/** The text-shadow of a -webkit-text-stroke'd glyph includes the stroke
 * (WebKit); Blink casts it from the fill only. text-shadow-coverage. */
export const STROKE_CASTS_TEXT_SHADOW = ENGINE !== 'blink';

/** Blink paints a plain LTR source run with one shaped fillText without moving
 * its DOM raster. paint-runs. */
export const BLINK_TEXT_RUN_SHAPING = ENGINE === 'blink';

/** One fillText of a whole bidi line matches the engine's own layout. Not in
 * WebKit, whose Canvas orders it differently. bidi-order-parity. */
export const CANVAS_BIDI_LINE = ENGINE !== 'webkit';

/** The line baseline is floored to a whole CSS pixel (Blink; WebKit over its
 * truncated line-height). Gecko keeps it exact. line-baseline-parity. */
export const FLOORS_LINE_BASELINE = ENGINE !== 'gecko';

/** `super` = fontSize/3 + 1, `sub` = fontSize/5 + 1 (Blink and WebKit); Gecko
 * shifts 0.34em / 0.2em. line-baseline-parity. */
export const BLINK_SUPER_SUB = ENGINE !== 'gecko';

/** WebKit floors the float32 line-height to whole pixels (16px x 1.6 = 25px).
 * line-baseline-parity, line-box-parity. */
export const TRUNCATES_LINE_HEIGHT = ENGINE === 'webkit';

/** Blink paints each line box at a whole CSS pixel (round half up of its top)
 * while layout stays fractional. WebKit snaps to device pixels (not modelled).
 * line-paint-snap-parity. */
export const SNAPS_LINE_PAINT = ENGINE === 'blink';

/** Blink's auto underline top sits `ceil(fontSize / 20)` below the snapped
 * baseline, font-independent. decoration-geometry, line-paint-snap-parity. */
export const BLINK_UNDERLINE_GAP = ENGINE === 'blink';

/** A list item whose children all collapse through still gets its marker's
 * line box in Blink; WebKit gives it no height. margin-collapse-parity. */
export const MARKER_LINE_WITHOUT_CONTENT = ENGINE === 'blink';

/**
 * Margins leaving a block's bottom from its last child, under a min-height
 * (margin-collapse-parity):
 * - `'drop'` (Blink): a min-height that raises the box loses those margins.
 * - `'collapse'` (WebKit): CSS 2.1 §8.3.1 — they always pass out.
 * - `'contain'` (Gecko, unmeasured): any nonzero min-height keeps them inside.
 *   Firefox CI disagrees for min-heights at or near the content height.
 */
export const MIN_HEIGHT_END_MARGINS: 'drop' | 'collapse' | 'contain' =
  ENGINE === 'gecko' ? 'contain' : ENGINE === 'webkit' ? 'collapse' : 'drop';

/** Blink lays line-heights on its 1/64px LayoutUnit grid: a number floors the
 * product, a length rounds to nearest, the half-leading truncates.
 * line-baseline-parity. */
export const LAYOUT_UNIT_LINE_HEIGHT = ENGINE === 'blink';

/** Gecko rounds a line-height to its 1/60px app units (17.3px x 1.85 = 32.005
 * lays out as 32), measured in Firefox CI. line-baseline-parity. */
export const APP_UNIT_LINE_HEIGHT = ENGINE === 'gecko';
