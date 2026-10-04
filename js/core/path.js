// Bezier paths: the pen tool, shape layers, path <-> selection.
//
// A path is a list of SUBPATHS; a subpath is a list of anchors and a closed
// flag. Each anchor carries its two handles in ABSOLUTE document coordinates,
// not as offsets:
//
//   { x, y, inX, inY, outX, outY }
//
// Absolute because every operation here is geometric -- transform, flatten,
// measure, hit-test -- and relative handles would need converting at the top
// of each one. The cost is that moving an anchor must move its handles too,
// which is one line in the editor and is also what the user expects.
//
// Everything else in this file falls out of ONE primitive: flatten the curves
// to polylines. Filling is a scanline over those polylines; stroking builds an
// outline out of them; length, bounds and hit-testing measure them. That is
// why the flattener's tolerance is the only accuracy knob in the file.
//
// Stroking deserves a note, because there are two ways to do it and only one
// of them gives real joins. Taking the distance to the polyline and
// thresholding it is three lines and produces a perfect ROUND join and cap --
// and can never produce a mitre, a bevel or a butt end, because those are not
// functions of distance. So a stroke here is an OUTLINE: a quad per segment,
// a wedge per join, a shape per cap, all wound the same way, unioned by the
// non-zero winding rule the scanline already implements.

import { clamp, clamp01, TAU } from './util.js';
import { polygonsCoverage, signedArea } from './select.js';
import { rect } from './util.js';

export const DEFAULT_TOLERANCE = 0.1;      // pixels of flatness
export const CAPS = ['butt', 'round', 'square'];
export const JOINS = ['miter', 'round', 'bevel'];

export function newPath() { return { subpaths: [] }; }

export function anchor(x, y, inX = x, inY = y, outX = x, outY = y) {
  return { x, y, inX, inY, outX, outY };
}

/** A straight-sided subpath from a point list. Handles sit on the anchors, so
 *  every segment is a degenerate cubic and the flattener returns the corners
 *  exactly -- no special case for "it is actually a polygon". */
export function subpathFromPoints(points, closed = true) {
  return { closed, anchors: points.map(([x, y]) => anchor(x, y)) };
}

export function pathFromPoints(points, closed = true) {
  return { subpaths: [subpathFromPoints(points, closed)] };
}

export function clonePath(path) {
  return {
    subpaths: (path.subpaths || []).map((sp) => ({
      closed: !!sp.closed,
      anchors: sp.anchors.map((a) => ({ ...a })),
    })),
  };
}

export function countAnchors(path) {
  return (path.subpaths || []).reduce((n, sp) => n + sp.anchors.length, 0);
}

// ------------------------------------------------------------------- cubics

export function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

export function cubicTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = -3 * u * u, b = 3 * u * u - 6 * u * t, c = 6 * u * t - 3 * t * t, d = 3 * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/**
 * How far a cubic's control points stray from the chord.
 *
 * The standard conservative flatness measure: the maximum distance from
 * either control point to the line p0-p3 bounds the curve's own deviation,
 * because a Bezier lies inside the convex hull of its control points.
 */
function flatness(p0, p1, p2, p3) {
  const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) {
    return Math.max(
      Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
      Math.hypot(p2[0] - p0[0], p2[1] - p0[1]),
    );
  }
  const d1 = Math.abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / len;
  const d2 = Math.abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / len;
  return Math.max(d1, d2);
}

/**
 * Append the flattened cubic to `out`, excluding p0 and including p3.
 *
 * The depth cap is 12, chosen rather than guessed. Subdividing at the midpoint
 * roughly quarters the flatness each level, so a curve starting at flatness F
 * converges in about log4(F / tol) levels: the worst case anything here asks
 * for is a 2000px arc at a tolerance of 0.001, which is 10.5. Twelve leaves
 * margin and still bounds a curve to 4096 segments.
 *
 * The cap matters because it is the only thing standing between a flatness
 * measure that does NOT shrink and a locked tab. A control that replaced the
 * de Casteljau midpoint with the chord midpoint did exactly that, and against
 * the old cap of 18 -- 262,144 segments per curve -- the oracle ran for half
 * an hour before anyone noticed. A malformed SVG could do the same.
 */
