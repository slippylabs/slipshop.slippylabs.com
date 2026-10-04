// The filter catalogue.
//
// Same shape as adjust.js: a registry of pure functions over a dense Float32
// RGBA buffer plus a declarative field table, so the Filter menu and its
// dialogs are generated from the same place the maths lives.
//
// The difference from an adjustment is that a filter is SPATIAL -- it reads
// neighbouring pixels. That has one consequence the caller must respect: to
// filter a region, grow the region by the filter's radius, filter, then keep
// the middle. `radiusOf` reports that growth, and anything that filters a
// tile without it gets a seam every 256 pixels.

import { clamp, clamp01, lerp, luma709, mulberry32, gaussianPair, round, TAU, reflect } from './util.js';
import {
  gaussianBlur, boxBlur, convolve, unsharpMask, highPass, rankFilter,
  motionBlur, premultiply, unpremultiply, KERNELS, gaussianRadius, separable, gaussianKernel,
} from './convolve.js';
// Tileable Perlin from SlipKit, vendored by studio/tools/kitcopy.sh. Using
// the kit's module rather than writing another one means Clouds here is
// bit-identical to the Noise Lab tool, and the studio's own oracle already
// holds that module to the live page.
import { fractal, buildPermutation } from '../vendor/slipkit/1.12.0/core/noise.js';
import { srgbToLinear, linearToSrgb, rgbToHsl, hslToRgb } from './color.js';
import { sampleAt } from './resample.js';

// ------------------------------------------------------------------- blur

const blurGaussian = (b, w, h, p) => gaussianBlur(b, w, h, p.radius, p.border || 'clamp');
const blurBox = (b, w, h, p) => boxBlur(b, w, h, Math.round(p.radius), p.border || 'clamp');
const blurMotion = (b, w, h, p) => motionBlur(b, w, h, { length: p.length, angle: p.angle, mode: p.border || 'clamp' });

/** Radial blur: spin about a centre, or zoom towards it. */
function blurRadial(buf, w, h, p) {
  const amount = Math.max(0, p.amount ?? 10);
  if (amount <= 0) return buf;
  const steps = Math.max(2, Math.min(64, Math.round(amount)));
  const cx = (p.cx === undefined ? 0.5 : p.cx) * w;
  const cy = (p.cy === undefined ? 0.5 : p.cy) * h;
  const spin = (p.mode || 'spin') === 'spin';
  const src = buf.slice();
  premultiply(src);
  const out = new Float32Array(buf.length);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const rad = Math.hypot(dx, dy);
      const a0 = Math.atan2(dy, dx);
      let r0 = 0, g0 = 0, b0 = 0, a0c = 0;
      for (let s = 0; s < steps; s++) {
        const t = (s / (steps - 1) - 0.5);
        let sx, sy;
        if (spin) {
          const a = a0 + t * (amount / 100);
          sx = cx + Math.cos(a) * rad;
          sy = cy + Math.sin(a) * rad;
        } else {
          const k = 1 + t * (amount / 100);
          sx = cx + dx * k;
          sy = cy + dy * k;
        }
        sampleAt(src, w, h, sx, sy, 'bilinear', px);
        r0 += px[0]; g0 += px[1]; b0 += px[2]; a0c += px[3];
      }
      const d = (y * w + x) * 4;
      out[d] = r0 / steps; out[d + 1] = g0 / steps; out[d + 2] = b0 / steps; out[d + 3] = a0c / steps;
    }
  }
  unpremultiply(out);
  buf.set(out);
  return buf;
}

/**
 * Surface blur: smooth flat areas and leave edges alone.
 *
 * A bilateral filter -- the weight is the spatial gaussian times a range
 * gaussian on the colour difference, so a pixel across an edge contributes
 * almost nothing. That is what makes it usable for skin without turning a
 * face into plastic.
 */
