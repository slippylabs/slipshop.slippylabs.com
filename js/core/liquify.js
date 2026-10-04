// Liquify: a displacement mesh you push pixels around with.
//
// THREE decisions make the rest of this file follow.
//
// 1. THE MESH HOLDS THE INVERSE MAP. Each node stores where to SAMPLE FROM,
//    not where its pixel goes to. That is what a resampler needs -- for every
//    destination pixel, one source position -- so the forward direction would
//    have to be inverted before anything could be drawn, and a forward warp
//    leaves holes where it stretches. The price is that every tool's maths
//    runs backwards: pushing content to the right means sampling from the
//    left.
//
// 2. IT IS A GRID, NOT A FULL-RESOLUTION FIELD. Two floats per pixel on a
//    4000x3000 image is 96MB, and liquify is an interactive tool that has to
//    stay responsive while you drag. A node every `step` pixels, bilinearly
//    interpolated, is what Photoshop's mesh is and what makes saving one
//    possible.
//
// 3. DABS COMPOSE, THEY DO NOT ADD. The right way to stack two inverse maps
//    is function composition:
//
//        new(p) = dab(p) + old(p + dab(p))
//
//    Adding them instead -- `d += dab` -- is one character shorter and wrong
//    as soon as a warp is big enough to matter: the second dab would be read
//    at the undisplaced position, so pushing a feature across the canvas and
//    then twirling where it ENDED UP would twirl where it STARTED. It also
//    breaks the one property that makes liquify usable: a push and an equal
//    push back must cancel.

import { clamp, clamp01, rect } from './util.js';
import { sampleAt } from './resample.js';

export const LIQUIFY_TOOLS = [
  'push', 'bloat', 'pucker', 'twirlCW', 'twirlCCW', 'shift', 'reconstruct', 'smooth', 'freeze', 'thaw',
];

export const LIQUIFY_LABELS = {
  push: 'Forward Warp', bloat: 'Bloat', pucker: 'Pucker',
  twirlCW: 'Twirl Clockwise', twirlCCW: 'Twirl Anticlockwise',
  shift: 'Shift Pixels', reconstruct: 'Reconstruct', smooth: 'Smooth',
  freeze: 'Freeze Mask', thaw: 'Thaw Mask',
};

/** Tools that need a drag direction rather than just a position. */
export const DIRECTIONAL = new Set(['push', 'shift']);

export const DEFAULT_STEP = 8;

export class Mesh {
  /**
   * @param w,h  the document size the mesh covers
   * @param step node spacing in pixels; the grid is one node larger each way
   *             so the last node sits exactly on the far edge
   */
  constructor(w, h, step = DEFAULT_STEP) {
    this.w = w;
    this.h = h;
    this.step = Math.max(1, Math.round(step));
    this.nx = Math.ceil(w / this.step) + 1;
    this.ny = Math.ceil(h / this.step) + 1;
    const n = this.nx * this.ny;
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    /** 0..1 per node. A frozen node never moves, which is how you protect an
     *  eye while reshaping the face around it. */
    this.freeze = new Float32Array(n);
  }

  get length() { return this.nx * this.ny; }

  /** The document position of node (i, j), clamped to the document. The last
   *  node is pinned to the far edge rather than hanging past it, so the mesh
   *  covers the image exactly and nothing samples from outside. */
  nodeX(i) { return Math.min(i * this.step, this.w); }
  nodeY(j) { return Math.min(j * this.step, this.h); }

  clone() {
    const m = new Mesh(this.w, this.h, this.step);
    m.dx.set(this.dx);
    m.dy.set(this.dy);
    m.freeze.set(this.freeze);
    return m;
  }

  reset() {
    this.dx.fill(0);
    this.dy.fill(0);
  }

  get isIdentity() {
    for (let i = 0; i < this.dx.length; i++) if (this.dx[i] !== 0 || this.dy[i] !== 0) return false;
    return true;
  }

