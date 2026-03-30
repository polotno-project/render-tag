# render-tag

Render HTML rich text onto canvas with the 2D API. No SVG, no `foreignObject` — just `fillText`, `measureText`, and drawing primitives.

**Website & demos:** [https://polotno.com/render-tag/](https://polotno.com/render-tag/)

## Why

When you need rich text as part of a canvas — design editors, image export, canvas-based apps — the standard SVG `foreignObject` approach is slow (~100ms per render). `render-tag` parses your HTML, resolves styles via `getComputedStyle`, then lays out and draws everything with pure canvas 2D calls. It's **10-60x faster** than SVG-based approaches.

By design, render-tag focuses on **rich text only** — paragraphs, headings, lists, tables, inline formatting. It is not designed for interactive elements (buttons, inputs, iframes) or complex HTML layouts. This focus is what makes it fast.

## Install

```bash
npm install render-tag
```

## Usage

```typescript
import { render } from 'render-tag';

const { canvas, height } = render({
  html: '<p>Hello <strong>world</strong></p>',
  width: 400,
});

document.body.appendChild(canvas);
```

### With CSS

Include `<style>` tags in your HTML string:

```typescript
const { canvas } = render({
  html: `
    <style>
      .title {
        font-family: Georgia, serif;
        font-size: 24px;
        color: #1a1a1a;
      }
    </style>
    <p class="title">Styled text</p>
  `,
  width: 600,
});
```

### Font loading

`render` is **synchronous** and does not load fonts. You must ensure fonts are loaded before calling it. If a font isn't loaded, the browser falls back to a default font and text metrics will be wrong.

```typescript
// Load fonts before rendering
await document.fonts.load('400 16px "Roboto"');
await document.fonts.load('700 16px "Roboto"');

// Now render — fonts are guaranteed to be available
const { canvas } = render({ html, width: 500 });

// Re-render if fonts load later
document.fonts.onloadingdone = () => {
  render({ html, width: 500 });
};
```

You do **not** need to pass `@font-face` rules separately. As long as fonts are loaded in the document (via `<link>`, `@font-face` in a stylesheet, or the CSS Font Loading API), `render` can use them.

### High-DPI / Retina

`pixelRatio` defaults to `devicePixelRatio`, so HiDPI displays are sharp out of the box. Override if needed:

```typescript
const { canvas } = render({ html, width: 600, pixelRatio: 1 });
```

### Render onto existing canvas

```typescript
const canvas = document.getElementById('my-canvas');
render({ html, canvas, width: 800, height: 600 });
```

### Render onto existing context

Draw directly onto a context you control (no canvas resizing or scaling):

```typescript
const ctx = myCanvas.getContext('2d');
render({ html, ctx, width: 400 });
```

This is useful for compositing multiple renders onto one canvas or rendering onto an `OffscreenCanvas`.

## API

### `render(config): RenderResult`

All-in-one: compute layout and draw in a single call.

| Option | Type | Default | Description |
|---|---|---|---|
| `html` | `string` | *required* | HTML string to render (include `<style>` tags for CSS) |
| `width` | `number` | *required* | Layout width in CSS pixels |
| `height` | `number` | auto | Fixed height (auto-sized from content if omitted) |
| `ctx` | `CanvasRenderingContext2D` | — | Existing context to draw onto (no resizing/scaling) |
| `canvas` | `HTMLCanvasElement \| OffscreenCanvas` | created | Target canvas element (mutually exclusive with `ctx`) |
| `pixelRatio` | `number` | `devicePixelRatio` | Device pixel ratio for sharp rendering |
| `accuracy` | `'balanced' \| 'performance'` | `'balanced'` | `'balanced'` uses DOM probes for cross-browser line height accuracy. `'performance'` uses pure canvas API only. |

Returns `{ canvas, height, layoutRoot, lines }`.

The function is **synchronous**. Fonts must be loaded before calling.

### `layout(config): LayoutResult`

Compute layout without rendering. Use when you need to measure content or render the same layout onto multiple targets.

| Option | Type | Default | Description |
|---|---|---|---|
| `html` | `string` | *required* | HTML string (include `<style>` tags for CSS) |
| `width` | `number` | *required* | Layout width in CSS pixels |
| `height` | `number` | auto | Fixed height (auto-sized from content if omitted) |
| `accuracy` | `'balanced' \| 'performance'` | `'balanced'` | Measurement accuracy mode |

Returns `{ layoutRoot, height, lines }`.

### `drawLayout(config): { canvas }`

Draw a pre-computed layout onto a canvas or context.

| Option | Type | Default | Description |
|---|---|---|---|
| `layout` | `LayoutResult` | *required* | Result from `layout()` |
| `width` | `number` | *required* | Width used during layout (must match) |
| `ctx` | `CanvasRenderingContext2D` | — | Existing context to draw onto (no resizing/scaling) |
| `canvas` | `HTMLCanvasElement \| OffscreenCanvas` | created | Target canvas (mutually exclusive with `ctx`) |
| `pixelRatio` | `number` | `devicePixelRatio` | Device pixel ratio |

### Example: layout once, draw many

```typescript
import { layout, drawLayout } from 'render-tag';

const result = layout({ html, width: 400 });
console.log('content height:', result.height);

// Draw onto a thumbnail canvas
drawLayout({ layout: result, width: 400, canvas: thumbnailCanvas });

// Draw onto the main canvas
drawLayout({ layout: result, width: 400, canvas: mainCanvas });

// Draw onto an existing context
drawLayout({ layout: result, width: 400, ctx: offscreenCtx });
```

## What it renders

- Paragraphs, headings, divs, spans
- Bold, italic, underline, strikethrough, overline
- Text colors, background colors
- Font families, sizes, weights (100-900)
- Line height, letter spacing, text alignment (left/center/right/justify)
- Ordered and unordered lists with nesting
- Inline styles and CSS classes
- Flexbox layout (row/column)
- Table layout (basic)
- Text shadows, text stroke, gradient text
- Decoration styles: solid, dotted, dashed, double, wavy
- RTL text, CJK characters, emoji
- `pre-wrap` whitespace handling
- `overflow-wrap: break-word`
- Soft hyphens (`&shy;`)

## Recommended CSS reset

For best consistency between DOM and canvas rendering, add these CSS rules to your input HTML:

```css
/* Normalize monospace font size.
   Chrome reduces <code>/<pre> font-size via a UA quirk that canvas can't replicate.
   This makes DOM and canvas render code at the same size. */
code, pre, kbd, samp { font-size: inherit; }

/* Suppress Firefox's ::marker extra line height (~1.5px per list item).
   render-tag draws list markers itself, so this loses nothing visually. */
li::marker { content: none; font-size: 0; line-height: 0; }

/* Fix Firefox emoji position drift (apply to elements with emoji).
   Firefox's canvas kerning differs from DOM kerning for emoji characters,
   causing cumulative X position shift. Disabling kerning makes them match.
   Note: this slightly affects letter pair spacing for regular text. */
.has-emoji { font-kerning: none; }
```

The default `accuracy: 'performance'` uses pure canvas API measurements with no DOM touches, producing consistent canvas output across browsers. Use `accuracy: 'balanced'` if you need each browser's canvas output to match its own native DOM rendering more closely (at the cost of cross-browser canvas consistency).

## Design decisions

### Chrome-first rendering

Chrome is the primary target browser. When a rendering choice must favor one browser over another, Chrome wins. All development and CI testing defaults to Chromium.

### Cross-browser consistency over per-browser accuracy

The library prioritizes producing **the same canvas output in every browser** over matching each browser's native DOM rendering pixel-for-pixel. If Chrome and Firefox render a `<p>` slightly differently in DOM, our canvas output should match Chrome's version in both browsers — not adapt to each browser's quirks.

In other words: identical canvas output everywhere > perfect DOM fidelity per browser. Users expect the same visual result regardless of which browser their audience uses.

## How it works

1. **Parse** HTML with `DOMParser`
2. **Resolve styles** via built-in CSS resolver (selector matching, cascade, inheritance — no DOM insertion)
3. **Layout** with canvas `measureText` (block flow, inline wrapping, margin collapsing)
4. **Render** with canvas 2D API (`fillText`, `fillRect`, `strokeText`, etc.)

Style resolution uses a built-in CSS parser and resolver that handles selectors, specificity, cascade, and inheritance without inserting HTML into the document. Layout and rendering are done entirely with the canvas 2D API.

## Development

```bash
npm install
npx playwright install chromium

# Run visual comparison demo
npm run dev

# Run tests (60 cases, Chromium via Playwright)
npm test
```

## License

MIT
