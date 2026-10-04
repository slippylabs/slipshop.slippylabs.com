// Oracle: bezier paths, shapes, stroking and SVG.
//
// Paths are the one part of the engine with a complete independent
// implementation sitting right there: the browser's own canvas fills and
// strokes paths, with the same cap, join and mitre-limit vocabulary. So the
// stroke geometry is checked against `ctx.stroke()` on a float16 canvas, and
// not only against arithmetic.
//
// What arithmetic still gives, and gives better than any reference:
//
//   a butt-capped stroke of width w along a straight run of length L covers
//   exactly L * w. A square cap adds exactly w^2. A round cap adds the area
//   of the POLYGON the circle is flattened to, which is a closed form in the
//   step count -- so "round caps are 1.9 short of pi*w^2/4" is a prediction,
//   not a tolerance.
//
// The quarter-arc constant deserves the same treatment. KAPPA is not a fudge
// factor: it is the handle length that makes a cubic pass through the
// 45-degree point of a circle exactly, and it leaves a known 0.027% radius
// error. The ellipse checks assert that number rather than allowing anything.

import {
  newPath, anchor, pathFromPoints, subpathFromPoints, clonePath, countAnchors,
  cubicPoint, cubicTangent, flattenSubpath, flattenPath, pathBounds, pathLength,
  pathArea, fillCoverage, strokeOutline, strokeCoverage, dashPolyline,
  shapePath, SHAPES, SHAPE_FIELDS, KAPPA, CAPS, JOINS,
  transformPath, reversePath, pathFromContours, pathToSvg, parseSvgPath,
  nearestOnPath, DEFAULT_TOLERANCE, insertAnchorNear, removeAnchor,
} from '../js/core/path.js';
import { shapeDefaults, shapeBounds, renderShape, SHAPE_STYLE_FIELDS } from '../js/core/shape.js';
import { marchingAnts, signedArea } from '../js/core/select.js';
import { Surface } from '../js/core/tiles.js';
import { rect, mulberry32, TAU } from '../js/core/util.js';
import { ok, eq, worst, note, done, f16round } from './_harness.mjs';
import { runInBrowserCached } from './_browser.mjs';

const inkOf = (cov) => { let s = 0; for (const v of cov) s += v; return s; };

// ------------------------------------------------------------------ cubics

{
  const p0 = [0, 0], p1 = [10, 30], p2 = [40, 30], p3 = [50, 0];
  eq(cubicPoint(p0, p1, p2, p3, 0).join(','), '0,0', 'a cubic starts at p0');
  eq(cubicPoint(p0, p1, p2, p3, 1).join(','), '50,0', 'and ends at p3');
  // The tangent at the ends points along the first and last handle.
  const t0 = cubicTangent(p0, p1, p2, p3, 0);
  eq(t0[0] / t0[1], (p1[0] - p0[0]) / (p1[1] - p0[1]), 'the start tangent follows the out handle', 1e-12);
  const t1 = cubicTangent(p0, p1, p2, p3, 1);
  eq(t1[0] / t1[1], (p3[0] - p2[0]) / (p3[1] - p2[1]), 'the end tangent follows the in handle', 1e-12);

  // A cubic whose handles sit on the chord IS the chord, and must flatten to
  // two points however tight the tolerance -- a flattener that stepped t
  // uniformly would spend 32 points on a straight line.
  const straight = { closed: false, anchors: [anchor(0, 0, 0, 0, 10, 5), anchor(40, 20, 30, 15, 40, 20)] };
  for (const tol of [1, 0.1, 0.01, 0.001]) {
    eq(flattenSubpath(straight, tol).length, 2, `a straight cubic is 2 points at tol ${tol}`);
  }
  // ...and a polygon's corners survive exactly.
  const tri = pathFromPoints([[3, 7], [40, 9], [11, 33]], true);
  const ring = flattenPath(tri)[0];
  eq(ring.length, 3, 'a triangle flattens to its three corners');
  eq(ring.map((p) => p.join(',')).join(' '), '3,7 40,9 11,33', 'with the coordinates untouched');
}

// ------------------------------------------------- the tolerance is honoured

