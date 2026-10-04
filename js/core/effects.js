// Layer effects.
//
// An effect is extra pixels drawn with the layer, derived from its own shape.
// They are NOT baked into the layer, so they follow it as you paint.
//
// Two things decide the whole design:
//
// 1. AN EFFECT IS A LAYER OF ITS OWN, placed either below or above the layer's
//    pixels. A drop shadow is a blurred, offset, coloured copy of the layer's
//    alpha drawn underneath; an inner shadow is the same thing drawn on top
//    and clipped to the alpha. Expressing them as ordered buffers rather than
//    as special cases inside the compositor keeps the compositor one loop and
//    makes each effect independently testable.
//
// 2. EFFECTS USE `opacity`, THE PIXELS USE `opacity * fillOpacity`. That is
//    the entire reason those two sliders both exist: drop Fill to 0 and the
//    layer's own pixels vanish while its stroke and shadow stay. Text with a
//    stroke and no fill is the usual reason anyone wants it.
//
// Everything derives from the layer's ALPHA, so an effect does not care
// whether the shape came from a brush, a text layer or a pasted cut-out.

import { clamp, clamp01 } from './util.js';
import { gaussianBlur } from './convolve.js';
import { distanceTransform, signedDistance } from './distance.js';
import { renderGradient } from './gradient.js';

export const EFFECT_TYPES = [
  'dropShadow', 'innerShadow', 'outerGlow', 'innerGlow',
  'stroke', 'colorOverlay', 'gradientOverlay', 'satin', 'bevel',
];

/** Where each effect sits relative to the layer's own pixels. */
const PLACEMENT = {
  dropShadow: 'below',
  outerGlow: 'below',
  innerShadow: 'above',
  innerGlow: 'above',
  colorOverlay: 'above',
  gradientOverlay: 'above',
  satin: 'above',
  bevel: 'above',
  stroke: 'both',            // depends on its position setting
};

export function effectDefaults(type) {
  switch (type) {
    case 'dropShadow':
      return { type, enabled: true, color: [0, 0, 0], opacity: 0.6, angle: 135, distance: 8, spread: 0, size: 10, blend: 'multiply' };
    case 'innerShadow':
      return { type, enabled: true, color: [0, 0, 0], opacity: 0.6, angle: 135, distance: 6, choke: 0, size: 8, blend: 'multiply' };
    case 'outerGlow':
      return { type, enabled: true, color: [1, 0.9, 0.4], opacity: 0.7, spread: 0, size: 14, blend: 'screen' };
    case 'innerGlow':
      return { type, enabled: true, color: [1, 0.95, 0.7], opacity: 0.6, choke: 0, size: 10, source: 'edge', blend: 'screen' };
    case 'stroke':
      return { type, enabled: true, color: [0, 0, 0], opacity: 1, size: 3, position: 'outside', blend: 'normal' };
    case 'colorOverlay':
      return { type, enabled: true, color: [1, 0, 0], opacity: 1, blend: 'normal' };
    case 'gradientOverlay':
      return {
        type, enabled: true, opacity: 1, angle: 90, scale: 1, reverse: false, blend: 'normal',
        stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }],
      };
    case 'satin':
      return { type, enabled: true, color: [0, 0, 0], opacity: 0.4, angle: 19, distance: 11, size: 14, invert: true, blend: 'multiply' };
    case 'bevel':
      return { type, enabled: true, size: 8, soften: 2, depth: 1, angle: 135, altitude: 30, style: 'inner', highlight: [1, 1, 1], shadow: [0, 0, 0], highlightOpacity: 0.75, shadowOpacity: 0.75 };
    default:
      throw new Error(`unknown effect: ${type}`);
  }
}

