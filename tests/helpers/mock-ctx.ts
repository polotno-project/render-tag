/**
 * Shared fixed-width mock canvas context for DOM-free tests: every character
 * is CHAR_WIDTH px wide, letter-spacing adds after every character (mirrors
 * Chrome canvas, trailing included). Used by layout-logic and the
 * browser/node parity suites so all environments measure identically.
 */

export const CHAR_WIDTH = 10;

export function mockCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '',
    fontKerning: 'normal',
    letterSpacing: '0px',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    measureText(text: string) {
      const ls = parseFloat((ctx as any).letterSpacing) || 0;
      const width = text.length * CHAR_WIDTH + text.length * ls;
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
