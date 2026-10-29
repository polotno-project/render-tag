# Changelog

Only the interesting, user-visible changes. Full detail lives in the git history.

## 0.4.1 — 2026-10-29

- Draw list bullets at their exact size and place in Chrome on Windows, Linux, ChromeOS and Android, as on macOS: Chrome there reports a bullet's ink in whole pixels, which put it up to 1.6px off.
- Keep a space's kerning into the next word under `white-space: pre`, `pre-wrap` and `break-spaces` (in Arial before "A", "T" or "Y"): the rest of such a line no longer drifts right of the browser's layout.
- Text units: a word after a kerned space paints exactly where `drawLayout` paints it, so word and line units at rest no longer sit up to a pixel off.

## 0.4.0 — 2026-10-29

- Animate text by line, word or letter: `layout({ textUnits })` cuts the laid-out text into units, and `drawLayout({ paintTextUnit })` paints each one under its own canvas state, with its gradient, stroke, decorations and shadow. See the [live examples](https://polotno.com/render-tag/#motion).
- Draw list bullets at Chrome's size and position in every browser: they were about half size and too high in WebKit, and 1.5px off in Firefox. Bold and italic lists keep a full-size bullet, and numbers follow the item's weight and style.
- Lay out bulleted lists up to 2.5× faster in Firefox and 1.5× faster in WebKit.
- Apply the horizontal margins of inline elements, and their padding and borders even when they paint no background, as browsers do.
- `word-spacing` now also widens preserved spaces and no-break spaces, as browsers do.
- Fix `<bdo dir="rtl">` and `unicode-bidi: bidi-override`: wrapped text is reordered per line, combining marks and emoji stay whole, and Hebrew and Arabic no longer paint mirrored. Vector adapters receive such text wrapped in U+202E…U+202C.
- Place Hebrew on a path letter by letter, so it follows the curve.
- Draw bordered boxes about twice as fast.
- Keep `letter-spacing` and `word-spacing` on canvases that ignore `ctx.letterSpacing` and `ctx.wordSpacing` (Safari before 18.4, node-canvas, Chrome before 99, Firefox before 115): render-tag now measures and places the spacing itself, as Chrome spaces it, so spaced text no longer loses its spacing or runs past a right-aligned box there.

## 0.3.3 — 2026-10-24

- Lay out and draw faster with fewer allocations: plain ASCII text skips Unicode segmentation, a word split across many inline styles lays out in linear time instead of quadratic, and drawing derives each style's text state once per draw.
- Fix a memory leak: a kept `layout()` result whose styles used percentages held on to the measuring canvas context. A kept `layoutTextOnPath()` result now also releases it once `paintBounds` is read.
- Fix `line-height: inherit` and `text-underline-offset: inherit` after an earlier value on the same element: they now take the parent's value, as browsers do.

## 0.3.2 — 2026-10-14

- Break lines where Chrome and WebKit break them at the edge of the box: the available width is truncated to the engines' 1/64px layout grid and a line is kept up to one unit over it, instead of a flat 0.02px tolerance. Text fitted to a fractional width (for example `751.855px`) no longer re-wraps between the DOM and the canvas.

## 0.3.1 — 2026-10-14

- Fix `-webkit-line-clamp` dropping the "…" when the cut falls at a paragraph boundary (`<p>Intro</p><p>two</p><p>three</p><p>four</p>` clamped to 3 lines now ends in "three…", like Chrome).

## 0.3.0 — 2026-10-13

- Lay out long documents up to twice as fast and stop retaining memory across calls: line tops no longer live in a module-level table, and plain Latin, Greek and Cyrillic text is measured after the previous word only (same line breaks, about half the `measureText` calls).
- Draw plain text with one `fillText` per fragment in Chromium, including shadowed text and fragments beside decorated or boxed siblings: about three times fewer drawing commands, closer to Chrome's own shaping.
- Draw text on a path with one transform per run instead of a save/translate/rotate per glyph, cull shadow tiles by glyph, and paint its decorations at the measured browser positions with continuous dashes and waves.
- Stroke a uniform border as one rectangle, so translucent corners are no longer double-blended.
- Fix hangs on extreme input: a huge font size or blur inside `text-shadow`, and deeply nested elements matched by a long descendant selector.
- Fix a dotted underline exactly two dots wide painting as a solid line, NaN geometry from a `pre-wrap` tab at `font-size: 0` or malformed path data, and author text named `constructor` corrupting the cascade.
- Reject non-finite `width` and `pixelRatio`, and release the measuring context once `paintBounds` is read.
- Remove the `accuracy` option: layout is canvas measurement only and never touches the DOM.
- Ship no source maps or Node entry shims; the package is 208 KB packed instead of 454 KB. Types are now strict.

## 0.2.2 — 2026-10-08

- Speed up text layout by reusing measurements and preparing inline content once per layout call; reduce temporary layout allocations.
- Resolve CSS selectors, shorthands, inheritance and invalid values more like browsers; add relative units, CSS math functions and `box-sizing` support.
- Improve mixed-direction text across inline styles with Unicode bidirectional ordering, including text on a path.
- Match browser line heights, baselines, text decorations, gradients and text shadows more closely while preserving foreground drawing commands for vector adapters.
- Fix width constraints and percentage sizing in inline blocks, flex items and table cells.
- Update the website with editable rich text, rendering examples, layout measurements, and a fresh-render performance comparison.

## 0.2.1 — 2026-09-28

- Text on a path now applies CSS `text-transform`.
- Capitalization follows browser word boundaries across inline styles, quotes and inline blocks.
- Text on a path omits `display:none` descendants.

## 0.2.0 — 2026-09-23

- Add lazy `paintBounds` to ordinary and curved text layouts, including overflowing glyphs, strokes, decorations and CSS shadows.
- Account for synthetic italic overflow in WebKit when sizing text paint buffers.

## 0.1.37 — 2026-09-16

- Expose per-box line geometry and hard breaks through `LayoutBox.lineBoxes`, including blank lines from `<br>` and preserved newlines.
- Match native HTML text-decoration color and thickness when text has a stroke, including text on a path.

## 0.1.36 — 2026-09-16

- Fix Safari shadow corruption on scaled gradient text.
- Shadows stay behind text fill, outlines and decorations without repainting the foreground, including text on a path.
- Shadow buffering preserves foreground drawing commands for vector adapters. Add `createCanvas` for Node shadow rendering and `renderShadows: false` to omit effects.

## 0.1.35 — 2026-08-26

- Fix: text on a path applied `letter-spacing` twice — curved text drew at double the requested tracking, and centered text sat half a space off center.
- Fix: text on a path could drop its last glyph with `align: right` or `align: justify` when `letter-spacing` was set, and a gradient across the text ran out before that glyph's ink.

## 0.1.34 — 2026-08-25

- `border-radius` support: backgrounds and uniform borders, per-corner values, percentages (`50%` draws real circles/ellipses). Closes [#2](https://github.com/polotno-project/render-tag/issues/2).
- Fix: the `border` shorthand truncated `rgb()`/`hsl()` colors and painted the border with a leftover color.
- Fix: inline background boxes now follow `vertical-align`, and super/sub offsets match each engine's own rule (thanks @jacobmolby, [#3](https://github.com/polotno-project/render-tag/pull/3)).
- More accurate line breaking: CJK punctuation glue (kinsoku), hyphen and inline-block breaks, and flex items sized from real flex base sizes.
- Chrome canvas output keeps text shaping across spaces (a plain run paints as one `fillText`).
- API for external renderers: layout node types (`LayoutBox`, `LayoutText`, `ResolvedStyle`, …), `getFontMetrics` and `tabStopMetrics` are exported; `layoutRoot` is documented as the rendering surface (`lines` is a lossy summary).

## 0.1.33 — 2026-08-21

- Fix: negative list margins are preserved instead of clamped.

## 0.1.32 — 2026-08-20

- `lineBaselineOffset` exported — the one baseline-placement rule shared with external renderers.
- Fix: `getFontMetrics` no longer leaves the ctx font changed.

## 0.1.31 — 2026-08-20

- Unknown engines default to Blink behavior (Chrome-first), so exotic browsers get Chrome's output instead of a mix.

## 0.1.30 — 2026-08-20

- Line boxes are built the way each engine builds them: mixed font sizes and `vertical-align` on one line now stand at the correct height and baseline.

## 0.1.29 — 2026-08-13

- `text-underline-offset` and `text-decoration-thickness` support.

## 0.1.28 — 2026-08-13

- Decoration lines (underline/strikethrough) take their thickness and position from the decorating element, matching the browser.

## 0.1.27 — 2026-07-29

- Fix: crash at inline-run boundaries; emoji may break between runs again.

## 0.1.26 — 2026-07-15

- Fix: gradient text (`background-clip: text`) and text-stroke gradients survive `break-word` splits.

Older releases: see the git history.