  /**
   * Bilinear displacement at a document position.
   *
   * Clamped at the edges, which matters: a warp whose brush overlaps the edge
   * of the image otherwise reads displacement from nowhere and tears.
   */
  sample(x, y, out = [0, 0]) {
    const gx = clamp(x / this.step, 0, this.nx - 1);
    const gy = clamp(y / this.step, 0, this.ny - 1);
    const i0 = Math.floor(gx), j0 = Math.floor(gy);
    const i1 = Math.min(i0 + 1, this.nx - 1), j1 = Math.min(j0 + 1, this.ny - 1);
    const fx = gx - i0, fy = gy - j0;
    const a = j0 * this.nx + i0, b = j0 * this.nx + i1;
    const c = j1 * this.nx + i0, d = j1 * this.nx + i1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = this.dx[a] * w00 + this.dx[b] * w10 + this.dx[c] * w01 + this.dx[d] * w11;
    out[1] = this.dy[a] * w00 + this.dy[b] * w10 + this.dy[c] * w01 + this.dy[d] * w11;
    return out;
  }

  sampleFreeze(x, y) {
    const gx = clamp(x / this.step, 0, this.nx - 1);
    const gy = clamp(y / this.step, 0, this.ny - 1);
    const i0 = Math.floor(gx), j0 = Math.floor(gy);
    const i1 = Math.min(i0 + 1, this.nx - 1), j1 = Math.min(j0 + 1, this.ny - 1);
    const fx = gx - i0, fy = gy - j0;
    return this.freeze[j0 * this.nx + i0] * (1 - fx) * (1 - fy)
      + this.freeze[j0 * this.nx + i1] * fx * (1 - fy)
      + this.freeze[j1 * this.nx + i0] * (1 - fx) * fy
      + this.freeze[j1 * this.nx + i1] * fx * fy;
  }

  /** Flat arrays, for saving a mesh in a project file. */
  toJSON() {
    return {
      w: this.w, h: this.h, step: this.step,
      dx: Array.from(this.dx), dy: Array.from(this.dy), freeze: Array.from(this.freeze),
    };
  }

  static fromJSON(o) {
    const m = new Mesh(o.w, o.h, o.step);
    if (o.dx && o.dx.length === m.length) m.dx.set(o.dx);
    if (o.dy && o.dy.length === m.length) m.dy.set(o.dy);
    if (o.freeze && o.freeze.length === m.length) m.freeze.set(o.freeze);
    return m;
  }
}

/**
 * The brush falloff: 1 at the centre, 0 at the rim, with a ZERO DERIVATIVE at
 * both ends.
 *
 * (1 - t^2)^2 rather than a linear ramp or a cosine. The derivative at t = 1
 * is what you see: a falloff that reaches zero with a non-zero slope leaves a
 * visible circular crease at the edge of every dab, and a hundred dabs down a
 * drag leaves a hundred of them. Being flat at t = 0 as well keeps the centre
 * from pulling into a point.
 */
export function falloff(t) {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const u = 1 - t * t;
  return u * u;
}

/**
 * Apply one brush dab to the mesh, in place.
 *
 * @param mesh
 * @param tool    one of LIQUIFY_TOOLS
 * @param p       { x, y, radius, strength, dx, dy } -- dx/dy is the drag step
 *                for the directional tools, in document pixels
 * @returns the node-space rect touched, or null
 */
