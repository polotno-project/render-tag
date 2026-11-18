/**
 * `text-decoration-skip-ink: auto` against Chrome's own pixels.
 *
 * render-tag reads glyph ink from a scratch raster (src/skip-ink.ts); Chrome asks Skia for
 * outline intercepts. Each case is rendered twice:
 *  - visible: dark text, red bands — a sheet (Chrome / render-tag / diff, 2x) in
 *    `tests/.out/skip-ink/` for the eye;
 *  - band only: transparent text, so the image holds the bands alone. Every gap of every
 *    band row is matched between the two and its edge error recorded (device px).
 *
 * Run: `npx vitest run --project chromium tests/skip-ink-parity.test.ts`
 */
import { describe, it, expect, afterAll } from 'vitest';
import { commands } from 'vitest/browser';
import { compareNativeRenders } from './helpers/native-compare.ts';
import { loadMultiFontCss, TEST_FALLBACK_STACK } from './helpers/test-cases.ts';
import { reportPath } from './helpers/report-path.ts';

interface Case {
  name: string;
  /** Inner html; `U` is replaced by the underline declaration with skip-ink on. */
  html: string;
  font: string;
  width?: number;
  height?: number;
  dpr?: number;
  /** Whether Chrome leaves any gap in a solid band here. */
  gaps?: boolean;
  /** Pixel mismatch allowed, %, where something other than the gaps differs (said at the case). */
  mismatch?: number;
}

const U = 'text-decoration:underline red;text-decoration-skip-ink:auto';
const u = (text: string, extra = '') => `<span style="${U};${extra}">${text}</span>`;
const PANGRAM = 'Typography: jumping, quirky (gypsy) pages; Qjqy.';