function blurSurface(buf, w, h, p) {
  const radius = Math.max(1, Math.round(p.radius ?? 5));
  const threshold = Math.max(0.004, p.threshold ?? 0.08);
  const src = buf.slice();
  const sigmaS = radius / 2;
  const inv2s2 = 1 / (2 * sigmaS * sigmaS);
  const inv2r2 = 1 / (2 * threshold * threshold);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p0 = (y * w + x) * 4;
      let acc = [0, 0, 0], wsum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = clamp(y + dy, 0, h - 1);
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = clamp(x + dx, 0, w - 1);
          const q = (sy * w + sx) * 4;
          const dc = (src[q] - src[p0]) ** 2 + (src[q + 1] - src[p0 + 1]) ** 2 + (src[q + 2] - src[p0 + 2]) ** 2;
          const wv = Math.exp(-(dx * dx + dy * dy) * inv2s2 - dc * inv2r2);
          acc[0] += src[q] * wv; acc[1] += src[q + 1] * wv; acc[2] += src[q + 2] * wv;
          wsum += wv;
        }
      }
      if (wsum > 0) for (let c = 0; c < 3; c++) buf[p0 + c] = acc[c] / wsum;
    }
  }
  return buf;
}

/** Lens blur: a disc (bokeh) rather than a gaussian, so highlights become
 *  discs instead of smears. Done in LINEAR light, which is the whole reason
 *  real bokeh has bright rims. */
function blurLens(buf, w, h, p) {
  const radius = Math.max(1, Math.round(p.radius ?? 8));
  const blades = Math.max(0, Math.round(p.blades ?? 0));
  const taps = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      if (blades >= 3) {
        // a regular polygon aperture
        const a = Math.atan2(dy, dx);
        const seg = TAU / blades;
        const r2 = Math.cos(seg / 2) / Math.cos(((a % seg) + seg) % seg - seg / 2);
        if (d > radius * r2) continue;
      }
      taps.push([dx, dy]);
    }
  }
  const src = buf.slice();
  premultiply(src);
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) src[i + c] = srgbToLinear(src[i + c]);
  }
  const out = new Float32Array(buf.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (const [dx, dy] of taps) {
        const sx = clamp(x + dx, 0, w - 1);
        const sy = clamp(y + dy, 0, h - 1);
        const q = (sy * w + sx) * 4;
        r0 += src[q]; g0 += src[q + 1]; b0 += src[q + 2]; a0 += src[q + 3];
      }
      const d = (y * w + x) * 4;
      const n = taps.length;
      out[d] = linearToSrgb(r0 / n); out[d + 1] = linearToSrgb(g0 / n);
      out[d + 2] = linearToSrgb(b0 / n); out[d + 3] = a0 / n;
    }
  }
  unpremultiply(out);
  buf.set(out);
  return buf;
}

// ---------------------------------------------------------------- sharpen

const sharpenUnsharp = (b, w, h, p) => unsharpMask(b, w, h, { radius: p.radius, amount: p.amount, threshold: p.threshold });
const sharpenHigh = (b, w, h, p) => highPass(b, w, h, p.radius);
const sharpenSimple = (b, w, h, p) => {
  const amount = clamp01(p.amount ?? 1);
  const k = KERNELS.sharpen;
  const before = b.slice();
  convolve(b, w, h, k.k, k.w, k.h, { divisor: 1 });
  for (let i = 0; i < b.length; i += 4) {
    for (let c = 0; c < 3; c++) b[i + c] = clamp01(lerp(before[i + c], b[i + c], amount));
  }
  return b;
};

// ------------------------------------------------------------------ noise

/**
 * Noise keyed on the PIXEL, not drawn from a stream walked in buffer order.
 *
 * A single shared stream means the noise depends on where a pixel sits in the
 * buffer, so filtering a region gives different noise from filtering the whole
 * layer -- the filter reports radius 0, claiming to be pointwise, and then is
 * not tileable at all. Keying each pixel's draws on its own coordinates makes
 * it genuinely position-independent: the same pixel gets the same noise
 * whatever rectangle it was filtered in. Same reasoning as particle-forge
 * keying each particle on its index rather than on frame order.
 */
function addNoise(buf, w, h, p) {
  const amount = clamp01(p.amount ?? 0.1);
  const mono = !!p.monochrome;
  const gaussian = (p.distribution || 'gaussian') === 'gaussian';
  const seed = (p.seed ?? 1) >>> 0;
  const ox = p.originX | 0, oy = p.originY | 0;   // the rect's place in the layer
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // A per-pixel generator, seeded from the absolute coordinate.
      const key = (Math.imul(x + ox, 0x27d4eb2d) ^ Math.imul(y + oy, 0x165667b1) ^ seed) >>> 0;
      const rnd = mulberry32(key);
      if (mono) {
        const n = gaussian ? gaussianPair(rnd)[0] * amount * 0.4 : (rnd() - 0.5) * 2 * amount;
        for (let c = 0; c < 3; c++) buf[i + c] = clamp01(buf[i + c] + n);
      } else {
        for (let c = 0; c < 3; c++) {
          const n = gaussian ? gaussianPair(rnd)[0] * amount * 0.4 : (rnd() - 0.5) * 2 * amount;
          buf[i + c] = clamp01(buf[i + c] + n);
        }
      }
    }
  }
  return buf;
}

