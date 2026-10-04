// Oracle: resampling against Pillow, plus the conventions that decide whether
// a resizer is right or merely plausible.
//
// Pillow is the reference because its filters are the same named ones and its
// conventions are documented: BICUBIC is Catmull-Rom with a = -0.5, BILINEAR
// is the triangle, LANCZOS is a 3-lobe Lanczos, and it scales the filter
// support when downscaling. Matching it is therefore a real test rather than
// "the pictures look similar".
//
// Two things had to be pinned, and both were checked rather than assumed:
//
//  * PIXEL CENTRES. Pillow maps destination i to source (i + 0.5) * scale -
//    0.5, the same as here. Had they differed, every comparison would be off
//    by half a pixel and no tolerance would hide it.
//  * ALPHA. Pillow's resize does NOT premultiply, and this code does -- which
//    is correct for an image with transparency and makes the two disagree
//    wherever alpha varies. So the comparison data is fully opaque, and the
//    premultiplying behaviour is checked separately as a property (a blurred
//    cut-out must not grow a halo).
//
// And one about the comparison DATA rather than the code. resize() clamps its
// output to 0..alpha, because Lanczos and Catmull-Rom ring and an unclamped
// overshoot divided by a ringing alpha is how a sharpened edge grows a
// fluorescent fringe. Pillow in mode 'F' does not clamp. Comparing a clamped
// result against an unclamped one made every negative lobe read as zero and
// put Lanczos 0.26 away -- in code that agreed with Pillow to five decimal
// places on every coefficient. So the test field is held inside 0.3..0.7:
// 0.15..0.85 was not enough, because high-frequency noise rings far harder
// than a single edge and still reached the clamp, leaving Lanczos 0.03 out.
// The premise is now checked rather than assumed -- every reference value has
// to sit clear of both ends, or the comparison is reported as meaningless.
// That the clamp happens at all is asserted separately, on a full-range edge.

import { resize, buildTaps, transform, orient, sampleAt, mat, FILTERS, transformedBounds } from '../js/core/resample.js';
import { mulberry32, rect } from '../js/core/util.js';
import { ok, eq, note, done, worst } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

const PAIRS = [
  [32, 24, 96, 72],       // upscale, integer factor
  [96, 72, 32, 24],       // downscale, integer factor
  [37, 23, 61, 41],       // upscale, coprime
  [61, 41, 37, 23],       // downscale, coprime
  [40, 40, 41, 41],       // one pixel bigger
  [40, 40, 39, 39],       // one pixel smaller
  [64, 16, 16, 64],       // aspect inverted
];

const NAME = { nearest: 'NEAREST', bilinear: 'BILINEAR', bicubic: 'BICUBIC', lanczos3: 'LANCZOS' };

function field(w, h, seed) {
  const rnd = mulberry32(seed);
  const buf = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    // structure plus noise: a smooth ramp alone cannot tell two filters apart
    const checker = ((x >> 2) ^ (y >> 2)) & 1;
    // Everything inside 0.3..0.7, so no filter's ringing can reach 0 or 1.
    buf[i * 4] = checker ? 0.7 : 0.3;
    buf[i * 4 + 1] = 0.3 + (x / (w - 1)) * 0.4;
    buf[i * 4 + 2] = 0.3 + rnd() * 0.4;
    buf[i * 4 + 3] = 1;                       // opaque: see the note above
  }
  return buf;
}

// ------------------------------------------------------- exact statements

