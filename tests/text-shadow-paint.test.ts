import { beforeAll, describe, expect, it } from 'vitest';
import { render, layout, drawLayout } from '../src/index.ts';
import { drawTextOnPath } from '../src/path/index.ts';
import fontUrl from '@fontsource-variable/arimo/files/arimo-latin-wght-normal.woff2?url';

beforeAll(async () => {
  const font = new FontFace('ShadowFixture', `url(${fontUrl})`, { weight: '100 900' });
  document.fonts.add(await font.load());
});

function draw(gradient: boolean, scale: number, shadow = true) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 600;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(60, 60);
  if (shadow) {
    ctx.shadowColor = 'rgb(189, 16, 224)';
    ctx.shadowBlur = 12 * scale;
  }
  render({
    html: `<div style="font-size: 100px; font-weight: bold; font-family: ShadowFixture; line-height: 1.2;
      -webkit-text-stroke: 14px rgb(220, 186, 186); paint-order: stroke fill;
      ${gradient ? 'color: transparent; background-image: linear-gradient(0deg, blue, blue); background-clip: text;' : 'color: blue;'}">Header</div>`,
    width: 500,
    ctx,
  });
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function inkBounds(image: ImageData, shadowOnly = false) {
  let top = image.height, bottom = -1, left = image.width, right = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 64) continue;
      if (shadowOnly && (image.data[i] < 150 || image.data[i + 1] > 50 || image.data[i + 2] < 150)) continue;
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      left = Math.min(left, x); right = Math.max(right, x);
    }
  }
  return { top, bottom, left, right };
}

