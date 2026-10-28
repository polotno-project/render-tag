# render-tag

HTML rich text rendered onto a canvas with the pure 2D API. `README.md` holds
the public API, the PDF adapter contract and the design decisions
(Chrome-first, identical output in every browser). Each engine rule lives in
`src/engine.ts` with its measured numbers and the suite that gates it; each
test suite's header explains what it records and how to run it.

## Architecture

```
HTML string + CSS → parseHTML (DOMParser) → resolveStylesFromCSS (pure CSS parser + cascade)
→ buildLayoutTree (canvas measureText) → renderNode (canvas fillText/fillRect)
```

- **`render()` is synchronous**: no font loading; the caller loads fonts first.
- **Layout phases** (`src/layout.ts` is the entry, `buildLayoutTree`; phases in
  `src/layout/`): `session.ts` (the call's state, `Measurer`, engine
  line-height rules, the deliberate module state), `util.ts` (helpers more
  than one phase reads), `segment.ts` (runs, segments and flags,
  CJK/emoji/kinsoku), `prepare.ts` (`preparedInline` and intrinsic sizes),
  `flow.ts` (the line breaker, clamp), `emit.ts` (bidi reordering, lines to
  nodes), `flex.ts`, `block.ts` (margin collapsing, block/table/flex layout,
  list marker). Imports point only DOWN that order: a helper two phases need
  goes in `util.ts` or `session.ts`, never into a value import cycle.
- **Layout is reentrant: one `LayoutSession` per `buildLayoutTree` call**,
  threaded down as `session`. It owns the call's `Measurer`, debug callback,
  lines, min/max-content caches, anonymous flex items and prepared inline
  content. Never add a module-level `let` or cache to layout; put it on the
  session (`tests/node/reentrancy.test.ts`). The deliberate module state:
  `layoutFontMetrics` (a WeakMap keyed by results; a run's line top is a
  symbol property, `LINE_TOP`, like `RUN_SEAM`), the `claimCtx` writer token
  (a number, holds no reference), and the stateless `Intl.Segmenter`s. Layout
  never touches the DOM; the one canvas it makes is `Measurer.inkBox`'s
  scratch. `paintBounds` and `drawLayout` are reentrant too, and a result
  paints the same after a later `layout()` on a ctx with other font metrics.
  A kept result never pins the caller's ctx (`lazyPaintBounds`,
  `tests/node/memory.test.ts`).
- **Inline content: prepare once per call, flow per pass, then emit.**
  `preparedInline` segments and measures an inline formatting context ONCE
  per call into a `PreparedInline` (columns of segment text, width and flags,
  plus one `SegmentRefs` per run). Intrinsic sizing keeps it on the session;
  the layout takes it off (`takePreparedInline`). `flowLines` is the one line
  breaker: min-content at 0, max-content at Infinity, layout at the used
  width, over the same `PreparedInline`; never give intrinsic sizes their
  own break rules. Min-content differs only in `LineFlow.wordBreaking`
  ignoring `overflow-wrap: break-word`; the first line carries `text-indent`
  in every pass (a percentage one at 0). A flow never writes to the prepared content:
  what a pass cuts is a piece in that pass's own `FlowItems`. Only the final
  flow's lines become `Word` objects. Prepared widths are intrinsic; atomic
  inline-blocks (`inlineBlocks`) and percentage-padding edges
  (`percentEdges`) are re-sized for the final flow only (`usedSegmentWidths`),
  which gives every nonempty atomic its inner layout. An atomic inline-block
  is U+FFFC for line breaking and bidi only; debug entries and
  `LayoutLine.text` show its content (`FlowItems.debugText`).
- **Each line-breaking rule has one home.** "May a line start here?" is
  `breakBefore`; run-boundary glue is decided at prepare time
  (`abutsWithoutBreak`, `SEG_NO_BREAK_BEFORE`); "may a line end here?" is
  `headGlueWidth`; how a too-wide word may break is `LineFlow.wordBreaking`.
  The other phases: `breakGluedChain`, `knifeEdgeOverflows`, `LineFlow`
  (commit, whitespace trim, soft hyphen, tab stops). `layoutInlineContent`
  runs `flowInlineLines` → `clampLines` → `emitLine` (`alignedLineStart`,
  `lineBoxExtent`, bidi, `emitInlineBackgrounds`, `emitLineText`). A new break
  or glue rule goes INTO these; never re-derive it at a call site.
