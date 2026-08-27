# Changelog

Only the interesting, user-visible changes. Full detail lives in the git history.

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
