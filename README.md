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
    <style>.title { font-size: 24px; font-family: Georgia, serif; color: #1a1a1a; }</style>
    <p class="title">Hello <strong>world</strong></p>
  `,
  width: 400,
});

document.body.appendChild(canvas);
```

`render` is **synchronous** — load fonts before calling (e.g. `await document.fonts.load('400 16px "Roboto"')`). If a font isn't loaded yet, the browser falls back to a default and text metrics will be wrong. Re-render once fonts arrive.

## API

```ts
function render(config: RenderConfig): { canvas, height, layoutRoot, lines, paintBounds };
function layout(config: LayoutConfig): { layoutRoot, height, lines, paintBounds };
function drawLayout(config: DrawConfig): { canvas };
```

| Option | Default | Notes |
|---|---|---|
| `html` | *required* | HTML string (include `<style>` tags for CSS). |
| `width` | *required* | Layout width in CSS pixels. |
| `height` | auto | Fixed height; auto-sized from content if omitted. |
| `canvas` | created | Existing target canvas (mutually exclusive with `ctx`). |
| `ctx` | — | Existing 2D context — no canvas resizing or scaling. |
| `createCanvas` | browser canvas | Factory `(width, height) => canvas` for shadow composition. Required for shadows outside browsers. |
| `renderShadows` | `true` | Set `false` to omit CSS and context shadows without allocating shadow buffers. Foreground stays drawing commands in both modes. |
| `pixelRatio` | `devicePixelRatio` | HiDPI scaling. |
| `accuracy` | `'performance'` | `'balanced'` uses DOM probes for per-browser line-height accuracy; `'performance'` is pure canvas and consistent cross-browser. |

Use `layout()` + `drawLayout()` when you need to measure content, render the same layout onto multiple targets, or render onto an `OffscreenCanvas`.

### Painted bounds

Both `layout()` and `layoutTextOnPath()` return `paintBounds`: a conservative
`{ x, y, width, height }` in layout coordinates. It includes overflowing glyphs,
strokes, decorations, box paints and CSS text shadows. Use it to size offscreen
buffers; `x` and `y` can be negative. Existing layout dimensions and curved-text
`bounds` keep their selection/layout meaning.

```ts
const result = layout({ html, width: 400 });
const { x, y, width, height } = result.paintBounds;
```

Bounds are measured on first access and reused, so layout-only callers pay no
extra measurement cost. Load fonts first and create a new layout when content,
styles or fonts change; treat the returned layout as a snapshot.

Measurement uses the layout's context (required in Node) and preserves its current
state. Bounds exclude destination transforms, clipping and canvas effects. CSS
shadows are always included, even if drawing later uses `renderShadows: false`.
The combined `render()` and `drawTextOnPath()` APIs expose the same property.

### Line geometry and breaks

Read `layoutRoot` for rendering. Boxes with inline content expose `lineBoxes`:

```ts
interface LayoutLineBox {
  x: number;
  y: number;       // top, not baseline
  width: number;
  height: number;
  endedByHardBreak: boolean;
}
```

These rectangles use canvas coordinates and the line heights used during layout.
Each box owns its lines; table cells and inline-blocks keep separate arrays.
An absent or empty array means the box has no lines of its own.
The metadata reflects the current layout, including its existing limitations:
RTL inline-block content is flattened, and inline-blocks containing only `<br>`
elements are dropped. Neither case has separate inner line boxes.

`endedByHardBreak` is true for `<br>` and preserved newlines. It is false for
soft wraps, the end of content, and lines cut by an ellipsis. Soft-hyphen
substitution does not affect this flag. Justification is already reflected in
the positioned text runs; renderers should use those positions.

Blank lines from `<br>` or preserved newlines have zero width and retain their
height. An empty `<p></p>` creates no line box, matching native HTML. Paragraph
margins are spacing between boxes, not blank lines. Backgrounds that extend a
blank line to a neighbour's width are a consumer policy.

### `LayoutLine` summary

Each entry in `result.lines`:

```ts
interface LayoutLine {
  y: number;        // rounded baseline y
  text: string;
  bounds: { x, y, width, height };  // union of line boxes
}
```

`result.lines` is a lossy summary for wrap inspection. It omits blank lines and
merges text and bounds from separate flows on the same visual row, including
table cells and list markers. Use `layoutRoot` for backgrounds, hit-testing,
and rendering.

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
  html: '<span style="font-size:24px;font-family:sans-serif">Hello <b>world</b></span>',
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
drawLayout({ layout: result, width: 400, ctx: outputCtx, createCanvas });
```

Without injection, functions throw with guidance. `accuracy: 'balanced'` needs a real browser DOM and throws on Node — use the default `'performance'`. `render-tag/path` works the same way (`layoutTextOnPath` already takes `ctx`; it re-exports `setDOMParser`).

## Shadows

`text-shadow` paints behind the combined text fill, stroke and decorations.
Multiple shadows paint in CSS order (the first listed is on top). Shadows do
not repaint the foreground or include box backgrounds. Offsets and blur are
in layout pixels and transform with the text; on a path they use the whole
path's coordinates, not each glyph's rotated coordinates.

An existing `ctx.shadow*` casts one shadow from the completed rendering,
including backgrounds and CSS shadows. Its offsets and blur retain Canvas 2D's
device pixel semantics. Combining both intentionally produces both effects.
Both shadow paths rasterize only the effect. The foreground still uses text,
stroke and decoration commands, retaining the caller's per-paint opacity and
blending behavior.

Shadow composition uses temporary canvases sized for the painted content,
including overhanging glyphs and decorations. Node consumers must pass
`createCanvas` to `render`, `drawLayout`, `drawTextOnPath`, or
`drawTextOnPathLayout` when using shadows. It must return a fresh canvas
compatible with the destination context. Drawing without shadows needs no
scratch canvas. Fonts and blur rasterization can still differ slightly between
browser engines; these APIs do not promise byte-identical pixels across engines.

### PDF and other vector adapters

Some consumers pass a Canvas-like proxy that translates drawing commands into
PDF operations, preserving vector text. The same drawing API works with a
compatible proxy: render-tag emits shadow images through `drawImage`, then
foreground text, stroke and decoration commands in the correct paint order.

```ts
// Requires a compatible Canvas 2D proxy and a raster canvas factory.
drawLayout({ layout: result, width: 400, ctx: pdfContext, createCanvas });
```

With shadows enabled, the proxy must support Canvas 2D image and transform
operations, including `drawImage`, `getTransform` and `setTransform`. The adapter
owns PDF image embedding and must preserve drawing order if embedding is
asynchronous; render-tag's drawing APIs remain synchronous. The factory supplies
real raster canvases for shadow composition. The foreground remains drawing
commands on the destination proxy.

For adapters that paint effects separately, use `renderShadows: false`:

```ts
drawLayout({ layout: result, width: 400, ctx: pdfContext, renderShadows: false });
```

This omits both CSS `text-shadow` and caller-supplied `ctx.shadow*`, allocates no
shadow canvases, and keeps foreground commands and layout unchanged. It requires
no image or transform-query APIs. The adapter must provide the omitted effects;
this option alone does not preserve the appearance of shadowed text.

Unsupported proxies fail with guidance when shadows are enabled. Exporters
remain responsible for matching fonts, opacity, blending and effect placement
across formats. No separate shadow-layer or preparation API is required.

## What it renders

Paragraphs, headings, divs, spans · bold, italic, underline, strikethrough, overline · colors, background colors, text-shadow, text-stroke (solid **and gradient**), gradient text · font families, sizes, weights (100–900) · line-height, letter-spacing, text-align (left/center/right/justify) · ordered/unordered lists with nesting · flexbox (row/column, with `flex-grow`/`flex-shrink`/`flex-basis` sized against min- and max-content like the browser), basic tables · `-webkit-line-clamp` · `pre-wrap`, `overflow-wrap: break-word`, soft hyphens · RTL, CJK, emoji.

Text decorations follow HTML painting rules. A visible text stroke supplies the
automatic decoration color without widening the band. An explicit decoration
color other than `currentColor` overrides it. `paint-order` controls glyph
fill/stroke order; it does not add a filled outline to the decoration as native
SVG text can.

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

The gradient paints glyph outlines. Automatic decorations use the solid text
stroke color, following the HTML rules above.

## Recommended CSS reset

For tighter DOM/canvas parity, drop these into your input HTML:

```css
/* Chrome gives <code>/<pre> a smaller monospace default; canvas cannot replicate it. */
code, pre, kbd, samp { font-family: inherit; font-size: inherit; }

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
- **Cross-browser consistency over per-browser DOM fidelity.** Same canvas output in every browser, not pixel-matching each browser's quirks. `accuracy: 'balanced'` probes browser line heights where that improves geometry, but it cannot reconcile browser-specific line-break policies or Canvas/DOM metric differences.
- **The line-box baseline follows the engine's own rounding.** Blink floors half-leading + ascent onto a whole CSS pixel (`FontHeight::AddLeading`); Gecko and WebKit keep the exact value. render-tag does what the engine it runs in does, so canvas text lands on the baseline that browser's own DOM would use — which is what keeps a canvas render and a contenteditable overlay of the same text on one line. Safari is the closest fit rather than a match: its canvas metrics disagree with its own layout metrics, so no canvas-side rule reaches its DOM exactly. This is the one place per-browser fidelity wins over identical output.

## License

MIT
