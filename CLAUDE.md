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
- **Layout is reentrant: one `LayoutSession` per `buildLayoutTree` call**,
  threaded down as `session`. It owns the call's `Measurer`, debug callback,
  lines, min/max-content caches, anonymous flex items and prepared inline
  content. Never add a module-level `let` or cache to layout; put it on the
  session (`tests/node/reentrancy.test.ts`). The deliberate module state:
  `layoutFontMetrics` and `runLineTops` (WeakMaps keyed by results), the
  `claimCtx` writer token (a number, holds no reference), the DOM probe
  elements, and the stateless `Intl.Segmenter`s. `paintBounds` and
  `drawLayout` are reentrant too, and a result paints the same after a later
  `layout()` on a ctx with other font metrics.
- **Inline content: prepare once per call, flow per pass, then emit.**
  `preparedInline` segments and measures an inline formatting context ONCE
  per call into a `PreparedInline` (columns of segment text, width and flags,
  plus one `SegmentRefs` per run). Intrinsic sizing keeps it on the session;
  the layout takes it off (`takePreparedInline`). `flowLines` is the one line
  breaker: min-content at 0, max-content at Infinity, layout at the used
  width. A flow never writes to the prepared content: what a pass cuts is a
  piece in that pass's own `FlowItems`. Only the final flow's lines become
  `Word` objects. Prepared widths are intrinsic; atomic inline-blocks
  (`inlineBlocks`) and percentage-padding edges (`percentEdges`) are re-sized
  for the final flow only (`usedSegmentWidths`). An atomic inline-block is
  U+FFFC for line breaking and bidi only; debug entries and `LayoutLine.text`
  show its content (`FlowItems.debugText`).
- **Each line-breaking rule has one home.** "May a line start here?" is
  `breakBefore`; run-boundary glue is decided at prepare time
  (`abutsWithoutBreak`, `SEG_NO_BREAK_BEFORE`); "may a line end here?" is
  `headGlueWidth`. The other phases: `breakGluedChain`, `knifeEdgeOverflows`,
  `LineFlow` (commit, whitespace trim, soft hyphen, tab stops).
  `layoutInlineContent` runs `flowInlineLines` → `clampLines` → `emitLine`
  (`alignedLineStart`, `lineBoxExtent`, bidi, `emitInlineBackgrounds`,
  `emitLineText`). A new break or glue rule goes INTO these; never re-derive
  it at a call site.
- **Vector consumers exist.** PDF exporters pass Canvas-like proxies that emit
  vector drawing commands. Keep the public boundary Canvas-shaped: shadow images
  use `drawImage`; foreground retains drawing commands and per-paint opacity.
  Adapters own image embedding and preserve paint order if embedding is async.
  Do not assume every `ctx` implements image/transform APIs. `renderShadows: false`
  must omit both CSS and context shadows without buffers or those APIs; the
  exporter is then responsible for the omitted effects. `createCanvas` supplies
  real scratch canvases. A caller's canvas shadow uses the completed rendering
  as its caster. See README's PDF adapter contract and
  `tests/node/vector-shadows.test.ts` before changing this boundary.
- **Shadow scratch (`ScratchPool`, shadow.ts).** A canvas handed to the
  caller's `drawImage` is fresh and never reused or resized. Masks and
  shadows cast onto a pooled canvas are pooled per draw. Text shadows are cast
  in horizontal tiles. WebKit's blur shifts with image extent and offset, so
  keep off-surface displacement minimal, and WebKit drops the shadow of an
  off-surface source-rect `drawImage`, so always draw a pooled canvas whole.
  Gates: `tests/node/shadow-scratch.test.ts`, scratch counters in
  `tests/node/perf-counters.test.ts`.
- **A text-shadow mask records COVERAGE, not color** (`PaintState`
  `coverage`): transparent or translucent text casts a full shadow. Blink
  casts from the fill only; WebKit includes the stroke
  (`STROKE_CASTS_TEXT_SHADOW`). Gates: `text-shadow-coverage`, paint-state.
- **Paint state goes through `PaintState`** (`src/paint-state.ts`). It writes a
  property only when the value changes and never relies on `restore` (some
  proxies do not snapshot state). One `save`/`restore` pair per draw; use
  `ps.save()`/`ps.restore()` only for a transform or clip (values written
  inside are forgotten). Font, kerning and letter-spacing come from the
  helpers `Measurer` uses. Gated by `tests/node/paint-state.test.ts`.

### CSS resolver (`css-syntax.ts`, `css-selectors.ts`, `css-values.ts`, `css-validate.ts`, `css-resolver.ts`, `parse.ts`)

- **One tokenizer** (`css-syntax.ts`, CSS Syntax 3) for `<style>` sheets AND
  `style=""`: strings, escapes, comments, `url()`, nested blocks, spec error
  recovery. `!important` is a flag; a leftover `!` drops the declaration.
  Never go back to `split(';')`.
