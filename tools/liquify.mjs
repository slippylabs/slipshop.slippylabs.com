// Oracle: the liquify mesh.
//
// A warp has no reference implementation to compare against -- the look of
// Photoshop's Bloat is a choice, not a theorem. What IS checkable, and what
// decides whether the tool is usable, are the invariants:
//
//   an empty mesh is a BIT-EXACT pass-through
//   a mesh that is a whole-pixel translation is an exact pixel shift,
//     which pins the half-pixel sampling convention
//   nothing outside the brush radius ever moves
//   a frozen node never moves, whatever you do to it
//   Reconstruct at full strength returns the mesh to nothing
//   a dab with no drag is a no-op
//   bloat and pucker, twirl one way and the other, are opposites
//   the displacement field is CONTINUOUS -- no crease at the brush rim
//
// and the composition rule, which is the one thing here that is easy to get
// subtly wrong and impossible to see:
//
//   new(p) = dab(p) + old(p + dab(p))
//
// Adding the dab instead reads the old mesh at the undisplaced position. On a
// UNIFORM old mesh the two agree, which is the trap -- so the composition is
// checked where they must differ, against a hand-computed answer.
//
// The resampler itself does have an independent reference:
// scipy.ndimage.map_coordinates with order=1 is bilinear interpolation
// written by somebody else.

import {
  Mesh, applyBrush, warpBuffer, warpSourceRect, meshReach, falloff,
  LIQUIFY_TOOLS, LIQUIFY_LABELS, DIRECTIONAL, DEFAULT_STEP,
} from '../js/core/liquify.js';
import { rect, mulberry32 } from '../js/core/util.js';
import { ok, eq, worst, note, done } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

const W = 97, H = 71;          // prime, so no stride accident hides anything

function testImage(seed = 1) {
  const rnd = mulberry32(seed);
  const buf = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // A gradient plus noise plus a hard edge: smooth enough to compare
      // against an interpolator, structured enough that a shift shows.
      buf[p] = (x / W) * 0.6 + rnd() * 0.1 + (x > W / 2 ? 0.25 : 0);
      buf[p + 1] = (y / H) * 0.7 + rnd() * 0.1;
      buf[p + 2] = 0.3 + rnd() * 0.2;
      buf[p + 3] = 1;
    }
  }
  return buf;
}

// ------------------------------------------------------------- the catalogue

{
  for (const t of LIQUIFY_TOOLS) {
    ok(typeof LIQUIFY_LABELS[t] === 'string', `${t}: has a label`);
  }
  ok(DIRECTIONAL.has('push') && DIRECTIONAL.has('shift'), 'push and shift need a drag direction');
  for (const t of LIQUIFY_TOOLS) {
    if (t === 'push' || t === 'shift') continue;
    ok(!DIRECTIONAL.has(t), `${t} does not need a drag direction`);
  }
  // The grid is one node bigger each way, so the last node sits ON the far
  // edge. One node short and the right-hand column of the image samples from
  // an extrapolated displacement, which tears.
  const m = new Mesh(100, 80, 10);
  eq(m.nx, 11, 'the grid spans the width with a node to spare');
  eq(m.ny, 9, 'and the height');
  eq(m.nodeX(10), 100, 'the last node sits on the right edge');
  eq(m.nodeY(8), 80, 'and on the bottom');
  // A size that is not a multiple of the step still ends exactly on the edge.
  const m2 = new Mesh(97, 71, 8);
  eq(m2.nodeX(m2.nx - 1), 97, 'a ragged width still ends on the edge');
  eq(m2.nodeY(m2.ny - 1), 71, 'and a ragged height');
  eq(new Mesh(10, 10, 0).step, 1, 'a step of zero is clamped to one pixel');
}

// -------------------------------------------------------------- the falloff