describe('text shadows', () => {
  for (const scale of [1, 1.6]) {
    it(`a uniform gradient has the same shadow footprint as a solid fill at scale ${scale}`, () => {
      const solid = inkBounds(draw(false, scale));
      const gradient = inkBounds(draw(true, scale));
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        expect(Math.abs(gradient[side] - solid[side]), `${side}: ${JSON.stringify({ solid, gradient })}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('does not paint the fill shadow over an opaque stroke', () => {
    const plain = draw(false, 1, false).data;
    const shadow = draw(false, 1).data;
    let strokePixels = 0;
    let changedStrokePixels = 0;
    for (let i = 0; i < plain.length; i += 4) {
      if (plain[i] !== 220 || plain[i + 1] !== 186 || plain[i + 2] !== 186 || plain[i + 3] !== 255) continue;
      strokePixels++;
      if (Math.abs(shadow[i] - 220) > 1 || Math.abs(shadow[i + 1] - 186) > 1 || Math.abs(shadow[i + 2] - 186) > 1) changedStrokePixels++;
    }
    expect(strokePixels).toBeGreaterThan(100);
    expect(changedStrokePixels).toBe(0);
  });
});

function cssText(style: string, text = 'Header') {
  return `<div style="font-size:60px;font-family:ShadowFixture;font-weight:bold;line-height:1.4;${style}">${text}</div>`;
}

function surface() {
  const canvas = document.createElement('canvas');
  canvas.width = 700; canvas.height = 420;
  return canvas.getContext('2d')!;
}

function pixels(ctx: CanvasRenderingContext2D) {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
}

function expectSameImage(a: Uint8ClampedArray, e: Uint8ClampedArray, tolerance = 2) {
  // Compare premultiplied channels: unpremultiplication magnifies 1-level
  // rounding in faint shadow pixels. Different image extents may round the
  // browser's blur by one level; visible composition must still agree.
  let maxDifference = 0;
  for (let i = 0; i < a.length; i += 4) {
    maxDifference = Math.max(maxDifference, Math.abs(a[i + 3] - e[i + 3]));
    for (let c = 0; c < 3; c++) {
      maxDifference = Math.max(maxDifference, Math.abs(a[i + c] * a[i + 3] / 255 - e[i + c] * e[i + 3] / 255));
    }
  }
  expect(maxDifference).toBeLessThanOrEqual(tolerance);
}

function expectOpaquePaintUnchanged(plain: Uint8ClampedArray, shadowed: Uint8ClampedArray) {
  let opaque = 0, changed = 0;
  for (let i = 0; i < plain.length; i += 4) {
    if (plain[i + 3] !== 255) continue;
    opaque++;
    if ([0, 1, 2].some(c => Math.abs(plain[i + c] - shadowed[i + c]) > 1)) changed++;
  }
  expect(opaque).toBeGreaterThan(100);
  expect(changed).toBe(0);
}

for (const curved of [false, true]) {
  const paint = (ctx: CanvasRenderingContext2D, style: string, text = 'Header', renderShadows?: boolean) => {
    if (curved) {
      drawTextOnPath({ctx, html: cssText(style, text), path: 'M30,150 Q240,20 520,150', renderShadows});
    } else {
      ctx.save(); ctx.translate(35, 60);
      render({ctx, html: cssText(style, text), width: 550, renderShadows});
      ctx.restore();
    }
  };

  describe(curved ? 'curved shadow composition' : 'straight shadow composition', () => {
    for (const failFirst of [false, true]) {
      it(`restores emulated proxy shadows across calls, image failure=${failFirst}`, () => {
        const shadowState = { shadowColor: 'magenta', shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 10 };
        let images = 0;
        // Vector proxies can keep shadow properties outside their graphics-state
        // save/restore stack. Forward other operations to a real canvas here.
        const ctx = new Proxy(surface(), {
          get(target, key) {
            if (key in shadowState) return Reflect.get(shadowState, key);
            if (key === 'drawImage') return (...args: any[]) => {
              images++;
              if (failFirst && images === 1) throw new Error('Image output failed');
              return (target.drawImage as Function).apply(target, args);
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, key, value) {
            return key in shadowState ? Reflect.set(shadowState, key, value) : Reflect.set(target, key, value, target);
          },
        });
        for (let call = 0; call < 2; call++) {
          let error = '';
          try { paint(ctx, 'color:blue;-webkit-text-stroke:4px beige'); }
          catch (caught) { error = (caught as Error).message; }
          expect(error).toBe(failFirst && call === 0 ? 'Image output failed' : '');
          expect(ctx.shadowColor).toBe('magenta');
          expect(ctx.shadowBlur).toBe(12);
          expect(images).toBe(call + 1);
        }
      });
    }

    it('adding a distant caller shadow does not change foreground opacity', () => {
      const style = 'color:blue;-webkit-text-stroke:12px red;paint-order:stroke fill';
      const plain = surface(), actual = surface();
      plain.globalAlpha = .6; actual.globalAlpha = .6;
      paint(plain, style);
      actual.shadowColor = 'magenta'; actual.shadowOffsetY = 800;
      paint(actual, style);
      expectSameImage(pixels(actual), pixels(plain));
    });

    it('can omit both kinds of shadow without changing foreground pixels', () => {
      const style = 'color:rgba(0,0,255,.4);-webkit-text-stroke:8px beige;paint-order:stroke fill;text-decoration:underline';
      const plain = surface(); paint(plain, style);
      const actual = surface();
      actual.shadowColor = 'magenta'; actual.shadowBlur = 20;
      paint(actual, style + ';text-shadow:30px 30px 20px green', 'Header', false);
      expectSameImage(pixels(actual), pixels(plain));
      expect(actual.shadowBlur).toBe(20);
      expect(actual.shadowColor).toBe('#ff00ff');
    });

    it('gives scaled CSS gradient and solid text the same shadow footprint', () => {
      const solid = surface(), gradient = surface();
      for (const ctx of [solid, gradient]) ctx.scale(1.6, 1.6);
      const style = 'text-shadow:0 0 12px magenta;-webkit-text-stroke:8px beige;paint-order:stroke fill;';
      paint(solid, style + 'color:blue');
      paint(gradient, style + 'color:transparent;background-clip:text;background-image:linear-gradient(0deg,blue,blue)');
      const a = inkBounds(solid.getImageData(0, 0, 700, 420), true);
      const b = inkBounds(gradient.getImageData(0, 0, 700, 420), true);
      for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(Math.abs(a[side] - b[side]), `${side}: ${JSON.stringify({solid:a, gradient:b})}`).toBeLessThanOrEqual(1);
    });

    it('casts the caller shadow from one completed rendering', () => {
      const style = 'color:rgba(0,0,255,.5);-webkit-text-stroke:12px rgba(255,0,0,.5);paint-order:stroke fill';
      const source = surface(); paint(source, style, '<b>He</b>ader');
      const expected = surface();
      expected.shadowColor = 'rgba(0,200,0,.8)'; expected.shadowBlur = 12;
      expected.shadowOffsetX = 1000 - 8; expected.shadowOffsetY = 10;
      expected.drawImage(source.canvas, -1000, 0);
      expected.shadowColor = 'transparent';
      paint(expected, style, '<b>He</b>ader');
      const actual = surface();
      actual.shadowColor = 'rgba(0,200,0,.8)'; actual.shadowBlur = 12;
      actual.shadowOffsetX = -8; actual.shadowOffsetY = 10;
      paint(actual, style, '<b>He</b>ader');
      expectSameImage(pixels(actual), pixels(expected));
    });

    it('CSS shadows never paint over opaque foreground in another run', () => {
      const style = 'color:blue;-webkit-text-stroke:12px rgb(220,186,186);paint-order:stroke fill;letter-spacing:-6px';
      const plain = surface(); paint(plain, style, '<b>He</b>ader');
      const actual = surface(); paint(actual, style + ';text-shadow:-16px 0px 12px magenta', '<b>He</b>ader');
      expectOpaquePaintUnchanged(pixels(plain), pixels(actual));
    });

    it('does not repaint translucent text for every CSS shadow', () => {
      const style = 'color:rgba(0,0,255,.4)';
      const plain = surface(); paint(plain, style);
      const actual = surface(); paint(actual, style + ';text-shadow:0px 180px 0px red,0px 240px 0px green');
      const p = pixels(plain), a = pixels(actual);
      let compared = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] < 50) continue;
        compared++;
        expect(a[i + 3]).toBe(p[i + 3]);
      }
      expect(compared).toBeGreaterThan(100);
    });

    it('includes decorations in CSS shadows', () => {
      const style = 'color:blue;text-decoration:underline;text-underline-offset:25px;text-decoration-thickness:6px';
      const plain = surface(); paint(plain, style);
      const actual = surface(); paint(actual, style + ';text-shadow:0px 180px 0px red');
      const p = pixels(plain), a = pixels(actual);
      let missing = 0, compared = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 700; x++) {
        const i = (y * 700 + x) * 4;
        if (p[i + 3] !== 255) continue;
        compared++;
        const j = ((y + 180) * 700 + x) * 4;
        if (a[j] < 250 || a[j + 3] < 250) missing++;
      }
      expect(compared).toBeGreaterThan(100);
      expect(missing).toBe(0);
    });

    it('paints the first CSS shadow on top and resolves currentColor', () => {
      const first = surface(); paint(first, 'color:blue;text-shadow:0 180px 0 currentColor');
      const stack = surface(); paint(stack, 'color:blue;text-shadow:0 180px 0,0 180px 0 red');
      const a = pixels(first), b = pixels(stack);
      let compared = 0;
      for (let y = 200; y < 400; y++) for (let x = 0; x < 700; x++) {
        const i = (y * 700 + x) * 4;
        if (a[i + 3] !== 255) continue;
        compared++;
        expect([...b.slice(i, i + 4)]).toEqual([0, 0, 255, 255]);
      }
      expect(compared).toBeGreaterThan(100);
    });

    it('preserves caller transforms, clipping, opacity and compositing', () => {
      const style = 'color:transparent;background-clip:text;background-image:linear-gradient(0deg,blue,red);-webkit-text-stroke:8px beige;paint-order:stroke fill';
      const source = surface();
      source.setTransform(-1.1, .15, .2, .8, 580.25, 40.5);
      paint(source, style);
      const expected = surface(), actual = surface();
      for (const ctx of [expected, actual]) {
        ctx.fillStyle = '#eeddcc'; ctx.fillRect(0, 0, 700, 420);
        ctx.beginPath(); ctx.rect(100, 40, 470, 320); ctx.clip();
        ctx.globalAlpha = .6;
        ctx.globalCompositeOperation = 'multiply';
        ctx.shadowColor = 'rgba(0,200,0,.8)'; ctx.shadowBlur = 16;
        ctx.shadowOffsetX = -12; ctx.shadowOffsetY = 24;
      }
      // Native Canvas reference: one shadow of the completed source, followed
      // by the normal foreground commands at the caller's opacity/blend mode.
      expected.shadowOffsetX += 1000;
      expected.drawImage(source.canvas, -1000, 0);
      expected.shadowColor = 'transparent';
      expected.setTransform(-1.1, .15, .2, .8, 580.25, 40.5);
      paint(expected, style);
      actual.setTransform(-1.1, .15, .2, .8, 580.25, 40.5);
      const transform = actual.getTransform().toString();
      const opacity = actual.globalAlpha;
      paint(actual, style);
      expect(actual.getTransform().toString()).toBe(transform);
      expect(actual.globalAlpha).toBe(opacity);
      expect(actual.globalCompositeOperation).toBe('multiply');
      expect(actual.shadowBlur).toBe(16);
      // Rasterizing the shadow adds an 8-bit rounding step before opacity and
      // multiply blending; Firefox differs from its native shadow by up to 3.
      expectSameImage(pixels(actual), pixels(expected), 3);
    });

    it('scales and rotates CSS shadow offsets with the whole text', () => {
      const plain = surface(), actual = surface();
      for (const ctx of [plain, actual]) ctx.setTransform(0, 1, -1, 0, 650, 10);
      paint(plain, 'color:blue');
      paint(actual, 'color:blue;text-shadow:180px 0 0 red');
      const p = pixels(plain), a = pixels(actual);
      let compared = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 700; x++) {
        const i = (y * 700 + x) * 4;
        if (p[i + 3] !== 255) continue;
        const j = ((y + 180) * 700 + x) * 4;
        // Exclude places covered by the actual foreground.
        if (p[j + 3]) continue;
        compared++;
        expect([...a.slice(j, j + 4)]).toEqual([255, 0, 0, 255]);
      }
      expect(compared).toBeGreaterThan(100);
    });
  });
}

it('a distant CSS shadow preserves overlapping sibling backgrounds and text', () => {
  const paint = (ctx: CanvasRenderingContext2D, shadow: boolean) => {
    ctx.translate(20, 40);
    render({ ctx, width: 400, html: `<div style="font-size:80px;font-family:ShadowFixture;line-height:.5;color:blue;
      ${shadow ? 'text-shadow:0 2000px 0 red' : ''}">
      <div>Hg</div><div style="background-color:yellow">Ab</div></div>` });
  };
  const plain = surface(), actual = surface();
  paint(plain, false); paint(actual, true);
  expectSameImage(pixels(actual), pixels(plain), 0);
});

for (const [align, direction, spacing] of [
  ['right', 'ltr', false], ['center', 'ltr', false],
  ['start', 'rtl', false], ['end', 'ltr', false],
  ['left', 'ltr', true],
] as const) {
  it(`caller shadow bounds retain inherited ${align}/${direction} alignment and spacing=${spacing}`, () => {
    // Measure separately so drawLayout receives the exact inherited paint state.
    const result = layout({ html: cssText('color:blue;white-space:nowrap', spacing ? 'WWW WWW' : 'Header'), width: 100 });
    const paint = (ctx: CanvasRenderingContext2D) => {
      ctx.save();
      ctx.translate(spacing ? 20 : 320, 30);
      ctx.textAlign = align; ctx.direction = direction;
      ctx.letterSpacing = spacing ? '30px' : '0px';
      ctx.wordSpacing = spacing ? '35px' : '0px';
      drawLayout({ layout: result, width: 100, ctx });
      ctx.restore();
    };
    const source = surface(); paint(source);
    const expected = surface();
    expected.shadowColor = 'red'; expected.shadowOffsetX = 1000; expected.shadowOffsetY = 180;
    expected.drawImage(source.canvas, -1000, 0);
    expected.shadowColor = 'transparent'; paint(expected);
    const actual = surface();
    actual.shadowColor = 'red'; actual.shadowOffsetY = 180;
    paint(actual);
    expectSameImage(pixels(actual), pixels(expected));
  });
}

it('keeps off-canvas source pixels that cast a visible shadow', () => {
  const ctx = surface();
  ctx.translate(-400, 30);
  ctx.shadowColor = 'red'; ctx.shadowOffsetX = 500;
  render({ ctx, width: 500, html: cssText('color:blue', 'Hi') });
  const a = pixels(ctx);
  let red = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] === 255 && a[i + 3] === 255) red++;
  expect(red).toBeGreaterThan(100);
});

it('uses a supplied scratch-canvas factory only when shadows need it', () => {
  let calls = 0;
  const createCanvas = (width: number, height: number) => {
    calls++;
    return new OffscreenCanvas(width, height);
  };
  const ctx = surface();
  let foregroundCalls = 0;
  const fillText = ctx.fillText.bind(ctx);
  ctx.fillText = (...args) => { foregroundCalls++; fillText(...args); };
  render({ ctx, width: 500, html: cssText('color:blue'), createCanvas });
  expect(calls).toBe(0);
  foregroundCalls = 0;
  ctx.shadowBlur = 10; ctx.shadowColor = 'red';
  render({ ctx, width: 500, html: cssText('color:blue'), createCanvas });
  expect(calls).toBeGreaterThan(0);
  expect(foregroundCalls).toBeGreaterThan(0);
  calls = 0;
  ctx.shadowColor = 'transparent';
  drawTextOnPath({ctx, path: 'M0,100 L500,100', html: cssText('color:blue;text-shadow:0 10px 4px red'), createCanvas});
  expect(calls).toBeGreaterThan(0);
});
