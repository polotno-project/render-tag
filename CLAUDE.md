# render-tag

HTML rich text rendered onto a canvas with the pure 2D API. `README.md` holds
the public API, the PDF adapter contract and the design decisions
(Chrome-first, identical output in every browser). Each engine rule lives in
`src/engine.ts` with its measured numbers and the suite that gates it; each
test file's header says what it records and how to run it. The code is the
map: this file holds only what no single file tells you.

## Invariants

- **One home per rule.** A layout, measuring or paint rule lives in one
  function; a new case goes into it, never re-derived at a call site. An
  engine difference is a flag in `src/engine.ts` answering one measured
  question; never gate one flag on another.
- **Layout is reentrant.** Per-call state lives on the `LayoutSession`, never
  in a module-level `let` or cache (`tests/node/reentrancy.test.ts`). The CSS
  rule index is the one cache that outlives a call; any such cache needs
  `tests/node/determinism.test.ts` first. A kept result never pins the
  caller's ctx (`tests/node/memory.test.ts`).
- **Styles are shared and read-only.** A `#text` node's `style` IS its parent
  element's object: copy it (`{ ...style, x }`). Style identity does not mean
  "same text node" (`startsMeasuredRun`).
- **Measure through the call's `Measurer`, paint through `PaintState`.** Font,
  kerning, letter- and word-spacing are never set on the ctx by hand.
  `PaintState` writes only on change and never relies on `restore` (some
  proxies do not snapshot state).
- **Keep the public boundary Canvas-shaped.** Vector consumers draw through it
  (README's PDF adapter, Polotno's SVG and PDF export), so a ctx may lack image
  and transform APIs; `renderShadows: false` needs neither. Public helpers such
  as `lineBaselineOffset` are called from `@polotno/svg-export`: change them as
  public API.
- **Paint that reaches descendants by painting rules, not inheritance**
  (`background-clip: text`, `--rt-text-stroke-image`, decoration bands) is
  stamped from its declaring element. Re-deriving it from a run's own style is
  the recurring bug: the paint vanishes one inline deeper
  (`<s clip><u>text</u></s>`). When touching it, run
  `gradient-clip-inline-nested`, `gradient-clip-descendants`,
  `gradient-stroke{,-inline}`, `solid-clip-text`, `path/gradient-clip-parity`,
  `decoration-propagation`, `decoration-offset-thickness` and
  `webkit-text-stroke`.
- **Text-unit stamps only when `session.units`**: more run shapes made a plain
  `drawLayout` ~20% slower.
- **CSS**: an invalid value is ignored, never written as 0; an unsupported
  selector matches nothing, so never strip the unknown part and match the rest.
  Inline styles come from `getAttribute('style')`, never `el.style.cssText`
  (each engine re-serializes it).

## Testing

- **The oracle is each engine's own DOM**: scores compare render-tag with a
  screenshot of the same fixture in that engine, with fonts vendored under
  `tests/fonts/`. Prove engine behaviour against that DOM, not by reasoning.
  Playwright WebKit is WebKit, not Safari; never label its results Safari.
- **Lanes**: `npm test` (Node + Chromium), `npm run test:webkit` and
  `npm run test:firefox` are the release bar. A browser project's `include` in
  `vitest.config.ts` is what that engine gates; `--project <x> <file>` runs any
  file in any engine. Reports go to the git-ignored `tests/.out/`.
- **Recorded contracts fail on ANY unrecorded change**, improvements included:
  pixel baselines (a score move over 0.01% or any change of line membership),
  the DOM-parity ratchets in `tests/engine-divergences.json` (a listed case
  that now passes fails too; Firefox keys are per platform: `firefox` is CI's
  ubuntu, `firefox-darwin` the Mac) and `perf-counters`. Tests never update
  them: verify the change, then re-record deliberately with
  `npm run update -- --project <browser> <files>`.
- **CI runs with `RENDER_TAG_PORTABLE=1`**, which skips environment-pinned
  gates (`tests/helpers/portable-mode.ts`). Never fix red CI by re-recording on
  a runner: either the change is wrong or the gate belongs behind
  `PORTABLE_GATES_ONLY`.
- **TDD in the Node tier**: write the failing case in
  `tests/node/layout-logic.test.ts` (mocked `measureText`; Node takes the Blink
  branch), see it fail, fix, see it pass, then run `npm test`. A case that
  needs real font metrics or the DOM belongs in a browser suite.
- **Wrap triage**: a different line count is a break-logic bug; the same count
  with shifted membership is a knife-edge boundary. Run `stress` for any
  wrapping change.

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