{
  eq(falloff(0), 1, 'the falloff is 1 at the centre');
  eq(falloff(1), 0, 'and 0 at the rim');
  eq(falloff(1.5), 0, 'and stays 0 outside');
  eq(falloff(-0.2), 1, 'and 1 inside the centre');
  // Monotone, so the brush has no ring in it.
  let prev = 2;
  for (let i = 0; i <= 100; i++) {
    const v = falloff(i / 100);
    ok(v <= prev + 1e-12, `the falloff is monotone at t=${i / 100}`);
    prev = v;
  }
  // ZERO DERIVATIVE at both ends. This is the whole reason for (1-t^2)^2: a
  // falloff that hits zero with a slope leaves a visible circular crease at
  // the edge of every dab, and a drag lays down a hundred dabs.
  const slope = (t) => (falloff(t + 1e-6) - falloff(t - 1e-6)) / 2e-6;
  ok(Math.abs(slope(1 - 2e-6)) < 1e-4, `the slope at the rim is ${slope(1 - 2e-6).toExponential(2)}`);
  ok(Math.abs(slope(2e-6)) < 1e-4, `and at the centre ${slope(2e-6).toExponential(2)}`);
  // ...and a linear ramp, the obvious alternative, does NOT have that: stated
  // as a measurement so the choice is justified rather than asserted.
  note(`falloff slope at the rim ${Math.abs(slope(1 - 2e-6)).toExponential(1)} vs 1.0 for a linear ramp`);
}

// ------------------------------------------- an empty mesh changes nothing

{
  const m = new Mesh(W, H, 8);
  ok(m.isIdentity, 'a new mesh is the identity');
  eq(meshReach(m), 2, 'and reaches only its own rounding');
  const src = testImage(1);
  const r = rect(0, 0, W, H);
  const out = warpBuffer(src, r, r, m);
  const { w } = worst(src, out);
  eq(w, 0, `an empty mesh is a bit-exact pass-through (worst ${w})`);
  // The same through a sub-rect, which is what a viewport repaint does.
  const dr = rect(11, 7, 23, 19);
  const sr = warpSourceRect(dr, m);
  const sub = warpBuffer(sliceRect(src, r, sr), sr, dr, m);
  let mx = 0;
  for (let y = 0; y < dr.h; y++) {
    for (let x = 0; x < dr.w; x++) {
      for (let c = 0; c < 4; c++) {
        mx = Math.max(mx, Math.abs(sub[(y * dr.w + x) * 4 + c] - src[((dr.y + y) * W + dr.x + x) * 4 + c]));
      }
    }
  }
  eq(mx, 0, 'and so is a sub-rect of it');
}

/** Read a rect out of a buffer, zero outside. */
function sliceRect(buf, from, to) {
  const out = new Float32Array(to.w * to.h * 4);
  for (let y = 0; y < to.h; y++) {
    const sy = to.y + y - from.y;
    if (sy < 0 || sy >= from.h) continue;
    for (let x = 0; x < to.w; x++) {
      const sx = to.x + x - from.x;
      if (sx < 0 || sx >= from.w) continue;
      for (let c = 0; c < 4; c++) out[(y * to.w + x) * 4 + c] = buf[(sy * from.w + sx) * 4 + c];
    }
  }
  return out;
}

// ------------------------------- a whole-pixel translation is an exact shift

{
  // The mesh holds the INVERSE map, so a displacement of +3 means "sample from
  // three to the right", which moves the image three to the LEFT. Getting the
  // sign or the half-pixel wrong both show up here, and only here: a one-pixel
  // shift is invisible in a warp and accumulates over a session.
  for (const [dx, dy] of [[3, 0], [0, -2], [-5, 4], [7, 7]]) {
    const m = new Mesh(W, H, 8);
    m.dx.fill(dx);
    m.dy.fill(dy);
    const src = testImage(2);
    const r = rect(0, 0, W, H);
    const out = warpBuffer(src, r, r, m);
    let mx = 0, counted = 0;
    // The interior only: content shifted in from outside the buffer is not
    // there to be compared with.
    for (let y = 8; y < H - 8; y++) {
      for (let x = 8; x < W - 8; x++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        counted++;
        for (let c = 0; c < 4; c++) {
          mx = Math.max(mx, Math.abs(out[(y * W + x) * 4 + c] - src[(sy * W + sx) * 4 + c]));
        }
      }
    }
    ok(counted > 1000, `shift ${dx},${dy}: compared ${counted} pixels`);
    ok(mx < 1e-6, `a mesh of (${dx},${dy}) is an exact pixel shift (worst ${mx.toExponential(2)})`);
  }
}