/** The declarative field tables the UI generates its panel from. */
export const EFFECT_FIELDS = {
  dropShadow: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Angle', 'angle', 'num', -180, 180, 1], ['Distance', 'distance', 'num', 0, 250, 1],
    ['Spread', 'spread', 'num', 0, 1, 0.01], ['Size', 'size', 'num', 0, 250, 1],
  ],
  innerShadow: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Angle', 'angle', 'num', -180, 180, 1], ['Distance', 'distance', 'num', 0, 250, 1],
    ['Choke', 'choke', 'num', 0, 1, 0.01], ['Size', 'size', 'num', 0, 250, 1],
  ],
  outerGlow: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Spread', 'spread', 'num', 0, 1, 0.01], ['Size', 'size', 'num', 0, 250, 1],
  ],
  innerGlow: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Choke', 'choke', 'num', 0, 1, 0.01], ['Size', 'size', 'num', 0, 250, 1],
    ['Source', 'source', 'sel', ['edge', 'centre']],
  ],
  stroke: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Size', 'size', 'num', 0.5, 100, 0.5],
    ['Position', 'position', 'sel', ['outside', 'centre', 'inside']],
  ],
  colorOverlay: [['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01]],
  gradientOverlay: [
    ['Opacity', 'opacity', 'num', 0, 1, 0.01], ['Angle', 'angle', 'num', -180, 180, 1],
    ['Scale', 'scale', 'num', 0.1, 4, 0.01], ['Reverse', 'reverse', 'bool'],
  ],
  satin: [
    ['Colour', 'color', 'col'], ['Opacity', 'opacity', 'num', 0, 1, 0.01],
    ['Angle', 'angle', 'num', -180, 180, 1], ['Distance', 'distance', 'num', 0, 120, 1],
    ['Size', 'size', 'num', 0, 120, 1], ['Invert', 'invert', 'bool'],
  ],
  bevel: [
    ['Size', 'size', 'num', 1, 100, 1], ['Soften', 'soften', 'num', 0, 16, 0.5],
    ['Depth', 'depth', 'num', 0.05, 4, 0.05], ['Angle', 'angle', 'num', -180, 180, 1],
    ['Altitude', 'altitude', 'num', 0, 90, 1],
    ['Style', 'style', 'sel', ['inner', 'outer', 'emboss', 'pillow']],
    ['Highlight', 'highlight', 'col'], ['Highlight opacity', 'highlightOpacity', 'num', 0, 1, 0.01],
    ['Shadow', 'shadow', 'col'], ['Shadow opacity', 'shadowOpacity', 'num', 0, 1, 0.01],
  ],
};

export const EFFECT_LABELS = {
  dropShadow: 'Drop Shadow', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow',
  innerGlow: 'Inner Glow', stroke: 'Stroke', colorOverlay: 'Colour Overlay',
  gradientOverlay: 'Gradient Overlay', satin: 'Satin', bevel: 'Bevel & Emboss',
};

/**
 * How far outside a rect an effect READS, in pixels.
 *
 * Not how far it draws -- that is a different and smaller number, and using it
 * was a bug. An INNER shadow draws only inside the shape, but it derives from
 * the inverted alpha blurred and offset, so on a sub-rect repaint it reads from
 * well outside. Return the read radius and the compositor grows the rect by it,
 * which is what makes "composite a region" equal "composite the whole thing and
 * cut the region out" -- the property the tiling oracle checks.
 */
export function effectMargin(fx) {
  if (!fx || fx.enabled === false) return 0;
  const d = Math.abs(fx.distance || 0);
  const sz = fx.size || 0;
  const soft = fx.soften || 0;
  switch (fx.type) {
    // A gaussian of sigma = size/3 has radius ceil(3*sigma) = ceil(size).
    case 'dropShadow': return Math.ceil(d + sz + 2);
    case 'innerShadow': return Math.ceil(d + sz + 2);
    case 'outerGlow': return Math.ceil(sz + 2);
    case 'innerGlow': return Math.ceil(sz + 2);
    case 'satin': return Math.ceil(d + sz + 2);
    // The distance field reads across the edge whichever side the stroke is on.
    case 'stroke': return Math.ceil(sz + 2);
    // Distance field, then a blur, then a central difference over the result.
    case 'bevel': return Math.ceil(sz + soft + 3);
    // Per-pixel, and the gradient is anchored in document coordinates.
    case 'colorOverlay': case 'gradientOverlay': return 0;
    default: return 0;
  }
}

export function layerMargin(layer) {
  if (!layer || !layer.effects || !layer.effects.length) return 0;
  let m = 0;
  for (const fx of layer.effects) m = Math.max(m, effectMargin(fx));
  return m;
}

export const hasEffects = (layer) =>
  !!(layer && layer.effects && layer.effects.some((f) => f && f.enabled !== false));

// --------------------------------------------------------------- helpers

/** Pull the alpha channel out of an RGBA buffer. */
function alphaOf(src, n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = src[i * 4 + 3];
  return a;
}

/** Blur a single-channel coverage field. Routed through gaussianBlur so the
 *  shadow and the Gaussian Blur filter agree about what "size 10" means. */
function blurField(field, w, h, sigma) {
  if (sigma <= 0) return field;
  const tmp = new Float32Array(w * h * 4);
  for (let i = 0; i < field.length; i++) {
    tmp[i * 4] = field[i]; tmp[i * 4 + 1] = field[i]; tmp[i * 4 + 2] = field[i]; tmp[i * 4 + 3] = 1;
  }
  gaussianBlur(tmp, w, h, sigma, 'clamp');
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = tmp[i * 4];
  return out;
}

/**
 * Spread/choke: harden the coverage before blurring, by remapping it.
 *
 * Photoshop's Spread is applied BEFORE the blur, which is why a spread of 100%
 * gives a hard-edged shadow at any size rather than a bigger blurry one. Doing
 * it after would just raise the contrast of an already-soft edge.
 */
function applySpread(field, amount) {
  const s = clamp01(amount);
  if (s <= 0) return field;
  // At s = 1 everything above zero becomes solid.
  const k = 1 / Math.max(1e-3, 1 - s);
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = clamp01(field[i] * k);
  return out;
}

/** Offset a field by (dx, dy), with zero outside. */
function offsetField(field, w, h, dx, dy) {
  if (dx === 0 && dy === 0) return field;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = field[sy * w + sx];
    }
  }
  return out;
}

