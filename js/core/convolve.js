// Convolution and the blurs built on it.
//
// Everything here works on a dense Float32 RGBA buffer and a border mode, and
// nothing knows about tiles. That separation is the point: a tiled filter is
// this code called on a rect that has been GROWN by the kernel radius, and the
// growth is the caller's job. Mixing the two is how a filter grows a seam
// every 256 pixels.
//
// Alpha is handled as the thing it is. Blurring straight (non-premultiplied)
// colour pulls the colour of transparent pixels into visible ones -- that is
// the black or white halo around a blurred cut-out, and it is the single most
// common bug in a hand-written image filter. So every spatial filter here
// PREMULTIPLIES, filters, and un-premultiplies.

import { clamp, clamp01, reflect, wrap } from './util.js';

// 'clamp'   repeat the edge pixel            (scipy 'nearest')
// 'reflect' mirror WITHOUT repeating the edge (scipy 'mirror')
// 'wrap'    tile                              (scipy 'grid-wrap')
// 'zero'    everything outside is 0           (scipy 'constant', cval=0)
//
// 'zero' is a TRUE zero: the missing taps contribute nothing and the result is
// not renormalised. An earlier version divided by the weight that landed
// inside, which is a defensible "ignore what is missing" rule and is what
// nobody else means by zero -- it made the border of a blurred mask stay
// opaque instead of fading, and it could not be compared against scipy.
export const BORDER_MODES = ['clamp', 'reflect', 'wrap', 'zero'];

/** Index mapper for a border mode. */
export function borderMap(mode) {
  switch (mode) {
    case 'reflect': return reflect;
    case 'wrap': return wrap;
    case 'zero': return (i, n) => (i < 0 || i >= n ? -1 : i);   // -1 means "no sample"
    case 'clamp':
    default: return (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);
  }
}

/** RGBA straight -> premultiplied, in place. */
export function premultiply(buf) {
  for (let p = 0; p < buf.length; p += 4) {
    const a = buf[p + 3];
    buf[p] *= a; buf[p + 1] *= a; buf[p + 2] *= a;
  }
  return buf;
}

/** RGBA premultiplied -> straight, in place. Fully transparent pixels have no
 *  colour to recover, so they are left at zero rather than divided by zero. */
export function unpremultiply(buf) {
  for (let p = 0; p < buf.length; p += 4) {
    const a = buf[p + 3];
    if (a > 0) { buf[p] /= a; buf[p + 1] /= a; buf[p + 2] /= a; }
    else { buf[p] = buf[p + 1] = buf[p + 2] = 0; }
  }
  return buf;
}

/** The kernel radius for a sigma. Exported because an oracle has to pin
 *  scipy to the SAME radius: scipy derives its own from `truncate`, and for
 *  sigma 0.7 that gives 2 where this gives 3, so an unpinned comparison
 *  measures the window, not the kernel. */
export const gaussianRadius = (sigma) => Math.max(1, Math.ceil(Math.max(1e-4, sigma) * 3));

/**
 * A normalised 1-D Gaussian. The radius is ceil(3*sigma), which captures
 * 99.7% of the kernel; truncating at 2 sigma leaves a visible step in a
 * gradient, and going past 4 costs time for nothing.
 */
export function gaussianKernel(sigma) {
  const s = Math.max(1e-4, sigma);
  const r = gaussianRadius(sigma);
  const k = new Float32Array(r * 2 + 1);
  const d = -0.5 / (s * s);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(i * i * d);
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, r };
}

/**
 * Separable convolution of an RGBA buffer with a 1-D kernel, horizontally
 * then vertically. In place via a scratch buffer.
 *
 * `alpha` false leaves the alpha channel untouched, which is what an
 * adjustment wants; true filters it too, which is what a blur wants.
 */
