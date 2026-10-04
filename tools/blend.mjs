// Oracle: our blend modes against the browser's own compositor.
//
// The W3C Compositing and Blending Level 1 spec is what Chromium implements
// for canvas globalCompositeOperation, and js/core/blend.js is written from
// that same spec -- so the browser is a genuinely independent implementation
// of the same contract, not a copy of our arithmetic. No reference library is
// needed for the most important file in the engine.
//
// It runs on a FLOAT16 canvas (getContext('2d', { colorType: 'float16' })).
// That matters more than it sounds: the default unorm8 pipeline computes the
// product terms in 8-bit fixed point, so multiply, overlay and exclusion came
// out up to 2/255 away from the exact answer while difference, screen and
// soft-light matched to the byte. Chasing that looked exactly like a formula
// bug for a while. On the float16 path every mode agrees to half-precision,
// which is a real test of the arithmetic instead of a test of Skia's rounding.
//
// Tolerance is float16's own resolution: an 11-bit significand is 4.9e-4
// relative, and values are rounded once on the way in and once on the way
// out, so 2e-3 relative is tight. tools/controls.sh breaks each formula in
// turn to prove this bound still catches a wrong one.

import { SEPARABLE, NON_SEPARABLE, W3C_MODES, composite, cssName } from '../js/core/blend.js';
import { ok, eq, note, done, colorSet, f16round, f16neighbours } from './_harness.mjs';
import { runInBrowser } from './_browser.mjs';

const F16_REL = 2e-3;
const F16_ABS = 2e-4;          // floor, for results near zero

// Two separate error sources, and conflating them is what made the first run
// of this oracle report ten "failures" in code that was right:
//
//  1. OUTPUT precision -- the result is stored in float16. Flat tolerance.
//  2. INPUT conditioning -- the browser's inputs are float16, and some modes
//     are steep. color-burn at the clamp boundary turns a 1-ULP input nudge
//     into a 4.5e-3 output swing, and difference(b, s) where b == s is pure
//     cancellation: the true answer is 0 and a 1-ULP input shift makes it
//     5e-4. Neither is a formula error; comparing there measures the
//     conditioning of the expression, not either implementation of it.
//
// So the allowance at each point is the output tolerance PLUS the spread the
// formula itself produces when its own inputs move by one float16 ULP. That
// keeps the bound tight where the mode is well conditioned (which is almost
// everywhere) and honest where it is not.
//
// The sweep is deliberately NOT capped, and the reason is worth recording.
// color-dodge is genuinely DISCONTINUOUS at b == 0 -- nudging the backdrop by
// one ULP takes the result from 0 to 1 -- so its allowance there is 1.0 and
// the point accepts any answer. Reversing dodge's degenerate cases, a real bug
// the spec explicitly warns about, sailed straight through the first version
// of this oracle.
//
// Capping the spread fixed that control and broke a correct one: color-burn
// near its clamp is steep but CONTINUOUS, and the browser's intermediate
// 1 - x with x ~ 1 loses 2.4e-4 to cancellation, which a cap rejected as a
// bug. Steepness and discontinuity need different treatment and a single
// threshold cannot tell them apart.
//
// So the generic sweep keeps its honest uncapped allowance, and every
// degenerate point the spec calls out is pinned separately and EXACTLY by
// DEGENERATE below. Nothing is left excused by the slack.
function allowance(evalAt, cb, cs, nominal) {
  let spread = 0;
  for (let k = 0; k < 6; k++) {
    const arr = k < 3 ? cb : cs;
    const idx = k % 3;
    for (const v of f16neighbours(arr[idx])) {
      if (v === arr[idx]) continue;
      const b2 = cb.slice(), s2 = cs.slice();
      (k < 3 ? b2 : s2)[idx] = v;
      const got = evalAt(b2, s2);
      for (let c = 0; c < 3; c++) spread = Math.max(spread, Math.abs(got[c] - nominal[c]));
    }
  }
  return spread;
}

