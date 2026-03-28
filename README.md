# render-tag

Render HTML rich text onto a canvas element using pure 2D canvas API. No SVG, no `foreignObject` — just `fillText`, `measureText`, and drawing primitives.

## Why

Browsers can render HTML into canvas via SVG `foreignObject`, but it's slow (~100ms) and inconsistent across browsers. `render-tag` parses your HTML, resolves styles via `getComputedStyle`, then lays out and draws everything with canvas 2D calls. It's **10-60x faster** than SVG-based approaches.

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

### With web fonts

```typescript
const { canvas } = renderHTML(
  '<p>Custom font text</p>',
  {
    width: 500,
    css: `
      @font-face {
        font-family: 'MyFont';
        src: url('https://example.com/font.woff2') format('woff2');
      }
      p { font-family: 'MyFont', sans-serif; font-size: 18px; }
    `,
  }
);
```

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
| `css` | `string` | `''` | CSS stylesheet (supports `@font-face`, classes, selectors) |
| `canvas` | `HTMLCanvasElement` | created | Target canvas element |
| `pixelRatio` | `number` | `1` | Device pixel ratio for sharp rendering |
| `useDomMeasurements` | `boolean` | `true` | Use DOM probes for cross-browser line height accuracy. Disable for DOM-free rendering (pure canvas). |

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
- `@font-face` web fonts (loaded automatically)
- Flexbox layout (row/column)
- Table layout (basic)
- Text shadows, text stroke, gradient text
- Decoration styles: solid, dotted, dashed, double, wavy
- RTL text, CJK characters, emoji
- `pre-wrap` whitespace handling
- `overflow-wrap: break-word`

## Cross-browser consistency

The library targets Chrome as the primary browser. For consistent rendering across Chrome and Firefox, add these CSS rules to your input:

```css
/* Suppress Firefox's ::marker extra line height (~1.5px per list item).
   render-tag draws list markers itself, so this loses nothing visually. */
li::marker { content: none; font-size: 0; line-height: 0; }
```

With `useDomMeasurements: true` (the default), the library uses hidden DOM probes to match Firefox's actual line box heights. If you disable DOM measurements (`useDomMeasurements: false`), the CSS above becomes especially important for Firefox consistency.

## How it works

1. **Parse** HTML with `DOMParser`
2. **Resolve styles** via hidden DOM + `getComputedStyle` (CSS cascade for free)
3. **Layout** with pure canvas `measureText` (block flow, inline wrapping, margin collapsing)
4. **Render** with canvas 2D API (`fillText`, `fillRect`, `strokeText`, etc.)

Layout is computed from CSS values and canvas text metrics. Optional DOM probes (`useDomMeasurements`) improve cross-browser accuracy for line heights and mixed-font wrapping.

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