const median = (b, w, h, p) => rankFilter(b, w, h, Math.round(p.radius), 0.5, 'clamp');
const minimum = (b, w, h, p) => rankFilter(b, w, h, Math.round(p.radius), 0, 'clamp');
const maximum = (b, w, h, p) => rankFilter(b, w, h, Math.round(p.radius), 1, 'clamp');

/** Despeckle: a median that only replaces pixels that stand out, so detail
 *  survives where there is no speckle to remove. */
function despeckle(buf, w, h, p) {
  const before = buf.slice();
  rankFilter(buf, w, h, 1, 0.5, 'clamp');
  const threshold = p.threshold ?? 0.06;
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(before[i + c] - buf[i + c]) < threshold) buf[i + c] = before[i + c];
    }
  }
  return buf;
}

// ---------------------------------------------------------------- stylize

function findEdges(buf, w, h, p) {
  const src = buf.slice();
  const gx = src.slice(), gy = src.slice();
  convolve(gx, w, h, KERNELS.sobelX.k, 3, 3, { divisor: 1, bias: 0 });
  convolve(gy, w, h, KERNELS.sobelY.k, 3, 3, { divisor: 1, bias: 0 });
  const invert = p.invert !== false;
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const m = Math.min(1, Math.hypot(gx[i + c], gy[i + c]));
      buf[i + c] = invert ? 1 - m : m;
    }
  }
  return buf;
}

function emboss(buf, w, h, p) {
  const angle = ((p.angle ?? 135) * Math.PI) / 180;
  const height = p.height ?? 2;
  const amount = p.amount ?? 1;
  const dx = Math.cos(angle), dy = -Math.sin(angle);
  const k = [
    -dx * height - dy * height, -dy * height, dx * height - dy * height,
    -dx * height, 1, dx * height,
    -dx * height + dy * height, dy * height, dx * height + dy * height,
  ].map((v, i) => (i === 4 ? 1 : v * amount));
  return convolve(buf, w, h, k, 3, 3, { divisor: 1, bias: p.gray === false ? 0 : 0.5 });
}

function solarize(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 3; c++) buf[i + c] = buf[i + c] < 0.5 ? buf[i + c] : 1 - buf[i + c];
  }
  return buf;
}

/** Oil paint: for each pixel, the most common intensity bucket in its
 *  neighbourhood, averaged. The classic Kuwahara-family effect. */
function oilPaint(buf, w, h, p) {
  const radius = Math.max(1, Math.round(p.radius ?? 3));
  const levels = Math.max(2, Math.round(p.levels ?? 20));
  const src = buf.slice();
  const count = new Int32Array(levels);
  const sum = new Float32Array(levels * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      count.fill(0); sum.fill(0);
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = clamp(y + dy, 0, h - 1);
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = clamp(x + dx, 0, w - 1);
          const q = (sy * w + sx) * 4;
          const lv = Math.min(levels - 1, Math.floor(luma709(src[q], src[q + 1], src[q + 2]) * levels));
          count[lv]++;
          sum[lv * 3] += src[q]; sum[lv * 3 + 1] += src[q + 1]; sum[lv * 3 + 2] += src[q + 2];
        }
      }
      let best = 0;
      for (let i = 1; i < levels; i++) if (count[i] > count[best]) best = i;
      const d = (y * w + x) * 4;
      const n = Math.max(1, count[best]);
      for (let c = 0; c < 3; c++) buf[d + c] = sum[best * 3 + c] / n;
    }
  }
  return buf;
}

// --------------------------------------------------------------- pixelate

