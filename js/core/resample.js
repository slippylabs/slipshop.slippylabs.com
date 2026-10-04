// Resampling: Image Size, Free Transform, and anything else that reads a
// pixel grid at coordinates that are not integers.
//
// Two conventions decide whether this is right or subtly wrong everywhere,
// and both are the kind of mistake that survives review because the result
// still looks like the picture:
//
// 1. PIXEL CENTRES ARE AT +0.5. Destination pixel i covers [i, i+1) and its
//    centre is i + 0.5, so the source coordinate is
//        (i + 0.5) * (srcSize / dstSize) - 0.5
//    Dropping the halves shifts the whole image by half a destination pixel
//    per axis -- invisible on a photograph, and a steadily accumulating drift
//    on anything resized repeatedly, plus a visible one-sided edge on a
//    nearest-neighbour upscale of pixel art.
//
// 2. THE FILTER MUST BE SCALED WHEN DOWNSCALING. A 3-tap Lanczos window that
//    stays 3 source pixels wide while the image shrinks by 4 skips 3 pixels
//    out of every 4: that is aliasing, and it looks like noise rather than
//    like a missing low-pass. The support is widened by the scale factor and
//    the kernel evaluated in DESTINATION space, which is what every correct
//    resizer does and what Pillow does.
//
// Everything premultiplies first, for the same reason the blurs do.

import { clamp, clamp01, round } from './util.js';
import { premultiply, unpremultiply } from './convolve.js';

export const FILTERS = ['nearest', 'bilinear', 'bicubic', 'mitchell', 'lanczos3'];

/** Catmull-Rom (a = -0.5), which is Pillow's BICUBIC and ImageMagick's Catrom. */
function cubicCatrom(x) {
  const a = -0.5;
  const t = Math.abs(x);
  if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
  if (t < 2) return ((a * t - 5 * a) * t + 8 * a) * t - 4 * a;
  return 0;
}

