// Selections.
//
// A selection is an 8-bit COVERAGE MASK over the whole document, stored in the
// same tiled Surface as everything else. That one decision buys most of the
// feature list for free: feathering is a blur of the mask, antialiasing is
// just a coverage between 0 and 1, "Select > Modify" is arithmetic on it, and
// a selection can be saved as a channel or loaded from one without conversion.
//
// A path-based selection would be smaller and would make feathering, the magic
// wand and quick-select into three unrelated problems.

import { Surface } from './tiles.js';
import { rect, rectIntersect, rectUnion, rectEmpty, clamp, clamp01, round } from './util.js';
import { gaussianBlur } from './convolve.js';
import { signedDistance, distanceTransform } from './distance.js';
import { rgbToLab, deltaE2000 } from './color.js';

export const COMBINE = ['new', 'add', 'subtract', 'intersect', 'xor'];

/** Combine two coverage values. */
export function combineValue(mode, existing, incoming) {
  switch (mode) {
    case 'add': return Math.max(existing, incoming);
    case 'subtract': return Math.min(existing, 1 - incoming);
    case 'intersect': return Math.min(existing, incoming);
    case 'xor': return Math.abs(existing - incoming);
    case 'new':
    default: return incoming;
  }
}

/**
 * Write a coverage buffer into a selection with a combine mode.
 *
 * 'new' is the awkward one: it must clear everything OUTSIDE the incoming
 * rect too, or a new rectangular selection would leave the previous one
 * showing wherever the new rect does not reach.
 */
export function applyCoverage(sel, r, cov, mode = 'new') {
  if (mode === 'new') {
    sel.tiles.clear();
    const c = rectIntersect(r, sel.bounds);
    if (!rectEmpty(c)) {
      const sub = cropCoverage(cov, r, c);
      sel.writeRect(c, sub);
    }
    return sel;
  }
  const c = rectIntersect(r, sel.bounds);
  if (rectEmpty(c)) {
    // Subtract and intersect against nothing still have an effect on the rest
    // of the selection for 'intersect' -- everything outside the incoming
    // shape must go.
    if (mode === 'intersect') sel.tiles.clear();
    return sel;
  }
  if (mode === 'intersect') {
    // Clear outside the incoming rect first, then intersect inside it.
    const keep = sel.readRect(c);
    sel.tiles.clear();
    const sub = cropCoverage(cov, r, c);
    for (let i = 0; i < keep.length; i++) keep[i] = Math.min(keep[i], sub[i]);
    sel.writeRect(c, keep);
    return sel;
  }
  const cur = sel.readRect(c);
  const sub = cropCoverage(cov, r, c);
  for (let i = 0; i < cur.length; i++) cur[i] = clamp01(combineValue(mode, cur[i], sub[i]));
  sel.writeRect(c, cur);
  return sel;
}

function cropCoverage(cov, from, to) {
  if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return cov;
  const out = new Float32Array(to.w * to.h);
  for (let y = 0; y < to.h; y++) {
    const sy = to.y + y - from.y;
    for (let x = 0; x < to.w; x++) {
      const sx = to.x + x - from.x;
      if (sx < 0 || sy < 0 || sx >= from.w || sy >= from.h) continue;
      out[y * to.w + x] = cov[sy * from.w + sx];
    }
  }
  return out;
}

export function newSelection(doc) { return new Surface(doc.w, doc.h, 1, 8); }

/** Everything selected. A null selection means the same thing and is cheaper,
 *  so the engine treats null as "all" and this is only for when a real mask
 *  is needed (saving to a channel, say). */
export function selectAll(doc) {
  const s = newSelection(doc);
  s.fill([1]);
  return s;
}

export function invertSelection(sel) {
  const r = sel.bounds;
  const buf = sel.readRect(r);
  for (let i = 0; i < buf.length; i++) buf[i] = 1 - buf[i];
  sel.writeRect(r, buf);
  return sel;
}

/** The tight bounds of anything selected, or an empty rect. */
export function selectionBounds(sel) {
  return sel ? sel.contentBounds() : null;
}

export function isEmptySelection(sel) {
  if (!sel) return false;                 // null means "all"
  return rectEmpty(sel.contentBounds());
}

// ------------------------------------------------------------- primitives

