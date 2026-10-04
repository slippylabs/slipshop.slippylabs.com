# Working in SlipShop as an AI

## The shape of it

`js/core/` is **pure** — no DOM, no canvas, no `window`. It runs under node,
which is the only reason `tools/` can check it. `js/app/` is the DOM half.
If you find yourself wanting `document` in `js/core/`, the function belongs in
`js/app/`.

Within core, the dependency graph is a tree. `util` -> `color` -> `blend` ->
`composite`; `tiles` and `doc` under `composite`; `convolve` under `adjust` and
`filters`; `distance` under `select`. Nothing imports upwards.

## The loop

1. **Run the oracles before you change anything**, so you know what was already
   green: `tools/run_all.sh` (seconds to a couple of minutes, no browser).
2. Change the code.
3. `tools/run_all.sh` again.
4. **Add an oracle check for what you changed, then a control that makes it
   fail.** A check that cannot fail proves nothing; five of the controls here
   did not fire the first time, and in four of those cases the ORACLE was the
   thing at fault, not the control.
5. `tools/controls.sh` — run it **alone**. It mutates the working tree and
   restores it between mutations, so a concurrent `run_all` reads half-mutated
   files and reports failures that are not real. `ONLY=<regex>` runs a subset.
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
   point and puts multiply, overlay and exclusion 2/255 out.
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