- **Vector consumers exist** (README's PDF adapter contract,
  `tests/node/vector-shadows.test.ts`). Keep the public boundary
  Canvas-shaped: shadow images use `drawImage`; foreground retains drawing
  commands and per-paint opacity. Do not assume every `ctx` implements
  image/transform APIs. `renderShadows: false` omits both CSS and context
  shadows without buffers or those APIs.
- **Shadow scratch (`ScratchPool`, shadow.ts).** A canvas handed to the
  caller's `drawImage` is fresh and never reused or resized. Masks and
  shadows cast onto a pooled canvas are pooled per draw. Text shadows are
  cast in horizontal tiles. WebKit's blur shifts with image extent and
  offset, so keep off-surface displacement minimal, and WebKit drops the
  shadow of an off-surface source-rect `drawImage`, so always draw a pooled
  canvas whole (`tests/node/shadow-scratch.test.ts`).
- **A text-shadow mask records COVERAGE, not color** (`PaintState`
  `coverage`): transparent or translucent text casts a full shadow
  (`STROKE_CASTS_TEXT_SHADOW` decides whether the stroke casts too).
- **Paint state goes through `PaintState`** (`src/paint-state.ts`). It writes
  a property only when the value changes and never relies on `restore` (some
  proxies do not snapshot state). One `save`/`restore` pair per draw; use
  `ps.save()`/`ps.restore()` only for a transform or clip (values written
  inside are forgotten). Font, kerning and letter-spacing come from the
  helpers `Measurer` uses (`tests/node/paint-state.test.ts`).

## CSS resolver

`css-syntax.ts`, `css-selectors.ts`, `css-values.ts`, `css-validate.ts`,
`css-resolver.ts`, `parse.ts`.

- **One tokenizer** (`css-syntax.ts`, CSS Syntax 3) for `<style>` sheets AND
  `style=""`: strings, escapes, comments, `url()`, nested blocks, spec error
  recovery. `!important` is a flag; a leftover `!` drops the declaration.
- **Inline styles come from `getAttribute('style')`**, never
  `el.style.cssText` (the CSSOM re-serializes per engine and drops unknown
  properties). Shorthands are ours to expand (`expandShorthand`).
- **The rule index is the ONE cache that outlives a call.** Keyed by the
  exact css text, LRU-bounded, admitted on a sheet's second sighting; nothing
  in it reaches a result. Any cache that outlives a call must keep
  `tests/node/determinism.test.ts` green: add the test before the cache.
- **A `#text`/`<br>` node's `style` IS its parent element's object.** Nothing
  downstream may write to a style: copy it (`{ ...style, x }`). Style
  identity does not mean "same text node": layout flags the first piece of
  each measuring run (`startsMeasuredRun`) and Blink paint batching never
  merges across it (`tests/node/paint-runs.test.ts`). Private fields
  (`LINE_HEIGHT_MULTIPLIER`, `UNDERLINE_OFFSET_PCT`, `OVERFLOW_X`/`OVERFLOW_Y`,
  `BOX_SIZING`) are SYMBOL keys, assigned after the `defaultStyle()` literal.
- **Cascade order** (`cascadeOrder`): UA defaults (`TAG_DEFAULTS`) < `<font>`
  hints < sheet normal < `style=""` normal < sheet `!important` < `style=""`
  `!important`. `defaultStyle(parent)` initializes inherited fields, then
  `FONT_PROPERTIES` resolve first so em/ch/ex see the final font. CSS-wide
  keywords are handled once (`applyKeyword`, `PROPERTY_FIELDS`), never stored
  as strings.
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
  (`intrinsicStyle`, CSS Sizing 3 §5.2.1). `text-indent` and a flex
  container's `gap` are percentages of the box's OWN content width
  (`OWN_PERCENT_FIELDS`), re-resolved at the settled width. An inherited
  `text-indent` inherits the percentage (`inheritPercentages`). A stored
  basis (`PercentBasis`) keeps the measured ch/ex numbers, never the
  measuring callback.
- **`box-sizing`** decides which box `width`, `min-width`, `min-height` and
  `flex-basis` size; `borderBoxSize` / `contentBoxSize` are the one
  conversion. A border-box size never shrinks below padding + border.
  `height` is not supported.
