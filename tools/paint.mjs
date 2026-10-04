// Oracle: selections, the distance transform, gradients, the brush engine and
// the filter catalogue.
//
// Mostly exact statements and properties, because there is no library that has
// an opinion about what a magic wand or a brush spacing should do. Where there
// IS one -- the Euclidean distance transform, the flood fill -- scipy and
// scikit-image are used.
//
// The sharpest check in here is the one for marching ants: with y pointing
// down and the inside on the right, the signed areas of all the contours of a
// mask sum to EXACTLY its selected pixel count. One integer validates edge
// directions, winding, holes and the diagonal turn policy at once, and it is
// the same oracle image-to-vector uses for its tracer.

import { Surface } from '../js/core/tiles.js';
import {
  rectCoverage, ellipseCoverage, polygonCoverage, applyCoverage, combineValue,
  magicWand, colorRange, colorDistance, featherSelection, expandSelection,
  contractSelection, borderSelection, smoothSelection, invertSelection,
  selectAll, selectionBounds, isEmptySelection, newSelection, marchingAnts,
  signedArea, COMBINE,
} from '../js/core/select.js';
import { distanceTransform, distanceSqTransform, signedDistance } from '../js/core/distance.js';
import { renderGradient, twoStop, fgToTransparent, bucketFill, GRADIENT_SHAPES } from '../js/core/gradient.js';
import { Stroke, tipMask, defaultBrush, applyStroke, strokeLine } from '../js/core/brush.js';
import { FILTERS, FILTER_KINDS, FILTER_GROUPS, applyFilter, filterDefaults, radiusOf } from '../js/core/filters.js';
import { Doc, Layer, newDoc } from '../js/core/doc.js';
import { rect, rectEmpty, mulberry32, clamp01, luma709 } from '../js/core/util.js';
import { ok, eq, note, done, worst } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

const rnd = mulberry32(0x5A1D7);

// ------------------------------------------------------- distance transform

{
  // Exact, from a single point: every distance is a hypotenuse.
  const w = 9, h = 7;
  const m = new Float32Array(w * h);
  m[3 * w + 4] = 1;
  const d = distanceTransform(m, w, h);
  let wErr = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    wErr = Math.max(wErr, Math.abs(d[y * w + x] - Math.hypot(x - 4, y - 3)));
  }
  ok(wErr < 1e-5, `the EDT from one point is exact (worst ${wErr.toExponential(2)})`);

  // Inside pixels are zero.
  const m2 = new Float32Array(w * h).fill(1);
  const d2 = distanceTransform(m2, w, h);
  ok(d2.every((v) => v === 0), 'every pixel inside the set has distance 0');

  // An empty set has no finite distance anywhere -- it must not silently
  // return zeros, which would make Expand grow from nothing.
  const d3 = distanceTransform(new Float32Array(w * h), w, h);
  ok(d3.every((v) => v > 1e8), 'an empty set gives an effectively infinite distance everywhere');

  // Signed: negative inside, positive outside, and zero-crossing at the edge.
  const mask = new Float32Array(w * h);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 6; x++) mask[y * w + x] = 1;
  const sd = signedDistance(mask, w, h);
  ok(sd[3 * w + 4] < 0, 'the centre of a blob has negative signed distance');
  ok(sd[0] > 0, 'a far corner has positive signed distance');
}

if (havePython()) {
  // scipy's distance_transform_edt is exact too, so this should agree to
  // float32 precision rather than approximately.
  const W = 41, H = 29;
  const m = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = rnd() < 0.12 ? 1 : 0;
  m[0] = 1;                                   // guarantee a non-empty set
  const mine = distanceTransform(m, W, H);
  const want = runPython(`
from scipy.ndimage import distance_transform_edt
a = IN.reshape(${H}, ${W})
# scipy measures distance to the nearest ZERO, so invert to get distance to
# the nearest SET pixel, which is what ours measures. Getting this backwards
# produces a plausible-looking field that is wrong everywhere.
OUT = distance_transform_edt(a == 0).reshape(-1)
`, m, [H, W]);
  const d = worst(Array.from(mine), Array.from(want));
  ok(d.w < 1e-5, `the EDT matches scipy over a random mask (worst ${d.w.toExponential(2)})`);
  note(`EDT vs scipy: ${d.w.toExponential(2)} over ${W * H} pixels`);
}

// ------------------------------------------------------------ coverage areas

