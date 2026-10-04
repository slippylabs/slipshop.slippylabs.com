// Monotone cubic interpolation, for the Curves dialog and for anything else
// that maps a tone through hand-placed points.
//
// The requirement is not "smooth", it is MONOTONE. A natural cubic spline
// through four or five hand-placed points overshoots between them, and an
// overshoot in a tone curve means the output goes DOWN where the input went
// up -- a band of inverted tones in the middle of a photograph, from a curve
// that looks perfectly reasonable in the dialog. Fritsch and Carlson's
// construction limits the tangents so that can never happen, and the oracle
// asserts monotonicity directly rather than trusting the construction.

import { clamp, clamp01 } from './util.js';

/**
 * @param points [[x,y], ...] with x in 0..1, y in 0..1. Sorted and
 *               de-duplicated here, so the caller can hand over whatever the
 *               user dragged.
 * @returns a function x -> y, clamped to 0..1
 */
export function monotoneSpline(points) {
  const pts = dedupe(points);
  const n = pts.length;
  if (n === 0) return (x) => clamp01(x);
  if (n === 1) {
    // One point is an offset, not a curve: shift the identity through it.
    const [px, py] = pts[0];
    return (x) => clamp01(x + (py - px));
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);

  // secant slopes
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  // initial tangents: one-sided at the ends, averaged inside
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;

  // Fritsch-Carlson: where a secant is flat the tangents must be zero, and
  // elsewhere the tangents are confined to a circle of radius 3 around the
  // secant. Both conditions are what rule out an overshoot.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
    // A tangent of the opposite sign to its secant is an immediate overshoot.
    if (a < 0) m[i] = 0;
    if (b < 0) m[i + 1] = 0;
  }

  return function evaluate(x) {
    const t = clamp01(x);
    if (t <= xs[0]) return clamp01(ys[0] + m[0] * (t - xs[0]));
    if (t >= xs[n - 1]) return clamp01(ys[n - 1] + m[n - 1] * (t - xs[n - 1]));
    // binary search for the interval
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= t) lo = mid; else hi = mid;
    }
    const h = xs[lo + 1] - xs[lo];
    const s = (t - xs[lo]) / h;
    const s2 = s * s, s3 = s2 * s;
    // Hermite basis
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return clamp01(h00 * ys[lo] + h10 * h * m[lo] + h01 * ys[lo + 1] + h11 * h * m[lo + 1]);
  };
}

/** Sort by x and drop duplicates, keeping the last y for a repeated x -- a
 *  repeated x would divide by zero in the secant slope. */
function dedupe(points) {
  const out = [];
  const sorted = [...points].map((p) => [clamp01(p[0]), clamp01(p[1])]).sort((a, b) => a[0] - b[0]);
  for (const p of sorted) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// 16384, not 4096. Linear interpolation error scales with the square of the
// spacing, and on a STEEP curve (a hard S through close-together points) 4096
// samples left 1.4e-5 of error -- about one least-significant bit at 16 bits,
// so a 16-bit document would have been limited by the lookup table rather than
// by its storage. 16384 brings that to 8e-7, and the table is built once per
// adjustment rather than per pixel.
export const LUT_SIZE = 16384;

/**
 * Sample a 0..1 -> 0..1 function into a lookup table, turning a binary search
 * per pixel per channel into two array reads.
 */
export function buildLut(fn, size = LUT_SIZE) {
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) lut[i] = fn(i / (size - 1));
  return lut;
}

/** Sample a LUT with linear interpolation; values outside 0..1 are clamped. */
export function sampleLut(lut, x) {
  if (!(x > 0)) return lut[0];                 // also catches NaN
  if (x >= 1) return lut[lut.length - 1];
  const f = x * (lut.length - 1);
  const i = f | 0;
  const t = f - i;
  return lut[i] + (lut[i + 1] - lut[i]) * t;
}

/** The identity curve, as points. */
export const IDENTITY_CURVE = [[0, 0], [1, 1]];

/** Is this point list the identity? Lets a caller skip the work entirely. */
export function isIdentityCurve(points) {
  const p = dedupe(points);
  if (p.length !== 2) return false;
  return p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
}