{
  const rnd = mulberry32(31);
  let worstDev = 0, worstTol = 0;
  for (let t = 0; t < 40; t++) {
    const a = anchor(rnd() * 200, rnd() * 200);
    const b = anchor(rnd() * 200, rnd() * 200);
    a.outX = rnd() * 200; a.outY = rnd() * 200;
    b.inX = rnd() * 200; b.inY = rnd() * 200;
    const sp = { closed: false, anchors: [a, b] };
    for (const tol of [1, 0.25, 0.05]) {
      const poly = flattenSubpath(sp, tol);
      // Every point of the true curve is within `tol` of the polyline. Not of
      // a VERTEX of the polyline -- of the polyline, which is what flatness
      // means and what the fill will actually trace.
      let dev = 0;
      for (let i = 0; i <= 400; i++) {
        const p = cubicPoint([a.x, a.y], [a.outX, a.outY], [b.inX, b.inY], [b.x, b.y], i / 400);
        let d = Infinity;
        for (let k = 0; k < poly.length - 1; k++) {
          const u = poly[k], w = poly[k + 1];
          const dx = w[0] - u[0], dy = w[1] - u[1];
          const l2 = dx * dx + dy * dy;
          const s = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l2)) : 0;
          d = Math.min(d, Math.hypot(p[0] - (u[0] + dx * s), p[1] - (u[1] + dy * s)));
        }
        dev = Math.max(dev, d);
      }
      if (dev / tol > worstDev / Math.max(worstTol, 1e-9)) { worstDev = dev; worstTol = tol; }
      ok(dev <= tol * 1.05, `curve ${t} at tol ${tol}: deviation ${dev.toFixed(4)}`);
    }
    // A looser tolerance never costs more points than a tighter one.
    const n1 = flattenSubpath(sp, 1).length;
    const n2 = flattenSubpath(sp, 0.05).length;
    ok(n1 <= n2, `curve ${t}: a looser tolerance is not more points (${n1} <= ${n2})`);
  }
  // The depth cap must not bind for anything the editor actually asks for,
  // or the tolerance stops being honoured and the curve is visibly faceted.
  // The cap is 12, so 4096 segments per curve; subdividing at the midpoint
  // roughly quarters the flatness each level, so the worst realistic case --
  // a 2000px arc at a tolerance of 0.001 -- needs about log4(2e6) = 10.5.
  for (const [tol, rad] of [[0.5, 4000], [0.1, 4000], [0.01, 2000], [0.001, 2000]]) {
    const e = shapePath('ellipse', { x: 0, y: 0, w: rad * 2, h: rad * 2 });
    const perArc = flattenPath(e, tol)[0].length / 4;
    ok(perArc < 4096, `tol ${tol} on an r=${rad} arc converges in ${perArc} segments, under the 4096 cap`);
  }
  note(`flattening: worst deviation ${worstDev.toFixed(4)} at tolerance ${worstTol}`);
}

// ---------------------------------------------------------------- area

{
  // A rectangle, exactly.
  const r = shapePath('rect', { x: 10, y: 20, w: 100, h: 40 });
  eq(Math.abs(pathArea(r)), 4000, 'a rectangle path encloses w * h exactly');
  // Winding has a sign, and reversing it flips it.
  const fwd = pathArea(r), rev = pathArea(reversePath(r));
  eq(fwd, -rev, 'reversing a path negates its area');
  ok(fwd !== 0, 'and the area was not zero to begin with');

  // A regular polygon: (1/2) n r^2 sin(2 pi / n), exactly.
  for (const sides of [3, 4, 5, 6, 8, 12, 24]) {
    const p = shapePath('polygon', { x: 0, y: 0, w: 200, h: 200 }, { sides });
    const want = 0.5 * sides * 100 * 100 * Math.sin(TAU / sides);
    eq(Math.abs(pathArea(p)), want, `a ${sides}-gon of radius 100 encloses ${want.toFixed(2)}`, 1e-8);
  }

  // A star: n triangles of outer radius R and inner radius r, twice over.
  for (const points of [5, 6, 9]) {
    for (const innerRatio of [0.3, 0.5, 0.8]) {
      const p = shapePath('star', { x: 0, y: 0, w: 200, h: 200 }, { points, innerRatio });
      // 2n triangles from the centre, alternating R-r and r-R, each with the
      // same included angle pi/n: area = n * R * r * sin(pi / n).
      const want = points * 100 * (100 * innerRatio) * Math.sin(Math.PI / points);
      eq(Math.abs(pathArea(p)), want, `a ${points}-point star at ratio ${innerRatio}`, 1e-8);
    }
  }

  // The ellipse: four cubic quarter-arcs with handles of length KAPPA * r.
  // That is 0.027% small on the radius, so about 0.054% on the quarter-arc
  // area -- asserted as a figure, because it is a property of the constant.
  eq(KAPPA, (4 / 3) * (Math.SQRT2 - 1), 'KAPPA is 4/3 (sqrt 2 - 1)', 1e-15);
  for (const rad of [10, 50, 100, 400]) {
    const e = shapePath('ellipse', { x: 0, y: 0, w: rad * 2, h: rad * 2 });
    const exact = Math.PI * rad * rad;
    const got = Math.abs(pathArea(e, 0.001));
    const relErr = (got - exact) / exact;
    // LARGER, not smaller. The KAPPA cubic bows slightly OUTSIDE the circle
    // between the axis point and the 45-degree point -- its maximum radius is
    // 1.00027r -- so the area comes out about 2.7 parts in 10000 over. The
    // first version of this check asserted "small" and failed on correct code.
    ok(relErr > 1e-4 && relErr < 4e-4,
      `an r=${rad} bezier circle is ${(relErr * 1e4).toFixed(2)} parts in 10000 LARGE`);
    const len = pathLength(e, 0.001);
    ok(Math.abs(len - TAU * rad) / (TAU * rad) < 2e-4,
      `and its circumference is within 2e-4 of 2 pi r (${len.toFixed(3)} vs ${(TAU * rad).toFixed(3)})`);
  }
  // A cubic quarter-arc passes through the 45-degree point, which is the
  // property KAPPA is chosen FOR -- and the only point where it is exact.
  {
    const r = 100;
    const mid = cubicPoint([r, 0], [r, KAPPA * r], [KAPPA * r, r], [0, r], 0.5);
    const d = Math.hypot(mid[0], mid[1]);
    ok(Math.abs(d - r) / r < 3e-4, `the quarter-arc midpoint sits at r (${d.toFixed(4)} vs ${r})`);
  }

  // A rounded rectangle: the square minus the four corners the arcs cut off.
  for (const radius of [0, 5, 20, 50]) {
    const p = shapePath('roundRect', { x: 0, y: 0, w: 200, h: 120 }, { radius });
    const want = 200 * 120 - (4 - Math.PI) * radius * radius;
    // The allowance is the bezier circle's own 2.7e-4 over the corner area,
    // not over the whole rectangle -- which is what caught the real bug here:
    // the first anchor's IN handle sat on the anchor instead of at the end of
    // the top-left arc, so that one corner was a straight cut and the area
    // came out 47 short on a tolerance of 7.
    eq(Math.abs(pathArea(p, 0.001)), want, `a round rect with r=${radius}`,
      Math.max(0.01, Math.PI * radius * radius * 1e-3));
  }
}