/**
 * Analytic coverage for an axis-aligned rectangle with real (sub-pixel) edges.
 * Exact, not supersampled: the overlap of a pixel square with a rectangle is
 * just the product of the two 1-D overlaps.
 */
export function rectCoverage(sel, x0, y0, x1, y1, { antialias = true } = {}) {
  const lo = [Math.min(x0, x1), Math.min(y0, y1)];
  const hi = [Math.max(x0, x1), Math.max(y0, y1)];
  const r = rect(
    Math.floor(lo[0]), Math.floor(lo[1]),
    Math.ceil(hi[0]) - Math.floor(lo[0]), Math.ceil(hi[1]) - Math.floor(lo[1]),
  );
  if (r.w <= 0 || r.h <= 0) return { r: rect(0, 0, 0, 0), cov: new Float32Array(0) };
  const cov = new Float32Array(r.w * r.h);
  const span = (a, b, i) => {
    if (!antialias) return (i + 0.5 >= a && i + 0.5 < b) ? 1 : 0;
    return clamp01(Math.min(b, i + 1) - Math.max(a, i));
  };
  for (let y = 0; y < r.h; y++) {
    const fy = span(lo[1], hi[1], r.y + y);
    if (fy <= 0) continue;
    for (let x = 0; x < r.w; x++) {
      cov[y * r.w + x] = span(lo[0], hi[0], r.x + x) * fy;
    }
  }
  return { r, cov };
}

/**
 * An ellipse, antialiased from its implicit function rather than by
 * supersampling: the distance to the boundary in pixel units gives a smooth
 * one-pixel ramp with no stair-stepping and no 16-level banding.
 */
export function ellipseCoverage(sel, x0, y0, x1, y1, { antialias = true } = {}) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (rx <= 0 || ry <= 0) return { r: rect(0, 0, 0, 0), cov: new Float32Array(0) };
  const r = rect(
    Math.floor(cx - rx) - 1, Math.floor(cy - ry) - 1,
    Math.ceil(rx * 2) + 3, Math.ceil(ry * 2) + 3,
  );
  const cov = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    const py = r.y + y + 0.5 - cy;
    for (let x = 0; x < r.w; x++) {
      const px = r.x + x + 0.5 - cx;
      const u = px / rx, v = py / ry;
      const q = Math.sqrt(u * u + v * v);
      if (!antialias) { cov[y * r.w + x] = q <= 1 ? 1 : 0; continue; }
      // Scale the implicit value back into pixels: the gradient of q is
      // roughly 1/min(rx,ry), so the ramp width in pixels is that reciprocal.
      const grad = Math.hypot(u / rx, v / ry) || 1e-6;
      const dist = (1 - q) / grad;                  // signed pixels, + inside
      cov[y * r.w + x] = clamp01(dist + 0.5);
    }
  }
  return { r, cov };
}

/**
 * A polygon (lasso, polygonal lasso, a path converted to a selection).
 *
 * Coverage comes from 4x vertical subsamples with EXACT horizontal spans,
 * which is a good trade: the horizontal direction -- where a scanline gives
 * the answer analytically -- costs nothing, and only the vertical direction
 * is quantised, to quarter-pixels. Full 4x4 supersampling would give 16
 * coverage levels in both directions and a visible stair on a near-horizontal
 * edge.
 *
 * The fill rule is NON-ZERO, so a self-intersecting lasso selects its whole
 * outline rather than punching a hole where it crosses itself.
 */
/** One ring, the common case. See polygonsCoverage for the general one. */
export function polygonCoverage(points, opts = {}) {
  return polygonsCoverage([points], opts);
}

/**
 * Antialiased coverage for a set of rings.
 *
 * Several rings rather than one because that is what a real path is, and
 * because it is how a STROKE is drawn here: each segment, join and cap is its
 * own ring, all wound the same way, and non-zero winding turns their overlap
 * into a union. Rasterising them one at a time and taking the maximum would
 * double-count the antialiased edges where two rings meet, leaving a visible
 * seam down the middle of every join.
 */