export function applyBrush(mesh, tool, p) {
  const { x, y } = p;
  const radius = Math.max(1, p.radius || 50);
  const strength = p.strength === undefined ? 0.5 : clamp01(p.strength);
  const step = mesh.step;

  const i0 = Math.max(0, Math.floor((x - radius) / step));
  const i1 = Math.min(mesh.nx - 1, Math.ceil((x + radius) / step));
  const j0 = Math.max(0, Math.floor((y - radius) / step));
  const j1 = Math.min(mesh.ny - 1, Math.ceil((y + radius) / step));
  if (i1 < i0 || j1 < j0) return null;

  if (tool === 'freeze' || tool === 'thaw') {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const nx = mesh.nodeX(i), ny = mesh.nodeY(j);
        const w = falloff(Math.hypot(nx - x, ny - y) / radius) * strength;
        if (w <= 0) continue;
        const k = j * mesh.nx + i;
        mesh.freeze[k] = tool === 'freeze'
          ? Math.min(1, mesh.freeze[k] + w)
          : Math.max(0, mesh.freeze[k] - w);
      }
    }
    return { i0, j0, i1, j1 };
  }

  if (tool === 'smooth') {
    // Average with the four neighbours, weighted by the brush. Read from a
    // COPY: smoothing in place propagates the first node's new value into the
    // second's average and turns a symmetric blur into a directional smear.
    const sx = mesh.dx.slice(), sy = mesh.dy.slice();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const nx = mesh.nodeX(i), ny = mesh.nodeY(j);
        const w = falloff(Math.hypot(nx - x, ny - y) / radius) * strength
          * (1 - mesh.freeze[j * mesh.nx + i]);
        if (w <= 0) continue;
        const k = j * mesh.nx + i;
        const li = Math.max(0, i - 1), ri = Math.min(mesh.nx - 1, i + 1);
        const tj = Math.max(0, j - 1), bj = Math.min(mesh.ny - 1, j + 1);
        const ax = (sx[j * mesh.nx + li] + sx[j * mesh.nx + ri] + sx[tj * mesh.nx + i] + sx[bj * mesh.nx + i]) / 4;
        const ay = (sy[j * mesh.nx + li] + sy[j * mesh.nx + ri] + sy[tj * mesh.nx + i] + sy[bj * mesh.nx + i]) / 4;
        mesh.dx[k] += (ax - mesh.dx[k]) * w;
        mesh.dy[k] += (ay - mesh.dy[k]) * w;
      }
    }
    return { i0, j0, i1, j1 };
  }

  if (tool === 'reconstruct') {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const nx = mesh.nodeX(i), ny = mesh.nodeY(j);
        const w = falloff(Math.hypot(nx - x, ny - y) / radius) * strength;
        if (w <= 0) continue;
        const k = j * mesh.nx + i;
        mesh.dx[k] *= 1 - w;
        mesh.dy[k] *= 1 - w;
      }
    }
    return { i0, j0, i1, j1 };
  }

  // The displacing tools. Each computes the dab's OWN inverse displacement at
  // a node, then composes it with what the mesh already held.
  const old = { dx: mesh.dx.slice(), dy: mesh.dy.slice() };
  const oldAt = (px, py, out) => {
    const gx = clamp(px / step, 0, mesh.nx - 1);
    const gy = clamp(py / step, 0, mesh.ny - 1);
    const a0 = Math.floor(gx), b0 = Math.floor(gy);
    const a1 = Math.min(a0 + 1, mesh.nx - 1), b1 = Math.min(b0 + 1, mesh.ny - 1);
    const fx = gx - a0, fy = gy - b0;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const ia = b0 * mesh.nx + a0, ib = b0 * mesh.nx + a1;
    const ic = b1 * mesh.nx + a0, id = b1 * mesh.nx + a1;
    out[0] = old.dx[ia] * w00 + old.dx[ib] * w10 + old.dx[ic] * w01 + old.dx[id] * w11;
    out[1] = old.dy[ia] * w00 + old.dy[ib] * w10 + old.dy[ic] * w01 + old.dy[id] * w11;
    return out;
  };

  const tmp = [0, 0];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const nx = mesh.nodeX(i), ny = mesh.nodeY(j);
      const k = j * mesh.nx + i;
      const dist = Math.hypot(nx - x, ny - y);
      const w = falloff(dist / radius) * strength * (1 - mesh.freeze[k]);
      if (w <= 0) continue;

      let bx = 0, by = 0;
      if (tool === 'push' || tool === 'shift') {
        // Content follows the pointer, so the SAMPLE moves the other way.
        // `shift` goes perpendicular to the drag, which is what makes it a
        // sideways nudge rather than a second forward warp.
        const mx = p.dx || 0, my = p.dy || 0;
        if (tool === 'push') { bx = -mx * w; by = -my * w; }
        else { bx = my * w; by = -mx * w; }
      } else if (tool === 'bloat' || tool === 'pucker') {
        // Sampling from CLOSER to the centre magnifies, which is bloat.
        const s = tool === 'bloat' ? -w : w;
        bx = (nx - x) * s * 0.5;
        by = (ny - y) * s * 0.5;
      } else {
        // Rotate the sample position BACKWARDS so the content turns forwards.
        const ang = (tool === 'twirlCW' ? -1 : 1) * w * Math.PI * 0.5;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = nx - x, ry = ny - y;
        bx = (ca * rx - sa * ry) - rx;
        by = (sa * rx + ca * ry) - ry;
      }

      // Composition, not addition: read what the mesh already said at the
      // position this dab samples from.
      oldAt(nx + bx, ny + by, tmp);
      mesh.dx[k] = bx + tmp[0];
      mesh.dy[k] = by + tmp[1];
    }
  }
  return { i0, j0, i1, j1 };
}

