/**
 * The engine whose canvas to work around, from the UA alone (layout never
 * touches the DOM). Blink is the default, so a server-side render matches
 * headless Chrome. Gecko is the only engine with a real `Gecko/<date>` token.
 * Safari is AppleWebKit without `Chrome/`, `jsdom/` or `HappyDOM/` (both borrow
 * WebKit's UA); `Chrome/` has no word boundary because of `HeadlessChrome/`.
 */
const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
export const ENGINE: 'blink' | 'webkit' | 'gecko' = /\bGecko\/\d/.test(UA) ? 'gecko'
  : /AppleWebKit/.test(UA) && !/Chrome\/\d/.test(UA) && !/\b(jsdom|HappyDOM)\//.test(UA) ? 'webkit' : 'blink';

// One layout in every browser, Chrome's (README, Design decisions). A flag here only works
// around a canvas that reports or paints differently, so that canvas yields Chrome's layout
// and paint; it never follows another engine's own layout. One flag per canvas question,
// even where two select the same engines today: never gate one on another's flag.

/** Blink paints a plain LTR source run with one shaped fillText without moving
 * its DOM raster. paint-runs. */
export const BLINK_TEXT_RUN_SHAPING = ENGINE === 'blink';

/** One fillText of a whole bidi line matches the engine's own layout. Not in
 * WebKit, whose Canvas orders it differently. bidi-order-parity. */
export const CANVAS_BIDI_LINE = ENGINE !== 'webkit';

/** Firefox's canvas reports the font box ceiled to whole px where Chrome's and WebKit's round
 * it (Arimo 16px: 15 / 4 over 14.48 / 3.39, Chrome 14 / 3; Playfair 100px: 109 / 26, Chrome
 * 108 / 25): `chromeFontBox` reads it at EXACT_PROBE_SIZE and rounds it as Chrome does.
 * cross-browser.compare. */
export const CANVAS_CEILS_FONT_BOX = ENGINE === 'gecko';

/** Firefox's canvas rounds each glyph advance to 1/60px at the font's size (Open Sans 700 16px
 * "Съешь же ещё этих мягких французских булок": 398.883px, Chrome 398.992) and snaps a fractional
 * size (Open Sans 2.2px: 1.1% narrow, 11.2px: 0.55% wide), so a line can fit a word Chrome wraps. At EXACT_PROBE_SIZE and scaled it reports Chrome's within 0.002px:
 * `Measurer.width` reads widths there, but emoji (`STRIKE_SIZED`) and fonts designed per size
 * (`SCALING_PROBES`). cross-browser.compare. */
export const CANVAS_ROUNDS_ADVANCES = ENGINE === 'gecko';

/** Firefox's canvas widens each glyph of a synthetic bold, ~0.57px at 20px (Lobster, one weight:
 * "still underlined" 125.03px bold, 115.97 regular), where Chrome's keeps the regular advances
 * (116.02 both): layout measures the regular face (`syntheticBoldWidening`) and paint takes the
 * widening back out with letter-spacing. cross-browser.compare. */
export const CANVAS_WIDENS_SYNTHETIC_BOLD = ENGINE === 'gecko';

/** `measureText`'s ink box is not the painted ink, so `Measurer.inkBox` reads the
 * pixels. WebKit's always holds the pen origin and the advance, whatever the
 * textBaseline, textAlign or letterSpacing: `•` (Roboto 100px, ink 47.4 up,
 * -26.2 down, -6.8 left, 26.7 right) reads 47.4 / 0 / 0 / 33.7. Gecko's sits
 * ~1px right of the ink at any size. Blink's is the ink only on macOS; Linux and
 * Windows round it to whole pixels (`•` Roboto 120px reads 56 / -31 / -8 / 33 for
 * 56.9 / -31.4 / -8.1 / 32), so does every Blink platform but macOS identify.
 * Node and jsdom have no canvas to read. engine-probe marker-ink (CI),
 * list-marker-geometry. */
export const INK_BOX_FROM_PAINT = ENGINE !== 'blink' || /\b(Windows|Linux|CrOS)\b/.test(UA);