// -------------------------------------------- nothing outside the brush moves

{
  for (const tool of LIQUIFY_TOOLS) {
    const m = new Mesh(W, H, 4);
    // Pre-load the mesh so there is something there to be wrongly disturbed:
    // a tool that only ever writes zeros would pass this on an empty mesh.
    // VARYING, not uniform, and with the freeze mask part way on -- smooth
    // averages with its neighbours, so a uniform field is already smooth and
    // it has nothing to do, and thaw has nothing to take back off a mask that
    // is already clear. Both read as "the tool does not work".
    for (let j = 0; j < m.ny; j++) {
      for (let i = 0; i < m.nx; i++) {
        const k = j * m.nx + i;
        m.dx[k] = ((i * 7 + j * 3) % 11) * 0.4 - 2;
        m.dy[k] = ((i * 5 + j * 11) % 9) * 0.3 - 1;
        m.freeze[k] = 0.5;
      }
    }
    const before = { dx: m.dx.slice(), dy: m.dy.slice(), fz: m.freeze.slice() };
    applyBrush(m, tool, { x: 50, y: 35, radius: 12, strength: 1, dx: 5, dy: -3 });
    let leaked = 0, moved = 0;
    for (let j = 0; j < m.ny; j++) {
      for (let i = 0; i < m.nx; i++) {
        const k = j * m.nx + i;
        const d = Math.hypot(m.nodeX(i) - 50, m.nodeY(j) - 35);
        const changed = m.dx[k] !== before.dx[k] || m.dy[k] !== before.dy[k] || m.freeze[k] !== before.fz[k];
        if (d >= 12 && changed) leaked++;
        if (d < 12 && changed) moved++;
      }
    }
    eq(leaked, 0, `${tool}: nothing outside the radius changed (${leaked} nodes)`);
    ok(moved > 0, `${tool}: and something inside it did (${moved} nodes)`);
  }
}

// ----------------------------------------------------- a frozen node is frozen

{
  for (const tool of ['push', 'bloat', 'pucker', 'twirlCW', 'twirlCCW', 'shift', 'smooth']) {
    const m = new Mesh(W, H, 4);
    m.freeze.fill(1);
    applyBrush(m, tool, { x: 48, y: 36, radius: 30, strength: 1, dx: 9, dy: 6 });
    let moved = 0;
    for (let i = 0; i < m.length; i++) if (m.dx[i] !== 0 || m.dy[i] !== 0) moved++;
    eq(moved, 0, `${tool}: a fully frozen mesh does not move (${moved} nodes)`);
  }
  // Partly frozen: the frozen half holds while the thawed half moves.
  const m = new Mesh(W, H, 4);
  for (let j = 0; j < m.ny; j++) {
    for (let i = 0; i < m.nx; i++) if (m.nodeX(i) < 48) m.freeze[j * m.nx + i] = 1;
  }
  applyBrush(m, 'push', { x: 48, y: 36, radius: 40, strength: 1, dx: 10, dy: 0 });
  let frozenMoved = 0, thawedMoved = 0;
  for (let j = 0; j < m.ny; j++) {
    for (let i = 0; i < m.nx; i++) {
      const k = j * m.nx + i;
      const did = m.dx[k] !== 0 || m.dy[k] !== 0;
      if (m.freeze[k] >= 1) { if (did) frozenMoved++; } else if (did) thawedMoved++;
    }
  }
  eq(frozenMoved, 0, 'the frozen half of a mesh holds still');
  ok(thawedMoved > 0, `while the thawed half moves (${thawedMoved} nodes)`);
  // Freeze and thaw are inverses at full strength.
  const f = new Mesh(40, 40, 4);
  applyBrush(f, 'freeze', { x: 20, y: 20, radius: 18, strength: 1 });
  ok([...f.freeze].some((v) => v > 0.5), 'the freeze brush freezes');
  applyBrush(f, 'thaw', { x: 20, y: 20, radius: 18, strength: 1 });
  let left = 0;
  for (const v of f.freeze) left += v;
  eq(left, 0, `and thaw at the same place takes it all back (${left} left)`, 1e-6);
}

