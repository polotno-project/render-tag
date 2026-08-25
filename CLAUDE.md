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

### Native DOM oracle and pinned fonts

Quality scores compare render-tag with a screenshot of the same fixture in an
independent browser page. Chromium and WebKit use isolated Playwright pages.
Firefox uses the same Playwright screenshot path without `omitBackground`,
which its transport does not implement; comparisons normalize both images onto
white instead. The SVG `foreignObject` path remains a fast demo helper and has
a canary against native DOM, but it is not the test oracle.

Capture documents are reused by exact font-face set and receive fresh fixture
content/styles for each screenshot. Those documents are persistent iframes, so
the WebKit font cache is never asked to reload a face into a discarded frame.
WebKit additionally gets a separate top-level page per font set; that layer
predates the persistent frames and is kept as belt-and-braces, since a font-cache
regression there caches a wrong reference rather than failing. Native reference
PNGs persist in
`node_modules/.cache/render-tag/native-dom/`, which is already git-ignored.
The cache key includes the complete fixture, viewport, DPR, browser build, OS,
package lock, and capture implementation; references captured under a
superseded environment are pruned. A render-tag source change does not
invalidate the independent reference. Run `npm run test:clear-native-cache` to
force a cold reference run.

All corpus fonts are pinned `@fontsource` dev dependencies. The fallback stack
also pins Arabic, Devanagari, Myanmar, Khmer, Thai, Japanese, Simplified Chinese,
Korean, and monochrome emoji faces. Arabic, CJK and emoji use static files that
all three engines accept; the other families remain variable. Tests do not
contact Google Fonts or depend on system fallback selection.
`tests/helpers/compare.ts` registers every unique rule in a stable order and
warms the actual fixture text before measuring. Native captures keep only faces
that cover that fixture, then load them sequentially. A load error throws before
pixels or wrapping can be recorded.

Unicode-range fonts often put spaces and punctuation in a different face from
the letters. Fixture pruning keeps those neutral faces for the active
family/style/weight; otherwise the isolated DOM and the shared canvas document
silently use different glyphs. WebKit CJK is the exception: its script face owns
the punctuation, and adding overlapping neutral faces changes font selection.

Playwright WebKit is the WebKit engine, not branded Safari. CI runs the full
corpus headlessly with WebKit on macOS. Branded Safari has no headless mode, so
its `safaridriver` canaries are an explicit manual diagnostic, not a CI gate.
They cover solid paint, rich inline text, and exact wrapping; Safari does not
have a recorded 531-case baseline. Do not label WebKit baselines as Safari
results.