function decode(s) {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** The page-side preamble both passes share. */
const PRELUDE = `
const f16 = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { colorType: 'float16', willReadFrequently: true });
  if (g.getContextAttributes().colorType !== 'float16') throw new Error('no float16 canvas');
  return { c, g };
};
const put = (g, w, data) => g.putImageData(new ImageData(data, w, 1, { pixelFormat: 'rgba-float16' }), 0, 0);
const read = (g, w) => g.getImageData(0, 0, w, 1, { pixelFormat: 'rgba-float16' }).data;
const ship = (f32) => {
  const b = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(s);
};
`;

// ------------------------------------------------------------- opaque pass
// Pixel (i,j) is source COLS[j] over backdrop COLS[i], both opaque. The
// backdrop goes in with putImageData (no blending) and the source arrives as a
// drawImage so the mode actually applies.

// Inputs are rounded to float16 HERE so both sides blend bit-identical
// numbers. Without this the oracle also measures the 8-bit -> float16
// conversion, which is not what it is for.
const COLS = colorSet().map((c) => c.map((v) => f16round(v / 255)));
const N = COLS.length;
const W = N * N;

const opaquePage = `${PRELUDE}
const COLS = ${JSON.stringify(COLS)};
const MODES = ${JSON.stringify(W3C_MODES.map(cssName))};
const N = ${N}, W = ${W};
const bd = new Float16Array(W * 4), sd = new Float16Array(W * 4);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const p = (i * N + j) * 4;
  bd[p] = COLS[i][0]; bd[p+1] = COLS[i][1]; bd[p+2] = COLS[i][2]; bd[p+3] = 1;
  sd[p] = COLS[j][0]; sd[p+1] = COLS[j][1]; sd[p+2] = COLS[j][2]; sd[p+3] = 1;
}
const S = f16(W, 1); put(S.g, W, sd);
const B = f16(W, 1);
const out = new Float32Array(MODES.length * W * 4);
MODES.forEach((m, k) => {
  B.g.globalCompositeOperation = 'source-over';
  B.g.clearRect(0, 0, W, 1);
  put(B.g, W, bd);
  B.g.globalCompositeOperation = m;
  if (B.g.globalCompositeOperation !== m) throw new Error('mode not supported: ' + m);
  B.g.drawImage(S.c, 0, 0);
  const r = read(B.g, W);
  for (let i = 0; i < r.length; i++) out[k * W * 4 + i] = r[i];
});
window.__out = ship(out);
`;

note(`opaque: ${N} colours -> ${W} pairs x ${W3C_MODES.length} modes`);
const got = decode(runInBrowser(opaquePage));
eq(got.length, W3C_MODES.length * W * 4, 'browser returned the expected float count');

let worstO = 0, whereO = '', illO = 0;
for (let k = 0; k < W3C_MODES.length; k++) {
  const mode = W3C_MODES[k];
  const sep = SEPARABLE[mode];
  const evalAt = sep
    ? (b, s) => [sep(b[0], s[0]), sep(b[1], s[1]), sep(b[2], s[2])]
    : (b, s) => NON_SEPARABLE[mode](b, s);
  let bad = 0, ill = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = k * W * 4 + (i * N + j) * 4;
    const cb = COLS[i], cs = COLS[j];
    const want = evalAt(cb, cs);
    const base = want.map((v) => F16_ABS + F16_REL * Math.abs(v));
    let spread = 0;
    let needSpread = false;
    for (let c = 0; c < 3; c++) if (Math.abs(got[p + c] - want[c]) > base[c]) needSpread = true;
    if (needSpread) {
      spread = allowance(evalAt, cb, cs, want);
      if (spread > Math.max(...base)) ill++;
    }
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(got[p + c] - want[c]);
      const tol = base[c] + spread;
      const rel = d / tol;
      if (rel > worstO) { worstO = rel; whereO = `${mode} ch${c} b=${cb} s=${cs} got ${got[p + c]} want ${want[c]} tol ${tol.toExponential(2)}`; }
      if (d > tol) bad++;
    }
    if (Math.abs(got[p + 3] - 1) > 1e-3) bad++;
  }
  illO += ill;
  ok(bad === 0, `${mode}: ${bad} of ${W * 3} channels outside tolerance`);
}
note(`opaque worst = ${worstO.toFixed(3)} x tolerance  ${worstO > 0.9 ? `(${whereO})` : ''}`);
note(`${illO} of ${N * N * W3C_MODES.length} opaque points are ill-conditioned (clamp boundaries and cancellation)`);