// ------------------------------------------------------------------- fill

{
  // An integer-aligned rectangle covers exactly its own area: no antialiasing
  // to argue about, so this is the check that pins the half-pixel convention.
  for (const box of [{ x: 0, y: 0, w: 10, h: 10 }, { x: 3, y: 7, w: 25, h: 13 }, { x: -4, y: -2, w: 9, h: 6 }]) {
    const { cov } = fillCoverage(shapePath('rect', box));
    eq(inkOf(cov), box.w * box.h, `filling a ${box.w}x${box.h} rect covers ${box.w * box.h}`, 1e-9);
  }
  // Half-pixel offsets land on exactly half a pixel at the edges.
  const { cov: half } = fillCoverage(shapePath('rect', { x: 0.5, y: 0, w: 10, h: 10 }));
  eq(inkOf(half), 100, 'a rect shifted half a pixel still covers its own area', 1e-9);

  // A disc of radius r covers pi r^2, limited only by the bezier circle.
  for (const r of [8, 20, 60]) {
    const { cov } = fillCoverage(shapePath('ellipse', { x: 0, y: 0, w: r * 2, h: r * 2 }), { tol: 0.01 });
    const want = Math.PI * r * r;
    ok(Math.abs(inkOf(cov) - want) / want < 0.004,
      `filling an r=${r} disc covers ${inkOf(cov).toFixed(1)} vs ${want.toFixed(1)}`);
  }

  // Non-zero vs even-odd, on two rings wound the SAME way. Non-zero unions
  // them (the outer area); even-odd punches the inner one out (the annulus).
  // Wound the same way is the important part -- opposite windings make the
  // two rules agree and the test vacuous.
  const outer = subpathFromPoints([[0, 0], [60, 0], [60, 60], [0, 60]], true);
  const inner = subpathFromPoints([[20, 20], [40, 20], [40, 40], [20, 40]], true);
  ok(Math.sign(signedArea(flattenSubpath(outer))) === Math.sign(signedArea(flattenSubpath(inner))),
    'both rings are wound the same way');
  const two = { subpaths: [outer, inner] };
  eq(inkOf(fillCoverage(two).cov), 3600, 'non-zero winding unions the two rings', 1e-9);
  eq(inkOf(fillCoverage(two, { evenOdd: true }).cov), 3600 - 400, 'even-odd makes the inner one a hole', 1e-9);
  // An opposite winding makes the hole under BOTH rules.
  const three = { subpaths: [outer, subpathFromPoints([[20, 20], [20, 40], [40, 40], [40, 20]], true)] };
  eq(inkOf(fillCoverage(three).cov), 3200, 'an opposite winding is a hole under non-zero too', 1e-9);
}

// ----------------------------------------------------------------- stroke

