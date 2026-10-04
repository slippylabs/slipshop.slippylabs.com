// Oracle: the colour spaces.
//
// Three different kinds of check, because no single reference covers this file:
//
//  1. Against scikit-image, for the two transforms where its conventions can
//     be pinned exactly -- CIEDE2000 (Lab in, scalar out: no matrix and no
//     illuminant are involved, so there is nothing to disagree about) and HSV.
//  2. Against scikit-image's OWN constants substituted into our code, for
//     Lab. skimage ships an older, coarsely rounded sRGB matrix, so a direct
//     diff shows 1e-4 differences that belong to its constants. Feeding its
//     matrix and white point in turns a vague "close enough" into an exact
//     match, which is the only version of this comparison worth running.
//  3. Against exact statements, where a library would add nothing: round
//     trips, greys having zero chroma, the transfer function's continuity at
//     its breakpoint, and the two OKLab matrices being mutual inverses.
//
// Python's stdlib colorsys is used for HSL, which skimage does not provide --
// a genuinely separate implementation, and one nobody can claim we copied.

import {
  srgbToLinear, linearToSrgb, BYTE_TO_LINEAR,
  rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToCmyk, cmykToRgb,
  linearRgbToXyz, xyzToLinearRgb, xyzToLab, labToXyz, rgbToLab, labToRgb,
  labToLch, lchToLab, rgbToOklab, oklabToRgb, linearRgbToOklab, oklabToLinearRgb,
  oklabToOklch, oklchToOklab, deltaE76, deltaE2000,
  parseHex, toHex, D65, M_RGB2XYZ, M_XYZ2RGB, invert3, inGamut, EPS, KAPPA,
} from '../js/core/color.js';
import { ok, eq, note, done, worst } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

// scikit-image's constants, read out of skimage.color.colorconv.
const SK_M = [[0.412453, 0.35758, 0.180423], [0.212671, 0.71516, 0.072169], [0.019334, 0.119193, 0.950227]];
const SK_W = [0.95047, 1.0, 1.08883];
// skimage's xyz2lab still uses the historical rounded pair, 0.008856 and
// 7.787*t + 16/116, rather than the exact CIE rationals. Read straight out of
// its source; without these the toe disagrees by 1.6e-4 and the comparison
// says nothing about whether the algorithm matches.
const SK_EPS = 0.008856;
const SK_KAPPA = 7.787 * 116;
const SK_OPTS = { matrix: SK_M, white: SK_W, eps: SK_EPS, kappa: SK_KAPPA };

// ----------------------------------------------------------- exact statements

eq(rgbToLab(1, 1, 1)[0], 100, 'white is exactly L*100');
eq(rgbToLab(1, 1, 1)[1], 0, 'white has exactly a*0 -- only true if the white point is the matrix own');
eq(rgbToLab(1, 1, 1)[2], 0, 'white has exactly b*0');
eq(rgbToLab(0, 0, 0)[0], 0, 'black is exactly L*0');
// 6.5e-9 is M_LMS2OKLAB's first row not summing to exactly 1 -- the precision
// of Ottosson's published constants. Tight enough that a real error fails.
eq(rgbToOklab(1, 1, 1)[0], 1, 'white is OKLab L 1 to the published constants precision', 1e-8);
eq(rgbToOklab(0, 0, 0)[0], 0, 'black is OKLab L 0', 1e-12);

// The transfer function is piecewise and the two pieces must meet. A plain
// 2.2 gamma is the usual shortcut and is wrong by 0.4% in the shadows.
eq(srgbToLinear(0.04045), 0.04045 / 12.92, 'transfer is continuous at the breakpoint (toe side)', 1e-12);
eq(srgbToLinear(0.04045), Math.pow((0.04045 + 0.055) / 1.055, 2.4), 'and on the power side', 1e-7);
eq(srgbToLinear(0), 0, 'transfer maps 0 to 0');
eq(srgbToLinear(1), 1, 'transfer maps 1 to 1', 1e-15);
eq(linearToSrgb(0), 0, 'inverse maps 0 to 0');
eq(linearToSrgb(1), 1, 'inverse maps 1 to 1', 1e-15);
ok(Math.abs(srgbToLinear(0.5) - Math.pow(0.5, 2.2)) > 1e-3,
  'the real transfer differs measurably from a 2.2 gamma (so the control can fail)');

// Monotonicity: a tone curve that is not monotone inverts tones somewhere.
let mono = true;
for (let i = 1; i <= 2000; i++) {
  if (srgbToLinear(i / 2000) <= srgbToLinear((i - 1) / 2000)) mono = false;
  if (linearToSrgb(i / 2000) <= linearToSrgb((i - 1) / 2000)) mono = false;
}
ok(mono, 'both transfer directions are strictly increasing');