{
  for (const f of FILTERS) {
    const src = field(16, 16, 1);
    const same = resize(src, 16, 16, 16, 16, f);
    eq(worst(same, src).w, 0, `${f}: resizing to the same size is exactly a copy`);
  }

  // Weights must sum to 1 for every destination index, in every filter and at
  // every scale, or the image changes brightness across its own width.
  let worstSum = 0;
  for (const f of FILTERS) {
    for (const [sw, , dw] of PAIRS) {
      const t = buildTaps(sw, dw, f);
      for (let i = 0; i < dw; i++) {
        let s = 0;
        for (let k = 0; k < t.counts[i]; k++) s += t.weights[i * t.taps + k];
        worstSum = Math.max(worstSum, Math.abs(s - 1));
      }
    }
  }
  ok(worstSum < 1e-6, `every tap row sums to 1 (worst ${worstSum.toExponential(2)})`);

  // Nearest must take exactly one tap, or it is not nearest.
  for (const [sw, , dw] of PAIRS) {
    const t = buildTaps(sw, dw, 'nearest');
    let bad = 0;
    for (let i = 0; i < dw; i++) if (t.counts[i] !== 1) bad++;
    eq(bad, 0, `nearest ${sw}->${dw}: exactly one tap per destination pixel`);
  }

  // An integer-factor nearest upscale must replicate exact blocks.
  const p4 = new Float32Array(2 * 2 * 4);
  for (let i = 0; i < 4; i++) { p4[i * 4] = i / 3; p4[i * 4 + 3] = 1; }
  const up = resize(p4, 2, 2, 6, 6, 'nearest');
  let blockBad = 0;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    const s = ((y < 3 ? 0 : 1) * 2 + (x < 3 ? 0 : 1)) * 4;
    if (Math.abs(up[(y * 6 + x) * 4] - p4[s]) > 1e-6) blockBad++;
  }
  eq(blockBad, 0, 'a 3x nearest upscale replicates each pixel into an exact 3x3 block');

  // Pixel centres. sampleAt(0.5, 0.5) must be pixel (0,0) exactly.
  const ramp = new Float32Array(4 * 4);
  for (let i = 0; i < 4; i++) { ramp[i * 4] = i / 3; ramp[i * 4 + 3] = 1; }
  eq(sampleAt(ramp, 4, 1, 0.5, 0.5, 'bilinear')[0], 0, 'sampleAt(0.5) is pixel 0');
  eq(sampleAt(ramp, 4, 1, 1.5, 0.5, 'bilinear')[0], 1 / 3, 'sampleAt(1.5) is pixel 1', 1e-7);
  eq(sampleAt(ramp, 4, 1, 1.0, 0.5, 'bilinear')[0], 1 / 6, 'sampleAt(1.0) is half way between them', 1e-7);

  // Flat fields, every filter, every pair.
  let worstFlat = 0;
  for (const f of FILTERS) {
    for (const [sw, sh, dw, dh] of PAIRS) {
      const src = new Float32Array(sw * sh * 4);
      for (let p = 0; p < src.length; p += 4) { src[p] = 0.3; src[p + 1] = 0.6; src[p + 2] = 0.9; src[p + 3] = 1; }
      const out = resize(src, sw, sh, dw, dh, f);
      for (let i = 0; i < dw * dh; i++) {
        worstFlat = Math.max(worstFlat,
          Math.abs(out[i * 4] - 0.3), Math.abs(out[i * 4 + 1] - 0.6),
          Math.abs(out[i * 4 + 2] - 0.9), Math.abs(out[i * 4 + 3] - 1));
      }
    }
  }
  ok(worstFlat < 3e-6, `a flat field survives every filter at every scale (worst ${worstFlat.toExponential(2)})`);

  // Ringing must not escape the valid range: Lanczos and Catmull-Rom
  // overshoot at a hard edge, and an un-clamped overshoot divided by a
  // ringing alpha is how a sharpened edge grows a fluorescent fringe.
  const hard = new Float32Array(32 * 4);
  for (let i = 0; i < 32; i++) { hard[i * 4] = i < 16 ? 0 : 1; hard[i * 4 + 3] = 1; }
  for (const f of ['bicubic', 'lanczos3', 'mitchell']) {
    const out = resize(hard, 32, 1, 128, 1, f);
    let bad = 0;
    for (let i = 0; i < out.length; i++) if (out[i] < 0 || out[i] > 1) bad++;
    eq(bad, 0, `${f}: ringing at a hard edge stays inside 0..1`);
  }

  // Rotation by 90 degrees, four times, must be the identity exactly.
  const src = field(16, 12, 5);
  let r = orient(src, 16, 12, 'rot90');
  r = orient(r.data, r.w, r.h, 'rot90');
  r = orient(r.data, r.w, r.h, 'rot90');
  r = orient(r.data, r.w, r.h, 'rot90');
  eq(worst(r.data, src).w, 0, 'four 90-degree rotations are exactly the identity');
  eq(r.w, 16, 'and the size comes back');

  // Four rotations returning to the start does NOT pin the direction: a plain
  // transpose is its own inverse, so doing it four times is also the identity
  // and the control for a wrong rot90 never fired. Pin where one corner goes.
  const marked = new Float32Array(16 * 12 * 4);
  marked[0] = 1; marked[3] = 1;                       // a single marker at (0,0)
  const once = orient(marked, 16, 12, 'rot90');
  eq(once.w, 12, 'rot90 swaps the axes');
  eq(once.h, 16, 'both of them');
  // Clockwise with y down: the top-left corner goes to the TOP-RIGHT.
  const at = (im, w, x, y) => im[(y * w + x) * 4];
  eq(at(once.data, once.w, once.w - 1, 0), 1, 'rot90 sends the top-left pixel to the top-right');
  eq(at(once.data, once.w, 0, 0), 0, 'and not to the top-left');
  // ...and two rot90s must equal one rot180.
  const twice = orient(once.data, once.w, once.h, 'rot90');
  const half = orient(marked, 16, 12, 'rot180');
  eq(worst(twice.data, half.data).w, 0, 'rot90 twice is exactly rot180');
  const thrice = orient(twice.data, twice.w, twice.h, 'rot90');
  const anti = orient(marked, 16, 12, 'rot270');
  eq(worst(thrice.data, anti.data).w, 0, 'and rot90 three times is exactly rot270');
  // Flips are involutions.
  for (const op of ['flipH', 'flipV', 'rot180']) {
    const a = orient(src, 16, 12, op);
    const b = orient(a.data, a.w, a.h, op);
    eq(worst(b.data, src).w, 0, `${op} applied twice is the identity`);
  }

  // The affine helpers.
  const m = mat.mul(mat.translate(3, 4), mat.scale(2, 2));
  eq(JSON.stringify(mat.apply(m, 1, 1)), JSON.stringify([5, 6]), 'translate(3,4) * scale(2) maps (1,1) to (5,6)');
  const inv = mat.invert(m);
  const back = mat.apply(inv, 5, 6);
  ok(Math.abs(back[0] - 1) < 1e-9 && Math.abs(back[1] - 1) < 1e-9, 'and its inverse maps back');
  eq(mat.invert(mat.scale(0, 0)), null, 'a degenerate matrix has no inverse and returns null rather than NaN');
  const about = mat.about(mat.rotate(90), 10, 10);
  const centre = mat.apply(about, 10, 10);
  ok(Math.abs(centre[0] - 10) < 1e-9 && Math.abs(centre[1] - 10) < 1e-9, 'a rotation about a pivot leaves the pivot fixed');
  const tb = transformedBounds(mat.rotate(90), 10, 20);
  eq(`${tb.w}x${tb.h}`, '20x10', 'transformedBounds of a 90-degree rotation swaps the axes');
  // A degenerate transform must give an empty result, not a crash.
  const degen = transform(field(8, 8, 2), 8, 8, mat.scale(0, 0), 8, 8, 'bilinear');
  ok(degen.every((v) => v === 0), 'a degenerate transform produces transparency rather than throwing');
}

