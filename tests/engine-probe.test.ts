/**
 * Engine-probe matrix — a maintainer measurement tool, NOT a gate (not in
 * `npm test` or any lane). `npm run probe:engines` (all engines) or `npx vitest run --project <browser> tests/engine-probe.test.ts`.
 *
 * Each FAMILY is a table of inputs for one engine rule in `src/engine.ts`. A
 * row measures the engine's own DOM and render-tag's `layout()` in the same
 * browser (so render-tag predicts with that engine's flags) and records both
 * plus the signed delta per field. `tests/engine-probe.<browser>.json`
 * (git-ignored) holds every row, one per line, sorted by family, and a
 * summary: rows matching within `tol` (the engine's layout unit, or 0 device
 * px for raster families) and the worst rows. Fit a rule from the rows, then
 * pin it in a parity suite.
 *
 * Adding a probe: one input in a family's table, or one entry in FAMILIES.
 */
import { describe, it, expect } from 'vitest';
import { commands } from 'vitest/browser';
import { layout } from '../src/index.ts';
import { ENGINE } from '../src/engine.ts';
import type { LayoutBox, LayoutNode } from '../src/types.ts';
import { collectInlineBoxes, collectTexts } from './helpers/layout-tree.ts';
import { prepareComparisonFonts } from './helpers/compare.ts';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { scanBand } from './helpers/decoration-scan.ts';
import { FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import { browserName } from './helpers/browser-name.ts';

/** What getBoundingClientRect resolves to: Blink and WebKit LayoutUnits,
 * Gecko app units. */
const UNIT = ENGINE === 'gecko' ? 1 / 60 : 1 / 64;
const EPS = 1e-6;

const PINNED = FONT_VARIANTS.map((f) => ({ font: f.name, family: f.family }));
// Unpinned: present on macOS, fallbacks on CI runners. Kept in their own
// families so they never mix with comparable rows.
const SYSTEM = ['sans-serif', 'Georgia', 'Verdana'].map((f) => ({ font: f, family: f }));

const SIZES = [8.7, 12.5, 13.33, 13.6, 16, 17.3, 20, 33.9, 44];
const LINE_HEIGHTS = ['normal', '1', '1.15', '1.37', '1.6', '0.8', '25.6px', '21.99px', '1.3em', '133.3%', '162.9%'];
const PERCENTS = ['99.5%', '100.5%', '133.3%', '133.7%', '150.25%', '162.5%', '162.9%'];
const PITCH_LINES = 8;
const WIDTH = 600;

type Input = Record<string, string | number>;
interface Measured { dom: number[]; rt: number[] }
interface Family<I extends Input = Input> {
  name: string;
  /** The engine.ts flag(s) or layout rule the family validates. */
  rule: string;
  fields: string[];
  tol: number;
  inputs: I[];
  measure(input: I): Measured | Promise<Measured>;
}

// ─── DOM and render-tag readers ─────────────────────────────────────

const ZERO = '<span class="p" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';

function mount(html: string, width = WIDTH): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;left:-9999px;top:0;width:${width}px;margin:0;padding:0`;
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap;
}

/** Tops of the zero-size `.p` probes (each sits on its parent's baseline). */
function probeTops(wrap: HTMLElement): number[] {
  const top = wrap.getBoundingClientRect().top;
  return [...wrap.querySelectorAll('.p')].map((p) => p.getBoundingClientRect().top - top);
}

function blockStyle(family: string, size: number, lineHeight: string): string {
  return `margin:0;padding:0;font-family:${family};font-size:${size}px;line-height:${lineHeight}`;
}

function textBaselines(html: string): number[] {
  return collectTexts(layout({ html, width: WIDTH }).layoutRoot)
    .filter((t) => t.text.trim())
    .map((t) => t.y);
}

function canvasMetrics(family: string, size: number): { asc: number; desc: number } {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${size}px ${family}`;
  const m = ctx.measureText('M');
  return { asc: round(m.fontBoundingBoxAscent), desc: round(m.fontBoundingBoxDescent) };
}

function boxesByTag(node: LayoutNode, tag: string, out: LayoutBox[] = []): LayoutBox[] {
  if (node.type !== 'box') return out;
  if (node.tagName === tag) out.push(node);
  for (const child of node.children) boxesByTag(child, tag, out);
  return out;
}