const CASES: Case[] = [
  { name: 'arial-40', font: '40px Arial', html: u(PANGRAM), width: 900, gaps: true },
  { name: 'arial-16', font: '16px Arial', html: u(PANGRAM + ' ' + PANGRAM), width: 420 },
  { name: 'open-sans-24-wrapped', font: `24px 'Open Sans'`, html: u(`${PANGRAM} ${PANGRAM} ${PANGRAM}`), width: 520, height: 220 },
  { name: 'roboto-20-bold-nested', font: `20px Roboto`, html: u(`happy <b>jumping</b> <i>gypsy</i> query`), width: 520 },
  { name: 'playfair-48', font: `48px 'Playfair Display'`, html: u('going gadget Qjy;'), width: 620 },
  { name: 'merriweather-italic-32', font: `italic 32px Merriweather`, html: u('jiffy flying pygmy quay'), width: 620 },
  { name: 'lobster-40', font: `40px Lobster`, html: u('Juggling fjord py gq'), width: 620 },
  { name: 'inconsolata-24', font: `24px Inconsolata`, html: u('if (py_obj.gq) { j /= y; }'), width: 620 },
  { name: 'thick-6px', font: '40px Arial', html: u('gypsy query jq', 'text-decoration-thickness:6px'), width: 520 },
  { name: 'offset-8px', font: '40px Arial', html: u('gypsy query jq', 'text-underline-offset:8px'), width: 520, gaps: false },
  { name: 'offset-negative', font: '40px Arial', html: u('gypsy Query BDE', 'text-underline-offset:-10px'), width: 520 },
  { name: 'double', font: '40px Arial', html: u('gypsy query jq', 'text-decoration-style:double'), width: 520 },
  { name: 'dotted', font: '40px Arial', html: u('gypsy query jq', 'text-decoration-style:dotted'), width: 520 },
  { name: 'dashed', font: '40px Arial', html: u('gypsy query jq', 'text-decoration-style:dashed'), width: 520 },
  { name: 'wavy', font: '40px Arial', html: u('gypsy query jq', 'text-decoration-style:wavy'), width: 520 },
  { name: 'overline', font: '40px Arial', html: u('Ålesund ÄÖÜ bdfhklt', 'text-decoration-line:overline'), width: 520 },
  { name: 'under-and-over', font: `36px 'Open Sans'`, html: u('Éjecté gypsy', 'text-decoration-line:underline overline'), width: 520 },
  { name: 'line-through-untouched', font: '40px Arial', html: u('gypsy query', 'text-decoration-line:line-through'), width: 520, gaps: false },
  { name: 'letter-spacing', font: '32px Arial', html: u('gypsy query jq', 'letter-spacing:4px'), width: 520 },
  { name: 'never-skipped', font: `32px Arial, ${TEST_FALLBACK_STACK}`, html: u('a_b/c\\d 日本語 gjp 한국어'), width: 620, gaps: true },
  // A color glyph has no outline for Skia to cross.
  { name: 'emoji', font: '32px Arial', html: u('gyp \u{1F33F} \u{1F433} jq'), width: 520, gaps: true },
  // The band of this mixed-direction fragment ends 9px further right than Chrome's, with
  // `skip-ink: none` too: not a gap.
  { name: 'arabic', font: `32px Arial, ${TEST_FALLBACK_STACK}`, html: `<div dir="rtl">${u('مرحبا بالعالم gypsy')}</div>`, width: 520, mismatch: 0.05 },
  // A thin band shows any piece left inside a glyph: one span per glyph, as Skia.
  { name: 'rtl-latin-thin', font: `80px Arial`, html: `<div dir="rtl">${u('gyjp gq', 'text-decoration-thickness:1px;text-underline-offset:6px')}</div>`, width: 620, height: 200 },
  { name: 'arabic-thin', font: `80px Arial, ${TEST_FALLBACK_STACK}`, html: `<div dir="rtl">${u('نيع جحخ', 'text-decoration-thickness:1px;text-underline-offset:6px')}</div>`, width: 620, height: 200 },
  { name: 'arabic-only', font: `32px Arial, ${TEST_FALLBACK_STACK}`, html: `<div dir="rtl">${u('مرحبا')}</div>`, width: 520 },
  { name: 'inherited-and-none', font: '32px Arial',
    html: `<div style="text-decoration-skip-ink:auto"><u style="text-decoration-color:red">gypsy <span style="text-decoration-skip-ink:none">gypsy</span> gypsy</u></div>`, width: 520 },
  { name: 'ancestor-band', font: '32px Arial', html: u('gyp <span style="font-size:48px">gyp</span> <sup>gyp</sup>'), width: 520 },
  { name: 'text-shadow', font: '40px Arial', html: u('gypsy query', 'text-shadow:6px 6px 0 #88f'), width: 520 },
  { name: 'arial-40-dpr2', font: '40px Arial', html: u(PANGRAM), width: 900, dpr: 2 },
  { name: 'open-sans-17-dpr2', font: `17px 'Open Sans'`, html: u(PANGRAM), width: 460, dpr: 2 },
];

const DIR = 'skip-ink';

function isRed(d: Uint8ClampedArray, i: number): boolean {
  return d[i + 3] > 96 && d[i] > d[i + 1] + 60 && d[i] > d[i + 2] + 60;
}

/** Per band row: the gaps [start, end) between its first and last red pixel. */
function gapsByRow(canvas: HTMLCanvasElement): Map<number, [number, number][]> {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height);
  const rows = new Map<number, [number, number][]>();
  for (let y = 0; y < height; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) if (isRed(data, (y * width + x) * 4)) { if (first < 0) first = x; last = x; }
    // A row of dots, a wave's crest: not a band row to read gaps from.
    if (first < 0) continue;
    const gaps: [number, number][] = [];
    let open = -1, red = 0;
    for (let x = first; x <= last + 1; x++) {
      const on = x <= last && isRed(data, (y * width + x) * 4);
      if (on) red++;
      if (!on && open < 0) open = x;
      else if (on && open >= 0) { gaps.push([open, x]); open = -1; }
    }
    if (red >= (last - first + 1) * 0.5) rows.set(y, gaps);
  }
  return rows;
}

interface GapStats { gaps: number; exact: number; within1: number; worse: number; unmatched: number; maxEdge: number; rows: string[] }