export function polygonsCoverage(rings, { antialias = true, evenOdd = false } = {}) {
  const rs = (rings || []).filter((p) => p && p.length >= 3);
  if (!rs.length) return { r: rect(0, 0, 0, 0), cov: new Float32Array(0) };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of rs) {
    for (const [x, y] of points) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const r = rect(Math.floor(minX), Math.floor(minY), Math.ceil(maxX) - Math.floor(minX) + 1, Math.ceil(maxY) - Math.floor(minY) + 1);
  if (r.w <= 0 || r.h <= 0) return { r: rect(0, 0, 0, 0), cov: new Float32Array(0) };
  const cov = new Float32Array(r.w * r.h);
  const SUB = antialias ? 4 : 1;
  const xs = [];
  const winds = [];
  for (let y = 0; y < r.h; y++) {
    for (let s = 0; s < SUB; s++) {
      const sy = r.y + y + (s + 0.5) / SUB;
      xs.length = 0; winds.length = 0;
      for (const points of rs) {
        const n = points.length;
        for (let i = 0; i < n; i++) {
          const [ax, ay] = points[i];
          const [bx, by] = points[(i + 1) % n];
          if (ay === by) continue;
          // Half-open in y, so a vertex shared by two edges is counted once --
          // the classic double-count that leaves a one-pixel gap at a vertex.
          if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
            const t = (sy - ay) / (by - ay);
            xs.push(ax + t * (bx - ax));
            winds.push(by > ay ? 1 : -1);
          }
        }
      }
      if (!xs.length) continue;
      const order = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b]);
      let wind = 0;
      for (let i = 0; i < order.length - 1; i++) {
        wind += winds[order[i]];
        const insideSpan = evenOdd ? ((i % 2) === 0) : wind !== 0;
        if (!insideSpan) continue;
        const spanA = xs[order[i]], spanB = xs[order[i + 1]];
        // Exact horizontal coverage of this span across whole pixels.
        const px0 = Math.max(r.x, Math.floor(spanA));
        const px1 = Math.min(r.x + r.w - 1, Math.ceil(spanB));
        for (let px = px0; px <= px1; px++) {
          const overlap = Math.min(spanB, px + 1) - Math.max(spanA, px);
          if (overlap <= 0) continue;
          cov[y * r.w + (px - r.x)] += overlap / SUB;
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i++) cov[i] = clamp01(cov[i]);
  return { r, cov };
}

// ---------------------------------------------------------- magic wand

/**
 * Colour difference for the wand and for Colour Range, in the space the user
 * actually perceives. deltaE2000 in Lab is slow but it is the reason a
 * tolerance of 20 picks "about the same blue" rather than "about the same
 * amount of red", which is what an RGB distance gives you.
 *
 * `fast` switches to a plain RGB distance for interactive previews on a big
 * image, and the two are deliberately NOT mixed: a preview that used one and
 * the commit the other would change the selection on mouse-up.
 */
export function colorDistance(a, b, fast = false) {
  if (fast) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt((dr * dr + dg * dg + db * db) / 3) * 100;
  }
  return deltaE2000(rgbToLab(a[0], a[1], a[2]), rgbToLab(b[0], b[1], b[2]));
}

/**
 * Magic wand. Contiguous mode is a flood fill from the clicked pixel;
 * non-contiguous ("Global") tests every pixel in the document.
 *
 * The flood fill is ITERATIVE with an explicit stack. A recursive one blows
 * the JS stack somewhere around a 300x300 region, and the crash looks like a
 * browser bug rather than like a missing queue.
 */
export function magicWand(rgba, w, h, sx, sy, opts = {}) {
  const tolerance = opts.tolerance === undefined ? 20 : opts.tolerance;
  const contiguous = opts.contiguous !== false;
  const antialias = opts.antialias !== false;
  const fast = !!opts.fast;
  const diagonal = !!opts.diagonal;
  const cov = new Float32Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { r: rect(0, 0, w, h), cov };

  const at = (i) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  const seed = at(sy * w + sx);
  const seedLab = fast ? null : rgbToLab(seed[0], seed[1], seed[2]);

  const dist = (i) => {
    const c = at(i);
    if (fast) return colorDistance(seed, c, true);
    return deltaE2000(seedLab, rgbToLab(c[0], c[1], c[2]));
  };

  // Coverage ramps from 1 at zero difference to 0 at the tolerance, which is
  // what antialiasing means for a wand: a pixel half-way out is half selected.
  const ramp = (d) => {
    if (d <= 0) return 1;
    if (d >= tolerance) return 0;
    return antialias ? 1 - d / tolerance : 1;
  };

  if (!contiguous) {
    for (let i = 0; i < w * h; i++) {
      const d = dist(i);
      if (d < tolerance) cov[i] = ramp(d);
    }
    return { r: rect(0, 0, w, h), cov };
  }

  const seen = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop();
    const d = dist(i);
    if (d >= tolerance) continue;
    cov[i] = ramp(d);
    const x = i % w, y = (i / w) | 0;
    const push = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const j = ny * w + nx;
      if (seen[j]) return;
      seen[j] = 1;
      stack.push(j);
    };
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    if (diagonal) { push(x - 1, y - 1); push(x + 1, y - 1); push(x - 1, y + 1); push(x + 1, y + 1); }
  }
  return { r: rect(0, 0, w, h), cov };
}