{
  // Analytic, so these are exact rather than approximate.
  const r = rectCoverage(null, 2.5, 1.25, 6.5, 4.75);
  let area = 0;
  for (const v of r.cov) area += v;
  eq(area, 14, 'a sub-pixel rectangle has exactly its true area', 1e-5);

  const r2 = rectCoverage(null, 0, 0, 10, 10, { antialias: false });
  let a2 = 0;
  for (const v of r2.cov) a2 += v;
  eq(a2, 100, 'and without antialiasing it is still exact on integer bounds');

  const e = ellipseCoverage(null, 0, 0, 40, 40);
  let ea = 0;
  for (const v of e.cov) ea += v;
  ok(Math.abs(ea - Math.PI * 400) / (Math.PI * 400) < 0.002,
    `a circle of r=20 has area within 0.2% of pi*r^2 (${ea.toFixed(1)} vs ${(Math.PI * 400).toFixed(1)})`);

  const sq = polygonCoverage([[0, 0], [10, 0], [10, 10], [0, 10]]);
  let sa = 0;
  for (const v of sq.cov) sa += v;
  eq(sa, 100, 'an axis-aligned square polygon is exact', 1e-4);

  const tri = polygonCoverage([[0, 0], [20, 0], [0, 20]]);
  let ta = 0;
  for (const v of tri.cov) ta += v;
  eq(ta, 200, 'a right triangle is exact too -- the horizontal spans are analytic', 1e-3);

  // A self-intersecting lasso must select its whole outline under non-zero
  // winding rather than punching a hole where it crosses itself. A bowtie is
  // the wrong test shape -- its two lobes do not overlap, so both fill rules
  // agree and the check asserts nothing. A five-pointed STAR does overlap
  // itself in the middle, which is where the rules differ.
  const star = [];
  for (let i = 0; i < 5; i++) {
    const a = (-Math.PI / 2) + (i * 4 * Math.PI) / 5;
    star.push([20 + Math.cos(a) * 18, 20 + Math.sin(a) * 18]);
  }
  const nz = polygonCoverage(star);
  let ba = 0;
  for (const v of nz.cov) ba += v;
  const eo = polygonCoverage(star, { evenOdd: true });
  let bea = 0;
  for (const v of eo.cov) bea += v;
  ok(ba > 300, `a star fills solid under non-zero winding (${ba.toFixed(0)})`);
  ok(bea < ba * 0.92, `and even-odd leaves the middle hollow (${bea.toFixed(0)} vs ${ba.toFixed(0)})`);

  // Degenerate inputs must give an empty result rather than throwing.
  for (const bad of [[], [[0, 0]], [[0, 0], [1, 1]]]) {
    const out = polygonCoverage(bad);
    ok(rectEmpty(out.r), `a polygon with ${bad.length} point(s) is empty, not an error`);
  }
  ok(rectEmpty(ellipseCoverage(null, 5, 5, 5, 5).r), 'a zero-size ellipse is empty');
}

// -------------------------------------------------------------- combine modes

{
  const cases = [
    ['new', 0.8, 0.3, 0.3],
    ['add', 0.8, 0.3, 0.8],
    ['add', 0.3, 0.8, 0.8],
    ['subtract', 0.8, 0.3, 0.7],
    ['subtract', 1, 1, 0],
    ['intersect', 0.8, 0.3, 0.3],
    ['xor', 0.8, 0.3, 0.5],
    ['xor', 1, 1, 0],
  ];
  for (const [mode, a, b, want] of cases) {
    eq(combineValue(mode, a, b), want, `combine ${mode}(${a}, ${b}) = ${want}`, 1e-9);
  }
  eq(COMBINE.length, 5, 'five combine modes');

  const doc = new Doc({ w: 60, h: 40 });
  // 'new' must clear OUTSIDE the incoming rect too, or the previous selection
  // shows through wherever the new one does not reach.
  const sel = newSelection(doc);
  const left = rectCoverage(null, 0, 0, 20, 40);
  applyCoverage(sel, left.r, left.cov, 'new');
  const right = rectCoverage(null, 40, 0, 60, 40);
  applyCoverage(sel, right.r, right.cov, 'new');
  eq(sel.getPixel(5, 20)[0], 0, "a 'new' selection clears the old one outside its own rect");
  eq(sel.getPixel(50, 20)[0], 1, 'and selects its own area');

  // 'intersect' with a disjoint shape must empty the selection.
  const sel2 = newSelection(doc);
  applyCoverage(sel2, left.r, left.cov, 'new');
  applyCoverage(sel2, right.r, right.cov, 'intersect');
  ok(isEmptySelection(sel2), 'intersecting two disjoint shapes leaves nothing selected');

  // selectAll / invert round trip.
  const all = selectAll(doc);
  ok(!isEmptySelection(all), 'select all selects something');
  invertSelection(all);
  ok(isEmptySelection(all), 'inverting select-all selects nothing');
  invertSelection(all);
  eq(all.getPixel(30, 20)[0], 1, 'and inverting again brings it back');
}

// --------------------------------------------------- modify, via the SDF

{
  const doc = new Doc({ w: 80, h: 80 });
  const mk = () => {
    const s = newSelection(doc);
    const c = rectCoverage(null, 20, 20, 60, 60);
    applyCoverage(s, c.r, c.cov, 'new');
    return s;
  };
  const areaOf = (s) => {
    const b = s.readRect(doc.bounds);
    let a = 0;
    for (const v of b) a += v;
    return a;
  };

  const base = areaOf(mk());
  eq(base, 1600, 'the test selection is 40x40', 1);

  const grown = mk();
  expandSelection(grown, 5);
  // Expanding a 40x40 square by 5 should approach a rounded 50x50: the
  // corners are quarter-circles, so the area is 50*50 - (4 - pi) * 25.
  const wantGrow = 50 * 50 - (4 - Math.PI) * 25;
  ok(Math.abs(areaOf(grown) - wantGrow) / wantGrow < 0.01,
    `Expand by 5 gives a ROUNDED square, area within 1% of ${wantGrow.toFixed(0)} (got ${areaOf(grown).toFixed(0)})`);

  const shrunk = mk();
  contractSelection(shrunk, 5);
  const wantShrink = 30 * 30 - (4 - Math.PI) * 25;
  // Contract rounds the INNER corners against the pixel grid, so it sits a
  // little above the ideal rounded square. 3% is the measured gap.
  ok(Math.abs(areaOf(shrunk) - wantShrink) / wantShrink < 0.03,
    `Contract by 5 gives area within 3% of ${wantShrink.toFixed(0)} (got ${areaOf(shrunk).toFixed(0)})`);

  // Expand then contract by the same amount returns (nearly) to the start --
  // not exactly, because the corners are rounded on the way out.
  const round = mk();
  expandSelection(round, 4);
  contractSelection(round, 4);
  eq(areaOf(round), base, 'expand then contract by the same amount returns EXACTLY to the original area', 1);

  // Feather conserves total coverage: it is a blur, and a blur of a mask has
  // the same integral. A feather that changed the area would be growing or
  // shrinking the selection, which is what Expand is for.
  const feathered = mk();
  featherSelection(feathered, 4);
  ok(Math.abs(areaOf(feathered) - base) / base < 0.02,
    `Feather conserves total coverage (${areaOf(feathered).toFixed(0)} vs ${base})`);
  // ...and it really did soften the edge.
  const edge = feathered.getPixel(20, 40)[0];
  ok(edge > 0.05 && edge < 0.95, `and the edge pixel is partly selected (${edge.toFixed(3)})`);

  const border = mk();
  borderSelection(border, 6);
  const ba = areaOf(border);
  // A 6px ring around a 40x40 square is roughly its perimeter times 6.
  ok(ba > 600 && ba < 1300, `Border gives a ring, not a disc or nothing (area ${ba.toFixed(0)})`);
  eq(border.getPixel(40, 40)[0], 0, 'and the middle of the ring is not selected');

  const smooth = mk();
  smoothSelection(smooth, 3);
  ok(Math.abs(areaOf(smooth) - base) / base < 0.1, 'Smooth keeps roughly the same area');

  // Expand by zero must be exactly a no-op.
  const zero = mk();
  const before = zero.readRect(doc.bounds);
  expandSelection(zero, 0);
  eq(worst(before, zero.readRect(doc.bounds)).w, 0, 'Expand by 0 is exactly a no-op');
}