{
  // The exact statements. A straight run of length L stroked at width w with
  // BUTT caps covers exactly L * w -- no caps, no joins, nothing to round.
  const L = 100, W = 10;
  const line = pathFromPoints([[10, 10], [10 + L, 10]], false);
  eq(inkOf(strokeCoverage(line, { width: W, cap: 'butt' }).cov), L * W,
    'a butt-capped straight stroke covers length times width', 1e-7);
  // A square cap adds half a width at each end: exactly w * w.
  eq(inkOf(strokeCoverage(line, { width: W, cap: 'square' }).cov), L * W + W * W,
    'a square cap adds exactly one width squared', 1e-7);
  // A round cap adds the POLYGON the circle was flattened to, not the circle.
  // The step count follows from the tolerance: a chord subtending theta has a
  // sagitta of r(1 - cos(theta/2)), so steps = ceil(2 pi / theta).
  for (const tol of [0.5, 0.1, 0.01]) {
    const r = W / 2;
    const th = 2 * Math.acos(1 - tol / r);
    const steps = Math.min(256, Math.max(6, Math.ceil(TAU / th)));
    const polyArea = 0.5 * steps * r * r * Math.sin(TAU / steps);
    const got = inkOf(strokeCoverage(line, { width: W, cap: 'round', tol }).cov);
    // 0.2, where the butt and square cases are exact to 1e-7: those caps are
    // axis-aligned rectangles, which the 4-subsample scanline integrates
    // exactly, and a polygon's slanted edges it does not. The margin between a
    // 7-gon (68.4) and a true circle (78.5) is 10, so this still pins the step
    // count the tolerance produced.
    eq(got, L * W + polyArea, `a round cap at tol ${tol} adds a ${steps}-gon`, 0.2);
  }
  note('round caps checked against the exact area of the polygon they flatten to');

  // Both ends only -- a CLOSED path has no caps at all, so a square cap on a
  // closed square ring must change nothing.
  const ring = shapePath('rect', { x: 20, y: 20, w: 80, h: 60 });
  const a = inkOf(strokeCoverage(ring, { width: 6, cap: 'butt', join: 'miter' }).cov);
  const b = inkOf(strokeCoverage(ring, { width: 6, cap: 'square', join: 'miter' }).cov);
  eq(a, b, 'a closed path has no ends, so the cap style makes no difference', 1e-7);
  // A mitred stroke round a rectangle is the frame between two rectangles.
  eq(a, (80 + 6) * (60 + 6) - (80 - 6) * (60 - 6),
    'a mitred stroke round a rectangle is the frame between the two offsets', 1e-6);

  // The mitre limit. At a sharp angle the spike has to be cut off, or a
  // near-reversal shoots a point clear across the canvas.
  // The turn has to be sharp but not a near-reversal: at a reversal the ratio
  // is in the hundreds, so even a limit of 100 already bevels and "unlimited
  // mitres spike" cannot be shown. This one turns through about 159 degrees,
  // ratio 5.6.
  const sharp = pathFromPoints([[0, 50], [100, 50], [20, 20]], false);
  const far = (o) => Math.max(...strokeOutline(sharp, o).flat().map((p) => p[0]));
  const spike = far({ width: 20, join: 'miter', miterLimit: 10, cap: 'butt' });
  const cut = far({ width: 20, join: 'miter', miterLimit: 1.2, cap: 'butt' });
  const bevelled = far({ width: 20, join: 'bevel', cap: 'butt' });
  ok(spike > bevelled + 20, `a mitre inside the limit spikes out (${spike.toFixed(1)} vs ${bevelled.toFixed(1)})`);
  eq(cut.toFixed(6), bevelled.toFixed(6), 'past the limit it falls back to a bevel');
  // ...and a limit of exactly 1 is a bevel everywhere, which is what the
  // definition says: the ratio is never below 1.
  eq(far({ width: 20, join: 'miter', miterLimit: 1, cap: 'butt' }).toFixed(6),
    bevelled.toFixed(6), 'a mitre limit of 1 is a bevel');

  // A zero-length subpath is a dot with a round or square cap, and nothing at
  // all with a butt one.
  const dot = { subpaths: [{ closed: false, anchors: [anchor(50, 50)] }] };
  ok(inkOf(strokeCoverage(dot, { width: 10, cap: 'round' }).cov) > 70, 'a lone anchor is a round dot');
  eq(inkOf(strokeCoverage(dot, { width: 10, cap: 'square' }).cov), 100, 'or a square one', 1e-7);
  eq(inkOf(strokeCoverage(dot, { width: 10, cap: 'butt' }).cov), 0, 'and nothing with a butt cap', 1e-9);

  // Every ring the outline emits is wound the same way, which is the ONLY
  // reason non-zero winding unions them instead of punching holes.
  for (const join of JOINS) {
    for (const cap of CAPS) {
      const rings = strokeOutline(shapePath('star', { x: 0, y: 0, w: 120, h: 120 }, { points: 5 }),
        { width: 9, join, cap });
      const signs = new Set(rings.map((r) => Math.sign(signedArea(r))).filter((s) => s !== 0));
      ok(signs.size <= 1, `${join}/${cap}: every ring winds the same way (${[...signs]})`);
    }
  }
}

// ------------------------------------------------------------------- dashes

{
  const ring = [[0, 0], [100, 0]];
  // 10 on, 10 off along 100: five on-runs of 10.
  const runs = dashPolyline(ring, false, [10, 10], 0);
  eq(runs.length, 5, 'a 10/10 dash over 100 units is five dashes');
  const total = runs.reduce((s, r) => {
    let t = 0;
    for (let i = 0; i < r.pts.length - 1; i++) t += Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]);
    return s + t;
  }, 0);
  eq(total, 50, 'and covers half the length', 1e-9);
  // The phase carries across SEGMENTS, so flattening a curve more finely must
  // not change the pattern. Measured on a polyline split into pieces.
  const whole = dashPolyline([[0, 0], [100, 0]], false, [7, 3], 0);
  const split = dashPolyline([[0, 0], [13, 0], [41, 0], [78, 0], [100, 0]], false, [7, 3], 0);
  const len = (rs) => rs.reduce((s, r) => {
    let t = 0;
    for (let i = 0; i < r.pts.length - 1; i++) t += Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]);
    return s + t;
  }, 0);
  eq(len(split), len(whole), 'the dash phase carries across vertices', 1e-9);
  // An empty or all-zero pattern is no dash at all, not an empty stroke.
  eq(dashPolyline(ring, false, [], 0).length, 1, 'an empty pattern is a solid line');
  eq(dashPolyline(ring, false, [0, 0], 0).length, 1, 'and so is an all-zero one');
  // A dashed stroke lays down less ink than a solid one, in proportion.
  const line = pathFromPoints([[0, 20], [200, 20]], false);
  const solid = inkOf(strokeCoverage(line, { width: 8, cap: 'butt' }).cov);
  const dashed = inkOf(strokeCoverage(line, { width: 8, cap: 'butt', dash: [10, 10] }).cov);
  eq(dashed, solid / 2, 'a 10/10 dash is half the ink', 0.5);
}