/** Angle in degrees -> a direction in pixels. Screen y is DOWN, so the sine is
 *  negated: 90 degrees points up, as the dial in every editor shows it. */
function polarOffset(angleDeg, distance) {
  const a = (angleDeg * Math.PI) / 180;
  return [Math.round(Math.cos(a) * distance), Math.round(-Math.sin(a) * distance)];
}

/**
 * Where a shadow goes for a light at `angleDeg`: the OPPOSITE way.
 *
 * The angle names the direction the light comes FROM, so a drop shadow is cast
 * away from it -- light from above puts the shadow below. This was the wrong
 * way round at first and the drop shadow looked perfectly fine on its own; it
 * only showed up against the inner shadow, which lit the bottom inside edge
 * from a light above. Two effects disagreeing about one dial is the bug.
 */
function shadowOffset(angleDeg, distance) {
  const [dx, dy] = polarOffset(angleDeg, distance);
  return [-dx, -dy];
}

/** A flat colour at a given coverage field, as an RGBA buffer. */
function colorAt(field, colour, n) {
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[p] = colour[0]; out[p + 1] = colour[1]; out[p + 2] = colour[2];
    out[p + 3] = field[i];
  }
  return out;
}

// --------------------------------------------------------------- effects

function dropShadow(fx, alpha, w, h) {
  const [dx, dy] = shadowOffset(fx.angle, fx.distance);
  let f = applySpread(alpha, fx.spread);
  f = offsetField(f, w, h, dx, dy);
  f = blurField(f, w, h, (fx.size || 0) / 3);
  // The shadow must not show THROUGH the layer -- it is behind it, and where
  // the layer is opaque it is hidden anyway, but a semi-transparent layer
  // would otherwise double up with its own shadow.
  for (let i = 0; i < f.length; i++) f[i] *= 1 - alpha[i];
  return colorAt(f, fx.color, w * h);
}

function outerGlow(fx, alpha, w, h) {
  let f = applySpread(alpha, fx.spread);
  f = blurField(f, w, h, (fx.size || 0) / 3);
  for (let i = 0; i < f.length; i++) f[i] = clamp01(f[i] * (1 - alpha[i]));
  return colorAt(f, fx.color, w * h);
}

function innerShadow(fx, alpha, w, h) {
  const [dx, dy] = shadowOffset(fx.angle, fx.distance);
  // The shadow comes from the OUTSIDE pushed in: invert, offset, blur, then
  // keep only what lands inside the shape.
  let inv = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) inv[i] = 1 - alpha[i];
  inv = applySpread(inv, fx.choke);
  inv = offsetField(inv, w, h, dx, dy);
  inv = blurField(inv, w, h, (fx.size || 0) / 3);
  for (let i = 0; i < inv.length; i++) inv[i] = clamp01(inv[i] * alpha[i]);
  return colorAt(inv, fx.color, w * h);
}

