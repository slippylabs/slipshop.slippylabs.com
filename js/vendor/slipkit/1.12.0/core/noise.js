// Noise, ported VERBATIM from noise-lab.slippylabs.com (the live page, sliced
// between "function mulberry32" and "Rendering a whole field"). Do not edit by
// hand: tools/noise.mjs slices the live page again and requires bit-identical
// output, so a drift in either copy fails the suite. Re-port with the snippet
// in that oracle's header.
//
// perlin2 / value2 / simplex2 / worley2, fractal (fbm | ridged | turbulence),
// domain warp, and exact tiling via `period`.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Perlin's table doubled, so a lookup at i + 1 never needs a bounds test. */
export function buildPermutation(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/* Eight unit gradients. Unit length matters: the classic bound on 2D gradient
   noise, |n| <= sqrt(2)/2, only holds for unit gradients, and it is what the
   normalisation below relies on. */
const GRAD2 = (() => {
  const g = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI * 2) / 8;
    g.push([Math.cos(a), Math.sin(a)]);
  }
  return g;
})();

const PERLIN_SCALE = Math.SQRT2;   /* sqrt(2)/2 -> 1 */

export function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
export function lerp(a, b, t) { return a + (b - a) * t; }

/* Wrap a lattice coordinate into [0, period) when tiling, leave it alone when
   not. Negative coordinates have to land in range too, so this is a real modulo
   and not a remainder. */
export function wrap(i, period) {
  if (!period) return i;
  const m = i % period;
  return m < 0 ? m + period : m;
}

export function perlin2(x, y, perm, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = wrap(xi, period) & 255;
  const y0 = wrap(yi, period) & 255;
  const x1 = wrap(xi + 1, period) & 255;
  const y1 = wrap(yi + 1, period) & 255;

  const g00 = GRAD2[perm[x0 + perm[y0]] & 7];
  const g10 = GRAD2[perm[x1 + perm[y0]] & 7];
  const g01 = GRAD2[perm[x0 + perm[y1]] & 7];
  const g11 = GRAD2[perm[x1 + perm[y1]] & 7];

  /* The dot products use the TRUE offsets, not the wrapped ones -- wrapping the
     offset as well would fold the surface and put a crease at the seam. */
  const n00 = g00[0] * xf + g00[1] * yf;
  const n10 = g10[0] * (xf - 1) + g10[1] * yf;
  const n01 = g01[0] * xf + g01[1] * (yf - 1);
  const n11 = g11[0] * (xf - 1) + g11[1] * (yf - 1);

  const u = fade(xf);
  const v = fade(yf);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * PERLIN_SCALE;
}

export function value2(x, y, perm, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = wrap(xi, period) & 255;
  const y0 = wrap(yi, period) & 255;
  const x1 = wrap(xi + 1, period) & 255;
  const y1 = wrap(yi + 1, period) & 255;
  const at = (a, b) => (perm[a + perm[b]] / 255) * 2 - 1;
  const u = fade(xf);
  const v = fade(yf);
  return lerp(lerp(at(x0, y0), at(x1, y0), u), lerp(at(x0, y1), at(x1, y1), u), v);
}

/* 2D simplex. The skew constants are the standard ones; the 0.5 - r^2 kernel is
   raised to the fourth power and the whole thing scaled by 70 to land in about
   [-1, 1]. Simplex has no periodic form here -- the lattice is triangular and
   does not wrap onto a square -- which the UI says out loud rather than
   quietly producing a seam. */
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export function simplex2(x, y, perm) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  const corner = (dx, dy, gi) => {
    let tt = 0.5 - dx * dx - dy * dy;
    if (tt < 0) return 0;
    tt *= tt;
    const g = GRAD2[gi & 7];
    return tt * tt * (g[0] * dx + g[1] * dy);
  };
  n += corner(x0, y0, perm[ii + perm[jj]]);
  n += corner(x1, y1, perm[ii + i1 + perm[jj + j1]]);
  n += corner(x2, y2, perm[ii + 1 + perm[jj + 1]]);
  return 70 * n;
}