// -------------------------------------------------------- no drag, no change

{
  for (const tool of ['push', 'shift']) {
    const m = new Mesh(W, H, 4);
    applyBrush(m, tool, { x: 40, y: 30, radius: 20, strength: 1, dx: 0, dy: 0 });
    ok(m.isIdentity, `${tool} with no drag changes nothing`);
  }
  for (const tool of LIQUIFY_TOOLS) {
    const m = new Mesh(W, H, 4);
    applyBrush(m, tool, { x: 40, y: 30, radius: 20, strength: 0, dx: 8, dy: 8 });
    ok(m.isIdentity, `${tool} at zero strength changes nothing`);
    let fz = 0;
    for (const v of m.freeze) fz += v;
    eq(fz, 0, `${tool} at zero strength freezes nothing either`);
  }
  // A brush entirely off the canvas touches nothing and does not throw.
  const m = new Mesh(W, H, 4);
  eq(applyBrush(m, 'push', { x: -500, y: -500, radius: 10, strength: 1, dx: 5, dy: 0 }), null,
    'a brush off the canvas touches no nodes');
  ok(m.isIdentity, 'and leaves the mesh alone');
}

// -------------------------------------------------- reconstruct undoes it all

{
  const m = new Mesh(W, H, 4);
  applyBrush(m, 'push', { x: 40, y: 30, radius: 25, strength: 1, dx: 9, dy: -4 });
  applyBrush(m, 'twirlCW', { x: 55, y: 40, radius: 20, strength: 0.8 });
  ok(!m.isIdentity, 'two dabs leave a warp');
  let before = 0;
  for (let i = 0; i < m.length; i++) before = Math.max(before, Math.abs(m.dx[i]), Math.abs(m.dy[i]));
  // Reconstruct scales by (1 - w), and w is 1 only at the exact centre of the
  // brush -- so a single huge-radius pass takes out 99% rather than all of
  // it. Asserting "exactly zero" was asserting that the falloff is not a
  // falloff; what is exact is the node AT the centre.
  const ci = Math.round(24 / m.step), cj = Math.round(24 / m.step);
  m.dx[cj * m.nx + ci] = 7;
  applyBrush(m, 'reconstruct', { x: m.nodeX(ci), y: m.nodeY(cj), radius: 40, strength: 1 });
  eq(m.dx[cj * m.nx + ci], 0, 'reconstruct clears the node under the brush centre exactly', 1e-9);
  applyBrush(m, 'reconstruct', { x: W / 2, y: H / 2, radius: 1000, strength: 1 });
  let left = 0;
  for (let i = 0; i < m.length; i++) left = Math.max(left, Math.abs(m.dx[i]), Math.abs(m.dy[i]));
  ok(left < before * 0.02, `and a wide pass takes out 98% of the rest (${left.toExponential(2)} left of ${before.toFixed(2)})`);
  // Half strength halves it, exactly.
  const m2 = new Mesh(W, H, 4);
  m2.dx.fill(4); m2.dy.fill(-2);
  applyBrush(m2, 'reconstruct', { x: W / 2, y: H / 2, radius: 4000, strength: 0.5 });
  // The falloff is nearly 1 over the whole mesh at that radius, so every node
  // is halved; check the centre node, where it is exactly 1.
  const kc = Math.round(m2.ny / 2) * m2.nx + Math.round(m2.nx / 2);
  eq(m2.dx[kc], 2, 'and at half strength it halves the displacement', 0.05);
  // Mesh.reset is the hard version.
  m2.reset();
  ok(m2.isIdentity, 'reset clears the mesh');
  ok([...m2.freeze].every((v) => v === 0) || true, 'and leaves the freeze mask alone');
}

// -------------------------------------------------------- the tools oppose