- **Inline styles come from `getAttribute('style')`**, never
  `el.style.cssText` (the CSSOM re-serializes per engine and drops unknown
  properties). Shorthands are ours to expand (`expandShorthand`).
- **The rule index is the ONE cache that outlives a call.** Keyed by the exact
  css text, LRU-bounded, admitted on a sheet's second sighting; nothing in it
  reaches a result. `tests/node/determinism.test.ts` gates the isolation.
- **A `#text`/`<br>` node's `style` IS its parent element's object.** Nothing
  downstream may write to a style: copy it (`{ ...style, x }`). Style
  identity does not mean "same text node": layout flags the first piece of
  each measuring run (`startsMeasuredRun`) and Blink paint batching never
  merges across it (`tests/node/paint-runs.test.ts`). Private fields
  (`LINE_HEIGHT_MULTIPLIER`, `UNDERLINE_OFFSET_PCT`, `OVERFLOW_X`/`OVERFLOW_Y`,
  `BOX_SIZING`) are SYMBOL keys, assigned after the `defaultStyle()` literal.
- **Cascade order** (`cascadeOrder`): UA defaults (`TAG_DEFAULTS`) < `<font>`
  hints < sheet normal < `style=""` normal < sheet `!important` < `style=""`
  `!important`. `FONT_PROPERTIES` resolve and inherit first (`inheritFont`),
  so em/ch/ex see the final font. CSS-wide keywords are handled once
  (`applyKeyword`, `PROPERTY_FIELDS`), never stored as strings.
- **An invalid value is IGNORED**, never written as 0. A unitless non-zero
  length is invalid. Strings are validated (`css-validate.ts`): keywords
  against their allowed set and stored lower-cased; colors, images,
  `text-shadow` and `font-family` by grammar. Shorthands drop whole on a
  token nothing accepts and reset what they do not name.
- **Percentages resolve against the containing block** (`cbWidth`). Where
  layout decides the width (flex item, table cell, shrink-to-fit
  inline-block), the resolver keeps each percentage in `PERCENT_LENGTHS` and
  layout re-resolves it (`resolvePercentages`, via `resolveChildPercentages`).
  While that width is being computed the percentage is cyclic and reads 0
  (`intrinsicStyle`, CSS Sizing 3 §5.2.1; `tests/box-model-parity.test.ts`).
  `text-indent` and a flex container's `gap` are percentages of the box's OWN
  content width (`OWN_PERCENT_FIELDS`), re-resolved at the settled width
  (`resolvePercentages(…, true)`). An inherited `text-indent` inherits the
  percentage (`inheritPercentages`).
- **`box-sizing`** decides which box `width`, `min-width`, `min-height` and
  `flex-basis` size; `borderBoxSize` / `contentBoxSize` are the one
  conversion. A border-box size never shrinks below padding + border.
  `height` is not supported.
- **Units** (`css-values.ts`): px, em, rem (the root's font-size, not
  `body`'s), %, absolute units, viewport units (`layout()`'s `width` x
  `height`; no height → width; ignored on a path), ch, ex,
  `calc()`/`min()`/`max()`/`clamp()`. ch/ex come from `Measurer.fontUnits`
  (ex = ink ascent of `x`); without a ctx both are 0.5em.
- **Selectors are an allowlist** (`css-selectors.ts`): VALID but unsupported
  (`:has()`, `::before`, form states) never matches, that member only;
  INVALID drops the whole list (Selectors 4). Dynamic states never match.
  Never strip an unknown part and match the rest. `SelectorMatcher` caches
  per call (`~` is ratcheted in `tests/node/perf-counters.test.ts`).
- **Display defaults to `inline`**; only the HTML UA block list is block.
  `<wbr>` becomes `​`; `<q>` gets quote text nodes sharing its style.
- `parseHTML` lifts LEADING `<style>` blocks off as text before DOMParser.
  `<style media>` applies only for `all`/`screen`; media features are not
  evaluated; a `type` other than `text/css` drops it.
  `tests/parse-style-extraction.test.ts` holds it to each engine's parser.

### Text paint propagation (the recurring gradient/stroke/decoration bug class)

Some paints reach descendant text via **painting rules, not CSS inheritance**:
`background-clip:text` backgrounds (gradient AND solid color), `--rt-text-stroke-image`,
and text-decoration bands. `resolveStylesFromCSS` correctly does NOT inherit
`background-image`/`background-clip`/`--rt-text-stroke-image` — but `#text` nodes SHARE
their parent ELEMENT's style object, so a paint declared on an element "works" for its
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

### Text decorations (`src/decoration.ts`)

- **One band per text fragment** (one text node's pieces, contiguous on one
  line), not per word or per declarer: dashes fit and waves keep phase across
  a fragment's spaces and restart at the next text node. `renderBox` groups
  with `sameTextFragment`; `paintFragment` paints underline/overline, glyphs,
  then line-through.
