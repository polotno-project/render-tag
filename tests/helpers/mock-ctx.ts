/**
 * Shared fixed-width mock canvas context for DOM-free tests: every character
 * is `charWidth` px wide (CHAR_WIDTH by default), letter-spacing adds after
 * every character, trailing included: `measureText` grows by one spacing for
 * a 1-char string and three for a 3-char one in Chromium, Firefox and WebKit
 * alike. The spacing is uniform, which is where the mock stops being
 * faithful: Chrome applies none inside a cursive Arabic run. Ascent 12 and
 * descent 4 at every font size.
 */

export const CHAR_WIDTH = 10;
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function mockCtx(charWidth = CHAR_WIDTH): CanvasRenderingContext2D {
  const ctx = {
    font: '',
    fontKerning: 'normal',
    letterSpacing: '0px',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    measureText(text: string) {
      const ls = parseFloat((ctx as any).letterSpacing) || 0;
      // Bidi controls (an RTL override's RLO…PDF) draw nothing.
      const n = text.replace(BIDI_CONTROLS, '').length;
      const width = n * charWidth + n * ls;
      return {
        width,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
    fillText() {},
    strokeText() {},
    save() {},
    restore() {},
    scale() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    getImageData() { return { data: new Uint8ClampedArray(0), width: 0, height: 0 }; },
    putImageData() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}