// --------------------------------------------------------- degenerate cases
// The points where a mode is discontinuous, which the sweep above cannot
// guard because the discontinuity is exactly what makes its allowance wide.
// Each is a value the spec states outright, and both we and the browser must
// return it exactly. colorSet() puts the cube corners first, so index 0 is
// black and index 7 is white.
const BLACK = 0, WHITE = 7;
for (const c of COLS[BLACK]) eq(c, 0, 'colorSet index 0 is black');
for (const c of COLS[WHITE]) eq(c, 1, 'colorSet index 7 is white');

const DEGENERATE = [
  // [mode, backdrop index, source index, expected channel value]
  // ColorDodge: a black backdrop stays black even under white -- the b === 0
  // test MUST come before the s === 1 test or this returns 1.
  ['color-dodge', BLACK, WHITE, 0],
  ['color-dodge', WHITE, WHITE, 1],
  // ColorBurn: a white backdrop stays white even under black, for the mirror
  // reason -- b === 1 before s === 0.
  ['color-burn', WHITE, BLACK, 1],
  ['color-burn', BLACK, BLACK, 0],
  // The rest are the ordinary extremes, cheap to state and easy to break.
  ['multiply', BLACK, WHITE, 0],
  ['multiply', WHITE, WHITE, 1],
  ['screen', WHITE, BLACK, 1],
  ['screen', BLACK, BLACK, 0],
  ['difference', WHITE, BLACK, 1],
  ['difference', WHITE, WHITE, 0],
  ['exclusion', WHITE, WHITE, 0],
  ['overlay', BLACK, WHITE, 0],
  ['hard-light', WHITE, BLACK, 0],
  ['soft-light', BLACK, WHITE, 0],
  ['darken', WHITE, BLACK, 0],
  ['lighten', BLACK, WHITE, 1],
];

for (const [mode, bi, si, want] of DEGENERATE) {
  const k = W3C_MODES.indexOf(mode);
  const sep = SEPARABLE[mode];
  const mine = sep(COLS[bi][0], COLS[si][0]);
  eq(mine, want, `spec: ${mode}(${COLS[bi][0]}, ${COLS[si][0]}) is exactly ${want}`);
  const p = k * W * 4 + (bi * N + si) * 4;
  ok(Math.abs(got[p] - want) <= F16_ABS,
    `browser agrees exactly: ${mode}(${COLS[bi][0]}, ${COLS[si][0]}) = ${got[p]}, want ${want}`);
}
note(`${DEGENERATE.length} discontinuous points pinned exactly on both sides`);

// -------------------------------------------------------------- alpha pass
// Partial alpha on BOTH sides. This is what exercises the (1 - ab) term in
// the blend step, which is the term people drop: without it a soft edge over
// empty space picks up a fringe that no opaque test can see.

const CA = COLS.slice(0, 24);
const ALPHA_NOTE = 'alphas are float16-exact already (0, 1/16, 1/4, 1/2, 1)';
const ALPHAS = [0, 0.0625, 0.25, 0.5, 1].map(f16round);
const WA = CA.length * CA.length * ALPHAS.length * ALPHAS.length;