function flattenCubic(out, p0, p1, p2, p3, tol, depth = 0) {
  if (depth >= 12 || flatness(p0, p1, p2, p3) <= tol) {
    out.push([p3[0], p3[1]]);
    return;
  }
  // de Casteljau at the midpoint. Subdividing at the midpoint rather than
  // stepping t uniformly is what makes the point count follow the curvature:
  // a near-straight segment costs two points however long it is.
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3);
  const p012 = m(p01, p12), p123 = m(p12, p23);
  const mid = m(p012, p123);
  flattenCubic(out, p0, p01, p012, mid, tol, depth + 1);
  flattenCubic(out, mid, p123, p23, p3, tol, depth + 1);
}

/** A subpath as a polyline. Closed subpaths do NOT repeat the first point --
 *  the scanline wraps, and a duplicated vertex is a zero-length edge. */
export function flattenSubpath(sp, tol = DEFAULT_TOLERANCE) {
  const a = sp.anchors;
  if (!a.length) return [];
  if (a.length === 1) return [[a[0].x, a[0].y]];
  const out = [[a[0].x, a[0].y]];
  const n = sp.closed ? a.length : a.length - 1;
  for (let i = 0; i < n; i++) {
    const c = a[i], d = a[(i + 1) % a.length];
    flattenCubic(out, [c.x, c.y], [c.outX, c.outY], [d.inX, d.inY], [d.x, d.y], tol);
  }
  if (sp.closed) out.pop();                 // the wrap point
  return out;
}

export function flattenPath(path, tol = DEFAULT_TOLERANCE) {
  return (path.subpaths || []).map((sp) => flattenSubpath(sp, tol)).filter((p) => p.length);
}

export function pathBounds(path, tol = DEFAULT_TOLERANCE) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of flattenPath(path, tol)) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return rect(0, 0, 0, 0);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pathLength(path, tol = DEFAULT_TOLERANCE) {
  let total = 0;
  (path.subpaths || []).forEach((sp) => {
    const ring = flattenSubpath(sp, tol);
    const n = ring.length;
    const last = sp.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  });
  return total;
}

/** The signed area a path encloses. Positive and negative subpaths cancel,
 *  which is what makes a hole a hole. */
export function pathArea(path, tol = DEFAULT_TOLERANCE) {
  let a = 0;
  for (const ring of flattenPath(path, tol)) a += signedArea(ring);
  return a;
}

// --------------------------------------------------------------------- fill

/** Antialiased coverage for the path's interior. */
export function fillCoverage(path, { tol = DEFAULT_TOLERANCE, evenOdd = false, antialias = true } = {}) {
  // An OPEN subpath still fills, with its ends joined -- the same thing every
  // renderer does, and the same thing the pen tool shows you while you draw.
  return polygonsCoverage(flattenPath(path, tol), { evenOdd, antialias });
}

// ------------------------------------------------------------------- stroke

/** Make a ring wind positive, so a set of them unions under non-zero. */
function orient(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

function circleRing(cx, cy, r, steps) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return orient(out);
}

/** Enough segments that a circle of radius r is within `tol` of round. */
function circleSteps(r, tol) {
  if (r <= tol) return 4;
  // sagitta of a chord subtending angle th is r(1 - cos(th/2))
  const th = 2 * Math.acos(clamp(1 - tol / r, -1, 1));
  return clamp(Math.ceil(TAU / th), 6, 256);
}

/**
 * Split a polyline into the "on" runs of a dash pattern.
 *
 * The phase carries ACROSS segments, which is the whole point: a dash that
 * restarted at every vertex would make the pattern depend on how finely the
 * curve happened to be flattened.
 */
