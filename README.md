# SlipShop

An image editor that runs entirely in your browser. Layers with 27 blend modes,
masks, clipping and nine layer effects; re-editable text with sixteen warp
styles; bezier paths and shape layers; a liquify mesh; selections with real
feathering; a pressure-sensitive brush engine; 19 adjustments (destructive or
as non-destructive layers); 31 filters; and undo that stores only the tiles you
actually painted.

Nothing is uploaded. There is no account and no server doing the work — every
pixel is processed on your own machine.

**Live:** <https://slipshop.slippylabs.com/>

## What it does

- **Layers** — raster, group, adjustment, solid-fill, text and shape layers;
  27 blend modes; opacity and fill opacity; layer masks; clipping masks;
  Blend If ranges.
- **Layer effects** — drop shadow, inner shadow, outer and inner glow, stroke
  (inside, centred or outside), colour overlay, gradient overlay, satin, and
  bevel & emboss. Non-destructive: they are derived from the layer's own alpha,
  so they follow it as you paint. Effects take the layer's *opacity* and not
  its *fill*, which is what both sliders are for — drop Fill to 0 and a shape
  keeps its stroke and shadow with nothing inside them.
- **Text** — re-editable text layers. Change the words, the font, the size,
  the tracking, the leading or the alignment and the layer redraws; point text
  and paragraph text with wrapping and justification; underline and
  strikethrough; text on a path; and sixteen warp styles (arc, arch, bulge,
  flag, wave, fish, rise, fisheye, inflate, twist and the rest).
- **Paths** — a pen tool with symmetric handles, Direct Select for anchors and
  handles (Shift for a cusp, Alt to retract a handle or insert an anchor
  without changing the shape), seven parametric shapes, re-editable shape
  layers with a fill and a stroke, fill path, stroke path, path ↔ selection,
  and SVG import and export.
- **Liquify** — forward warp, bloat, pucker, twirl either way, shift pixels,
  smooth, reconstruct, and a freeze mask. The warp is held as a displacement
  mesh and the image is resampled once from the original however many strokes
  you make, so it does not soften a little more each time.
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
fourteen oracles over it, and most of them check against something that shares
no code with what it is checking.

Five design decisions carry most of the weight:

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
same region of a full composite. Layer effects slot into the same loop as
extra buffers below and above the layer's own pixels, which is also why they
need the rect GROWN by how far they read: an inner shadow is built from the
inverted alpha blurred and offset, so on a sub-rect repaint it reads from well
outside the region it draws into.

**A text layer and a shape layer store a SPEC, and the pixels are derived.**
Change a word or drag an anchor and the surface is rebuilt from the spec,
which is what "re-editable" means. It is also why painting on one rasterises
it first: otherwise the next keystroke would redraw over the brush stroke.

**Liquify holds a displacement mesh, not warped pixels.** Every stroke
accumulates in the mesh and the image is resampled once from the untouched
original. Warping the pixels in place instead would soften them a little on
every stroke, and fifty strokes into a portrait that is obvious. The mesh
holds the INVERSE map — for each destination pixel, where to sample from —
and stacking two dabs is function composition, `new(p) = dab(p) + old(p +
dab(p))`, not addition: adding reads the old mesh at the undisplaced position,
so pushing a feature across the canvas and then twirling where it ended up
would twirl where it started.

## Verification

`tools/run_all.sh` — fourteen node oracles, about 19,000 checks. The ones
worth knowing about:

| Oracle | Checked against |
| --- | --- |
| `blend` | **The browser's own compositor.** Chromium's canvas implements the same W3C spec `blend.js` is written from, so it is a genuinely independent implementation. Runs on a float16 canvas, because the default 8-bit pipeline computes the product terms in fixed point. |
| `composite` | The browser again, but the whole **layer stack** — groups, masks, opacity and clipping built from `globalAlpha`, `destination-in` and offscreen canvases. |
| `tiles` | A **dense** surface: the same contract implemented with one flat array. A dense array has nowhere to hide a seam. |
| `convolve` | `scipy.ndimage`, with the radius pinned and `correlate` (not `convolve`) chosen deliberately. |
| `color` | `scikit-image`, with **its** constants substituted into our code — it ships an older sRGB matrix and the historical rounded Lab constants, so that is the only version of the comparison that proves anything. |
| `history` | A property: 158 random edits, then a 400-move random walk through history, every position bit-identical to the state recorded for it. |
| `adjust` | A property: every adjustment at its neutral setting must be the **identity**, and an adjustment layer must equal the destructive apply. |
| `effects` | A property, and the important one: compositing a window of the document must be **bit-identical** to that window of the whole composite. Plus the closed-form ring area of a stroke, and the shadow's blur pinned to `scipy.ndimage.gaussian_filter`. |
| `text` | A **synthetic font metric** — every character exactly ten units wide — which turns wrapping, alignment, tracking and justification into arithmetic with an exact answer. Then the real browser, for the one thing only it can settle: that our per-character placement matches what it draws when handed the whole string. |
| `path` | **The browser's own `ctx.stroke()`**, which has the same cap, join and mitre-limit vocabulary, so it is a second implementation. Plus closed forms: a butt-capped stroke of width *w* along a run of length *L* covers exactly *L·w*, a square cap adds exactly *w*², and a round cap adds the area of the polygon the circle is flattened to. |
| `liquify` | `scipy.ndimage.map_coordinates` for the resampling, and properties for the mesh: an empty mesh is a bit-exact pass-through, a whole-pixel mesh is an exact pixel shift, nothing outside the brush moves, a frozen node never moves. |

`tools/controls.sh` re-introduces every bug the engine exists to prevent, one
at a time, and confirms the oracle that guards it fails. An oracle that cannot
fail proves nothing — several here could not, the first time.

`tools/playable.py` drives the real editor in a real browser: paint a stroke
and assert the pixels, confine paint to a selection, commit and cancel a
dialog, resize the document, export every format, round-trip a project file
(the pixels **and** the text, shape, effect and path specs the pixels are
derived from), draw a path with the pen and turn it into a selection and back,
warp a bar with liquify and undo it, and check every control reaches 40px at
phone width.

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

## What is not here yet

Stated plainly, because a feature list that quietly omits things is worse than
a short one. All of these were in the plan for this editor and none of them are
in v1.1.0:

- **Interactive Free Transform.** Scale and rotate exist as Image Size and the
  rotate/flip commands; there is no drag-handle box on the canvas.
- **Boolean path operations.** Paths can be drawn, edited, filled, stroked,
  turned into selections and exported, but there is no union/subtract/intersect
  between two of them.
- **Non-destructive liquify.** The mesh is live while you work and is baked
  into the pixels when you press Apply; it is not stored on the layer.
- **Pattern overlay and pattern stamp.** Eight of the nine Photoshop layer
  effects are here; the pattern overlay needs a pattern library first.
- **Content-aware fill and content-aware scale.** No PatchMatch inpainting and
  no seam carving.
- **PSD import or export**, and no GIF, TIFF, ICO or SVG export. Opening reads
  anything the browser decodes (PNG, JPEG, WebP, GIF, BMP); saving is PNG,
  JPEG, WebP, or the layered `.slipshop` project.
- **Actions and a script panel.** Every edit is already a data op, which is
  what a macro recorder would be built on, but there is no recorder and no
  way to paste a list of ops in.
- **Blend If** is implemented in the compositor and has no UI.
- **16-bit documents** are supported by the engine — tiles, history, codecs —
  and File > New always makes an 8-bit one.
- **Workers.** Everything runs on the main thread. The engine was written so a
  filter is a pure function over a tile, which is the hard part of moving it
  off, but a large filter on a large image will still block the tab.

One more thing that is an approximation rather than a gap: the temperature and
tint sliders in White Balance are a creative curve, not a black-body one. They
scale in linear light, which is where a light source's colour actually
multiplies, but the coefficients are chosen to feel right rather than measured.

---

Part of [Slippy Labs](https://slippylabs.com). This one is indexed at
[art.slippylabs.com](https://art.slippylabs.com).
