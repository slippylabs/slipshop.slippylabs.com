// Oracle: convolution, blur and rank filters against scipy.ndimage.
//
// Three conventions have to be pinned or the comparison measures the wrong
// thing. Each of these was checked rather than assumed:
//
//  1. RADIUS. scipy derives the gaussian window from `truncate`; we derive it
//     from ceil(3*sigma). At sigma 0.7 those give 2 and 3. scipy takes an
//     explicit `radius`, so the oracle passes ours in and the windows match.
//  2. CORRELATE, NOT CONVOLVE. Every image editor's "convolution" is
//     mathematically a correlation -- the kernel is NOT flipped. scipy has
//     both, and picking the wrong one makes an asymmetric kernel like emboss
//     look mirrored. There is an explicit check below that the two differ, so
//     this cannot quietly stop mattering.
//  3. BORDER NAMES. clamp = 'nearest', reflect = 'mirror' (no repeated edge
//     sample), wrap = 'grid-wrap', zero = 'constant' with cval 0.
//
// WHICH LAYER IS COMPARED matters, and getting it wrong produced five
// confident failures in correct code. gaussianBlur() premultiplies, so under a
// zero border the alpha falls off at the edge and un-premultiplying divides
// the colour back up -- the colour is RESTORED rather than darkened, which is
// exactly the behaviour an image wants and is 0.4 away from what scipy
// returns for a raw channel. So scipy is compared against `separable`, the
// convolution primitive, and the premultiplying wrapper is pinned to that
// primitive by a separate identity. Comparing the wrapper against scipy would
// have meant either a meaningless tolerance or deleting premultiply.

import {
  gaussianKernel, gaussianRadius, gaussianBlur, boxBlur, separable, convolve,
  rankFilter, unsharpMask, highPass, premultiply, unpremultiply, KERNELS, motionBlur,
} from '../js/core/convolve.js';
import { mulberry32 } from '../js/core/util.js';
import { ok, eq, note, done, worst } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

const W = 37, H = 23;        // prime-ish, so no stride accident hides anything
const N = W * H;

function testField(seed) {
  const rnd = mulberry32(seed);
  const buf = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    buf[p] = rnd(); buf[p + 1] = rnd(); buf[p + 2] = rnd(); buf[p + 3] = 1;
  }
  return buf;
}

/** Pull one channel out as a plain w*h array for scipy. */
function channel(buf, c) {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = buf[i * 4 + c];
  return out;
}

const MODES = [['clamp', 'nearest'], ['reflect', 'mirror'], ['wrap', 'grid-wrap'], ['zero', 'constant']];

// --------------------------------------------------------- exact statements

{
  for (const sigma of [0.5, 0.7, 1, 1.5, 2, 3.3, 7]) {
    const { k, r } = gaussianKernel(sigma);
    eq(r, gaussianRadius(sigma), `sigma ${sigma}: the kernel uses the exported radius rule`);
    eq(k.length, r * 2 + 1, `sigma ${sigma}: kernel length matches its radius`);
    let s = 0;
    for (let i = 0; i < k.length; i++) s += k[i];
    ok(Math.abs(s - 1) < 1e-6, `sigma ${sigma}: the kernel sums to 1 (${s.toFixed(9)}) -- otherwise a blur changes brightness`);
    // symmetric about the centre
    let asym = 0;
    for (let i = 0; i < k.length; i++) asym = Math.max(asym, Math.abs(k[i] - k[k.length - 1 - i]));
    ok(asym < 1e-7, `sigma ${sigma}: the kernel is symmetric`);
    ok(k[r] === Math.max(...k), `sigma ${sigma}: the peak is at the centre`);
  }
}

{
  // A flat field must survive any blur in any mode. This is the partition of
  // unity, and it is what stops a blur from darkening a solid colour.
  for (const [mode] of MODES) {
    for (const sigma of [1, 4]) {
      const buf = new Float32Array(N * 4);
      for (let p = 0; p < buf.length; p += 4) { buf[p] = 0.3; buf[p + 1] = 0.6; buf[p + 2] = 0.9; buf[p + 3] = 1; }
      const before = buf.slice();
      gaussianBlur(buf, W, H, sigma, mode);
      let w = 0;
      // 'zero' legitimately darkens the border -- that is what zero means --
      // so for that mode only the interior is checked.
      const pad = mode === 'zero' ? gaussianRadius(sigma) : 0;
      for (let y = pad; y < H - pad; y++) for (let x = pad; x < W - pad; x++) {
        const p = (y * W + x) * 4;
        for (let c = 0; c < 4; c++) w = Math.max(w, Math.abs(buf[p + c] - before[p + c]));
      }
      ok(w < 2e-6, `${mode} sigma ${sigma}: a flat field is unchanged in the interior (worst ${w.toExponential(2)})`);
    }
  }
}

