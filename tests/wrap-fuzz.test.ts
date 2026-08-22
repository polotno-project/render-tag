import { describe, it, expect } from 'vitest';
import {
  compareWrapping,
  prepareComparisonFonts,
  warmNativeLayout,
} from './helpers/compare.ts';
import { render } from '../src/index.ts';
import baseline from './wrap-fuzz-baseline.json';
import { loadMultiFontCss } from './helpers/test-cases.ts';

/**
 * Generative differential wrap fuzzer — a REGRESSION GATE in `npm test`.
 *
 * Where the curated baselines test "cases someone thought to write down", this
 * SYNTHESIZES rich-text HTML variations and sweeps them through the same
 * ground-truth oracle (compareWrapping: canvas line-grouping vs. real DOM).
 * It targets the input space that produced real bugs — a word split across
 * inline-run boundaries (font-size / weight / style / letter-spacing changes
 * mid-word) under different text-align / white-space / overflow-wrap.
 *
 * The seeded PRNG makes the generated corpus deterministic, so this can fail
 * the build. It asserts two things:
 *   • HARD: zero box-overflow (a canvas line wider than its container) — the
 *     clear render-bug class; robust (tens of px, never sub-pixel).
 *   • No NEW structural (line-count) divergence CLASS beyond the signatures in
 *     wrap-fuzz-baseline.json — same philosophy as the pixel baselines.
 * It also writes tests/wrap-report.fuzz-<browser>.json for triage.
 *
 * Run alone: npx vitest run tests/wrap-fuzz.test.ts. Tune NUM_CASES / SEED.
 */
import { browserName } from './helpers/browser-name.ts';

// ─── Config ────────────────────────────────────────────────────────────────
const NUM_CASES = 600;
const SEED = 0x9e3779b9;
const WIDTH_STEPS = 12;

// ─── Seeded PRNG (mulberry32) — deterministic, reproducible failures ─────────
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const ri = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// ─── Generation alphabet ─────────────────────────────────────────────────────
const WORDS = [
  'Summer', 'Night', 'Music', 'Experience', 'wonderful', 'the', 'a', 'Glow',
  'Festival', 'Live', 'internationalization', 'well-being', 'Vibes', '2024',
  'and', 'celebrate', 'Extraordinary', 'Joy', 'Moonlight', 'Dance',
];
const TAGS = ['span', 'strong', 'em', 'b', 'i'];
const MUTATIONS: { kind: string; style: string }[] = [
  { kind: 'none', style: '' },
  { kind: 'size-up', style: 'font-size: 1.5em;' },
  { kind: 'size-up2', style: 'font-size: 1.9em;' },
  { kind: 'size-down', style: 'font-size: 0.6em;' },
  { kind: 'bold', style: 'font-weight: 700;' },
  { kind: 'italic', style: 'font-style: italic;' },
  { kind: 'ls-pos', style: 'letter-spacing: 3px;' },
  { kind: 'ls-neg', style: 'letter-spacing: -1px;' },
  { kind: 'super', style: 'font-size: 0.7em; vertical-align: super;' },
];
const ALIGNS = ['left', 'center', 'right'];
const WHITES = ['normal', 'pre-wrap'];
const OWRAPS = ['normal', 'break-word'];
const BASE_SIZES = [40, 70];

interface GenCase {
  html: string;
  contentCss: string;
  sig: string;
  align: string;
  ws: string;
  ow: string;
  baseSize: number;
  mutationKinds: string[];
}