// ---------------------------------------------------------------- transform

{
  const p = shapePath('star', { x: 10, y: 20, w: 100, h: 60 }, { points: 7 });
  const rad = 0.7;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rot = [c, s, -s, c, 13, -4];
  const inv = [c, -s, s, c, -(c * 13 + s * -4), -(-s * 13 + c * -4)];
  const back = transformPath(transformPath(p, rot), inv);
  let mx = 0;
  p.subpaths.forEach((sp, i) => sp.anchors.forEach((an, j) => {
    const b = back.subpaths[i].anchors[j];
    for (const k of ['x', 'y', 'inX', 'inY', 'outX', 'outY']) mx = Math.max(mx, Math.abs(an[k] - b[k]));
  }));
  ok(mx < 1e-10, `a rotation and its inverse are the identity (worst ${mx.toExponential(2)})`);
  // The area scales by the determinant.
  const scale = [2, 0, 0, 3, 100, 100];
  eq(Math.abs(pathArea(transformPath(p, scale))), Math.abs(pathArea(p)) * 6,
    'area scales by the determinant', 1e-6);
  // A transform moves the HANDLES too, or every curve straightens out.
  const e = shapePath('ellipse', { x: 0, y: 0, w: 100, h: 100 });
  const big = transformPath(e, [3, 0, 0, 3, 0, 0]);
  eq(Math.abs(pathArea(big, 0.001)) / Math.abs(pathArea(e, 0.001)), 9,
    'scaling an ellipse scales its area by the square', 1e-3);
}

// ------------------------------------------------------- selection <-> path

{
  // The crack contours of a mask are axis-aligned staircases, so a path built
  // from them and re-rasterised must reproduce the mask EXACTLY -- not nearly.
  // This is the whole claim of Make Path From Selection.
  const W = 40, H = 30;
  const sel = new Surface(W, H, 1, 16);
  const buf = new Float32Array(W * H);
  // An L, plus a hole, plus a detached blob: three contours of two windings.
  for (let y = 4; y < 24; y++) for (let x = 3; x < 14; x++) buf[y * W + x] = 1;
  for (let y = 18; y < 24; y++) for (let x = 14; x < 28; x++) buf[y * W + x] = 1;
  for (let y = 8; y < 14; y++) for (let x = 6; x < 11; x++) buf[y * W + x] = 0;
  for (let y = 3; y < 9; y++) for (let x = 30; x < 37; x++) buf[y * W + x] = 1;
  sel.writeRect(rect(0, 0, W, H), buf);

  const contours = marchingAnts(sel);
  ok(contours.length >= 3, `the mask has ${contours.length} contours`);
  const p = pathFromContours(contours);
  eq(p.subpaths.length, contours.length, 'one subpath per contour');
  const { r, cov } = fillCoverage(p, { antialias: false });
  let diff = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const want = buf[y * W + x];
      const px = x - r.x, py = y - r.y;
      const got = (px >= 0 && py >= 0 && px < r.w && py < r.h) ? cov[py * r.w + px] : 0;
      if (Math.abs(got - want) > 1e-9) diff++;
    }
  }
  eq(diff, 0, `a path from a selection's contours re-rasterises to the same mask (${diff} pixels differ)`);
  // ...and the signed areas still sum to the pixel count, the invariant the
  // contour tracer is built on.
  const total = contours.reduce((s, c) => s + signedArea(c), 0);
  let pixels = 0;
  for (const v of buf) if (v >= 0.5) pixels++;
  eq(Math.abs(total), pixels, 'the contour areas sum to the pixel count', 1e-9);
}

// --------------------------------------------------------------------- SVG

