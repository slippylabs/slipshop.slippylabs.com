// Oracle: the shared helpers. No reference library -- these are all facts you
// can state exactly, which is why they belong in their own file rather than
// being assumed by every oracle downstream.

import {
  clamp, clamp01, round, toByte, toU16, wrap, reflect, wrapHue, hueDelta,
  luma709, luma601, mulberry32, gaussianPair,
  rect, rectEmpty, rectIntersect, rectUnion, rectContains, rectEq, rectGrow,
} from '../js/core/util.js';
import { ok, eq, note, done } from './_harness.mjs';

// ------------------------------------------------------------------ rounding
// Every quantise in the engine goes through round(), and an oracle written in
// Python will reach for np.round, which is half-to-EVEN. Pinning the JS
// behaviour here is what lets those oracles use np.floor(x + 0.5) knowingly.
eq(round(0.5), 1, 'round(0.5) is 1 (half-up, like Math.round)');
eq(round(1.5), 2, 'round(1.5) is 2 -- NOT 2 by luck: half-to-even would also say 2');
eq(round(2.5), 3, 'round(2.5) is 3, where half-to-even would say 2');
eq(round(-0.5), 0, 'round(-0.5) is 0');
eq(round(-1.5), -1, 'round(-1.5) is -1 (towards +inf, like Math.round)');
for (let i = 0; i < 1000; i++) {
  const v = (i - 500) / 7;
  eq(round(v), Math.round(v), `round matches Math.round at ${v}`);
}

eq(toByte(0), 0, 'toByte(0)');
eq(toByte(1), 255, 'toByte(1)');
eq(toByte(-5), 0, 'toByte saturates below');
eq(toByte(5), 255, 'toByte saturates above');
eq(toU16(1), 65535, 'toU16(1)');
// Byte round-trip must be exact for all 256 values or every codec drifts.
for (let i = 0; i < 256; i++) eq(toByte(i / 255), i, `byte ${i} round-trips`);
for (let i = 0; i < 65536; i += 7) eq(toU16(i / 65535), i, `u16 ${i} round-trips`);

// ------------------------------------------------------------------ borders
// A convolution needs its border modes to be exactly right or a filter grows
// a dark or bright frame that looks like a kernel bug.
for (const n of [1, 2, 3, 4, 5, 8]) {
  for (let i = -3 * n; i < 4 * n; i++) {
    const w = wrap(i, n);
    ok(w >= 0 && w < n, `wrap keeps ${i} inside [0,${n})`);
    const r = reflect(i, n);
    ok(r >= 0 && r < n, `reflect keeps ${i} inside [0,${n})`);
  }
  // wrap is periodic with period n; reflect with period 2n-2.
  for (let i = -2 * n; i < 2 * n; i++) {
    eq(wrap(i + n, n), wrap(i, n), `wrap is ${n}-periodic at ${i}`);
    if (n > 1) eq(reflect(i + 2 * n - 2, n), reflect(i, n), `reflect is ${2 * n - 2}-periodic at ${i}`);
  }
  // In range, both are the identity -- a border mode must not touch the interior.
  for (let i = 0; i < n; i++) {
    eq(wrap(i, n), i, `wrap is the identity inside the range at ${i}`);
    eq(reflect(i, n), i, `reflect is the identity inside the range at ${i}`);
  }
}
// This is scipy's 'mirror', not 'reflect': the edge sample is NOT repeated.
eq(reflect(-1, 4), 1, 'reflect(-1) is 1, not 0 -- the edge sample is not doubled');
eq(reflect(4, 4), 2, 'reflect(4) is 2, not 3');

// ------------------------------------------------------------------ hue
eq(wrapHue(0), 0, 'wrapHue(0)');
eq(wrapHue(360), 0, 'wrapHue(360) folds to 0');
eq(wrapHue(-90), 270, 'wrapHue(-90)');
eq(wrapHue(450), 90, 'wrapHue(450)');
eq(hueDelta(350, 10), 20, 'hueDelta takes the short way forwards over the wrap');
eq(hueDelta(10, 350), -20, 'hueDelta takes the short way backwards over the wrap');
eq(hueDelta(0, 180), 180, 'hueDelta at exactly half a turn is +180');
for (let a = 0; a < 360; a += 7) for (let b = 0; b < 360; b += 11) {
  const d = hueDelta(a, b);
  ok(d > -180.0001 && d <= 180.0001, `hueDelta(${a},${b}) is in (-180,180]`);
  eq(wrapHue(a + d), wrapHue(b), `a + hueDelta(a,b) lands on b`, 1e-12);
}

// ------------------------------------------------------------------ luma
eq(luma709(1, 1, 1), 1, 'luma709 of white is 1', 1e-12);
eq(luma601(1, 1, 1), 1, 'luma601 of white is 1', 1e-12);
eq(luma709(0, 0, 0), 0, 'luma709 of black is 0');
ok(luma709(0, 1, 0) > luma709(1, 0, 0), 'green weighs more than red in Rec.709');
ok(luma709(1, 0, 0) > luma709(0, 0, 1), 'red weighs more than blue in Rec.709');

