// Colour spaces. Every function takes and returns plain numbers or small
// arrays; nothing here knows about pixels, tiles or canvases.
//
// Convention: rgb channels are 0..1 and SRGB-ENCODED unless a name says
// "linear". Hue is degrees, s/l/v are 0..1. Lab is the usual L 0..100,
// a/b roughly -128..127. OKLab's L is 0..1.
//
// Why two families: the editor blends and adjusts in encoded space by default
// (that is what Photoshop, CSS mix-blend-mode and the canvas do, and it is
// what makes the browser a valid oracle for the compositor), while anything
// physical -- a real blur, a resize, an alpha composite of photographic
// content -- is correct only in linear light. Mixing the two silently is how
// a near-black wall turns grey, so the space is always explicit in the name.

import { clamp, clamp01, round, wrapHue } from './util.js';

// ---------------------------------------------------------------- transfer

/** sRGB encoded -> linear. IEC 61966-2-1, including the linear toe. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear -> sRGB encoded. */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** A 256-entry byte->linear table. The decode is a pow per channel per pixel
 *  otherwise, and the input only has 256 possible values. */
export const BYTE_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

// ---------------------------------------------------------------- hex

export function parseHex(hex) {
  let s = String(hex).trim().replace(/^#/, '');
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const n = [];
  for (let i = 0; i < s.length; i += 2) n.push(parseInt(s.slice(i, i + 2), 16) / 255);
  if (n.length === 3) n.push(1);
  return n;                                 // [r,g,b,a] 0..1
}

export function toHex(rgb, withAlpha = false) {
  const h = (v) => round(clamp01(v) * 255).toString(16).padStart(2, '0');
  const base = '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  return withAlpha ? base + h(rgb.length > 3 ? rgb[3] : 1) : base;
}

// ---------------------------------------------------------------- HSL / HSV

export function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h, s, l) {
  h = wrapHue(h) / 360;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, mx === 0 ? 0 : d / mx, mx];
}

export function hsvToRgb(h, s, v) {
  h = wrapHue(h) / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// ---------------------------------------------------------------- CMYK
// Naive device CMYK, no profile. Honest about what it is: a convenience for
// picking and reading values back, not a print-ready separation.

export function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
}

export function cmykToRgb(c, m, y, k) {
  const d = 1 - k;
  return [(1 - c) * d, (1 - m) * d, (1 - y) * d];
}

// ---------------------------------------------------------------- XYZ / Lab
// sRGB primaries, D65. Matrices from Lindbloom; the Lab constants are the
// exact rationals (216/24389, 24389/27), not the rounded 0.008856 / 903.3,
// so the round trip closes to float precision.

// The white point MUST be this matrix's own white -- the row sums -- not the
// book value 0.95047/1/1.08883. The matrix is rounded to 7 places, so its Y
// row sums to 1.0000001, and using the book value made pure white come out at
// L* 100.000004 with a non-zero a*/b*. Deriving it here closes that exactly.
const M_RGB2XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
export const D65 = M_RGB2XYZ.map((row) => row[0] + row[1] + row[2]);
// The EXACT CIE rationals. The pair everyone copies instead -- 0.008856 for
// the branch and 7.787 * t + 16/116 for the toe -- is a rounding of these, and
// scikit-image still ships it. It costs about 1.6e-4 in Lab inside the toe,
// which is why both are parameters here: feeding skimage's approximations in
// makes that comparison exact instead of approximately close.
export const EPS = 216 / 24389;        // 0.008856451679...
export const KAPPA = 24389 / 27;       // 903.296296..., so KAPPA/116 = 7.787037...
export const SKIMAGE_EPS = 0.008856;
export const SKIMAGE_KAPPA = 7.787 * 116;

/** The matrix and white point are parameters so a test can substitute another
 *  library's constants. They are NOT interchangeable between libraries:
 *  scikit-image ships an older, more coarsely rounded sRGB matrix (its Z row
 *  is 0.950227 against this one's 0.9503041), so a direct diff against it
 *  shows 1e-4 differences that belong to its constants, not to this code.
 *  Passing its matrix in is what turns that into a decisive comparison. */
