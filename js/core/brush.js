// The paint engine.
//
// A stroke is not a polyline. It is a sequence of STAMPS laid along the path
// at a fixed spacing, which is what makes a brush feel like a brush and what
// every dynamic hangs off. Three things in here are the difference between a
// toy and something you can actually paint with:
//
// 1. SPACING CARRIES OVER BETWEEN SEGMENTS. Pointer events arrive at whatever
//    rate the device feels like; if the spacing counter resets per segment, a
//    slow drag lays a stamp per event and the stroke turns into a row of
//    blobs, while a fast one skips. The leftover distance is kept in the
//    stroke, not in the segment.
//
// 2. FLOW AND OPACITY ARE DIFFERENT THINGS, and the difference needs a buffer.
//    Flow is how much coverage each stamp adds, and it ACCUMULATES where
//    stamps overlap -- that is why a low-flow brush builds up as you scrub.
//    Opacity is a cap on the whole stroke. So the stroke accumulates into its
//    own coverage surface and is composited onto the layer ONCE, at the end.
//    Painting each stamp straight onto the layer makes opacity and flow the
//    same slider, and makes a soft brush darken along its own overlaps.
//
// 3. THE ACCUMULATOR IS TILED. A stroke on a 6000x4000 document must not
//    allocate a 96 MB buffer, so it uses the same sparse Surface as a layer
//    and costs the tiles it actually touches.

import { Surface } from './tiles.js';
import { rect, rectUnion, rectIntersect, rectEmpty, clamp, clamp01, lerp, mulberry32, TAU } from './util.js';

export const TIP_SHAPES = ['round', 'square', 'custom'];

/**
 * A single stamp's coverage.
 *
 * Hardness is the fraction of the radius that is solid before the falloff
 * starts; the falloff itself is smoothstep, not linear, because a linear edge
 * on a soft brush shows a visible ring where the gradient changes.
 *
 * The returned footprint is sized for the ROTATED ellipse, so a 45-degree
 * flat brush is not clipped by its own bounding box.
 */
export function tipMask(size, { hardness = 0.5, roundness = 1, angle = 0, shape = 'round' } = {}) {
  const r = Math.max(0.5, size / 2);
  const ry = r * clamp(roundness, 0.01, 1);
  const ca = Math.cos((angle * Math.PI) / 180);
  const sa = Math.sin((angle * Math.PI) / 180);
  // half-extent of the rotated ellipse
  const hx = Math.sqrt((r * ca) ** 2 + (ry * sa) ** 2);
  const hy = Math.sqrt((r * sa) ** 2 + (ry * ca) ** 2);
  const w = Math.max(1, Math.ceil(hx * 2) + 2);
  const h = Math.max(1, Math.ceil(hy * 2) + 2);
  const cx = w / 2, cy = h / 2;
  const data = new Float32Array(w * h);
  const hard = clamp01(hardness);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      // into the tip's own frame
      const u = (dx * ca + dy * sa) / r;
      const v = (-dx * sa + dy * ca) / ry;
      let cov;
      if (shape === 'square') {
        cov = Math.max(Math.abs(u), Math.abs(v)) <= 1 ? 1 : 0;
      } else {
        const q = Math.hypot(u, v);
        if (q <= hard) cov = 1;
        else if (q >= 1) cov = 0;
        else {
          const t = (1 - q) / Math.max(1e-6, 1 - hard);
          cov = t * t * (3 - 2 * t);
        }
        // A fully hard brush still gets one pixel of antialiasing, or every
        // stroke is a staircase.
        if (hard >= 1) cov = clamp01((1 - q) * r + 0.5);
      }
      data[y * w + x] = cov;
    }
  }
  return { w, h, data, cx, cy };
}

/** The default brush settings, and the shape of a preset. */
export function defaultBrush() {
  return {
    size: 30,
    hardness: 0.6,
    roundness: 1,
    angle: 0,
    shape: 'round',
    spacing: 0.25,          // fraction of the diameter
    opacity: 1,
    flow: 1,
    // dynamics: each is { by: 'off'|'pressure'|'tilt'|'velocity'|'random', min }
    sizeDynamics: { by: 'pressure', min: 0.2 },
    opacityDynamics: { by: 'off', min: 0.3 },
    flowDynamics: { by: 'off', min: 0.3 },
    angleDynamics: { by: 'off', min: 0 },
    scatter: 0,             // in diameters
    scatterCount: 1,
    jitterSize: 0,
    jitterAngle: 0,
    smoothing: 0.35,        // stabiliser, 0..0.95
    wetEdges: false,
    seed: 1,
  };
}

