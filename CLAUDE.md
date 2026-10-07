# render-tag

HTML rich text renderer onto canvas using pure 2D API.

See `README.md` for public API docs, usage examples, and **design decisions** (Chrome-first, cross-browser consistency priorities).

## Architecture

```
HTML string + CSS → parseHTML (DOMParser) → resolveStylesFromCSS (pure CSS parser + cascade)
→ buildLayoutTree (canvas measureText) → renderNode (canvas fillText/fillRect)
```

- **Layout is reentrant: one `LayoutSession` per `buildLayoutTree` call**
  (layout.ts), threaded down every layout function as `session`. It owns the
  call's `Measurer` (font state, widths, DOM-probed line heights), the debug
  callback, the collected lines, the flex min/max-content caches, the
  anonymous flex items and the prepared inline content. layout.ts keeps no per-call module state, so a
  `layout()` made from a `debug` callback or from inside the caller's
  `measureText` cannot touch the outer call (`tests/node/reentrancy.test.ts`,
  every hook point). Do not add a module-level `let` or cache to layout: put
  it on the session. The module state that remains is deliberate:
  `layoutFontMetrics` (a WeakMap from a result to the font metrics its call
  measured, which paint reads; see Text measurement), the `claimCtx` writer
  token (a NUMBER naming which `Measurer` or `PaintState` last wrote a ctx,
  so a writer re-writes its state after a nested call; it holds no answer and
  no reference, so the last call's measurer is not kept alive), the
  `runLineTops` WeakMap (paint bookkeeping keyed by result nodes), the DOM
  probe elements, and the stateless `Intl.Segmenter`s. Reentrancy covers the
  measurements after the call too: `paintBounds` and `drawLayout` (block and
  text-on-path), and a result paints the same after a later `layout()` on a
  ctx with other font metrics.
- **Inline content: prepare once per call, flow per pass, then emit.**
  `preparedInline` segments and measures an inline formatting context's text
  ONCE per call into a `PreparedInline` (layout.ts): columns of segment
  text, width and flags (space, tab, soft
  hyphen, no-break-before, run seam, forced break, CJK/emoji, kinsoku
  punctuation), plus one `SegmentRefs` per run (style and declarers) that the
  segments index. Intrinsic sizing keeps it on the session by node identity;
  the layout, its last reader, takes it off (`takePreparedInline`), so a
  long document does not hold every paragraph until the call ends.
  `flowLines` is the one line breaker over it: min-content
  runs it at 0, max-content at Infinity, the layout at the used width. A
  flow never writes to the prepared content — what a pass cuts (CJK/emoji
  and break-word pieces, glued-chain fragments, a soft hyphen's `-`, a tab at
  the stop it reached) is a piece in that pass's own `FlowItems`, so a pass
  cannot leak into the next (`a tab is placed afresh by every sizing pass`,
  layout-logic). Only the final flow's lines become `Word` objects, for the
  emit pass. Segment text stays the exact measured string (not a range into
  a paragraph string); the columns are plain arrays because typed arrays
  measured slower. `measure-word` debug entries are recorded while preparing
  and replayed by each pass, so the debug stream is what it was when every
  pass tokenized. Every flow emits its `line-wrap`/`line-commit` entries,
  sizing flows included (an inline-block's min/max-content flows at 0 and
  Infinity among them); an atomic inline-block's segment is U+FFFC for line
  breaking and bidi only — debug entries and `LayoutLine.text` show its
  content (`FlowItems.debugText`; an inline-block whose content laid out no
  line adds no text). `perf-counters` counts the passes (`layout.tokenizePasses`:
  one per inline formatting context) and segments. Prepared widths are the
  INTRINSIC ones: the segments whose width depends on the containing
  block's used width — each atomic inline-block (`inlineBlocks`) and each
  inline box edge with a percentage padding (`percentEdges`, prepared at 0)
  — are re-sized for the final flow only (`usedSegmentWidths`).
- **The line breaker is split into phases, and each DOM-measured rule has one
  home.** "May a line start here?" is ONE function, `breakBefore`
  (`'space' | 'continues' | 'glued' | 'allowed'`). The glued tail
  (`gluedRunWidth`), the glued chain (`gluedChainEnd`), the fit test
  (`placePiece`) and the kinsoku of split pieces (`trailingGlueWidth`) all
  ask it. `abutsWithoutBreak` is where its run-boundary glue
  (`SEG_NO_BREAK_BEFORE`) is decided, at prepare time. "May a line END here?"
  (openers, an inline box's opening edge) is `headGlueWidth`. The rest of the
  phases are: words split across runs (`breakGluedChain`), the knife-edge
  re-measure (`knifeEdgeOverflows`), and line commit with its whitespace trimming,
  visible soft hyphen and tab stops (`LineFlow`). `layoutInlineContent` runs
  `flowInlineLines` → `clampLines`, then `emitLine` per line:
  `alignedLineStart`, `lineBoxExtent` (the line-box union), bidi
  reordering, `emitInlineBackgrounds`, `emitLineText`. A new break or glue
  rule goes INTO these functions; never re-derive it at a call site.

### CSS resolver (`css-syntax.ts`, `css-selectors.ts`, `css-values.ts`, `css-validate.ts`, `css-resolver.ts`, `parse.ts`)

- **One tokenizer** (`css-syntax.ts`) for `<style>` sheets AND `style=""`. It
  follows CSS Syntax 3 block structure: strings, escapes, comments, `url()`,
  nested `()`/`[]`/`{}`. So `url(data:…;base64,…)` and `"a;b"` stay one
  value, a `}` in a string does not end a rule, block @-rules are skipped by
  depth, and a nested style rule is dropped. `!important` becomes a flag; a
  leftover `!` (`!important !important`, `!ie`) drops the declaration. Error
  recovery is the spec's: a stray `}` in `style=""` drops its item up to the
  next `;`; a stray top-level `}` joins the next prelude (so that rule is
  dropped); a comment in a prelude is removed with NO space (`.a/**/.b` is
  `.a.b`). Never go back to `split(';')`.
- **Inline styles come from `getAttribute('style')`**, parsed and expanded
  once, never from `el.style.cssText`. The CSSOM re-serializes per engine:
  WebKit expanded `font:`/`border:` into longhands, Chrome lower-cased
  `currentColor`. The resolver gave different answers per browser and per DOM
  (linkedom), and the CSSOM silently dropped what it did not know (inline
  `line-clamp`). Shorthands are therefore OURS to expand (`expandShorthand`:
  `font`, `border*`, `margin`/`padding`, `flex`, `text-decoration`, ...).
- **The rule index is the ONE cache that outlives a call.** It is keyed by
  the exact css text, a pure function of that string (no ctx, font or DOM
  state). Nothing in it reaches a result. It is LRU-bounded (16 sheets, 1M key
  chars, and 10k index entries + declarations — the bound that caps the heap,
  measured at ≤ ~5.6 MB retained), and an index is admitted only on the
  second sighting of a sheet. (`isColor` keeps a 512-entry answer map, the
  same kind of pure string function.)
  `tests/node/determinism.test.ts` ("a caller writing into a result…") gates
  the isolation.
- **A `#text`/`<br>` node's `style` IS its parent element's object** (not a
  copy; 41% of the styled heap). So `run.style === parentElementStyle` for
  direct text, and nothing downstream may write to a style: copy it
  (`{ ...style, x }`) as layout does. Style identity therefore does NOT mean
  "same text node": Blink paint batching must not merge two MEASURING runs
  of one style (`Hello<!---->World` is two runs, measured apart). Layout flags
  the first piece of such a run (`startsMeasuredRun`, a symbol key set only
  on those rare pieces — a per-piece side table cost 7% of layout) and paint
  never batches across it (`tests/node/paint-runs.test.ts`). Inheritance is
  a fixed, field-by-field `inheritFrom`. `defaultStyle()` declares every
  field in one shape; the private ones (`LINE_HEIGHT_MULTIPLIER`,
  `UNDERLINE_OFFSET_PCT`, `OVERFLOW_X/Y`) are SYMBOL keys: copied by spreads,
  invisible to `Object.keys`/JSON, so they are no public field. Assign them
  after the literal — computed keys in the literal cost 12% of resolve.
- **Cascade order** (`cascadeOrder`): UA tag defaults (`TAG_DEFAULTS`, plus
  `[hidden]` and `a[href]` links) < `<font>` presentational hints < sheet
  normal (specificity, order) < `style=""` normal < sheet `!important` <
  `style=""` `!important`. The FONT properties (`FONT_PROPERTIES`) resolve
  first, against the parent, and are inherited before anything else
  (`inheritFont`), so em, ch and ex in every other declaration see the
  element's final font. CSS-wide keywords (`inherit`/`initial`/`unset`,
  `revert` = `unset`) are handled once, generically (`applyKeyword`,
  `PROPERTY_FIELDS`), never stored as strings.
- **An invalid value is IGNORED** (the parser returns NaN / false), as in a
  browser — it never writes 0 over the cascaded value. A unitless non-zero
  length is invalid (standards mode). Strings are validated too
  (`css-validate.ts`): keywords against their property's allowed set and
  stored LOWER-CASED (`display:INLINE` is `inline`; layout compares with
  `===`), colors / images / `text-shadow` / `font-family` by grammar. The raw
  `style` attribute is no longer filtered by the CSSOM, so this is the only
  thing standing between `style="color: foo"` and a canvas that ignores the
  fillStyle and paints with the previous one. Shorthands (`border*`,
  `text-decoration`, `-webkit-text-stroke`, `list-style`, `background`) drop
  whole on a token nothing accepts, and reset what they do not name.
- **Percentages resolve against the containing block**, threaded down the
  recursion (`cbWidth`): a block's content box, passed through inline boxes.
  That is exact for block flow and for flex items (the container's content
  box). Where LAYOUT decides the width instead — a flex item's used width, a
  table cell, a shrink-to-fit inline-block — the resolver keeps each
  percentage declaration in a private side table (`PERCENT_LENGTHS`), and
  layout re-resolves it against the width it settled on
  (`resolvePercentages`, called by `resolveChildPercentages` before anything
  reads the children) and writes the used px into the style. While that
  width is still being COMPUTED the percentage is cyclic: intrinsic sizing
  reads `intrinsicStyle`, where it is 0 (a width, min-width or flex-basis:
  auto), CSS Sizing 3 §5.2.1, measured in Blink and WebKit
  (`tests/box-model-parity.test.ts`). Two fields are percentages of the
  box's OWN content width, not the containing block's (`OWN_PERCENT_FIELDS`):
  `text-indent` and a flex container's `gap`. The resolver resolves them
  against the width it gives the children, and layout again at the box's
  settled content width (`resolveOwnPercentages`, in `layoutBlock` and for an
  inline-block). An inherited `text-indent` inherits the PERCENTAGE (its
  computed value; `inheritPercentages`, the anonymous flex item too), so an
  inline-block inheriting `10%` sizes with it at 0 and then indents by 10% of
  its own width — as Blink and WebKit do. Intrinsic sizing reads both at 0.
- **`box-sizing`** (private `BOX_SIZING`; `content-box` is the initial
  value) decides which box `width`, `min-width`, `min-height` and
  `flex-basis` size: `borderBoxSize` / `contentBoxSize` in the resolver are
  the one conversion layout (`layoutBlock`, flex, inline-blocks) and the
  resolver's `childCb` use. A border-box
  size never shrinks the box below its padding + border. `height` is not
  supported at all.
- **Units** (`css-values.ts`): px, em, rem (the root's `html`/`:root`
  font-size — NOT `body`'s, though the root container stands for both), %,
  pt, pc, in, cm, mm, Q, vw/vh/vmin/vmax (+ s/l/d variants, vi/vb), ch, ex,
  `calc()`/`min()`/`max()`/`clamp()`. The viewport is `layout()`'s
  `width` x `height` (no height: vh falls back to the width); text on a path
  has none, so a viewport unit is ignored there. ch/ex come from the
  caller's ctx through `Measurer.fontUnits` — measured only when used; ex is
  the ink ascent of `x` (engines read OS/2 x-height, ~1-2% apart). Without a
  ctx (`resolveStylesFromCSS` called bare) both are 0.5em.
- **Selectors are an allowlist** (`css-selectors.ts`): anything unsupported
  but VALID (`:has()`, `::before`, `*|p`, form states) makes that selector
  never match, and only that member of a list; anything INVALID (`:foo`,
  `::bogus`, `]`) drops the whole list, as Selectors 4 says. Dynamic states
  (`:hover`, `:focus`, `:visited`) are valid and never active, so
  `:not(:hover)` matches. `:is()`/`:where()`/`:not()` take complex
  selectors. Never strip an unknown part and match the rest — that made
  `:root {}` hit every element. Matching walks the DOM (`SelectorMatcher`:
  one context per element, sibling positions per parent, and the `~` answer
  per element, all cached per call — `~` was quadratic, 610 ms for one rule
  on 4,000 items; `tests/node/perf-counters.test.ts` ratchets it).
- **Display defaults to `inline`** (CSS initial). Only elements in the HTML
  UA sheet's block list are blocks; table internals (`thead`/`tbody`/...)
  stay plain blocks because layout reads rows through them. `<wbr>` becomes a
  `\u200B` text node; `<q>` gets quote text nodes sharing its style.
- `parseHTML` lifts LEADING `<style>` blocks off as text before DOMParser
  (RAWTEXT rules, CR/LF and NUL normalized). DOMParser spent ~1.7 ms on a
  321 KB @font-face sheet. Anything less plain falls back to the DOM. A
  `<style media>` applies only for `all`/`screen` (`not print` too); media
  features are not evaluated, so a query with one does not apply — like an
  `@media` block, which is skipped. A `type` other than `text/css` drops it.
  `tests/parse-style-extraction.test.ts` holds it to each engine's parser.

- **`accuracy` option** (default: `'performance'`) — `'balanced'` enables hidden DOM probes for line heights. `'performance'` uses pure canvas API only.
- **`render()` is synchronous** — no async, no font loading. Caller must load fonts first.
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
  caller's `drawImage` is fresh and never reused or resized (an adapter may
  embed it later). Masks, and shadow images cast onto a pooled canvas (the
  caller-shadow source layer), are pooled per draw and released at its end. Text
  shadows are cast in horizontal tiles from one mask per tile, every value
  into one image. Chromium output is pixel-identical to one whole-group mask.
  WebKit's blur moves by a few levels with the image extent and the shadow
  offset, so keep the off-surface displacement minimal. WebKit also drops the
  shadow of a source-rect `drawImage` drawn off-surface, so always draw a
  pooled canvas whole. Gated by `tests/node/shadow-scratch.test.ts` and the
  scratch counters in `tests/node/perf-counters.test.ts`.
- **A text-shadow mask records COVERAGE, not color** (`PaintState`
  `coverage`): the engines cast the shadow from the glyph shape in the
  shadow's color, so `color: transparent` and 40%-alpha text cast full
  shadows. Blink casts from the FILL only — the text stroke casts nothing —
  while WebKit's mask includes the stroke (`STROKE_CASTS_TEXT_SHADOW`).
  Before casting, the destination's tracker is `finish()`ed: the mask copies
  its dash/cap but its own tracker assumes solid/butt. Gated by
  `text-shadow-coverage` and the paint-state node test.
- **Paint state goes through `PaintState`** (`src/paint-state.ts`). It writes a
  property only when the value changes. It never relies on `restore` to put a
  value back, because some proxies do not snapshot state. A draw has one
  `save`/`restore` pair around it, so the caller gets its ctx state back. Do not
  add a per-run pair. Use `ps.save()`/`ps.restore()` only for a transform or a
  clip; a value written inside that scope is forgotten when it closes. Font,
  kerning and letter-spacing come from the helpers `Measurer` uses, so paint
  cannot drift from measurement. Gated by `tests/node/paint-state.test.ts`.

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

- **One band per text fragment.** The engine paints a decoration once per
  text fragment — one text node's pieces, contiguous on one line — not per
  word and not per declarer: a dash pattern fits and a wave keeps its phase
  across the spaces of a fragment, and both restart at the next text node,
  even under the same declarer (`<u>aa <b>bb</b> cc</u>` is three bands;
  measured in Chromium and WebKit). `renderBox` groups runs with
  `sameTextFragment` (same style object, no `startsMeasuredRun` seam, same
  baseline, touching edges) and `paintFragment` paints underline/overline,
  then the glyphs, then line-through — the engine's order.
- **No decoration crosses into an atomic inline** (inline-block,
  inline-flex, inline-table, ...): the resolver gives such an element only
  its OWN entries (`ATOMIC_INLINE`, CSS Text Decoration 3 §2.1), so the
  ancestor's band leaves a gap where the box sits — both engines,
  `decoration-shape-parity` ("skips an atomic inline").
- **Whose painter** is `DECORATION_PAINTER` (src/engine.ts). Every Blink and
  WebKit rule is measured off the DOM raster, and the Blink ones match its
  source (decoration_line_painter.cc, styled_stroke_data.cc,
  text_decoration_info.cc). Gecko is unmeasured and keeps the old shapes.
- **Blink**: thickness t = fontSize / 10 (painted floor(t) rows); dashes
  3t/2t (2t/t from 3px) with the gap stretched to end on a whole dash;
  dotted ≤ 3px square and NOT fitted, > 3px round dots, fitted; double = a
  second full band t + 1 away, snapped on its own; wavy = cubic per
  `1 + 2·round(2t + 0.5)`, control points `0.5 + round(3t + 0.5)` off axis,
  painted from a device-pixel-aligned tile; line-through top =
  `baseline - ascent / 3 - t / 2` (190 of 190 bands).
- **WebKit**: t = fontSize / 16 painted ceil(t) DEVICE pixels — it needs the
  device scale, which paint takes from `pixelRatio` (`PaintState.deviceScale`);
  the baseline snaps to a device pixel; underline `max(1, ceil(t/2))` below
  it; overline's top on the ascent row; double one band apart, downward;
  an explicit thickness T is also rounded UP on the device grid, and keeps
  the AUTO underline position and the auto overline's bottom edge (Blink
  instead resolves T to round(T) and moves the underline by ceil(T/2));
  dots/dashes `rows`/`2·rows`, unfitted. The line-through comes from a font
  table canvas cannot read: its formula is a FIT, one device pixel off on
  ~1 in 5 bands.