export function dashPolyline(ring, closed, dash, phase = 0) {
  const pat = (dash || []).filter((d) => d >= 0);
  if (!pat.length || pat.every((d) => d === 0)) return [{ pts: ring, closed }];
  const total = pat.reduce((a, b) => a + b, 0);
  let idx = 0;
  let left = pat[0];
  let on = true;
  // Wind the phase forward through the pattern.
  let ph = ((phase % total) + total) % total;
  while (ph > 0) {
    if (ph < left) { left -= ph; ph = 0; }
    else { ph -= left; idx = (idx + 1) % pat.length; left = pat[idx]; on = !on; }
  }
  const runs = [];
  let cur = on ? [ring[0]] : null;
  const n = ring.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    let a = ring[i];
    const b = ring[(i + 1) % n];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (seg > 1e-12) {
      if (left <= 0) { idx = (idx + 1) % pat.length; left = pat[idx]; on = !on; if (on) cur = [a]; else { if (cur && cur.length > 1) runs.push({ pts: cur, closed: false }); cur = null; } continue; }
      const take = Math.min(seg, left);
      const t = take / seg;
      const nx = a[0] + (b[0] - a[0]) * t, ny = a[1] + (b[1] - a[1]) * t;
      if (on && cur) cur.push([nx, ny]);
      a = [nx, ny];
      seg -= take;
      left -= take;
    }
  }
  if (cur && cur.length > 1) runs.push({ pts: cur, closed: false });
  return runs;
}

/**
 * Build the stroke's outline as a set of positively-wound rings.
 *
 * One quad per segment, one wedge per join, one shape per cap. Overlaps are
 * fine and expected -- the non-zero winding rule unions them -- which is what
 * keeps this simple enough to be correct: there is no polygon clipping here.
 */
export function strokeOutline(path, {
  width = 1, cap = 'round', join = 'miter', miterLimit = 10,
  tol = DEFAULT_TOLERANCE, dash = null, dashPhase = 0,
} = {}) {
  const h = Math.max(1e-6, width / 2);
  const rings = [];
  const steps = circleSteps(h, tol);

  const runs = [];
  (path.subpaths || []).forEach((sp) => {
    const ring = flattenSubpath(sp, tol);
    if (ring.length < 2) {
      // A lone anchor strokes to a dot with a round or square cap, and to
      // nothing at all with a butt one -- which is what zero length means.
      if (ring.length === 1 && cap === 'round') rings.push(circleRing(ring[0][0], ring[0][1], h, steps));
      else if (ring.length === 1 && cap === 'square') {
        const [x, y] = ring[0];
        rings.push(orient([[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]));
      }
      return;
    }
    for (const r of dashPolyline(ring, sp.closed, dash, dashPhase)) runs.push(r);
  });

  for (const run of runs) {
    const pts = run.pts;
    const n = pts.length;
    const segs = run.closed ? n : n - 1;
    const dirs = [];
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) { dirs.push(null); continue; }
      dirs.push([dx / len, dy / len]);
      const nx = -dy / len * h, ny = dx / len * h;
      rings.push(orient([
        [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
      ]));
    }

    // Joins at every interior vertex (and at the wrap, for a closed run).
    const joints = run.closed ? segs : segs - 1;
    for (let k = 0; k < joints; k++) {
      const d0 = dirs[k], d1 = dirs[(k + 1) % segs];
      if (!d0 || !d1) continue;
      const P = pts[(k + 1) % n];
      if (join === 'round') { rings.push(circleRing(P[0], P[1], h, steps)); continue; }
      const cross = d0[0] * d1[1] - d0[1] * d1[0];
      if (Math.abs(cross) < 1e-12) continue;        // straight through
      // The OUTER side is the one the turn opens away from.
      const s = cross > 0 ? -1 : 1;
      const a = [P[0] + s * -d0[1] * h, P[1] + s * d0[0] * h];
      const b = [P[0] + s * -d1[1] * h, P[1] + s * d1[0] * h];
      if (join === 'bevel') { rings.push(orient([P, a, b])); continue; }
      // Mitre: the two offset lines meet at a distance h / cos(theta/2) from
      // the vertex along the bisector. Past the limit it must fall back to a
      // bevel, or a near-reversal shoots a spike across the canvas.
      const bx = d1[0] - d0[0], by = d1[1] - d0[1];
      const bl = Math.hypot(bx, by);
      if (bl < 1e-12) continue;
      const dot = clamp(d0[0] * d1[0] + d0[1] * d1[1], -1, 1);
      const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
      if (cosHalf < 1e-9 || 1 / cosHalf > miterLimit) { rings.push(orient([P, a, b])); continue; }
      const mlen = h / cosHalf;
      // The bisector of the OUTER angle points opposite the turn.
      const ux = (a[0] - P[0] + b[0] - P[0]), uy = (a[1] - P[1] + b[1] - P[1]);
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-12) continue;
      const M = [P[0] + (ux / ul) * mlen, P[1] + (uy / ul) * mlen];
      rings.push(orient([P, a, M, b]));
    }

    if (run.closed) continue;
    for (const [idx, dir, sign] of [[0, dirs[0], -1], [n - 1, dirs[segs - 1], 1]]) {
      if (!dir) continue;
      const [x, y] = pts[idx];
      if (cap === 'round') rings.push(circleRing(x, y, h, steps));
      else if (cap === 'square') {
        const ex = x + dir[0] * h * sign, ey = y + dir[1] * h * sign;
        const nx = -dir[1] * h, ny = dir[0] * h;
        rings.push(orient([[x + nx, y + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [x - nx, y - ny]]));
      }
    }
  }
  return rings;
}