{
  // THE HALO PROPERTY. An opaque white square on a fully transparent BLACK
  // background: blurring straight colour drags that black into the edge and
  // the square gets a dark rim. Premultiplied, the colour at the edge stays
  // white and only the alpha falls off. No reference library has a view on
  // this; it is the reason every spatial filter here premultiplies.
  const buf = new Float32Array(N * 4);
  for (let y = 8; y < 16; y++) for (let x = 12; x < 24; x++) {
    const p = (y * W + x) * 4;
    buf[p] = buf[p + 1] = buf[p + 2] = 1; buf[p + 3] = 1;
  }
  const blurred = buf.slice();
  gaussianBlur(blurred, W, H, 2, 'clamp');
  let minColour = 1, sawPartial = false;
  for (let i = 0; i < N; i++) {
    const a = blurred[i * 4 + 3];
    if (a > 0.05 && a < 0.95) { sawPartial = true; minColour = Math.min(minColour, blurred[i * 4]); }
  }
  ok(sawPartial, 'the blur really produced partially transparent edge pixels');
  ok(minColour > 0.999, `every partly transparent edge pixel is still white (min ${minColour.toFixed(6)}) -- no dark halo`);

  // And the control: the same blur WITHOUT premultiplying does halo, which is
  // what proves the test can fail.
  const naive = buf.slice();
  const { k, r } = gaussianKernel(2);
  separable(naive, W, H, k, r, 'clamp', true);
  let naiveMin = 1;
  for (let i = 0; i < N; i++) {
    const a = naive[i * 4 + 3];
    if (a > 0.05 && a < 0.95) naiveMin = Math.min(naiveMin, naive[i * 4]);
  }
  ok(naiveMin < 0.9, `and filtering straight colour DOES halo (min ${naiveMin.toFixed(4)}), so the check above is meaningful`);
}

{
  // An identity kernel must be a no-op, and a uniform kernel must preserve a
  // flat field -- the two cheapest ways a divisor bug shows up.
  const buf = testField(7);
  const before = buf.slice();
  convolve(buf, W, H, KERNELS.identity.k, 3, 3, { mode: 'clamp' });
  const wId = worst(buf, before);
  ok(wId.w < 1e-6, `the identity kernel is a no-op (worst ${wId.w.toExponential(2)})`);

  const flat = new Float32Array(N * 4);
  for (let p = 0; p < flat.length; p += 4) { flat[p] = flat[p + 1] = flat[p + 2] = 0.42; flat[p + 3] = 1; }
  const f2 = flat.slice();
  convolve(f2, W, H, KERNELS.blur3.k, 3, 3, { mode: 'clamp' });
  const wFlat = worst(f2, flat);
  ok(wFlat.w < 1e-6, `a 3x3 box kernel divides by its sum (flat field unchanged, worst ${wFlat.w.toExponential(2)})`);
}

{
  // The alpha channel must survive a colour convolution. An edge-detect
  // kernel run over alpha turns an opaque layer transparent in flat areas,
  // which looks like the filter deleted the image.
  const buf = testField(11);
  for (let i = 0; i < N; i++) buf[i * 4 + 3] = 1;
  convolve(buf, W, H, KERNELS.findEdges.k, 3, 3, { mode: 'clamp' });
  let minA = 1;
  for (let i = 0; i < N; i++) minA = Math.min(minA, buf[i * 4 + 3]);
  ok(minA > 0.999, `an edge-detect kernel leaves alpha alone (min ${minA.toFixed(6)})`);
}

if (!havePython()) {
  note('SKIPPED the scipy comparisons: .venv is missing');
  done('convolution is internally consistent; reference comparison skipped');
}

// ------------------------------------------------------------ vs scipy

// 1. Gaussian blur, every mode, several sigmas, radius pinned.
let worstG = 0, whereG = '';
for (const [mine, theirs] of MODES) {
  for (const sigma of [0.7, 1, 2.5, 5]) {
    const buf = testField(100 + Math.round(sigma * 10));
    const src = channel(buf, 0);
    const { k, r } = gaussianKernel(sigma);
    separable(buf, W, H, k, r, mine, true);      // the primitive, not the wrapper
    const got = channel(buf, 0);
    const want = runPython(`
from scipy.ndimage import gaussian_filter
a = IN.reshape(${H}, ${W})
OUT = gaussian_filter(a, sigma=${sigma}, mode=${JSON.stringify(theirs)}, cval=0.0, radius=${gaussianRadius(sigma)}).reshape(-1)
`, src, [H, W]);
    const d = worst(got, want);
    if (d.w > worstG) { worstG = d.w; whereG = `${mine} sigma ${sigma}`; }
    ok(d.w < 3e-6, `gaussian ${mine}/${theirs} sigma ${sigma} matches scipy (worst ${d.w.toExponential(2)})`);
  }
}
note(`gaussian vs scipy: worst ${worstG.toExponential(2)} (${whereG}) -- float32 accumulation, scipy works in float64`);

