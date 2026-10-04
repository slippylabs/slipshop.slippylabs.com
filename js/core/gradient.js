// Gradient fills.
//
// Five shapes, all reduced to ONE scalar t per pixel and then a single stop
// lookup. That is the whole design: the shape decides t, the stops decide the
// colour, and nothing else needs to know which is which -- so adding a shape
// is one function and the Gradient Map adjustment shares the stop code.
//
// Dithering is on by default and matters more than it sounds. A smooth
// gradient across 2000 pixels crosses only 256 distinct 8-bit values, so it
// bands visibly; a sub-LSB ordered dither breaks the bands up and costs
// nothing. Photoshop has the same checkbox for the same reason.

import { clamp01, lerp, TAU, mulberry32 } from './util.js';
import { sampleStops } from './adjust.js';
import { magicWand } from './select.js';

export const GRADIENT_SHAPES = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

/** The 8x8 Bayer matrix, normalised to +/-0.5 of one output step. */
const BAYER8 = (() => {
  const m = [[0, 1], [3, 2]];
  let cur = m;
  for (let s = 2; s < 8; s *= 2) {
    const n = cur.length * 2;
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let y = 0; y < cur.length; y++) {
      for (let x = 0; x < cur.length; x++) {
        const v = cur[y][x] * 4;
        out[y][x] = v;
        out[y][x + cur.length] = v + 2;
        out[y + cur.length][x] = v + 3;
        out[y + cur.length][x + cur.length] = v + 1;
      }
    }
    cur = out;
  }
  const flat = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) flat[y * 8 + x] = cur[y][x] / 64 - 0.5;
  return flat;
})();

/** t for one pixel, given the shape and the drag. */
function shapeT(shape, px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  switch (shape) {
    case 'radial': {
      const len = Math.hypot(dx, dy) || 1e-6;
      return Math.hypot(px - x0, py - y0) / len;
    }
    case 'angle': {
      // The drag direction is t = 0; the angle sweeps a full turn.
      const a = Math.atan2(py - y0, px - x0) - Math.atan2(dy, dx);
      return ((a / TAU) % 1 + 1) % 1;
    }
    case 'reflected': {
      const len2 = dx * dx + dy * dy || 1e-12;
      const t = ((px - x0) * dx + (py - y0) * dy) / len2;
      return Math.abs(t);
    }
    case 'diamond': {
      const len2 = dx * dx + dy * dy || 1e-12;
      const u = ((px - x0) * dx + (py - y0) * dy) / len2;
      const v = ((px - x0) * -dy + (py - y0) * dx) / len2;
      return Math.abs(u) + Math.abs(v);
    }
    case 'linear':
    default: {
      const len2 = dx * dx + dy * dy || 1e-12;
      return ((px - x0) * dx + (py - y0) * dy) / len2;
    }
  }
}

/**
 * Render a gradient into an RGBA Float32 buffer covering `r`.
 *
 * @param stops  [{pos, color:[r,g,b], mid}]
 * @param opts   { shape, x0,y0,x1,y1 in DOCUMENT coords, reverse, dither,
 *                 opacity, alphaStops }
 */
export function renderGradient(r, stops, opts = {}) {
  const shape = GRADIENT_SHAPES.includes(opts.shape) ? opts.shape : 'linear';
  const { x0 = 0, y0 = 0, x1 = 1, y1 = 0 } = opts;
  const reverse = !!opts.reverse;
  const dither = opts.dither !== false;
  const opacity = opts.opacity === undefined ? 1 : clamp01(opts.opacity);
  const alphaStops = opts.alphaStops || null;

  // Pre-sample the ramp once: a stop lookup per pixel would dominate, and
  // 1024 samples is finer than 8-bit output can show.
  const N = 1024;
  const ramp = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const c = sampleStops(stops, reverse ? 1 - t : t);
    ramp[i * 4] = c[0]; ramp[i * 4 + 1] = c[1]; ramp[i * 4 + 2] = c[2];
    ramp[i * 4 + 3] = alphaStops ? clamp01(sampleStops(alphaStops, reverse ? 1 - t : t)[0]) : 1;
  }

  const out = new Float32Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const py = r.y + y + 0.5;
    for (let x = 0; x < r.w; x++) {
      const px = r.x + x + 0.5;
      let t = clamp01(shapeT(shape, px, py, x0, y0, x1, y1));
      if (dither) {
        // Half a ramp step of ordered noise, which is below one 8-bit level
        // and breaks the banding a smooth ramp would otherwise show.
        t = clamp01(t + BAYER8[((r.y + y) & 7) * 8 + ((r.x + x) & 7)] / N);
      }
      const f = t * (N - 1);
      const i0 = f | 0;
      const i1 = Math.min(N - 1, i0 + 1);
      const ft = f - i0;
      const d = (y * r.w + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[d + c] = lerp(ramp[i0 * 4 + c], ramp[i1 * 4 + c], ft);
      }
      out[d + 3] *= opacity;
    }
  }
  return out;
}

/** Two-stop stops from the current foreground and background. */
export function twoStop(a, b) {
  return [{ pos: 0, color: a.slice(0, 3) }, { pos: 1, color: b.slice(0, 3) }];
}

/** Foreground to transparent, which needs alpha stops rather than colour. */
export function fgToTransparent(a) {
  return {
    stops: [{ pos: 0, color: a.slice(0, 3) }, { pos: 1, color: a.slice(0, 3) }],
    alphaStops: [{ pos: 0, color: [1, 1, 1] }, { pos: 1, color: [0, 0, 0] }],
  };
}

/**
 * Paint bucket: flood from a point with a tolerance, then fill.
 *
 * It reuses the magic wand rather than having its own flood fill. The bucket
 * IS a wand plus a fill, and two implementations are how the two tools end up
 * disagreeing about what "tolerance 32" means.
 */
export function bucketFill(rgba, w, h, sx, sy, colour, opts = {}) {
  const out = rgba;
  const tolerance = opts.tolerance === undefined ? 20 : opts.tolerance;
  const contiguous = opts.contiguous !== false;
  const { r, cov } = magicWand(rgba, w, h, sx, sy, { tolerance, contiguous, antialias: opts.antialias !== false, fast: opts.fast });
  const alpha = opts.opacity === undefined ? 1 : clamp01(opts.opacity);
  for (let i = 0; i < w * h; i++) {
    const a = cov[i] * alpha;
    if (a <= 0) continue;
    const p = i * 4;
    const ab = out[p + 3];
    const ao = a + ab * (1 - a);
    if (ao <= 0) { out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) out[p + c] = (colour[c] * a + out[p + c] * ab * (1 - a)) / ao;
    out[p + 3] = ao;
  }
  return { r, cov };
}