export function separable(buf, w, h, kernel, r, mode = 'clamp', alpha = true) {
  const map = borderMap(mode);
  const tmp = new Float32Array(buf.length);
  const ch = alpha ? 4 : 3;
  // --- horizontal ---
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let i = -r; i <= r; i++) {
        const sx = map(x + i, w);
        if (sx < 0) continue;                 // 'zero' outside
        const kv = kernel[i + r];
        const p = (row + sx) * 4;
        r0 += buf[p] * kv; g0 += buf[p + 1] * kv; b0 += buf[p + 2] * kv;
        if (alpha) a0 += buf[p + 3] * kv;
      }
      const d = (row + x) * 4;
      tmp[d] = r0; tmp[d + 1] = g0; tmp[d + 2] = b0;
      tmp[d + 3] = alpha ? a0 : buf[d + 3];
    }
  }
  // --- vertical ---
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let i = -r; i <= r; i++) {
        const sy = map(y + i, h);
        if (sy < 0) continue;
        const kv = kernel[i + r];
        const p = (sy * w + x) * 4;
        r0 += tmp[p] * kv; g0 += tmp[p + 1] * kv; b0 += tmp[p + 2] * kv;
        if (alpha) a0 += tmp[p + 3] * kv;
      }
      const d = (y * w + x) * 4;
      buf[d] = r0; buf[d + 1] = g0; buf[d + 2] = b0;
      if (alpha) buf[d + 3] = a0;
    }
  }
  return buf;
}

/** Gaussian blur. Premultiplies so a blurred cut-out does not halo. */
export function gaussianBlur(buf, w, h, sigma, mode = 'clamp') {
  if (sigma <= 0) return buf;
  const { k, r } = gaussianKernel(sigma);
  premultiply(buf);
  separable(buf, w, h, k, r, mode, true);
  unpremultiply(buf);
  return buf;
}

/** Box blur of radius r, as a true mean (not a gaussian approximation). */
export function boxBlur(buf, w, h, r, mode = 'clamp') {
  if (r <= 0) return buf;
  const n = r * 2 + 1;
  const k = new Float32Array(n).fill(1 / n);
  premultiply(buf);
  separable(buf, w, h, k, r, mode, true);
  unpremultiply(buf);
  return buf;
}

/**
 * Full 2-D convolution with an arbitrary kernel -- the "Custom" filter, and
 * what emboss, edge detection and sharpen kernels run through.
 *
 * `divisor` and `bias` are the classic Photoshop Custom controls: the result
 * is sum/divisor + bias. A divisor of 0 means "use the kernel sum, or 1 if it
 * sums to zero", which is what an edge-detect kernel needs.
 */
export function convolve(buf, w, h, kernel, kw, kh, opts = {}) {
  const mode = opts.mode || 'clamp';
  const alpha = opts.alpha !== false;
  const preserveAlpha = opts.preserveAlpha !== false;
  let divisor = opts.divisor;
  if (divisor === undefined || divisor === 0) {
    let s = 0;
    for (let i = 0; i < kernel.length; i++) s += kernel[i];
    divisor = s === 0 ? 1 : s;
  }
  const bias = opts.bias || 0;
  const map = borderMap(mode);
  const rx = (kw - 1) >> 1;
  const ry = (kh - 1) >> 1;
  const src = buf.slice();
  if (alpha) premultiply(src);
  const inv = 1 / divisor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let ky = 0; ky < kh; ky++) {
        const sy = map(y + ky - ry, h);
        if (sy < 0) continue;
        for (let kx = 0; kx < kw; kx++) {
          const sx = map(x + kx - rx, w);
          if (sx < 0) continue;
          const kv = kernel[ky * kw + kx];
          if (kv === 0) continue;
          const p = (sy * w + sx) * 4;
          r0 += src[p] * kv; g0 += src[p + 1] * kv; b0 += src[p + 2] * kv;
          a0 += src[p + 3] * kv;
        }
      }
      const d = (y * w + x) * 4;
      buf[d] = r0 * inv + bias;
      buf[d + 1] = g0 * inv + bias;
      buf[d + 2] = b0 * inv + bias;
      // A convolution of the ALPHA channel is almost never what is wanted --
      // an edge-detect kernel would make an opaque layer semi-transparent in
      // flat areas. Preserve it unless the caller says otherwise.
      buf[d + 3] = preserveAlpha ? src[d + 3] : a0 * inv + bias;
    }
  }
  if (alpha) unpremultiply(buf);
  return buf;
}

/** Unsharp mask: src + amount * (src - blur(src)), with a threshold below
 *  which nothing is sharpened (so film grain is not amplified). */