- **Units** (`css-values.ts`): rem is the root's font-size (not `body`'s);
  viewport units are `layout()`'s `width` x `height` (no height → width;
  ignored on a path); ch/ex come from `Measurer.fontUnits` once per font per
  call (ex = ink ascent of `x`); without a ctx both are 0.5em.
- **Selectors are an allowlist** (`css-selectors.ts`): VALID but unsupported
  (`:has()`, `::before`, form states) never matches, that member only;
  INVALID drops the whole list (Selectors 4). Dynamic states never match.
  Never strip an unknown part and match the rest. `SelectorMatcher` caches
  per call: `~` and the descendant combinator memoize their answer per
  element, so deep nesting and long lists stay linear. Every table keyed by
  author text (tags, property names, keywords) is `nullProto`: `constructor`
  finds nothing.
- **Display defaults to `inline`**; only the HTML UA block list is block.
  `<wbr>` becomes `​`; `<q>` gets quote text nodes sharing its style.
- `parseHTML` lifts LEADING `<style>` blocks off as text before DOMParser.
  `<style media>` applies only for `all`/`screen`; media features are not
  evaluated; a `type` other than `text/css` drops it.

## Paint

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
  while `sameDecorationBand` holds (src/layout/util.ts).
- **Fragment geometry** — the paint spans the DECLARING element's fragment, not each
  word: `assignInlineFragmentBoxes` (per-line fragment box → `LayoutText.clip`/
  `.strokeImage`) in layout; `assignFragmentRanges` (natural-offset range) on path.
  Block declarers span their border box, threaded down `renderBox` at render time.
- **Precedence** (both renderers must agree): nearest declarer wins; an inherited clip
  paint shows only when the run's own fill is transparent; a transparent decoration
  over clip-painted text paints the band with the clip paint (never skip it);
  `background-clip:text` suppresses the box-background fillRect.

When touching this area, run `gradient-clip-inline-nested`,
`gradient-clip-descendants`, `gradient-stroke{,-inline}`, `solid-clip-text`,
`path/gradient-clip-parity`, `decoration-propagation`,
`decoration-offset-thickness` and `webkit-text-stroke`.

### Text decorations (`src/decoration.ts`)

- **One band per text fragment** (one text node's pieces, contiguous on one
  line), not per word or per declarer: dashes fit and waves keep phase across
  a fragment's spaces and restart at the next text node. `renderBox` groups
  with `sameTextFragment`; `paintFragment` paints underline/overline, glyphs,
  then line-through.
- **No decoration crosses into an atomic inline** (`ATOMIC_INLINE`, CSS Text
  Decoration 3 §2.1): the ancestor's band leaves a gap there.
- **The painter follows `ENGINE`.** Blink and WebKit shapes and positions are
  measured off the DOM raster; the formulas live in decoration.ts. Gecko is
  unmeasured. WebKit needs the device scale (`PaintState.deviceScale`, from
  `pixelRatio`). Text on a path paints the same bands (`fragmentBands`,
  `paintBand`) through a `Pen` that bends them along the glyph frames
  (`BentPen`, src/path/index.ts); a clip-painted band paints per glyph.

### Blink paint batching

Blink paints a plain Latin/Cyrillic/Greek text fragment with one `fillText`
per measured run, preserving shaping across spaces; layout stays word-based.
The batch is decided per FRAGMENT (`forEachFragment`): a run with
decorations, strokes, clip paints or justification, a complex script, Gecko
or WebKit does not batch. Text shadows are cast from the same batched run as
the foreground.

## Layout rules

### Margin collapsing (`layoutBlock`, `leadingStrut`, `collapsesThrough`)

CSS 2.1 §8.3.1, for EVERY block in normal flow — there is no tag allowlist.

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
- **A visible marker is content.** An empty `<li>` has the marker's line box
  (`MARKER_LINE_WITHOUT_CONTENT` for an `<li>` whose children all collapse
  through). `list-style-position: inside` is not supported.
- **What the resolver must hand layout**: `display: none` subtrees are
  dropped; a border whose style is `none`/`hidden` has width 0;
  `overflow-x`/`overflow-y` count like the shorthand (private `OVERFLOW_X` /
  `OVERFLOW_Y`); a percentage `min-height` computes to none.
- **The root holds its children's margins**, like the capture harness's
  `overflow:hidden` content div. min-height on a parent is an engine rule
  (`MIN_HEIGHT_END_MARGINS`).

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