/**
 * How far outside a rect a warp reads.
 *
 * The biggest displacement anywhere in the mesh, rounded up. Not the brush
 * radius: a feature pushed right across the canvas is read from where it came
 * from, which may be nowhere near the brush.
 */
export function meshReach(mesh) {
  let m = 0;
  for (let i = 0; i < mesh.dx.length; i++) {
    const d = Math.abs(mesh.dx[i]) + Math.abs(mesh.dy[i]);
    if (d > m) m = d;
  }
  return Math.ceil(m) + 2;
}

/**
 * Resample a buffer through the mesh.
 *
 * `src` covers `sr`; the result covers `dr`. Premultiplied on the way in and
 * divided back out on the way out, for the usual reason: interpolating
 * straight colour across the edge of a cut-out drags the colour of
 * transparent pixels into visible ones, which is the dark fringe round
 * anything warped or rotated.
 */
export function warpBuffer(src, sr, dr, mesh, { filter = 'bilinear' } = {}) {
  const n = sr.w * sr.h;
  const pre = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = src[p + 3];
    pre[p] = src[p] * a; pre[p + 1] = src[p + 1] * a; pre[p + 2] = src[p + 2] * a;
    pre[p + 3] = a;
  }
  const out = new Float32Array(dr.w * dr.h * 4);
  const d = [0, 0];
  const px = [0, 0, 0, 0];
  for (let y = 0; y < dr.h; y++) {
    const docY = dr.y + y + 0.5;
    for (let x = 0; x < dr.w; x++) {
      const docX = dr.x + x + 0.5;
      mesh.sample(docX, docY, d);
      const sx = docX + d[0] - sr.x;
      const sy = docY + d[1] - sr.y;
      const q = (y * dr.w + x) * 4;
      if (sx < -1 || sy < -1 || sx > sr.w + 1 || sy > sr.h + 1) continue;
      sampleAt(pre, sr.w, sr.h, sx, sy, filter, px);
      const a = clamp01(px[3]);
      if (a <= 0) continue;
      out[q] = clamp01(px[0] / a);
      out[q + 1] = clamp01(px[1] / a);
      out[q + 2] = clamp01(px[2] / a);
      out[q + 3] = a;
    }
  }
  return out;
}

/** The rect a warp of `dr` has to read. */
export function warpSourceRect(dr, mesh) {
  const pad = meshReach(mesh);
  return rect(dr.x - pad, dr.y - pad, dr.w + pad * 2, dr.h + pad * 2);
}