- Gates: `decoration-shape-parity`, `decoration-position-parity` (DPR 1 and
  2, Chromium + WebKit lanes), `tests/node/decoration-fragments.test.ts`.
  The text-on-path renderer still draws the old shapes per glyph (D3).

### Gradients (`src/gradient.ts`)

`parseLinearGradient` follows CSS Images 3: corner keywords depend on the box
aspect ratio, unpositioned stops sit between positioned neighbours, positions
clamp to be monotonic, two-position stops, px stops, and stops outside 0-100%
stretch the canvas gradient line instead of being dropped.
`repeating-linear-gradient` is unrolled into plain stops over the line (kept
monotonic, or a float-rounded seam inverts). A color hint is IGNORED — the
transition stays linear with its midpoint halfway (mixing would need a color
parser). `PaintState.linearGradient`
caches one gradient object per image + box per ctx, so all runs of a
fragment share it. Gates: `tests/node/linear-gradient.test.ts`,
`gradient-parity` (all lanes).

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
the installed Playwright and `@fontsource*` versions, and the capture
implementation; references captured under a superseded environment are pruned.
A render-tag source change does not invalidate the independent reference, and
neither does any other dependency bump (vitest, vite, TypeScript). Run `npm run test:clear-native-cache` to
force a cold reference run.