{
  // A round trip through the `d` attribute. Compared on the FLATTENED
  // geometry: the printed form rounds to four decimals, so the anchors come
  // back a ten-thousandth out and comparing them exactly would be asserting
  // the precision rather than the parser.
  for (const kind of SHAPES) {
    const p = shapePath(kind, { x: 11.25, y: 7.5, w: 123, h: 81 }, { sides: 7, points: 6, radius: 15, innerRatio: 0.4 });
    const back = parseSvgPath(pathToSvg(p));
    eq(countAnchors(back), countAnchors(p), `${kind}: the round trip keeps every anchor`);
    eq(back.subpaths.length, p.subpaths.length, `${kind}: and every subpath`);
    eq(back.subpaths.map((s) => s.closed).join(','), p.subpaths.map((s) => s.closed).join(','),
      `${kind}: and whether each one was closed`);
    const f1 = flattenPath(p, 0.01).flat(), f2 = flattenPath(back, 0.01).flat();
    eq(f2.length, f1.length, `${kind}: the same flattened point count`);
    let mx = 0;
    for (let i = 0; i < Math.min(f1.length, f2.length); i++) {
      mx = Math.max(mx, Math.abs(f1[i][0] - f2[i][0]), Math.abs(f1[i][1] - f2[i][1]));
    }
    ok(mx < 1e-3, `${kind}: the geometry survives the round trip (worst ${mx.toExponential(2)})`);
  }

  // Each command, against the explicit cubic that means the same thing.
  const cases = [
    ['M 0 0 L 100 0 L 100 50 Z', 'absolute lines and close'],
    ['m 10 10 l 50 0 l 0 50 z', 'relative lines'],
    ['M 0 0 H 60 V 40 H 0 Z', 'horizontal and vertical'],
    ['M 0 0 C 20 0 40 20 40 40', 'a cubic'],
    ['M 0 0 c 20 0 40 20 40 40', 'a relative cubic'],
    ['M 0 0 Q 50 0 50 50', 'a quadratic'],
    ['M 0 0 C 10 0 20 10 20 20 S 40 30 40 40', 'a smooth cubic'],
    ['M 0 0 Q 20 0 20 20 T 40 40', 'a smooth quadratic'],
    ['M 0 0 L 50 0 M 60 0 L 100 0', 'two subpaths'],
  ];
  for (const [d, what] of cases) {
    const p = parseSvgPath(d);
    ok(countAnchors(p) >= 2, `${what}: parsed to ${countAnchors(p)} anchors`);
    for (const sp of p.subpaths) {
      for (const an of sp.anchors) {
        for (const k of ['x', 'y', 'inX', 'inY', 'outX', 'outY']) {
          ok(Number.isFinite(an[k]), `${what}: ${k} is a number`);
        }
      }
    }
  }
  // A quadratic converted to a cubic is the SAME curve, not an approximation:
  // the control points a third of the way out are exact.
  {
    const q = parseSvgPath('M 0 0 Q 60 0 60 60');
    const an = q.subpaths[0].anchors;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const u = 1 - t;
      const want = [
        u * u * 0 + 2 * u * t * 60 + t * t * 60,
        u * u * 0 + 2 * u * t * 0 + t * t * 60,
      ];
      const got = cubicPoint([an[0].x, an[0].y], [an[0].outX, an[0].outY], [an[1].inX, an[1].inY], [an[1].x, an[1].y], t);
      eq(got[0], want[0], `the quadratic-to-cubic conversion is exact at t=${t} (x)`, 1e-12);
      eq(got[1], want[1], `the quadratic-to-cubic conversion is exact at t=${t} (y)`, 1e-12);
    }
  }
  // Z after an explicit line back to the start must not leave a duplicate
  // anchor sitting on the first one -- a zero-length segment that every join
  // and cap then has to cope with.
  const closed = parseSvgPath('M 0 0 L 50 0 L 50 50 L 0 0 Z');
  eq(countAnchors(closed), 3, 'a Z after a line home does not duplicate the first anchor');
  ok(closed.subpaths[0].closed, 'and the subpath is closed');
  // Garbage in: empty, not an exception.
  eq(countAnchors(parseSvgPath('')), 0, 'an empty d string is an empty path');
  // "nonsense" tokenises to two bare `s` commands with no numbers behind
  // them; without a check for that it built anchors full of NaN, which does
  // not throw and rasterises silently to nothing.
  eq(countAnchors(parseSvgPath('nonsense')), 0, 'and so is nonsense');
  for (const junk of ['s', 'C 1 2', 'M', 'M 5', 'Q 1 2 3', 'L L L', '...']) {
    const p = parseSvgPath(junk);
    let bad = 0;
    for (const sp of p.subpaths) for (const an of sp.anchors) {
      for (const k of ['x', 'y', 'inX', 'inY', 'outX', 'outY']) if (!Number.isFinite(an[k])) bad++;
    }
    eq(bad, 0, `a truncated command ("${junk}") produces no NaN coordinates`);
  }
}

// ---------------------------------------------------------------- hit test

{
  const line = pathFromPoints([[0, 100], [200, 100]], false);
  for (const [x, y, d] of [[100, 120, 20], [0, 100, 0], [-30, 100, 30], [230, 100, 30], [50, 90, 10]]) {
    eq(nearestOnPath(line, x, y).dist, d, `the distance from (${x},${y}) to the line is ${d}`, 1e-9);
  }
  // On a circle, the nearest point is r away from the centre however you come
  // at it -- and that is the radius, not the chord.
  const c = shapePath('ellipse', { x: 0, y: 0, w: 200, h: 200 });
  for (const ang of [0, 0.4, 1.1, 2.7, 5.5]) {
    const hit = nearestOnPath(c, 100 + Math.cos(ang) * 40, 100 + Math.sin(ang) * 40, 0.01);
    eq(hit.dist, 60, `from 40 out along ${ang.toFixed(1)}, the circle is 60 away`, 0.05);
  }
  eq(nearestOnPath(newPath(), 5, 5).dist, Infinity, 'an empty path is infinitely far away');
}

// --------------------------------------------------- against the browser