- The memo (`session.minContent`/`maxContent`) holds CONTENT-box widths; a
  node's own margins, frame and width are added per question
  (`minimumContribution`/`maximumContribution`).
- Block children inside an inline-block are flattened into its one inline
  flow (known gap).
- Shrinking is weighted by `flex-shrink x base`, growing by `flex-grow` alone,
  both through `resolveFlexibleLengths` (CSS Flexbox §9.7) over OUTER
  (margin-box) widths. Each pass freezes items that landed under their
  automatic minimum (`min-width: auto` = min-content) and repeats; minima that
  do not fit overflow the container, as they do natively.
- Bare text beside an element in a flex container is an **anonymous flex
  item**: `flexItems` wraps it in a block box, once per text node, so sizing
  and layout ask about the same node (the caches are keyed by identity).
- Flex fixtures live in `loadFlexCases()`, not the pixel corpus: a pixel
  baseline cannot see a wrong column split (`tests/flex-parity.test.ts`).

### Line boxes and the baseline (`lineBaselineOffset`, `lineBoxExtent`)

A line box is the union of EVERY box on the line — the block strut, each run,
each `vertical-align`-shifted run, each inline-block. Each box brings its own
line-height and its own half-leading; the line takes `max(ascent - shift)` and
`max(descent + shift)`. Never collapse this back to one leading over the
line's max metrics: that is wrong on every mixed line.

- **The numbers are the ENGINE's**, measured off the DOM: used and percentage
  line-height, half-leading rounding, super/sub shifts. Each question has its
  own flag in `src/engine.ts` (UA detection, `ENGINE`). **Never gate one flag
  on another**: a test that did asserted Gecko's shift against Blink's in
  every engine except Chrome. A percentage `vertical-align` resolves against
  the EXACT line-height (`Measurer.computedLineHeight`).
- **Paint is not layout (Blink).** Blink keeps fractional layout but PAINTS
  each line box at a whole CSS pixel (line top `Math.round`, half up), with
  everything inside keeping its laid-out offset. `SNAPS_LINE_PAINT` and
  `paintLineSnap` model it at paint time only: `LayoutText.y` stays the
  fractional baseline; render adds `round(lineTop) - lineTop` to glyphs,
  decorations, shadows and `paintBounds`. The line top is kept off the public
  node (`LINE_TOP`); a hand-built node falls back to its baseline. Snap the
  line, never each run's baseline. Text in an inline-block snaps by its own
  inner line box.