/** Mitchell-Netravali (B = C = 1/3): softer, less ringing than Catmull-Rom. */
function mitchell(x) {
  const B = 1 / 3, C = 1 / 3;
  const t = Math.abs(x);
  const t2 = t * t, t3 = t2 * t;
  if (t < 1) {
    return ((12 - 9 * B - 6 * C) * t3 + (-18 + 12 * B + 6 * C) * t2 + (6 - 2 * B)) / 6;
  }
  if (t < 2) {
    return ((-B - 6 * C) * t3 + (6 * B + 30 * C) * t2 + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6;
  }
  return 0;
}

function sinc(x) {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

function lanczos3(x) {
  const t = Math.abs(x);
  if (t >= 3) return 0;
  return sinc(t) * sinc(t / 3);
}

const KERNEL = {
  nearest: { fn: (x) => (x >= -0.5 && x < 0.5 ? 1 : 0), support: 0.5 },
  bilinear: { fn: (x) => Math.max(0, 1 - Math.abs(x)), support: 1 },
  bicubic: { fn: cubicCatrom, support: 2 },
  mitchell: { fn: mitchell, support: 2 },
  lanczos3: { fn: lanczos3, support: 3 },
};

/**
 * Precompute the taps for one axis: for each destination index, the first
 * source index and the weights. This is the whole cost of a separable resize,
 * and it is O(dst * taps) rather than O(dst * src).
 */
export function buildTaps(srcSize, dstSize, filter = 'bicubic') {
  const k = KERNEL[filter];
  if (!k) throw new Error(`unknown filter: ${filter}`);
  const scale = srcSize / dstSize;
  // Widen the window when shrinking; never narrow it when enlarging.
  const fscale = Math.max(1, scale);
  const support = k.support * fscale;
  // +1 because the closed interval [c - support, c + support] can contain
  // floor(2*support) + 1 integers when the centre lands on one.
  const taps = Math.max(1, Math.ceil(support * 2) + 1);
  const starts = new Int32Array(dstSize);
  const counts = new Int32Array(dstSize);
  const weights = new Float32Array(dstSize * taps);

  for (let i = 0; i < dstSize; i++) {
    const centre = (i + 0.5) * scale - 0.5;
    let lo = Math.ceil(centre - support);
    let hi = Math.floor(centre + support);
    // nearest needs exactly one tap, and at a half-integer centre the ceil/
    // floor pair can give two or zero. Pin it.
    // Nearest is handled by index, never through the kernel. The kernel's
    // window is half-open, [-0.5, 0.5), and Math.round sends a tie UP -- so at
    // a centre of exactly 19.5 it picked source 20, asked the kernel for
    // k(+0.5), got 0, and that one destination pixel came out black. 40 -> 41
    // hits it exactly once, in the middle of the image.
    if (filter === 'nearest') {
      // (i + 0.5) * scale computed DIRECTLY, not as centre + 0.5.
      //
      // A destination centre can land exactly on a source pixel boundary, and
      // then both neighbours are equidistant. Which one gets picked is decided
      // by the last bit of the multiply: 19.5 * (40/39) comes out a hair below
      // 20 and 20.5 * (40/41) a hair above it, so 40 -> 39 breaks its tie down
      // and 40 -> 41 breaks it up. Pillow does the same multiply in a C double
      // and truncates, so writing the same expression here reproduces it
      // exactly -- whereas going through `centre` (subtract 0.5, add it back)
      // perturbs that last bit and shifts one pixel in the middle of the
      // image. Rounding this to taste would be the wrong fix.
      lo = hi = clamp(Math.floor((i + 0.5) * scale), 0, srcSize - 1);
      starts[i] = lo;
      counts[i] = 1;
      weights[i * taps] = 1;
      continue;
    }
    // THE WINDOW IS CLIPPED TO THE IMAGE AND THE REMAINING WEIGHTS
    // RENORMALISED -- the taps that fall outside are dropped, not folded onto
    // the edge pixel by clamping the index.
    //
    // The two differ only at the border, and only for a kernel with negative
    // lobes: clamping sums Lanczos's negative tails onto the edge pixel and
    // darkens or brightens a one-pixel border. Pillow, ImageMagick and
    // everything else clip-and-renormalise, and adopting it took the Lanczos
    // disagreement with Pillow from 0.26 to float noise. Bilinear agrees
    // either way, which is exactly why only Lanczos showed it.
    lo = Math.max(0, lo);
    hi = Math.min(srcSize - 1, hi);
    // The empty-window fix-up has to come AFTER the clip, not before it.
    // Nearest pins lo = hi = round(centre), and for the first destination
    // pixel of an upscale that can be -1: clipping lo up to 0 while hi stayed
    // at -1 left the window empty, the row summed to zero, and the first row
    // and column of every nearest resize came out black.
    if (hi < lo) hi = Math.min(srcSize - 1, Math.max(0, lo));
    if (hi < lo) { hi = lo = Math.max(0, Math.min(srcSize - 1, lo)); }
    let sum = 0;
    let n = 0;
    const base = i * taps;
    for (let s = lo; s <= hi && n < taps; s++) {
      const wv = k.fn((s - centre) / fscale);
      weights[base + n] = wv;
      sum += wv;
      n++;
    }
    if (sum !== 0) for (let t = 0; t < n; t++) weights[base + t] /= sum;
    starts[i] = lo;
    counts[i] = n;
  }
  return { starts, counts, weights, taps };
}

/**
 * Resize an RGBA Float32 buffer. Separable: horizontal then vertical.
 * Source coordinates outside the image are CLAMPED, so a downscale does not
 * darken its own border.
 */
export function resize(src, sw, sh, dw, dh, filter = 'bicubic') {
  if (sw === dw && sh === dh) return src.slice();
  if (dw < 1 || dh < 1) return new Float32Array(0);
  const work = src.slice();
  premultiply(work);

  const hx = buildTaps(sw, dw, filter);
  const mid = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srow = y * sw;
    const drow = y * dw;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const base = x * hx.taps;
      for (let t = 0; t < hx.counts[x]; t++) {
        const sx = clamp(hx.starts[x] + t, 0, sw - 1);
        const wv = hx.weights[base + t];
        const p = (srow + sx) * 4;
        r += work[p] * wv; g += work[p + 1] * wv; b += work[p + 2] * wv; a += work[p + 3] * wv;
      }
      const d = (drow + x) * 4;
      mid[d] = r; mid[d + 1] = g; mid[d + 2] = b; mid[d + 3] = a;
    }
  }

  const vy = buildTaps(sh, dh, filter);
  const out = new Float32Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const base = y * vy.taps;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < vy.counts[y]; t++) {
        const sy = clamp(vy.starts[y] + t, 0, sh - 1);
        const wv = vy.weights[base + t];
        const p = (sy * dw + x) * 4;
        r += mid[p] * wv; g += mid[p + 1] * wv; b += mid[p + 2] * wv; a += mid[p + 3] * wv;
      }
      const d = (y * dw + x) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  // Clamp before un-premultiplying: Lanczos and Catmull-Rom RING, so a hard
  // edge produces values slightly below 0 and above the alpha. Dividing a
  // negative colour by a ringing alpha is how a sharpened edge grows a
  // fluorescent fringe.
  for (let i = 0; i < out.length; i += 4) {
    const a = clamp01(out[i + 3]);
    out[i] = clamp(out[i], 0, a);
    out[i + 1] = clamp(out[i + 1], 0, a);
    out[i + 2] = clamp(out[i + 2], 0, a);
    out[i + 3] = a;
  }
  unpremultiply(out);
  return out;
}