export function strokeCoverage(path, opts = {}) {
  const rings = strokeOutline(path, opts);
  return polygonsCoverage(rings, { antialias: opts.antialias !== false, evenOdd: false });
}

// ------------------------------------------------------------------ shapes

export const SHAPES = ['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line', 'arrow'];

/** 4/3 * (sqrt(2) - 1): the handle length that puts a cubic quarter-arc
 *  within 0.027% of a true circle. Worth stating, because it looks arbitrary
 *  and is not -- it is the value that makes the curve pass through the
 *  45-degree point exactly. */
export const KAPPA = 0.5522847498307936;

export function shapePath(kind, box, params = {}) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2;
  const rx = w / 2, ry = h / 2;
  switch (kind) {
    case 'rect':
      return pathFromPoints([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    case 'roundRect': {
      const r = Math.min(params.radius === undefined ? 12 : params.radius, Math.abs(w) / 2, Math.abs(h) / 2);
      if (r <= 0) return shapePath('rect', box);
      const k = r * KAPPA;
      const a = [];
      const push = (px, py, ix, iy, ox, oy) => a.push({ x: px, y: py, inX: ix, inY: iy, outX: ox, outY: oy });
      push(x + r, y, x + r - k, y, x + r, y);   // in = end of the top-left arc
      push(x + w - r, y, x + w - r, y, x + w - r + k, y);
      push(x + w, y + r, x + w, y + r - k, x + w, y + r);
      push(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k);
      push(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h);
      push(x + r, y + h, x + r, y + h, x + r - k, y + h);
      push(x, y + h - r, x, y + h - r + k, x, y + h - r);
      push(x, y + r, x, y + r, x, y + r - k);
      return { subpaths: [{ closed: true, anchors: a }] };
    }
    case 'ellipse': {
      const kx = rx * KAPPA, ky = ry * KAPPA;
      return {
        subpaths: [{
          closed: true,
          anchors: [
            { x: cx, y: y, inX: cx - kx, inY: y, outX: cx + kx, outY: y },
            { x: x + w, y: cy, inX: x + w, inY: cy - ky, outX: x + w, outY: cy + ky },
            { x: cx, y: y + h, inX: cx + kx, inY: y + h, outX: cx - kx, outY: y + h },
            { x: x, y: cy, inX: x, inY: cy + ky, outX: x, outY: cy - ky },
          ],
        }],
      };
    }
    case 'polygon': {
      const sides = Math.max(3, Math.round(params.sides === undefined ? 6 : params.sides));
      const rot = (params.rotation || 0) - Math.PI / 2;
      const pts = [];
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * TAU;
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      return pathFromPoints(pts, true);
    }
    case 'star': {
      const points = Math.max(3, Math.round(params.points === undefined ? 5 : params.points));
      const inner = params.innerRatio === undefined ? 0.5 : clamp01(params.innerRatio);
      const rot = (params.rotation || 0) - Math.PI / 2;
      const pts = [];
      for (let i = 0; i < points * 2; i++) {
        const a = rot + (i / (points * 2)) * TAU;
        const k = i % 2 ? inner : 1;
        pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
      }
      return pathFromPoints(pts, true);
    }
    case 'line':
      return pathFromPoints([[x, y], [x + w, y + h]], false);
    case 'arrow': {
      // An open polyline: the head is two more points, so stroking it gives a
      // consistent line weight throughout instead of a filled triangle that
      // has to be sized separately.
      const head = Math.max(4, Math.min(Math.hypot(w, h) * 0.3, params.head || 18));
      const ang = Math.atan2(h, w);
      const tipX = x + w, tipY = y + h;
      const wing = (s) => [
        tipX - Math.cos(ang + s * 0.5) * head,
        tipY - Math.sin(ang + s * 0.5) * head,
      ];
      return {
        subpaths: [
          subpathFromPoints([[x, y], [tipX, tipY]], false),
          subpathFromPoints([wing(1), [tipX, tipY], wing(-1)], false),
        ],
      };
    }
    default:
      throw new Error(`unknown shape: ${kind}`);
  }
}

export const SHAPE_FIELDS = {
  roundRect: [['Corner radius', 'radius', 'num', 0, 200, 1]],
  polygon: [['Sides', 'sides', 'num', 3, 24, 1]],
  star: [['Points', 'points', 'num', 3, 24, 1], ['Inner radius', 'innerRatio', 'num', 0.05, 0.95, 0.01]],
  arrow: [['Head', 'head', 'num', 4, 80, 1]],
};

// -------------------------------------------------------------- transform

/** Apply a 2x3 affine [a, b, c, d, e, f] to every point AND handle. */
export function transformPath(path, m) {
  const [a, b, c, d, e, f] = m;
  const t = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  return {
    subpaths: (path.subpaths || []).map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((p) => {
        const [x, y] = t(p.x, p.y);
        const [ix, iy] = t(p.inX, p.inY);
        const [ox, oy] = t(p.outX, p.outY);
        return { x, y, inX: ix, inY: iy, outX: ox, outY: oy };
      }),
    })),
  };
}

