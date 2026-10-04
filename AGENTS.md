# Working in SlipShop as an AI

## The shape of it

`js/core/` is **pure** — no DOM, no canvas, no `window`. It runs under node,
which is the only reason `tools/` can check it. `js/app/` is the DOM half.
If you find yourself wanting `document` in `js/core/`, the function belongs in
`js/app/`.

Within core, the dependency graph is a tree. `util` -> `color` -> `blend` ->
`composite`; `tiles` and `doc` under `composite`; `convolve` under `adjust` and
`filters`; `distance` under `select`; `effects` under `composite` (and over
`distance`, `convolve`, `gradient`); `path` under `shape`; `resample` under
`liquify` and `text`. Nothing imports upwards, and
`for f in js/core/*.js; do echo "$f: $(grep -o "from '\./[a-z0-9]*\.js'" $f)"; done`
prints the graph.

`text` is the one module that cannot be pure on its own terms: it cannot
measure a glyph, so `layoutText` takes a `measure(str)` callback and
`js/app/textlayer.js` supplies one from a canvas. That is also what makes the
layout testable -- a synthetic metric with every character ten units wide turns
wrapping, alignment and justification into arithmetic with an exact answer.

## The loop

1. **Run the oracles before you change anything**, so you know what was already
   green: `tools/run_all.sh` (a couple of minutes; three of the fourteen want a
   browser and cache its answer in `/tmp`).
2. Change the code.
3. `tools/run_all.sh` again.
4. **Add an oracle check for what you changed, then a control that makes it
   fail.** A check that cannot fail proves nothing; five of the controls here
   did not fire the first time, and in four of those cases the ORACLE was the
   thing at fault, not the control.
5. `tools/controls.sh` — run it **alone**, and expect it to take the better part
   of an hour: it mutates the working tree and restores it between mutations, so
   a concurrent `run_all` reads half-mutated files and reports failures that are
   not real. `ONLY=<regex>` matches a control's NAME or the oracle it fires, so
   `ONLY=effects` runs everything one oracle guards. It also restores every file
   in its own list on exit, so do not edit `js/core/` while it runs.
6. For anything a person touches: `tools/serve.py 8796 &` then
   `tools/playable.py`.

## What the oracles rest on

Prefer, in this order:

1. **An exact statement.** The signed areas of a mask's contours sum to its
   pixel count. Four 90-degree rotations are the identity. An adjustment at its
   neutral setting changes nothing. These need no reference and cannot drift.
2. **The browser.** Chromium's canvas implements the same W3C compositing spec
   `blend.js` is written from, so it is an independent implementation of the
   same contract. Use a **float16** canvas (`getContext('2d', { colorType:
   'float16' })`) — the default 8-bit pipeline computes product terms in fixed
   point and puts multiply, overlay and exclusion 2/255 out. The canvas also
   strokes paths with the same cap, join and mitre-limit vocabulary `path.js`
   uses, and it owns the fonts, so it is the only thing that can settle where a
   glyph goes. `getImageData` still hands back **bytes** from a float16 canvas
   unless asked for floats, so a coverage total comes out 255x. Use
   `runInBrowserCached`, not `runInBrowser`: the answer depends only on the
   snippet, and controls.sh runs each oracle two hundred times.
3. **A reference library**, with its conventions pinned. scipy and scikit-image
   are in `.venv`. Pin them explicitly: scipy derives a gaussian radius from
   `truncate` where we use `ceil(3*sigma)`; scikit-image ships an older sRGB
   matrix and the historical rounded Lab constants. Feed ITS constants into our
   code and demand an exact match, rather than loosening a tolerance.

## Traps already paid for

- **Tolerance has to separate output precision from input conditioning.**
  `color-burn` near its clamp turns a 1-ULP input nudge into a 4.5e-3 output
  swing; `difference(b, b)` is pure cancellation. Comparing there measures the
  conditioning of the expression, not either implementation.
- **...and that allowance then excuses real bugs at a DISCONTINUITY.**
  `color-dodge` is discontinuous at `b == 0`, so its allowance is 1.0 and the
  point accepts anything. Pin the discontinuous points separately and exactly.
- **Every spatial filter premultiplies.** Blurring straight colour drags the
  colour of transparent pixels into visible ones — the dark halo round a
  blurred cut-out. Compare scipy against `separable`, the primitive, not
  against `gaussianBlur`, the premultiplying wrapper.
- **A filter reads outside the region it writes.** Grow the rect by
  `radiusOf(kind, params)`, filter, keep the middle. `radiusOf` returns `null`
  for a global filter (twirl, mosaic), which means it cannot be done on a
  sub-rect at all.
- **Pixel centres are at +0.5.** `(i + 0.5) * scale - 0.5`. Dropping the halves
  shifts the image half a pixel per axis, which is invisible once and
  accumulates.