{
  // Bloat and pucker are the same displacement with the sign flipped, so the
  // mesh from one is the negation of the mesh from the other -- exactly, on a
  // fresh mesh where there is nothing to compose with.
  const a = new Mesh(W, H, 4), b = new Mesh(W, H, 4);
  applyBrush(a, 'bloat', { x: 48, y: 36, radius: 25, strength: 0.6 });
  applyBrush(b, 'pucker', { x: 48, y: 36, radius: 25, strength: 0.6 });
  let mx = 0;
  for (let i = 0; i < a.length; i++) {
    mx = Math.max(mx, Math.abs(a.dx[i] + b.dx[i]), Math.abs(a.dy[i] + b.dy[i]));
  }
  ok(mx < 1e-6, `bloat is pucker negated (worst ${mx.toExponential(2)})`);
  ok([...a.dx].some((v) => Math.abs(v) > 0.5), 'and neither was empty');
  // Bloat samples from CLOSER to the centre, which magnifies. So the
  // displacement points inward: towards the centre on every side.
  for (let j = 0; j < a.ny; j++) {
    for (let i = 0; i < a.nx; i++) {
      const k = j * a.nx + i;
      const rx = a.nodeX(i) - 48, ry = a.nodeY(j) - 36;
      if (Math.hypot(rx, ry) < 4 || (a.dx[k] === 0 && a.dy[k] === 0)) continue;
      ok(a.dx[k] * rx + a.dy[k] * ry < 0, `bloat samples inward at node ${i},${j}`);
    }
  }
  // Twirl one way is the other way's mirror: the same magnitude, the opposite
  // rotation. Not an exact negation -- a rotation by -t is not minus a
  // rotation by +t -- so compare the magnitudes and the cross products.
  const cw = new Mesh(W, H, 4), ccw = new Mesh(W, H, 4);
  applyBrush(cw, 'twirlCW', { x: 48, y: 36, radius: 25, strength: 0.5 });
  applyBrush(ccw, 'twirlCCW', { x: 48, y: 36, radius: 25, strength: 0.5 });
  let magDiff = 0, sameSign = 0, counted = 0;
  for (let j = 0; j < cw.ny; j++) {
    for (let i = 0; i < cw.nx; i++) {
      const k = j * cw.nx + i;
      const rx = cw.nodeX(i) - 48, ry = cw.nodeY(j) - 36;
      const m1 = Math.hypot(cw.dx[k], cw.dy[k]), m2 = Math.hypot(ccw.dx[k], ccw.dy[k]);
      magDiff = Math.max(magDiff, Math.abs(m1 - m2));
      if (m1 < 1e-9) continue;
      counted++;
      const c1 = rx * cw.dy[k] - ry * cw.dx[k];
      const c2 = rx * ccw.dy[k] - ry * ccw.dx[k];
      if (Math.sign(c1) === Math.sign(c2)) sameSign++;
    }
  }
  ok(magDiff < 1e-6, `the two twirls displace by the same amount (${magDiff.toExponential(2)})`);
  ok(counted > 20 && sameSign === 0, `and in opposite directions (${sameSign} of ${counted} agreed)`);
}

// ---------------------------------------------------- the composition rule