// 2. Box blur against a uniform filter.
for (const [mine, theirs] of MODES) {
  const r = 3;
  const buf = testField(55);
  const src = channel(buf, 1);
  const bk = new Float32Array(r * 2 + 1).fill(1 / (r * 2 + 1));
  separable(buf, W, H, bk, r, mine, true);
  const got = channel(buf, 1);
  const want = runPython(`
from scipy.ndimage import uniform_filter
a = IN.reshape(${H}, ${W})
OUT = uniform_filter(a, size=${r * 2 + 1}, mode=${JSON.stringify(theirs)}, cval=0.0).reshape(-1)
`, src, [H, W]);
  const d = worst(got, want);
  ok(d.w < 3e-6, `box blur r=${r} ${mine} matches scipy uniform_filter (worst ${d.w.toExponential(2)})`);
}

// 2b. The premultiplying wrappers ARE the primitive, sandwiched. This is what
//     licenses comparing scipy against `separable` instead of against them.
for (const [mode] of MODES) {
  const sigma = 2;
  const buf = testField(201);
  // give alpha some structure, or premultiply is the identity and proves nothing
  for (let i = 0; i < N; i++) buf[i * 4 + 3] = (i % W) / (W - 1);
  const viaWrapper = buf.slice();
  gaussianBlur(viaWrapper, W, H, sigma, mode);
  const byHand = buf.slice();
  const { k, r } = gaussianKernel(sigma);
  premultiply(byHand);
  separable(byHand, W, H, k, r, mode, true);
  unpremultiply(byHand);
  const d = worst(viaWrapper, byHand);
  ok(d.w === 0, `gaussianBlur ${mode} is exactly premultiply + separable + unpremultiply`);

  const bb = buf.slice();
  boxBlur(bb, W, H, 3, mode);
  const bh = buf.slice();
  const bk = new Float32Array(7).fill(1 / 7);
  premultiply(bh);
  separable(bh, W, H, bk, 3, mode, true);
  unpremultiply(bh);
  ok(worst(bb, bh).w === 0, `boxBlur ${mode} is exactly the same sandwich`);
}

{
  // premultiply/unpremultiply round-trip, including the one case that cannot
  // round-trip: a fully transparent pixel has no colour to recover, and
  // returning NaN there (a 0/0 divide) is the bug this guards.
  const buf = testField(303);
  for (let i = 0; i < N; i++) buf[i * 4 + 3] = i % 5 === 0 ? 0 : (i % W) / (W - 1);
  const before = buf.slice();
  premultiply(buf);
  unpremultiply(buf);
  let w = 0, nan = 0;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    if (!Number.isFinite(buf[p]) || !Number.isFinite(buf[p + 1])) nan++;
    if (before[p + 3] === 0) continue;          // colour is undefined there
    for (let c = 0; c < 4; c++) w = Math.max(w, Math.abs(buf[p + c] - before[p + c]));
  }
  eq(nan, 0, 'un-premultiplying a fully transparent pixel does not produce NaN');
  ok(w < 2e-7, `premultiply round-trips wherever alpha is non-zero (worst ${w.toExponential(2)})`);
  let zeroed = 0;
  for (let i = 0; i < N; i++) if (before[i * 4 + 3] === 0 && buf[i * 4] !== 0) zeroed++;
  eq(zeroed, 0, 'and a transparent pixel comes back as zero rather than as garbage');
}

// 3. 2-D convolution with an ASYMMETRIC kernel, against correlate.
const asym = [0, 1, 2, 0, 0, 0, 0, 0, -3];          // nothing symmetric about it
for (const [mine, theirs] of MODES) {
  const buf = testField(77);
  const src = channel(buf, 2);
  convolve(buf, W, H, asym, 3, 3, { mode: mine, divisor: 1, bias: 0 });
  const got = channel(buf, 2);
  const want = runPython(`
from scipy.ndimage import correlate
import numpy as np
a = IN.reshape(${H}, ${W})
k = np.array(${JSON.stringify(asym)}, dtype=np.float64).reshape(3, 3)
OUT = correlate(a, k, mode=${JSON.stringify(theirs)}, cval=0.0).reshape(-1)
`, src, [H, W]);
  const d = worst(got, want);
  ok(d.w < 3e-6, `convolve ${mine} matches scipy CORRELATE with an asymmetric kernel (worst ${d.w.toExponential(2)})`);
}