- **`orient()`, never `transform()`, for right angles.** `transform` has to
  premultiply to resample, so it is only very nearly lossless; `orient` is an
  index permutation and is exact. `Math.cos(PI/2)` is 6.1e-17, not 0.
- **The random sweep did not cover it.** Four controls were missed because
  nothing in the oracle made a stroke touch the same tile twice, gave a group
  children, mutated `offset` in place, or used a pixel whose alpha and colour
  disagreed. When a control does not fire, suspect the oracle first.
- **A no-op edit must push no undo entry.** A random rect can land entirely
  outside the document; an undo step that does nothing is its own bug.
- **An effect READS further than it DRAWS.** `effectMargin` returns the read
  radius, not the draw radius. An inner shadow draws only inside the shape but
  is built from the inverted alpha blurred and offset, so on a sub-rect repaint
  it reads from well outside -- and the first version returned 0 for every
  inner effect, which changed the image as you scrolled.
- **A UNIFORM mistake is invisible to a region-consistency check.** Shift every
  cropped effect buffer by one row and the sub-rects still agree with the
  whole. Region consistency needs an ABSOLUTE companion: a hard-edged shadow
  at a known offset under a known square.
- **One dial, two features, one convention.** The layer-effects angle names
  where the LIGHT is, so a shadow falls the other way. Having the drop shadow
  follow the dial is self-consistent and passes its own test; it only showed up
  against the inner shadow, lit by the same light.
- **A snapshot must be deep enough to survive an in-place edit.** An effect
  holds a `color` array and the gradient overlay holds `stops` objects. A
  spread copy shares them, so the slider rewrites the undo entry it was taken
  to protect.
- **A second inline copy of a field list drifts.** `cloneLayer` and
  `duplicateLayer` each had one, and a duplicate silently lost its effects, its
  text spec and its Blend If ranges. One function.
- **Measure a glyph's PREFIX, not the glyph.** Summing per-character widths is
  44px out over nine characters of 160px serif, because the font kerns.
- **A bend of zero must be EXACTLY the identity.** Three of the sixteen text
  warps go through polar coordinates and leave 2.2e-16 behind, which stops
  "zero changes nothing" being a statement the oracle can make exactly.
- **A numeric inverse needs damping.** Plain Newton overshoots on `twist` and
  `inflate` at a large bend and leaves a residual near 0.5 -- half a text block
  in the wrong place. And three of the warps stop being INJECTIVE at the bottom
  of their nominal range, so `bendRange` clips them.
- **A sampled bound must be padded.** `warpedExtent` missed `shellLower`, whose
  maximum is on the centre line, by 2.4e-2 -- five pixels clipped off a 400px
  block. Half the largest step between samples covers it.
- **Stroke a path with an OUTLINE, not a distance field.** Thresholding the
  distance to the polyline is three lines and gives a perfect round join and
  cap -- and can never give a mitre, a bevel or a butt end, because those are
  not functions of distance. A quad per segment, a wedge per join and a shape
  per cap, all wound the same way, union under non-zero winding.
- **Grow a shape's bounds by the MITRE, not by half the stroke.** A mitred join
  reaches out by width/2 over the cosine of the half-angle, and the limit is
  the cap on that ratio; growing by half the width clips the spikes off a
  stroked star.
- **Split a cubic with de Casteljau to insert an anchor.** Dropping a corner on
  the flattened polyline leaves a kink; de Casteljau gives the two halves of
  the same curve and the shape does not change at all.
- **Liquify dabs COMPOSE, they do not add.** `new(p) = dab(p) + old(p + dab(p))`.
  Adding reads the old mesh at the undisplaced position, which agrees on a
  uniform mesh -- so check the composition where the two must differ.
- **A displacement mesh holds the INVERSE map.** Each node says where to sample
  FROM, so every tool's maths runs backwards: pushing content right means
  sampling from the left, and bloat samples from closer to the centre.
- **A brush falloff needs a zero derivative at the rim.** A linear ramp leaves
  a visible circular crease at the edge of every dab, and a drag lays down a
  hundred of them.

## Shipping

- Commit and push every change; tag a semver bump per release.
- `tools/deploy.sh` publishes to `/var/www/slipshop.slippylabs.com`. It refuses
  a dirty tree, ships the module tree under `js/b<N>/` (an ES-module import
  carries no `?v=`, so bumping the entry script does nothing for the sixty
  modules it pulls in), keeps the two newest builds so a page loaded mid-deploy
  does not 404 halfway through its import graph, and stages outside `/var/www`
  before moving in — `rm -rf` there races the gzip watcher and exits 0 having
  left orphans.
- **`style.css` is NOT under `js/b<N>/`.** Bump `style.css?v=` in `index.html`
  with any CSS change, or cached browsers and the edge keep the old stylesheet.
- After deploying, poll the **origin** (`curl -sk --resolve
  slipshop.slippylabs.com:443:127.0.0.1`) for a string that only exists in the
  new bytes before letting anything touch the public URL. Fetching the new
  versioned URL too early caches the stale body under it for hours.
