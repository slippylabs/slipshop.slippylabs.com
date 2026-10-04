// The compositor: a layer stack down to one RGBA buffer.
//
// It works on a RECT, not on whole layers, for two reasons. It is how the
// viewport repaints only what moved, and it is what makes the tiled and flat
// paths comparable -- compositing a region in one call must equal compositing
// it in pieces, and an oracle can check that directly.
//
// The model is the W3C one, applied bottom-up:
//
//   for each layer, bottom first:
//     Cs, as  <- the layer's own colour and alpha (recursive for a group)
//     as      <- as * mask * opacity                 (and fillOpacity, and Blend If)
//     as      <- as * clipBase                       (if it is a clipping layer)
//     backdrop <- composite(blend, backdrop, Cs, as)
//
// An ADJUSTMENT layer is different in kind: it does not add colour, it
// rewrites the backdrop beneath it. That is why it cannot be expressed as a
// blend mode, and why its mask and opacity mean "how much of the adjusted
// result to keep" rather than "how opaque are my pixels".

import { composite as compositePixel, blendColor, SEPARABLE, NON_SEPARABLE } from './blend.js';
import { srgbToLinear, linearToSrgb } from './color.js';
import { rect, rectIntersect, rectEmpty, clamp01 } from './util.js';

/**
 * @param doc   a Doc
 * @param box   the rect to composite; defaults to the whole document
 * @param opts  { applyAdjust } -- a function (kind, params, buf, w, h) that
 *              rewrites buf in place. Passed in so core/composite.js does not
 *              depend on the adjustment catalogue, which keeps the dependency
 *              graph a tree and lets a test substitute a known function.
 * @returns     Float32Array RGBA, straight (non-premultiplied) alpha
 */
export function compositeDoc(doc, box, opts = {}) {
  const r = rectIntersect(box || doc.bounds, doc.bounds);
  const out = new Float32Array(Math.max(0, r.w * r.h * 4));
  if (rectEmpty(r)) return out;
  compositeInto(out, doc.layers, doc, r, opts);
  return out;
}

/** Composite a list of layers onto an existing RGBA buffer, in place. */
export function compositeInto(dst, layers, doc, r, opts = {}) {
  const n = r.w * r.h;
  // Scratch buffers reused across layers: one composite of a 4000px-wide
  // document allocating per layer is what turns a 12-layer file into a
  // garbage-collection pause.
  const src = new Float32Array(n * 4);
  const cov = new Float32Array(n);          // the layer's coverage after mask/opacity
  /** The alpha of the nearest non-clipping layer below, for clipping masks. */
  let clipBase = null;

  for (const layer of layers) {
    if (!layer.visible) continue;

    if (layer.type === 'adjustment') {
      applyAdjustmentLayer(dst, layer, doc, r, opts, clipBase);
      continue;
    }

    if (layer.type === 'group' && !layer.isolated) {
      // Pass-through: the children see the backdrop and write straight onto
      // it, which is exactly what "no isolation" means.
      compositeInto(dst, layer.children, doc, r, opts);
      if (!layer.clipping) clipBase = null;
      continue;
    }

    src.fill(0);
    if (!layerPixels(src, layer, doc, r, opts)) {
      if (!layer.clipping) clipBase = null;
      continue;
    }

    // coverage = own alpha * fillOpacity * mask * opacity * blendIf
    readCoverage(cov, layer, doc, r, src);

    if (layer.clipping && clipBase) {
      for (let i = 0; i < n; i++) cov[i] *= clipBase[i];
    }

    blendOnto(dst, src, cov, layer.effectiveBlend, n, doc.linearBlend);

    // A non-clipping layer becomes the clip base for the clipping layers
    // above it. Snapshot its own coverage, not the accumulated backdrop:
    // clipping is to the BASE LAYER's shape, not to everything underneath.
    if (!layer.clipping) {
      clipBase = clipBase && clipBase.length === n ? clipBase : new Float32Array(n);
      clipBase.set(cov);
    }
  }
  return dst;
}

/** Fill `src` with a layer's own straight-alpha RGBA. False if it has none. */
function layerPixels(src, layer, doc, r, opts) {
  if (layer.type === 'group') {
    // Isolated: children composite against transparency.
    compositeInto(src, layer.children, doc, r, opts);
    return true;
  }
  if (layer.surface) {
    layer.surface.readRect(r, src);
    return true;
  }
  if (layer.type === 'fill' && layer.fill && layer.fill.kind === 'solid') {
    const c = layer.fill.color || [0, 0, 0, 1];
    for (let i = 0, p = 0; i < r.w * r.h; i++, p += 4) {
      src[p] = c[0]; src[p + 1] = c[1]; src[p + 2] = c[2]; src[p + 3] = c.length > 3 ? c[3] : 1;
    }
    return true;
  }
  return false;
}