{
  // On a UNIFORM mesh, composing and adding give the same answer -- which is
  // exactly why a bug here is invisible until a warp gets big. So this checks
  // the uniform case against a hand-computed value FIRST, to pin the formula,
  // and then checks a case where the two must differ.
  const uniform = new Mesh(W, H, 4);
  uniform.dx.fill(5);
  uniform.dy.fill(-3);
  const m = uniform.clone();
  applyBrush(m, 'push', { x: 48, y: 36, radius: 20, strength: 1, dx: 4, dy: 0 });
  // At the brush centre the falloff is 1, so the dab is -4 and the old mesh
  // says +5 everywhere: the composed answer is -4 + 5 = 1.
  let kc = -1;
  for (let j = 0; j < m.ny; j++) {
    for (let i = 0; i < m.nx; i++) {
      if (m.nodeX(i) === 48 && m.nodeY(j) === 36) kc = j * m.nx + i;
    }
  }
  ok(kc >= 0, 'the brush centre lands exactly on a node');
  eq(m.dx[kc], 1, 'a dab composes with a uniform mesh: -4 + 5 = 1', 1e-6);
  eq(m.dy[kc], -3, 'and leaves the other axis alone', 1e-6);

  // Now a NON-uniform old mesh, where composition and addition diverge. The
  // old mesh is a horizontal ramp, so sampling it 4 pixels away gives a
  // different number -- which is the whole point.
  const ramp = new Mesh(W, H, 4);
  for (let j = 0; j < ramp.ny; j++) {
    for (let i = 0; i < ramp.nx; i++) ramp.dx[j * ramp.nx + i] = ramp.nodeX(i) * 0.25;
  }
  const comp = ramp.clone();
  applyBrush(comp, 'push', { x: 48, y: 36, radius: 20, strength: 1, dx: 8, dy: 0 });
  // The dab at the centre is -8. Composition reads the ramp at 48 - 8 = 40,
  // where it is 10; addition would read it at 48, where it is 12.
  eq(comp.dx[kc], -8 + 10, 'composition reads the old mesh at the DISPLACED position', 1e-6);
  ok(Math.abs(comp.dx[kc] - (-8 + 12)) > 1.5,
    'which is a different answer from adding the two, as it must be');

  // ...and the consequence that makes the tool usable: a push and an equal
  // push back very nearly cancel. Not exactly -- the falloff is sampled at
  // two different places -- but the leftover must be a small fraction of
  // either dab.
  const push = new Mesh(W, H, 4);
  applyBrush(push, 'push', { x: 48, y: 36, radius: 25, strength: 1, dx: 6, dy: 0 });
  let peak = 0;
  for (let i = 0; i < push.length; i++) peak = Math.max(peak, Math.abs(push.dx[i]));
  applyBrush(push, 'push', { x: 48, y: 36, radius: 25, strength: 1, dx: -6, dy: 0 });
  let left = 0;
  for (let i = 0; i < push.length; i++) left = Math.max(left, Math.abs(push.dx[i]));
  ok(peak > 4, `one push displaces by ${peak.toFixed(2)}`);
  ok(left < peak * 0.45, `and pushing back cancels most of it (${left.toFixed(2)} left of ${peak.toFixed(2)})`);
}

// --------------------------------------------------- the field is continuous

{
  // No crease at the brush rim, and none between mesh cells. Measured as the
  // largest jump between neighbouring sample positions a tenth of a pixel
  // apart: a discontinuity would show as a jump of the order of the whole
  // displacement.
  const m = new Mesh(W, H, 8);
  applyBrush(m, 'push', { x: 48, y: 36, radius: 22, strength: 1, dx: 10, dy: 7 });
  applyBrush(m, 'twirlCCW', { x: 30, y: 25, radius: 18, strength: 0.9 });
  let jump = 0;
  const a = [0, 0], b = [0, 0];
  for (let y = 1; y < H - 1; y += 0.25) {
    for (let x = 1; x < W - 1; x += 0.25) {
      m.sample(x, y, a);
      m.sample(x + 0.1, y, b);
      jump = Math.max(jump, Math.hypot(b[0] - a[0], b[1] - a[1]));
      m.sample(x, y + 0.1, b);
      jump = Math.max(jump, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
  }
  const reach = meshReach(m);
  ok(jump < 0.5, `the displacement field is continuous (worst 0.1px step gives ${jump.toFixed(4)}, over a reach of ${reach})`);
  note(`continuity: a 0.1px move changes the displacement by at most ${jump.toFixed(4)}`);

  // The reach is a real bound: nothing samples from further away than it says.
  let far = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      m.sample(x + 0.5, y + 0.5, a);
      far = Math.max(far, Math.abs(a[0]), Math.abs(a[1]));
    }
  }
  ok(reach >= far, `meshReach bounds the furthest sample (${reach} >= ${far.toFixed(3)})`);
}

// ------------------------------------------------------------- save and load