/** Reverse every subpath's direction, swapping each anchor's handles -- which
 *  is the half that is easy to forget and turns every curve inside out. */
export function reversePath(path) {
  return {
    subpaths: (path.subpaths || []).map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.slice().reverse().map((p) => ({
        x: p.x, y: p.y, inX: p.outX, inY: p.outY, outX: p.inX, outY: p.inY,
      })),
    })),
  };
}

// ---------------------------------------------------------- selection <-> path

/**
 * A path from the crack contours of a selection mask.
 *
 * The contours are axis-aligned staircases -- that is what a pixel boundary
 * is -- so the path is straight-sided and re-rasterising it reproduces the
 * mask exactly. Smoothing it into curves would be a different and lossy
 * operation, and it belongs behind its own menu item, not inside this one.
 */
export function pathFromContours(contours) {
  return {
    subpaths: (contours || [])
      .filter((c) => c && c.length >= 3)
      .map((c) => subpathFromPoints(c.map((p) => (Array.isArray(p) ? p : [p.x, p.y])), true)),
  };
}

// ------------------------------------------------------------------- SVG

/** The `d` attribute for a path. Cubics throughout, so no segment type is
 *  special-cased on the way out or the way back in. */
export function pathToSvg(path, precision = 4) {
  const f = (v) => {
    const s = v.toFixed(precision);
    return s.replace(/\.?0+$/, '') || '0';
  };
  const parts = [];
  for (const sp of path.subpaths || []) {
    const a = sp.anchors;
    if (!a.length) continue;
    parts.push(`M ${f(a[0].x)} ${f(a[0].y)}`);
    const n = sp.closed ? a.length : a.length - 1;
    for (let i = 0; i < n; i++) {
      const c = a[i], d = a[(i + 1) % a.length];
      parts.push(`C ${f(c.outX)} ${f(c.outY)} ${f(d.inX)} ${f(d.inY)} ${f(d.x)} ${f(d.y)}`);
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join(' ');
}

/**
 * Parse an SVG `d` string.
 *
 * Handles M m L l H h V v C c S s Q q T t Z z -- the whole set bar arcs, which
 * need the endpoint-to-centre conversion and are not produced here. Quadratics
 * and the shorthand forms are converted to cubics on the way in, so the rest
 * of the file only ever sees one segment type.
 */
export function parseSvgPath(d) {
  const toks = String(d).match(/[MmLlHhVvCcSsQqTtZzAa]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const subpaths = [];
  let sp = null;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let prevCtrl = null;          // the last cubic's second control point
  let prevQCtrl = null;
  let cmd = null;
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  /**
   * Are the next k tokens numbers?
   *
   * Without this, a `d` string that is not one -- "nonsense" tokenises to two
   * bare `s` commands -- ran the smooth-cubic case with nothing to read and
   * built anchors full of NaN. A path with NaN coordinates does not throw; it
   * silently rasterises to nothing, which is a much worse failure than
   * refusing the string.
   */
  const have = (k) => {
    if (i + k > toks.length) return false;
    for (let j = 0; j < k; j++) if (/[A-Za-z]/.test(toks[i + j])) return false;
    return true;
  };
  const push = (x, y) => {
    if (!sp) { sp = { closed: false, anchors: [] }; subpaths.push(sp); }
    sp.anchors.push(anchor(x, y));
  };
  const curveTo = (c1x, c1y, c2x, c2y, x, y) => {
    if (!sp || !sp.anchors.length) push(cx, cy);
    const last = sp.anchors[sp.anchors.length - 1];
    last.outX = c1x; last.outY = c1y;
    sp.anchors.push({ x, y, inX: c2x, inY: c2y, outX: x, outY: y });
  };
  while (i < toks.length) {
    const t = toks[i];
    if (/[A-Za-z]/.test(t)) { cmd = t; i++; }
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    const head = cmd.toUpperCase();
    const NEED = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0, A: 7 };
    if (head !== 'Z' && !have(NEED[head] || 0)) break;
    switch (head) {
      case 'M': {
        const x = num() + ox, y = num() + oy;
        sp = { closed: false, anchors: [] };
        subpaths.push(sp);
        push(x, y);
        cx = startX = x; cy = startY = y;
        prevCtrl = prevQCtrl = null;
        // A repeated coordinate pair after M is an implicit L.
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { const x = num() + ox, y = num() + oy; curveTo(cx, cy, x, y, x, y); cx = x; cy = y; prevCtrl = prevQCtrl = null; break; }
      case 'H': { const x = num() + ox; curveTo(cx, cy, x, cy, x, cy); cx = x; prevCtrl = prevQCtrl = null; break; }
      case 'V': { const y = num() + oy; curveTo(cx, cy, cx, y, cx, y); cy = y; prevCtrl = prevQCtrl = null; break; }
      case 'C': {
        const c1x = num() + ox, c1y = num() + oy, c2x = num() + ox, c2y = num() + oy, x = num() + ox, y = num() + oy;
        curveTo(c1x, c1y, c2x, c2y, x, y);
        cx = x; cy = y; prevCtrl = [c2x, c2y]; prevQCtrl = null;
        break;
      }
      case 'S': {
        const c2x = num() + ox, c2y = num() + oy, x = num() + ox, y = num() + oy;
        const c1 = prevCtrl ? [2 * cx - prevCtrl[0], 2 * cy - prevCtrl[1]] : [cx, cy];
        curveTo(c1[0], c1[1], c2x, c2y, x, y);
        cx = x; cy = y; prevCtrl = [c2x, c2y]; prevQCtrl = null;
        break;
      }
      case 'Q': {
        const qx = num() + ox, qy = num() + oy, x = num() + ox, y = num() + oy;
        // A quadratic is the cubic with its controls a third of the way out.
        curveTo(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        prevQCtrl = [qx, qy]; prevCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'T': {
        const x = num() + ox, y = num() + oy;
        const q = prevQCtrl ? [2 * cx - prevQCtrl[0], 2 * cy - prevQCtrl[1]] : [cx, cy];
        curveTo(cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy),
          x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), x, y);
        prevQCtrl = q; prevCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'Z': {
        if (sp) {
          sp.closed = true;
          // A Z after an explicit line back to the start leaves a duplicate
          // anchor on top of the first one, which is a zero-length segment
          // every join and cap then has to cope with.
          const a = sp.anchors;
          if (a.length > 1) {
            const f0 = a[0], l0 = a[a.length - 1];
            if (Math.abs(f0.x - l0.x) < 1e-9 && Math.abs(f0.y - l0.y) < 1e-9) {
              f0.inX = l0.inX; f0.inY = l0.inY;
              a.pop();
            }
          }
        }
        cx = startX; cy = startY;
        sp = null;
        prevCtrl = prevQCtrl = null;
        break;
      }
      case 'A': {
        // Arcs are not produced here and converting them properly needs the
        // endpoint-to-centre parameterisation; skip the seven parameters
        // rather than mis-draw them.
        num(); num(); num(); num(); num();
        const x = num() + ox, y = num() + oy;
        curveTo(cx, cy, x, y, x, y);
        cx = x; cy = y;
        break;
      }
      default: i++; break;
    }
  }
  return { subpaths: subpaths.filter((s) => s.anchors.length) };
}

export function pathToSvgDocument(path, w, h, { fill = 'none', stroke = '#000', width = 1 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<path d="${pathToSvg(path)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/></svg>`;
}

// ---------------------------------------------------------------- hit test

/** The nearest point on the path to (x, y), for clicking on a path. */
export function nearestOnPath(path, x, y, tol = DEFAULT_TOLERANCE) {
  let best = { dist: Infinity, x: 0, y: 0, subpath: -1 };
  (path.subpaths || []).forEach((sp, si) => {
    const ring = flattenSubpath(sp, tol);
    const n = ring.length;
    const last = sp.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp01(((x - a[0]) * dx + (y - a[1]) * dy) / len2) : 0;
      const px = a[0] + dx * t, py = a[1] + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best.dist) best = { dist: d, x: px, y: py, subpath: si };
    }
  });
  return best;
}

/**
 * Insert an anchor on the segment nearest (x, y).
 *
 * Splitting the cubic at the right t with de Casteljau, NOT dropping a corner
 * point on the flattened polyline: de Casteljau gives the two halves of the
 * SAME curve, so the shape does not change at all when an anchor is added.
 * Inserting a corner instead leaves a visible kink, which is exactly what the
 * user did not ask for.
 *
 * @returns a new path, or null if nothing was near enough.
 */
export function insertAnchorNear(path, x, y, reach = 6, tol = DEFAULT_TOLERANCE) {
  let best = null;
  (path.subpaths || []).forEach((sp, si) => {
    const a = sp.anchors;
    const segs = sp.closed ? a.length : a.length - 1;
    for (let i = 0; i < segs; i++) {
      const c = a[i], d = a[(i + 1) % a.length];
      const p0 = [c.x, c.y], p1 = [c.outX, c.outY], p2 = [d.inX, d.inY], p3 = [d.x, d.y];
      // A coarse t sweep then a local refine: the segment is short and the
      // only thing being decided is where to split, so 64 + 12 samples is
      // plenty and much simpler than solving the fifth-degree distance.
      let bt = 0, bd = Infinity;
      for (let k = 0; k <= 64; k++) {
        const t = k / 64;
        const q = cubicPoint(p0, p1, p2, p3, t);
        const dd = Math.hypot(q[0] - x, q[1] - y);
        if (dd < bd) { bd = dd; bt = t; }
      }
      let step = 1 / 64;
      for (let k = 0; k < 12; k++) {
        step /= 2;
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const q = cubicPoint(p0, p1, p2, p3, t);
          const dd = Math.hypot(q[0] - x, q[1] - y);
          if (dd < bd) { bd = dd; bt = t; }
        }
      }
      if (bd < reach && (!best || bd < best.d)) best = { d: bd, si, i, t: bt, p0, p1, p2, p3 };
    }
  });
  if (!best) return null;

  const { si, i, t, p0, p1, p2, p3 } = best;
  const lerpP = (u, v) => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t];
  const q0 = lerpP(p0, p1), q1 = lerpP(p1, p2), q2 = lerpP(p2, p3);
  const r0 = lerpP(q0, q1), r1 = lerpP(q1, q2);
  const mid = lerpP(r0, r1);

  const out = clonePath(path);
  const a = out.subpaths[si].anchors;
  const left = a[i], right = a[(i + 1) % a.length];
  left.outX = q0[0]; left.outY = q0[1];
  right.inX = q2[0]; right.inY = q2[1];
  a.splice(i + 1, 0, {
    x: mid[0], y: mid[1],
    inX: r0[0], inY: r0[1], outX: r1[0], outY: r1[1],
  });
  return out;
}

/** Remove an anchor, leaving the rest of the path alone. A subpath of fewer
 *  than two anchors is dropped: one anchor is a dot, and no anchors is
 *  nothing, but keeping an empty subpath around is just a thing every loop
 *  then has to skip. */
export function removeAnchor(path, si, ai) {
  const out = clonePath(path);
  const sp = out.subpaths[si];
  if (!sp) return out;
  sp.anchors.splice(ai, 1);
  if (sp.anchors.length < 1) out.subpaths.splice(si, 1);
  return out;
}