/** coverage[i] = srcAlpha * fillOpacity * mask * opacity, blendIf applied. */
function readCoverage(cov, layer, doc, r, src) {
  const n = r.w * r.h;
  const o = layer.opacity * layer.fillOpacity;
  for (let i = 0; i < n; i++) cov[i] = src[i * 4 + 3] * o;
  if (layer.mask && layer.maskEnabled) {
    const m = layer.mask.readRect(r);
    for (let i = 0; i < n; i++) cov[i] *= m[i];
  }
  if (layer.blendIf) applyBlendIf(cov, layer.blendIf, src, n);
}

/**
 * Blend If: a per-channel range on the source (and on the backdrop) that
 * fades a layer out where the underlying tone is outside it. The two inner
 * handles of each slider give a linear ramp rather than a hard cut, which is
 * the only reason the feature is usable at all.
 */
function applyBlendIf(cov, spec, src, n) {
  const ch = { gray: -1, r: 0, g: 1, b: 2 }[spec.channel || 'gray'];
  const [a0, a1, b0, b1] = spec.source || [0, 0, 1, 1];
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const v = ch < 0 ? (0.3 * src[p] + 0.59 * src[p + 1] + 0.11 * src[p + 2]) : src[p + ch];
    let f = 1;
    if (v < a0) f = 0;
    else if (v < a1) f = (v - a0) / Math.max(1e-9, a1 - a0);
    else if (v > b1) f = 0;
    else if (v > b0) f = 1 - (v - b0) / Math.max(1e-9, b1 - b0);
    cov[i] *= f;
  }
}

/** The W3C composite, over a buffer, with an optional detour into linear. */
function blendOnto(dst, src, cov, mode, n, linear) {
  const sep = SEPARABLE[mode];
  const nonSep = NON_SEPARABLE[mode];
  const cb = [0, 0, 0], cs = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const as = cov[i];
    if (as <= 0) continue;
    const p = i * 4;
    const ab = dst[p + 3];
    for (let c = 0; c < 3; c++) {
      cb[c] = linear ? srgbToLinear(dst[p + c]) : dst[p + c];
      cs[c] = linear ? srgbToLinear(src[p + c]) : src[p + c];
    }
    // Inlined rather than calling composite() per pixel: this is the engine's
    // hot loop and the array allocation in the generic version dominates it.
    const ao = as + ab * (1 - as);
    if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }
    if (sep) {
      for (let c = 0; c < 3; c++) {
        const b = sep(cb[c], cs[c]);
        const cr = (1 - ab) * cs[c] + ab * b;
        const v = (as * cr + ab * cb[c] * (1 - as)) / ao;
        dst[p + c] = linear ? linearToSrgb(v) : v;
      }
    } else {
      const b = nonSep(cb, cs);
      for (let c = 0; c < 3; c++) {
        const cr = (1 - ab) * cs[c] + ab * b[c];
        const v = (as * cr + ab * cb[c] * (1 - as)) / ao;
        dst[p + c] = linear ? linearToSrgb(v) : v;
      }
    }
    dst[p + 3] = ao;
  }
}

/**
 * An adjustment layer rewrites the backdrop in place, then mixes the result
 * back by mask * opacity. Mixing is what makes a 40%-opacity Curves layer
 * mean "40% of the way to the adjusted tone", and it is why an adjustment
 * layer at full opacity with no mask must be BIT-IDENTICAL to applying the
 * same adjustment destructively -- the property the oracle checks.
 */
function applyAdjustmentLayer(dst, layer, doc, r, opts, clipBase) {
  const apply = opts.applyAdjust;
  if (!apply || !layer.adjust) return;
  const n = r.w * r.h;
  const before = layer.opacity < 1 || (layer.mask && layer.maskEnabled) || layer.clipping
    ? dst.slice()
    : null;
  apply(layer.adjust.kind, layer.adjust.params, dst, r.w, r.h);
  if (!before) return;
  const m = layer.mask && layer.maskEnabled ? layer.mask.readRect(r) : null;
  for (let i = 0; i < n; i++) {
    let f = layer.opacity;
    if (m) f *= m[i];
    if (layer.clipping && clipBase) f *= clipBase[i];
    if (f >= 1) continue;
    const p = i * 4;
    for (let c = 0; c < 4; c++) dst[p + c] = before[p + c] + (dst[p + c] - before[p + c]) * f;
  }
}

/** Composite onto an opaque background -- what an export to JPEG needs. */
export function flattenOnto(doc, box, bg = [1, 1, 1], opts = {}) {
  const r = rectIntersect(box || doc.bounds, doc.bounds);
  const out = compositeDoc(doc, r, opts);
  for (let i = 0, p = 0; i < r.w * r.h; i++, p += 4) {
    const a = out[p + 3];
    for (let c = 0; c < 3; c++) out[p + c] = out[p + c] * a + bg[c] * (1 - a);
    out[p + 3] = 1;
  }
  return out;
}