function mosaic(buf, w, h, p) {
  const size = Math.max(2, Math.round(p.size ?? 10));
  for (let by = 0; by < h; by += size) {
    for (let bx = 0; bx < w; bx += size) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const ey = Math.min(h, by + size), ex = Math.min(w, bx + size);
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const q = (y * w + x) * 4;
        // Average in PREMULTIPLIED form, or a block containing transparency
        // takes the colour of pixels nobody can see.
        const al = buf[q + 3];
        r += buf[q] * al; g += buf[q + 1] * al; b += buf[q + 2] * al; a += al;
        n++;
      }
      const aa = a / n;
      const rr = aa > 0 ? r / a : 0, gg = aa > 0 ? g / a : 0, bb = aa > 0 ? b / a : 0;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const q = (y * w + x) * 4;
        buf[q] = rr; buf[q + 1] = gg; buf[q + 2] = bb; buf[q + 3] = aa;
      }
    }
  }
  return buf;
}

/** Colour halftone: a rotated dot screen per channel, as a print would be. */
function halftone(buf, w, h, p) {
  const size = Math.max(2, p.size ?? 8);
  const angles = [p.angleC ?? 108, p.angleM ?? 162, p.angleY ?? 90];
  const src = buf.slice();
  for (let c = 0; c < 3; c++) {
    const a = (angles[c] * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x * ca + y * sa) / size;
        const v = (-x * sa + y * ca) / size;
        const du = u - Math.floor(u) - 0.5;
        const dv = v - Math.floor(v) - 0.5;
        const d = Math.hypot(du, dv) * 2;
        const q = (y * w + x) * 4;
        // the dot grows as the channel darkens
        const ink = 1 - src[q + c];
        buf[q + c] = d < Math.sqrt(ink) ? 0 : 1;
      }
    }
  }
  return buf;
}

function crystallize(buf, w, h, p) {
  const size = Math.max(2, Math.round(p.size ?? 12));
  const rnd = mulberry32((p.seed ?? 7) >>> 0);
  // Jittered grid of sites, so each pixel takes the colour of the nearest.
  const cols = Math.ceil(w / size) + 1, rows = Math.ceil(h / size) + 1;
  const sites = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      sites.push([(gx + rnd()) * size, (gy + rnd()) * size]);
    }
  }
  const src = buf.slice();
  const acc = new Float32Array(sites.length * 5);
  const cellOf = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cols - 1, Math.floor(x / size));
      const gy = Math.min(rows - 1, Math.floor(y / size));
      let best = -1, bd = Infinity;
      // Only the 3x3 block of cells can hold the nearest site.
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox, cy = gy + oy;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        const i = cy * cols + cx;
        const d = (sites[i][0] - x) ** 2 + (sites[i][1] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cellOf[y * w + x] = best;
      const q = (y * w + x) * 4;
      const al = src[q + 3];
      acc[best * 5] += src[q] * al; acc[best * 5 + 1] += src[q + 1] * al;
      acc[best * 5 + 2] += src[q + 2] * al; acc[best * 5 + 3] += al; acc[best * 5 + 4] += 1;
    }
  }
  for (let i = 0; i < w * h; i++) {
    const c = cellOf[i];
    const n = acc[c * 5 + 4] || 1;
    const a = acc[c * 5 + 3];
    const p4 = i * 4;
    buf[p4] = a > 0 ? acc[c * 5] / a : 0;
    buf[p4 + 1] = a > 0 ? acc[c * 5 + 1] / a : 0;
    buf[p4 + 2] = a > 0 ? acc[c * 5 + 2] / a : 0;
    buf[p4 + 3] = a / n;
  }
  return buf;
}

// ---------------------------------------------------------------- distort

/** A generic warp: the caller supplies a (x,y) -> (sx,sy) inverse map. */
function warp(buf, w, h, map, filter = 'bilinear') {
  const src = buf.slice();
  premultiply(src);
  const out = new Float32Array(buf.length);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = map(x + 0.5, y + 0.5);
      sampleAt(src, w, h, sx, sy, filter, px);
      const d = (y * w + x) * 4;
      out[d] = px[0]; out[d + 1] = px[1]; out[d + 2] = px[2]; out[d + 3] = px[3];
    }
  }
  unpremultiply(out);
  buf.set(out);
  return buf;
}

const twirl = (b, w, h, p) => {
  const cx = w / 2, cy = h / 2;
  const rad = Math.min(w, h) / 2;
  const amt = ((p.angle ?? 90) * Math.PI) / 180;
  return warp(b, w, h, (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= rad) return [x, y];
    const t = (1 - d / rad) ** 2 * amt;
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
};

const pinch = (b, w, h, p) => {
  const cx = w / 2, cy = h / 2;
  const rad = Math.min(w, h) / 2;
  const amt = p.amount ?? 0.5;
  return warp(b, w, h, (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= rad || d === 0) return [x, y];
    const t = d / rad;
    const k = Math.pow(t, 1 + amt) / t;
    return [cx + dx * k, cy + dy * k];
  });
};