/** The value of a dynamic at one input sample. */
function dynamic(d, sample, rnd) {
  if (!d || d.by === 'off') return 1;
  const min = clamp01(d.min === undefined ? 0 : d.min);
  let t;
  switch (d.by) {
    case 'pressure': t = clamp01(sample.pressure); break;
    case 'tilt': t = clamp01(sample.tilt); break;
    case 'velocity': t = clamp01(sample.velocity); break;
    case 'random': t = rnd(); break;
    default: t = 1;
  }
  return lerp(min, 1, t);
}

/**
 * A live stroke. Points go in one at a time as the pointer moves; coverage
 * accumulates into a sparse surface; the dirty rect says what to repaint.
 */
export class Stroke {
  /**
   * @param w,h    document size
   * @param brush  settings (see defaultBrush)
   * @param opts   { eraser, smudge } flags the caller uses when applying
   */
  constructor(w, h, brush, opts = {}) {
    this.w = w;
    this.h = h;
    this.brush = { ...defaultBrush(), ...brush };
    this.opts = opts;
    /** Accumulated coverage for the whole stroke, 0..1. 16-bit, because a
     *  low-flow brush builds up in steps of 1/255 and 8 bits would band. */
    this.cov = new Surface(w, h, 1, 16);
    this.dirty = rect(0, 0, 0, 0);
    this.stampCount = 0;
    this.leftover = 0;
    this.last = null;
    this.smoothed = null;
    this.rnd = mulberry32(this.brush.seed >>> 0);
    this.cachedTip = null;
    this.cachedKey = '';
  }

  tipFor(size, angle, roundness) {
    // Re-generating a 120px tip per stamp is most of the cost of a stroke;
    // the size is quantised to a quarter pixel so a pressure ramp reuses it.
    const qs = Math.round(size * 4) / 4;
    const qa = Math.round(angle);
    const qr = Math.round(roundness * 100) / 100;
    const key = `${qs}|${qa}|${qr}|${this.brush.hardness}|${this.brush.shape}`;
    if (key !== this.cachedKey) {
      this.cachedTip = tipMask(qs, {
        hardness: this.brush.hardness, roundness: qr, angle: qa, shape: this.brush.shape,
      });
      this.cachedKey = key;
    }
    return this.cachedTip;
  }

  /**
   * Feed one input sample. Returns the rect that changed, which may be empty
   * when the pointer has not moved far enough for the next stamp.
   */
  add(x, y, pressure = 1, tilt = 0) {
    const b = this.brush;
    // The stabiliser: a lag filter on the incoming position. It is what makes
    // a hand-drawn line smooth, and at 0 it must be exactly a no-op.
    if (b.smoothing > 0) {
      const k = clamp(b.smoothing, 0, 0.95);
      if (!this.smoothed) this.smoothed = { x, y };
      else {
        this.smoothed.x = lerp(x, this.smoothed.x, k);
        this.smoothed.y = lerp(y, this.smoothed.y, k);
      }
      x = this.smoothed.x; y = this.smoothed.y;
    }

    let changed = rect(0, 0, 0, 0);
    const sample = { pressure, tilt, velocity: 0 };

    if (!this.last) {
      this.last = { x, y, pressure, tilt };
      changed = this.stampAt(x, y, sample);
      this.dirty = rectUnion(this.dirty, changed);
      return changed;
    }

    const dx = x - this.last.x, dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return changed;
    // Velocity, normalised against a nominal fast stroke, for the dynamic.
    sample.velocity = clamp01(dist / 40);

    const step = Math.max(0.5, b.size * Math.max(0.01, b.spacing));
    let travelled = -this.leftover;
    while (travelled + step <= dist) {
      travelled += step;
      const t = travelled / dist;
      const px = this.last.x + dx * t;
      const py = this.last.y + dy * t;
      const s = {
        pressure: lerp(this.last.pressure, pressure, t),
        tilt: lerp(this.last.tilt, tilt, t),
        velocity: sample.velocity,
      };
      changed = rectUnion(changed, this.stampAt(px, py, s, Math.atan2(dy, dx)));
    }
    // What is left over is carried into the NEXT segment, which is the whole
    // reason a stroke keeps a constant stamp spacing whatever the event rate.
    this.leftover = dist - travelled;
    this.last = { x, y, pressure, tilt };
    this.dirty = rectUnion(this.dirty, changed);
    return changed;
  }