export function linearRgbToXyz(r, g, b, m = M_RGB2XYZ) {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

/** The inverse is COMPUTED from the forward matrix, not typed from the book.
 *  The published pair is each rounded to 7 places independently, so they are
 *  not exact inverses of one another and an RGB->XYZ->RGB round trip drifts
 *  1.7e-6 for no reason -- big enough to look like a bug when an oracle
 *  compares against a library that did invert properly. */
const M_XYZ2RGB = invert3(M_RGB2XYZ);

export { M_RGB2XYZ, M_XYZ2RGB };

export function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

export function xyzToLinearRgb(x, y, z, m = M_XYZ2RGB) {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

export function xyzToLab(x, y, z, white = D65, eps = EPS, kappa = KAPPA) {
  const f = (t) => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
  const fx = f(x / white[0]), fy = f(y / white[1]), fz = f(z / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToXyz(L, a, bb, white = D65) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (t) => {
    const t3 = t * t * t;
    return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
  };
  // Y has a closed form that avoids a needless cube/uncube at the toe.
  const y = L > KAPPA * EPS ? Math.pow((L + 16) / 116, 3) : L / KAPPA;
  return [inv(fx) * white[0], y * white[1], inv(fz) * white[2]];
}

/** Encoded sRGB -> Lab, the whole chain. */
export function rgbToLab(r, g, b, opts) {
  const o = opts || {};
  const xyz = linearRgbToXyz(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), o.matrix || M_RGB2XYZ);
  return xyzToLab(xyz[0], xyz[1], xyz[2], o.white || D65,
    o.eps === undefined ? EPS : o.eps, o.kappa === undefined ? KAPPA : o.kappa);
}

/** Lab -> encoded sRGB. Out-of-gamut values come back outside 0..1 rather
 *  than clipped, so a caller can decide whether to clip or map. */
export function labToRgb(L, a, b) {
  const xyz = labToXyz(L, a, b);
  const lin = xyzToLinearRgb(xyz[0], xyz[1], xyz[2]);
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
}

export function labToLch(L, a, b) {
  const C = Math.hypot(a, b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

export function lchToLab(L, C, h) {
  const r = h * Math.PI / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

// ---------------------------------------------------------------- OKLab
// Ottosson's matrices, from LINEAR sRGB.

// Ottosson publishes four matrices rounded to ten places, and the two pairs
// are NOT exact inverses of one another: using all four as printed leaves the
// round trip 1.7e-6 out and gives greys a 3.7e-8 tint. Only the two FORWARD
// matrices are kept here (they are the definition) and both inverses are
// computed, exactly as the XYZ inverse is. That makes the round trip exact.
//
// What cannot be fixed by inversion: M2's first row sums to 0.9999999935, not
// 1, so pure white lands at OKLab L = 0.9999999935. That is the precision of
// the published constants, not an error here, and the oracle asserts it stays
// inside 1e-7 rather than pretending it is zero.
const M_LIN2LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const M_LMS2OKLAB = [
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
];
const M_LMS2LIN = invert3(M_LIN2LMS);
const M_OKLAB2LMS = invert3(M_LMS2OKLAB);

const mul3 = (m, x, y, z) => [
  m[0][0] * x + m[0][1] * y + m[0][2] * z,
  m[1][0] * x + m[1][1] * y + m[1][2] * z,
  m[2][0] * x + m[2][1] * y + m[2][2] * z,
];

export function linearRgbToOklab(r, g, b) {
  const lms = mul3(M_LIN2LMS, r, g, b);
  return mul3(M_LMS2OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));
}

export function oklabToLinearRgb(L, a, b) {
  const p = mul3(M_OKLAB2LMS, L, a, b);
  return mul3(M_LMS2LIN, p[0] * p[0] * p[0], p[1] * p[1] * p[1], p[2] * p[2] * p[2]);
}

export function rgbToOklab(r, g, b) {
  return linearRgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

export function oklabToRgb(L, a, b) {
  const lin = oklabToLinearRgb(L, a, b);
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
}

export function oklabToOklch(L, a, b) {
  const C = Math.hypot(a, b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

export function oklchToOklab(L, C, h) {
  const r = h * Math.PI / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

// ---------------------------------------------------------------- difference

export function deltaE76(lab1, lab2) {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

/** CIEDE2000. Written out in full because every short version of this found
 *  in the wild gets the h-prime averaging wrong near the 0/360 wrap. */
export function deltaE2000(lab1, lab2, kL = 1, kC = 1, kH = 1) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));  // 25^7
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (ap, bp) => {
    if (ap === 0 && bp === 0) return 0;
    let h = Math.atan2(bp, ap) * 180 / Math.PI;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else dhp = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * Math.PI / 180);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;
  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos((2 * hbarp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * hbarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hbarp - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const dL2 = (Lbarp - 50) * (Lbarp - 50);
  const SL = 1 + (0.015 * dL2) / Math.sqrt(20 + dL2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin((2 * dTheta) * Math.PI / 180) * RC;
  const tL = dLp / (kL * SL), tC = dCp / (kC * SC), tH = dHp / (kH * SH);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

// ---------------------------------------------------------------- misc

/** Perceptual-ish greyscale mix used by Black & White and desaturate. */
export function desaturate(r, g, b, weights) {
  const w = weights || [0.2126, 0.7152, 0.0722];
  return w[0] * r + w[1] * g + w[2] * b;
}

export const clampRgb = (c) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
export const inGamut = (c, tol = 1e-6) =>
  c.every((v) => v >= -tol && v <= 1 + tol);
