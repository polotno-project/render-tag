# render-tag

HTML rich text renderer onto canvas using pure 2D API.

See `README.md` for public API docs, usage examples, and **design decisions** (Chrome-first, cross-browser consistency priorities).

## Architecture

```
HTML string + CSS → parseHTML (DOMParser) → resolveStyles (hidden DOM + getComputedStyle)
→ buildLayoutTree (canvas measureText) → renderNode (canvas fillText/fillRect)
```

- **DOM used for** `getComputedStyle` (CSS cascade/inheritance), `getComputedStyle(el, '::before')` (list markers), and optional DOM probes for cross-browser line height accuracy
- **`accuracy` option** (default: `'balanced'`) — enables DOM probes for line heights and mixed-font width verification. `'performance'` uses pure canvas API only.
- **`render()` is synchronous** — no async, no font loading. Caller must load fonts first.

### Key files
- `src/index.ts` — public API: `render()`, `layout()`, `drawLayout()`
- `src/style-resolver.ts` — hidden DOM insertion + getComputedStyle walk
- `src/layout.ts` — block flow, inline wrapping, flex, table, lists, RTL
- `src/render.ts` — canvas 2D drawing: text, backgrounds, borders, decorations
- `src/types.ts` — ResolvedStyle, StyledNode, LayoutBox, LayoutText

## Testing workflow

### Running tests
```bash
npm test                                      # baseline pixel/wrap tests (vitest + Chromium)
npx vitest run tests/layout-logic.test.ts     # layout unit tests (mocked measureText, fast)
npx vitest run tests/render.test.ts           # render quality tests
npx vitest run tests/stress.test.ts           # layout width sweep
```

### Baseline regression system
- Per-browser baseline files: `baselines.chrome.json`, `baselines.firefox.json`, `baselines.webkit.json`
- Each stores `{ score, wrap }` per test case (default font + 5 font variants)
- `score`: content mismatch %. Tests fail if any case regresses by >2% above its baseline
- `wrap`: whether text wrapping matches DOM. Tests fail if a passing case starts failing
- Baselines cover default font cases, Polotno cases, and all cases × 5 fonts (Open Sans, Roboto, Playfair Display, Merriweather, Lobster)
- Each browser has its own baselines — no cross-browser tolerance hack

### Updating baselines
- **Tests never update baselines** — baselines are only updated via explicit commands as a deliberate milestone
- **Regressions fail the test** — any score increase >0.01% or wrapping regression causes failure
- **Update commands** (run after verifying improvements):
  - `npm run test:update-baselines` — Chrome baselines
  - `npm run test:update-baselines:firefox` — Firefox baselines
  - `npm run test:update-baselines:webkit` — WebKit/Safari baselines

### Content-based mismatch
- Mismatch is measured against **content pixels only** (non-white/non-transparent), not total canvas area
- This prevents empty space from diluting the measurement
- A 600x400 canvas with one line of text might be 5% filled — mismatch is relative to that 5%

### Unit tests for layout logic (`tests/layout-logic.test.ts`)
Baseline tests compare pixels and wrapping against a real browser, which is
comprehensive but noisy (font metrics differ across environments) and slow.

**Unit tests** cover deterministic layout algorithms directly — no browser, no
fonts, no pixels. They mock `ctx.measureText` to return predictable widths
(e.g., 10px per character), then assert the output of layout functions.

**Good candidates for unit tests** (algorithm is deterministic given known widths):
- Hyphen breaking — "top-to-bottom" splits at `-` when it overflows
- Margin collapsing — sibling, first-child, last-child, collapse-through
- Line breaking — given words with known widths, which words land on which line
- Whitespace handling — `pre-wrap`, `nowrap`, tab stops, newlines
- CJK character-level breaking
- Text transform — uppercase, lowercase, capitalize
- Inline-block atomic wrapping — whole element wraps as one unit
- Flex/table column width distribution

**When to add a unit test:**
- You discovered new browser behavior and added logic for it (e.g., hyphen breaks)
- You fixed a layout bug — add a test that would have caught it
- The logic is complex enough that baseline tests might not cover edge cases