All corpus fonts are pinned `@fontsource` dev dependencies. The fallback stack
also pins Arabic, Devanagari, Myanmar, Khmer, Thai, Japanese, Simplified Chinese,
Korean, and monochrome emoji faces. Arabic, CJK and emoji use static files that
all three engines accept; the other families remain variable. Tests do not
contact Google Fonts or depend on system fallback selection.
`tests/helpers/compare.ts` registers every unique rule in a stable order and
warms the actual fixture text before measuring. Native captures keep only faces
that cover that fixture, then load them sequentially. The canvas side of a pixel
comparison then renders beside EXACTLY that pruned set: every rule has its own
`<style>`, and `compareRendersWithReference` disables the ones the fixture's
pruned CSS lacks (`useOnlyFontFaces`) until the next `prepareComparisonFonts`.
Beside the full catalog, WebKit picked a different CJK face on the canvas than
in the isolated capture: Simplified Chinese, Korean, CJK formatting/lists and
Long CJK paragraph read 12-38% with identical layout, and 0.00-0.62 once the
sets matched (Chromium: Subscript and superscript and Numbers and currency in
RTL, up to 10%, the same way). An earlier note blamed WebKit for painting CJK
glyphs 1px below its own baseline; that was this harness effect. A load error throws before
pixels or wrapping can be recorded. The canvas side gets the fixture CSS through
`canvasFixtureHtml`, with every `@font-face` stripped: the faces are already in
`document.fonts`, and parsing ~370 KB of them cost about 3 ms per `layout()`
call against ~0.4 ms for the layout itself (the 1px sweep went from ~100 s to
~20 s, with every score, wrap and sweep result byte-identical).

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
npm test                                      # baseline pixel/wrap tests (Chromium) + Node suites
npm run test:firefox                          # full Firefox + cross-browser + stress gates
npm run test:webkit                           # full WebKit + cross-browser + stress gates
npm run test:safari-native                    # manual visible Safari diagnostic (macOS; non-core)
npm run test:svg-oracle                       # optional SVG demo-path canary; not a core gate
npm run test:clear-native-cache               # remove local native-reference PNGs
npx vitest run -c vitest.node.config.ts tests/node/layout-logic.test.ts  # layout unit tests (Node, mocked measureText, <1s)
npx vitest run tests/wrapping-parity.test.ts  # focused Chrome DOM-wrap regressions
npx vitest run tests/flex-parity.test.ts      # flex item geometry vs the DOM (all 3 lanes)
npx vitest run tests/computed-style-parity.test.ts  # ResolvedStyle vs getComputedStyle (all 3 lanes)
npx vitest run tests/margin-collapse-parity.test.ts  # block margins vs the DOM (Chromium + WebKit)
npx vitest run tests/geometry-oracle.test.ts  # line/token geometry vs the DOM, report-only (Chromium + WebKit)
npx vitest run tests/render.test.ts           # render quality tests
npm run test:stress                           # native-DOM layout width sweep (7 cases, 10px)
npm run test:wrap-sweep                       # full corpus at 1px, default font (rare, ~20 s)
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
  - `npm run test:update-computed-style-failures[:firefox|:webkit]` — computed-style known failures
  - `npm run test:update-perf-counters` — Node work-counter bounds (`tests/perf-counters-baseline.json`)