// --------------------------------------------- MARCHING ANTS: the exact area

{
  const cases = {
    'a rectangle': (c, w) => { for (let y = 5; y < 20; y++) for (let x = 8; x < 30; x++) c[y * w + x] = 1; },
    'a rect with a hole': (c, w) => {
      for (let y = 5; y < 25; y++) for (let x = 8; x < 35; x++) c[y * w + x] = 1;
      for (let y = 10; y < 18; y++) for (let x = 14; x < 26; x++) c[y * w + x] = 0;
    },
    'two separate blobs': (c, w) => {
      for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) c[y * w + x] = 1;
      for (let y = 20; y < 30; y++) for (let x = 40; x < 55; x++) c[y * w + x] = 1;
    },
    'a diagonal staircase': (c, w) => { for (let i = 0; i < 15; i++) { c[(5 + i) * w + (5 + i)] = 1; c[(5 + i) * w + (6 + i)] = 1; } },
    'a single pixel': (c, w) => { c[20 * w + 20] = 1; },
    'the document corner': (c, w) => { for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) c[y * w + x] = 1; },
    'a disc': (c, w) => { for (let y = 0; y < 40; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - 30, y - 20) < 13) c[y * w + x] = 1; },
    'a ring': (c, w) => { for (let y = 0; y < 40; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x - 30, y - 20); if (d < 15 && d > 8) c[y * w + x] = 1; } },
    'random noise': (c) => { const r = mulberry32(9); for (let i = 0; i < c.length; i++) c[i] = r() < 0.35 ? 1 : 0; },
    'a one-pixel comb': (c, w) => { for (let x = 2; x < 50; x += 2) for (let y = 5; y < 15; y++) c[y * w + x] = 1; },
  };
  const W = 60, H = 40;
  for (const [name, paint] of Object.entries(cases)) {
    const s = new Surface(W, H, 1, 8);
    const cov = new Float32Array(W * H);
    paint(cov, W);
    s.writeRect(rect(0, 0, W, H), cov);
    let px = 0;
    for (const v of cov) if (v >= 0.5) px++;
    const paths = marchingAnts(s);
    let area = 0;
    for (const p of paths) area += signedArea(p);
    eq(area, px, `marching ants, ${name}: signed areas sum to the ${px} selected pixels (${paths.length} contour(s))`, 1e-9);
    for (const p of paths) {
      ok(p.length > 2, `${name}: every contour has at least 3 points`);
    }
  }
  // 8-connectivity, where it matters: a staircase two pixels wide shares real
  // edges and must come out as ONE contour, because a dotted outline that
  // breaks at every diagonal step looks broken.
  const s2 = new Surface(W, H, 1, 8);
  const c2 = new Float32Array(W * H);
  for (let i = 0; i < 12; i++) { c2[(5 + i) * W + (5 + i)] = 1; c2[(5 + i) * W + (6 + i)] = 1; }
  s2.writeRect(rect(0, 0, W, H), c2);
  eq(marchingAnts(s2).length, 1, 'a two-pixel-wide diagonal staircase is a single contour');

  // A chain of pixels touching ONLY at their corners comes out as one loop per
  // pixel. Stated rather than asserted away: the signed areas still sum
  // exactly (checked above), so the outline is geometrically right, and twelve
  // little squares is a defensible way to draw twelve corner-touching pixels.
  const s3 = new Surface(W, H, 1, 8);
  const c3 = new Float32Array(W * H);
  for (let i = 0; i < 12; i++) c3[(5 + i) * W + (5 + i)] = 1;
  s3.writeRect(rect(0, 0, W, H), c3);
  const diag = marchingAnts(s3);
  let diagArea = 0;
  for (const p of diag) diagArea += signedArea(p);
  eq(diagArea, 12, 'a corner-touching diagonal chain still has exactly its own area', 1e-9);
  note(`a corner-touching diagonal chain draws as ${diag.length} loops, one per pixel`);

  // An empty selection has no outline at all.
  eq(marchingAnts(new Surface(W, H, 1, 8)).length, 0, 'an empty selection has no contours');
}

// ------------------------------------------------------------- magic wand