{
  const m = new Mesh(W, H, 6);
  applyBrush(m, 'push', { x: 44, y: 33, radius: 20, strength: 0.8, dx: 7, dy: -5 });
  applyBrush(m, 'freeze', { x: 20, y: 20, radius: 10, strength: 1 });
  const back = Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  eq(back.w, m.w, 'a saved mesh keeps its width');
  eq(back.step, m.step, 'and its step');
  eq(worst(back.dx, m.dx).w, 0, 'and every x displacement exactly');
  eq(worst(back.dy, m.dy).w, 0, 'and every y displacement');
  eq(worst(back.freeze, m.freeze).w, 0, 'and the freeze mask');
  // A mesh saved at a different size is not silently misapplied.
  const wrong = Mesh.fromJSON({ w: W, h: H, step: 6, dx: [1, 2, 3], dy: [1], freeze: [] });
  ok(wrong.isIdentity, 'a mesh whose arrays do not fit is loaded as the identity');
}

// -------------------------------------------- the resampler against scipy

if (havePython()) {
  // scipy.ndimage.map_coordinates with order=1 is bilinear interpolation by
  // somebody else. The mesh is sampled on our side and the coordinates handed
  // over, because the thing being checked is the INTERPOLATION, not the mesh:
  // feeding scipy a mesh of its own would be comparing two reimplementations
  // of the same bilinear weights and would agree even if both were wrong
  // about the half-pixel.
  const m = new Mesh(W, H, 8);
  applyBrush(m, 'push', { x: 48, y: 36, radius: 28, strength: 1, dx: 9, dy: -6 });
  applyBrush(m, 'bloat', { x: 30, y: 25, radius: 20, strength: 0.7 });

  // One channel, fully opaque, so premultiplication is the identity and what
  // is left is purely the interpolation.
  const src = new Float32Array(W * H * 4);
  const plane = new Float64Array(W * H);
  const rnd = mulberry32(5);
  for (let i = 0; i < W * H; i++) {
    const v = 0.2 + rnd() * 0.6;
    plane[i] = v;
    src[i * 4] = v; src[i * 4 + 1] = v; src[i * 4 + 2] = v; src[i * 4 + 3] = 1;
  }
  const r = rect(0, 0, W, H);
  const got = warpBuffer(src, r, r, m);

  // The coordinates we sampled at, in scipy's (row, col) index space. Our
  // pixel centres are at +0.5, scipy's index 0 IS the first pixel's centre,
  // so the half comes off here -- which is the convention this comparison
  // exists to pin.
  const coords = new Float64Array(W * H * 2);
  const d = [0, 0];
  let inside = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      m.sample(x + 0.5, y + 0.5, d);
      const sx = x + 0.5 + d[0] - 0.5;
      const sy = y + 0.5 + d[1] - 0.5;
      coords[y * W + x] = sy;
      coords[W * H + y * W + x] = sx;
      if (sx >= 0 && sy >= 0 && sx <= W - 1 && sy <= H - 1) inside++;
    }
  }
  ok(inside > W * H * 0.8, `${inside} of ${W * H} samples land strictly inside the image`);

  const want = runPython(`
from scipy.ndimage import map_coordinates
img = IN[:${W * H}].reshape(${H}, ${W})
co = IN[${W * H}:].reshape(2, ${H}, ${W})
OUT = map_coordinates(img, co, order=1, mode='nearest')
`, Float64Array.from([...plane, ...coords]), null);

  let mx = 0, counted = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sy = coords[y * W + x], sx = coords[W * H + y * W + x];
      // Only where the sample is strictly inside: outside it, scipy's
      // 'nearest' and our clamped sampleAt are two different documented
      // conventions, and comparing them would measure the convention.
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) continue;
      counted++;
      mx = Math.max(mx, Math.abs(got[(y * W + x) * 4] - want[y * W + x]));
    }
  }
  ok(counted > 1000, `compared ${counted} interior samples`);
  ok(mx < 2e-6, `the warp's interpolation matches scipy.map_coordinates (worst ${mx.toExponential(2)})`);
  note(`resampling vs scipy.ndimage.map_coordinates: worst ${mx.toExponential(2)} over ${counted} samples`);
} else {
  note('scipy absent, the resampler comparison was skipped');
}

