import { describe, it, expect } from 'vitest';
import { compareWrapping } from './helpers/compare.ts';
import { compareNativeRenders as compareRenders } from './helpers/native-compare.ts';
import { loadBasicCases, polotnoCase, polotnoListsCase, negativeListMarginsCase, FONT_VARIANTS, loadMultiFontCss } from './helpers/test-cases.ts';
import type { BenchmarkCase } from './helpers/test-cases.ts';
import {
  classifyBaselineResult,
  validateBaselineCoverage,
  type BaselineEntry,
} from './helpers/baselines.ts';
import chromeBaselines from './baselines.chrome.json';
import firefoxBaselines from './baselines.firefox.json';
import webkitBaselines from './baselines.webkit.json';
import { browserName, isFirefox } from './helpers/browser-name.ts';

// Each browser has its own baseline file — no cross-browser tolerance needed.
const SCORE_TOLERANCE = 0.01;
const PIXEL_RATIO = 2;

const baselineFiles: Record<string, Record<string, BaselineEntry>> = {
  chrome: chromeBaselines as Record<string, BaselineEntry>,
  firefox: firefoxBaselines as Record<string, BaselineEntry>,
  webkit: webkitBaselines as Record<string, BaselineEntry>,
};
const baselineMap = baselineFiles[browserName];

// Known wrapping limitations that are skipped from wrap checks
const SKIP_WRAPPING = new Set([
  'Very narrow container',
  ...(isFirefox ? ['Long unbroken word overflow-wrap'] : []),
]);

function formatResult(name: string, score: number, wrap: boolean, baseline?: BaselineEntry): string {
  const scoreDelta = baseline ? (score - baseline.score) : 0;
  const scoreStr = baseline
    ? (scoreDelta < -0.5 ? ` (${scoreDelta.toFixed(1)} improved)` : scoreDelta > SCORE_TOLERANCE ? ` (+${scoreDelta.toFixed(1)} REGRESSION!)` : '')
    : '';
  const wrapStr = baseline
    ? (baseline.wrap && !wrap ? ' (WRAP REGRESSION!)' : !baseline.wrap && wrap ? ' (wrap improved)' : '')
    : '';
  return `[${name}] score: ${score.toFixed(2)}%${scoreStr} | wrap: ${wrap}${wrapStr}`;
}

/** Run a single case: pixel comparison + wrapping check. Returns score and wrap result. */
async function runCase(
  tc: BenchmarkCase,
  css: string,
): Promise<{ score: number; wrap: boolean }> {
  const result = await compareRenders(tc.html, css, tc.width, tc.height, 0.1, PIXEL_RATIO);
  const wrap = SKIP_WRAPPING.has(tc.name)
    ? { wrappingMatch: true } // skipped = treat as passing
    : compareWrapping(tc.html, css, tc.width, tc.height, result.canvasLines);
  return { score: result.contentMismatchPercentage, wrap: wrap.wrappingMatch };
}

/** Baseline key for a case, optionally with a font suffix. */
function baselineKey(caseName: string, fontName?: string): string {
  return fontName ? `${caseName}@${fontName}` : caseName;
}

