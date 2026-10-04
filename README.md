# SlipShop

An image editor that runs entirely in your browser. Layers with 27 blend modes,
masks and clipping, selections with real feathering, a pressure-sensitive brush
engine, 19 adjustments (destructive or as non-destructive layers), 31 filters,
and undo that stores only the tiles you actually painted.

Nothing is uploaded. There is no account and no server doing the work — every
pixel is processed on your own machine.

**Live:** <https://slipshop.slippylabs.com/>

## What it does

- **Layers** — raster, group, adjustment and solid-fill layers; 27 blend modes;
  opacity and fill opacity; layer masks; clipping masks; Blend If ranges.
- **Selections** — rectangle, ellipse, lasso, polygonal lasso and magic wand,
  with add/subtract/intersect/exclude, antialiasing, and Select ▸ Modify
  (Expand, Contract, Feather, Border, Smooth) computed from an exact distance
  field rather than by iterated dilation.
- **Painting** — brush, pencil, eraser, clone stamp, smudge, blur, sharpen,
  dodge and burn. Flow accumulates within a stroke and opacity caps it, which
  are genuinely different things. Stylus pressure and tilt drive size and flow.
- **Adjustments** — Brightness/Contrast, Levels, Curves, Exposure,
  Shadows/Highlights, Hue/Saturation, Vibrance, Colour Balance, White Balance,
  Photo Filter, Channel Mixer, Selective Colour, Colour Lookup (`.cube` LUTs),
  Black & White, Desaturate, Gradient Map, Invert, Posterize, Threshold. Each
  works destructively or as a non-destructive adjustment layer.
- **Filters** — six blurs (including lens bokeh and a bilateral surface blur),
  sharpening, noise, Stylize, Pixelate, six Distort filters with lens
  correction, Render (clouds, fibers), and a custom 3×3 convolution.
- **Transform** — Image Size with five resampling filters, Canvas Size, Crop,
  Trim, rotate and flip.
- **Files** — open PNG, JPEG, WebP, GIF and BMP; export PNG, JPEG and WebP;
  save a layered `.slipshop` project. Autosaves to IndexedDB, so a reload does
  not lose your work.

## How it works

The engine is a **pure pixel core** — `js/core/` has no DOM and no canvas in it
and runs under node. That is what makes it testable: `tools/run_all.sh` runs
eleven oracles over it, and most of them check against something that shares no
code with what it is checking.

Three design decisions carry most of the weight:

**Pixels live in sparse 256×256 tiles, and a missing tile *is* transparent.**
A 6000×4000 document with one brush stroke on a new layer costs two tiles, not
96 MB. Storage is 8- or 16-bit integer; every operation reads a rect out as
float32, works, and writes it back, because rounding to bytes between steps is
what makes a chain of adjustments band.

**Undo stores dirty tiles, not layers.** A 40-pixel dab costs one tile. Undo
and redo are the same swap, so one copy of the changed data serves both
directions. Structural changes — reorder, rename, opacity — are snapshots of
the layer tree with the pixel surfaces held by reference.

**The compositor is the W3C model, applied to a rectangle.** That is how the
viewport repaints only what moved, and it is what makes the tiled and flat
paths comparable — so an oracle can check that compositing a region equals the
same region of a full composite.

## Verification

`tools/run_all.sh` — eleven node oracles. The ones worth knowing about:

| Oracle | Checked against |
| --- | --- |
| `blend` | **The browser's own compositor.** Chromium's canvas implements the same W3C spec `blend.js` is written from, so it is a genuinely independent implementation. Runs on a float16 canvas, because the default 8-bit pipeline computes the product terms in fixed point. |
| `composite` | The browser again, but the whole **layer stack** — groups, masks, opacity and clipping built from `globalAlpha`, `destination-in` and offscreen canvases. |
| `tiles` | A **dense** surface: the same contract implemented with one flat array. A dense array has nowhere to hide a seam. |
| `convolve` | `scipy.ndimage`, with the radius pinned and `correlate` (not `convolve`) chosen deliberately. |
| `color` | `scikit-image`, with **its** constants substituted into our code — it ships an older sRGB matrix and the historical rounded Lab constants, so that is the only version of the comparison that proves anything. |
| `history` | A property: 158 random edits, then a 400-move random walk through history, every position bit-identical to the state recorded for it. |
| `adjust` | A property: every adjustment at its neutral setting must be the **identity**, and an adjustment layer must equal the destructive apply. |

`tools/controls.sh` re-introduces every bug the engine exists to prevent, one
at a time, and confirms the oracle that guards it fails. An oracle that cannot
fail proves nothing — several here could not, the first time.

`tools/playable.py` drives the real editor in a real browser: paint a stroke
and assert the pixels, confine paint to a selection, commit and cancel a
dialog, resize the document, export every format, round-trip a project file,
and check every control reaches 40px at phone width.

## Run it locally

A static site. No build step and no package manager.

```
git clone git@github.com:slippylabs/slipshop.slippylabs.com.git
cd slipshop.slippylabs.com
tools/serve.py 8796
```

Then open <http://127.0.0.1:8796/>. A plain `python3 -m http.server` also works,
but `tools/serve.py` sets the right MIME type for ES modules and disables
caching so a test cannot pass against the previous edit.

To run the checks:

```
tools/run_all.sh                      # node oracles, no browser needed
tools/controls.sh                     # re-introduce each bug; run it ALONE
python3 -m venv .venv && .venv/bin/pip install numpy scipy scikit-image pillow
tools/serve.py 8796 & tools/playable.py
```

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | The shell |
| `style.css` | The shared Slippy Labs tool stylesheet plus the `.sp-*` app shell |
| `js/core/` | The engine. Pure: no DOM, no canvas, runs under node |
| `js/app/` | The editor: viewport, tools, panels, menus, file I/O |
| `js/vendor/slipkit/` | SlipKit's tileable noise, vendored from SlipStudio so Clouds is bit-identical to the Noise Lab tool |
| `tools/` | Oracles, mutation controls, the browser suite, the dev server |
| `deploy/` | The nginx vhost |

## Notes

There is no third-party code in the editor itself. The encoders for PNG, JPEG
and WebP are the browser's own, which are real and well-tested; there is no
reason to hand-roll those. Everything else — the compositor, the blend modes,
the colour spaces, the brush engine, the filters, the resampler, the distance
transform, the project format — is written here.

Known limits, stated rather than implied: text is rasterised when placed rather
than staying re-editable; there is no PSD import or export yet; Free Transform
is Image Size and the rotate/flip commands rather than an interactive box; and
the temperature/tint sliders in White Balance are a creative approximation, not
a black-body curve.

---

Part of [Slippy Labs](https://slippylabs.com). Every tool is indexed at
[projects.slippylabs.com](https://projects.slippylabs.com).