{
  // THE HALO PROPERTY, which is why resize premultiplies and why Pillow
  // cannot be the reference for an image with transparency.
  const W = 32, H = 32;
  const src = new Float32Array(W * H * 4);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) {
    const p = (y * W + x) * 4;
    src[p] = src[p + 1] = src[p + 2] = 1;      // white
    src[p + 3] = 1;
  }
  const out = resize(src, W, H, 16, 16, 'bicubic');
  let minColour = 1, sawPartial = false;
  for (let i = 0; i < 16 * 16; i++) {
    const a = out[i * 4 + 3];
    if (a > 0.05 && a < 0.95) { sawPartial = true; minColour = Math.min(minColour, out[i * 4]); }
  }
  ok(sawPartial, 'downscaling the square produced partially transparent edge pixels');
  ok(minColour > 0.99, `every one of them is still white (min ${minColour.toFixed(5)}) -- no dark halo`);
}

if (!havePython()) {
  note('SKIPPED the Pillow comparison: .venv is missing');
  done('resampling is internally exact; reference comparison skipped');
}

// ----------------------------------------------------------- vs Pillow

let worstAll = 0, whereAll = '';
for (const f of Object.keys(NAME)) {
  for (const [sw, sh, dw, dh] of PAIRS) {
    const src = field(sw, sh, sw * 31 + dw);
    // one channel at a time, as a plain 2-D array, since Pillow's F mode is
    // single-channel and that removes any question about channel order
    const chan = new Float64Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) chan[i] = src[i * 4 + 2];
    const out = resize(src, sw, sh, dw, dh, f);
    const got = new Float64Array(dw * dh);
    for (let i = 0; i < dw * dh; i++) got[i] = out[i * 4 + 2];

    const want = runPython(`
from PIL import Image
a = IN.reshape(${sh}, ${sw}).astype('float32')
im = Image.fromarray(a, mode='F')
r = im.resize((${dw}, ${dh}), Image.${NAME[f]})
OUT = np.asarray(r, dtype=np.float64).reshape(-1)
`, chan, [sh, sw]);

    // If anything DID reach the clamp, the comparison would be meaningless,
    // so check the premise rather than assume it.
    let clamped = 0;
    for (let i = 0; i < want.length; i++) if (want[i] < 0.02 || want[i] > 0.98) clamped++;

    // NEAREST has exact ties, and they are not comparable. Where a
    // destination centre lands precisely on a source pixel boundary both
    // neighbours are equidistant and the answer is arbitrary -- every
    // formulation of the centre tried here (floor, int, (2i+1)/2d) agrees with
    // Pillow on 600 of 601 sampled indices and disagrees on the one dead tie,
    // which Pillow resolves downwards from inside its own affine path.
    // Comparing there measures a coin toss, not either implementation, so
    // those columns and rows are skipped and counted.
    let ties = 0;
    const tieCols = new Set(), tieRows = new Set();
    if (f === 'nearest') {
      const near = (t) => Math.abs(t - Math.round(t)) < 1e-9;
      for (let i = 0; i < dw; i++) if (near((i + 0.5) * (sw / dw))) { tieCols.add(i); ties++; }
      for (let j = 0; j < dh; j++) if (near((j + 0.5) * (sh / dh))) { tieRows.add(j); ties++; }
      if (ties) {
        for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
          if (tieCols.has(i) || tieRows.has(j)) { got[j * dw + i] = want[j * dw + i]; }
        }
      }
    }
    const d = worst(got, want);
    if (d.w > worstAll) { worstAll = d.w; whereAll = `${f} ${sw}x${sh}->${dw}x${dh}`; }
    ok(clamped === 0, `${f} ${sw}x${sh} -> ${dw}x${dh}: every reference value is clear of the clamp (${clamped} too close)`);
    ok(d.w < 2e-6, `${f} ${sw}x${sh} -> ${dw}x${dh} matches Pillow (worst ${d.w.toExponential(2)}${ties ? `, ${ties} exact tie(s) skipped` : ''})`);
  }
}
note(`vs Pillow: worst ${worstAll.toExponential(2)} (${whereAll}) -- float32 accumulation here, float64 there`);