// The byte table must agree with the function it caches.
let tbl = 0;
for (let i = 0; i < 256; i++) tbl = Math.max(tbl, Math.abs(BYTE_TO_LINEAR[i] - srgbToLinear(i / 255)));
ok(tbl < 1e-7, `BYTE_TO_LINEAR matches srgbToLinear (worst ${tbl.toExponential(2)}, float32 storage)`);

// Greys must have exactly zero chroma in every opponent space, or a
// desaturated image picks up a tint.
let chroma = 0, okChroma = 0;
for (let i = 0; i <= 255; i++) {
  const v = i / 255;
  const lab = rgbToLab(v, v, v);
  chroma = Math.max(chroma, Math.abs(lab[1]), Math.abs(lab[2]));
  const o = rgbToOklab(v, v, v);
  okChroma = Math.max(okChroma, Math.abs(o[1]), Math.abs(o[2]));
}
ok(chroma < 1e-12, `every grey has zero Lab chroma (worst ${chroma.toExponential(2)})`);
ok(okChroma < 1e-7, `every grey has near-zero OKLab chroma (worst ${okChroma.toExponential(2)}, the published matrices own precision)`);

// The OKLab matrices are published as a pair; if they are not mutual inverses
// the round trip drifts and no reference library here would tell us.
let okInv = 0;
for (let i = 0; i < 3; i++) {
  const e = [0, 0, 0]; e[i] = 1;
  const back = oklabToLinearRgb(...linearRgbToOklab(e[0], e[1], e[2]));
  for (let j = 0; j < 3; j++) okInv = Math.max(okInv, Math.abs(back[j] - e[j]));
}
ok(okInv < 1e-14, `the OKLab round trip is exact because the inverses are COMPUTED (worst ${okInv.toExponential(2)})`);

// invert3 is load bearing: the whole XYZ inverse comes from it.
const I = invert3(M_RGB2XYZ);
let invErr = 0;
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  let acc = 0;
  for (let k = 0; k < 3; k++) acc += M_RGB2XYZ[i][k] * I[k][j];
  invErr = Math.max(invErr, Math.abs(acc - (i === j ? 1 : 0)));
}
ok(invErr < 1e-15, `invert3 really inverts (worst off-identity ${invErr.toExponential(2)})`);
eq(JSON.stringify(I), JSON.stringify(M_XYZ2RGB), 'the exported inverse is the computed one');