const spherize = (b, w, h, p) => {
  const cx = w / 2, cy = h / 2;
  const rad = Math.min(w, h) / 2;
  const amt = p.amount ?? 0.5;
  return warp(b, w, h, (x, y) => {
    const dx = (x - cx) / rad, dy = (y - cy) / rad;
    const d = Math.hypot(dx, dy);
    if (d >= 1 || d === 0) return [x, y];
    const z = Math.sqrt(1 - d * d);
    const k = 1 - amt * (1 - z);
    return [cx + dx * rad * k, cy + dy * rad * k];
  });
};

const wave = (b, w, h, p) => {
  const amp = p.amplitude ?? 10;
  const len = Math.max(2, p.wavelength ?? 60);
  const vertical = p.direction !== 'horizontal';
  return warp(b, w, h, (x, y) => (vertical
    ? [x + Math.sin((y / len) * TAU) * amp, y]
    : [x, y + Math.sin((x / len) * TAU) * amp]));
};

const polar = (b, w, h, p) => {
  const toPolar = p.mode !== 'toRect';
  const cx = w / 2, cy = h / 2;
  const rad = Math.min(w, h) / 2;
  return warp(b, w, h, (x, y) => {
    if (toPolar) {
      const a = (x / w) * TAU - Math.PI;
      const r = (y / h) * rad;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    const dx = x - cx, dy = y - cy;
    const a = (Math.atan2(dy, dx) + Math.PI) / TAU;
    const r = Math.hypot(dx, dy) / rad;
    return [a * w, r * h];
  });
};

/** Lens correction: barrel/pincushion, chromatic aberration, vignette. */
function lensCorrect(buf, w, h, p) {
  const k1 = p.distortion ?? 0;
  const ca = p.chromatic ?? 0;
  const vig = p.vignette ?? 0;
  const cx = w / 2, cy = h / 2;
  const norm = Math.hypot(cx, cy);
  if (k1 !== 0 || ca !== 0) {
    const src = buf.slice();
    premultiply(src);
    const out = new Float32Array(buf.length);
    const px = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - cx) / norm, dy = (y + 0.5 - cy) / norm;
        const r2 = dx * dx + dy * dy;
        const d = (y * w + x) * 4;
        // Each channel gets its own scale, which IS chromatic aberration --
        // one sample for all three would make the correction colourless.
        for (let c = 0; c < 3; c++) {
          const cscale = 1 + ca * 0.01 * (c - 1);
          const k = (1 + k1 * r2) * cscale;
          sampleAt(src, w, h, cx + dx * norm * k, cy + dy * norm * k, 'bilinear', px);
          out[d + c] = px[c];
          if (c === 1) out[d + 3] = px[3];
        }
      }
    }
    unpremultiply(out);
    buf.set(out);
  }
  if (vig !== 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - cx) / norm, dy = (y + 0.5 - cy) / norm;
        const r = Math.hypot(dx, dy);
        const f = 1 - vig * r * r;
        const d = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) buf[d + c] = clamp01(buf[d + c] * f);
      }
    }
  }
  return buf;
}

// ----------------------------------------------------------------- render

function renderClouds(buf, w, h, p) {
  const scale = Math.max(2, p.scale ?? 120);
  const octaves = Math.max(1, Math.round(p.octaves ?? 5));
  const seed = (p.seed ?? 1) >>> 0;
  const difference = !!p.difference;
  const fg = p.fg || [0, 0, 0];
  const bg = p.bg || [1, 1, 1];
  const perm = buildPermutation(seed);
  const opts = { perm, octaves, lacunarity: 2, gain: 0.5, period: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = fractal('perlin', difference ? 'turbulence' : 'fbm', x / scale, y / scale, opts);
      n = clamp01(difference ? Math.abs(n) : (n + 1) / 2);
      const d = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) buf[d + c] = lerp(fg[c], bg[c], n);
      buf[d + 3] = 1;
    }
  }
  return buf;
}