function innerGlow(fx, alpha, w, h) {
  let f;
  if (fx.source === 'centre') {
    // From the middle outwards: the distance INTO the shape, normalised.
    const d = distanceTransform((i) => alpha[i] < 0.5, w, h);
    const size = Math.max(1, fx.size || 1);
    f = new Float32Array(alpha.length);
    for (let i = 0; i < f.length; i++) f[i] = clamp01(d[i] / size) * alpha[i];
  } else {
    let inv = new Float32Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) inv[i] = 1 - alpha[i];
    inv = applySpread(inv, fx.choke);
    f = blurField(inv, w, h, (fx.size || 0) / 3);
    for (let i = 0; i < f.length; i++) f[i] = clamp01(f[i] * alpha[i]);
  }
  return colorAt(f, fx.color, w * h);
}

/**
 * Stroke, from the signed distance field.
 *
 * Doing it from the SDF rather than by dilating and subtracting is what makes
 * a stroke round at a corner and exactly the requested width everywhere --
 * an iterated 3x3 dilation gives a square or a diamond depending on the
 * neighbourhood, and nobody wants either.
 */
function strokeEffect(fx, alpha, w, h) {
  const size = Math.max(0.01, fx.size || 1);
  const sd = signedDistance(alpha, w, h, 0.5);
  const f = new Float32Array(alpha.length);
  let lo, hi;
  if (fx.position === 'inside') { lo = -size; hi = 0; }
  else if (fx.position === 'centre') { lo = -size / 2; hi = size / 2; }
  else { lo = 0; hi = size; }
  for (let i = 0; i < f.length; i++) {
    const d = sd[i];
    // A half-pixel ramp at each end, so the stroke is antialiased.
    f[i] = clamp01(Math.min(d - lo, hi - d) + 0.5);
  }
  return colorAt(f, fx.color, w * h);
}

function colorOverlay(fx, alpha, w, h) {
  const f = new Float32Array(alpha.length);
  for (let i = 0; i < f.length; i++) f[i] = alpha[i];
  return colorAt(f, fx.color, w * h);
}

function gradientOverlay(fx, alpha, w, h, r, box) {
  // Anchored to `box` -- the layer's content bounds -- in DOCUMENT coordinates,
  // and rendered at the rect's absolute position. Both halves matter: anchoring
  // to the rect would slide the gradient every time the viewport repainted a
  // different region, and rendering at a local origin would move the dither
  // pattern, so a tiled composite would differ from a whole one in the last
  // bit. The tiling oracle catches either.
  const b = box && box.w > 0 ? box : r;
  const a = (fx.angle * Math.PI) / 180;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const half = ((Math.abs(Math.cos(a)) * b.w + Math.abs(Math.sin(a)) * b.h) / 2) * (fx.scale || 1);
  const g = renderGradient(r, fx.stops, {
    shape: 'linear',
    x0: cx - Math.cos(a) * half, y0: cy + Math.sin(a) * half,
    x1: cx + Math.cos(a) * half, y1: cy - Math.sin(a) * half,
    reverse: fx.reverse, dither: true,
  });
  for (let i = 0; i < alpha.length; i++) g[i * 4 + 3] = alpha[i];
  return g;
}

/**
 * Satin: the shape blended with two offset copies of itself.
 *
 * It looks arbitrary and it is -- it is a stylistic effect, not a physical
 * one. Two mirrored offsets of the alpha are combined with a difference, which
 * is what produces the folded, cloth-like bands.
 */
function satin(fx, alpha, w, h) {
  const [dx, dy] = polarOffset(fx.angle, fx.distance);
  const a1 = offsetField(alpha, w, h, dx, dy);
  const a2 = offsetField(alpha, w, h, -dx, -dy);
  let f = new Float32Array(alpha.length);
  for (let i = 0; i < f.length; i++) f[i] = Math.abs(a1[i] - a2[i]);
  f = blurField(f, w, h, (fx.size || 0) / 3);
  for (let i = 0; i < f.length; i++) {
    const v = fx.invert ? 1 - f[i] : f[i];
    f[i] = clamp01(v * alpha[i]);
  }
  return colorAt(f, fx.color, w * h);
}

/**
 * Bevel and emboss.
 *
 * A height field from the distance to the edge, smoothed, then lit with a
 * directional light: where the surface tilts towards the light it takes the
 * highlight colour, away from it the shadow colour. The two are returned in
 * ONE buffer because they never overlap -- a pixel is either lit or shaded.
 */