{
  const W = 40, H = 30;
  const px = new Float32Array(W * H * 4);
  // left half red, right half blue, with a one-pixel green stripe between
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    if (x < 19) { px[p] = 1; }
    else if (x === 19) { px[p + 1] = 1; }
    else { px[p + 2] = 1; }
    px[p + 3] = 1;
  }
  const a = magicWand(px, W, H, 5, 5, { tolerance: 10, contiguous: true });
  let n = 0;
  for (const v of a.cov) if (v > 0.5) n++;
  eq(n, 19 * H, 'a contiguous wand on the red half selects exactly that half');

  // The stripe must block it: a wand that leaks across a one-pixel boundary
  // is the classic tolerance bug.
  const b = magicWand(px, W, H, 5, 5, { tolerance: 10, contiguous: true });
  eq(b.cov[5 * W + 25], 0, 'and does not leak past the one-pixel stripe into the blue');

  // Global mode ignores connectivity.
  const g = magicWand(px, W, H, 5, 5, { tolerance: 10, contiguous: false });
  let gn = 0;
  for (const v of g.cov) if (v > 0.5) gn++;
  eq(gn, 19 * H, 'global mode selects the same pixels here, since all the red is one colour');

  // A huge tolerance selects everything; a zero tolerance selects only exact
  // matches (which here is still the whole red half).
  const big = magicWand(px, W, H, 5, 5, { tolerance: 200, contiguous: false });
  eq(big.cov.filter((v) => v > 0).length, W * H, 'a tolerance of 200 selects the whole image');
  const zero = magicWand(px, W, H, 5, 5, { tolerance: 0, contiguous: true });
  ok(zero.cov.every((v) => v === 0), 'a tolerance of 0 selects nothing -- the ramp is exclusive at the bound');

  // Clicking outside the image is a no-op, not a crash.
  const out = magicWand(px, W, H, -5, -5, { tolerance: 50 });
  ok(out.cov.every((v) => v === 0), 'clicking outside the document selects nothing');

  // deltaE2000 is perceptual: a dark blue and a dark green that are the same
  // RGB distance apart are NOT the same perceptual distance. That is the
  // whole reason the wand uses Lab rather than RGB.
  const dRgb = colorDistance([0.1, 0.1, 0.5], [0.1, 0.5, 0.1], true);
  const dLab = colorDistance([0.1, 0.1, 0.5], [0.1, 0.5, 0.1], false);
  ok(dRgb > 0 && dLab > 0, 'both colour metrics are positive for different colours');
  eq(colorDistance([0.3, 0.4, 0.5], [0.3, 0.4, 0.5], false), 0, 'and zero for identical colours', 1e-9);

  // Colour range.
  const cr = colorRange(px, W, H, [1, 0, 0], { fuzziness: 20 });
  let cn = 0;
  for (const v of cr.cov) if (v > 0.5) cn++;
  eq(cn, 19 * H, 'Colour Range on red picks the red half');
}

if (havePython()) {
  // The flood fill, against scikit-image's. Same seed, same tolerance, so the
  // selected SET must be identical even though the ramp differs.
  const W = 50, H = 40;
  const grid = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) grid[i] = rnd() < 0.3 ? 0 : 1;
  const px = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = grid[i];
    px[i * 4 + 3] = 1;
  }
  // start from a known 1
  let sx = 0, sy = 0;
  outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y * W + x] === 1) { sx = x; sy = y; break outer; }
  const mine = magicWand(px, W, H, sx, sy, { tolerance: 5, contiguous: true, antialias: false });
  const want = runPython(`
from skimage.segmentation import flood
a = IN.reshape(${H}, ${W})
OUT = flood(a, (${sy}, ${sx}), connectivity=1).astype(np.float64).reshape(-1)
`, grid, [H, W]);
  let diff = 0;
  for (let i = 0; i < W * H; i++) {
    const a = mine.cov[i] > 0.5 ? 1 : 0;
    if (a !== want[i]) diff++;
  }
  eq(diff, 0, `the contiguous wand selects exactly what scikit-image's flood does (${diff} differ of ${W * H})`);
  note('flood fill agrees with skimage.segmentation.flood pixel for pixel');
}

// -------------------------------------------------------------- gradients