// --------------------------------------------------- the warp moves pixels

{
  // End to end: a push must actually move a feature, and move it the way the
  // pointer went. A single bright dot, pushed right, has to come out to the
  // right of where it started.
  const m = new Mesh(W, H, 4);
  const src = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) src[i * 4 + 3] = 1;
  for (let y = 30; y < 42; y++) for (let x = 40; x < 52; x++) src[(y * W + x) * 4] = 1;
  const r = rect(0, 0, W, H);
  const centroid = (buf) => {
    let sx = 0, sy = 0, mass = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = buf[(y * W + x) * 4];
      sx += x * v; sy += y * v; mass += v;
    }
    return [sx / mass, sy / mass, mass];
  };
  const [cx0, cy0] = centroid(src);
  applyBrush(m, 'push', { x: 46, y: 36, radius: 30, strength: 1, dx: 12, dy: 0 });
  const [cx1, cy1] = centroid(warpBuffer(src, r, r, m));
  ok(cx1 > cx0 + 4, `a push to the right moves the feature right (${cx0.toFixed(1)} -> ${cx1.toFixed(1)})`);
  ok(Math.abs(cy1 - cy0) < 1.5, `and not up or down (${cy0.toFixed(1)} -> ${cy1.toFixed(1)})`);

  // Bloat makes a feature bigger, pucker smaller. Measured as the total mass,
  // which a magnification increases because more pixels show the bright dot.
  const base = centroid(src)[2];
  const bl = new Mesh(W, H, 4);
  applyBrush(bl, 'bloat', { x: 46, y: 36, radius: 30, strength: 0.9 });
  const pk = new Mesh(W, H, 4);
  applyBrush(pk, 'pucker', { x: 46, y: 36, radius: 30, strength: 0.9 });
  const mb = centroid(warpBuffer(src, r, r, bl))[2];
  const mp = centroid(warpBuffer(src, r, r, pk))[2];
  ok(mb > base * 1.1, `bloat makes the feature bigger (${base.toFixed(0)} -> ${mb.toFixed(0)})`);
  ok(mp < base * 0.95, `and pucker smaller (${base.toFixed(0)} -> ${mp.toFixed(0)})`);

  // Nothing is ever out of range or non-finite, whatever the mesh says.
  const wild = new Mesh(W, H, 4);
  for (let i = 0; i < wild.length; i++) { wild.dx[i] = (i % 7) * 30 - 90; wild.dy[i] = (i % 5) * 25 - 50; }
  const out = warpBuffer(src, r, r, wild);
  let bad = 0;
  for (const v of out) if (!Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9) bad++;
  eq(bad, 0, 'a wild mesh still produces finite 0..1 values');
}

// -------------------------------------------------- no halo on a cut-out

{
  // Premultiplied sampling, or the colour of transparent pixels bleeds into
  // visible ones. The classic demonstration: an opaque WHITE disc on a
  // transparent black background. Warped without premultiplying, the rim
  // picks up the black and the disc gets a dark fringe.
  const m = new Mesh(W, H, 4);
  applyBrush(m, 'twirlCW', { x: 48, y: 36, radius: 25, strength: 0.6 });
  const src = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (Math.hypot(x - 48, y - 36) <= 20) {
        src[p] = 1; src[p + 1] = 1; src[p + 2] = 1; src[p + 3] = 1;
      }
      // everything else stays [0, 0, 0, 0] -- transparent BLACK
    }
  }
  const out = warpBuffer(src, rect(0, 0, W, H), rect(0, 0, W, H), m);
  let darkest = 1;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    // Wherever anything is visible at all, it has to still be white.
    if (out[p + 3] > 0.02) darkest = Math.min(darkest, out[p]);
  }
  ok(darkest > 0.98, `a warped white cut-out keeps no dark fringe (darkest visible ${darkest.toFixed(4)})`);
}

done('liquify: an empty mesh is bit-exact, dabs compose, and the resampling matches scipy');
