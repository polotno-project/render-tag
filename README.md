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
import { renderHTML } from 'render-tag';

const { canvas, height } = renderHTML(
  '<p>Hello <strong>world</strong></p>',
  { width: 400 }
);

document.body.appendChild(canvas);
```

### With CSS

```typescript
const { canvas } = renderHTML(
  '<p class="title">Styled text</p>',
  {
    width: 600,
    css: `
      .title {
        font-family: Georgia, serif;
        font-size: 24px;
        color: #1a1a1a;
      }
    `,
  }
);
```

### Font loading

`renderHTML` is **synchronous** and does not load fonts. You must ensure fonts are loaded before calling it. If a font isn't loaded, the browser falls back to a default font and text metrics will be wrong.

```typescript
// Load fonts before rendering
await document.fonts.load('400 16px "Roboto"');
await document.fonts.load('700 16px "Roboto"');

// Now render — fonts are guaranteed to be available
const { canvas } = renderHTML(html, { width: 500 });

// Re-render if fonts load later
document.fonts.onloadingdone = () => {
  renderHTML(html, { width: 500 });
};
```

You do **not** need to pass `@font-face` rules in the `css` option. As long as fonts are loaded in the document (via `<link>`, `@font-face` in a stylesheet, or the CSS Font Loading API), `renderHTML` can use them.

### High-DPI / Retina

```typescript
const { canvas } = renderHTML(html, {
  width: 600,
  pixelRatio: window.devicePixelRatio,
});
```

### Render onto existing canvas

```typescript
const canvas = document.getElementById('my-canvas');
renderHTML(html, { canvas, width: 800, height: 600 });
```

## API

### `renderHTML(html, options): RenderResult`

| Option | Type | Default | Description |
|---|---|---|---|
| `width` | `number` | *required* | Layout width in CSS pixels |
| `height` | `number` | auto | Fixed height (auto-sized from content if omitted) |
| `css` | `string` | `''` | CSS stylesheet (classes, selectors, etc.) |
| `canvas` | `HTMLCanvasElement` | created | Target canvas element |
| `pixelRatio` | `number` | `1` | Device pixel ratio for sharp rendering |
| `useDomMeasurements` | `boolean` | `true` | Use DOM probes for cross-browser line height accuracy. Disable for pure canvas rendering. |

Returns `{ canvas: HTMLCanvasElement, height: number }`.

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

With `useDomMeasurements: true` (the default), the library uses hidden DOM probes to match Firefox's actual line box heights. If you disable DOM measurements (`useDomMeasurements: false`), the CSS above becomes especially important for Firefox consistency.

## How it works

1. **Parse** HTML with `DOMParser`
2. **Resolve styles** via hidden DOM + `getComputedStyle` (CSS cascade for free)
3. **Layout** with canvas `measureText` (block flow, inline wrapping, margin collapsing)
4. **Render** with canvas 2D API (`fillText`, `fillRect`, `strokeText`, etc.)

Style resolution uses a hidden DOM element with `getComputedStyle` to get the full CSS cascade. Layout and rendering are done entirely with the canvas 2D API. Optional DOM probes (`useDomMeasurements`) improve cross-browser accuracy for line heights and mixed-font wrapping.

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