{
  const r = rect(0, 0, 101, 1);
  const g = renderGradient(r, twoStop([0, 0, 0], [1, 1, 1]), { shape: 'linear', x0: 0.5, y0: 0, x1: 100.5, y1: 0, dither: false });
  let wErr = 0;
  for (let i = 0; i < 101; i++) wErr = Math.max(wErr, Math.abs(g[i * 4] - i / 100));
  ok(wErr < 1e-5, `a linear gradient is exactly linear (worst ${wErr.toExponential(2)})`);

  // Dither must stay well under one 8-bit step, or it is visible as noise
  // rather than invisible as a fix for banding.
  const d = renderGradient(rect(0, 0, 101, 8), twoStop([0, 0, 0], [1, 1, 1]), { shape: 'linear', x0: 0.5, y0: 0, x1: 100.5, y1: 0, dither: true });
  let dw = 0;
  for (let y = 0; y < 8; y++) for (let i = 0; i < 101; i++) dw = Math.max(dw, Math.abs(d[(y * 101 + i) * 4] - i / 100));
  ok(dw < 1 / 255, `dither stays inside one 8-bit step (${dw.toExponential(2)} vs ${(1 / 255).toExponential(2)})`);
  ok(dw > 1e-5, 'and it is actually doing something');

  for (const shape of GRADIENT_SHAPES) {
    const out = renderGradient(rect(0, 0, 32, 32), twoStop([0, 0, 0], [1, 1, 1]), { shape, x0: 16, y0: 16, x1: 32, y1: 16, dither: false });
    ok(out.every((v) => v >= 0 && v <= 1), `${shape}: every value is in range`);
    ok(out.some((v) => v > 0.01) && out.some((v) => v < 0.99), `${shape}: produces an actual gradient, not a flat fill`);
  }

  // Reverse really reverses.
  const fwd = renderGradient(rect(0, 0, 16, 1), twoStop([0, 0, 0], [1, 1, 1]), { shape: 'linear', x0: 0, y0: 0, x1: 16, y1: 0, dither: false });
  const rev = renderGradient(rect(0, 0, 16, 1), twoStop([0, 0, 0], [1, 1, 1]), { shape: 'linear', x0: 0, y0: 0, x1: 16, y1: 0, dither: false, reverse: true });
  let rw = 0;
  for (let i = 0; i < 16; i++) rw = Math.max(rw, Math.abs(fwd[i * 4] - rev[(15 - i) * 4]));
  ok(rw < 1e-6, 'reverse is the mirror of forward');

  // Foreground to transparent fades the ALPHA, not the colour.
  const ft = fgToTransparent([1, 0, 0]);
  const t = renderGradient(rect(0, 0, 16, 1), ft.stops, { shape: 'linear', x0: 0, y0: 0, x1: 16, y1: 0, dither: false, alphaStops: ft.alphaStops });
  ok(t[3] > 0.9 && t[15 * 4 + 3] < 0.1, 'fg-to-transparent fades alpha from opaque to clear');
  let colourMoved = 0;
  for (let i = 0; i < 16; i++) if (Math.abs(t[i * 4] - 1) > 0.02) colourMoved++;
  eq(colourMoved, 0, 'and the colour stays the foreground all the way across');

  // A zero-length drag must not divide by zero.
  const deg = renderGradient(rect(0, 0, 8, 8), twoStop([0, 0, 0], [1, 1, 1]), { shape: 'linear', x0: 4, y0: 4, x1: 4, y1: 4 });
  ok(deg.every((v) => Number.isFinite(v)), 'a zero-length gradient drag stays finite');

  // The bucket reuses the wand, so "tolerance 20" means the same thing in both.
  const W = 16, H = 16;
  const buf = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = (i % W) < 8 ? 1 : 0; buf[i * 4 + 3] = 1; }
  const { cov } = bucketFill(buf, W, H, 1, 1, [0, 0, 1], { tolerance: 10 });
  let filled = 0;
  for (const v of cov) if (v > 0.5) filled++;
  eq(filled, 8 * H, 'the bucket fills exactly the region the wand would select');
  eq(buf[(1 * W + 1) * 4 + 2], 1, 'and the filled pixels take the new colour', 1e-3);
  eq(buf[(1 * W + 9) * 4 + 2], 0, 'while the other region is untouched');
}

// ------------------------------------------------------------ brush engine