### Computed-style oracle (`tests/computed-style-parity.test.ts`)

Tier 1: the resolver's `ResolvedStyle` against the browser's own
`getComputedStyle`, field by field, for every element of the generated
CSS-feature fixtures in `tests/helpers/css-feature-cases.ts` (units, the `font`
shorthand, `!important`, `background`, `currentcolor`, `url(data:…)`,
phrasing/legacy/unknown elements, structural/attribute selectors and
combinators, inheritance and CSS-wide keywords, containing-block
percentages). No fonts, no pixels: about 2 s per lane. The pixel corpus has
none of these features, so this is where resolver bugs are named.

`ResolvedStyle` is not computed style: the test file's header maps each
sentinel (`lineHeight: 0` = normal, `width: 0` = auto, `''` = currentcolor,
own vs propagated decoration lines, the decoration PAINT color, ...)
explicitly. Free-form strings (colors, images, shadows, families) are
normalized through a probe element in the top document.

`tests/computed-style-known-failures.json` records today's divergences per
browser — a ratchet like the baselines: a new divergence fails, and so does a
listed key that now passes (remove it; the list only shrinks). The
git-ignored `tests/computed-style-report.<browser>.json` holds every divergence
with both values for triage. Firefox is `null` (never recorded): that lane runs
the cases but does not gate the set until recorded there.

### Unit tests for layout logic (`tests/node/layout-logic.test.ts`)
Unit tests cover deterministic layout algorithms directly — no browser, no fonts, no pixels. They mock `ctx.measureText` to return predictable widths (e.g., 10px per character), then assert the output of layout functions.

They run in **Node** under `npm run test:node` (part of `npm test`), so a
focused run takes under a second — pass `-c vitest.node.config.ts`, or the
default config runs the file in Chromium. Cases that go through
`layout({ html })` parse with linkedom (`setDOMParser`), which
`tests/node/parity.test.ts` pins against the browser parser. Node has no
Gecko/WebKit user agent, so the engine flags always take the Blink branch
there. A case that needs real font metrics or the DOM does not belong here:
put it in a browser suite (the real-font block-strut baseline case lives in
`tests/line-baseline-parity.test.ts`).

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
`wordSpacing`, `fontKerning` as a pair term) and which records paint as
effective operations — each fillText/stroke/drawImage with the state it reads.
`tests/helpers/node-corpus.ts` loads the browser corpus in Node with inert
`@font-face` rules. Neither gate is environment-pinned, so CI runs both at
full strictness.

- **`determinism.test.ts`** — every corpus case (own width, 0.6× width, and
  the same text re-stated under letter-spacing, word-spacing and
  `font-kerning: none` — one property per variant, so a cache key missing
  any single one collides) laid out and drawn in
  a FRESH module graph, then again forward and in reverse through ONE module
  graph and ONE shared ctx. The serialized `LayoutResult` (including object
  sharing, `paintBounds`) and the paint stream must be identical; text-on-path
  likewise. Any cache that outlives a call must keep this green — add it
  before the cache, not after.
- **`perf-counters.test.ts`** — exact work counts on its fixtures (2000-word
  paragraph, 2000-char CJK paragraph, the `perf.test` document, sibling
  selectors over 4000 items, 50 shadowed paragraphs, nested flex leaves, a
  4000-item `<ol>`): measureText calls and characters, `ctx.font` sets,
  fillText/save/restore per draw, LayoutText count, styled-tree size, and
  layout's own work that no ctx call shows — inline preparation passes,
  segments and per-item `Word` objects, read through `buildLayoutTree`'s
  internal `stats` sink. `tests/perf-counters-baseline.json` holds them as a
  ratchet: UP fails as a regression, DOWN fails until promoted with
  `npm run test:update-perf-counters`.

### Full-corpus 1px width sweep (`tests/wrap-sweep.test.ts`) — rare milestone gate

The wide net for line-breaking bugs. Not in `npm test`: it sweeps every corpus
case (plus the polotno cases, minus `SWEEP_WRAP_SKIPS`) across every width from
100px to the case's own width in **1px** steps. The recorded gate is
`FONT_MODE = 'default'` — the corpus font only: 89 keys, ~31.7k line-membership
comparisons per lane, ~20 s in Chrome, ~65 s in WebKit. Run it deliberately,
like a baseline.

`FONT_MODE = 'all'` adds the 5 font variants (519 keys, ~184k comparisons,
~2 min in Chrome). It completes now that the sweep yields inside each case,
but `wrap-sweep-baseline.json` records only default-font keys, so an `'all'`
run fails the gate on every `@<font>` key — use it to explore, and record it
before gating on it.

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

Browser console output does not stream from this runner, and a long
synchronous loop can kill the page mid-sweep ("rpc is closed") — with vitest
sometimes still exiting 0. `sweepWrapWidths` therefore yields the page's task
queue every 200ms of work, inside a case and not only between keys (a sweep
with no yields died after 26 s; with them it completes). The sweep also
writes `tests/wrap-sweep-progress.<browser>.log` (git-ignored) before each
key; on a silent death that file names the key that was running. A completed
run always writes `tests/wrap-sweep-report.<browser>.json`; no report file
means the run died.