/** Match each Chrome gap with the render-tag gap it overlaps, row by row. */
function compareGaps(dom: HTMLCanvasElement, lib: HTMLCanvasElement): GapStats {
  const stats: GapStats = { gaps: 0, exact: 0, within1: 0, worse: 0, unmatched: 0, maxEdge: 0, rows: [] };
  const libRows = gapsByRow(lib);
  for (const [y, domGaps] of gapsByRow(dom)) {
    const libGaps = [...(libRows.get(y) ?? [])];
    const before = stats.exact;
    const all = domGaps.length + libGaps.length;
    for (const [a, b] of domGaps) {
      stats.gaps++;
      const k = libGaps.findIndex(([c, d]) => c < b && d > a);
      if (k < 0) { stats.unmatched++; continue; }
      const [c, d] = libGaps.splice(k, 1)[0];
      const edge = Math.max(Math.abs(a - c), Math.abs(b - d));
      stats.maxEdge = Math.max(stats.maxEdge, edge);
      if (edge === 0) stats.exact++;
      else if (edge <= 1) stats.within1++;
      else stats.worse++;
    }
    stats.unmatched += libGaps.length;
    // The first rows that differ, for triage.
    if ((stats.exact - before) * 2 !== all && stats.rows.length < 2) {
      stats.rows.push(`y=${y} chrome ${JSON.stringify(domGaps)} render-tag ${JSON.stringify(libRows.get(y) ?? [])}`);
    }
  }
  return stats;
}

/** Chrome / render-tag / diff, stacked, 2x. */
function sheet(name: string, dom: HTMLCanvasElement, lib: HTMLCanvasElement, diff: HTMLCanvasElement): string {
  const zoom = 2, label = 18;
  const out = document.createElement('canvas');
  out.width = dom.width * zoom;
  out.height = (dom.height * zoom + label) * 3;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  [['Chrome', dom], ['render-tag', lib], ['diff', diff]].forEach(([title, canvas], i) => {
    const y = i * (dom.height * zoom + label);
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${title} — ${name}`, 4, y + 13);
    ctx.drawImage(canvas as HTMLCanvasElement, 0, y + label, dom.width * zoom, dom.height * zoom);
  });
  return out.toDataURL('image/png').split(',')[1];
}

const report: Record<string, GapStats & { mismatch: number }> = {};

describe('text-decoration-skip-ink: auto vs Chrome', () => {
  afterAll(async () => {
    await commands.writeFile(reportPath(`${DIR}/report.json`), JSON.stringify(report, null, 2) + '\n');
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const fontCss = await loadMultiFontCss();
      const width = c.width ?? 520, height = c.height ?? 110, dpr = c.dpr ?? 1;
      const wrap = (color: string) =>
        `<div style="font:${c.font};color:${color};margin:0;padding:16px 12px;line-height:1.5">${c.html}</div>`;
      const visible = await compareNativeRenders(wrap('#1a1a2e'), fontCss, width, height, 0.1, dpr);
      await commands.writeFile(
        reportPath(`${DIR}/${c.name}.png`),
        sheet(c.name, visible.domCanvas, visible.libCanvas, visible.diffCanvas), 'base64');
      const bands = await compareNativeRenders(wrap('transparent'), fontCss, width, height, 0.1, dpr);
      const stats = compareGaps(bands.domCanvas, bands.libCanvas);
      report[c.name] = { ...stats, mismatch: +visible.mismatchPercentage.toFixed(3) };
      // Every gap Chrome leaves is there, its edges within a device px (a crossing's edge is
      // rounded to the grid: a hair's difference in the read ink can move it one px).
      expect(stats.unmatched, `gaps on one side only\n${stats.rows.join('\n')}`).toBe(0);
      expect(stats.maxEdge, `gap edges\n${stats.rows.join('\n')}`).toBeLessThanOrEqual(1);
      if (c.gaps !== undefined) expect(stats.gaps > 0, 'Chrome skips ink here').toBe(c.gaps);
      expect(visible.mismatchPercentage, 'pixels').toBeLessThan(c.mismatch ?? 0.02);
    });
  }
});
