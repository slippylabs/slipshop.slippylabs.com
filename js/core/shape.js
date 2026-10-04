// Shape layers: a path, a fill and a stroke, kept as data.
//
// Same arrangement as a text layer. The SPEC is the truth and the pixels are
// derived, so the path stays editable -- drag an anchor and the layer redraws.
// That is also why this file is pure: it turns a spec into an RGBA buffer and
// knows nothing about surfaces, canvases or history.
//
// The stroke is drawn OVER the fill, and both are composited into the buffer
// rather than added to it, so a semi-transparent stroke over a fill looks the
// way it does everywhere else.

import { clamp01, rect, rectIntersect } from './util.js';
import { fillCoverage, strokeCoverage, pathBounds, DEFAULT_TOLERANCE, CAPS, JOINS } from './path.js';

export function shapeDefaults() {
  return {
    path: { subpaths: [] },
    kind: 'rect',
    params: {},
    fillEnabled: true,
    fill: [0.2, 0.6, 1],
    fillAlpha: 1,
    evenOdd: false,
    strokeEnabled: false,
    stroke: [0, 0, 0],
    strokeAlpha: 1,
    strokeWidth: 3,
    cap: 'round',
    join: 'miter',
    miterLimit: 10,
    dash: null,
    dashPhase: 0,
  };
}

export const SHAPE_STYLE_FIELDS = [
  ['Fill', 'fillEnabled', 'bool'],
  ['Fill colour', 'fill', 'col'],
  ['Fill opacity', 'fillAlpha', 'num', 0, 1, 0.01],
  ['Even-odd fill', 'evenOdd', 'bool'],
  ['Stroke', 'strokeEnabled', 'bool'],
  ['Stroke colour', 'stroke', 'col'],
  ['Stroke opacity', 'strokeAlpha', 'num', 0, 1, 0.01],
  ['Stroke width', 'strokeWidth', 'num', 0.25, 200, 0.25],
  ['Cap', 'cap', 'sel', CAPS],
  ['Join', 'join', 'sel', JOINS],
  ['Mitre limit', 'miterLimit', 'num', 1, 20, 0.1],
];

/**
 * The document rect a shape will occupy.
 *
 * Grown by half the stroke width times the MITRE LIMIT, not just by half the
 * stroke width: a mitred join at a sharp angle reaches out along the bisector
 * by width/2 divided by the cosine of the half-angle, and the limit is exactly
 * the cap on that ratio. Growing by half the width alone clips the spikes off
 * a stroked star, which is the shape most likely to have them.
 */
export function shapeBounds(shape, tol = DEFAULT_TOLERANCE) {
  const s = { ...shapeDefaults(), ...shape };
  const b = pathBounds(s.path, tol);
  let pad = 1;
  if (s.strokeEnabled && s.strokeWidth > 0) {
    const h = s.strokeWidth / 2;
    pad += s.join === 'miter' ? h * Math.max(1, s.miterLimit) : h;
  }
  return rect(
    Math.floor(b.x - pad), Math.floor(b.y - pad),
    Math.ceil(b.w + pad * 2) + 1, Math.ceil(b.h + pad * 2) + 1,
  );
}

/** Composite a flat colour at the given coverage onto an RGBA buffer. */
function paint(dst, r, cov, cr, colour, alpha) {
  for (let y = 0; y < r.h; y++) {
    const sy = r.y + y - cr.y;
    if (sy < 0 || sy >= cr.h) continue;
    for (let x = 0; x < r.w; x++) {
      const sx = r.x + x - cr.x;
      if (sx < 0 || sx >= cr.w) continue;
      const a = clamp01(cov[sy * cr.w + sx]) * alpha;
      if (a <= 0) continue;
      const p = (y * r.w + x) * 4;
      const ab = dst[p + 3];
      const ao = a + ab * (1 - a);
      for (let c = 0; c < 3; c++) {
        dst[p + c] = (colour[c] * a + dst[p + c] * ab * (1 - a)) / ao;
      }
      dst[p + 3] = ao;
    }
  }
}

/** Render a shape spec into a straight-alpha RGBA buffer over `r`. */
export function renderShape(shape, r, { tol = DEFAULT_TOLERANCE, antialias = true } = {}) {
  const s = { ...shapeDefaults(), ...shape };
  const out = new Float32Array(r.w * r.h * 4);
  if (!s.path || !s.path.subpaths || !s.path.subpaths.length) return out;
  if (s.fillEnabled && s.fillAlpha > 0) {
    const f = fillCoverage(s.path, { tol, evenOdd: s.evenOdd, antialias });
    if (f.cov.length) paint(out, r, f.cov, f.r, s.fill, s.fillAlpha);
  }
  if (s.strokeEnabled && s.strokeAlpha > 0 && s.strokeWidth > 0) {
    const k = strokeCoverage(s.path, {
      width: s.strokeWidth, cap: s.cap, join: s.join, miterLimit: s.miterLimit,
      dash: s.dash, dashPhase: s.dashPhase, tol, antialias,
    });
    if (k.cov.length) paint(out, r, k.cov, k.r, s.stroke, s.strokeAlpha);
  }
  return out;
}