### Geometry oracle (`tests/geometry-oracle.test.ts`) — shadow mode, report-only

Tier-2 geometry: WHERE render-tag puts each line and word, against the
browser's own layout of the same fixture, instead of how many pixels differ.
`compareGeometry` (`tests/helpers/geometry.ts`) runs the corpus x all six
fonts at each case's own width (~4 s Chromium, ~17 s WebKit) and writes
`tests/geometry-report.<browser>.json` (git-ignored): per key, order-aware
line membership, per-line visual order, and signed per-token x / baseline /
advance and per-line baseline / x-range errors. It asserts nothing about the
numbers yet; only an exception fails it. It is in the Chromium and WebKit
lanes; Firefox has not been run.

- Same mount and word walk as the wrap oracle (`mountFixture`,
  `collectDomWords`, LAST character rect); both sides are cut into lines by
  the one rule, `groupDomLines`, which `collectDomLines` also uses. Its
  membership verdict equals the recorded `wrap` bit on every key in both
  lanes.
- Membership compares each line's glyphs in LOGICAL order (wrap-comparison
  sorts code points), which is why bidi lines EMIT their runs in logical
  order. Visual order (run order by x) is checked separately; that is how it
  found `Mixed scripts with formatting` painting two adjacent RTL words in
  logical order inside an LTR line (fixed: 0 keys in both lanes, see "Bidi").
  It cannot see order INSIDE one run. RTL bidi-override runs are stored
  visually reversed, so their lines compare order-insensitively.
- Tokens pair through a character alignment: the DOM tokenizes per word,
  render-tag per run.
- The DOM has no baseline. It is the word rect's top plus that engine's
  content-area ascent, measured once per computed font outside the fixture
  with a zero-size inline-block probe. Blink rounds that ascent to a whole
  px, so `canvas fontBoundingBoxAscent` would put the baseline up to ~0.5px
  off. `dAscent` keeps the difference visible.
- WebKit Range rects are pixel-snapped, so its token x and advance have a
  ~1px floor. Baselines are not affected.

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
  or min-height (all its children empty too) joins its top and bottom margins
  to the run around it. ONE predicate, `createsLineBox` (CSS 2.1 §9.4.2),
  decides both the collapse and the height: text, `<br>`, an atomic inline,
  or an inline with non-zero inline-axis margin/border/padding makes a line
  box (at the strut height even with no words — `<span style="padding:0
  3px"></span>` is a 20px line in both engines); collapsible whitespace and an
  empty `<span>` do not.
- **A visible marker is content.** An empty `<li>` has the marker's line box.
  An `<li>` whose children all collapse through does not collapse through
  itself: their margins adjoin its top AND its bottom, and the item is the
  marker's line tall in Blink, 0 in WebKit (`MARKER_LINE_WITHOUT_CONTENT`;
  Gecko gets WebKit's answer, unverified). `list-style-position: inside` is
  not supported at all (its marker would be an inline line box that stops the
  li > p first-child collapse).
- **What the resolver must hand layout**: `display: none` subtrees are dropped
  (they used to be laid out, margins and text included); a border whose style
  is `none`/`hidden` has width 0; `overflow-x`/`overflow-y` count like the
  shorthand (kept in private `_overflowX`/`_overflowY`, NOT on the public
  `ResolvedStyle`); a percentage `min-height` computes to none, because no
  containing block here has a definite height.
- **The root holds its children's margins**, like the capture harness's
  `overflow:hidden` content div. The first child's top margin and the last
  child's bottom margin stay inside the content height.
- **min-height on a parent is an engine rule** (`MIN_HEIGHT_END_MARGINS`).
  Blink: a min-height that raises the box drops the last child's margins.
  WebKit: they always collapse out (CSS 2.1 as written). Gecko: render-tag's
  old rule (any min-height holds them inside). This is unverified, because
  Firefox cannot run here. The parity test is not in the Firefox lane yet.

The old claim "only `li`/`ul`/`ol`/`dd`/`dt` collapse through a parent, the
native reference prevents it for divs" came from the retired html-to-svg
reference. That reference wrapped content in a `<body>`. The native harness
does not. The allowlist cost ~25% of Chrome's pixel mass ("Non-Latin text
alignment", "Pre-wrap preserved whitespace").

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

Both intrinsic sizes are the SAME line flow at a different width, not their own
break rules: `minimumInlineContentWidth` is `flowLines(..., 0, ...)`
(every soft-wrap opportunity taken, so each line is one unbreakable unit) and
`maximumInlineContentWidth` is the same call at `Infinity` (only forced breaks).
Both take the widest resulting line. They each used to re-derive "can a line
break here?" privately, and drifted from the wrapper and from each
other — the number that freezes a flex item is computed by the very rules the
wrapper uses. Keep it that way. They also read the SAME `PreparedInline` the
layout then flows (one segmentation per item per call, not three). The one
deliberate difference is that min-content neutralizes `overflow-wrap:
break-word` per run (a copy of its `SegmentRefs` with a copied style),
because CSS ignores that last resort when sizing. The first line carries
the block's `text-indent` in both, as it does in the final flow (a
percentage `text-indent` at 0 there: it is of the width being computed).

The memo (`session.minContent`/`maxContent`, `contentMinimum`/
`contentMaximum`) holds CONTENT-box widths; a node's own margins, frame and
width are added per question (`minimumContribution`/`maximumContribution`),
because they are read two ways: a flex item's own box resolves against the
container (`node.style`), every descendant inside a size being computed
through `intrinsicStyle` (cyclic percentages at 0).

**Inline-blocks** are sized by the same flows: an atomic segment is prepared
at its max-content contribution, min-content passes it at its min-content
one, and the final flow at shrink-to-fit, min(max(min-content, available),
max-content) of its OWN content in its own styles
(`inlineBlockContentWidth` at 0, Infinity and the used width). Its segment
text is U+FFFC, never its content's text: CJK content made the atomic box
splittable and a trailing period glued it. Block children inside an
inline-block are still flattened into its one inline flow, and sized by
that flow (known gap: Stage 5).

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

Flex fixtures address items by class. Structural pseudo-classes
(`:first-child`, `:nth-child()`, ...) are supported now (see the CSS resolver
section), but the recorded fixtures predate them.

### Line boxes and the baseline (`lineBaselineOffset`, `lineBoxExtent`)
A line box is the union of EVERY box on the line — the block strut, each run,
each `vertical-align`-shifted run, each inline-block. Each box brings its own
line-height and its own half-leading; the line takes `max(ascent - shift)` and
`max(descent + shift)`. So a line carrying a second font, a second size or a
shifted box stands taller than the largest line-height on it, and its baseline
sits deeper than the strut alone would put it. Do not collapse this back to one
leading over the line's max metrics — that was the old rule, and it was wrong on
every mixed line.

