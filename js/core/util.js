// Pure helpers shared by the whole engine. No DOM, no canvas: this file and
// everything beside it must run under node, because that is what makes the
// oracles in tools/ possible.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** JS rounding is half-UP; numpy's is half-to-even. Every quantise in the
 *  engine goes through here so an oracle can reproduce it with
 *  np.floor(x + 0.5) rather than np.round. */
export const round = (v) => Math.floor(v + 0.5);

/** 0..1 float -> 0..255 byte, saturating. */
export const toByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : round(v * 255));
/** 0..1 float -> 0..65535, saturating. */
export const toU16 = (v) => (v <= 0 ? 0 : v >= 1 ? 65535 : round(v * 65535));

/** Wrap an index into [0,n) for both signs (JS % keeps the sign). */
export const wrap = (i, n) => ((i % n) + n) % n;

/** Mirror an out-of-range index back inside [0,n-1] without repeating the
 *  edge sample, which is what "reflect" means for a convolution border. */
export function reflect(i, n) {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  let k = wrap(i, period);
  return k < n ? k : period - k;
}

/** Degrees, kept in [0,360). */
export const wrapHue = (h) => ((h % 360) + 360) % 360;

/** The shortest signed way from a to b around the hue circle. */
export function hueDelta(a, b) {
  let d = wrapHue(b) - wrapHue(a);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Rec.709 luma on NON-linear (encoded) channels, which is what every image
 *  tool on this estate means by "luminance" and what Photoshop's Luminosity
 *  blend uses. For physically correct luminance convert to linear first. */
export const luma709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Rec.601, the one the ASCII and dither tools use. */
export const luma601 = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Equality for float buffers, with the tolerance named at the call site.
 *  Float32Array storage means 8.1 reads back as 8.100000381, so a 1e-9
 *  tolerance is wrong for anything that has been through a float32. */
export function nearly(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

/** A deterministic 32-bit PRNG. Same generator as noise-lab's, so a seeded
 *  result here can be diffed against that page. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, drawing from a supplied uniform so noise stays seeded. */
export function gaussianPair(rnd) {
  let u = 0;
  while (u === 0) u = rnd();           // log(0) is -Infinity
  const r = Math.sqrt(-2 * Math.log(u));
  const th = TAU * rnd();
  return [r * Math.cos(th), r * Math.sin(th)];
}

/** An integer rect. Empty is width or height <= 0, and stays empty through
 *  every operation here rather than going negative. */
export const rect = (x, y, w, h) => ({ x, y, w, h });
export const rectEmpty = (r) => !r || r.w <= 0 || r.h <= 0;

export function rectIntersect(a, b) {
  if (rectEmpty(a) || rectEmpty(b)) return rect(0, 0, 0, 0);
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return rect(x, y, Math.max(0, x1 - x), Math.max(0, y1 - y));
}

export function rectUnion(a, b) {
  if (rectEmpty(a)) return rectEmpty(b) ? rect(0, 0, 0, 0) : rect(b.x, b.y, b.w, b.h);
  if (rectEmpty(b)) return rect(a.x, a.y, a.w, a.h);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return rect(x, y, x1 - x, y1 - y);
}

export const rectContains = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
export const rectEq = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Grow a rect by n on every side, then clip to a bound. A kernel of radius n
 *  reads n pixels outside the rect it writes, which is the whole reason the
 *  tiled and flat paths can disagree. */
export function rectGrow(r, n, bound) {
  const g = rect(r.x - n, r.y - n, r.w + 2 * n, r.h + 2 * n);
  return bound ? rectIntersect(g, bound) : g;
}
