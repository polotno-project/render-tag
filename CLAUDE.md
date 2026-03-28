# render-tag

HTML rich text renderer onto canvas using pure 2D API.

## Architecture

```
HTML string + CSS → parseHTML (DOMParser) → resolveStyles (hidden DOM + getComputedStyle)
→ buildLayoutTree (canvas measureText) → renderNode (canvas fillText/fillRect)
```

- **No DOM measurements** for layout — all positions computed from CSS values + `canvas.measureText`
- **DOM used only for** `getComputedStyle` (CSS cascade/inheritance) and `getComputedStyle(el, '::before')` (list markers)
- **`renderHTML()` is synchronous** — no async, no font loading. Caller must load fonts first.

### Key files
- `src/index.ts` — public API: `renderHTML(html, options)`
- `src/style-resolver.ts` — hidden DOM insertion + getComputedStyle walk
- `src/layout.ts` — block flow, inline wrapping, flex, table, lists, RTL
- `src/render.ts` — canvas 2D drawing: text, backgrounds, borders, decorations
- `src/types.ts` — ResolvedStyle, StyledNode, LayoutBox, LayoutText

## Testing workflow

### Running tests
```bash
npm test                              # all tests (vitest + Chromium)
npx vitest run tests/render.test.ts   # render quality tests
npx vitest run tests/stress.test.ts   # layout width sweep
```

### Baseline regression system
- `tests/baselines.json` has locked best-known content mismatch % per test case
- Tests fail if any case regresses by >2% above its baseline
- **After improvements**: update `baselines.json` with new values and commit

### Updating baselines
1. Run tests, note improved cases in output (shows "improved" with delta)
2. Update the values in `tests/baselines.json`
3. Commit baselines alongside the code change

### Content-based mismatch
- Mismatch is measured against **content pixels only** (non-white/non-transparent), not total canvas area
- This prevents empty space from diluting the measurement
- A 600x400 canvas with one line of text might be 5% filled — mismatch is relative to that 5%

## Debugging render issues

### Step 1: Isolate the problem
Create a minimal test case in a temporary test file:
```typescript
const r = await compareRenders(html, css, width, height, 0.1, 1);
console.log('mismatch:', r.contentMismatchPercentage.toFixed(1) + '%');
```

### Step 2: Compare positions via DOM
The most effective debug technique — measure actual DOM element positions and compare with our canvas layout:
```typescript
// Canvas positions
const { root } = buildLayoutTree(ctx, tree, width);
// walk root, log each text/box y position

// DOM positions (ground truth)
container.innerHTML = html;
document.body.appendChild(container);
const elements = container.querySelectorAll('p, div, span');
for (const el of elements) {
  const rect = el.getBoundingClientRect();
  console.log(el.tagName, rect.top - containerTop, rect.height);
}
```

Compare side by side — look for where the delta changes. A consistent offset is fine (baseline vs top-of-text). A changing delta reveals the exact element where layout diverges.

### Step 3: Common root causes
- **Y position drift** → margin collapsing bug (check `collapseMargins`, first/last child collapse)
- **Last child margin-bottom not in parent height** → `prevMarginBottom` not added to `curY` when `canCollapseThrough` is false
- **Words wrapping differently** → `measureText` precision (inherent limitation with mixed fonts)
- **Missing spaces between spans** → whitespace text nodes being stripped in `walkNode`
- **Inline-block not on same line** → consecutive inline children not grouped together
- **Empty elements have wrong height** → check `min-height` support, empty element line-height

### Step 4: Always clean up
Delete debug test files after fixing. Never commit them.

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
Firefox's line box height is 1.5px taller than Chrome for the same `line-height`
value. `getComputedStyle` reports the same value in both browsers, but Firefox's
actual element height is larger. This accumulates in lists (1.5px × N items).

No CSS property fixes this except `display: flex` on the element, which changes
the layout model entirely. For users needing cross-browser consistency:
```css
li { display: flex; align-items: center; }
```

The test suite uses Chromium baselines with 35% tolerance for Firefox.

## Commands
- `npm run dev` — demo page with side-by-side comparison
- `npm test` — vitest in Chromium
- `npm run test:firefox` — vitest in Firefox (wider tolerance)
- `npm run test:stress` — layout width sweep stress test
- `npm run build` — TypeScript compilation