Four of the numbers involved are the ENGINE's, not ours, and each was measured
off the DOM rather than guessed (the branch is picked by user agent):

| | Blink | WebKit | Gecko |
| --- | --- | --- | --- |
| used line-height | 1/64px grid: a number floors, a length rounds | `floor(float32 value)`; a number floors the font-size to 1/64px first | exact |
| percentage line-height | integer percentage (162.9% is 162%) | integer percentage | exact (unverified) |
| half-leading + ascent | half truncated to 1/64px toward zero, then floored | floored to a whole px | exact |
| `vertical-align: super` | `fontSize / 3 + 1` | `fontSize / 3 + 1` | `0.34 × fontSize` |
| `vertical-align: sub` | `fontSize / 5 + 1` | `fontSize / 5 + 1` | `0.2 × fontSize` |

Each question is separate, and each has its own flag: `TRUNCATES_LINE_HEIGHT`
(WebKit), `LAYOUT_UNIT_LINE_HEIGHT` (Blink: the line-height grid AND the
LayoutUnit half-leading — one mechanism, Blink's 1/64px arithmetic),
`INTEGER_PERCENT_LINE_HEIGHT` (Blink and WebKit; in `src/engine.ts` because
the resolver applies it), `FLOORS_LINE_BASELINE` (Blink and WebKit),
`BLINK_SUPER_SUB` (Blink and WebKit). UA detection lives in `src/engine.ts`. Never gate one on another. A
test that did that asserted Gecko's shift against Blink's in every engine
except Chrome.

The Blink line-height rule (`LAYOUT_UNIT_LINE_HEIGHT`, measured as the DOM's
line pitch over 64 lines):
- A NUMBER rounds the font-size onto the 1/64px grid, multiplies, and floors
  the product onto the grid: 14px × 1.6 is 22.390625, not 22.4. 20 × 1.15 is
  23 (an epsilon keeps the double product, a hair under, on the grid).
- A LENGTH (px, em, %) rounds to the nearest grid line: 22.4px is 22.40625.
  A PERCENTAGE is first truncated to an integer percentage (in WebKit too):
  133.3% of 16px is 21.28, 162.5% of 8px is 12.96 (on the grid 12.953125).
  That also explains the old "133.06% / 133.09% land one step lower" note.
- The half-leading is halved in LayoutUnits, truncating toward ZERO, and only
  then floored: a line an odd number of 64ths SHORT of ascent+descent puts the
  baseline a pixel lower than flooring the exact half (Verdana 13.6px × 1.25:
  16.984375 over 14 + 3 → baseline 14, not 13).
- An older note called this drift sub-pixel and pixel-neutral. It was, until
  the paint snap below: ~0.01px a line moves a line across a rounding point
  after a few dozen lines (Long document: 3.2% → 0.00 in all six fonts).
- `lineBaselineOffset` applies the LENGTH rule (rounding to the grid,
  idempotent) and the LayoutUnit half-leading. It cannot apply the NUMBER rule
  (it sees a px value, not the multiplier): a caller with a unitless
  line-height must pass the grid value, `floor(round64(fontSize) × n × 64) / 64`.

**Paint is not layout (Blink).** Blink keeps the fractional layout above, but
PAINTS each line box at a whole CSS pixel: the line top rounds (`Math.round`,
half up) and everything inside the line keeps its laid-out offset — the
baseline, a `super`/`sub`/length shift. `SNAPS_LINE_PAINT` and
`paintLineSnap` (layout.ts) model it at paint time only: `LayoutText.y` stays
the fractional layout baseline, `render.ts` adds `round(lineTop) - lineTop` to
the glyphs, every decoration, the shadow pass and `paintBounds`. The line top
is paint bookkeeping kept off the public node (a WeakMap keyed by node
identity); a hand-built or cloned node falls back to its line baseline.
- Measured on Chromium's DOM raster with the line top at k/16px, six fonts:
  pixel-identical at DPR 1, 2 AND 3 (576 of 576 plain lines), so it is a CSS
  pixel, not a device pixel. A canvas lands `fillText` on a device pixel
  itself, which is why DPR 1 looked right before.
- Rounding each RUN's own baseline instead puts `sub` and length shifts a
  pixel off (and was worse than no snap for `super` at DPR 2-3): the shift is
  not snapped, the line is. Text inside an inline-block snaps by its OWN inner line box.
- Chromium pixel mass 1076.9 → 458.6 (-57%), with the line-height grid above.
- The auto underline hangs `ceil(fontSize / 20)` px below the SNAPPED baseline
  (`BLINK_UNDERLINE_GAP`) — half the auto thickness, rounded up, the same rule
  an explicit `text-decoration-thickness` follows. Measured 672 of 672 bands
  (six pinned fonts, 8-72px, DPR 1-2) plus 198 of 198 across eleven system
  families. The old `0.105em - 0.2` formula was fitted to Chrome at fractional
  baselines before the snap was modelled; WebKit and Gecko keep it.
- WebKit snaps its text baseline to a DEVICE pixel instead (192 of 192 at
  DPR 1 and 2, 176 of 192 at DPR 3). That needs the device scale at paint
  time; not modelled. Gecko: unmeasured, keeps the unsnapped paint.
- Decoration shapes and positions are in "Text decorations" below. Blink
  computes an underline's rect BEFORE the line snap (it moves with the
  decorating box), so the snap's half pixel decides a double's gap and a
  dash's row; the band still lands on the snapped row.
- Under `line-height: normal`, a font with a line gap (Arial) puts Chromium's
  baseline below render-tag's — 2px at 160px. Canvas metrics cannot see the
  gap. Pre-existing; not this rule.

The WebKit line-height rule:
- WebKit lays every line box out at a whole-pixel line-height. 16px × 1.6 is a
  25px line, and 20px × 1.15 is 23. The double product is
  22.999999999999996, so `Math.floor` alone gives 22: round through
  `Math.fround` first. `23.99999px` is 23.
- A unitless NUMBER floors the font-size to 1/64px BEFORE it multiplies:
  13.6px × 1.25 is a 16px line (13.59375 × 1.25), not 17; 17.3 × 1.85 is 31.
  (`multipliedLineHeight`.)
- The baseline sits `floor(half-leading)` below the line top, plus the ascent.
- Measured in Playwright WebKit: 1,768 of 1,768 configurations matched
  (eight families, 8-56px, seventeen line-heights including `normal`, %, em
  and px), but that sweep used whole sizes and whole percentages. A review
  sweep at fractional sizes found 33 of 2,898 unitless rows a pixel off until
  the 1/64 font-size floor above, and non-integer percentages off until the
  integer-percentage rule; `line-baseline-parity` pins rows of each. The system
  `monospace` is excluded: its DOM content area is 1px taller than its canvas
  metrics.
- A percentage `vertical-align` still resolves against the EXACT value (50% of
  25.6px moves 12.796875). That is why `Measurer` has `computedLineHeight` next
  to `lineHeight` (the used value).
- Before this rule, render-tag drifted 0.4-0.8px further down per line in
  WebKit: 83% of that lane's pixel mass.