// Round trips, over a 17^3 cube.
const RT = [];
for (let r = 0; r <= 16; r++) for (let g = 0; g <= 16; g++) for (let b = 0; b <= 16; b++) RT.push([r / 16, g / 16, b / 16]);
const rtWorst = { xyz: 0, lab: 0, oklab: 0, hsl: 0, hsv: 0, cmyk: 0, lch: 0, oklch: 0 };
for (const [r, g, b] of RT) {
  let o = xyzToLinearRgb(...linearRgbToXyz(r, g, b));
  rtWorst.xyz = Math.max(rtWorst.xyz, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  o = labToRgb(...rgbToLab(r, g, b));
  rtWorst.lab = Math.max(rtWorst.lab, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  o = oklabToRgb(...rgbToOklab(r, g, b));
  rtWorst.oklab = Math.max(rtWorst.oklab, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  o = hslToRgb(...rgbToHsl(r, g, b));
  rtWorst.hsl = Math.max(rtWorst.hsl, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  o = hsvToRgb(...rgbToHsv(r, g, b));
  rtWorst.hsv = Math.max(rtWorst.hsv, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  o = cmykToRgb(...rgbToCmyk(r, g, b));
  rtWorst.cmyk = Math.max(rtWorst.cmyk, ...o.map((v, i) => Math.abs(v - [r, g, b][i])));
  const lab = rgbToLab(r, g, b);
  o = lchToLab(...labToLch(...lab));
  rtWorst.lch = Math.max(rtWorst.lch, ...o.map((v, i) => Math.abs(v - lab[i])));
  const okl = rgbToOklab(r, g, b);
  o = oklchToOklab(...oklabToOklch(...okl));
  rtWorst.oklch = Math.max(rtWorst.oklch, ...o.map((v, i) => Math.abs(v - okl[i])));
}
for (const [k, v] of Object.entries(rtWorst)) {
  ok(v < 1e-12, `${k} round trip is exact to float64 (worst ${v.toExponential(2)})`);
}

// Hex.
eq(toHex([0.2235294117647059, 1, 0.5607843137254902]), '#39ff8f', 'toHex');
eq(JSON.stringify(parseHex('#39ff8f')), JSON.stringify([57 / 255, 255 / 255, 143 / 255, 1]), 'parseHex 6 digit');
eq(JSON.stringify(parseHex('abc')), JSON.stringify([170 / 255, 187 / 255, 204 / 255, 1]), 'parseHex 3 digit expands');
eq(parseHex('#39ff8f80')[3], 128 / 255, 'parseHex 8 digit keeps alpha');
eq(parseHex('#12345'), null, 'parseHex rejects a 5-digit string');
eq(parseHex('#gggggg'), null, 'parseHex rejects non-hex');
eq(deltaE76([50, 0, 0], [50, 3, 4]), 5, 'deltaE76 is a plain euclidean distance');
eq(deltaE2000([50, 2, -3], [50, 2, -3]), 0, 'deltaE2000 of a colour with itself is 0');

// ------------------------------------------------------- reference libraries

if (!havePython()) {
  note('SKIPPED the scikit-image comparisons: .venv is missing (python3 -m venv .venv && .venv/bin/pip install numpy scipy scikit-image pillow)');
  done('colour spaces are internally exact; reference comparison skipped');
}

// --- Lab, with skimage's own constants substituted in ---
const N = 4096;
const samples = new Float64Array(N * 3);
let si = 0;
let a = 0x12345678;
const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let i = 0; i < N; i++) {
  // mix structured edges with a seeded spread so the toe of the transfer and
  // the Lab epsilon branch both get hit
  if (i < 256) { const v = i / 255; samples[si++] = v; samples[si++] = v; samples[si++] = v; }
  else { samples[si++] = rnd(); samples[si++] = rnd(); samples[si++] = rnd(); }
}

const skLab = runPython(`
from skimage import color as C
OUT = C.rgb2lab(IN.reshape(-1, 1, 3)).reshape(-1)
`, samples, [N, 3]);

const mineSk = new Float64Array(N * 3);
for (let i = 0; i < N; i++) {
  const lab = rgbToLab(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], SK_OPTS);
  mineSk[i * 3] = lab[0]; mineSk[i * 3 + 1] = lab[1]; mineSk[i * 3 + 2] = lab[2];
}
const wLab = worst(mineSk, skLab);
ok(wLab.w < 1e-10, `Lab matches scikit-image EXACTLY with its own constants (worst ${wLab.w.toExponential(2)} over ${N} colours)`);
eq(EPS, 216 / 24389, 'our epsilon is the exact CIE rational, not 0.008856');
eq(KAPPA, 24389 / 27, 'our kappa is the exact CIE rational, so KAPPA/116 is 7.787037... not 7.787');
ok(Math.abs(SK_EPS - EPS) > 4e-7, 'and skimage\'s differs enough to matter in the toe');

// And with our constants it differs only by the constants -- small, and in
// the direction the white-point difference predicts.
const mineOwn = new Float64Array(N * 3);
for (let i = 0; i < N; i++) {
  const lab = rgbToLab(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
  mineOwn[i * 3] = lab[0]; mineOwn[i * 3 + 1] = lab[1]; mineOwn[i * 3 + 2] = lab[2];
}
const wOwn = worst(mineOwn, skLab);
ok(wOwn.w < 0.02, `with our own constants the gap to skimage stays under 0.02 Lab (worst ${wOwn.w.toExponential(2)})`);
ok(wOwn.w > wLab.w, 'and that gap is bigger than the matched-constants gap, i.e. it really is the constants');
note(`Lab vs skimage: ${wLab.w.toExponential(2)} with its constants, ${wOwn.w.toExponential(2)} with ours`);

// --- CIEDE2000: no illuminant, no matrix, nothing to disagree about ---
const M = 20000;
const labPairs = new Float64Array(M * 6);
for (let i = 0; i < M; i++) {
  const o = i * 6;
  // Lab space proper, including the high-chroma and near-neutral regions
  // where the RT term and the h-prime averaging actually matter.
  labPairs[o] = rnd() * 100;
  labPairs[o + 1] = (rnd() - 0.5) * 256;
  labPairs[o + 2] = (rnd() - 0.5) * 256;
  if (i % 4 === 0) {           // near-neutral pairs: the 0/360 hue wrap
    labPairs[o + 3] = labPairs[o] + (rnd() - 0.5) * 2;
    labPairs[o + 4] = labPairs[o + 1] + (rnd() - 0.5) * 0.4;
    labPairs[o + 5] = labPairs[o + 2] + (rnd() - 0.5) * 0.4;
  } else {
    labPairs[o + 3] = rnd() * 100;
    labPairs[o + 4] = (rnd() - 0.5) * 256;
    labPairs[o + 5] = (rnd() - 0.5) * 256;
  }
}
const skDE = runPython(`
from skimage import color as C
p = IN.reshape(-1, 6)
A = p[:, 0:3].reshape(-1, 1, 3)
B = p[:, 3:6].reshape(-1, 1, 3)
OUT = C.deltaE_ciede2000(A, B).reshape(-1)
`, labPairs, [M, 6]);

const mineDE = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const o = i * 6;
  mineDE[i] = deltaE2000([labPairs[o], labPairs[o + 1], labPairs[o + 2]],
                         [labPairs[o + 3], labPairs[o + 4], labPairs[o + 5]]);
}
const wDE = worst(mineDE, skDE);
ok(wDE.w < 1e-9, `CIEDE2000 matches scikit-image over ${M} random Lab pairs (worst ${wDE.w.toExponential(2)})`);
note(`CIEDE2000 vs skimage: worst ${wDE.w.toExponential(2)} over ${M} pairs`);

// Symmetry is a property of the metric, and the one the h-prime averaging
// breaks first if it is wrong.
let asym = 0;
for (let i = 0; i < M; i++) {
  const o = i * 6;
  const d1 = deltaE2000([labPairs[o], labPairs[o + 1], labPairs[o + 2]], [labPairs[o + 3], labPairs[o + 4], labPairs[o + 5]]);
  const d2 = deltaE2000([labPairs[o + 3], labPairs[o + 4], labPairs[o + 5]], [labPairs[o], labPairs[o + 1], labPairs[o + 2]]);
  asym = Math.max(asym, Math.abs(d1 - d2));
}
ok(asym < 1e-9, `deltaE2000 is symmetric (worst asymmetry ${asym.toExponential(2)})`);

// --- HSV against skimage, HSL against the stdlib ---
const skHsv = runPython(`
from skimage import color as C
OUT = C.rgb2hsv(IN.reshape(-1, 1, 3)).reshape(-1)
`, samples, [N, 3]);
const mineHsv = new Float64Array(N * 3);
for (let i = 0; i < N; i++) {
  const h = rgbToHsv(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
  mineHsv[i * 3] = h[0] / 360; mineHsv[i * 3 + 1] = h[1]; mineHsv[i * 3 + 2] = h[2];
}
const wHsv = worst(mineHsv, skHsv);
ok(wHsv.w < 1e-12, `HSV matches scikit-image (worst ${wHsv.w.toExponential(2)}); note skimage scales hue to 0..1`);

const pyHls = runPython(`
import colorsys
p = IN.reshape(-1, 3)
OUT = np.array([colorsys.rgb_to_hls(*row) for row in p]).reshape(-1)
`, samples, [N, 3]);
const mineHls = new Float64Array(N * 3);
for (let i = 0; i < N; i++) {
  const h = rgbToHsl(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
  // colorsys returns H, L, S in that order -- not H, S, L. Getting this wrong
  // reads as a saturation bug in correct code.
  mineHls[i * 3] = h[0] / 360; mineHls[i * 3 + 1] = h[2]; mineHls[i * 3 + 2] = h[1];
}
const wHls = worst(mineHls, pyHls);
ok(wHls.w < 1e-12, `HSL matches Python's stdlib colorsys (worst ${wHls.w.toExponential(2)})`);

// --- the transfer function, isolated ---
// For a grey input the Y row of the matrix sums to 1, so skimage's XYZ Y
// channel IS its linearised value. That isolates the transfer function from
// the matrix entirely.
const ramp = new Float64Array(256 * 3);
for (let i = 0; i < 256; i++) { ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = i / 255; }
const skY = runPython(`
from skimage import color as C
OUT = C.rgb2xyz(IN.reshape(-1, 1, 3)).reshape(-1, 3)[:, 1]
`, ramp, [256, 3]);
const mineY = new Float64Array(256);
for (let i = 0; i < 256; i++) mineY[i] = srgbToLinear(i / 255) * (SK_M[1][0] + SK_M[1][1] + SK_M[1][2]);
const wY = worst(mineY, skY);
ok(wY.w < 1e-12, `the sRGB transfer function matches skimage's (worst ${wY.w.toExponential(2)} on a grey ramp)`);

done(`colour spaces exact internally and against scikit-image (Lab ${wLab.w.toExponential(1)}, dE2000 ${wDE.w.toExponential(1)}, HSV ${wHsv.w.toExponential(1)}, HSL ${wHls.w.toExponential(1)})`);
