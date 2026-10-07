/**
 * Which engine branch a user agent selects.
 *
 * Blink is the DEFAULT: a server-side render targets headless Chrome, so
 * anything render-tag cannot positively identify must round the way Chrome
 * does. Only Gecko and Safari opt out. jsdom is the trap this pins — it
 * borrows WebKit's UA verbatim and read naively looks exactly like Safari,
 * which would make a Node export stand up to 1px off the canvas it mirrors.
 *
 * The flags are module-level consts, so each case re-imports the module with
 * its own navigator.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADLESS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36';
const FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const JSDOM = 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.0.1';
const NODE = 'Node.js/25.6.1';

function stubUA(userAgent: string | null): void {
  vi.resetModules();
  if (userAgent === null) vi.stubGlobal('navigator', undefined);
  else vi.stubGlobal('navigator', { userAgent });
}

async function engineUnder(userAgent: string | null) {
  stubUA(userAgent);
  return import('../../src/engine.ts');
}

async function layoutUnder(userAgent: string | null) {
  stubUA(userAgent);
  return import('../../src/layout.ts');
}

afterEach(() => vi.unstubAllGlobals());

describe('engine branch', () => {
  it.each([
    ['Chrome', CHROME, true],
    ['headless Chrome', HEADLESS, true],
    ['jsdom', JSDOM, true],
    ['Node', NODE, true],
    ['no navigator', null, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, true],
  ] as const)('%s floors the line baseline: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).FLOORS_LINE_BASELINE).toBe(expected);
  });

  // A separate question from the floor: only WebKit lays a line box out at a
  // whole-pixel line-height. Gecko and Blink keep the fraction.
  it.each([
    ['Chrome', CHROME, false],
    ['headless Chrome', HEADLESS, false],
    ['jsdom', JSDOM, false],
    ['Node', NODE, false],
    ['no navigator', null, false],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, true],
  ] as const)('%s truncates the line-height: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).TRUNCATES_LINE_HEIGHT).toBe(expected);
  });

  // A single-paint bidi line stays one fillText where the engine's Canvas
  // lays it out like its DOM (Blink, measured; Gecko, its old path,
  // unmeasured). WebKit's Canvas does not, so WebKit gets ordered level runs.
  it.each([
    ['Chrome', CHROME, true],
    ['headless Chrome', HEADLESS, true],
    ['jsdom', JSDOM, true],
    ['Node', NODE, true],
    ['no navigator', null, true],
    ['Firefox', FIREFOX, true],
    ['Safari', SAFARI, false],
  ] as const)('%s paints a single-paint bidi line as one run: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).CANVAS_BIDI_LINE).toBe(expected);
  });

  // Margins leaving a block with a min-height: three engine answers. Gecko's
  // is render-tag's pre-existing rule, not a measurement (Firefox cannot run
  // here).
  it.each([
    ['Chrome', CHROME, 'drop'],
    ['headless Chrome', HEADLESS, 'drop'],
    ['jsdom', JSDOM, 'drop'],
    ['no navigator', null, 'drop'],
    ['Firefox', FIREFOX, 'contain'],
    ['Safari', SAFARI, 'collapse'],
  ] as const)('%s min-height end margins: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).MIN_HEIGHT_END_MARGINS).toBe(expected);
  });

  // Blink keeps the fraction on its 1/64px grid; WebKit's whole-pixel
  // truncation is a separate flag; Gecko is not modelled.
  it.each([
    ['Chrome', CHROME, true],
    ['Node', NODE, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, false],
  ] as const)('%s keeps line-height on the LayoutUnit grid: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).LAYOUT_UNIT_LINE_HEIGHT).toBe(expected);
  });

  // Paint, not layout: Blink paints each line box at a whole CSS pixel.
  // WebKit snaps to a DEVICE pixel instead (not modelled); Gecko is unmeasured
  // and keeps the unsnapped paint.
  it.each([
    ['Chrome', CHROME, true],
    ['headless Chrome', HEADLESS, true],
    ['jsdom', JSDOM, true],
    ['Node', NODE, true],
    ['no navigator', null, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, false],
  ] as const)('%s snaps line paint: %s -> %s', async (_name, ua, expected) => {
    const layout = await layoutUnder(ua);
    expect((await import('../../src/engine.ts')).SNAPS_LINE_PAINT).toBe(expected);
    // A run on a line whose top is 10.3 paints 0.3px higher in Blink.
    const run = { type: 'text', text: 'a', x: 0, y: 27.3, width: 1, style: {} } as never;
    expect(layout.paintLineSnap(run)).toBeCloseTo(expected ? -0.3 : 0, 9);
  });

  // A separate question from the snap: where Blink hangs the auto underline
  // below it. WebKit hangs it off its own thickness instead (src/decoration.ts).
  it.each([
    ['Chrome', CHROME, true],
    ['Node', NODE, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, false],
  ] as const)('%s uses Blink\'s underline gap: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).BLINK_UNDERLINE_GAP).toBe(expected);
  });

  // Whose decoration painter (thickness, positions, double/dotted/dashed/wavy
  // shapes) to imitate. Gecko is unmeasured and keeps the older shapes.
  it.each([
    ['Chrome', CHROME, 'blink'],
    ['headless Chrome', HEADLESS, 'blink'],
    ['jsdom', JSDOM, 'blink'],
    ['Node', NODE, 'blink'],
    ['no navigator', null, 'blink'],
    ['Firefox', FIREFOX, 'gecko'],
    ['Safari', SAFARI, 'webkit'],
  ] as const)('%s paints decorations like: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).ENGINE).toBe(expected);
  });

  // The public helper other renderers call must follow the same rule: in
  // WebKit a 25.6px line is 25px, so its baseline is floor((25 - 22) / 2) + 17.
  it.each([
    ['Chrome', CHROME, 18],
    ['Firefox', FIREFOX, 18.8],
    ['Safari', SAFARI, 18],
  ] as const)('%s lineBaselineOffset(25.6, 17, 5) -> %s', async (_name, ua, expected) => {
    expect((await layoutUnder(ua)).lineBaselineOffset(25.6, 17, 5)).toBeCloseTo(expected, 9);
  });

  // Blink halves a negative leading in LayoutUnits, truncating toward zero,
  // before the floor: a line one 64th short of its 17px content area keeps
  // the ascent (Verdana 13.6px x 1.25 = 16.984375 over 14 + 3), where the
  // exact half (-1/128) would floor a whole pixel higher. WebKit's line is
  // whole pixels, Gecko's exact.
  it.each([
    ['Chrome', CHROME, 14],
    ['Firefox', FIREFOX, 14 - 1 / 128],
    ['Safari', SAFARI, 13],
  ] as const)('%s lineBaselineOffset(16.984375, 14, 3) -> %s', async (_name, ua, expected) => {
    expect((await layoutUnder(ua)).lineBaselineOffset(16.984375, 14, 3)).toBeCloseTo(expected, 9);
  });

  // A percentage line-height is an integer percentage outside Gecko.
  it.each([
    ['Chrome', CHROME, true],
    ['Node', NODE, true],
    ['Firefox', FIREFOX, false],
    ['Safari', SAFARI, true],
  ] as const)('%s truncates a line-height percentage: %s -> %s', async (_name, ua, expected) => {
    expect((await engineUnder(ua)).INTEGER_PERCENT_LINE_HEIGHT).toBe(expected);
  });
});