- An old corpus run rejected the floor for Safari (214 wins, 223 losses). It
  tested the floor WITHOUT the truncation. Only both together match.

The super/sub rules fit 8-56px across sans-serif/serif/monospace to within
0.06px, and no engine reads the font's own metrics — the family does not move
the number. `layout.ts` carries the corpus measurement behind each branch.

`lineBaselineOffset` is the PUBLIC export, not the flag: every renderer that
places a baseline beside a render-tag canvas (`@polotno/svg-export`, the
editor's list marker) calls it, so the rule has one home. It takes the
COMPUTED line-height and applies the engine's LENGTH rule itself (WebKit's
truncation, Blink's grid rounding) plus each engine's half-leading rounding.
It cannot see a unitless multiplier, so for a NUMBER line-height WebKit's
1/64 font-size floor and Blink's floored product are the caller's job (see
the two rule lists above); the line box it heads is the used line-height tall,
and a caller that steps lines steps by that used value. The Blink paint snap
(`paintLineSnap`) is not public either: a vector exporter positioning glyphs
from `LayoutText.y` is up to 0.5px off Chromium's raster. Exposing either is
a public-API decision, deliberately not taken in Stage 1.5.

Playwright WebKit now asserts DOM parity like the other engines: its canvas
font metrics are whole pixels and equal to its layout metrics for the pinned
fonts and the system sans-serif/serif. An older note said Safari's canvas and
layout metrics disagree (30px/1 at 25.59375 in the DOM against 25.5); that does
not reproduce in Playwright WebKit, where the line lands at 25. Branded Safari
has NOT been re-measured.

**Unverified in Firefox:** Gecko keeps the exact line-height, the exact
percentage and the exact half-leading. Firefox could not launch where this was
measured, so the Firefox lane was NOT run at all in Stage 1.5 — no Firefox
score moved because none was taken. If Gecko also truncates, the Firefox
geometry oracle will show the same 0.4-0.8px per-line slope. The four Stage 1.5
parity tests (line-box, line-baseline, margin-collapse, bidi-order) are in
`vitest.firefox.config.ts` so they gate once Firefox runs.

Detecting the engine is UA-only (`accuracy: 'performance'` promises no DOM
probe): Gecko is the one that sends a real `Gecko/<date>` token, Blink the one
that says `Chrome/` — matched with NO word boundary, because headless Chrome
says `HeadlessChrome/`. Safari sends neither.

`vertical-align: text-top` / `text-bottom` align the box's LEADED edge with the
parent's CONTENT-area edge (bare ascent/descent, no leading). Mixing those two
up is worth 25px on a line carrying both. `middle` centres the LEADED box too,
not the content area. Where the half-leading is floored, the two midpoints are
up to 0.5px apart (DOM 34.70, content area 34.0, leaded 34.5 in both Blink and
WebKit). The remaining 0.2px comes from the x-height, which render-tag
approximates as 0.5em.

Parity tests: `tests/line-baseline-parity.test.ts` (first-line baseline, the
baseline of every line — exact, not within a LayoutUnit per line — and
`middle`) and `tests/line-box-parity.test.ts` (line box height). Both run in
`npm test` and in the WebKit lane. `tests/line-paint-snap-parity.test.ts`
gates the paint snap against Chromium's raster (Chromium only). Both assert against the
browser's own numbers, not against a constant. One line-box case is skipped
in WebKit only, for a residual that comes from another rule (see its
`webkitResidual`): `font-size: smaller` is 0.83em in render-tag but /1.2 in
both engines.

### Bidi (`src/bidi.ts`, `resolveLineBidi`, `bidiLineItems`)
Canvas reorders only INSIDE one `fillText`. A line with several runs (two
styles, a box, a shifted span) is several calls, and their order is layout's
job. Placing runs in logical order painted `<b>العربية الغامقة</b>` in an
English line left to right; every engine paints it right to left.

- `src/bidi.ts` is UAX #9: levels for the whole PARAGRAPH (X1–X10, W1–W7,
  N0–N2, I1–I2), then L1 and L2 per line. Levels are paragraph-wide because a
  neutral or number at a soft wrap takes its type from the other line.
  Bidi_Class comes from General_Category + Script plus explicit weak/neutral
  tables (JS regex has no `\p{Bidi_Class}`). The paragraph level is the
  block's CSS `direction`, not P2/P3.
- CSS reaches it as control characters (`BidiTextBuilder`, CSS Writing Modes
  §2.4.2): inline `unicode-bidi: isolate/embed/*-override` wraps its text in
  RLI/LRI…PDI, RLE/LRE…PDF, RLO/LRO…PDF. A forced break is a paragraph
  separator (Blink feeds `<br>` to ICU as U+000A); an atomic inline is U+FFFC.
  `[dir]` computes `unicode-bidi: isolate` and `<bdo>` `isolate-override`,
  measured in Blink and WebKit. `dir="auto"` takes the direction of the first
  strong character (HTML auto directionality; skipping `[dir]`/`<bdi>`
  descendants), so `<p dir="auto">שלום world</p>` is an RTL, right-aligned
  paragraph.
- Paint direction is the bidi LEVEL's, never the inherited CSS `direction`:
  every emitted run gets `withDirection(level parity)`. `<span
  style="direction:rtl">` over LTR words (unicode-bidi: normal) reorders
  nothing, and painting those words right-anchored drew them a run-width left. An RTL override is still reversed in
  `collectTextRuns` and painted LTR, so it enters as an LTR override.