// And a control on the premise: if the pixel-centre convention were wrong,
// the comparison WOULD fail. Shifting the source by half a pixel must break it.
{
  const [sw, sh, dw, dh] = [37, 23, 61, 41];
  const src = field(sw, sh, 999);
  const chan = new Float64Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) chan[i] = src[i * 4 + 2];
  const want = runPython(`
from PIL import Image
a = IN.reshape(${sh}, ${sw}).astype('float32')
OUT = np.asarray(Image.fromarray(a, mode='F').resize((${dw}, ${dh}), Image.BICUBIC), dtype=np.float64).reshape(-1)
`, chan, [sh, sw]);
  // resample half a pixel off, by sampling through the transform instead
  const shifted = transform(src, sw, sh, mat.mul(mat.scale(dw / sw, dh / sh), mat.translate(0.5, 0.5)), dw, dh, 'bicubic');
  const got = new Float64Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) got[i] = shifted[i * 4 + 2];
  const d = worst(got, want);
  ok(d.w > 0.05, `a half-pixel shift really does break the Pillow match (${d.w.toFixed(3)}), so the convention is being tested`);
}

done(`resampling matches Pillow across ${Object.keys(NAME).length} filters and ${PAIRS.length} size pairs (worst ${worstAll.toExponential(1)})`);
