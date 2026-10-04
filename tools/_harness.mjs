// The shared assert surface for every oracle in this directory, deliberately
// the same shape as SlipStudio's tools/_harness.mjs so the two read alike:
// each oracle prints one summary line and exits non-zero on any failure.

let ran = 0;
let failed = 0;
const fails = [];

export function ok(cond, msg) {
  ran++;
  if (!cond) { failed++; if (fails.length < 30) fails.push(msg); }
  return !!cond;
}

export function eq(a, b, msg, tol = 0) {
  const good = tol === 0 ? a === b : Math.abs(a - b) <= tol;
  ran++;
  if (!good) { failed++; if (fails.length < 30) fails.push(`${msg}: got ${a}, want ${b}${tol ? ` (+-${tol})` : ''}`); }
  return good;
}

/** Worst absolute difference between two numeric arrays, with a name so a
 *  failure says which pair diverged rather than just "arrays differ". */
export function worst(a, b) {
  let w = 0, at = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > w) { w = d; at = i; }
  }
  return { w, at, len: n };
}

export function note(msg) { console.log(`    ${msg}`); }

export function done(summary) {
  if (failed) {
    console.log(`FAILED ${failed} of ${ran}`);
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`${ran} checks, ${summary}`);
}

/** A deterministic colour set for pixel-level oracles: the eight cube corners,
 *  a grey ramp through every value a blend mode special-cases, and a seeded
 *  spread. Byte values, so nothing is lost on the way into a canvas. */
export function colorSet() {
  const out = [];
  for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) out.push([r, g, b]);
  for (const v of [0, 1, 63, 64, 127, 128, 191, 192, 254, 255]) out.push([v, v, v]);
  let a = 0x9e3779b9 >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  while (out.length < 112) {
    out.push([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
  }
  return out;
}

// ---------------------------------------------------------------- float16
// Node 20 has no Float16Array, and the browser oracles blend on a float16
// canvas. Comparing float64 maths against float16 results without rounding
// the INPUTS to float16 first measures the conversion, not the formula.

/** Round to the nearest IEEE half, ties to even. Handles subnormals, which
 *  matter here because an 8-bit colour of 1/255 is 0.0039 -- well inside the
 *  normal range, but an alpha-weighted product of two such values is not. */
export function f16round(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a >= 65520) return sign * Infinity;        // rounds up to inf
  const e = Math.max(Math.floor(Math.log2(a)), -14);
  const q = Math.pow(2, e - 10);                 // the ULP in that binade
  const d = a / q;
  let r = Math.floor(d);
  const frac = d - r;
  if (frac > 0.5 || (frac === 0.5 && (r & 1) === 1)) r++;
  return sign * r * q;
}

/** The float16 ULP at x, i.e. the spacing of representable values there. */
export function f16ulp(x) {
  const a = Math.abs(x);
  if (a === 0) return Math.pow(2, -24);
  const e = Math.max(Math.floor(Math.log2(a)), -14);
  return Math.pow(2, e - 10);
}

/** The float16 values either side of x, for a sensitivity sweep. */
export function f16neighbours(x) {
  const u = f16ulp(x);
  return [f16round(x - u), f16round(x), f16round(x + u)];
}