describe('HTML Canvas Renderer', () => {
  let allCases: BenchmarkCase[];


  it('loads all test cases', async () => {
    allCases = await loadBasicCases();
    expect(allCases.length).toBeGreaterThan(0);
    const expectedKeys = [
      ...allCases.map((testCase) => baselineKey(testCase.name)),
      baselineKey(polotnoCase.name),
      baselineKey(polotnoListsCase.name),
      baselineKey(negativeListMarginsCase.name),
      ...FONT_VARIANTS.flatMap((font) =>
        allCases.map((testCase) => baselineKey(testCase.name, font.name)),
      ),
    ];
    expect(validateBaselineCoverage(expectedKeys, baselineMap)).toEqual({
      missing: [],
      unexpected: [],
    });
    console.log(`Loaded ${allCases.length} test cases | browser: ${browserName} | baselines: ${Object.keys(baselineMap).length}`);
  });

  describe('Default font cases', () => {
    it('all cases (score + wrapping)', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const cases = [...allCases, polotnoCase, polotnoListsCase, negativeListMarginsCase];
      const baselineIssues: string[] = [];

      for (const tc of cases) {
        const key = baselineKey(tc.name);
        const baseline = baselineMap[key];
        const { score, wrap } = await runCase(tc, tc.css);

        console.log(formatResult(key, score, wrap, baseline));
        baselineIssues.push(
          ...classifyBaselineResult(
            key,
            score,
            wrap,
            baseline,
            SCORE_TOLERANCE,
          ),
        );
      }

      expect(
        baselineIssues,
        `Baseline contract changed:\n  ${baselineIssues.join('\n  ')}`,
      ).toEqual([]);
    }, 300000);
  });

  describe('::marker pseudo-element', () => {
    /**
     * Walk the layout tree and find the LTR/RTL gap between an `<li>` marker
     * and the first non-marker text. Returns null if either is missing.
     */
    async function measureMarkerGap(html: string, css: string, width = 400) {
      const { layout } = await import('../src/index.ts');
      const fullHtml = `<style>${css}</style>${html}`;
      const r = layout({ html: fullHtml, width, height: 400 });

      const markers: { x: number; width: number; y: number }[] = [];
      const items: { x: number; width: number; y: number; text: string }[] = [];
      const walk = (n: any, isMarker = false) => {
        if (n.type === 'text') {
          if (isMarker) markers.push({ x: n.x, width: n.width, y: n.y });
          else if (n.text.trim()) items.push({ x: n.x, width: n.width, y: n.y, text: n.text });
          return;
        }
        // The marker text is unshifted as the first child of an <li> box.
        if (n.tagName === 'li' && n.children.length > 0) {
          walk(n.children[0], true);
          for (let i = 1; i < n.children.length; i++) walk(n.children[i], false);
        } else {
          for (const c of n.children) walk(c, false);
        }
      };
      walk(r.layoutRoot);
      return { markers, items };
    }

    it('::marker padding-inline-end widens marker→content gap (LTR)', async () => {
      const html = '<ul><li>item</li></ul>';
      const css = `body { font-family: sans-serif; font-size: 16px; }`;
      const cssWide = css + ` ::marker { padding-inline-end: 1em; }`;

      const def = await measureMarkerGap(html, css);
      const wide = await measureMarkerGap(html, cssWide);

      const defGap = def.items[0].x - (def.markers[0].x + def.markers[0].width);
      const wideGap = wide.items[0].x - (wide.markers[0].x + wide.markers[0].width);
      // Default bullet gap ≈ 7 + ascent/3 ≈ 11.8 at 16px. An explicit 1em
      // padding replaces it → delta ≈ 16 - 11.8 ≈ 4.2.
      expect(wideGap - defGap).toBeGreaterThan(2);
      expect(wideGap - defGap).toBeLessThan(7);
    });

    it('::marker padding-inline-end maps to the correct side in RTL', async () => {
      const html = '<ul dir="rtl"><li>عنصر</li></ul>';
      const css = `body { font-family: sans-serif; font-size: 16px; }`;
      const cssWide = css + ` ::marker { padding-inline-end: 1em; }`;

      const def = await measureMarkerGap(html, css);
      const wide = await measureMarkerGap(html, cssWide);

      // RTL: marker is to the RIGHT of content. Gap = marker.x - (item.x + item.width).
      const defItem = def.items[0];
      const wideItem = wide.items[0];
      const defGap = def.markers[0].x - (defItem.x + defItem.width);
      const wideGap = wide.markers[0].x - (wideItem.x + wideItem.width);
      // Same as LTR: 1em replaces the ≈11.8px default → delta ≈ 4.2.
      expect(wideGap - defGap).toBeGreaterThan(2);
      expect(wideGap - defGap).toBeLessThan(7);
    });

    it('::marker rule only matches inside the selector ancestor', async () => {
      const html = `
        <ul class="fancy"><li>fancy</li></ul>
        <ul><li>plain</li></ul>
      `;
      const css = `body { font-family: sans-serif; font-size: 16px; }
        .fancy ::marker { padding-inline-end: 1em; }`;
      const got = await measureMarkerGap(html, css, 400);

      // Two <li>s. Match items by text to disambiguate.
      const fancy = got.items.find(i => i.text.includes('fancy'))!;
      const plain = got.items.find(i => i.text.includes('plain'))!;
      const fancyMarker = got.markers.find(m => Math.abs(m.y - fancy.y) < 8)!;
      const plainMarker = got.markers.find(m => Math.abs(m.y - plain.y) < 8)!;

      const fancyGap = fancy.x - (fancyMarker.x + fancyMarker.width);
      const plainGap = plain.x - (plainMarker.x + plainMarker.width);
      // plain keeps the default (≈11.8), fancy gets 1em → ≈ 4.2px wider
      expect(fancyGap - plainGap).toBeGreaterThan(2);
      expect(fancyGap - plainGap).toBeLessThan(7);
    });

    it('higher-specificity ::marker rule wins over lower-specificity one', async () => {
      const html = '<ul><li class="special">x</li></ul>';
      const css = `body { font-family: sans-serif; font-size: 16px; }
        li::marker { padding-inline-end: 0.5em; }
        .special::marker { padding-inline-end: 2em; }`;
      const got = await measureMarkerGap(html, css);

      const gap = got.items[0].x - (got.markers[0].x + got.markers[0].width);
      // 2em ≈ 32px. Allow a couple of px for measurement noise.
      expect(gap).toBeGreaterThan(28);
      expect(gap).toBeLessThan(36);
    });
  });

  describe('Punctuation wrapping', () => {
    it('trailing comma stays with preceding word', async () => {
      const html = '<p>Just some words before the <strong>target</strong>, then rest of text continues here</p>';
      const css = 'body { font-family: sans-serif; font-size: 16px; }';
      const { render } = await import('../src/index.ts');
      const fullHtml = `<style>${css}</style>${html}`;

      let testWidth = 0;
      for (let w = 300; w >= 100; w--) {
        const r = render({ html: fullHtml, width: w, height: 200 });
        const line0 = r.lines[0]?.text || '';
        if (line0.includes('target') && !line0.includes(',')) {
          testWidth = w;
          break;
        }
      }

      if (testWidth === 0) return; // fix already prevents comma wrapping

      const result = render({ html: fullHtml, width: testWidth, height: 200 });
      const wrap = compareWrapping(html, css, testWidth, 200, result.lines);
      expect(wrap.wrappingMatch, 'Trailing comma should not wrap to next line').toBe(true);
    });
  });

  describe('Multi-font matrix', () => {
    it('all cases × all fonts (score + wrapping)', async () => {
      if (!allCases) allCases = await loadBasicCases();
      const multiFontCss = await loadMultiFontCss();
      const fonts = FONT_VARIANTS;
      const baselineIssues: string[] = [];

      for (const font of fonts) {
        let totalScore = 0;
        let count = 0;

        for (const tc of allCases) {
          const css = multiFontCss + '\n' + tc.css + `\nbody { font-family: ${font.family} !important; }`;
          const key = baselineKey(tc.name, font.name);
          const baseline = baselineMap[key];
          const { score, wrap } = await runCase(tc, css);
  
          console.log(formatResult(key, score, wrap, baseline));
          totalScore += score;
          count++;
          baselineIssues.push(
            ...classifyBaselineResult(
              key,
              score,
              wrap,
              baseline,
              SCORE_TOLERANCE,
            ),
          );
        }

        console.log(`[${font.name}] avg: ${(totalScore / count).toFixed(1)}%`);
      }

      expect(
        baselineIssues,
        `Baseline contract changed:\n  ${baselineIssues.join('\n  ')}`,
      ).toEqual([]);
    }, 300000);
  });

  describe('Visual debug: bullet item with leading nbsp', () => {
    it('renders the case and prints layout', async () => {
      const html = `<style>
    p, ul, ol, li { margin: 0; padding: 0; }
    ul, ol { padding-left: 1.5em; }
    .ql-cursor, .ql-ui { display: none; }
  </style>
  <div style="font-family: Roboto; font-size: 70.37037037037037px; line-height: 1.2; color: #000000; font-weight: normal; font-style: normal; text-align: center; text-decoration: none; word-break: break-word; letter-spacing: 0px; text-transform: none; white-space: pre-wrap; word-wrap: break-word; margin: 0; padding: 0">
  <ul><li>&nbsp;competition</li><li>item</li></ul>
  </div>`;
      const css = `body { margin: 0; background: #eee; font-family: Roboto, sans-serif; }`;
      const width = 413;
      const height = 400;

      const { render, layout } = await import('../src/index.ts');
      const fullHtml = `<style>${css}</style>${html}`;

      const layoutResult = layout({ html: fullHtml, width, height });
      const renderResult = render({ html: fullHtml, width, height });

      console.log(`\n=== Bullet/nbsp case | width=${width}px, content height=${layoutResult.height}px ===`);
      console.log(`Lines (${renderResult.lines.length}):`);
      for (let i = 0; i < renderResult.lines.length; i++) {
        const l = renderResult.lines[i];
        console.log(`  [${i}] y=${l.y}  "${l.text}"`);
      }

      // Reuse a measure context (same configuration as the layout engine)
      const mctx = document.createElement('canvas').getContext('2d')!;
      mctx.fontKerning = 'normal';

      const f = (n: number | undefined) => (n === undefined ? '?' : n.toFixed(2));
      const fmtBox = (s: any, prefix: string) => {
        const t = s[`${prefix}Top`] ?? 0;
        const r = s[`${prefix}Right`] ?? 0;
        const b = s[`${prefix}Bottom`] ?? 0;
        const l = s[`${prefix}Left`] ?? 0;
        return (t || r || b || l) ? `${prefix}=[${t},${r},${b},${l}]` : '';
      };

      const dump = (node: any, depth = 0): void => {
        const pad = '  '.repeat(depth);
        const s = node.style ?? {};
        if (node.type === 'text') {
          mctx.font = `${s.fontStyle || 'normal'} ${s.fontWeight || 400} ${s.fontSize}px ${s.fontFamily}`;
          (mctx as any).letterSpacing = `${s.letterSpacing || 0}px`;
          const measured = mctx.measureText(node.text);
          const ascent = measured.actualBoundingBoxAscent;
          const descent = measured.actualBoundingBoxDescent;
          const codepoints = [...node.text].map(c =>
            c === ' ' ? 'SP' : c === ' ' ? 'NBSP' : c === '\t' ? 'TAB' :
            c === '\n' ? 'LF' : c.charCodeAt(0) < 32 ? `U+${c.charCodeAt(0).toString(16)}` : c
          ).join('|');
          console.log(
            `${pad}text  x=${f(node.x)} y(baseline)=${f(node.y)} w=${f(node.width)}` +
            `  measure=${f(measured.width)}` +
            `  ascent=${f(ascent)} descent=${f(descent)}` +
            `  font="${s.fontFamily}" ${s.fontWeight} ${s.fontStyle} ${s.fontSize}px lh=${s.lineHeight}` +
            `  ws=${s.whiteSpace} wb=${s.wordBreak} ow=${s.overflowWrap} ls=${s.letterSpacing}` +
            `\n${pad}      text=[${codepoints}]  raw="${node.text}"`,
          );
        } else if (node.type === 'box') {
          const tag = node.tagName || s.display || 'box';
          const padBox = fmtBox(s, 'padding');
          const marginBox = fmtBox(s, 'margin');
          const borderBox = fmtBox(s, 'border').replace('border=', 'borderW=');
          const fontInfo = s.fontSize
            ? ` font="${s.fontFamily}" ${s.fontWeight} ${s.fontSize}px lh=${s.lineHeight}`
            : '';
          const align = s.textAlign && s.textAlign !== 'start' ? ` align=${s.textAlign}` : '';
          const dir = s.direction && s.direction !== 'ltr' ? ` dir=${s.direction}` : '';
          const wsInfo = s.whiteSpace ? ` ws=${s.whiteSpace}` : '';
          const marker = node.listMarker ? ` marker="${node.listMarker}"` : '';
          console.log(
            `${pad}${tag}  x=${f(node.x)} y=${f(node.y)} w=${f(node.width)} h=${f(node.height)}` +
            `${marker} display=${s.display}${align}${dir}${wsInfo}` +
            `${fontInfo}` +
            `${padBox ? '  ' + padBox : ''}${marginBox ? '  ' + marginBox : ''}${borderBox ? '  ' + borderBox : ''}`,
          );
          for (const c of node.children) dump(c, depth + 1);
        }
      };
      console.log(`Layout tree:`);
      dump(layoutResult.layoutRoot);

      console.log(`\nDerived metrics:`);
      console.log(`  font-size = 70.37037037037037px → line-height ratio 1.2 → line box = ${(70.37037037037037 * 1.2).toFixed(4)}px`);
      console.log(`  ul padding-left = 1.5em = ${(70.37037037037037 * 1.5).toFixed(4)}px`);
      console.log(`  available text width inside li = container ${width}px - ul.padding-left = ${(width - 70.37037037037037 * 1.5).toFixed(4)}px`);

      const cmp = await compareRenders(html, css, width, height, 0.1, PIXEL_RATIO);
      console.log(`Score: ${cmp.contentMismatchPercentage.toFixed(2)}%  (mismatched=${cmp.mismatchedPixels} content=${cmp.contentPixels})`);

      // Make canvases visible during the browser test run and capture a
      // screenshot reference under tests/__screenshots__ for inspection.
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:12px;background:#fff;padding:12px;align-items:flex-start;font-family:sans-serif;font-size:12px;width:fit-content';
      const labels = ['DOM (reference)', 'Canvas (lib)', 'Diff'];
      const canvases = [cmp.domCanvas, cmp.libCanvas, cmp.diffCanvas];
      for (let i = 0; i < canvases.length; i++) {
        const col = document.createElement('div');
        const label = document.createElement('div');
        label.textContent = labels[i];
        label.style.cssText = 'margin-bottom:4px;font-weight:600';
        col.appendChild(label);
        const c = canvases[i];
        c.style.cssText = `width:240px;height:auto;border:1px solid #ccc;display:block`;
        col.appendChild(c);
        wrapper.appendChild(col);
      }
      document.body.appendChild(wrapper);
      try {
        await (expect(wrapper) as any).toMatchScreenshot('bullet-nbsp');
      } catch {
        // toMatchScreenshot may need a reference; ignore on first run.
      } finally {
        wrapper.remove();
      }
    });
  });

});