function generate(rng: () => number): GenCase {
  const n = ri(rng, 3, 7);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pick(rng, WORDS));
  const text = words.join(' ');

  // Inject 1–2 inline wrappers over character ranges (frequently mid-word).
  const numMut = rng() < 0.65 ? 1 : 2;
  const ranges: { s: number; e: number; tag: string; mut: { kind: string; style: string } }[] = [];
  for (let i = 0; i < numMut; i++) {
    const s = ri(rng, 0, text.length - 2);
    const e = ri(rng, s + 1, Math.min(text.length, s + ri(rng, 1, 12)));
    ranges.push({ s, e, tag: pick(rng, TAGS), mut: pick(rng, MUTATIONS) });
  }
  // Keep ranges disjoint; apply right-to-left so indices stay valid.
  ranges.sort((a, b) => a.s - b.s);
  const disjoint: typeof ranges = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.s >= lastEnd) { disjoint.push(r); lastEnd = r.e; }
  }
  let html = text;
  for (const r of [...disjoint].sort((a, b) => b.s - a.s)) {
    const open = r.mut.style ? `<${r.tag} style="${r.mut.style}">` : `<${r.tag}>`;
    html = html.slice(0, r.s) + open + html.slice(r.s, r.e) + `</${r.tag}>` + html.slice(r.e);
  }

  const align = pick(rng, ALIGNS);
  const ws = pick(rng, WHITES);
  const ow = pick(rng, OWRAPS);
  const baseSize = pick(rng, BASE_SIZES);
  const contentCss =
    `font-size: ${baseSize}px; font-family: 'Roboto', sans-serif; line-height: 1.2; ` +
    `text-align: ${align}; white-space: ${ws}; overflow-wrap: ${ow};`;
  const mutationKinds = [...new Set(disjoint.map((r) => r.mut.kind))].sort();
  const sig = `${align}|${ws}|${ow}|sz${baseSize}|${mutationKinds.join(',')}`;
  return { html: `<div style="${contentCss}">${html}</div>`, contentCss, sig, align, ws, ow, baseSize, mutationKinds };
}

// ─── Report types ─────────────────────────────────────────────────────────
interface Finding {
  kind: 'linecount' | 'overflow';
  sig: string;
  html: string;
  width: number;
  canvasLines: number;
  domLines: number;
  overflowPx?: number;
  sample: { i: number; canvas: string; dom: string }[];
}