  stampAt(x, y, sample, pathAngle = 0) {
    const b = this.brush;
    const rnd = this.rnd;
    let total = rect(0, 0, 0, 0);
    const n = Math.max(1, Math.round(b.scatterCount));
    for (let i = 0; i < n; i++) {
      let sx = x, sy = y;
      if (b.scatter > 0) {
        const a = rnd() * TAU;
        const d = rnd() * b.scatter * b.size;
        sx += Math.cos(a) * d;
        sy += Math.sin(a) * d;
      }
      let size = b.size * dynamic(b.sizeDynamics, sample, rnd);
      if (b.jitterSize > 0) size *= lerp(1 - b.jitterSize, 1, rnd());
      size = Math.max(0.5, size);
      let angle = b.angle + (b.angleDynamics && b.angleDynamics.by === 'direction'
        ? (pathAngle * 180) / Math.PI : 0);
      if (b.jitterAngle > 0) angle += (rnd() - 0.5) * 2 * b.jitterAngle;
      const flow = clamp01(b.flow * dynamic(b.flowDynamics, sample, rnd));
      if (flow <= 0 || size <= 0) continue;
      total = rectUnion(total, this.blit(sx, sy, size, angle, flow));
      this.stampCount++;
    }
    return total;
  }

  /** Composite one tip into the accumulator with "max then add" semantics. */
  blit(x, y, size, angle, flow) {
    const tip = this.tipFor(size, angle, this.brush.roundness);
    const x0 = Math.floor(x - tip.cx);
    const y0 = Math.floor(y - tip.cy);
    const r = rectIntersect(rect(x0, y0, tip.w, tip.h), rect(0, 0, this.w, this.h));
    if (rectEmpty(r)) return rect(0, 0, 0, 0);
    const cur = this.cov.readRect(r);
    for (let yy = 0; yy < r.h; yy++) {
      const ty = r.y + yy - y0;
      for (let xx = 0; xx < r.w; xx++) {
        const tx = r.x + xx - x0;
        const c = tip.data[ty * tip.w + tx] * flow;
        if (c <= 0) continue;
        const i = yy * r.w + xx;
        // Accumulate the way paint does: each stamp covers a FRACTION of what
        // is still uncovered, so repeated stamps approach 1 without ever
        // passing it, and a single stamp at flow 1 is exactly 1. Plain
        // addition would blow past 1 and lose the soft edge; a plain max
        // would make flow do nothing on overlap.
        cur[i] = cur[i] + (1 - cur[i]) * c;
      }
    }
    this.cov.writeRect(r, cur);
    return r;
  }
}

/**
 * Apply a finished (or in-progress) stroke to a layer.
 *
 * `mode` 'paint' lays colour down, 'erase' removes it. The selection, if
 * there is one, scales the coverage -- which is what makes painting inside a
 * selection soft at a feathered edge rather than clipped to it.
 */
export function applyStroke(layer, stroke, r, { color = [0, 0, 0], opacity = 1, mode = 'paint', selection = null } = {}) {
  const box = rectIntersect(r, rect(0, 0, stroke.w, stroke.h));
  if (rectEmpty(box)) return box;
  const cov = stroke.cov.readRect(box);
  const sel = selection ? selection.readRect(box) : null;
  const dst = layer.surface.readRect(box);
  const n = box.w * box.h;
  for (let i = 0; i < n; i++) {
    let a = cov[i] * opacity;
    if (sel) a *= sel[i];
    if (a <= 0) continue;
    const p = i * 4;
    if (mode === 'erase') {
      dst[p + 3] = dst[p + 3] * (1 - a);
      continue;
    }
    // Straight-alpha source-over of a solid colour.
    const ab = dst[p + 3];
    const ao = a + ab * (1 - a);
    if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) {
      dst[p + c] = (color[c] * a + dst[p + c] * ab * (1 - a)) / ao;
    }
    dst[p + 3] = ao;
  }
  layer.surface.writeRect(box, dst);
  return box;
}

/**
 * A straight line of stamps, for Shift-click and for the line tool. Uses the
 * same Stroke so spacing, dynamics and accumulation behave identically --
 * a separate line routine is how a line ends up looking different from a
 * drag along the same path.
 */
export function strokeLine(w, h, brush, from, to, pressure = 1) {
  const s = new Stroke(w, h, { ...brush, smoothing: 0 });
  s.add(from[0], from[1], pressure);
  s.add(to[0], to[1], pressure);
  return s;
}