function bevel(fx, alpha, w, h) {
  const size = Math.max(1, fx.size || 1);
  const style = fx.style || 'inner';
  const sd = signedDistance(alpha, w, h, 0.5);
  const height = new Float32Array(alpha.length);
  for (let i = 0; i < height.length; i++) {
    let t;
    if (style === 'outer') t = clamp01(1 - sd[i] / size);
    else if (style === 'emboss') t = clamp01(0.5 - sd[i] / (size * 2));
    else if (style === 'pillow') t = clamp01(1 - Math.abs(sd[i]) / size);
    else t = clamp01(-sd[i] / size);               // inner
    // A quarter-circle profile, so the bevel rolls over instead of ramping
    // linearly into a crease.
    height[i] = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  }
  const smooth = fx.soften > 0 ? blurField(height, w, h, fx.soften / 2) : height;

  const a = (fx.angle * Math.PI) / 180;
  const alt = (fx.altitude * Math.PI) / 180;
  const lx = Math.cos(a) * Math.cos(alt);
  const ly = -Math.sin(a) * Math.cos(alt);
  const depth = fx.depth || 1;

  const out = new Float32Array(alpha.length * 4);
  const at = (x, y) => smooth[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // central differences, scaled by depth
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * depth * 8;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * depth * 8;
      const len = Math.hypot(-gx, -gy, 1) || 1;
      const nx = -gx / len, ny = -gy / len;
      // Only the TANGENTIAL part of the light. Including the nz*lz term is
      // the obvious thing and it is wrong twice over: it leaves a flat
      // interior at lz rather than at zero, so it has to be subtracted back
      // off, and the leftover (nz - 1) * lz is never positive, which biases
      // every steep slope towards shadow. Flipping the light then does NOT
      // swap highlight and shadow -- 58 of 414 lit pixels stayed the same
      // colour -- and altitude 90, straight down the normal, still shaded
      // the edges instead of lighting nothing. Dropping the term makes both
      // exact: flat is neutral, reversing the light negates the result, and
      // cos(altitude) scales the whole effect to nothing overhead.
      const k = (nx * lx + ny * ly) * 2;
      const p = i * 4;
      const inside = style === 'outer' ? 1 - alpha[i] : alpha[i];
      if (k >= 0) {
        out[p] = fx.highlight[0]; out[p + 1] = fx.highlight[1]; out[p + 2] = fx.highlight[2];
        out[p + 3] = clamp01(k) * fx.highlightOpacity * inside;
      } else {
        out[p] = fx.shadow[0]; out[p + 1] = fx.shadow[1]; out[p + 2] = fx.shadow[2];
        out[p + 3] = clamp01(-k) * fx.shadowOpacity * inside;
      }
    }
  }
  return out;
}

const RENDER = {
  dropShadow, outerGlow, innerShadow, innerGlow,
  stroke: strokeEffect, colorOverlay, gradientOverlay, satin, bevel,
};

/**
 * Render a layer's effects over a rect.
 *
 * @param box  the anchor rect for position-dependent effects, in document
 *             coordinates -- the layer's content bounds. Only the gradient
 *             overlay uses it; everything else derives from the alpha and is
 *             translation-equivariant.
 * @returns { below: [{ buf, blend, opacity }], above: [...] } in draw order
 */
export function renderEffects(layer, src, r, box) {
  const out = { below: [], above: [] };
  if (!hasEffects(layer)) return out;
  const n = r.w * r.h;
  const alpha = alphaOf(src, n);

  // Photoshop draws them in a fixed order regardless of the list order, and
  // it matters: a stroke sits over an overlay, a bevel over both.
  const ORDER = ['dropShadow', 'outerGlow', 'gradientOverlay', 'colorOverlay', 'innerShadow', 'innerGlow', 'satin', 'bevel', 'stroke'];
  const sorted = [...layer.effects].filter((f) => f && f.enabled !== false)
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

  for (const fx of sorted) {
    const render = RENDER[fx.type];
    if (!render) continue;
    const full = { ...effectDefaults(fx.type), ...fx };
    const buf = render(full, alpha, r.w, r.h, r, box);
    const where = PLACEMENT[fx.type] === 'both'
      ? (full.position === 'inside' ? 'above' : 'below')
      : PLACEMENT[fx.type];
    out[where].push({ buf, blend: full.blend || 'normal', opacity: clamp01(full.opacity ?? 1), type: fx.type });
  }
  // A stroke drawn below should still sit over the shadow and the glow.
  out.below.sort((a, b) => (a.type === 'stroke' ? 1 : 0) - (b.type === 'stroke' ? 1 : 0));
  return out;
}