describe('Wrap fuzz (generative differential)', () => {
  it('no box-overflow and no new wrap-divergence class beyond the baseline', async () => {
    const fontCss = await loadMultiFontCss();
    await prepareComparisonFonts('', fontCss);

    const rng = makeRng(SEED);
    const findings: Finding[] = [];
    let totalRuns = 0;
    const bySig = new Map<string, { linecount: number; overflow: number }>();
    const seenSig = new Set<string>(); // first reproducer per (sig, kind)

    // Fixed width ladder. The canvas .lines layout is independent of canvas
    // height, so we render onto a tiny canvas (H) — only the layout matters.
    const H = 120;
    const WIDTHS = [90, 130, 180, 240, 320, 420, 540, 680, 840, 1040, 1300, 1600].slice(0, WIDTH_STEPS);

    for (let c = 0; c < NUM_CASES; c++) {
      const gc = generate(rng);
      // The first native layout of a fixture finalizes lazy variable-font
      // shaping, so without this the FIRST width in the ladder is the only one
      // measured against a cold font backend — and its divergence gets
      // promoted into wrap-fuzz-baseline.json as a "known residual".
      warmNativeLayout(gc.html, '', WIDTHS[0]);
      for (const width of WIDTHS) {
        totalRuns++;
        // 1) Structural line-grouping divergence vs DOM.
        let res;
        try {
          res = compareWrapping(gc.html, '', width, H);
        } catch { continue; }
        if (!res.wrappingMatch && res.canvasLineCount !== res.domLineCount) {
          const rec = bySig.get(gc.sig) || { linecount: 0, overflow: 0 };
          rec.linecount++; bySig.set(gc.sig, rec);
          const key = `${gc.sig}#linecount`;
          if (!seenSig.has(key)) {
            seenSig.add(key);
            findings.push({
              kind: 'linecount', sig: gc.sig, html: gc.html, width,
              canvasLines: res.canvasLineCount, domLines: res.domLineCount,
              sample: res.differentLines.slice(0, 3).map((d) => ({ i: d.lineIndex, canvas: d.canvas, dom: d.dom })),
            });
          }
        }
        // 2) Canvas line overflowing its own container. Only a bug under
        // overflow-wrap:break-word (where nothing should overflow). With
        // overflow-wrap:normal a long unbreakable word overflowing is correct
        // CSS, so we don't flag it. Skip the narrowest widths where a single
        // glyph can legitimately exceed the box.
        try {
          const r = render({ html: gc.html, width, height: H });
          let worst = 0;
          for (const l of r.lines) worst = Math.max(worst, l.bounds.width - width);
          if (gc.ow === 'break-word' && width >= 180 && worst > 2.0) {
            const rec = bySig.get(gc.sig) || { linecount: 0, overflow: 0 };
            rec.overflow++; bySig.set(gc.sig, rec);
            const key = `${gc.sig}#overflow`;
            if (!seenSig.has(key)) {
              seenSig.add(key);
              findings.push({
                kind: 'overflow', sig: gc.sig, html: gc.html, width,
                canvasLines: r.lines.length, domLines: -1, overflowPx: Math.round(worst),
                sample: r.lines.filter((l) => l.bounds.width - width > 1).slice(0, 3)
                  .map((l) => ({ i: 0, canvas: `${l.text} [w=${l.bounds.width.toFixed(0)}/${width}]`, dom: '' })),
              });
            }
          }
        } catch { /* ignore */ }
      }
    }

    const lc = findings.filter((f) => f.kind === 'linecount').length;
    const ov = findings.filter((f) => f.kind === 'overflow').length;
    console.log(`\n=== WRAP FUZZ [${browserName}] cases=${NUM_CASES} runs=${totalRuns} ===`);
    console.log(`Unique signatures with: line-count divergence=${lc} | overflow=${ov}`);
    console.log('\n-- top signatures (linecount / overflow instance counts) --');
    const sorted = [...bySig.entries()].sort((a, b) => (b[1].linecount + b[1].overflow) - (a[1].linecount + a[1].overflow));
    for (const [sig, rec] of sorted.slice(0, 25)) {
      console.log(`  lc=${String(rec.linecount).padStart(3)} ov=${String(rec.overflow).padStart(3)}  ${sig}`);
    }

    const report = JSON.stringify({
      browser: browserName, seed: SEED, numCases: NUM_CASES, totalRuns,
      uniqueLinecount: lc, uniqueOverflow: ov,
      bySig: Object.fromEntries(sorted.map(([s, r]) => [s, r])),
      findings,
    }, null, 2);
    const { commands } = await import('vitest/browser');
    const out = `tests/wrap-report.fuzz-${browserName}.json`;
    await commands.writeFile(out, report);
    console.log(`\nReport written to ${out}`);

    // ─── Regression gate ───────────────────────────────────────────────────
    // 1) HARD: no canvas line may overflow its container (the clear render bug
    //    class — e.g. the "last glyph outside the box" report). Robust: tens of
    //    px, never sub-pixel. This must always be zero.
    const overflows = findings.filter((f) => f.kind === 'overflow');
    expect(
      overflows.length,
      `Box-overflow regressions (${overflows.length}). A canvas line is wider than its container:\n` +
        overflows.slice(0, 8).map((f) => `  [${f.sig}] w${f.width} +${f.overflowPx}px  ${f.html}`).join('\n'),
    ).toBe(0);

    // 2) No NEW structural divergence CLASS beyond the committed baseline. Known
    //    residuals are recorded in wrap-fuzz-baseline.json (same philosophy as
    //    the pixel baselines — divergences are promoted deliberately). A new
    //    signature here means the fuzzer found a class we haven't triaged.
    const known: string[] | null = (baseline as Record<string, string[] | null>)[browserName] ?? null;
    if (known) {
      const knownSet = new Set(known);
      const newSigs = findings
        .filter((f) => f.kind === 'linecount' && !knownSet.has(f.sig));
      expect(
        newSigs.length,
        `NEW wrap divergence classes (${newSigs.length}) not in tests/wrap-fuzz-baseline.json[${browserName}]:\n` +
          newSigs.slice(0, 10).map((f) =>
            `  [${f.sig}] w${f.width} canvas=${f.canvasLines}/dom=${f.domLines}  ${f.html}`).join('\n') +
          `\nIf intentional, verify then add the signature(s) to the baseline.`,
      ).toBe(0);
    }
  }, 600000);
});
