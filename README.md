# render-tag

Render HTML rich text onto canvas with the 2D API. No SVG, no `foreignObject` — just `fillText`, `measureText`, and drawing primitives.

**Website & demos:** [https://polotno.com/render-tag/](https://polotno.com/render-tag/)

## Why

Browsers can render HTML into canvas via SVG `foreignObject`, but it's slow (~100ms) and inconsistent across browsers. `render-tag` parses your HTML, resolves styles via `getComputedStyle`, then lays out and draws everything with canvas 2D calls. It's **10-60x faster** than SVG-based approaches.

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

- `canvas` — the canvas rendered onto
- `height` — content height in CSS pixels
- `layoutRoot` — full layout tree for inspection
- `lines` — text lines grouped by Y coordinate

The function is **synchronous**. Fonts must be loaded before calling.

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

## Cross-browser consistency

The library targets Chrome as the primary browser. For consistent rendering across Chrome and Firefox, add these CSS rules to your input:

```css
/* Suppress Firefox's ::marker extra line height (~1.5px per list item).
   render-tag draws list markers itself, so this loses nothing visually. */
li::marker { content: none; font-size: 0; line-height: 0; }

/* Fix Firefox emoji position drift (apply to elements with emoji).
   Firefox's canvas kerning differs from DOM kerning for emoji characters,
   causing cumulative X position shift. Disabling kerning makes them match.
   Note: this slightly affects letter pair spacing for regular text. */
.has-emoji { font-kerning: none; }
```

With `accuracy: 'balanced'` (the default), the library uses hidden DOM probes to match Firefox's actual line box heights. With `accuracy: 'performance'`, the CSS above becomes especially important for Firefox consistency.

## How it works

1. **Parse** HTML with `DOMParser`
2. **Resolve styles** via hidden DOM + `getComputedStyle` (CSS cascade for free)
3. **Layout** with canvas `measureText` (block flow, inline wrapping, margin collapsing)
4. **Render** with canvas 2D API (`fillText`, `fillRect`, `strokeText`, etc.)

Style resolution uses a hidden DOM element with `getComputedStyle` to get the full CSS cascade. Layout and rendering are done entirely with the canvas 2D API. Optional DOM probes (`accuracy: 'balanced'`) improve cross-browser accuracy for line heights and mixed-font wrapping.

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