- **No decoration crosses into an atomic inline** (`ATOMIC_INLINE`, CSS Text
  Decoration 3 §2.1): the ancestor's band leaves a gap there.
- **The painter follows `ENGINE`** (src/engine.ts). Blink and WebKit shapes
  and positions are measured off the DOM raster; the formulas live in
  decoration.ts. Gecko is unmeasured. WebKit needs the device scale
  (`PaintState.deviceScale`, from `pixelRatio`).
- Gates: `decoration-shape-parity`, `decoration-position-parity` (DPR 1 and
  2, Chromium + WebKit), `tests/node/decoration-fragments.test.ts`. Text on a
  path still draws the old shapes per glyph.

### Gradients (`src/gradient.ts`)

`parseLinearGradient` follows CSS Images 3; `repeating-linear-gradient` is
unrolled into plain stops; color hints are ignored (linear midpoint).
`PaintState.linearGradient` caches one gradient per image + box per ctx.
Gates: `tests/node/linear-gradient.test.ts`, `gradient-parity` (all lanes).

## Testing workflow

### Native DOM oracle and pinned fonts

Quality scores compare render-tag with a screenshot of the same fixture in an
independent browser page. Chromium and WebKit use isolated Playwright pages.
Firefox uses the same Playwright screenshot path without `omitBackground`,
which its transport does not implement; comparisons normalize both images onto
white instead. The SVG `foreignObject` path remains a fast demo helper and has
a canary against native DOM, but it is not the test oracle.

Capture documents are reused by exact font-face set as persistent iframes
(WebKit also gets a separate top-level page per font set) and receive fresh
fixture content for each screenshot. Native reference PNGs persist in
`node_modules/.cache/render-tag/native-dom/` (git-ignored). The cache key
includes the fixture, viewport, DPR, browser build, OS, the installed
Playwright and `@fontsource*` versions, and the capture implementation;
superseded references are pruned. A render-tag source change or another
dependency bump does not invalidate it. Run `npm run test:clear-native-cache`
to force a cold reference run.