// ------------------------------------------------------------- transforms

/** 3x3 affine helpers, row-major [a,b,tx, c,d,ty, 0,0,1] as a flat 6. */
export const mat = {
  identity: () => [1, 0, 0, 0, 1, 0],
  translate: (tx, ty) => [1, 0, tx, 0, 1, ty],
  scale: (sx, sy) => [sx, 0, 0, 0, sy, 0],
  rotate: (deg) => {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return [c, -s, 0, s, c, 0];
  },
  skew: (ax, ay) => [1, Math.tan((ax * Math.PI) / 180), 0, Math.tan((ay * Math.PI) / 180), 1, 0],
  mul: (m, n) => [
    m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5],
  ],
  apply: (m, x, y) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]],
  invert: (m) => {
    const det = m[0] * m[4] - m[1] * m[3];
    if (Math.abs(det) < 1e-12) return null;
    const i = 1 / det;
    const a = m[4] * i, b = -m[1] * i, c = -m[3] * i, d = m[0] * i;
    return [a, b, -(a * m[2] + b * m[5]), c, d, -(c * m[2] + d * m[5])];
  },
  /** Around a pivot, which is what a transform handle actually does. */
  about: (m, px, py) => mat.mul(mat.mul(mat.translate(px, py), m), mat.translate(-px, -py)),
};

/**
 * Sample an RGBA buffer at a real coordinate. Pixel centres at +0.5, so
 * sampleAt(buf, w, h, 0.5, 0.5) is exactly pixel (0,0).
 */
export function sampleAt(src, sw, sh, x, y, filter = 'bilinear', out = [0, 0, 0, 0]) {
  const k = KERNEL[filter] || KERNEL.bilinear;
  const cx = x - 0.5, cy = y - 0.5;
  if (filter === 'nearest') {
    const sx = clamp(Math.round(cx), 0, sw - 1);
    const sy = clamp(Math.round(cy), 0, sh - 1);
    const p = (sy * sw + sx) * 4;
    out[0] = src[p]; out[1] = src[p + 1]; out[2] = src[p + 2]; out[3] = src[p + 3];
    return out;
  }
  const sup = k.support;
  const x0 = Math.ceil(cx - sup), x1 = Math.floor(cx + sup);
  const y0 = Math.ceil(cy - sup), y1 = Math.floor(cy + sup);
  let r = 0, g = 0, b = 0, a = 0, wsum = 0;
  for (let sy = y0; sy <= y1; sy++) {
    const wy = k.fn(sy - cy);
    if (wy === 0) continue;
    const cyy = clamp(sy, 0, sh - 1);
    for (let sx = x0; sx <= x1; sx++) {
      const wv = k.fn(sx - cx) * wy;
      if (wv === 0) continue;
      const cxx = clamp(sx, 0, sw - 1);
      const p = (cyy * sw + cxx) * 4;
      r += src[p] * wv; g += src[p + 1] * wv; b += src[p + 2] * wv; a += src[p + 3] * wv;
      wsum += wv;
    }
  }
  if (wsum !== 0) { const n = 1 / wsum; r *= n; g *= n; b *= n; a *= n; }
  out[0] = r; out[1] = g; out[2] = b; out[3] = a;
  return out;
}