// ------------------------------------------------------------------ clamp
eq(clamp(5, 0, 3), 3, 'clamp above');
eq(clamp(-5, 0, 3), 0, 'clamp below');
eq(clamp(2, 0, 3), 2, 'clamp inside');
eq(clamp01(0.5), 0.5, 'clamp01 inside');
ok(Object.is(clamp01(-0), -0) || clamp01(-0) === 0, 'clamp01 of -0 is zero');

// ------------------------------------------------------------------ rects
const A = rect(2, 3, 10, 6);
const B = rect(8, 1, 10, 10);
ok(rectEmpty(rect(0, 0, 0, 5)), 'zero width is empty');
ok(rectEmpty(rect(0, 0, 5, -1)), 'negative height is empty');
ok(!rectEmpty(A), 'a real rect is not empty');
eq(JSON.stringify(rectIntersect(A, B)), JSON.stringify(rect(8, 3, 4, 6)), 'intersect');
eq(JSON.stringify(rectUnion(A, B)), JSON.stringify(rect(2, 1, 16, 10)), 'union');
// Disjoint rects intersect to EMPTY, never to a negative-size rect -- a
// negative width silently becomes a huge loop bound downstream.
const D = rectIntersect(rect(0, 0, 2, 2), rect(50, 50, 2, 2));
ok(rectEmpty(D) && D.w >= 0 && D.h >= 0, 'disjoint intersect is empty with non-negative size');
ok(rectEmpty(rectIntersect(A, rect(0, 0, 0, 0))), 'intersect with empty is empty');
eq(JSON.stringify(rectUnion(A, rect(0, 0, 0, 0))), JSON.stringify(A), 'union with empty is a no-op');
ok(rectContains(A, 2, 3), 'contains its own origin');
ok(!rectContains(A, 12, 3), 'excludes the far edge (half-open)');
ok(!rectContains(A, 1, 3), 'excludes just outside');
ok(rectEq(A, rect(2, 3, 10, 6)), 'rectEq');
// Grow then clip: a kernel of radius n reads n outside the rect it writes,
// and getting this wrong is what makes a tiled filter seam.
const bound = rect(0, 0, 20, 20);
eq(JSON.stringify(rectGrow(rect(0, 0, 4, 4), 2, bound)), JSON.stringify(rect(0, 0, 6, 6)),
  'grow clips at the top-left bound rather than going negative');
eq(JSON.stringify(rectGrow(rect(16, 16, 4, 4), 2, bound)), JSON.stringify(rect(14, 14, 6, 6)),
  'grow clips at the bottom-right bound');
eq(JSON.stringify(rectGrow(rect(5, 5, 4, 4), 0, bound)), JSON.stringify(rect(5, 5, 4, 4)),
  'grow by zero is a no-op');
// Idempotence of intersect and commutativity of both, over a grid.
for (let i = 0; i < 40; i++) {
  const r1 = rect(i % 7, i % 5, (i % 4) + 1, (i % 3) + 1);
  const r2 = rect(i % 3, i % 6, (i % 5) + 1, (i % 4) + 1);
  ok(rectEq(rectIntersect(r1, r2), rectIntersect(r2, r1)), 'intersect commutes');
  ok(rectEq(rectUnion(r1, r2), rectUnion(r2, r1)), 'union commutes');
  ok(rectEq(rectIntersect(r1, r1), r1), 'intersect is idempotent');
  const u = rectUnion(r1, r2);
  ok(rectEq(rectIntersect(r1, u), r1), 'a rect is contained in its union');
}

// ------------------------------------------------------------------ prng
// Seeded and reproducible, because every noise filter and dithered gradient
// depends on the same value coming back on a re-render.
const r1 = mulberry32(12345), r2 = mulberry32(12345);
let same = true, inRange = true;
for (let i = 0; i < 10000; i++) {
  const a = r1(), b = r2();
  if (a !== b) same = false;
  if (!(a >= 0 && a < 1)) inRange = false;
}
ok(same, 'the same seed gives the same sequence');
ok(inRange, 'every draw is in [0,1)');
const r3 = mulberry32(12346);
ok(mulberry32(12345)() !== r3(), 'a different seed gives a different first draw');
// Mean and variance of a uniform, loosely -- enough to catch a stuck bit.
let s = 0, s2 = 0;
const rr = mulberry32(7);
const Nn = 200000;
for (let i = 0; i < Nn; i++) { const v = rr(); s += v; s2 += v * v; }
eq(s / Nn, 0.5, 'uniform mean is 0.5', 0.01);
eq(s2 / Nn - (s / Nn) ** 2, 1 / 12, 'uniform variance is 1/12', 0.01);

// Box-Muller: unit normal, and it must never be handed a zero (log(0)).
const rg = mulberry32(99);
let gs = 0, gs2 = 0, n = 0, finite = true;
for (let i = 0; i < 100000; i++) {
  const [x, y] = gaussianPair(rg);
  if (!Number.isFinite(x) || !Number.isFinite(y)) finite = false;
  gs += x + y; gs2 += x * x + y * y; n += 2;
}
ok(finite, 'gaussianPair never returns a non-finite value');
eq(gs / n, 0, 'gaussian mean is 0', 0.02);
eq(gs2 / n, 1, 'gaussian variance is 1', 0.02);

note('border modes, rect algebra and the PRNG are all exact statements, no reference needed');
done('helpers behave exactly as the engine assumes');