export function unsharpMask(buf, w, h, { radius = 2, amount = 1, threshold = 0, mode = 'clamp' } = {}) {
  if (amount === 0 || radius <= 0) return buf;
  const blurred = buf.slice();
  gaussianBlur(blurred, w, h, radius, mode);
  for (let p = 0; p < buf.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const d = buf[p + c] - blurred[p + c];
      if (Math.abs(d) >= threshold) buf[p + c] = buf[p + c] + amount * d;
    }
  }
  return buf;
}

/** High pass: what unsharp subtracts, centred on 0.5. */
export function highPass(buf, w, h, radius = 3, mode = 'clamp') {
  const blurred = buf.slice();
  gaussianBlur(blurred, w, h, radius, mode);
  for (let p = 0; p < buf.length; p += 4) {
    for (let c = 0; c < 3; c++) buf[p + c] = buf[p + c] - blurred[p + c] + 0.5;
  }
  return buf;
}

/**
 * A rank filter over a square window: median, minimum (Photoshop's "Minimum",
 * an erosion) or maximum (a dilation). Rank 0.5 is the median.
 *
 * Done per channel on STRAIGHT colour deliberately: a median is an
 * order-statistic, and premultiplying would mix alpha into the ordering and
 * pick a different pixel.
 */
export function rankFilter(buf, w, h, radius, rank = 0.5, mode = 'clamp') {
  if (radius <= 0) return buf;
  const map = borderMap(mode);
  const src = buf.slice();
  const n = (radius * 2 + 1) * (radius * 2 + 1);
  const win = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let m = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const sy = map(y + dy, h);
          if (sy < 0) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = map(x + dx, w);
            if (sx < 0) continue;
            win[m++] = src[(sy * w + sx) * 4 + c];
          }
        }
        const sub = win.subarray(0, m);
        sub.sort();
        const idx = clamp(Math.round(rank * (m - 1)), 0, m - 1);
        buf[(y * w + x) * 4 + c] = sub[idx];
      }
    }
  }
  return buf;
}

/** Motion blur: a line kernel at an angle, length in pixels. */
export function motionBlur(buf, w, h, { length = 10, angle = 0, mode = 'clamp' } = {}) {
  if (length <= 1) return buf;
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = -Math.sin(rad);
  const n = Math.max(2, Math.round(length));
  const half = (n - 1) / 2;
  const map = borderMap(mode);
  const src = buf.slice();
  premultiply(src);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        const t = i - half;
        const sx = map(Math.round(x + dx * t), w);
        const sy = map(Math.round(y + dy * t), h);
        if (sx < 0 || sy < 0) continue;
        const p = (sy * w + sx) * 4;
        r0 += src[p]; g0 += src[p + 1]; b0 += src[p + 2]; a0 += src[p + 3];
        cnt++;
      }
      const d = (y * w + x) * 4;
      if (cnt === 0) continue;
      buf[d] = r0 / cnt; buf[d + 1] = g0 / cnt; buf[d + 2] = b0 / cnt; buf[d + 3] = a0 / cnt;
    }
  }
  unpremultiply(buf);
  return buf;
}

/** Named kernels for the Custom filter and the Stylize set. */
export const KERNELS = {
  identity: { w: 3, h: 3, k: [0, 0, 0, 0, 1, 0, 0, 0, 0] },
  sharpen: { w: 3, h: 3, k: [0, -1, 0, -1, 5, -1, 0, -1, 0] },
  sharpenMore: { w: 3, h: 3, k: [-1, -1, -1, -1, 9, -1, -1, -1, -1] },
  blur3: { w: 3, h: 3, k: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
  edgeDetect: { w: 3, h: 3, k: [0, 1, 0, 1, -4, 1, 0, 1, 0] },
  findEdges: { w: 3, h: 3, k: [-1, -1, -1, -1, 8, -1, -1, -1, -1] },
  emboss: { w: 3, h: 3, k: [-2, -1, 0, -1, 1, 1, 0, 1, 2] },
  sobelX: { w: 3, h: 3, k: [-1, 0, 1, -2, 0, 2, -1, 0, 1] },
  sobelY: { w: 3, h: 3, k: [-1, -2, -1, 0, 0, 0, 1, 2, 1] },
};