/**
 * Apply an affine transform by INVERSE mapping: for each destination pixel,
 * find where it came from. Forward mapping leaves holes.
 */
export function transform(src, sw, sh, m, dw, dh, filter = 'bicubic') {
  const inv = mat.invert(m);
  const out = new Float32Array(dw * dh * 4);
  if (!inv) return out;                       // a degenerate matrix maps to nothing
  const work = src.slice();
  premultiply(work);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [sx, sy] = mat.apply(inv, x + 0.5, y + 0.5);
      const d = (y * dw + x) * 4;
      // Outside the source is transparent, not clamped: a rotated layer must
      // not smear its edge pixel across the corners it does not cover.
      if (sx < 0 || sy < 0 || sx > sw || sy > sh) continue;
      sampleAt(work, sw, sh, sx, sy, filter, px);
      const a = clamp01(px[3]);
      out[d] = clamp(px[0], 0, a);
      out[d + 1] = clamp(px[1], 0, a);
      out[d + 2] = clamp(px[2], 0, a);
      out[d + 3] = a;
    }
  }
  unpremultiply(out);
  return out;
}

/** The bounding box of a transformed rect, which is what a free transform
 *  needs to know before it allocates anything. */
export function transformedBounds(m, w, h) {
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => mat.apply(m, x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Snap a corner that is within a millionth of an integer before rounding
  // outwards. Math.cos(PI/2) is 6.1e-17, not 0, so a 90-degree rotation puts
  // a corner at -1.2e-15 and floor/ceil then grow the box by a pixel on each
  // axis -- a "rotate 90 twice" that is 2px bigger than it started.
  const snap = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
  const x0 = Math.floor(snap(Math.min(...xs))), y0 = Math.floor(snap(Math.min(...ys)));
  const x1 = Math.ceil(snap(Math.max(...xs))), y1 = Math.ceil(snap(Math.max(...ys)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Flip and 90-degree rotation as an exact index permutation.
 *
 * Use this, never transform(), for the right-angle cases. transform() has to
 * premultiply in order to resample, and on a layer with partial alpha the
 * premultiply/un-premultiply round trip moves low-alpha pixels by a few ULPs
 * -- so a 90-degree rotate through transform() is very nearly lossless and
 * this is exactly lossless. Four rotations here return the original bit for
 * bit; through transform() they do not. (Math.cos(PI/2) is 6.1e-17, not 0,
 * so transform() is not even exactly a right angle.)
 */
export function orient(src, w, h, op) {
  const out = new Float32Array(src.length);
  const put = (dx, dy, sp) => {
    const dp = (dy * (op === 'rot90' || op === 'rot270' ? h : w) + dx) * 4;
    out[dp] = src[sp]; out[dp + 1] = src[sp + 1]; out[dp + 2] = src[sp + 2]; out[dp + 3] = src[sp + 3];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sp = (y * w + x) * 4;
      switch (op) {
        case 'flipH': put(w - 1 - x, y, sp); break;
        case 'flipV': put(x, h - 1 - y, sp); break;
        case 'rot180': put(w - 1 - x, h - 1 - y, sp); break;
        case 'rot90': put(h - 1 - y, x, sp); break;
        case 'rot270': put(y, w - 1 - x, sp); break;
        default: put(x, y, sp);
      }
    }
  }
  const swapped = op === 'rot90' || op === 'rot270';
  return { data: out, w: swapped ? h : w, h: swapped ? w : h };
}