function blockBoxes(node: LayoutNode, out: LayoutBox[] = []): LayoutBox[] {
  if (node.type !== 'box' || node.style.display.startsWith('inline')) return out;
  out.push(node);
  for (const child of node.children) blockBoxes(child, out);
  return out;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

const cross = <A, B>(as: A[], bs: B[]) => as.flatMap((a) => bs.map((b) => [a, b] as const));

function lineHeightInputs(fonts: typeof PINNED, lineHeights: string[]): Input[] {
  return cross(fonts, cross(SIZES, lineHeights)).map(([f, [size, lh]]) => ({
    font: f.font, family: f.family, size, lh, ...canvasMetrics(f.family, size),
  }));
}

// ─── Families ───────────────────────────────────────────────────────

function usedLineHeight(name: string, rule: string, inputs: () => Input[]): Family {
  return {
    name, rule, fields: ['height'], tol: UNIT, get inputs() { return inputs(); },
    measure({ family, size, lh }) {
      const html = `<div style="${blockStyle(String(family), Number(size), String(lh))}">Hxg</div>`;
      const wrap = mount(html);
      const dom = (wrap.firstElementChild as HTMLElement).getBoundingClientRect().height;
      wrap.remove();
      return { dom: [dom], rt: [layout({ html, width: WIDTH }).height] };
    },
  };
}

function firstBaseline(name: string, fonts: typeof PINNED): Family {
  return {
    name, rule: 'FLOORS_LINE_BASELINE, LAYOUT_UNIT_LINE_HEIGHT (half-leading)', fields: ['baseline'], tol: UNIT,
    get inputs() { return lineHeightInputs(fonts, LINE_HEIGHTS); },
    measure({ family, size, lh }) {
      const style = blockStyle(String(family), Number(size), String(lh));
      const wrap = mount(`<div style="${style}">Hxg${ZERO}</div>`);
      const [dom] = probeTops(wrap);
      wrap.remove();
      return { dom: [dom], rt: [textBaselines(`<div style="${style}">Hxg</div>`)[0]] };
    },
  };
}

function linePitch(name: string, fonts: typeof PINNED): Family {
  return {
    name,
    rule: 'TRUNCATES_LINE_HEIGHT, LAYOUT_UNIT_LINE_HEIGHT, APP_UNIT_LINE_HEIGHT (compounded)',
    fields: ['pitch', 'lastBaseline'], tol: UNIT,
    get inputs() { return lineHeightInputs(fonts, LINE_HEIGHTS); },
    measure({ family, size, lh }) {
      const style = blockStyle(String(family), Number(size), String(lh));
      // A zero-height probe on the baseline still extends a line whose leaded
      // descent is negative (big font, small line-height), so only the LAST
      // line carries one; the first baseline comes from its own fixture.
      const lines = (probe: string) =>
        Array.from({ length: PITCH_LINES }, (_, i) => `Hxg${i === PITCH_LINES - 1 ? probe : ''}`).join('<br>');
      const first = mount(`<div style="${style}">Hxg${ZERO}</div>`);
      const [domFirst] = probeTops(first);
      first.remove();
      const wrap = mount(`<div style="${style}">${lines(ZERO)}</div>`);
      const [domLast] = probeTops(wrap);
      wrap.remove();
      const rt = textBaselines(`<div style="${style}">${lines('')}</div>`);
      const rtLast = rt[rt.length - 1];
      const n = PITCH_LINES - 1;
      return { dom: [(domLast - domFirst) / n, domLast], rt: [(rtLast - rt[0]) / n, rtLast] };
    },
  };
}

const VALIGNS = ['super', 'sub', 'sup-element', 'sub-element', 'middle', 'text-top', 'text-bottom'];

const verticalAlign: Family = {
  name: 'vertical-align',
  rule: 'BLINK_SUPER_SUB (super/sub), FLOORS_LINE_BASELINE (middle), text-top/text-bottom leaded vs content edge',
  fields: ['shiftUp'], tol: UNIT,
  get inputs() {
    return cross(PINNED, cross([8, 12.5, 16, 18, 33.9, 56], cross(VALIGNS, ['1', '2']))).map(
      ([f, [size, [valign, lh]]]) => ({ font: f.font, family: f.family, size, valign, lh }),
    );
  },
  measure({ family, size, valign, lh }) {
    const style = blockStyle(String(family), Number(size), String(lh));
    // super/sub keep the parent size (the shift rule alone); <sup>/<sub> add
    // the UA's `font-size: smaller`; the others use a bigger box so the
    // alignment moves it.
    const open = valign === 'sup-element' ? '<sup>' : valign === 'sub-element' ? '<sub>'
      : `<span style="vertical-align:${valign}${valign === 'super' || valign === 'sub' ? '' : `;font-size:${round(Number(size) * 1.6)}px`}">`;
    const close = valign === 'sup-element' ? '</sup>' : valign === 'sub-element' ? '</sub>' : '</span>';
    const wrap = mount(`<div style="${style}">${ZERO}H${open}${ZERO}x${close}</div>`);
    const [base, shifted] = probeTops(wrap);
    wrap.remove();
    const texts = collectTexts(layout({ html: `<div style="${style}">H${open}x${close}</div>`, width: WIDTH }).layoutRoot);
    const h = texts.find((t) => t.text === 'H')!;
    const x = texts.find((t) => t.text === 'x')!;
    return { dom: [base - shifted], rt: [h.y - x.y] };
  },
};

const MARGIN_ROOT = `font-family:${PINNED[1].family};font-size:16px;line-height:20px`;

function marginGeometry(html: string): Measured {
  const wrap = mount(`<div style="${MARGIN_ROOT}">${html}</div>`, 300);
  const origin = wrap.getBoundingClientRect().top;
  const blocks = [...wrap.querySelectorAll(':not(br)')].filter((el) => {
    const d = getComputedStyle(el).display;
    return d !== 'none' && !d.startsWith('inline');
  });
  const last = blocks[blocks.length - 1].getBoundingClientRect().top - origin;
  const dom = [last, wrap.getBoundingClientRect().height];
  wrap.remove();
  const result = layout({ html: `<div style="${MARGIN_ROOT}">${html}</div>`, width: 300 });
  const boxes = blockBoxes(result.layoutRoot);
  return { dom, rt: [boxes[boxes.length - 1].y, result.height] };
}

const marginMinHeight: Family = {
  name: 'margin-min-height',
  rule: 'MIN_HEIGHT_END_MARGINS',
  fields: ['nextTop', 'height'], tol: UNIT,
  get inputs() {
    return cross([10, 19.5, 20, 20.5, 25, 30, 40, 80], cross([10, 40], [0, 16])).map(
      ([minHeight, [childBottom, nextTop]]) => ({ minHeight, childBottom, nextTop }),
    );
  },
  measure: ({ minHeight, childBottom, nextTop }) => marginGeometry(
    `<div style="min-height:${minHeight}px"><p style="margin:0 0 ${childBottom}px">a</p></div>` +
    `<p style="margin:${nextTop}px 0 0">b</p>`,
  ),
};

const EMPTY_BLOCKS: Record<string, string> = {
  'empty div with margins': '<p>a</p><div style="margin:30px 0"></div><p>b</p>',
  'nested empty divs': '<p>a</p><div style="margin:30px 0"><div style="margin:50px 0"></div><div></div></div><p>b</p>',
  'height:0': '<p>a</p><div style="height:0;margin:30px 0"></div><p>b</p>',
  'min-height:0.5px': '<p>a</p><div style="min-height:0.5px;margin:30px 0"></div><p>b</p>',
  'min-height:6px': '<p>a</p><div style="min-height:6px"></div><p>b</p>',
  'padding-bottom:2px': '<p>a</p><div style="padding-bottom:2px"></div><p>b</p>',
  'border-top:1px': '<p>a</p><div style="border-top:1px solid red"></div><p>b</p>',
  'empty <p>': '<p>a</p><p></p><p>b</p>',
  'whitespace <p>': '<p>a</p><p> </p><p>b</p>',
  '<p> with empty inline': '<p>a</p><p><span></span></p><p>b</p>',
  '<p> with <br>': '<p>a</p><p><br></p><p>b</p>',
  'empty <li> in ul': '<ul><li>a</li><li></li><li>b</li></ul>',
  'empty <li> in ol': '<ol><li>a</li><li></li><li>b</li></ol>',
  'empty <li> no marker': '<ul style="list-style:none"><li style="margin:6px 0">a</li><li style="margin:30px 0"></li><li>b</li></ul>',
  '<li> holding only an empty block': '<ul><li>a</li><li><div style="margin:10px 0"></div></li><li>b</li></ul>',
  'blockquote > h1': '<p>a</p><blockquote><h1>b</h1><p>c</p></blockquote><p>d</p>',
};

const marginEmptyBlock: Family = {
  name: 'margin-empty-block',
  rule: 'collapsesThrough, MARKER_LINE_WITHOUT_CONTENT',
  fields: ['lastTop', 'height'], tol: UNIT,
  inputs: Object.keys(EMPTY_BLOCKS).map((name) => ({ name })),
  measure: ({ name }) => marginGeometry(EMPTY_BLOCKS[name]),
};

const listMarker: Family = {
  name: 'list-marker',
  rule: '::marker line height (Firefox ul taller; not modelled)',
  fields: ['liHeight', 'listHeight'], tol: UNIT,
  get inputs() {
    return cross(PINNED, cross([13.33, 16, 18.5, 24], cross(['normal', '1.2', '1.5'], cross(['ul', 'ol'], ['marker', 'none', 'marker-content-none'])))).map(
      ([f, [size, [lh, [list, marker]]]]) => ({ font: f.font, family: f.family, size, lh, list, marker }),
    );
  },
  measure({ family, size, lh, list, marker }) {
    const cls = `m${Math.random().toString(36).slice(2)}`;
    const sheet = marker === 'marker-content-none'
      ? `<style>.${cls} li::marker{content:none;font-size:0;line-height:0}</style>` : '';
    const listStyle = marker === 'none' ? 'list-style:none;' : '';
    const html = `${sheet}<div class="${cls}" style="${blockStyle(String(family), Number(size), String(lh))}">` +
      `<${list} style="margin:0;${listStyle}"><li>one</li><li>two</li><li>three</li></${list}></div>`;
    const wrap = mount(html);
    const li = wrap.querySelector('li')!.getBoundingClientRect().height;
    const all = wrap.querySelector(String(list))!.getBoundingClientRect().height;
    wrap.remove();
    const root = layout({ html, width: WIDTH }).layoutRoot;
    return { dom: [li, all], rt: [boxesByTag(root, 'li')[0].height, boxesByTag(root, String(list))[0].height] };
  },
};

const nestedInlineBlock: Family = {
  name: 'inline-block-nested',
  rule: 'inline-block height inside an inline-block (lineBoxExtent)',
  fields: ['outerHeight', 'innerHeight'], tol: UNIT,
  get inputs() {
    return cross(PINNED, cross([12.5, 16, 33.9], cross(['normal', '1', '1.15', '1.6'], [0, 3]))).map(
      ([f, [size, [lh, padding]]]) => ({ font: f.font, family: f.family, size, lh, padding }),
    );
  },
  measure({ family, size, lh, padding }) {
    const html = `<div style="${blockStyle(String(family), Number(size), String(lh))}">a ` +
      `<span class="o" style="display:inline-block;padding:${padding}px">b ` +
      `<span class="i" style="display:inline-block;padding:${padding}px">c</span></span> d</div>`;
    const wrap = mount(html);
    const dom = ['.o', '.i'].map((s) => wrap.querySelector(s)!.getBoundingClientRect().height);
    wrap.remove();
    const boxes = collectInlineBoxes(layout({ html, width: WIDTH }).layoutRoot)
      .filter((b) => b.style.display === 'inline-block');
    return { dom, rt: boxes.slice(0, 2).map((b) => b.height) };
  },
};

let decorationCss: Promise<string> | null = null;

const decorationBand: Family = {
  name: 'decoration-band',
  rule: 'decorationBand (BLINK_UNDERLINE_GAP; WebKit device-grid thickness; Gecko unmeasured)',
  fields: ['topBelowBaseline', 'thickness'], tol: 0,
  get inputs() {
    return cross(PINNED, cross(['underline', 'overline', 'line-through'], cross([10, 16, 25, 40, 64], [1, 2]))).map(
      ([f, [line, [size, dpr]]]) => ({ font: f.font, family: f.family, line, size, dpr }),
    );
  },
  async measure({ family, line, size, dpr }) {
    const css = await (decorationCss ??= loadMultiFontCss());
    const html =
      `<div style="font-family:${family};font-size:${size}px;line-height:normal;color:black;padding:4px 0 0 4px">` +
      `<span style="text-decoration:${line} red;text-decoration-skip-ink:none">HHHHHH</span></div>`;
    const s = Number(size);
    const r = await compareNativeRenders(html, css, s * 6, s * 3, 0.1, Number(dpr));
    const lib = scanBand(r.libCanvas), dom = scanBand(r.domCanvas);
    return { dom: [dom.top - dom.baseline, dom.rows], rt: [lib.top - lib.baseline, lib.rows] };
  },
};

const FAMILIES: Family[] = [
  usedLineHeight('line-height', 'TRUNCATES_LINE_HEIGHT, LAYOUT_UNIT_LINE_HEIGHT, APP_UNIT_LINE_HEIGHT',
    () => lineHeightInputs(PINNED, LINE_HEIGHTS)),
  usedLineHeight('line-height:system', 'TRUNCATES_LINE_HEIGHT, LAYOUT_UNIT_LINE_HEIGHT, APP_UNIT_LINE_HEIGHT',
    () => lineHeightInputs(SYSTEM, LINE_HEIGHTS)),
  usedLineHeight('line-height-percent', 'INTEGER_PERCENT_LINE_HEIGHT',
    () => lineHeightInputs(PINNED, PERCENTS)),
  firstBaseline('first-baseline', PINNED),
  firstBaseline('first-baseline:system', SYSTEM),
  linePitch('line-pitch', PINNED),
  linePitch('line-pitch:system', SYSTEM),
  verticalAlign,
  marginMinHeight,
  marginEmptyBlock,
  listMarker,
  nestedInlineBlock,
  decorationBand,
];

// ─── Run and report ─────────────────────────────────────────────────

interface Row { in: Input; dom: number[]; rt: number[]; d: number[]; err?: string }

const worstOf = (row: Row) => (row.err ? Infinity : Math.max(...row.d.map(Math.abs)));

describe('engine probe', () => {
  it('measures every probe family', async () => {
    const css = await loadMultiFontCss();
    const families = [...PINNED, ...SYSTEM].map((f) => `<span style="font-family:${f.family}">Hxg</span>`).join('');
    await prepareComparisonFonts(families, css);

    const rows: Record<string, Row[]> = {};
    const summary = [];
    let sinceYield = performance.now();
    for (const family of FAMILIES) {
      const out: Row[] = (rows[family.name] = []);
      for (const input of family.inputs) {
        const { family: _stack, ...shown } = input;
        const row: Row = { in: shown, dom: [], rt: [], d: [] };
        try {
          const { dom, rt } = await family.measure(input);
          row.dom = dom.map(round);
          row.rt = rt.map(round);
          row.d = dom.map((v, i) => round(rt[i] - v));
        } catch (error) {
          row.err = String(error);
        }
        out.push(row);
        // Long synchronous stretches kill the page (see sweepWrapWidths).
        if (performance.now() - sinceYield > 200) {
          await new Promise((r) => setTimeout(r));
          sinceYield = performance.now();
        }
      }
      const matched = out.filter((r) => worstOf(r) <= family.tol + EPS).length;
      summary.push({
        family: family.name,
        rule: family.rule,
        fields: family.fields,
        tol: round(family.tol),
        rows: out.length,
        matched,
        worst: [...out].sort((a, b) => worstOf(b) - worstOf(a)).slice(0, 5)
          .filter((r) => worstOf(r) > family.tol + EPS),
      });
      console.log(`[engine-probe ${browserName}] ${family.name}: ${matched}/${out.length} within ${round(family.tol)}`);
    }

    const line = (v: unknown) => JSON.stringify(v);
    const json =
      '{\n' +
      `"browser": ${line(browserName)},\n"engine": ${line(ENGINE)},\n"userAgent": ${line(navigator.userAgent)},\n` +
      `"devicePixelRatio": ${devicePixelRatio},\n"unit": ${round(UNIT)},\n` +
      `"summary": [\n${summary.map(line).join(',\n')}\n],\n` +
      `"rows": {\n${Object.entries(rows).map(([name, list]) =>
        `${line(name)}: [\n${list.map(line).join(',\n')}\n]`).join(',\n')}\n}\n}\n`;
    await commands.writeFile(`./tests/engine-probe.${browserName}.json`, json);
    // Report-only: the run fails only if a family produced no rows at all.
    for (const s of summary) expect(s.rows, s.family).toBeGreaterThan(0);
  }, 1_200_000);
});