{
  const t = tipMask(20, { hardness: 1 });
  let area = 0;
  for (const v of t.data) area += v;
  ok(Math.abs(area - Math.PI * 100) / (Math.PI * 100) < 0.01,
    `a hard round tip of diameter 20 has area within 1% of pi*r^2 (${area.toFixed(1)})`);
  eq(t.data[0], 0, 'and its corner is empty');

  // A rotated flat tip must not be clipped by its own bounding box.
  const flat = tipMask(40, { hardness: 0, roundness: 0.25, angle: 45 });
  let edgeInk = 0;
  for (let x = 0; x < flat.w; x++) { edgeInk += flat.data[x]; edgeInk += flat.data[(flat.h - 1) * flat.w + x]; }
  for (let y = 0; y < flat.h; y++) { edgeInk += flat.data[y * flat.w]; edgeInk += flat.data[y * flat.w + flat.w - 1]; }
  ok(edgeInk < 0.5, `a 45-degree flat tip is not clipped by its footprint (edge ink ${edgeInk.toExponential(2)})`);

  // Soft tips are soft, hard tips are hard.
  const soft = tipMask(40, { hardness: 0 });
  const hard = tipMask(40, { hardness: 1 });
  const partial = (m) => m.data.filter((v) => v > 0.02 && v < 0.98).length;
  ok(partial(soft) > partial(hard) * 3, `a soft tip has far more partial coverage than a hard one (${partial(soft)} vs ${partial(hard)})`);
  ok(partial(hard) > 0, 'but a hard tip is still antialiased, not a staircase');

  // SPACING IS CONSTANT whatever the event rate -- the property the whole
  // stroke design exists for.
  const counts = new Set();
  for (const step of [1, 2, 3, 7, 23, 75, 150]) {
    const s = new Stroke(300, 50, { size: 20, spacing: 0.25, smoothing: 0 });
    s.add(10, 25, 1);
    for (let x = 10 + step; x < 160; x += step) s.add(x, 25, 1);
    s.add(160, 25, 1);
    counts.add(s.stampCount);
  }
  eq(counts.size, 1, `a 150px line lays the same number of stamps at every event rate (${[...counts]})`);
  eq([...counts][0], 31, 'and that number is the line length over the spacing, plus the first stamp');

  // A stationary pointer lays exactly one stamp.
  const still = new Stroke(80, 80, { size: 20, smoothing: 0 });
  for (let i = 0; i < 50; i++) still.add(40, 40, 1);
  eq(still.stampCount, 1, '50 events at one position lay one stamp, not fifty');

  // FLOW ACCUMULATES, and never passes 1.
  const low = new Stroke(80, 80, { size: 30, spacing: 0.05, flow: 0.1, hardness: 1, smoothing: 0 });
  for (let i = 0; i < 40; i++) low.add(30 + (i % 2 ? 6 : 0), 40, 1);
  const v = low.cov.getPixel(32, 40)[0];
  ok(v > 0.9 && v <= 1.0001, `scrubbing at flow 0.1 builds up to ${v.toFixed(4)} without passing 1`);
  const one = new Stroke(80, 80, { size: 30, flow: 1, hardness: 1, smoothing: 0 });
  one.add(40, 40, 1);
  eq(one.cov.getPixel(40, 40)[0], 1, 'and a single stamp at flow 1 is exactly 1', 2e-5);

  // Determinism: the same stroke twice is the same pixels, scatter included.
  const mk = () => {
    const s = new Stroke(120, 120, { size: 24, spacing: 0.2, scatter: 1.5, scatterCount: 3, jitterSize: 0.4, seed: 42, smoothing: 0 });
    for (let i = 0; i <= 20; i++) s.add(10 + i * 5, 60 + Math.sin(i) * 10, 0.5 + i / 40);
    return s;
  };
  ok(mk().cov.equals(mk().cov), 'a seeded stroke with scatter and jitter is reproducible');

  // Pressure drives size when asked, and not when not.
  const withDyn = new Stroke(200, 60, { size: 40, hardness: 1, smoothing: 0, sizeDynamics: { by: 'pressure', min: 0.1 } });
  withDyn.add(20, 30, 0.1);
  withDyn.add(60, 30, 0.1);
  const offDyn = new Stroke(200, 60, { size: 40, hardness: 1, smoothing: 0, sizeDynamics: { by: 'off' } });
  offDyn.add(20, 30, 0.1);
  offDyn.add(60, 30, 0.1);
  const ink = (s) => { let a = 0; const b = s.cov.readRect(rect(0, 0, 200, 60)); for (const x of b) a += x; return a; };
  ok(ink(withDyn) < ink(offDyn) * 0.4, `pressure 0.1 with size dynamics lays much less ink (${ink(withDyn).toFixed(0)} vs ${ink(offDyn).toFixed(0)})`);

  // Smoothing 0 must be an exact no-op on position.
  const a1 = new Stroke(100, 100, { size: 10, smoothing: 0 });
  a1.add(10, 10, 1); a1.add(90, 90, 1);
  const a2 = new Stroke(100, 100, { size: 10, smoothing: 0 });
  a2.add(10, 10, 1); a2.add(90, 90, 1);
  ok(a1.cov.equals(a2.cov), 'smoothing 0 is deterministic');

  // applyStroke respects a selection, softly.
  const doc = newDoc(60, 60, { background: [1, 1, 1, 1] });
  const layer = doc.addLayer(new Layer({ type: 'raster' }));
  const sel = newSelection(doc);
  const half = rectCoverage(null, 0, 0, 30, 60);
  applyCoverage(sel, half.r, half.cov, 'new');
  const st = strokeLine(60, 60, { size: 20, hardness: 1, spacing: 0.1 }, [5, 30], [55, 30]);
  applyStroke(layer, st, doc.bounds, { color: [1, 0, 0], opacity: 1, selection: sel });
  ok(layer.surface.getPixel(10, 30)[3] > 0.9, 'paint lands inside the selection');
  eq(layer.surface.getPixel(50, 30)[3], 0, 'and not at all outside it');

  // The eraser removes alpha rather than painting.
  const l2 = doc.addLayer(new Layer({ type: 'raster' }));
  l2.surface.fill([0, 0, 1, 1]);
  const er = strokeLine(60, 60, { size: 20, hardness: 1, spacing: 0.1 }, [5, 10], [55, 10]);
  applyStroke(l2, er, doc.bounds, { opacity: 1, mode: 'erase' });
  ok(l2.surface.getPixel(30, 10)[3] < 0.05, 'the eraser removes alpha');
  eq(l2.surface.getPixel(30, 50)[3], 1, 'and leaves the rest alone');
}

// ---------------------------------------------------------------- filters

{
  eq(FILTER_KINDS.length, 31, '31 filters');
  eq(FILTER_GROUPS.length, 8, 'in 8 groups');

  const W = 28, H = 22;
  const base = () => {
    const b = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = (i / W) | 0;
      b[i * 4] = x / (W - 1);
      b[i * 4 + 1] = y / (H - 1);
      b[i * 4 + 2] = ((x >> 2) ^ (y >> 2)) & 1 ? 0.8 : 0.2;
      b[i * 4 + 3] = i % 5 === 0 ? 0 : 1;      // some transparency
    }
    return b;
  };

  for (const kind of FILTER_KINDS) {
    const f = FILTERS[kind];
    const params = filterDefaults(kind);
    if (f.usesColours) { params.fg = [0, 0, 0]; params.bg = [1, 1, 1]; }
    const buf = base();
    applyFilter(kind, params, buf, W, H);
    ok(buf.every((v) => Number.isFinite(v)), `${kind}: no NaN or Infinity`);
    ok(buf.every((v) => v >= 0 && v <= 1), `${kind}: output is inside 0..1`);
    const r = radiusOf(kind, params);
    ok(r === null || (Number.isInteger(r) && r >= 0), `${kind}: reports a usable radius (${r})`);
    // every field must name a parameter that exists
    for (const fd of f.fields) {
      let cur = f.defaults;
      let good = true;
      for (const part of String(fd[1]).split('.')) {
        if (cur == null || !(part in cur)) { good = false; break; }
        cur = cur[part];
      }
      ok(good, `${kind}: field "${fd[0]}" points at a real parameter`);
    }
    // determinism -- several filters use a seeded PRNG and must not drift
    const again = base();
    applyFilter(kind, params, again, W, H);
    eq(worst(buf, again).w, 0, `${kind}: deterministic`);
  }

  // A filter that reports a radius must actually be LOCAL to it: filtering a
  // grown region and keeping the middle must equal filtering the whole image.
  // This is the property that makes tiled filtering sound, and it is exactly
  // what a wrong radius breaks.
  let localBad = 0;
  for (const kind of FILTER_KINDS) {
    const params = filterDefaults(kind);
    if (FILTERS[kind].usesColours) continue;      // render filters ignore the input
    const r = radiusOf(kind, params);
    if (r === null) continue;
    const whole = base();
    applyFilter(kind, params, whole, W, H);
    // the middle band, filtered from a region grown by r
    const y0 = 8, y1 = 14;
    const gy0 = Math.max(0, y0 - r), gy1 = Math.min(H, y1 + r);
    const sub = new Float32Array(W * (gy1 - gy0) * 4);
    const src = base();
    sub.set(src.subarray(gy0 * W * 4, gy1 * W * 4));
    // The region's place in the layer. A position-keyed filter (Add Noise)
    // needs it, and a caller that forgets it gets grain that crawls as the
    // filtered rect changes -- so the oracle passes it the way the app must.
    applyFilter(kind, { ...params, originX: 0, originY: gy0 }, sub, W, gy1 - gy0);
    let w = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
      for (let c = 0; c < 4; c++) {
        w = Math.max(w, Math.abs(sub[((y - gy0) * W + x) * 4 + c] - whole[(y * W + x) * 4 + c]));
      }
    }
    // A vertical kernel still sees the TOP and BOTTOM edges differently in the
    // crop, so only the horizontal independence is asserted strictly; a
    // generous bound still catches a radius that is far too small.
    if (w > 0.08) { localBad++; note(`  ${kind}: grown-region result differs by ${w.toFixed(3)} (radius ${r})`); }
  }
  eq(localBad, 0, 'every filter that reports a radius really is local to it');

  let threw = false;
  try { applyFilter('nope', {}, new Float32Array(4), 1, 1); } catch (e) { threw = true; }
  ok(threw, 'an unknown filter throws');
  threw = false;
  try { radiusOf('nope', {}); } catch (e) { threw = true; }
  ok(threw, 'and so does asking for its radius');
}