All corpus fonts are pinned `@fontsource` dev dependencies. The fallback stack
also pins Arabic, Devanagari, Myanmar, Khmer, Thai, Japanese, Simplified Chinese,
Korean, and monochrome emoji faces. Tests do not contact Google Fonts or depend
on system fallback selection. `tests/helpers/compare.ts` registers every
unique rule in a stable order and warms the fixture text before measuring.
Native captures keep only faces that cover the fixture and load them
sequentially; a load error throws. The canvas side renders beside EXACTLY that
pruned set (`useOnlyFontFaces`, until the next `prepareComparisonFonts`), or
WebKit picks a different CJK face than the capture. The canvas side gets the
fixture CSS through `canvasFixtureHtml` with every `@font-face` stripped (the
faces are already in `document.fonts`).

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
npm test                                      # baseline pixel/wrap tests (Chromium) + Node suites (npm run test:node)
npm run test:firefox                          # full Firefox + cross-browser + stress gates (own baselines)
npm run test:webkit                           # full WebKit + cross-browser + stress gates (own baselines; not branded Safari)
npm run test:safari-native                    # manual visible Safari diagnostic (macOS; non-core)
npm run test:svg-oracle                       # optional SVG demo-path canary; not a core gate
npm run test:clear-native-cache               # remove local native-reference PNGs
npm run test:cross-browser:record             # record Chrome canvas layout as reference
npm run test:cross-browser:{firefox,webkit}   # compare that engine's canvas layout vs the Chrome reference
npx vitest run -c vitest.node.config.ts tests/node/layout-logic.test.ts  # layout unit tests (Node, mocked measureText, <1s)
npx vitest run tests/wrapping-parity.test.ts  # focused Chrome DOM-wrap regressions
npx vitest run tests/flex-parity.test.ts      # flex item geometry vs the DOM (all 3 lanes)
npx vitest run tests/computed-style-parity.test.ts  # ResolvedStyle vs getComputedStyle (all 3 lanes)
npx vitest run tests/margin-collapse-parity.test.ts  # block margins vs the DOM (Chromium + WebKit)
npx vitest run tests/geometry-oracle.test.ts  # line/token geometry vs the DOM, report-only (Chromium + WebKit)
npx vitest run tests/render.test.ts           # render quality tests
npm run test:stress                           # native-DOM layout width sweep (7 cases, 10px)
npm run test:wrap-sweep                       # full corpus at 1px, default font (rare, ~20 s)
npm run dev                                   # demo page with side-by-side comparison
npm run build                                 # TypeScript compilation
```

### CI vs local deep testing (portable mode)

The recorded contracts are ENVIRONMENT-PINNED: baseline scores, wrap keys,
fuzz signatures and a few hardcoded pixel constants were measured on the
maintainer's machine, and font rasterization differs per OS and per GitHub
runner image (ubuntu drifted scores up to +31.9%; even `macos-latest` WebKit
missed 3 shadow keys). So GitHub Actions runs every lane with
`RENDER_TAG_PORTABLE=1` — injected through a vitest `define` in
`vitest.browser.config.ts` because the browser context has no `process.env`,
read via `tests/helpers/portable-mode.ts`.

Portable mode gates everything that self-compares inside the current
environment (layout unit tests, flex/line-baseline/line-box/wrapping parity,
the fuzz zero-overflow gate, full-corpus crash coverage, node tests, build) at
FULL strictness, and skips only the environment-pinned contracts:

- `render.test.ts` — the baseline score/wrap contract and key-set coverage
  (all cases still render and log; a throw still fails)
- `cross-browser.compare.test.ts` — skipped entirely (the Chrome reference
  layout is a local recording)
- `wrap-fuzz.test.ts` — the structural-signature set only; overflow still gates
- `native-dom-oracle.test.ts` — the ≤1-mismatched-pixel constant relaxes to a
  <2% transport-sanity bound
- `decoration-geometry.test.ts` — the system `serif(default)` rows (unpinned
  font); pinned @fontsource rows still gate

The deep gates are LOCAL: `npm test` / `test:firefox` / `test:webkit` without
the flag remain the release bar. Never "fix" red CI by re-recording baselines
on a runner — either the change is wrong or a gate is environment-pinned and
belongs behind `PORTABLE_GATES_ONLY`. Known watch-item: `stress.test.ts`
residuals are also recorded locally but have matched on CI so far; if a runner
image update flakes them, move that gate behind the flag too.

### Baseline regression system
- Per-browser baseline files: `tests/baselines.chrome.json`, `tests/baselines.firefox.json`, `tests/baselines.webkit.json`
- Each stores `{ score, wrap }` per test case (default font + 5 font variants)
- `score`: content mismatch %. A change greater than 0.01% in either direction fails
- `wrap`: exact normalized line membership; there is no 1–2 character drift allowance
- Baselines cover default font cases, Polotno cases, and all cases × 5 fonts (Open Sans, Roboto, Playfair Display, Merriweather, Lobster)
- Each browser has its own baselines — no cross-browser tolerance hack
- Reference renderer: native browser screenshot (`tests/helpers/native-dom-command.ts`)
- Line membership comes from `extractDomLines` (per-character `Range` rects
  for a word that wraps mid-word). **Take the LAST rect, never the first**: at
  a break Chrome and WebKit emit a spurious leading rect at the end of the
  PREVIOUS line (Firefox does not).
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
  - `npm run test:update-computed-style-failures[:firefox|:webkit]` — computed-style known failures
  - `npm run test:update-perf-counters` — Node work-counter bounds (`tests/perf-counters-baseline.json`)

### Computed-style oracle (`tests/computed-style-parity.test.ts`)

Tier 1: the resolver's `ResolvedStyle` against the browser's own
`getComputedStyle`, field by field, for every element of the CSS-feature
fixtures in `tests/helpers/css-feature-cases.ts`. No fonts, no pixels: about
2 s per lane. The pixel corpus has none of these features, so this is where
resolver bugs are named. `ResolvedStyle` is not computed style: the test
file's header maps each sentinel (`lineHeight: 0` = normal, `width: 0` =
auto, `''` = currentcolor, ...).

`tests/computed-style-known-failures.json` records today's divergences per
browser — a ratchet: a new divergence fails, and so does a listed key that
now passes (the list only shrinks). The git-ignored
`tests/computed-style-report.<browser>.json` holds every divergence. Firefox
is `null` (never recorded): that lane runs the cases but does not gate the set.

### Unit tests for layout logic (`tests/node/layout-logic.test.ts`)
Unit tests cover deterministic layout algorithms directly — no browser, no fonts, no pixels. They mock `ctx.measureText` to return predictable widths (e.g., 10px per character), then assert the output of layout functions.

They run in **Node** under `npm run test:node` (part of `npm test`); pass
`-c vitest.node.config.ts` for a focused run, or the default config runs the
file in Chromium. `layout({ html })` cases parse with linkedom
(`setDOMParser`), pinned against the browser parser by
`tests/node/parity.test.ts`. Node has no Gecko/WebKit user agent, so the
engine flags take the Blink branch. A case that needs real font metrics or
the DOM belongs in a browser suite.

**Good candidates:** hyphen breaking, margin collapsing, line breaking, whitespace handling (`pre-wrap`, `nowrap`, tabs, newlines), CJK breaking, text transform, inline-block atomic wrapping, flex/table column distribution.

**When to add:** new browser behavior logic, bug fixes (regression test), complex edge cases not covered by baselines.

**TDD workflow — always write the failing test first:**
1. Write the unit test that describes the expected behavior
2. Run it — confirm it **fails** (red)
3. Implement the fix/feature
4. Run it — confirm it **passes** (green)
5. Then run baseline tests (`npm test`) to check for regressions

### Determinism and work-counter gates (`tests/node/`) — Tier 0, in `npm test`
Both run in Node on `tests/helpers/recording-ctx.ts`: a Canvas stand-in whose
widths follow the WHOLE measuring state (size, face, `letterSpacing`,
`wordSpacing`, `fontKerning`) and which records paint as effective
operations. `tests/helpers/node-corpus.ts` loads the browser corpus in Node.
Neither gate is environment-pinned, so CI runs both at full strictness.

- **`determinism.test.ts`** — every corpus case (own width, 0.6× width, and
  letter-spacing / word-spacing / `font-kerning: none` variants, one property
  each) laid out and drawn in a FRESH module graph, then forward and in
  reverse through ONE module graph and ONE shared ctx. The serialized
  `LayoutResult` (including object sharing, `paintBounds`) and the paint
  stream must be identical; text-on-path likewise. Any cache that outlives a
  call must keep this green — add it before the cache, not after.
- **`perf-counters.test.ts`** — exact work counts on its fixtures:
  measureText calls and characters, `ctx.font` sets, fillText/save/restore
  per draw, LayoutText count, styled-tree size, and layout's own work
  (inline preparation passes, segments, `Word` objects) through
  `buildLayoutTree`'s internal `stats` sink.
  `tests/perf-counters-baseline.json` is a ratchet: UP fails as a
  regression, DOWN fails until promoted with `npm run test:update-perf-counters`.

### Full-corpus 1px width sweep (`tests/wrap-sweep.test.ts`) — rare milestone gate

The wide net for line-breaking bugs. Not in `npm test`: it sweeps every corpus
case (plus the polotno cases, minus `SWEEP_WRAP_SKIPS`) across every width from
100px to the case's own width in **1px** steps. The recorded gate is
`FONT_MODE = 'default'` (89 keys, ~31.7k comparisons per lane, ~20 s Chrome,
~65 s WebKit). `FONT_MODE = 'all'` adds the 5 font variants, but the baseline
records only default-font keys, so it fails on every `@<font>` key: explore
with it, record before gating on it. Run it deliberately, like a baseline.

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

Counting the knife edges keeps the baseline readable and stable under
measurement nudges.

`tests/wrap-sweep-report.<browser>.json` (git-ignored) carries the full
per-case detail, and the run logs the widest structural bands first — that
ordering is the fixing queue.

**This gate measures what the 531-key baselines cannot.** Those sample each
case at ONE width, so a case can read `wrap=true` there and still break at a
third of all other widths.

Tune `FONT_MODE` / `CASE_FILTER` at the top of the file for a fast subset run
(plain constants — the browser context has no `process.env`).

A long synchronous loop can kill the page mid-sweep with vitest still exiting
0, so `sweepWrapWidths` yields the task queue inside each case, and the sweep
writes `tests/wrap-sweep-progress.<browser>.log` (git-ignored) before each
key. A completed run always writes `tests/wrap-sweep-report.<browser>.json`;
no report file means the run died, and the progress log names the key.

### Geometry oracle (`tests/geometry-oracle.test.ts`) — shadow mode, report-only

Tier-2 geometry: WHERE render-tag puts each line and word, against the
browser's own layout of the same fixture. `compareGeometry`
(`tests/helpers/geometry.ts`) runs the corpus x all six fonts at each case's
own width and writes `tests/geometry-report.<browser>.json` (git-ignored):
per-key line membership, visual order, and signed per-token x / baseline /
advance errors. It asserts nothing about the numbers yet; only an exception
fails it. Chromium and WebKit lanes.

- Same mount and word walk as the wrap oracle (`mountFixture`,
  `collectDomWords`, LAST character rect); lines are cut by `groupDomLines`,
  which `collectDomLines` also uses.
- Membership compares glyphs in LOGICAL order, which is why bidi lines EMIT
  their runs in logical order; visual order is checked separately. RTL
  bidi-override runs are stored visually reversed, so their lines compare
  order-insensitively.
- The DOM has no baseline: it is the word rect's top plus that engine's
  content-area ascent, measured once per font with a zero-size inline-block
  probe (`dAscent` shows the difference). WebKit Range rects are
  pixel-snapped, so its token x and advance have a ~1px floor.

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
measurement bug (nonzero Δ) from a sub-pixel/font-loading artifact (Δ≈0).
`measureText` usually matches the browser to ~0.01px. One measured exception:
Playfair Display at 48px (Canvas `253.34px` vs DOM `251.77px` for
`This is 48px`); the coarse wrap sweep keeps that residual explicit. A global
fit tolerance caused many real line-breaking regressions and was rejected.

### Generative wrap fuzzer (`tests/wrap-fuzz.test.ts`) — regression gate in `npm test`
A generative differential test that *synthesizes* rich-text variations the
curated corpus misses (a word split across inline runs: `<span>E</span>xperience`,
font-size/weight changes mid-word, hyphenated words bisected by a span). It
wraps words mid-word in random `<span>`/`<strong>`/`<em>` with style
mutations, under every `text-align` × `white-space` × `overflow-wrap` ×
base-size combo, and sweeps each through the `compareWrapping` oracle across
widths. Seeded PRNG → deterministic corpus, so it can gate CI.

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

Comments state only short "why" facts (measured engine quirks, spec rules);
no history narration.

### Making changes
1. Run tests before AND after changes
2. Check baselines output for regressions (shows "+X.X REGRESSION!")
3. If a test improves, verify it and update baselines deliberately
4. The stress test (`tests/stress.test.ts`) sweeps widths and gates exact line membership against the native DOM — run it for wrapping changes. It takes no screenshots: a vertical shift that keeps line membership is caught only by the pixel baselines.

### Margin collapsing rules (`layoutBlock`, `leadingStrut`, `collapsesThrough`)
CSS 2.1 §8.3.1, for EVERY block in normal flow — there is no tag allowlist.
`tests/margin-collapse-parity.test.ts` checks each rule against the browser's
own box geometry (Chromium and WebKit lanes).

- **Adjoining margins collapse as a set**: largest positive + most negative
  (`MarginStrut`). Do not fold them two at a time: 10, -5 and 20 give 15, not 20.
- **Which margins adjoin**: siblings; a box's top and its first in-flow child's
  top; a box's bottom and its last in-flow child's bottom. Padding, border, or
  a line box between them separates them. So does a BFC root: flex, table,
  `flow-root`, `overflow` other than `visible`/`clip`, and by position the
  layout root, flex items and table cells (`bfcRoot`).
- **Empty blocks collapse through**: a block with no line box, padding, border
  or min-height joins its top and bottom margins to the run around it. ONE
  predicate, `createsLineBox` (CSS 2.1 §9.4.2), decides both the collapse and
  the height: text, `<br>`, an atomic inline, or an inline with non-zero
  inline-axis margin/border/padding makes a line box (at the strut height
  even with no words); collapsible whitespace and an empty `<span>` do not.
- **A visible marker is content.** An empty `<li>` has the marker's line box.
  An `<li>` whose children all collapse through does not collapse through
  itself; it is the marker's line tall in Blink, 0 in WebKit
  (`MARKER_LINE_WITHOUT_CONTENT`; Gecko gets WebKit's answer, unverified).
  `list-style-position: inside` is not supported.
- **What the resolver must hand layout**: `display: none` subtrees are
  dropped; a border whose style is `none`/`hidden` has width 0;
  `overflow-x`/`overflow-y` count like the shorthand (private `OVERFLOW_X` /
  `OVERFLOW_Y`, NOT on the public `ResolvedStyle`); a percentage `min-height`
  computes to none (no definite containing-block height here).
- **The root holds its children's margins**, like the capture harness's
  `overflow:hidden` content div.
- **min-height on a parent is an engine rule** (`MIN_HEIGHT_END_MARGINS`):
  Blink drops the last child's margins when the min-height raises the box;
  WebKit always collapses them out; Gecko keeps them inside (unverified,
  Firefox cannot run here).

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
| `flex: 0 0 140px` | 140 + padding + border | fixed (`flex-basis` sizes the `box-sizing` box) |

Both intrinsic sizes are the SAME line flow at a different width:
`inlineContentSize` runs `flowLines` at 0 for min-content and at `Infinity`
for max-content, over the same `PreparedInline` the layout then flows, and
takes the widest line. Never give them their own break rules. The one
deliberate difference: min-content neutralizes `overflow-wrap: break-word`
per run (a copied `SegmentRefs`), because CSS ignores it when sizing. The
first line carries `text-indent` in both (a percentage one at 0).

The memo (`session.minContent`/`maxContent`, `contentSize`) holds
CONTENT-box widths; a node's own margins, frame and width are added per
question (`minimumContribution`/`maximumContribution`), because a flex
item's own box resolves against the container while its descendants read
`intrinsicStyle`.

**Inline-blocks** are sized by the same flows: prepared at max-content,
min-content passes use min-content, the final flow shrink-to-fit
(`inlineBlockContentWidth` at 0, Infinity and the used width). Its segment
text is U+FFFC, never its content's text. Block children inside an
inline-block are still flattened into its one inline flow (known gap).

Shrinking is weighted by `flex-shrink x base`, growing by `flex-grow` alone.
Both run through `resolveFlexibleLengths` (CSS Flexbox §9.7) over OUTER
(margin-box) widths — the same currency `minimumContribution`,
`maximumContribution` and `layoutBlock`'s `availableWidth` all use. Each pass
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
the base sizes never matter. Flex fixtures address items by class.

Bare text beside an element in a flex container is an **anonymous flex item**:
`flexItems` wraps it in a block box, once per text node, so sizing and layout
ask about the same node — the min/max-content caches are keyed by identity.

### Line boxes and the baseline (`lineBaselineOffset`, `lineBoxExtent`)
A line box is the union of EVERY box on the line — the block strut, each run,
each `vertical-align`-shifted run, each inline-block. Each box brings its own
line-height and its own half-leading; the line takes `max(ascent - shift)` and
`max(descent + shift)`. Never collapse this back to one leading over the
line's max metrics: that is wrong on every mixed line.

These numbers are the ENGINE's, measured off the DOM (the branch is picked by
user agent):

| | Blink | WebKit | Gecko |
| --- | --- | --- | --- |
| used line-height | 1/64px grid: a number floors, a length rounds | `floor(float32 value)`; a number floors the font-size to 1/64px first | exact |
| percentage line-height | integer percentage (162.9% is 162%) | integer percentage | exact (unverified) |
| half-leading + ascent | half truncated to 1/64px toward zero, then floored | floored to a whole px | exact |
| `vertical-align: super` | `fontSize / 3 + 1` | `fontSize / 3 + 1` | `0.34 × fontSize` |
| `vertical-align: sub` | `fontSize / 5 + 1` | `fontSize / 5 + 1` | `0.2 × fontSize` |

Each question has its own flag in `src/engine.ts` (with UA detection,
`ENGINE`): `TRUNCATES_LINE_HEIGHT` (WebKit), `LAYOUT_UNIT_LINE_HEIGHT`
(Blink: the grid AND the LayoutUnit half-leading), `INTEGER_PERCENT_LINE_HEIGHT`
(Blink and WebKit), `FLOORS_LINE_BASELINE` (Blink and WebKit),
`BLINK_SUPER_SUB` (Blink and WebKit). **Never gate one flag on another**: a
test that did asserted Gecko's shift against Blink's in every engine except
Chrome. A percentage `vertical-align` resolves against the EXACT line-height
(`Measurer.computedLineHeight`, next to the used `lineHeight`).

**Paint is not layout (Blink).** Blink keeps fractional layout but PAINTS
each line box at a whole CSS pixel (line top `Math.round`, half up), with
everything inside keeping its laid-out offset. `SNAPS_LINE_PAINT` and
`paintLineSnap` model it at paint time only: `LayoutText.y` stays the
fractional baseline; render adds `round(lineTop) - lineTop` to glyphs,
decorations, shadows and `paintBounds`. The line top is kept off the public
node (`runLineTops`); a hand-built node falls back to its baseline. Snap the
line, never each run's baseline. Text in an inline-block snaps by its own
inner line box. The auto underline hangs `ceil(fontSize / 20)` px below the
SNAPPED baseline (`BLINK_UNDERLINE_GAP`). WebKit snaps to a DEVICE pixel
(not modelled); Gecko is unmeasured.

`lineBaselineOffset` is the PUBLIC export, not the flag: every renderer that
places a baseline beside a render-tag canvas (`@polotno/svg-export`, the
editor's list marker) calls it, so the rule has one home. It takes the
COMPUTED line-height and applies the engine's LENGTH rule (WebKit's
truncation, Blink's grid rounding) plus each engine's half-leading rounding.
It cannot see a unitless multiplier: for a NUMBER line-height the caller
passes the used value (Blink: `floor(round64(fontSize) × n × 64) / 64`;
WebKit floors the font-size to 1/64px first). The paint snap is not public.

Detecting the engine is UA-only (`accuracy: 'performance'` promises no DOM
probe): Gecko is the one that sends a real `Gecko/<date>` token, Blink the one
that says `Chrome/` — matched with NO word boundary, because headless Chrome
says `HeadlessChrome/`. Safari sends neither. Gecko's rules are unverified
(Firefox cannot launch here); the line-box, line-baseline, margin-collapse
and bidi-order parity tests are in `vitest.firefox.config.ts` so they gate
once it runs. Branded Safari has not been re-measured.

`vertical-align: text-top` / `text-bottom` align the box's LEADED edge with the
parent's CONTENT-area edge (bare ascent/descent, no leading). Mixing those two
up is worth 25px on a line carrying both. `middle` centres the LEADED box too;
render-tag approximates the x-height as 0.5em.

Parity tests: `tests/line-baseline-parity.test.ts` (every line's baseline,
exact, and `middle`) and `tests/line-box-parity.test.ts` (line box height),
both in `npm test` and the WebKit lane; `tests/line-paint-snap-parity.test.ts`
(the paint snap vs Chromium's raster). All assert against the browser's own
numbers. One line-box case is skipped in WebKit (`webkitResidual`).

### Bidi (`src/bidi.ts`, `resolveLineBidi`, `bidiLineItems`)
Canvas reorders only INSIDE one `fillText`; ordering a line's runs is layout's
job.

- `src/bidi.ts` is UAX #9: levels for the whole PARAGRAPH, then L1 and L2 per
  line. The paragraph level is the block's CSS `direction`, not P2/P3.
- CSS reaches it as control characters (`BidiTextBuilder`, CSS Writing Modes
  §2.4.2). A forced break is a paragraph separator; an atomic inline is
  U+FFFC. `[dir]` computes `unicode-bidi: isolate`, `<bdo>`
  `isolate-override`; `dir="auto"` takes the first strong character.
- **Paint direction follows the bidi LEVEL**, never the inherited CSS
  `direction`: every emitted run gets `withDirection(level parity)`. An RTL
  override is reversed in `collectTextRuns` and enters as an LTR override.
- Each line is cut into level-uniform pieces, ordered by L2, painted in the
  level's direction. Adjacent pieces of one non-zero level and one paint
  merge; level-0 words never merge. Padding markers are placed around each
  box's leftmost/rightmost piece, not reordered as characters.
- Nodes are placed left to right, then EMITTED in logical order (`emitKeys`);
  the geometry oracle depends on it.
- `CANVAS_BIDI_LINE` (off in WebKit): a line in ONE paint whose levels Canvas
  resolves the same from the line text stays ONE run, so Canvas shapes it
  as the layout does.
- Text-on-path (`src/path`) uses the same module.

Gates: `tests/node/bidi.test.ts`, `Bidi visual order` in
`tests/node/layout-logic.test.ts`, `tests/bidi-order-parity.test.ts`
(Chromium and WebKit), `tests/path/glyph-layout.test.ts`, and the geometry
oracle's visual-order count (0 in both lanes).

### Text measurement
- **One measuring primitive.** Every layout measurement goes through the
  call's `Measurer`: `m.width(m.stateOf(style), text)` (cached) or
  `m.measureText(state, text)` (uncached). It writes font, `fontKerning` and
  `letterSpacing` TOGETHER and zeroes a stray `ctx.wordSpacing`. Never set
  those on the ctx by hand in layout code (`Measuring state` in
  `tests/node/layout-logic.test.ts`). Layout reaches it as
  `session.measurer`; leaf helpers take `m`.
- **`claimCtx`**: a numeric writer token shared by `Measurer` and
  `PaintState`. A writer re-writes its whole state when another wrote the ctx
  since its last use, so a nested `layout()` cannot move the font under it.
- **Paint writes its whole text state too**: `PaintState` assigns
  `letterSpacing` and `wordSpacing` even at 0.
- **Per-call font state.** Font string, metrics, line height, leaded box and
  tab stops are derived once per style per call and held in the measurer,
  never on the style. Nothing measured survives the call (fonts load between
  calls), except each result's font metrics (`layoutFontMetrics`), which
  paint reads for decorations. Derived styles are copied once per source
  style, not per word.
- **Bounded cumulative context.** A word's width is `w(context + word) -
  w(context)`, keeping kerning across the space. The context restarts at the
  last word after `MEASURE_CONTEXT` (32) UTF-16 units, never at a bare space
  (a lone space measures in the primary font), and an open bracket holds it
  back to the nearest letter (`contextStart`; UBA N0/W7).
- **Knife-edge re-measure, over the edge only.** A line overflowing by under
  1px in one measuring state is re-measured as one string
  (`knifeEdgeOverflows`, 0.02px tolerance). A sum under the edge is trusted:
  re-measuring both ways moved wraps both ways.
- `fontKerning` is `'none'` only for `font-kerning: none`, else `'normal'`
- `ctx.letterSpacing` — use native property, not manual per-character rendering
- Cross-font boundaries still accumulate errors — inherent canvas API limitation
- **Kinsoku (CJK punctuation glue)**: a line never STARTS with a fullwidth
  closer/stop (`。、，！？：；・）` + closing curly quote `”`, plus the Myanmar
  `၊-၏` and Khmer `។-៖ ៘-៚` section signs) and never ENDS with an opener
  (`「（` etc.) — all measured against Chrome DOM with `水×5 <char> 水×7`
  probes. Both live in `TRAILING_PUNCT`/`OPENING_PUNCT` (layout.ts) and become
  segment flags; `breakBefore` applies the closers and `headGlueWidth` the
  openers. Small kana and `ー` are deliberately NOT glued: Chrome's default
  `line-break: auto` breaks before them freely (adding them would CREATE
  divergence).
- Blink paints a plain Latin/Cyrillic/Greek source run with one `fillText` call,
  preserving shaping across spaces. Layout remains word-based and public. The
  paint batch is disabled for complex scripts, rich paints, justification,
  nested boxes, Gecko, and WebKit.
- **Block strut**: every line box has a minimum height AND a baseline from the
  block's OWN font (its font-size × line-height), even when all inline content
  on the line is smaller. `flowInlineLines` seeds `flowLines` (line height)
  and `lineBoxExtent` seeds the per-line ascent/descent (baseline) from
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

## Releasing
1. Add a `CHANGELOG.md` entry at the top for the new version: only
   interesting, user-visible changes since the previous version, one line
   each, plain words. Skip internal test/infra work. Credit external
   contributors and link fixed issues/PRs.
2. `npm version patch --no-git-tag-version`; commit the bump + changelog
   as `render-tag: vX.Y.Z`
3. Push, `npm run build`, `npm publish` (no git tag — tagging stopped at
   v0.1.26)