**When NOT to add a unit test:**
- Pure rendering (colors, gradients, shadows) — no layout logic to test
- Font metric accuracy — inherently browser-dependent
- Cross-browser differences — those belong in baseline tests

The mock approach: create a fake `CanvasRenderingContext2D` with `measureText`
returning `width = text.length * CHAR_WIDTH`, then call `buildLayoutTree` or
sub-functions directly and assert positions/line breaks.

## Debugging render issues

### Debug workflow overview
Issues are reported from the **real browser benchmark** (`npm run dev` / docs page).
The goal is to reproduce, isolate, fix, and verify — in that order.

### Step 1: Reproduce in an isolated test
Create `tests/debug-wrap.test.ts` (or similar) that runs **exactly** the same
case as the benchmark: same HTML, CSS, fonts, width, height. The test must:
- Load fonts identically to the main test (use `loadMultiFontCss()`, `loadBasicCases()`)
- Use the same `compareWrapping` / `compareRenders` helpers
- Print canvas lines vs DOM lines side-by-side for comparison
- Confirm you see the same failure (wrong wrap, high score, etc.)

If the vitest browser (Playwright Chromium) can't reproduce the issue (slightly
different font metrics from real Chrome), add `console.log` diagnostics to the
**benchmark page** (`docs/`) instead, and ask the user to run it in their real
browser and provide the logs back.

### Step 2: Laser-focus on the divergence
Once reproduced, narrow down:
- Compare canvas lines vs DOM lines — which line diverges first?
- Measure word-by-word widths: `ctx.measureText(word).width` vs DOM Range rects
- For wrapping bugs: find the exact word where canvas wraps but DOM doesn't (or vice versa)
- For score bugs: compare Y positions of each element between canvas layout tree and DOM `getBoundingClientRect()`

```typescript
// Canvas positions — walk the layout tree
const { root } = buildLayoutTree(ctx, tree, width);

// DOM positions (ground truth)
const elements = container.querySelectorAll('p, div, span');
for (const el of elements) {
  const rect = el.getBoundingClientRect();
  console.log(el.tagName, rect.top - containerTop, rect.height);
}
```

A consistent Y offset is fine (baseline vs top-of-text). A **changing delta**
reveals the exact element where layout diverges.

### Step 3: Common root causes
- **Y position drift** → margin collapsing bug (check `collapseMargins`, first/last child collapse)
- **Last child margin-bottom not in parent height** → `prevMarginBottom` not added to `curY` when `canCollapseThrough` is false
- **Words wrapping differently** → `measureText` precision (inherent limitation with mixed fonts)
- **Missing spaces between spans** → whitespace text nodes being stripped in `walkNode`
- **Inline-block not on same line** → consecutive inline children not grouped together
- **Empty elements have wrong height** → check `min-height` support, empty element line-height

### Step 4: After fixing
1. Run `npm test` — all baselines must pass
2. If scores/wrapping improved, update baselines: `npm run test:update-baselines`
3. Delete the debug test file (baselines are the real tests)
4. A sample debug file can be kept as a template if useful

## Code conventions

### Making changes
1. Run tests before AND after changes
2. Check baselines output for regressions (shows "+X.X REGRESSION!")
3. If a test improves, update `baselines.json`
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

### Reference renderer
- `html-to-svg` library in `html-to-svg/` directory (not part of this package)
- Used only in tests as the "ground truth" reference
- Font preloading happens in `tests/helpers/compare.ts` before both renders

### Firefox cross-browser differences
Firefox renders `<ul><li>` elements ~1.5px taller than Chrome due to the
`::marker` pseudo-element (disc/circle/square markers). This accumulates
in long lists (1.5px × N items). `<ol><li>` items are NOT affected.

**Library fix:** When `accuracy: 'balanced'` (the default), the layout engine uses a
hidden `<ul><li>` DOM probe to measure actual line heights for bullet-type
list items, matching Firefox's rendering.

**CSS fix (recommended for users):** Adding this CSS to input HTML eliminates
the difference at the source:
```css
li::marker { content: none; font-size: 0; line-height: 0; }
```
This is safe because render-tag draws list markers itself via canvas.

The test suite uses Chromium baselines with 35% tolerance for Firefox.

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
