Investigate and fix text-rendering inconsistencies in Polotno across the editor and PNG/JPEG, PDF, HTML, and SVG exports.

A render-tag update is required: use `render-tag@0.1.36` or a later version containing these shadow fixes. The source is in the sibling `../render-tag` repository. Check the dependency and lockfile resolutions actually used by the editor, Node rendering, and PDF export. Updating the dependency is a prerequisite, not proof that all integration issues are resolved.

Relevant render-tag behavior to guide the investigation:

- The API still uses the existing drawing functions and Canvas-like contexts. The only added drawing options are `createCanvas` and `renderShadows`; there is no shadow-layer callback or preparation API.
- CSS `text-shadow` paints behind the combined text fill, stroke, and decorations, above box backgrounds. It excludes those backgrounds from its source. Its offsets and blur use layout coordinates and transform with the text.
- A caller-supplied `ctx.shadow*` casts one shadow from the completed rendering, including backgrounds and CSS shadows. Its offsets and blur retain Canvas device-pixel semantics. Using both kinds produces both effects, so examine any overlapping shadow handling in Polotno and its exporters.
- Only the shadow effect is rasterized. Foreground text, strokes, and decorations remain drawing commands. Shadow buffering does not require rasterizing the PDF foreground.
- `createCanvas(width, height)` supplies real scratch canvases and is required for shadows outside browsers. With shadows enabled, a destination proxy needs compatible Canvas image and transform operations, including `drawImage`, `getTransform`, and `setTransform`. The existing PDF proxy is not yet verified against this contract.
- Drawing remains synchronous. Any adapter that embeds images asynchronously must preserve the intended paint order.
- `renderShadows: false` omits both CSS and context shadows and needs no shadow buffers or image/transform-query APIs. It is an explicit opt-out, not a visual fix: another renderer must supply any omitted effects.

Use these as library-contract facts, not as a prescribed Polotno implementation. Read render-tag's README and inspect the actual integration before deciding what belongs where. Check HTML and SVG behavior independently. Shared shadow logic does not guarantee identical font antialiasing or blur pixels across engines.

The reported case is a large Bevan “Header” with a vertical purple gradient, a thick pale outline, and a centered magenta glow. Safari shows an oversized glow and a displaced or duplicated shadow below the text. A solid fill looks better. Chrome is closer, but its screenshot should not be treated as the ideal result: shadows must not tint an opaque outline.

Expected behavior:

- The shadow follows the visible text silhouette, including its stroke and decorations, and stays behind the foreground.
- Adding a shadow must not repaint the foreground, darken an opaque stroke, change the text geometry, or unexpectedly change foreground opacity.
- Solid and equivalent gradient fills produce equivalent shadow shapes. Transparent fills and strokes retain their intended transparency.
- Shadows remain correctly positioned and unclipped through zoom, export resolution changes, element scaling, rotation, and negative or positive offsets.
- The same design has consistent appearance in the editor and every export format. Preserve vector text, strokes, and decorations in PDF where supported. Any effects that require raster output must not silently rasterize the entire text element or disappear.

Start with this reproduction (load Bevan before comparing):

```json
{
  "width": 1280,
  "height": 720,
  "fonts": [],
  "pages": [
    {
      "id": "shadow-page",
      "children": [
        {
          "id": "shadow-header",
          "type": "text",
          "name": "text-1",
          "opacity": 1,
          "visible": true,
          "x": 123.331707,
          "y": 180.569157,
          "width": 1100.607559,
          "height": 264,
          "rotation": 0,
          "text": "Header",
          "fontSize": 220,
          "fontFamily": "Bevan",
          "fontStyle": "normal",
          "fontWeight": "700",
          "textDecoration": "",
          "textTransform": "none",
          "fill": "linear-gradient(0deg, rgba(144,19,254,1) 0%,rgba(20,13,26,1) 100%)",
          "align": "center",
          "verticalAlign": "top",
          "strokeWidth": 27,
          "stroke": "rgba(220,186,186,1)",
          "strokeLineJoin": "round",
          "lineHeight": 1.2,
          "letterSpacing": 0,
          "shadowEnabled": true,
          "shadowBlur": 24,
          "shadowOffsetX": 0,
          "shadowOffsetY": 0,
          "shadowColor": "rgba(189,16,224,1)",
          "shadowOpacity": 1,
          "backgroundEnabled": false,
          "curveEnabled": false,
          "blurEnabled": false
        }
      ],
      "width": "auto",
      "height": "auto",
      "background": "white",
      "bleed": 0,
      "duration": 5000
    }
  ],
  "audios": [],
  "unit": "px",
  "dpi": 72,
  "schemaVersion": 4
}
```

Reproduce in current Chrome, Safari, and Firefox at multiple zoom levels and pixel ratios. Compare both the editor and exports, including solid-fill and shadow-disabled controls. Check opaque and translucent fills/strokes, multiple styled runs, overlapping letters, decorations, curved text, and backgrounds.

Also investigate whether shadow direction, blur extent, opacity, and background participation differ between the editor and exports, especially when rotation and nonzero offsets are combined. These are audit targets; verify them rather than assuming every renderer has the same defect.

Identify the root causes and establish the intended visual behavior before choosing a fix. Add regressions that cover browser rendering and export parity, verify that PDF foreground text remains vector where expected, and report any unsupported cases or unavoidable rendering differences explicitly. Keep unrelated layout and editing behavior stable.