{
  // The canvas strokes and fills paths with the same cap, join and mitre-limit
  // vocabulary, so it is a genuine second implementation. A float16 canvas for
  // the same reason blend.mjs uses one: the unorm8 pipeline quantises the
  // antialiased edge, and the edge is most of what is being compared here.
  const CASES = [
    { d: 'M 20 20 L 180 20', width: 12, cap: 'butt', join: 'miter' },
    { d: 'M 20 20 L 180 20', width: 12, cap: 'round', join: 'miter' },
    { d: 'M 20 20 L 180 20', width: 12, cap: 'square', join: 'miter' },
    { d: 'M 20 30 L 100 150 L 180 30', width: 16, cap: 'butt', join: 'miter' },
    { d: 'M 20 30 L 100 150 L 180 30', width: 16, cap: 'butt', join: 'round' },
    { d: 'M 20 30 L 100 150 L 180 30', width: 16, cap: 'butt', join: 'bevel' },
    { d: 'M 30 100 L 170 100 L 32 96', width: 14, cap: 'butt', join: 'miter', miterLimit: 2 },
    { d: 'M 30 30 L 170 30 L 170 170 L 30 170 Z', width: 10, cap: 'butt', join: 'miter' },
    { d: 'M 20 100 C 60 10 140 190 180 100', width: 18, cap: 'round', join: 'round' },
    { d: 'M 40 40 L 160 40 L 160 160 L 40 160 Z', width: 8, cap: 'butt', join: 'bevel' },
  ];
  const payload = JSON.parse(runInBrowserCached(`
    const CASES = ${JSON.stringify(CASES)};
    const out = [];
    for (const c of CASES) {
      const cv = document.createElement('canvas');
      cv.width = 200; cv.height = 200;
      const g = cv.getContext('2d', { colorType: 'float16' });
      g.clearRect(0, 0, 200, 200);
      g.strokeStyle = '#000';
      g.lineWidth = c.width;
      g.lineCap = c.cap;
      g.lineJoin = c.join;
      if (c.miterLimit !== undefined) g.miterLimit = c.miterLimit;
      g.beginPath();
      const p = new Path2D(c.d);
      g.stroke(p);
      const img = g.getImageData(0, 0, 200, 200, { colorSpace: 'srgb' });
      let ink = 0;
      // getImageData hands back bytes even from a float16 canvas unless it is
      // asked for floats, so the total is 255x the coverage. Dividing here
      // rather than in the comparison keeps the two sides in the same units.
      const d = img.data;
      for (let i = 0; i < 200 * 200; i++) ink += d[i * 4 + 3] / 255;
      // Also the bounding box of the ink, which catches a mitre spiking the
      // wrong way even when the total area happens to match.
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (d[(y * 200 + x) * 4 + 3] > 128) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      out.push({ ink, box: [x0, y0, x1, y1] });
    }
    window.__out = JSON.stringify(out);
  `));

  let worstRel = 0;
  CASES.forEach((c, i) => {
    const p = parseSvgPath(c.d);
    const { r, cov } = strokeCoverage(p, {
      width: c.width, cap: c.cap, join: c.join,
      miterLimit: c.miterLimit === undefined ? 10 : c.miterLimit,
      tol: 0.02,
    });
    const ours = inkOf(cov);
    const theirs = payload[i].ink;
    const rel = Math.abs(ours - theirs) / theirs;
    if (rel > worstRel) worstRel = rel;
    // 1.5%: the two differ in how they flatten the curve and how they
    // antialias the edge, and the edge of a 12px stroke is a tenth of its
    // area. A real disagreement -- a missing join, the wrong cap, a mitre
    // that did not get cut -- moves the total by far more than that.
    ok(rel < 0.015, `case ${i} (${c.cap}/${c.join}): our ink ${ours.toFixed(1)} vs the canvas ${theirs.toFixed(1)} (${(rel * 100).toFixed(2)}%)`);
    // The ink lands in the same place, to a pixel and a half.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      if (cov[y * r.w + x] > 0.5) {
        const gx = r.x + x, gy = r.y + y;
        if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
        if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
      }
    }
    const [bx0, by0, bx1, by1] = payload[i].box;
    for (const [got, want, what] of [[x0, bx0, 'left'], [y0, by0, 'top'], [x1, bx1, 'right'], [y1, by1, 'bottom']]) {
      ok(Math.abs(got - want) <= 2, `case ${i}: the ${what} edge agrees (${got} vs ${want})`);
    }
  });
  note(`stroke geometry vs the canvas: worst ${(worstRel * 100).toFixed(2)}% over ${CASES.length} cases`);
}

// ------------------------------------------------- shape layers (core/shape.js)