// ...and the flip actually matters, so choosing correlate was a real decision.
{
  const src = channel(testField(77), 2);
  const corr = runPython(`
from scipy.ndimage import correlate
import numpy as np
OUT = correlate(IN.reshape(${H}, ${W}), np.array(${JSON.stringify(asym)}).reshape(3,3), mode='nearest').reshape(-1)
`, src, [H, W]);
  const conv = runPython(`
from scipy.ndimage import convolve
import numpy as np
OUT = convolve(IN.reshape(${H}, ${W}), np.array(${JSON.stringify(asym)}).reshape(3,3), mode='nearest').reshape(-1)
`, src, [H, W]);
  const d = worst(corr, conv);
  ok(d.w > 0.01, `scipy's correlate and convolve really differ for this kernel (${d.w.toFixed(3)}), so picking correlate was a choice and not luck`);
}

// 4. Rank filters.
for (const [rank, fn] of [[0.5, 'median_filter'], [0, 'minimum_filter'], [1, 'maximum_filter']]) {
  for (const [mine, theirs] of [['clamp', 'nearest'], ['reflect', 'mirror']]) {
    const r = 2;
    const buf = testField(91);
    const src = channel(buf, 0);
    rankFilter(buf, W, H, r, rank, mine);
    const got = channel(buf, 0);
    const want = runPython(`
from scipy.ndimage import ${fn}
a = IN.reshape(${H}, ${W})
OUT = ${fn}(a, size=${r * 2 + 1}, mode=${JSON.stringify(theirs)}).reshape(-1)
`, src, [H, W]);
    const d = worst(got, want);
    ok(d.w < 1e-6, `rank ${rank} (${fn}) ${mine} matches scipy (worst ${d.w.toExponential(2)})`);
  }
}

// 5. Unsharp mask is a composition, so check the identity rather than a
//    library: amount 0 is a no-op, and the result is src + amount*(src-blur).
{
  const buf = testField(13);
  const before = buf.slice();
  unsharpMask(buf, W, H, { radius: 2, amount: 0 });
  ok(worst(buf, before).w === 0, 'unsharp with amount 0 is exactly a no-op');

  const b2 = before.slice();
  const blurred = before.slice();
  gaussianBlur(blurred, W, H, 2, 'clamp');
  unsharpMask(b2, W, H, { radius: 2, amount: 1.5, threshold: 0 });
  let w2 = 0;
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) {
    const p = i * 4 + c;
    w2 = Math.max(w2, Math.abs(b2[p] - (before[p] + 1.5 * (before[p] - blurred[p]))));
  }
  ok(w2 < 1e-6, `unsharp is exactly src + amount*(src - blur) (worst ${w2.toExponential(2)})`);

  // A threshold above the largest local difference must leave everything alone.
  const b3 = before.slice();
  unsharpMask(b3, W, H, { radius: 2, amount: 2, threshold: 10 });
  ok(worst(b3, before).w === 0, 'a threshold above every local difference is a no-op');
}

{
  // High pass of a flat field is exactly mid grey: the DC term is removed.
  const flat = new Float32Array(N * 4);
  for (let p = 0; p < flat.length; p += 4) { flat[p] = flat[p + 1] = flat[p + 2] = 0.8; flat[p + 3] = 1; }
  highPass(flat, W, H, 3, 'clamp');
  let w = 0;
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) w = Math.max(w, Math.abs(flat[i * 4 + c] - 0.5));
  ok(w < 2e-6, `high pass of a flat field is exactly 0.5 (worst ${w.toExponential(2)})`);
}

{
  // Motion blur along a row at angle 0 must equal a 1-D box blur of that row.
  const buf = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { const p = i * 4; buf[p] = (i % W) / W; buf[p + 3] = 1; }
  const mb = buf.slice();
  motionBlur(mb, W, H, { length: 5, angle: 0, mode: 'clamp' });
  // the centre of a horizontal run: mean of five neighbours
  let w = 0;
  for (let y = 0; y < H; y++) for (let x = 2; x < W - 2; x++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += buf[(y * W + x + d) * 4];
    w = Math.max(w, Math.abs(mb[(y * W + x) * 4] - s / 5));
  }
  ok(w < 1e-6, `horizontal motion blur of length 5 is the 5-tap mean (worst ${w.toExponential(2)})`);
}

done(`convolution, blur and rank filters match scipy (gaussian worst ${worstG.toExponential(1)})`);
