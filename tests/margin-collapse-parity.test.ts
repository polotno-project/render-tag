/**
 * Block margin collapsing against the real DOM (CSS 2.1 §8.3.1).
 *
 * Each case is laid out twice — by the browser inside an absolutely positioned
 * wrapper (a block formatting context root, like the native capture harness's
 * `overflow:hidden` content div and like render-tag's own root), and by
 * render-tag. Every element's border-box top and height, and the total
 * content height, must match the browser's own numbers.
 *
 * Text uses a px line-height so the line box is the same integer in every
 * engine; only the margins are under test.
 */
import { describe, it, expect } from 'vitest';
import { layout } from '../src/index.ts';
import type { LayoutBox, LayoutNode } from '../src/types.ts';

const WIDTH = 300;
const ROOT = 'font-family:sans-serif;font-size:16px;line-height:20px';

interface Geometry { tag: string; top: number; height: number }

function domGeometry(html: string): { boxes: Geometry[]; height: number } {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;left:-9999px;top:0;width:${WIDTH}px;margin:0;padding:0;`;
  wrap.innerHTML = `<div style="${ROOT}">${html}</div>`;
  document.body.appendChild(wrap);
  const origin = wrap.getBoundingClientRect().top;
  // render-tag turns <br> into a newline, not a box. Inline boxes are text
  // runs on its side; only block-level boxes are compared.
  const boxes = [...wrap.querySelectorAll(':not(br)')].filter((el) =>
    getComputedStyle(el).display !== 'none' && !getComputedStyle(el).display.startsWith('inline'),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), top: r.top - origin, height: r.height };
  });
  const height = wrap.getBoundingClientRect().height;
  wrap.remove();
  return { boxes, height };
}

function blockBoxes(node: LayoutNode, out: Geometry[] = []): Geometry[] {
  if (node.type !== 'box') return out;
  if (node.style.display.startsWith('inline')) return out;
  out.push({ tag: node.tagName, top: node.y, height: node.height });
  for (const child of (node as LayoutBox).children) blockBoxes(child, out);
  return out;
}

function canvasGeometry(html: string): { boxes: Geometry[]; height: number } {
  const result = layout({ html: `<div style="${ROOT}">${html}</div>`, width: WIDTH });
  // Drop the synthetic root container; the browser's wrapper stands for it.
  const boxes = blockBoxes(result.layoutRoot).slice(1);
  return { boxes, height: result.height };
}

const CASES: Record<string, string> = {
  // The "Non-Latin text alignment" shape: the last <p>'s bottom margin
  // collapses through a plain div with the next sibling's top margin.
  'last child bottom margin collapses through a plain div':
    '<div><p>a</p><p>b</p></div><p>c</p>',
  // The "Pre-wrap preserved whitespace" shape.
  'an empty <p> collapses through itself':
    '<p>a</p><p></p><p>b</p>',
  'first child top margin collapses through a plain div':
    '<p>a</p><div style="margin-top:10px"><p style="margin-top:30px">b</p></div>',
  'first child of the root container stays inside it':
    '<p style="margin-top:24px">a</p>',
  'nested first and last children collapse through several levels':
    '<p>a</p><div><div><p style="margin:40px 0">b</p></div></div><p>c</p>',
  'blockquote > h1 collapses with the blockquote margins':
    '<p>a</p><blockquote><h1>b</h1><p>c</p></blockquote><p>d</p>',
  'ul > li > p collapses through the li and ul':
    '<p>a</p><ul><li><p>b</p></li><li><p>c</p></li></ul><p>d</p>',
  'padding-top stops the first child collapse':
    '<p>a</p><div style="padding-top:5px"><p>b</p></div>',
  'border-top stops the first child collapse':
    '<p>a</p><div style="border-top:3px solid red"><p>b</p></div>',
  'padding-bottom stops the last child collapse':
    '<div style="padding-bottom:5px"><p>a</p></div><p>b</p>',
  'border-bottom stops the last child collapse':
    '<div style="border-bottom:3px solid red"><p>a</p></div><p>b</p>',
  // CSS 2.1 makes the last-child collapse depend on an 'auto' height, not on
  // min-height: the margins still leave the box when min-height raises it.
  'a min-height below the content height':
    '<div style="min-height:10px"><p>a</p></div><p>b</p>',
  'a min-height equal to the content height':
    '<div style="min-height:20px"><p>a</p></div><p>b</p>',
  'a min-height between the content and its trailing margin':
    '<div style="min-height:30px"><p>a</p></div><p>b</p>',
  'a min-height above the content height, larger child margin':
    '<div style="min-height:80px"><p style="margin-bottom:40px">a</p></div><p>b</p>',
  'overflow:hidden establishes a BFC':
    '<p>a</p><div style="overflow:hidden"><p>b</p></div><p>c</p>',
  'display:flow-root establishes a BFC':
    '<p>a</p><div style="display:flow-root"><p>b</p></div><p>c</p>',
  'a flex item keeps its first child margin inside':
    '<p>a</p><div style="display:flex"><div><p>b</p></div></div><p>c</p>',
  'text before a block child stops the first child collapse':
    '<div style="margin-top:10px">t<p>b</p></div>',
  'negative and positive margins: max positive plus min negative':
    '<p style="margin-bottom:10px">a</p>' +
    '<div style="margin-top:-5px"><p style="margin-top:20px">b</p></div>',
  'two negative margins: the most negative wins':
    '<p style="margin-bottom:-10px">a</p><div style="margin-top:-4px"><p style="margin-top:-8px">b</p></div>',
  'negative margin on the last child collapses out':
    '<div><p style="margin-bottom:-12px">a</p></div><p style="margin-top:4px">b</p>',
  'empty blocks with nested empty children collapse through':
    '<p>a</p><div style="margin:30px 0"><div style="margin:50px 0"></div><div></div></div><p>b</p>',
  'an empty first child lets the next child collapse with the parent':
    '<p>a</p><div><div style="margin-bottom:24px"></div><p style="margin-top:8px">b</p></div>',
  'an empty last child carries its margin out of the parent':
    '<div><p>a</p><div style="margin-top:40px"></div></div><p>b</p>',
  'an empty block with padding does not collapse through':
    '<p>a</p><div style="padding-bottom:2px"></div><p>b</p>',
  'an empty block with min-height does not collapse through':
    '<p>a</p><div style="min-height:6px"></div><p>b</p>',
  // <br> makes a line box, so this <p> is not empty.
  'a <p> holding only a <br> does not collapse through':
    '<p>a</p><p><br></p><p>b</p>',
  'a whitespace-only <p> collapses through itself':
    '<p>a</p><p> </p><p>b</p>',
  // The outside marker gives an empty <li> a line box of its own.
  'an empty <li> in a list':
    '<ul><li>a</li><li></li><li>b</li></ul>',
  'an empty <li> without a marker collapses through':
    '<ul style="list-style:none"><li style="margin:6px 0">a</li><li style="margin:30px 0"></li><li>b</li></ul>',
  'an empty block with a border does not collapse through':
    '<p>a</p><div style="border-top:1px solid red"></div><p>b</p>',
  // A line box needs content: an empty inline makes none, so the <p> holding
  // it collapses through. Inline-axis padding, border or margin, or an atomic
  // inline, makes one — even at zero size.
  'a <p> holding only an empty inline collapses through':
    '<p>a</p><p><span></span></p><p>b</p>',
  'an empty inline with horizontal padding makes a line box':
    '<p>a</p><p><span style="padding:0 3px"></span></p><p>b</p>',
  'an empty inline with a left margin makes a line box':
    '<p>a</p><p><span style="margin-left:4px"></span></p><p>b</p>',
  'an empty inline with a vertical border only makes no line box':
    '<p>a</p><p><span style="border-top:3px solid red"></span></p><p>b</p>',
  'an empty inline-block makes a line box':
    '<p>a</p><p><span style="display:inline-block"></span></p><p>b</p>',
  'a bare empty inline-block between blocks makes a line box':
    '<p>a</p><span style="display:inline-block"></span><p>b</p>',
  // An <li> whose only content collapses through: Blink gives it the
  // marker's line box, WebKit does not. Neither loses the child's margins.
  'an <li> holding only an empty block with margins':
    '<ul><li>a</li><li><div style="margin:10px 0"></div></li><li>b</li></ul>',
  // Not covered: `list-style-position: inside` is not supported at all. Its
  // marker is an inline that makes a line box of its own and so stops the
  // li > p first-child collapse (DOM: li 70px tall, render-tag 20px).
  'overflow-y:hidden establishes a BFC':
    '<p>a</p><div style="overflow-y:hidden"><p>b</p></div><p>c</p>',
  'overflow-x:auto establishes a BFC':
    '<p>a</p><div style="overflow-x:auto"><p>b</p></div><p>c</p>',
  'a border with style none has no width':
    '<p>a</p><div style="border-top:3px none red"><p>b</p></div>',
  'a display:none block takes no part in margin collapsing':
    '<p>a</p><div style="display:none;margin:100px"></div><p>b</p>',
  'a percentage min-height under an auto-height parent is none':
    '<p>a</p><div style="min-height:50%"><p>b</p></div><p>c</p>',
};

describe('margin collapsing matches the DOM', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(name, () => {
      const dom = domGeometry(html);
      const canvas = canvasGeometry(html);
      const round = (g: Geometry) => `${g.tag} y=${g.top.toFixed(2)} h=${g.height.toFixed(2)}`;
      const both = `DOM ${dom.boxes.map(round).join(' | ')}; canvas ${canvas.boxes.map(round).join(' | ')}`;
      expect(canvas.boxes.map((b) => b.tag), both).toEqual(dom.boxes.map((b) => b.tag));
      expect(canvas.boxes.map(round), both).toEqual(dom.boxes.map(round));
      expect(canvas.height).toBeCloseTo(dom.height, 2);
    });
  }
});