function renderFibers(buf, w, h, p) {
  const variance = Math.max(0.05, p.variance ?? 0.5);
  const strength = Math.max(1, p.strength ?? 16);
  const rnd = mulberry32((p.seed ?? 3) >>> 0);
  const fg = p.fg || [0, 0, 0];
  const bg = p.bg || [1, 1, 1];
  const walk = new Float32Array(w);
  for (let x = 0; x < w; x++) walk[x] = rnd();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      walk[x] = clamp01(walk[x] + (rnd() - 0.5) * variance / strength);
      const d = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) buf[d + c] = lerp(fg[c], bg[c], walk[x]);
      buf[d + 3] = 1;
    }
  }
  return buf;
}

// ------------------------------------------------------------------ other

const offsetWrap = (b, w, h, p) => {
  const dx = Math.round(p.x ?? 0), dy = Math.round(p.y ?? 0);
  const src = b.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = ((x - dx) % w + w) % w;
      const sy = ((y - dy) % h + h) % h;
      const d = (y * w + x) * 4, q = (sy * w + sx) * 4;
      for (let c = 0; c < 4; c++) b[d + c] = src[q + c];
    }
  }
  return b;
};

const customKernel = (b, w, h, p) => {
  const k = p.kernel || KERNELS.identity.k;
  const n = Math.round(Math.sqrt(k.length));
  return convolve(b, w, h, k, n, n, { divisor: p.divisor, bias: p.bias, mode: p.border || 'clamp' });
};

// --------------------------------------------------------------- registry