const alphaPage = `${PRELUDE}
const COLS = ${JSON.stringify(CA)};
const AL = ${JSON.stringify(ALPHAS)};
const MODES = ${JSON.stringify(W3C_MODES.map(cssName))};
const N = ${CA.length}, A = ${ALPHAS.length}, W = ${WA};
const bd = new Float16Array(W * 4), sd = new Float16Array(W * 4);
let p = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
  for (let ai = 0; ai < A; ai++) for (let aj = 0; aj < A; aj++) {
    bd[p] = COLS[i][0]; bd[p+1] = COLS[i][1]; bd[p+2] = COLS[i][2]; bd[p+3] = AL[ai];
    sd[p] = COLS[j][0]; sd[p+1] = COLS[j][1]; sd[p+2] = COLS[j][2]; sd[p+3] = AL[aj];
    p += 4;
  }
const S = f16(W, 1); put(S.g, W, sd);
const B = f16(W, 1);
const out = new Float32Array(MODES.length * W * 4);
MODES.forEach((m, k) => {
  B.g.globalCompositeOperation = 'source-over';
  B.g.clearRect(0, 0, W, 1);
  put(B.g, W, bd);
  B.g.globalCompositeOperation = m;
  B.g.drawImage(S.c, 0, 0);
  const r = read(B.g, W);
  for (let i = 0; i < r.length; i++) out[k * W * 4 + i] = r[i];
});
window.__out = ship(out);
`;

note(`alpha: ${CA.length}^2 colours x ${ALPHAS.length}^2 alphas x ${W3C_MODES.length} modes = ${WA * W3C_MODES.length} pixels`);
const gotA = decode(runInBrowser(alphaPage));
eq(gotA.length, W3C_MODES.length * WA * 4, 'browser returned the expected alpha float count');

let worstA = 0, whereA = '';
for (let k = 0; k < W3C_MODES.length; k++) {
  const mode = W3C_MODES[k];
  let bad = 0, badAlpha = 0, compared = 0;
  let p = 0;
  for (let i = 0; i < CA.length; i++) for (let j = 0; j < CA.length; j++)
    for (let ai = 0; ai < ALPHAS.length; ai++) for (let aj = 0; aj < ALPHAS.length; aj++) {
      const o = k * WA * 4 + p * 4;
      p++;
      const ab = ALPHAS[ai], as = ALPHAS[aj];
      const want = composite(mode, CA[i], ab, CA[j], as);
      if (Math.abs(gotA[o + 3] - want[3]) > F16_ABS + F16_REL * Math.abs(want[3])) badAlpha++;
      // Where the result is fully transparent the colour carries no
      // information -- the canvas stores premultiplied, so it is zero there
      // whatever we computed. Comparing it would assert on nothing.
      if (want[3] < 0.02) continue;
      compared++;
      const base = want.map((v) => F16_ABS + F16_REL * Math.abs(v));
      let spread = 0, needSpread = false;
      for (let c = 0; c < 3; c++) if (Math.abs(gotA[o + c] - want[c]) > base[c]) needSpread = true;
      if (needSpread) {
        spread = allowance((b, s) => composite(mode, b, ab, s, as), CA[i], CA[j], want);
      }
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(gotA[o + c] - want[c]);
        const tol = base[c] + spread;
        const rel = d / tol;
        if (rel > worstA) { worstA = rel; whereA = `${mode} ch${c} b=${CA[i]}@${ab} s=${CA[j]}@${as} got ${gotA[o + c]} want ${want[c]} tol ${tol.toExponential(2)}`; }
        if (d > tol) bad++;
      }
    }
  ok(badAlpha === 0, `${mode}: output alpha matches (${badAlpha} off)`);
  ok(bad === 0, `${mode}: ${bad} of ${compared * 3} alpha-case channels outside tolerance`);
}
note(`alpha worst = ${worstA.toFixed(3)} x tolerance  ${worstA > 0.9 ? `(${whereA})` : ''}`);
note(ALPHA_NOTE);

done(`27 modes defined, ${W3C_MODES.length} checked against the browser on a float16 canvas (opaque ${worstO.toFixed(2)}x, alpha ${worstA.toFixed(2)}x tolerance)`);