- **`lineBaselineOffset` is the PUBLIC export**, not the flag: every renderer
  that places a baseline beside a render-tag canvas (`@polotno/svg-export`,
  the editor's list marker) calls it, so the rule has one home. It takes the
  COMPUTED line-height and applies the engine's LENGTH rule plus each
  engine's half-leading rounding. For a NUMBER line-height the caller passes
  the used value (Blink: `floor(round64(fontSize) × n × 64) / 64`; WebKit
  floors the font-size to 1/64px first).
- `vertical-align: text-top` / `text-bottom` align the box's LEADED edge with
  the parent's CONTENT-area edge (bare ascent/descent, no leading). `middle`
  centres the LEADED box too; the x-height is approximated as 0.5em.
- **Block strut**: every line box has a minimum height AND a baseline from the
  block's OWN font, even when all inline content on the line is smaller.
  `flowInlineLines` seeds `flowLines` (line height) and `lineBoxExtent` seeds
  the per-line ascent/descent (baseline) from `node.style`. Don't reset those
  seeds to 0 in a refactor.

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
- Nodes are placed left to right, then EMITTED in logical order (`emitKeys`).
- `CANVAS_BIDI_LINE`: a line in ONE paint whose levels Canvas resolves the
  same from the line text stays ONE run, so Canvas shapes it as the layout
  does. Text-on-path uses the same module.

### Text measurement

- **One measuring primitive.** Every layout measurement goes through the
  call's `Measurer`: `m.width(m.stateOf(style), text)` (cached) or
  `m.measureText(state, text)` (uncached). It writes font, `fontKerning` and
  `letterSpacing` TOGETHER and zeroes a stray `ctx.wordSpacing`. Never set
  those on the ctx by hand in layout code. Layout reaches it as
  `session.measurer`; leaf helpers take `m`.
- **Ink extents come from `m.inkBox(state, text)`**, never raw
  `actualBoundingBox*`: WebKit's box always holds the origin and the advance
  and Gecko's sits ~1px off, so outside Blink it paints the text on a
  supersampled scratch canvas and reads the pixels (`INK_BOX_FROM_PAINT`,
  `tests/list-marker-geometry.test.ts`). `ex` still reads the ascent of `x`
  from `measureText`: WebKit reports an ink top above the baseline right.
- **`claimCtx`**: a numeric writer token shared by `Measurer` and
  `PaintState`. A writer re-writes its whole state when another wrote the ctx
  since its last use, so a nested `layout()` cannot move the font under it.
  Paint writes its whole text state too (`letterSpacing` and `wordSpacing`
  even at 0).
- **Per-call font state.** Font string, metrics, line height, leaded box and
  tab stops are derived once per style per call and held in the measurer,
  never on the style. Nothing measured survives the call (fonts load between
  calls), except each result's font metrics (`layoutFontMetrics`) and the
  ch/ex a stored percentage basis re-resolves with.
- **Measured in context.** A word's width is `w(context + word) -
  w(context)`, keeping kerning across the space. Simple-script text restarts
  the context at every word; other text after `MEASURE_CONTEXT` (32) UTF-16
  units, at the last word, never at a bare space (a lone space measures in
  the primary font), and an open bracket holds it back to the nearest letter
  (`contextStart`; UBA N0/W7).
- **Knife-edge re-measure, over the edge only.** A line overflowing by under
  1px in one measuring state is re-measured as one string
  (`knifeEdgeOverflows`). A sum under the edge is trusted: re-measuring both
  ways moved wraps both ways.
- **The fit test is on the engine's layout grid** (`LAYOUT_UNIT_LINE_FIT`,
  `LineFlow.budget`, `layoutUnit`, `LINE_FIT_TOLERANCE`). A global fit
  tolerance caused many real line-breaking regressions and was rejected.
- `fontKerning` is `'none'` only for `font-kerning: none`, else `'normal'`;
  letter-spacing uses the native `ctx.letterSpacing`, never per-character
  rendering.
- **Kinsoku (CJK punctuation glue)**: a line never STARTS with a fullwidth
  closer/stop (`。、，！？：；・）` + closing curly quote `”`, plus the Myanmar
  `၊-၏` and Khmer `។-៖ ៘-៚` section signs) and never ENDS with an opener
  (`「（` etc.), measured against Chrome DOM with `水×5 <char> 水×7` probes.
  Both live in `TRAILING_PUNCT`/`OPENING_PUNCT` (src/layout/segment.ts) and
  become segment flags; `breakBefore` applies the closers and `headGlueWidth`
  the openers. Small kana and `ー` are deliberately NOT glued: Chrome's
  default `line-break: auto` breaks before them freely.

## Testing

### The oracle

Scores compare render-tag with a screenshot of the same fixture in the same
engine's own DOM (Playwright pages; Firefox without `omitBackground`, both
images normalized onto white). Fonts are vendored under `tests/fonts/`
(`npm run vendor:fonts`; nothing contacts Google Fonts or depends on system
fallback). Native reference PNGs are cached in
`node_modules/.cache/render-tag/native-dom/`; `npm run
test:clear-native-cache` forces a cold run. Capture and font-pruning details
are in `tests/helpers/compare.ts` and `tests/helpers/native-dom-command.ts`.
Playwright WebKit is the WebKit engine, not branded Safari; never label
WebKit results as Safari.

Line membership comes from `extractDomLines`. **Take the LAST rect, never the
first**: at a break Chrome and WebKit emit a spurious leading rect at the end
of the PREVIOUS line.

### Lanes

One `vitest.config.ts`, four projects: `node`, `chromium`, `firefox`,
`webkit`, selected with `--project` (scripts in `package.json`). A browser
project's `include` is its lane: what that engine gates. A test file named
on the command line joins every browser lane for that run, so
`--project <x> <file>` runs any file in any engine. Chrome-first suites run
in the Chromium lane only; the decoration suites run in Chromium and WebKit
(Gecko unmeasured). `npm test` (Node + Chromium), `npm run test:webkit` and
`npm run test:firefox` without portable mode are the release bar. Generated
reports and local recordings go to the git-ignored `tests/.out/`
(`reportPath`). Shared helpers live in `tests/helpers/`: the corpus
(`loadCorpus`), `mockCtx`, `recording-ctx`, `pixels.ts`; reuse them.

### Portable mode (CI)

The recorded contracts are environment-pinned (font rasterization differs per
OS and runner image), so GitHub Actions runs every lane with
`RENDER_TAG_PORTABLE=1` (`tests/helpers/portable-mode.ts`). Self-comparing
gates stay at full strictness; portable mode skips only: the pixel
score/wrap contract and key-set coverage in `render.test.ts` (cases still
render), `cross-browser.compare.test.ts` (its Chrome reference is a local
recording in `tests/.out/`), `wrap-fuzz`'s signature set (overflow still gates),
`native-dom-oracle`'s ≤1-pixel constant (a <2% sanity bound instead),
`decoration-geometry`'s system-serif rows, and computed-style's ` ex › `
rows. **Never "fix" red CI by re-recording baselines on a runner**: either
the change is wrong or a gate is environment-pinned and belongs behind
`PORTABLE_GATES_ONLY`.

### Recorded contracts

- **Any unrecorded change fails**: a regression, an improvement, a wrap
  change or a key-set change. Pixel baselines (`tests/baselines.<browser>.json`,
  `{ score, wrap }` per case × default font + 5 fonts) fail on a score move
  over 0.01% either way and on any change of line membership.
- **Tests never update baselines.** Re-record deliberately, after verifying
  the change, with `npm run update -- --project <browser> <files>`; each file
  merges its own keys into its contract for that engine. Pixel baselines:
  `tests/render.test.ts tests/render.fonts.test.ts`. The Chrome reference for
  the cross-browser compare: `--project chromium
  tests/cross-browser.compare.test.ts`. The five DOM-parity suites
  (margin-collapse, line-baseline, line-box, box-model, flex) share
  `tests/engine-divergences.json` and are named together.
- **Ratchets** list today's known divergences: a new one fails, and so does a
  listed one that now passes (the list only shrinks). Firefox entries are
  keyed per platform (`firefox` = the ubuntu CI runner, `firefox-darwin` =
  the Mac).
- Bullet discs are Chrome-sized in every engine (`block.ts`), a deliberate
  Chrome-first residual in the Firefox and WebKit baselines. The corpus reset
  hides `::marker`, so `Large display list markers` is the one pixel case with
  markers; `list-marker-geometry` gates the disc itself in every lane.

### Node tier-0 (in `npm test`, full strictness in CI)

- `tests/node/layout-logic.test.ts` (mocked `measureText`, `layout({ html })`
  via linkedom; Node takes the Blink branch). A case that needs real font
  metrics or the DOM belongs in a browser suite. **TDD**: write the failing
  test, see it fail, fix, see it pass, then run `npm test`.
- `determinism.test.ts` and `perf-counters.test.ts` run on
  `tests/helpers/recording-ctx.ts`. perf-counters is a ratchet of exact work
  counts (`tests/perf-counters-baseline.json`): UP fails as a regression,
  DOWN fails until promoted with `npm run update -- --project node
  tests/node/perf-counters.test.ts`.

### Maintainer tools (not gates; each header says how to run it)

`wrap-sweep` (full corpus at 1px, the milestone wrap gate: band width is the
diagnosis), `wrap-debug`, `geometry-oracle`, `engine-probe` (also the
`Engine probe` workflow for Gecko on ubuntu), `wrap-fuzz` (in `npm test`),
`stress` (10px width sweep, run it for wrapping changes), `perf`,
`list-marker-parity`, the Safari canaries (`npm run test:safari-native`).
When triaging a wrap divergence: a different line count is a break-logic
bug; same count with shifted membership is a boundary (knife-edge)
divergence.

## Code conventions

Comments state only short "why" facts (measured engine quirks, spec rules);
no history narration.

## Releasing

1. Add a `CHANGELOG.md` entry at the top for the new version: only
   interesting, user-visible changes since the previous version, one line
   each, plain words. Skip internal test/infra work. Credit external
   contributors and link fixed issues/PRs.
2. `npm version patch --no-git-tag-version`; commit the bump + changelog
   as `render-tag: vX.Y.Z`, then tag that commit annotated, as
   `npm version` would: `git tag -a vX.Y.Z -m X.Y.Z`
3. `git push origin master vX.Y.Z`, `npm run build`, `npm publish` from
   that commit with a clean tree (npm records it as the version's
   `gitHead`; every tag matches it)