export const FILTERS = {
  gaussianBlur: {
    label: 'Gaussian Blur', group: 'Blur', defaults: { radius: 4, border: 'clamp' },
    fields: [['Radius', 'radius', 'num', 0, 250, 0.1], ['Edges', 'border', 'sel', ['clamp', 'reflect', 'wrap', 'zero']]],
    radius: (p) => gaussianRadius(p.radius), apply: blurGaussian,
  },
  boxBlur: {
    label: 'Box Blur', group: 'Blur', defaults: { radius: 4, border: 'clamp' },
    fields: [['Radius', 'radius', 'num', 1, 200, 1]],
    radius: (p) => Math.round(p.radius), apply: blurBox,
  },
  motionBlur: {
    label: 'Motion Blur', group: 'Blur', defaults: { length: 20, angle: 0 },
    fields: [['Length', 'length', 'num', 2, 400, 1], ['Angle', 'angle', 'num', -180, 180, 1]],
    radius: (p) => Math.ceil(p.length / 2) + 1, apply: blurMotion,
  },
  radialBlur: {
    label: 'Radial Blur', group: 'Blur', defaults: { amount: 10, mode: 'spin', cx: 0.5, cy: 0.5 },
    fields: [['Amount', 'amount', 'num', 1, 100, 1], ['Mode', 'mode', 'sel', ['spin', 'zoom']]],
    radius: () => null, apply: blurRadial,          // null = needs the whole layer
  },
  surfaceBlur: {
    label: 'Surface Blur', group: 'Blur', defaults: { radius: 5, threshold: 0.08 },
    fields: [['Radius', 'radius', 'num', 1, 40, 1], ['Threshold', 'threshold', 'num', 0.004, 0.5, 0.004]],
    radius: (p) => Math.round(p.radius), apply: blurSurface,
  },
  lensBlur: {
    label: 'Lens Blur', group: 'Blur', defaults: { radius: 8, blades: 0 },
    fields: [['Radius', 'radius', 'num', 1, 60, 1], ['Blades', 'blades', 'num', 0, 12, 1]],
    radius: (p) => Math.round(p.radius), apply: blurLens,
  },
  unsharpMask: {
    label: 'Unsharp Mask', group: 'Sharpen', defaults: { radius: 2, amount: 1, threshold: 0 },
    fields: [['Radius', 'radius', 'num', 0.1, 100, 0.1], ['Amount', 'amount', 'num', 0, 5, 0.01], ['Threshold', 'threshold', 'num', 0, 0.5, 0.004]],
    radius: (p) => gaussianRadius(p.radius), apply: sharpenUnsharp,
  },
  sharpen: {
    label: 'Sharpen', group: 'Sharpen', defaults: { amount: 1 },
    fields: [['Amount', 'amount', 'num', 0, 1, 0.01]],
    radius: () => 1, apply: sharpenSimple,
  },
  highPass: {
    label: 'High Pass', group: 'Sharpen', defaults: { radius: 3 },
    fields: [['Radius', 'radius', 'num', 0.1, 100, 0.1]],
    radius: (p) => gaussianRadius(p.radius), apply: sharpenHigh,
  },
  addNoise: {
    label: 'Add Noise', group: 'Noise', defaults: { amount: 0.1, monochrome: false, distribution: 'gaussian', seed: 1 },
    fields: [['Amount', 'amount', 'num', 0, 1, 0.01], ['Monochrome', 'monochrome', 'bool'], ['Distribution', 'distribution', 'sel', ['gaussian', 'uniform']], ['Seed', 'seed', 'num', 1, 99999, 1]],
    radius: () => 0, apply: addNoise,
  },
  median: {
    label: 'Median', group: 'Noise', defaults: { radius: 2 },
    fields: [['Radius', 'radius', 'num', 1, 20, 1]],
    radius: (p) => Math.round(p.radius), apply: median,
  },
  despeckle: {
    label: 'Despeckle', group: 'Noise', defaults: { threshold: 0.06 },
    fields: [['Threshold', 'threshold', 'num', 0.004, 0.3, 0.004]],
    radius: () => 1, apply: despeckle,
  },
  minimum: {
    label: 'Minimum (erode)', group: 'Other', defaults: { radius: 1 },
    fields: [['Radius', 'radius', 'num', 1, 20, 1]],
    radius: (p) => Math.round(p.radius), apply: minimum,
  },
  maximum: {
    label: 'Maximum (dilate)', group: 'Other', defaults: { radius: 1 },
    fields: [['Radius', 'radius', 'num', 1, 20, 1]],
    radius: (p) => Math.round(p.radius), apply: maximum,
  },
  findEdges: {
    label: 'Find Edges', group: 'Stylize', defaults: { invert: true },
    fields: [['Invert', 'invert', 'bool']],
    radius: () => 1, apply: findEdges,
  },
  emboss: {
    label: 'Emboss', group: 'Stylize', defaults: { angle: 135, height: 2, amount: 1 },
    fields: [['Angle', 'angle', 'num', -180, 180, 1], ['Height', 'height', 'num', 1, 10, 0.1], ['Amount', 'amount', 'num', 0, 5, 0.1]],
    radius: () => 1, apply: emboss,
  },
  solarize: {
    label: 'Solarize', group: 'Stylize', defaults: {}, fields: [],
    radius: () => 0, apply: solarize,
  },
  oilPaint: {
    label: 'Oil Paint', group: 'Stylize', defaults: { radius: 3, levels: 20 },
    fields: [['Radius', 'radius', 'num', 1, 12, 1], ['Levels', 'levels', 'num', 2, 60, 1]],
    radius: (p) => Math.round(p.radius), apply: oilPaint,
  },
  mosaic: {
    label: 'Mosaic', group: 'Pixelate', defaults: { size: 10 },
    fields: [['Cell size', 'size', 'num', 2, 200, 1]],
    radius: () => null, apply: mosaic,
  },
  halftone: {
    label: 'Colour Halftone', group: 'Pixelate', defaults: { size: 8, angleC: 108, angleM: 162, angleY: 90 },
    fields: [['Dot size', 'size', 'num', 2, 40, 1]],
    radius: () => null, apply: halftone,
  },
  crystallize: {
    label: 'Crystallize', group: 'Pixelate', defaults: { size: 12, seed: 7 },
    fields: [['Cell size', 'size', 'num', 2, 120, 1], ['Seed', 'seed', 'num', 1, 9999, 1]],
    radius: () => null, apply: crystallize,
  },
  twirl: {
    label: 'Twirl', group: 'Distort', defaults: { angle: 90 },
    fields: [['Angle', 'angle', 'num', -720, 720, 1]],
    radius: () => null, apply: twirl,
  },
  pinch: {
    label: 'Pinch', group: 'Distort', defaults: { amount: 0.5 },
    fields: [['Amount', 'amount', 'num', -1, 2, 0.01]],
    radius: () => null, apply: pinch,
  },
  spherize: {
    label: 'Spherize', group: 'Distort', defaults: { amount: 0.5 },
    fields: [['Amount', 'amount', 'num', -1, 1, 0.01]],
    radius: () => null, apply: spherize,
  },
  wave: {
    label: 'Wave', group: 'Distort', defaults: { amplitude: 10, wavelength: 60, direction: 'vertical' },
    fields: [['Amplitude', 'amplitude', 'num', 0, 200, 1], ['Wavelength', 'wavelength', 'num', 2, 500, 1], ['Direction', 'direction', 'sel', ['vertical', 'horizontal']]],
    radius: (p) => Math.ceil(p.amplitude) + 2, apply: wave,
  },
  polar: {
    label: 'Polar Coordinates', group: 'Distort', defaults: { mode: 'toPolar' },
    fields: [['Mode', 'mode', 'sel', ['toPolar', 'toRect']]],
    radius: () => null, apply: polar,
  },
  lensCorrect: {
    label: 'Lens Correction', group: 'Distort', defaults: { distortion: 0, chromatic: 0, vignette: 0 },
    fields: [['Distortion', 'distortion', 'num', -0.6, 0.6, 0.005], ['Chromatic', 'chromatic', 'num', -2, 2, 0.01], ['Vignette', 'vignette', 'num', -1, 1, 0.01]],
    radius: () => null, apply: lensCorrect,
  },
  clouds: {
    label: 'Clouds', group: 'Render', defaults: { scale: 120, octaves: 5, seed: 1, difference: false },
    fields: [['Scale', 'scale', 'num', 4, 800, 1], ['Octaves', 'octaves', 'num', 1, 9, 1], ['Seed', 'seed', 'num', 1, 9999, 1], ['Difference', 'difference', 'bool']],
    radius: () => null, apply: renderClouds, usesColours: true,
  },
  fibers: {
    label: 'Fibers', group: 'Render', defaults: { variance: 0.5, strength: 16, seed: 3 },
    fields: [['Variance', 'variance', 'num', 0.05, 2, 0.05], ['Strength', 'strength', 'num', 1, 64, 1], ['Seed', 'seed', 'num', 1, 9999, 1]],
    radius: () => null, apply: renderFibers, usesColours: true,
  },
  offset: {
    label: 'Offset (wrap)', group: 'Other', defaults: { x: 0, y: 0 },
    fields: [['X', 'x', 'num', -4000, 4000, 1], ['Y', 'y', 'num', -4000, 4000, 1]],
    radius: () => null, apply: offsetWrap,
  },
  custom: {
    label: 'Custom 3x3', group: 'Other',
    defaults: { kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0], divisor: 0, bias: 0, border: 'clamp' },
    fields: [['Divisor', 'divisor', 'num', -20, 20, 0.1], ['Bias', 'bias', 'num', -1, 1, 0.01]],
    radius: () => 1, apply: customKernel,
  },
};

