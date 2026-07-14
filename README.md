# render-tag

Render HTML rich text onto canvas with the 2D API. No SVG, no `foreignObject` — just `fillText`, `measureText`, and drawing primitives. Significantly faster than SVG-based approaches; synchronous; zero dependencies.

**Website & demos:** [https://polotno.com/render-tag/](https://polotno.com/render-tag/)

By design, render-tag focuses on **rich text only** — paragraphs, headings, lists, tables, inline formatting. Not interactive elements or arbitrary HTML layouts.

## Install

```bash
npm install render-tag
```

## Usage

```typescript
import { render } from 'render-tag';

const { canvas, height } = render({
  html: `
    <style>.title { font: 24px Georgia, serif; color: #1a1a1a; }</style>
    <p class="title">Hello <strong>world</strong></p>
  `,
  width: 400,
});

document.body.appendChild(canvas);
```

`render` is **synchronous** — load fonts before calling (e.g. `await document.fonts.load('400 16px "Roboto"')`). If a font isn't loaded yet, the browser falls back to a default and text metrics will be wrong. Re-render once fonts arrive.

## API

```ts
function render(config: RenderConfig): { canvas, height, layoutRoot, lines };
function layout(config: LayoutConfig): { layoutRoot, height, lines };
function drawLayout(config: DrawConfig): { canvas };
```

| Option | Default | Notes |
|---|---|---|
| `html` | *required* | HTML string (include `<style>` tags for CSS). |
| `width` | *required* | Layout width in CSS pixels. |
| `height` | auto | Fixed height; auto-sized from content if omitted. |
| `canvas` | created | Existing target canvas (mutually exclusive with `ctx`). |
| `ctx` | — | Existing 2D context — no canvas resizing or scaling. |
| `pixelRatio` | `devicePixelRatio` | HiDPI scaling. |
| `accuracy` | `'performance'` | `'balanced'` uses DOM probes for per-browser line-height accuracy; `'performance'` is pure canvas and consistent cross-browser. |

Use `layout()` + `drawLayout()` when you need to measure content, render the same layout onto multiple targets, or render onto an `OffscreenCanvas`.

### `LayoutLine`

Each entry in `result.lines`:

```ts
interface LayoutLine {
  y: number;        // baseline y
  text: string;
  bounds: { x, y, width, height };  // DOMRect-shaped line box
}
```

`bounds` is a drop-in replacement for `Range.getClientRects()` per line — useful for per-line backgrounds, hit-testing, or highlighting.

### Multi-line ellipsis (`-webkit-line-clamp`)

```css
.caption { width: 240px; -webkit-line-clamp: 3; }
```

Clips to N lines and appends an ellipsis to the Nth. `line-clamp` (unprefixed) is accepted as a synonym. `none` / `auto` / `0` mean "no clamp". Like Chrome's legacy `-webkit-box` behavior, the line count spans block descendants — a clamp on a wrapper truncates across its `<p>`/`<div>` children and drops everything below the cut.

## Text on path: `render-tag/path`

Draw rich text along an SVG path. Separate subpath entry point.

```ts
import { drawTextOnPath } from 'render-tag/path';

drawTextOnPath({
  html: '<span style="font:24px sans-serif">Hello <b>world</b></span>',
  path: 'M20,150 Q200,20 380,150',  // SVG `d` string, or a PathLike
  ctx,
  align: 'center',          // 'left' | 'center' | 'right' | 'justify' (default 'left')
  textBaseline: 'middle',   // path = vertical center of text (default 'alphabetic')
});
```

`textBaseline` controls where the path runs relative to the text:
`'alphabetic'` (default) — path = baseline, descenders below.
`'middle'` — path through the vertical center.
`'top'` / `'bottom'` — text hangs below / above the path.

Same HTML/CSS dialect as the main API: fonts, colors, weights, `direction: rtl`, `text-shadow`, `background-color`, `text-decoration`, gradient text via `background-clip: text`. Joining scripts (Arabic, Hebrew, Indic, Thai, Khmer, Myanmar) are shaped as runs so cursive joining works.

The path lays out as a single logical line — glyphs that overflow the path's end are dropped.

Returns `{ glyphs, textWidth, pathLength, lineHeight, bounds }`. Each `GlyphPlacement` has `{ char, x, y, rotation, width, style, ascent, descent, pathOffset, shaped }`.

`bounds` is a `DOMRect`-shaped `{ x, y, width, height }` describing the visible area of the rendered curved text — the union of per-glyph cells. Use it to size a parent UI element without re-walking the glyphs. The library does not consume `bounds` internally; it's purely for consumers.

### Layout once, draw many

```ts
import { layoutTextOnPath, drawTextOnPathLayout } from 'render-tag/path';

const result = layoutTextOnPath({ html, path, align: 'center' });
drawTextOnPathLayout({ layout: result, ctx: canvas1.getContext('2d')! });
drawTextOnPathLayout({ layout: result, ctx: canvas2.getContext('2d')! });
```

Not supported: full mixed-script BiDi shaping (pure-RTL via `direction: rtl` works).

## Node.js / server-side

render-tag stays zero-dependency, so nothing works out of the box in Node — inject a DOM parser (linkedom, jsdom, …) and pass a measurement 2D context. Nothing is ever written to `globalThis`.

```ts
import { layout, drawLayout, setDOMParser } from 'render-tag';
import { DOMParser } from 'linkedom';
import { createCanvas } from 'canvas';

setDOMParser(new DOMParser()); // once

const ctx = createCanvas(1, 1).getContext('2d');
const result = layout({ html, width: 400, ctx }); // ctx is required on Node
drawLayout({ layout: result, width: 400, ctx: outputCtx });
```

Without injection, functions throw with guidance. `accuracy: 'balanced'` needs a real browser DOM and throws on Node — use the default `'performance'`. `render-tag/path` works the same way (`layoutTextOnPath` already takes `ctx`; it re-exports `setDOMParser`).

## What it renders

Paragraphs, headings, divs, spans · bold, italic, underline, strikethrough, overline · colors, background colors, text-shadow, text-stroke (solid **and gradient**), gradient text · font families, sizes, weights (100–900) · line-height, letter-spacing, text-align (left/center/right/justify) · ordered/unordered lists with nesting · flexbox (row/column), basic tables · `-webkit-line-clamp` · `pre-wrap`, `overflow-wrap: break-word`, soft hyphens · RTL, CJK, emoji.

## render-tag-specific inputs

render-tag renders plain HTML/CSS — no custom syntax required. The exception:
a couple of properties that **have no real CSS equivalent** for canvas text, so
render-tag reads them off the element's style as an extra channel. They are
inert in a real browser (a browser ignores or drops them), so the same HTML
still renders in the DOM — render-tag just paints a little extra.

| Property | Type | Effect |
|---|---|---|
| `--rt-text-stroke-image` | CSS custom property, a `linear-gradient(...)` | Paints the `-webkit-text-stroke` outline with a gradient instead of a solid color. |
| `stroke-linejoin` | `round` (default) \| `miter` \| `bevel` | Corner join for `-webkit-text-stroke` (SVG-style; HTML text-stroke has no join control). |

### Gradient text stroke

CSS can only give a text stroke a **solid** color (`-webkit-text-stroke: 4px #333`),
and there is no CSS way to paint the outline with a gradient — the DOM
work-around is a two-layer `background-clip: text` stack. On canvas a gradient
stroke is trivial (`ctx.strokeStyle = gradient`), so render-tag exposes it
directly. Set the normal stroke for width + a solid fallback color, then hand
render-tag the gradient via `--rt-text-stroke-image`:

```html
<div style="
  color: #fff;                                     /* fill */
  -webkit-text-stroke: 4px #000;                   /* width + solid fallback */
  --rt-text-stroke-image: linear-gradient(0deg, #000 0%, #d400ff 100%);
  paint-order: stroke fill;                         /* stroke under the fill */
">Outlined</div>
```

The gradient spans the declaring element (like a `background-clip: text` fill
gradient) and threads through block children (`<p>`, `<li>`), so wrapped lines
and list items share one continuous stroke gradient. A custom property is used
because a browser strips unknown *real* properties from inline `cssText` before
render-tag can read them — custom properties survive.

## Recommended CSS reset

For tighter DOM/canvas parity, drop these into your input HTML:

```css
/* Chrome shrinks <code>/<pre> font-size via a UA quirk; canvas can't replicate it. */
code, pre, kbd, samp { font-size: inherit; }

/* Firefox's ::marker adds ~1.5px per <li>; render-tag draws markers itself. */
li::marker { content: none; font-size: 0; line-height: 0; }

/* Firefox's canvas kerning drifts on emoji; disable it on emoji-bearing text. */
.has-emoji { font-kerning: none; }
```

## How it works

1. Parse HTML with `DOMParser`.
2. Resolve styles with a built-in CSS parser (selectors, specificity, cascade, inheritance — no DOM insertion).
3. Lay out with canvas `measureText` (block flow, inline wrapping, margin collapsing).
4. Render with the canvas 2D API (`fillText`, `fillRect`, `strokeText`, …).

### Design decisions

- **Chrome-first.** When a rendering choice must favor one browser over another, Chrome wins.
- **Cross-browser consistency over per-browser DOM fidelity.** Same canvas output in every browser, not pixel-matching each browser's quirks. Use `accuracy: 'balanced'` if you'd rather match each browser's own DOM rendering.

## License

MIT