Several geometry suites intentionally encode Chrome-first output (for example,
Chrome's decoration position). Run those in the Chromium job only. Firefox and
WebKit still gate the complete native pixel/wrap corpus plus their native-oracle,
cross-browser structure, and width-sweep checks.

### Running tests
```bash
npm test                                      # baseline pixel/wrap tests (vitest + Chromium)
npm run test:firefox                          # full Firefox + cross-browser + stress gates
npm run test:webkit                           # full WebKit + cross-browser + stress gates
npm run test:safari-native                    # manual visible Safari diagnostic (macOS; non-core)
npm run test:svg-oracle                       # optional SVG demo-path canary; not a core gate
npm run test:clear-native-cache               # remove local native-reference PNGs
npx vitest run tests/layout-logic.test.ts     # layout unit tests (mocked measureText, fast)
npx vitest run tests/wrapping-parity.test.ts  # focused Chrome DOM-wrap regressions
npx vitest run tests/flex-parity.test.ts      # flex item geometry vs the DOM (all 3 lanes)
npx vitest run tests/render.test.ts           # render quality tests
npm run test:stress                           # native-DOM layout width sweep (7 cases, 10px)
npm run test:wrap-sweep                       # full corpus x all fonts at 1px (rare, ~13 min)
```

### Baseline regression system
- Per-browser baseline files: `tests/baselines.chrome.json`, `tests/baselines.firefox.json`, `tests/baselines.webkit.json`
- Each stores `{ score, wrap }` per test case (default font + 5 font variants)
- `score`: content mismatch %. A change greater than 0.01% in either direction fails
- `wrap`: exact normalized line membership; there is no 1–2 character drift allowance
- Baselines cover default font cases, Polotno cases, and all cases × 5 fonts (Open Sans, Roboto, Playfair Display, Merriweather, Lobster)
- Each browser has its own baselines — no cross-browser tolerance hack
- Reference renderer: native browser screenshot (`tests/helpers/native-dom-command.ts`)
- Line membership comes from `extractDomLines`, which walks per-CHARACTER
  `Range` rects for any word that wraps mid-word. **Take the LAST rect, never
  the first**: at a break the engine emits a spurious leading rect at the end of
  the PREVIOUS line — Chrome the painted soft-hyphen `-` (nonzero width),
  WebKit a zero-width box at every mid-word break, in every script. Reading
  `getClientRects()[0]` put the first character of each wrapped line on the line
  above, which cost 9 recorded Chrome wrap keys, 111 WebKit keys and WebKit's
  entire 95-width sweep residual — all of them the reference being wrong, not
  render-tag. Firefox emits no such rect.
- Missing and unexpected baseline keys fail before scoring; improvements fail until deliberately promoted
- Cross-browser structural residuals and width-sweep residuals have separate explicit baseline files
- The width sweep compares exact native DOM line membership; it does not take screenshots

### Updating baselines
- **Tests never update baselines** — baselines are only updated via explicit commands as a deliberate milestone
- **Any unrecorded change fails** — regression, improvement, wrap change, or key-set change
- **Update commands** (run after verifying improvements):
  - `npm run test:update-baselines` — Chrome baselines
  - `npm run test:update-baselines:firefox` — Firefox baselines
  - `npm run test:update-baselines:webkit` — WebKit baselines
  - `npm run test:update-cross-browser-baseline:{firefox,webkit}` — structural residuals
  - `npm run test:update-stress-baseline[:firefox|:webkit]` — width-sweep residuals
  - `npm run test:update-wrap-sweep-baseline[:firefox|:webkit]` — full-corpus 1px sweep bands

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

### Full-corpus 1px width sweep (`tests/wrap-sweep.test.ts`) — rare milestone gate

The wide net for line-breaking bugs. Not in `npm test`: it sweeps every corpus
case (plus the polotno cases) across every width from 100px to the case's own
width in **1px** steps, in all six font variants — ~195k line-membership
comparisons per lane, ~13 minutes. Run it deliberately, like a baseline.

```bash
npm run test:wrap-sweep[:firefox|:webkit]
npm run test:update-wrap-sweep-baseline[:firefox|:webkit]
```

**Why 1px, when `stress.test.ts` already sweeps at 10px.** Wrapping is a STEP
function of container width, so a divergence occupies a contiguous *band* of
widths whose size IS the disagreement. A 10px grid samples a band of size `d`
with probability `d/10` — measured on a 12-case subset, it caught **0 of 10**
knife-edge bands and missed **17 of 45** structural ones. The 10px sweep also
covers only 7 hand-named Latin cases, so it never sees the CJK/non-Latin cases
where every recorded wrap failure actually lives.

**Band width is the diagnosis**, and the two classes are recorded differently:

| band | meaning | recorded as |
| --- | --- | --- |
| 1–2px | threshold knife-edge — render-tag and the DOM disagree by a fraction of a px about where one word stops fitting; inherent `measureText`-vs-layout drift | a per-key COUNT (`key knife=<n>`) |
| ≥3px | the wrong break decision PERSISTS across widths — a real break-rule bug | each band listed (`key w=<start>-<end>`) |

Counting the knife edges instead of listing them is what keeps the baseline
readable: on the validation subset, **422 failing widths compressed to 21
signatures**. Listing every width would churn the file on any measurement nudge
and nobody would read it again.

`tests/wrap-sweep-report.<browser>.json` (git-ignored) carries the full
per-case detail, and the run logs the widest structural bands first — that
ordering is the fixing queue.

**This gate measures what the 531-key baselines cannot.** Those sample each case
at ONE width, so a case can read `wrap=true` there and still break at a third of
all other widths — `Non-Latin text alignment`, `Simplified Chinese text` and
`Japanese text mixed scripts` all do exactly that in Chrome.

Tune `FONT_MODE` / `CASE_FILTER` at the top of the file for a fast subset run
(plain constants — the browser context has no `process.env`).

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
- **same line-count, shifted membership** → an exact break-boundary divergence;
  sub-pixel knife edges are still recorded explicitly rather than tolerated

Table cells and multi-column content are marked known-hard in this report: they
contain independent flows that cannot be paired through one global line stream.
Their pixels and direct layout behavior remain covered elsewhere.

The benchmark demo (`docs/benchmark.ts`, isolated via
`benchmark.html?case=…&font=…`) prints a per-character canvas-vs-DOM line check
and per-word `measureText`-vs-DOM-rect deltas — use those to tell a real
measurement bug (nonzero Δ) from a sub-pixel/font-loading artifact (Δ≈0). Note:
`measureText` usually matches the browser to ~0.01px, so most residual
mismatches are sub-pixel knife-edges. One measured exception is Playfair
Display at 48px: Chrome reports `253.34px` through Canvas for `This is 48px`
but lays the same DOM range out at `251.77px`. The coarse wrap sweep keeps that
single structural residual explicit; a global fit tolerance caused many real
line-breaking regressions and was rejected.

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
3. If a test improves, verify it and update baselines deliberately
4. The stress test (`tests/stress.test.ts`) sweeps widths and gates exact line membership against the native DOM — run it for wrapping changes. It no longer screenshots, so a vertical shift that leaves line membership intact is caught only by the pixel baselines, at each case's natural width.

### Margin collapsing rules
- Sibling margins: `max(prevMarginBottom, nextMarginTop)` (positive case)
- First child margin-top collapses through parent: **only for block/list-item `li`/`ul`/`ol`/`dd`/`dt`** (never flex/table; not general divs — the native DOM reference prevents this)
- Last child margin-bottom: included in parent height when parent has padding/border or a nonzero min-height (can't collapse through)
- Last child margin-bottom: passed as `marginBottomOut` when it CAN collapse through

### Flex sizing (`layoutFlex`, `flexBaseSize`, `resolveFlexibleLengths`)
Every flex item has a **base size** before any space is shared, and that is the
whole of the algorithm. `flex-basis` gives it directly; `auto` — the initial
value, and what a bare `flex-grow: 1` leaves in place — resolves to the item's
own **max-content** width. Grow and shrink then act on the FREE space around
those bases, not on the container width:

| declaration | base | what the row does |
| --- | --- | --- |
| `flex: 1` (= `1 1 0%`) | 0 | splits by grow factor alone; content width drops out |
| `flex-grow: 1` | max-content | each item keeps its content width, leftover shared |
| nothing | max-content | items sit at max-content, shrinking only if they overflow |
| `flex: 0 0 140px` | 140 | fixed |

Both intrinsic sizes are the SAME line flow at a different width, not their own
break rules: `minimumInlineContentWidth` is `flowWordsIntoLines(..., 0, ...)`
(every soft-wrap opportunity taken, so each line is one unbreakable unit) and
`maximumInlineContentWidth` is the same call at `Infinity` (only forced breaks).
Both take the widest resulting line. They each used to re-derive "can a line
break here?" privately, and drifted from `flowWordsIntoLines` and from each
other — the number that freezes a flex item is computed by the very rules the
wrapper uses. Keep it that way. The one deliberate difference is that
min-content neutralizes `overflow-wrap: break-word` per word, because CSS
ignores that last resort when sizing.

Shrinking is weighted by `flex-shrink x base`, growing by `flex-grow` alone.
Both run through `resolveFlexibleLengths` (CSS Flexbox §9.7) over OUTER
(margin-box) widths — the same currency `minimumContentWidth`,
`maximumContentWidth` and `layoutBlock`'s `availableWidth` all use. Each pass
freezes the items that landed under their automatic minimum (`min-width: auto`
= min-content) and repeats, because freeing one item changes every other item's
share. Minima that do not fit overflow the container, exactly as they do
natively.

Gated by `tests/flex-parity.test.ts` in all three lanes: it sweeps
`loadFlexCases()` from 120px to each fixture's width and compares every
`<section>`'s x and border-box width against the browser's own layout to
0.05px, plus exact line membership. Flex fixtures are deliberately NOT in
`loadBasicCases()` — a pixel baseline cannot see a wrong column split, and
`Multi-column layout` (the one corpus flex case) is `flex: 1` at 800px, where
the base sizes never matter.

Bare text beside an element in a flex container is an **anonymous flex item**:
`flexItems` wraps it in a block box, once per text node, so sizing and layout
ask about the same node — the min/max-content caches are keyed by identity.
Before that it was counted in the width distribution and then skipped at
placement, so the text vanished and every item after it shifted left.

Not supported, and silently ignored: `:first-child` / `:last-child` and every
other pseudo-class (`parseSelector` returns null for them), so flex fixtures
address items by class.

### Line boxes and the baseline (`lineBaselineOffset`, `layoutInlineContent`)
A line box is the union of EVERY box on the line — the block strut, each run,
each `vertical-align`-shifted run, each inline-block. Each box brings its own
line-height and its own half-leading; the line takes `max(ascent - shift)` and
`max(descent + shift)`. So a line carrying a second font, a second size or a
shifted box stands taller than the largest line-height on it, and its baseline
sits deeper than the strut alone would put it. Do not collapse this back to one
leading over the line's max metrics — that was the old rule, and it was wrong on
every mixed line.

Three of the numbers involved are the ENGINE's, not ours, and each was measured
off the DOM rather than guessed (the branch is picked by user agent):

| | Blink | WebKit | Gecko |
| --- | --- | --- | --- |
| half-leading + ascent | floored to a whole px | exact | exact |
| `vertical-align: super` | `fontSize / 3 + 1` | `fontSize / 3 + 1` | `0.34 × fontSize` |
| `vertical-align: sub` | `fontSize / 5 + 1` | `fontSize / 5 + 1` | `0.2 × fontSize` |

The two questions are separate, and WebKit answers them differently: it rounds
like nobody and shifts like Blink, so `FLOORS_LINE_BASELINE` and
`BLINK_SUPER_SUB` are two flags, not one. Never gate one on the other — a test
that did asserted Gecko's shift against Blink's everywhere but Chrome.

The super/sub rules fit 8-56px across sans-serif/serif/monospace to within
0.06px, and no engine reads the font's own metrics — the family does not move
the number. `layout.ts` carries the corpus measurement behind each branch.

`lineBaselineOffset` is the PUBLIC export, not the flag: every renderer that
places a baseline beside a render-tag canvas (`@polotno/svg-export`, the
editor's list marker) calls it, so the rule has one home.

Safari still cannot assert DOM parity: its canvas metrics disagree with its own
layout metrics (30px/1 lands at 25.59375 in the DOM against 25.5 from the
canvas), so no rule stated in canvas terms can reach it. The exact value is the
closest branch, not a match, which is why the baseline parity suite asserts
against the DOM only in Chrome and Firefox.

Detecting the engine is UA-only (`accuracy: 'performance'` promises no DOM
probe): Gecko is the one that sends a real `Gecko/<date>` token, Blink the one
that says `Chrome/` — matched with NO word boundary, because headless Chrome
says `HeadlessChrome/`. Safari sends neither.

`vertical-align: text-top` / `text-bottom` align the box's LEADED edge with the
parent's CONTENT-area edge (bare ascent/descent, no leading). Mixing those two
up is worth 25px on a line carrying both.

Parity tests: `tests/line-baseline-parity.test.ts` (baseline vs the DOM) and
`tests/line-box-parity.test.ts` (line box height vs the DOM), both in `npm test`,
both asserting against the browser's own numbers rather than a constant.

### Text measurement
- Use cumulative `measureText` within a font run to avoid rounding accumulation
- `ctx.fontKerning = 'normal'` — always set for consistency
- `ctx.letterSpacing` — use native property, not manual per-character rendering
- Cross-font boundaries still accumulate errors — inherent canvas API limitation
- **Kinsoku (CJK punctuation glue)**: a line never STARTS with a fullwidth
  closer/stop (`。、，！？：；・）` + closing curly quote `”`, plus the Myanmar
  `၊-၏` and Khmer `។-៖ ៘-៚` section signs) and never ENDS with an opener
  (`「（` etc.) — all measured against Chrome DOM with `水×5 <char> 水×7`
  probes. Both live in `TRAILING_PUNCT`/`OPENING_PUNCT` (layout.ts), which
  feed the piece-level glue in `flowWordsIntoLines`. Small kana and `ー` are
  deliberately NOT glued: Chrome's default `line-break: auto` breaks before
  them freely (measured; adding them would CREATE divergence).
- Blink paints a plain Latin/Cyrillic/Greek source run with one `fillText` call,
  preserving shaping across spaces. Layout remains word-based and public. The
  paint batch is disabled for complex scripts, rich paints, justification,
  nested boxes, Gecko, and WebKit.
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
- `npm run test:webkit` — full WebKit suite (own baselines; not branded Safari)
- `npm run test:safari-native` — manual visible Safari canaries through safaridriver (non-core)
- `npm run test:cross-browser:record` — record Chrome canvas layout as reference
- `npm run test:cross-browser:firefox` — compare Firefox canvas layout vs Chrome reference
- `npm run test:cross-browser:webkit` — compare WebKit canvas layout vs Chrome reference
- `npm run test:stress` — layout width sweep stress test
- `npm run build` — TypeScript compilation