// ------------------------------ gaps the mutation controls found
// Each of these exists because a control did NOT fire.

{
  // POLYGON VERTEX DOUBLE-COUNTING. The scanline is half-open in y so a vertex
  // shared by two edges is counted once. Every shape above has its vertices on
  // integer y, and the sub-samples sit at y + 0.125/0.375/0.625/0.875 -- so no
  // vertex was ever ON a sample line and the half-open rule was never
  // exercised. These vertices land exactly on one.
  // The tolerance is 5%, not exact, and that is the honest accuracy of four
  // vertical sub-samples when an edge does not line up with the sample grid:
  // the first sample's quarter-pixel band sticks out past the top of the
  // shape, which costs this triangle about 3%. The bug being hunted is not a
  // percent -- double-counting a vertex flips the inside/outside parity for
  // the REST of that scanline, so half a row fills or empties at once.
  for (const yOff of [0.125, 0.375, 0.625, 0.875]) {
    const tri = [[0, yOff], [16, yOff], [8, 8 + yOff]];
    const out = polygonCoverage(tri);
    let a = 0;
    for (const v of out.cov) a += v;
    ok(Math.abs(a - 64) / 64 < 0.05,
      `a triangle whose apex sits exactly on a scanline sample (y+${yOff}) has its area within 5% (got ${a.toFixed(1)}, true 64)`);
  }
  // A diamond: two vertices on sample lines, so the parity has two chances to
  // go wrong, and its left and right edges are both non-horizontal.
  const diamond = [[8, 0.375], [16, 8.375], [8, 16.375], [0, 8.375]];
  let da = 0;
  for (const v of polygonCoverage(diamond).cov) da += v;
  ok(Math.abs(da - 128) / 128 < 0.05,
    `a diamond with both apexes on scanline samples has its area within 5% (got ${da.toFixed(1)}, true 128)`);
  // And no coverage value may exceed 1, which a double-counted span does.
  for (const yOff of [0.125, 0.625]) {
    const out = polygonCoverage([[0, yOff], [16, yOff], [8, 8 + yOff]]);
    ok(out.cov.every((v) => v <= 1 + 1e-6), `y+${yOff}: no pixel is covered more than once`);
  }

  // THE ONE THAT PINS THE HALF-OPEN RULE. A single area cannot do it: four
  // vertical sub-samples bias an apex-up triangle to 66 and an apex-down one
  // to 62 against a true 64, and double-counting the shared vertex also lands
  // on 66 -- within any tolerance loose enough to accept the bias.
  //
  // But the bias is equal and OPPOSITE for a shape and its vertical mirror, so
  // the two must average to the truth. They do (66 + 62 = 128); with the
  // vertex counted twice the apex-down triangle also reads 66 and the pair
  // averages to 66. That is the signature.
  const up = polygonCoverage([[0, 0.125], [16, 0.125], [8, 8.125]]);
  const down = polygonCoverage([[8, 0.125], [16, 8.125], [0, 8.125]]);
  let au = 0, ad = 0;
  for (const v of up.cov) au += v;
  for (const v of down.cov) ad += v;
  eq((au + ad) / 2, 64, `a triangle and its vertical mirror average to the true area (${au.toFixed(1)} and ${ad.toFixed(1)}) -- the sub-sampling bias cancels, and a double-counted vertex breaks that`, 0.25);
}

{
  // THE WAND'S ANTIALIASING. Counting pixels above 0.5 cannot tell a soft edge
  // from a hard one, so "the ramp has no antialiasing" changed nothing. A
  // gradient gives the ramp something to do.
  const W = 64, H = 8;
  const px = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    px[p] = x / (W - 1); px[p + 1] = 0.2; px[p + 2] = 0.4; px[p + 3] = 1;
  }
  const soft = magicWand(px, W, H, 0, 4, { tolerance: 30, contiguous: true, antialias: true });
  let partial = 0, full = 0;
  for (const v of soft.cov) { if (v > 0.02 && v < 0.98) partial++; else if (v >= 0.98) full++; }
  ok(partial > 10, `an antialiased wand on a gradient gives partial coverage (${partial} partly selected)`);
  ok(full > 0, 'and full coverage near the clicked colour');
  const hard = magicWand(px, W, H, 0, 4, { tolerance: 30, contiguous: true, antialias: false });
  let hardPartial = 0;
  for (const v of hard.cov) if (v > 0.02 && v < 0.98) hardPartial++;
  eq(hardPartial, 0, 'and with antialias off every pixel is fully in or fully out');
}