/** Select > Colour Range: every pixel within fuzziness of a target colour. */
export function colorRange(rgba, w, h, target, opts = {}) {
  const fuzziness = opts.fuzziness === undefined ? 20 : opts.fuzziness;
  const fast = !!opts.fast;
  const cov = new Float32Array(w * h);
  const tLab = fast ? null : rgbToLab(target[0], target[1], target[2]);
  for (let i = 0; i < w * h; i++) {
    const c = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    const d = fast ? colorDistance(target, c, true) : deltaE2000(tLab, rgbToLab(c[0], c[1], c[2]));
    cov[i] = d >= fuzziness ? 0 : 1 - d / fuzziness;
  }
  return { r: rect(0, 0, w, h), cov };
}

// ------------------------------------------------------------- modify

/** Feather: a gaussian blur of the coverage. */
export function featherSelection(sel, radius) {
  if (radius <= 0) return sel;
  const r = sel.bounds;
  const cov = sel.readRect(r);
  // gaussianBlur wants RGBA; put the coverage in all four channels so the
  // premultiply step is a no-op and the alpha channel carries the answer.
  const tmp = new Float32Array(r.w * r.h * 4);
  for (let i = 0; i < cov.length; i++) {
    tmp[i * 4] = cov[i]; tmp[i * 4 + 1] = cov[i]; tmp[i * 4 + 2] = cov[i]; tmp[i * 4 + 3] = 1;
  }
  gaussianBlur(tmp, r.w, r.h, radius, 'clamp');
  for (let i = 0; i < cov.length; i++) cov[i] = tmp[i * 4];
  sel.writeRect(r, cov);
  return sel;
}

/**
 * Expand or Contract, by moving the 0.5 threshold of a signed distance field.
 * One computation serves both directions, and the result is exactly round --
 * an iterated dilation by a 3x3 square grows a diamond or a square instead.
 */
export function expandSelection(sel, pixels) {
  if (pixels === 0) return sel;
  const r = sel.bounds;
  const cov = sel.readRect(r);
  const sd = signedDistance(cov, r.w, r.h, 0.5);
  for (let i = 0; i < cov.length; i++) {
    // sd is negative inside; moving the boundary out by `pixels` means
    // accepting everything whose distance is below +pixels.
    cov[i] = clamp01(0.5 - (sd[i] - pixels));
  }
  sel.writeRect(r, cov);
  return sel;
}

export function contractSelection(sel, pixels) { return expandSelection(sel, -pixels); }

/** Border: the ring within `width` of the edge, inside and out. */
export function borderSelection(sel, width) {
  const r = sel.bounds;
  const cov = sel.readRect(r);
  const sd = signedDistance(cov, r.w, r.h, 0.5);
  const half = width / 2;
  for (let i = 0; i < cov.length; i++) {
    cov[i] = clamp01(half - Math.abs(sd[i]) + 0.5);
  }
  sel.writeRect(r, cov);
  return sel;
}

/** Smooth: a median-like rounding of the coverage that removes single-pixel
 *  spikes without softening the edge the way a feather does. */