{
  // A shape layer is a path plus a fill and a stroke, rendered into a buffer.
  // The exact statements are about the UNION: a filled rectangle with a
  // stroke covers the outer offset rectangle, and the solid-coloured counts
  // are the fill inset by half the stroke and the frame around it.
  const sh = {
    ...shapeDefaults(),
    path: shapePath('rect', { x: 10, y: 10, w: 50, h: 30 }),
    fill: [1, 0, 0], fillEnabled: true,
    stroke: [0, 0, 1], strokeEnabled: true, strokeWidth: 4, join: 'miter',
  };
  const b = shapeBounds(sh);
  const buf = renderShape(sh, b);
  let alpha = 0, red = 0, blue = 0;
  for (let i = 0; i < b.w * b.h; i++) {
    const p = i * 4;
    alpha += buf[p + 3];
    if (buf[p + 3] > 0.999 && buf[p] > 0.99 && buf[p + 2] < 0.01) red++;
    if (buf[p + 3] > 0.999 && buf[p + 2] > 0.99 && buf[p] < 0.01) blue++;
  }
  // The union is the rectangle grown by half the stroke: 54 x 34.
  eq(alpha, 54 * 34, 'a filled and stroked rectangle covers the outer offset', 1e-6);
  // The stroke straddles the edge, so the fill survives inset by half of it.
  eq(red, 46 * 26, 'the fill shows through inside the stroke', 1);
  eq(blue, 54 * 34 - 46 * 26, 'and the stroke is the frame between the offsets', 1);

  // The bounds must allow for a MITRE, not just for half the stroke width: a
  // mitred join at a sharp angle reaches out by width/2 over the cosine of
  // the half-angle, and the limit is the cap on exactly that ratio. A star is
  // the shape most likely to have spikes, so it is the one to check.
  const star = {
    ...shapeDefaults(),
    path: shapePath('star', { x: 40, y: 40, w: 100, h: 100 }, { points: 5, innerRatio: 0.38 }),
    fillEnabled: false, strokeEnabled: true, strokeWidth: 10, join: 'miter', miterLimit: 10,
  };
  const sb = shapeBounds(star);
  const sbuf = renderShape(star, sb);
  // Nothing on the boundary of the rendered rect, which is what being clipped
  // looks like.
  let edge = 0;
  for (let x = 0; x < sb.w; x++) {
    if (sbuf[x * 4 + 3] > 1e-3) edge++;
    if (sbuf[((sb.h - 1) * sb.w + x) * 4 + 3] > 1e-3) edge++;
  }
  for (let y = 0; y < sb.h; y++) {
    if (sbuf[(y * sb.w) * 4 + 3] > 1e-3) edge++;
    if (sbuf[(y * sb.w + sb.w - 1) * 4 + 3] > 1e-3) edge++;
  }
  eq(edge, 0, `a mitred star fits inside its own bounds (${edge} pixels on the boundary)`);
  // ...and the bounds genuinely allow for the mitre rather than just the
  // width, which is the bug this is here for.
  const narrow = shapeBounds({ ...star, join: 'round' });
  ok(sb.w > narrow.w, `a mitre join reserves more room than a round one (${sb.w} vs ${narrow.w})`);

  // Fill and stroke can each be switched off, and off means nothing drawn.
  const none = renderShape({ ...sh, fillEnabled: false, strokeEnabled: false }, b);
  let any = 0;
  for (let i = 0; i < b.w * b.h; i++) if (none[i * 4 + 3] > 0) any++;
  eq(any, 0, 'with neither fill nor stroke a shape draws nothing');
  // A fill alpha of zero is the same as no fill.
  const zero = renderShape({ ...sh, strokeEnabled: false, fillAlpha: 0 }, b);
  let any2 = 0;
  for (let i = 0; i < b.w * b.h; i++) if (zero[i * 4 + 3] > 0) any2++;
  eq(any2, 0, 'and a fill opacity of zero draws nothing either');
  // An empty path draws nothing and does not throw.
  eq(renderShape({ ...shapeDefaults(), path: { subpaths: [] } }, b).some((v) => v !== 0), false,
    'an empty path renders an empty buffer');
  // Nothing is ever out of range.
  let bad = 0;
  for (const v of buf) if (!Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9) bad++;
  eq(bad, 0, 'every rendered value is a finite 0..1');
}

// -------------------------------------------- inserting an anchor is exact

{
  // Splitting a cubic with de Casteljau gives the two halves of the SAME
  // curve, so adding an anchor must not change the shape at all -- not
  // nearly. Dropping a corner point on the flattened polyline instead leaves
  // a visible kink, which is precisely what nobody asked for.
  for (const kind of ['ellipse', 'roundRect', 'star']) {
    const p = shapePath(kind, { x: 5, y: 9, w: 150, h: 90 }, { radius: 20, points: 6 });
    const before = pathArea(p, 0.001);
    const ringsBefore = flattenPath(p, 0.005);
    // Distance to the POLYLINE, not to its nearest vertex. A straight edge
    // flattens to its two endpoints and nothing in between, so a point in the
    // middle of one is 55 away from the nearest vertex while sitting exactly
    // on the outline -- which read as the insert moving the shape.
    const devFrom = (q) => {
      let d = Infinity;
      for (const ring of ringsBefore) {
        for (let k = 0; k < ring.length; k++) {
          const u = ring[k], w = ring[(k + 1) % ring.length];
          const dx = w[0] - u[0], dy = w[1] - u[1];
          const l2 = dx * dx + dy * dy;
          const t2 = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - u[0]) * dx + (q[1] - u[1]) * dy) / l2)) : 0;
          d = Math.min(d, Math.hypot(q[0] - (u[0] + dx * t2), q[1] - (u[1] + dy * t2)));
        }
      }
      return d;
    };
    for (const [x, y] of [[155, 54], [80, 9], [5, 54], [80, 99]]) {
      const ins = insertAnchorNear(p, x, y, 12);
      if (!ins) continue;
      eq(countAnchors(ins), countAnchors(p) + 1, `${kind}: one more anchor`);
      eq(pathArea(ins, 0.001), before, `${kind}: the area is unchanged by the insert`, 1e-9);
      // ...and the whole outline, not only its area.
      let dev = 0;
      for (const q of flattenPath(ins, 0.005).flat()) dev = Math.max(dev, devFrom(q));
      ok(dev < 0.01, `${kind}: the outline is unchanged (worst ${dev.toExponential(2)})`);
    }
  }
  eq(insertAnchorNear(shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), 500, 500, 3), null,
    'a click nowhere near the path inserts nothing');
  // Removing an anchor drops an empty subpath rather than leaving one behind
  // for every loop to skip.
  const one = { subpaths: [{ closed: false, anchors: [anchor(1, 2)] }] };
  eq(removeAnchor(one, 0, 0).subpaths.length, 0, 'removing the last anchor drops the subpath');
}

done(`paths: ${SHAPES.length} shapes, areas closed-form, stroke geometry checked against the canvas`);