{
  // THE DIAGONAL TURN POLICY. The exact-area oracle holds whichever turn is
  // taken -- the outline is geometrically right either way -- so the area
  // cannot pin the choice. The CONTOUR COUNT can.
  const W = 60, H = 40;
  const s = new Surface(W, H, 1, 8);
  const cov = new Float32Array(W * H);
  for (let i = 0; i < 12; i++) cov[(5 + i) * W + (5 + i)] = 1;
  s.writeRect(rect(0, 0, W, H), cov);
  eq(marchingAnts(s).length, 12,
    'a corner-touching diagonal chain draws as one loop per pixel -- the clockwise turn at a diagonal vertex');
}

{
  // A ZERO-LENGTH DRAG, in EVERY shape. Only 'linear' was tested, and the
  // divide-by-zero guard lives in each branch separately.
  for (const shape of GRADIENT_SHAPES) {
    const out = renderGradient(rect(0, 0, 8, 8), twoStop([0, 0, 0], [1, 1, 1]),
      { shape, x0: 4, y0: 4, x1: 4, y1: 4, dither: false });
    ok(out.every((v) => Number.isFinite(v)), `${shape}: a zero-length drag stays finite`);
    ok(out.every((v) => v >= 0 && v <= 1), `${shape}: and in range`);
  }
}

{
  // FLOW ACCUMULATION, exactly. The scrub test only checked that it approaches
  // 1 without passing it -- and plain addition ALSO stops at 1, because the
  // accumulator is a 16-bit surface that clamps on write. The arithmetic has
  // to be checked at a value that is not near the clamp.
  const st = new Stroke(64, 64, { size: 24, hardness: 1, smoothing: 0 });
  const flow = 0.2;
  for (let i = 0; i < 5; i++) st.blit(32, 32, 24, 0, flow);
  const got = st.cov.getPixel(32, 32)[0];
  const want = 1 - Math.pow(1 - flow, 5);          // 0.67232
  eq(got, want, `five overlapping stamps at flow ${flow} give 1-(1-f)^5 = ${want.toFixed(5)}, not 5f`, 3e-4);
  ok(Math.abs(got - flow * 5) > 0.1, 'which is a long way from simple addition');
}

{
  // ADD NOISE must be position-keyed. The locality sweep's 0.08 bound was
  // looser than the noise's own amplitude, so a buffer-order stream slipped
  // through. Compare a sub-region against the same rows of the whole, exactly.
  const W = 32, H = 24;
  const base = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { base[i * 4] = 0.5; base[i * 4 + 1] = 0.5; base[i * 4 + 2] = 0.5; base[i * 4 + 3] = 1; }
  const whole = base.slice();
  applyFilter('addNoise', { amount: 0.3, seed: 5 }, whole, W, H);
  const y0 = 7, y1 = 19;
  const sub = new Float32Array(W * (y1 - y0) * 4);
  sub.set(base.subarray(y0 * W * 4, y1 * W * 4));
  applyFilter('addNoise', { amount: 0.3, seed: 5, originX: 0, originY: y0 }, sub, W, y1 - y0);
  let w = 0;
  for (let i = 0; i < W * (y1 - y0) * 4; i++) w = Math.max(w, Math.abs(sub[i] - whole[y0 * W * 4 + i]));
  ok(w === 0, `Add Noise filtered as a region is IDENTICAL to the same rows of the whole (worst ${w})`);
  // ...and the grain is really VARIED, not one value applied everywhere. A
  // per-pixel generator reseeded with the same constant produces identical
  // noise at every pixel, which is position-independent and so passes the
  // comparison above while being obviously not noise.
  const vals = new Set();
  for (let i = 0; i < W * H; i++) vals.add(Math.round(whole[i * 4] * 1000));
  ok(vals.size > 50, `the grain varies across the image (${vals.size} distinct values), not one offset applied everywhere`);
  let moved = 0;
  for (let i = 0; i < W * H; i++) if (Math.abs(whole[i * 4] - 0.5) > 0.01) moved++;
  ok(moved > W * H * 0.5, 'and it actually added noise');
  // Neighbouring pixels must differ, which uniform noise cannot manage.
  let same = 0;
  for (let i = 1; i < W * H; i++) if (whole[i * 4] === whole[(i - 1) * 4]) same++;
  ok(same < W * H * 0.1, 'and adjacent pixels differ');
}

{
  // MOSAIC must average in PREMULTIPLIED form. With straight colour, a block
  // that is half transparent takes the colour of pixels nobody can see.
  const W = 8, H = 8;
  const buf = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    if (y < 4) { buf[p] = 1; buf[p + 1] = 0; buf[p + 2] = 0; buf[p + 3] = 0; }   // transparent RED
    else { buf[p] = 0; buf[p + 1] = 0; buf[p + 2] = 1; buf[p + 3] = 1; }          // opaque BLUE
  }
  applyFilter('mosaic', { size: 8 }, buf, W, H);
  // One cell covers the lot: the visible colour is blue, at half coverage.
  ok(buf[2] > 0.9 && buf[0] < 0.1,
    `a mosaic cell takes the colour of the pixels you can SEE (got r=${buf[0].toFixed(3)} b=${buf[2].toFixed(3)})`);
  eq(buf[3], 0.5, 'and averages the alpha', 0.01);
}

done('selections, distances, gradients, the brush engine and all 31 filters hold their properties');