export function smoothSelection(sel, radius) {
  if (radius <= 0) return sel;
  const r = sel.bounds;
  const cov = sel.readRect(r);
  const sd = signedDistance(cov, r.w, r.h, 0.5);
  // Rounding a signed distance field by its own radius is what rounds corners
  // and fills notches smaller than the radius, which is what Smooth means.
  const out = new Float32Array(cov.length);
  for (let i = 0; i < cov.length; i++) out[i] = sd[i];
  // expand then contract (a morphological closing), both exact
  for (let i = 0; i < cov.length; i++) cov[i] = clamp01(0.5 - (out[i] - radius));
  const sd2 = signedDistance(cov, r.w, r.h, 0.5);
  for (let i = 0; i < cov.length; i++) cov[i] = clamp01(0.5 - (sd2[i] + radius));
  sel.writeRect(r, cov);
  return sel;
}

// ------------------------------------------------------- marching ants

/**
 * The selection outline, as closed polygons on the PIXEL CORNER lattice.
 *
 * Built in two steps, because that makes it provable. First every boundary
 * crack becomes a directed edge with the selected side on its right; then the
 * edges are chained into loops. The exact oracle that validates the whole
 * thing is one number: with y pointing down and the inside on the right, the
 * signed areas of all the contours must sum to EXACTLY the selected pixel
 * count. That single check covers edge directions, winding, holes and the
 * diagonal turn policy at once -- the same oracle image-to-vector uses for
 * its tracer.
 *
 * Where two selected pixels meet corner to corner a lattice vertex has two
 * outgoing cracks. Taking the CLOCKWISE one keeps diagonals inside a single
 * contour (8-connected foreground); the other choice splits them, and a
 * marching-ants line that breaks at every diagonal step looks broken.
 */
export function marchingAnts(sel, threshold = 0.5) {
  const b = sel.contentBounds();
  if (rectEmpty(b)) return [];
  // One pixel of padding so a selection touching the document edge still has
  // outside pixels to walk against.
  const pad = rect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
  const cov = sel.readRect(pad);
  const w = pad.w, h = pad.h;
  const inside = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? false : cov[y * w + x] >= threshold);

  // Directed cracks, keyed by their start vertex. A vertex can have two.
  const out = new Map();
  const add = (x0, y0, x1, y1) => {
    const k = y0 * (w + 1) + x0;
    const list = out.get(k);
    if (list) list.push([x1, y1]); else out.set(k, [[x1, y1]]);
  };
  let pixels = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      pixels++;
      // Each edge is directed so the SELECTED pixel is on its right.
      if (!inside(x, y - 1)) add(x, y, x + 1, y);              // top, ->
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);      // right, v
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);      // bottom, <-
      if (!inside(x - 1, y)) add(x, y + 1, x, y);              // left, ^
    }
  }

  const paths = [];
  const used = new Set();
  const ekey = (x0, y0, x1, y1) => `${x0},${y0}>${x1},${y1}`;

  for (const [startKey, list] of out) {
    for (const first of list) {
      const sx = startKey % (w + 1);
      const sy = (startKey / (w + 1)) | 0;
      if (used.has(ekey(sx, sy, first[0], first[1]))) continue;
      const pts = [];
      let cx = sx, cy = sy, nx = first[0], ny = first[1];
      let guard = 0;
      const maxSteps = (w + 1) * (h + 1) * 4 + 16;
      while (guard++ < maxSteps) {
        used.add(ekey(cx, cy, nx, ny));
        pts.push([cx + pad.x, cy + pad.y]);
        const cont = out.get(ny * (w + 1) + nx);
        if (!cont || !cont.length) break;
        let pick = cont[0];
        if (cont.length > 1) {
          // Two cracks leave this vertex: the diagonal touch. Prefer the
          // CLOCKWISE turn, which keeps the diagonal in one contour.
          const dx = nx - cx, dy = ny - cy;
          const cw = [-dy, dx];                    // clockwise with y down
          pick = cont.find((e) => (e[0] - nx) === cw[0] && (e[1] - ny) === cw[1])
            || cont.find((e) => (e[0] - nx) === dx && (e[1] - ny) === dy)
            || cont[0];
        }
        cx = nx; cy = ny;
        nx = pick[0]; ny = pick[1];
        if (cx === sx && cy === sy && nx === first[0] && ny === first[1]) break;
      }
      if (pts.length > 2) paths.push(pts);
    }
  }
  return paths;
}

/**
 * Signed area of a closed polygon, y-down shoelace. Exported because it is
 * half of the exact oracle for marchingAnts -- the areas of all the contours
 * of a mask must sum to its selected pixel count.
 */
export function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