export const FILTER_KINDS = Object.keys(FILTERS);

export const FILTER_GROUPS = (() => {
  const g = new Map();
  for (const k of FILTER_KINDS) {
    const grp = FILTERS[k].group;
    if (!g.has(grp)) g.set(grp, []);
    g.get(grp).push(k);
  }
  return [...g.entries()];
})();

export function filterDefaults(kind) {
  const f = FILTERS[kind];
  if (!f) throw new Error(`unknown filter: ${kind}`);
  return structuredClone(f.defaults);
}

/**
 * The pixel radius a filter reads outside the region it writes, or null when
 * it is GLOBAL -- a twirl or a mosaic depends on the whole layer, so a caller
 * cannot filter a sub-rect of it at all.
 */
export function radiusOf(kind, params) {
  const f = FILTERS[kind];
  if (!f) throw new Error(`unknown filter: ${kind}`);
  const r = f.radius({ ...f.defaults, ...(params || {}) });
  return r === null ? null : Math.max(0, Math.ceil(r));
}

/**
 * Apply a filter and hold it to the engine's range contract.
 *
 * The clamp is central rather than per filter because three of them overshoot
 * BY DESIGN and it would be wrong to change them: unsharp mask is
 * src + amount*(src - blur), which rings past both ends at a hard edge;
 * emboss adds a 0.5 bias to a signed gradient; and lens blur round-trips
 * through linear light. Clamping inside each would lose the headroom a chain
 * of filters can legitimately use, and clamping nowhere lets a negative value
 * reach a codec. So the primitives stay honest and the public entry point
 * guarantees 0..1.
 */
export function applyFilter(kind, params, buf, w, h) {
  const f = FILTERS[kind];
  if (!f) throw new Error(`unknown filter: ${kind}`);
  f.apply(buf, w, h, { ...f.defaults, ...(params || {}) });
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    // NaN fails both comparisons, so it is caught by the else branch.
    if (v >= 0 && v <= 1) continue;
    buf[i] = v > 1 ? 1 : (v >= 0 ? v : 0);
  }
  return buf;
}