/* Worley: one jittered feature point per cell, distance to the nearest (F1) and
   second nearest (F2). Three cells each way is enough for a jitter inside the
   cell -- a point in a further ring cannot beat one in the 3x3 block. */
export function worley2(x, y, perm, period, wantF2) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  /* Distances are measured in the query cell's own frame -- offsets of -1..2
     rather than absolute world coordinates. Same geometry, but every operand is
     small and identical on both sides of a wrap, so a tiled field's opposite
     edges come out bit-for-bit equal instead of a few ULPs apart. Measured at
     x = 4096 the absolute form was already losing 2e-15 to rounding. */
  const fx = x - xi;
  const fy = y - yi;
  let f1 = Infinity;
  let f2 = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const wx = wrap(xi + dx, period) & 255;
      const wy = wrap(yi + dy, period) & 255;
      const h = perm[wx + perm[wy]];
      const h2 = perm[(wx + 37) & 255] ^ perm[(wy + 17) & 255];
      const px = dx + (h / 255) * 0.98 + 0.01;
      const py = dy + (h2 / 255) * 0.98 + 0.01;
      const d = Math.hypot(fx - px, fy - py);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  /* F1 is in [0, ~1.4]; map to [-1, 1] the same way the others sit. */
  return wantF2 ? Math.min(1, (f2 - f1)) * 2 - 1 : f1 * 2 - 1;
}

export function baseNoise(type, x, y, perm, period) {
  switch (type) {
    case 'value': return value2(x, y, perm, period);
    case 'simplex': return simplex2(x, y, perm);
    case 'worley-f1': return worley2(x, y, perm, period, false);
    case 'worley-f2f1': return worley2(x, y, perm, period, true);
    default: return perlin2(x, y, perm, period);
  }
}

/* Simplex cannot be made periodic on a square lattice, so asking for a tileable
   simplex field is a request the page has to refuse rather than fake. */
export function supportsTiling(type) { return type !== 'simplex'; }

/* ---- Fractal stacking -------------------------------------------------------
   Sum octaves of the same generator at doubling frequency and halving
   amplitude. The normalisation is the exact geometric sum of the amplitudes,
   which is what keeps the output in [-1, 1] whatever the gain -- dividing by
   the number of octaves (a common shortcut) leaves the field washed out at low
   gain and clipped at high gain. */
export function amplitudeSum(octaves, gain) {
  let sum = 0;
  let amp = 1;
  for (let i = 0; i < octaves; i++) { sum += amp; amp *= gain; }
  return sum;
}

export function fractal(type, mode, x, y, opts) {
  const { perm, octaves, lacunarity, gain, period } = opts;
  if (mode === 'none') return baseNoise(type, x, y, perm, period);
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    let n = baseNoise(type, x * freq, y * freq, perm, p);
    if (mode === 'ridged') n = 1 - 2 * Math.abs(n);
    else if (mode === 'turbulence') n = 2 * Math.abs(n) - 1;
    sum += n * amp;
    amp *= gain;
    freq *= lacunarity;
    /* The period has to scale with the frequency or the higher octaves stop
       tiling, which is the single easiest way to end up with a seam that only
       appears once the detail is turned up. Non-integer lacunarity cannot keep
       an integer period, so tiling is only offered for integer ones. */
    if (p) p = Math.round(p * lacunarity);
  }
  return sum / amplitudeSum(octaves, gain);
}

/* Domain warp: sample the field at a position that has itself been pushed
   around by two more noise fields. Cheap, and the difference between "clouds"
   and "marble". */
export function warpedFractal(type, mode, x, y, opts) {
  if (!opts.warp) return fractal(type, mode, x, y, opts);
  const qx = fractal(type, 'fbm', x + 5.2, y + 1.3, opts);
  const qy = fractal(type, 'fbm', x + 9.7, y + 4.1, opts);
  return fractal(type, mode, x + opts.warp * qx, y + opts.warp * qy, opts);
}
