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

### Text paint propagation (the recurring gradient/stroke/decoration bug class)

Some paints reach descendant text via **painting rules, not CSS inheritance**:
`background-clip:text` backgrounds (gradient AND solid color), `--rt-text-stroke-image`,
and text-decoration bands. `resolveStylesFromCSS` correctly does NOT inherit
`background-image`/`background-clip`/`--rt-text-stroke-image` — but `#text` nodes copy
their parent ELEMENT's full style, so a paint declared on an element "works" for its
direct text and silently vanishes one nested inline deeper (`<s clip><u>text</u></s>`).
Every historical gradient/underline/stroke invisibility bug came from re-deriving
propagation from a run's own style somewhere in a renderer.

The mechanism (keep new paint features on it):
- **Declarer stamping** — walk ancestors-or-self, stamp the nearest declaring element's
  style (object identity) onto runs/glyphs: `collectTextRuns` (`clipStyle`/
  `strokeImageStyle`) for block layout, `flattenSegments` for text-on-path. A
  `DecorationEntry` carries the same stamp as `declarer`, made once in
  `resolveStylesFromCSS` and shared by reference down the tree — it decides the
  band's thickness and the underline's position, so two runs may only merge
  while `sameDecorationBand` holds (layout.ts).
- **Fragment geometry** — the paint spans the DECLARING element's fragment, not each
  word: `assignInlineFragmentBoxes` (per-line fragment box → `LayoutText.clip`/
  `.strokeImage`) in layout; `assignFragmentRanges` (natural-offset range) on path.
  Block declarers span their border box, threaded down `renderBox` at render time.
- **Precedence** (both renderers must agree): nearest declarer wins; an inherited clip
  paint shows only when the run's own fill is transparent; a transparent decoration
  over clip-painted text paints the band with the clip paint (never skip it);
  `background-clip:text` suppresses the box-background fillRect.

Parity tests: `gradient-clip-inline-nested`, `gradient-clip-descendants`,
`gradient-stroke{,-inline}`, `solid-clip-text`, `path/gradient-clip-parity`.
When touching this area, run all of them plus `decoration-propagation`,
`decoration-offset-thickness` and `webkit-text-stroke`.

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

### Wrap-accuracy debugging harness (`tests/wrap-debug.test.ts`)
A maintainer tool (not part of `npm test`) for hunting text-wrapping divergences
between the canvas and the real DOM. Run `npx vitest run tests/wrap-debug.test.ts`
(or `-c vitest.firefox.config.ts` / `.webkit`); it sweeps every case × font ×
width via `compareWrapping` and writes `tests/wrap-report.<browser>.json`
(git-ignored) listing each failure with per-line diffs and by-case/by-font
counts. Tune the run by editing the `FONT_MODE` / `WIDTH_MODE` / `CASE_FILTER`
constants at the top (they're plain constants — the browser context has no
`process.env`).

When triaging a divergence, classify it before chasing it:
- **structural** (different line *count*) → likely a real break-logic bug
- **same line-count, ±1 char drift** → sub-pixel cumulative noise (rarely fixable)

The benchmark demo (`docs/benchmark.ts`, isolated via
`benchmark.html?case=…&font=…`) prints a per-character canvas-vs-DOM line check
and per-word `measureText`-vs-DOM-rect deltas — use those to tell a real
measurement bug (nonzero Δ) from a sub-pixel/font-loading artifact (Δ≈0). Note:
`measureText` matches the browser to ~0.01px, so most residual mismatches are
sub-pixel knife-edges where browser builds themselves disagree, not bugs.

### Generative wrap fuzzer (`tests/wrap-fuzz.test.ts`) — regression gate in `npm test`
A generative differential test that *synthesizes* rich-text variations instead
of relying on the hand-curated corpus — the curated baselines only cover "cases
someone thought to write down", which is how a whole class of bugs (a word
split across inline-run boundaries: `<span>E</span>xperience`, font-size/weight
changes mid-word, hyphenated words bisected by a formatting span) went
uncovered. It generates words wrapped mid-word in random `<span>`/`<strong>`/
`<em>` with style mutations, under every `text-align` × `white-space` ×
`overflow-wrap` × base-size combo, and sweeps each through the `compareWrapping`
oracle across widths. Seeded PRNG → deterministic corpus, so it can gate CI.

**It asserts** (and so runs in `npm test`, Chrome only):
- **zero box-overflow** — any canvas line wider than its container fails the
  build (the clear render-bug class, e.g. "last glyph outside the box").
- **no NEW structural (line-count) divergence signature** beyond those recorded
  in `tests/wrap-fuzz-baseline.json` (keyed per browser). Known residuals are
  promoted there deliberately — same philosophy as the pixel baselines.

**On failure** it prints the offending signatures + HTML reproducers and writes
`tests/wrap-report.fuzz-<browser>.json` (git-ignored) with all findings. To
promote a verified new residual, copy its signature into the baseline's browser
array. Tune `NUM_CASES`/`SEED` at the top. Firefox/WebKit baselines are `null`
(set-matching skipped there); the overflow gate still applies if added to those
configs.

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
- **Block strut**: every line box has a minimum height AND a baseline from the
  block's OWN font (its font-size × line-height), even when all inline content
  on the line is smaller. `layoutInlineContent` seeds both `flowWordsIntoLines`
  (line height) and the per-line `maxAscent`/`maxDescent` (baseline) from
  `node.style` — so `<li style="font-size:76px"><span style="font-size:42px">…`
  stands 76px tall with the small text on the 76px baseline, matching the DOM.
  Don't reset those seeds to 0 in a refactor.

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

**Bullet disc size is Chrome-tuned (deliberate, Chrome-first).** Bullet symbols
(disc/circle/square) are drawn by scaling the font's glyph so its ink diameter
equals `ascent/3` — Chrome's synthetic-disc size (Blink's ⅔·ascent marker box,
half-filled). The canvas draws ONE disc size for every browser (that's the point
— identical output everywhere), so it's tuned to Chrome. Firefox and WebKit paint
their native discs slightly SMALLER, so their `baselines.{firefox,webkit}.json`
scores rose ~0.3px avg (max ~1.5px on large display fonts) when this landed —
those updates are an intentional Chrome-first residual, NOT an improvement, and
are the one sanctioned exception to "update baselines only after verifying
improvement." The Chrome baseline improved (bullets: ~8px→<1.3px vs native).

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
