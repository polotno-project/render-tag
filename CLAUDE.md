# render-tag

HTML rich text renderer onto canvas using pure 2D API.

See `README.md` for public API docs, usage examples, and **design decisions** (Chrome-first, cross-browser consistency priorities).

## Architecture

```
HTML string + CSS → parseHTML (DOMParser) → resolveStylesFromCSS (pure CSS parser + cascade)
→ buildLayoutTree (canvas measureText) → renderNode (canvas fillText/fillRect)
```

- **`accuracy` option** (default: `'performance'`) — `'balanced'` enables hidden DOM probes for line heights. `'performance'` uses pure canvas API only.
- **`render()` is synchronous** — no async, no font loading. Caller must load fonts first.

## Testing workflow

### Running tests
```bash
npm test                                      # baseline pixel/wrap tests (vitest + Chromium)
npx vitest run tests/layout-logic.test.ts     # layout unit tests (mocked measureText, fast)
npx vitest run tests/render.test.ts           # render quality tests
npx vitest run tests/stress.test.ts           # layout width sweep
```

### Baseline regression system
- Per-browser baseline files: `tests/baselines.chrome.json`, `tests/baselines.firefox.json`, `tests/baselines.webkit.json`
- Each stores `{ score, wrap }` per test case (default font + 5 font variants)
- `score`: content mismatch %. Tests fail if any case regresses by >2% above its baseline
- `wrap`: whether text wrapping matches DOM. Tests fail if a passing case starts failing
- Baselines cover default font cases, Polotno cases, and all cases × 5 fonts (Open Sans, Roboto, Playfair Display, Merriweather, Lobster)
- Each browser has its own baselines — no cross-browser tolerance hack
- Reference renderer: `vendor/html-to-svg/` (ground truth for tests, font preloading in `tests/helpers/compare.ts`)

### Updating baselines
- **Tests never update baselines** — baselines are only updated via explicit commands as a deliberate milestone
- **Regressions fail the test** — any score increase >0.01% or wrapping regression causes failure
- **Update commands** (run after verifying improvements):
  - `npm run test:update-baselines` — Chrome baselines
  - `npm run test:update-baselines:firefox` — Firefox baselines
  - `npm run test:update-baselines:webkit` — WebKit/Safari baselines

### Unit tests for layout logic (`tests/layout-logic.test.ts`)
Unit tests cover deterministic layout algorithms directly — no browser, no fonts, no pixels. They mock `ctx.measureText` to return predictable widths (e.g., 10px per character), then assert the output of layout functions.

**Good candidates:** hyphen breaking, margin collapsing, line breaking, whitespace handling (`pre-wrap`, `nowrap`, tabs, newlines), CJK breaking, text transform, inline-block atomic wrapping, flex/table column distribution.

**When to add:** new browser behavior logic, bug fixes (regression test), complex edge cases not covered by baselines.

**TDD workflow — always write the failing test first:**
1. Write the unit test that describes the expected behavior
2. Run it — confirm it **fails** (red)
3. Implement the fix/feature
4. Run it — confirm it **passes** (green)
5. Then run baseline tests (`npm test`) to check for regressions

## Code conventions

### Making changes
1. Run tests before AND after changes
2. Check baselines output for regressions (shows "+X.X REGRESSION!")
3. If a test improves, update baselines
4. The stress test (`tests/stress.test.ts`) catches layout shifts across widths — run it for wrapping changes

### Margin collapsing rules
- Sibling margins: `max(prevMarginBottom, nextMarginTop)` (positive case)
- First child margin-top collapses through parent: **only for `li`/`ul`/`ol`/`dd`/`dt`** (not general divs — html-to-svg reference prevents this)
- Last child margin-bottom: included in parent height when parent has padding/border (can't collapse through)
- Last child margin-bottom: passed as `marginBottomOut` when it CAN collapse through

### Text measurement
- Use cumulative `measureText` within a font run to avoid rounding accumulation
- `ctx.fontKerning = 'normal'` — always set for consistency
- `ctx.letterSpacing` — use native property, not manual per-character rendering
- Cross-font boundaries still accumulate errors — inherent canvas API limitation

### Firefox cross-browser differences
Firefox renders `<ul><li>` elements ~1.5px taller than Chrome due to the
`::marker` pseudo-element (disc/circle/square markers). This accumulates
in long lists (1.5px × N items). `<ol><li>` items are NOT affected.

**Library fix:** When `accuracy: 'balanced'`, the layout engine uses a
hidden `<ul><li>` DOM probe to measure actual line heights for bullet-type
list items, matching Firefox's rendering.

**CSS fix (recommended for users):** Adding this CSS to input HTML eliminates
the difference at the source:
```css
li::marker { content: none; font-size: 0; line-height: 0; }
```
This is safe because render-tag draws list markers itself via canvas.

## Commands
- `npm run dev` — demo page with side-by-side comparison
- `npm test` — vitest in Chromium
- `npm run test:firefox` — vitest in Firefox (own baselines)
- `npm run test:webkit` — vitest in WebKit/Safari (own baselines)
- `npm run test:cross-browser:record` — record Chrome canvas layout as reference
- `npm run test:cross-browser:firefox` — compare Firefox canvas layout vs Chrome reference
- `npm run test:cross-browser:webkit` — compare WebKit canvas layout vs Chrome reference
- `npm run test:stress` — layout width sweep stress test
- `npm run build` — TypeScript compilation