- Each line is cut into LEVEL-UNIFORM pieces, ordered by L2, and painted in
  the direction of the level. Inside such a piece, Canvas's own bidi pass
  agrees with ours (mirroring and shaping stay Canvas's). Adjacent pieces of
  one non-zero level and one paint merge into one run whose width is the sum
  of the flow advances. Level-0 words are never merged: LTR stays
  word-granular.
- Padding markers are not characters. Content is reordered without them;
  then each box's open marker (padding-LEFT) goes before its leftmost piece
  and the close marker after its rightmost. Riding a neighbour's level moved
  the padding inside `<code>render()</code>` in Arabic.
- Nodes are placed left to right, then EMITTED in logical order (`emitKeys`).
  `layoutRoot` keeps document order, and the geometry oracle depends on it.
- `CANVAS_BIDI_LINE` (engine flag, `!IS_SAFARI`): a line in ONE paint, whose
  levels Canvas would resolve the same from the line text alone, stays ONE
  run in the paragraph direction. Canvas then shapes the whole line as the
  layout does. In Blink that is exact: every token is at dx 0 against the DOM.
  Per-word placement lost up to 0.5px of space kerning (Playfair, +2.6% on
  `Mixed LTR and RTL@Playfair`). WebKit must not use it: the same single-run
  lines scored 6–16% against its DOM and 0.00 once split. Gecko keeps the
  single run it always had; this is unmeasured, because Firefox cannot run
  here.
- Text-on-path (`src/path`) uses the same module: levels over all segments,
  shaped runs cut at level changes and at neutrals, L2 over the placements.
  The old per-segment reversal put a second RTL span on the wrong side and
  reversed Latin inside `dir=rtl`.

Gates: `tests/node/bidi.test.ts` (algorithm), `Bidi visual order` in
`tests/node/layout-logic.test.ts`, `tests/bidi-order-parity.test.ts` (run
order and extent against per-character DOM Range rects; Chromium and WebKit
lanes), `tests/path/glyph-layout.test.ts`, and the geometry oracle's
visual-order count (0 in both lanes).

### Text measurement
- **One measuring primitive.** Every layout measurement goes through the
  call's `Measurer` (layout.ts): `m.width(m.stateOf(style), text)` (cached) or
  `m.measureText(state, text)` (uncached: one-off strings, ink metrics). It writes
  font, `fontKerning` and `letterSpacing` TOGETHER, skipping what it last
  wrote, and its constructor zeroes a stray `ctx.wordSpacing`. Never set
  those on the ctx by hand in layout code: a site that set only the font
  measured under the previous run's letter-spacing or kerning and kept
  overflowing lines (`Measuring state` in `tests/node/layout-logic.test.ts`).
  Layout functions reach the call's measurer as `session.measurer`; leaf
  helpers take it as `m`. A measurer re-writes all of its state when another
  writer wrote a ctx since its last measurement (`claimCtx`, a numeric
  token shared with `PaintState`): a nested `layout()` or `tabStopMetrics`
  may have moved the font under it. `PaintState` forgets its font, kerning
  and spacing the same way, so `paintBounds` and paint measure right when
  the caller's `measureText` runs a nested `layout()`. One token for every
  ctx costs a redundant re-write when two contexts interleave (a shadow
  mask beside the destination), never a wrong width.
- **Paint writes its whole text state too.** `PaintState` (paint-state.ts)
  assigns `letterSpacing` and `wordSpacing` even at 0: `render({ ctx })`
  paints on the ctx layout just measured with, and a 0px run used to take the
  last-measured run's spacing. Gated in `tests/node/determinism.test.ts`.
- **Per-call font state.** The canvas font string, ascent/descent, line
  height, leaded box and tab stops are derived once per style object per call
  (`m.metrics` / `m.lineHeight` / `m.leadedBox` / `m.tabStops`), held in the
  measurer, never on the style. Widths are cached per interned
  (font, kerning, letter-spacing) state. Widths and font state do not survive
  the call — the caller's ctx is the oracle and fonts load between calls, and
  that includes DOM-probed line heights. Font metrics (font string →
  ascent/descent) go into a table each call creates and hands its measurer
  as a constructor argument; it outlives the call only on its RESULT
  (`layoutFontMetrics`, keyed by `layoutRoot` or the text-on-path result),
  where paint reads decoration ascents and descents (`PaintState.fontBox`;
  text-on-path records each decoration declarer's metrics while laying
  out). So a result's decorations sit on the metrics it was laid out with,
  whatever a later call measured. The public `getFontMetrics` measures on
  the ctx it is given, every call. `buildCanvasFont` is not memoized: callers keep the
  string per style. Code that derives styles (min-content's `overflow-wrap` neutralizing)
  makes one copy per source style, not per word, or every copy rebuilds its
  font state.
- **Bounded cumulative context.** A word's width is `w(context + word) -
  w(context)`, never the word alone: a plain per-word sum loses the kerning
  across the space (Chromium: 3.5px over a 2,286px Arial run). The context is
  the run so far, but restarts at the last word once it passes
  `MEASURE_CONTEXT` (32) UTF-16 units; `splitSegment`'s CJK/break-word
  split restarts at the last character the same way. The whole-run prefix it
  replaces was quadratic (2000 words → 25.7M measured characters). 32 is the
  smallest window that moved no width of the all-font 1px wrap sweep against
  the whole-run context in Chromium and WebKit; 16 and below moved RTL and
  fallback-font lines (Arabic with digits, Hebrew in Merriweather). Restart at
  a word, never at a bare space: a lone `' '` measures in the primary font,
  while between two fallback-font words the engine sets it in the fallback.
  An open bracket holds the restart back to the word with the nearest
  letter before the opener (`contextStart`, up to 256 units): a bracket pair's
  direction and glyphs come from that letter (UBA N0/W7), and cutting it off
  moved a wrap in `Numbers and currency in RTL` (Lobster). With that, the
  all-font Chromium 1px sweep matches the whole-run context exactly; glyph x
  still moves by float noise (up to ~5e-3px on the pinned fonts).
- **Knife-edge re-measure, over the edge only.** When a candidate line
  overflows by under 1px and its glyphs share one measuring state,
  `knifeEdgeOverflows` re-measures it as one string and that decides (0.02px
  overflow tolerance). A space in another state keeps its own width
  (`<b style="font-size:.7em"> </b>` measured at the line's size reads
  wider). Mixed-state and tab lines trust the sum. A sum UNDER the edge is
  trusted too: re-measuring in both directions was tried and moved wraps both
  ways across the 1px sweeps. A review's DOM sweep traced the losses to the
  one string dropping the last glyph's kern against the space after it (Blink
  keeps it: the space hangs) and the kern carried across a soft-hyphen/ZWSP
  break. Modelling those line ends is
  fidelity work with its own sweep, not a measurement change.
- `fontKerning` is `'none'` only for `font-kerning: none`, else `'normal'`
- `ctx.letterSpacing` — use native property, not manual per-character rendering
- Cross-font boundaries still accumulate errors — inherent canvas API limitation
- **Kinsoku (CJK punctuation glue)**: a line never STARTS with a fullwidth
  closer/stop (`。、，！？：；・）` + closing curly quote `”`, plus the Myanmar
  `၊-၏` and Khmer `។-៖ ៘-៚` section signs) and never ENDS with an opener
  (`「（` etc.) — all measured against Chrome DOM with `水×5 <char> 水×7`
  probes. Both live in `TRAILING_PUNCT`/`OPENING_PUNCT` (layout.ts);
  preparing turns them into segment flags. `breakBefore` applies the closers
  and `headGlueWidth` the openers, per piece. Small kana and `ー` are deliberately NOT glued: Chrome's default `line-break: auto` breaks before
  them freely (measured; adding them would CREATE divergence).
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

## Commands
- `npm run dev` — demo page with side-by-side comparison
- `npm test` — vitest in Chromium, then the Node suites (`npm run test:node`)
- `npm run test:firefox` — vitest in Firefox (own baselines)
- `npm run test:webkit` — full WebKit suite (own baselines; not branded Safari)
- `npm run test:safari-native` — manual visible Safari canaries through safaridriver (non-core)
- `npm run test:cross-browser:record` — record Chrome canvas layout as reference
- `npm run test:cross-browser:firefox` — compare Firefox canvas layout vs Chrome reference
- `npm run test:cross-browser:webkit` — compare WebKit canvas layout vs Chrome reference
- `npm run test:stress` — layout width sweep stress test
- `npm run build` — TypeScript compilation
