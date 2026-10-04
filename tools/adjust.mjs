// Oracle: the adjustments catalogue, and the non-destructive equivalence that
// adjustment layers rest on.
//
// There is no reference library for "what Photoshop's Vibrance slider does",
// so this oracle is built from properties that must hold whatever the formula
// is. The most productive by a long way is the IDENTITY property: an
// adjustment at its neutral setting must return the image untouched. With
// every slider at zero, Selective Colour was shifting (0.30, 0.70, 0.45) to
// (0.42, 0.70, 0.53) -- its CMYK decomposition and reconstruction were not an
// inverse pair. Nothing about the picture would have told you.
//
// The other properties: alpha is never touched, output stays in range, tone
// adjustments stay monotone (a non-monotone tone curve inverts a band of
// tones, which reads as a posterised artefact rather than as a bug), and the
// whole thing is deterministic.

import { ADJUSTMENTS, ADJUST_KINDS, applyAdjust, adjustDefaults, parseCube, sampleLut3d, sampleStops } from '../js/core/adjust.js';
import { monotoneSpline, buildLut, sampleLut, isIdentityCurve, IDENTITY_CURVE, LUT_SIZE } from '../js/core/curve.js';
import { Doc, Layer, newDoc } from '../js/core/doc.js';
import { compositeDoc } from '../js/core/composite.js';
import { Surface } from '../js/core/tiles.js';
import { rect, mulberry32, luma709, clamp01 } from '../js/core/util.js';
import { ok, eq, note, done, worst } from './_harness.mjs';

const rnd = mulberry32(0xADD1E5);

/** A spread of colours including every corner, grey ramp and random fill. */
function colourSet(n = 2000) {
  const out = [];
  for (const r of [0, 1]) for (const g of [0, 1]) for (const b of [0, 1]) out.push([r, g, b]);
  for (let i = 0; i <= 32; i++) out.push([i / 32, i / 32, i / 32]);
  // the six primaries and secondaries at full and half saturation
  for (const h of [0, 60, 120, 180, 240, 300]) {
    const f = (o) => clamp01(Math.abs(((h / 60 + o) % 6) - 3) - 1);
    out.push([f(3), f(1), f(5)]);
  }
  while (out.length < n) out.push([rnd(), rnd(), rnd()]);
  return out;
}

const COLS = colourSet();

function bufOf(cols, alpha) {
  const b = new Float32Array(cols.length * 4);
  for (let i = 0; i < cols.length; i++) {
    b[i * 4] = cols[i][0]; b[i * 4 + 1] = cols[i][1]; b[i * 4 + 2] = cols[i][2];
    b[i * 4 + 3] = alpha === undefined ? (i % 7) / 6 : alpha;
  }
  return b;
}

// ----------------------------------------------------------- registry shape
for (const kind of ADJUST_KINDS) {
  const a = ADJUSTMENTS[kind];
  ok(typeof a.label === 'string' && a.label.length > 0, `${kind}: has a label`);
  ok(typeof a.group === 'string' && a.group.length > 0, `${kind}: has a group`);
  ok(typeof a.apply === 'function', `${kind}: has an apply function`);
  ok(Array.isArray(a.fields), `${kind}: has a fields table`);
  // Every field must name a parameter that exists in the defaults, or the UI
  // would render a control that writes somewhere nothing reads.
  for (const f of a.fields) {
    const path = f[1];
    let cur = a.defaults;
    let okPath = true;
    for (const part of String(path).split('.')) {
      if (cur === null || cur === undefined || !(part in cur)) { okPath = false; break; }
      cur = cur[part];
    }
    ok(okPath, `${kind}: field "${f[0]}" points at defaults path "${path}" which exists`);
    ok(['num', 'col', 'sel', 'bool', 'curve'].includes(f[2]), `${kind}: field "${f[0]}" has a known kind (${f[2]})`);
    if (f[2] === 'num') {
      ok(typeof f[3] === 'number' && typeof f[4] === 'number' && f[4] > f[3],
        `${kind}: field "${f[0]}" has a sane numeric range`);
      const d = Number(cur);
      ok(d >= f[3] && d <= f[4], `${kind}: field "${f[0]}" default ${d} is inside its own range ${f[3]}..${f[4]}`);
    }
  }
  // adjustDefaults must not alias the catalogue, or editing one document's
  // adjustment would silently change the default for every later one.
  const d1 = adjustDefaults(kind);
  const d2 = adjustDefaults(kind);
  ok(d1 !== a.defaults, `${kind}: adjustDefaults returns a copy, not the catalogue object`);
  ok(d1 !== d2, `${kind}: and a fresh copy each time`);
}
let threw = false;
try { applyAdjust('nope', {}, new Float32Array(4), 1, 1); } catch (e) { threw = true; }
ok(threw, 'an unknown adjustment kind throws');

// ---------------------------------------------------- THE IDENTITY PROPERTY
let worstIdentity = 0, whereIdentity = '';
for (const kind of ADJUST_KINDS) {
  const neutral = ADJUSTMENTS[kind].neutral;
  if (!neutral) continue;
  const before = bufOf(COLS);
  const buf = before.slice();
  applyAdjust(kind, neutral, buf, COLS.length, 1);
  let w = 0, at = -1;
  for (let i = 0; i < buf.length; i++) {
    const d = Math.abs(buf[i] - before[i]);
    if (d > w) { w = d; at = i; }
  }
  if (w > worstIdentity) { worstIdentity = w; whereIdentity = `${kind} at colour ${(at / 4) | 0}`; }
  ok(w < 1e-6, `${kind} at its neutral setting is the IDENTITY over ${COLS.length} colours (worst ${w.toExponential(2)})`);
}
note(`identity property: worst ${worstIdentity.toExponential(2)} (${whereIdentity})`);

// --------------------------------------------------- alpha, range, determinism
for (const kind of ADJUST_KINDS) {
  const params = adjustDefaults(kind);
  const before = bufOf(COLS);
  const buf = before.slice();
  applyAdjust(kind, params, buf, COLS.length, 1);

  let alphaMoved = 0, outOfRange = 0, nonFinite = 0;
  for (let i = 0; i < COLS.length; i++) {
    const p = i * 4;
    if (buf[p + 3] !== before[p + 3]) alphaMoved++;
    for (let c = 0; c < 4; c++) {
      if (!Number.isFinite(buf[p + c])) nonFinite++;
      else if (buf[p + c] < -1e-6 || buf[p + c] > 1 + 1e-6) outOfRange++;
    }
  }
  eq(alphaMoved, 0, `${kind}: alpha is never touched`);
  eq(nonFinite, 0, `${kind}: no NaN or Infinity`);
  eq(outOfRange, 0, `${kind}: every output channel stays in 0..1`);

  const again = before.slice();
  applyAdjust(kind, params, again, COLS.length, 1);
  eq(worst(buf, again).w, 0, `${kind}: deterministic -- the same input gives the same output`);
}

// ------------------------------------------------------ extreme parameters
// A slider at its limit must not produce NaN or escape the range. These are
// the values a user reaches for first when they want to see what a slider does.
{
  const EXTREMES = {
    brightnessContrast: [{ brightness: 1, contrast: 1 }, { brightness: -1, contrast: -1 }, { brightness: 1, contrast: -1 }],
    levels: [
      { master: { inBlack: 1, inWhite: 0, gamma: 1, outBlack: 0, outWhite: 1 } },   // inverted span
      { master: { inBlack: 0.5, inWhite: 0.5, gamma: 1, outBlack: 0, outWhite: 1 } }, // zero span
      { master: { inBlack: 0, inWhite: 1, gamma: 0.1, outBlack: 1, outWhite: 0 } },  // inverted output
    ],
    exposure: [{ exposure: 5, offset: 0.5, gamma: 0.1 }, { exposure: -5, offset: -0.5, gamma: 4 }],
    hueSaturation: [{ master: { hue: 180, saturation: 1, lightness: 1 } }, { master: { hue: -180, saturation: -1, lightness: -1 } }, { colorize: true, colorizeHue: 200, colorizeSaturation: 1, colorizeLightness: 1 }],
    vibrance: [{ amount: 1 }, { amount: -1 }],
    colorBalance: [{ shadows: [1, -1, 1], midtones: [-1, 1, -1], highlights: [1, 1, -1] }],
    whiteBalance: [{ temperature: 1, tint: 1 }, { temperature: -1, tint: -1 }],
    photoFilter: [{ color: [1, 0, 0], density: 1 }, { color: [0, 0, 0], density: 1 }],
    channelMixer: [{ matrix: [[2, -2, 2], [-2, 2, -2], [2, 2, -2]], constant: [1, -1, 0.5] }, { monochrome: true, matrix: [[2, 2, 2], [0, 0, 0], [0, 0, 0]] }],
    selectiveColor: [{ ranges: { reds: { cyan: -1, magenta: 1, yellow: -1, black: 1 }, neutrals: { black: 1 }, blacks: { black: -1 }, whites: { cyan: 1 } }, mode: 'absolute' }],
    posterize: [{ levels: 2 }, { levels: 255 }],
    threshold: [{ level: 0 }, { level: 1 }],
    blackWhite: [{ reds: 3, yellows: -2, greens: 3, cyans: -2, blues: 3, magentas: -2, tint: true }],
    shadowsHighlights: [{ shadowAmount: 1, highlightAmount: 1, shadowTone: 0.05, highlightTone: 0.05, radius: 0 }],
    gradientMap: [{ stops: [{ pos: 0.5, color: [1, 0, 0] }, { pos: 0.5, color: [0, 1, 0] }] }],  // coincident stops
  };
  let bad = 0;
  for (const [kind, sets] of Object.entries(EXTREMES)) {
    for (const p of sets) {
      const buf = bufOf(COLS);
      applyAdjust(kind, { ...adjustDefaults(kind), ...p }, buf, COLS.length, 1);
      for (let i = 0; i < buf.length; i++) {
        if (!Number.isFinite(buf[i]) || buf[i] < -1e-6 || buf[i] > 1 + 1e-6) { bad++; break; }
      }
    }
  }
  eq(bad, 0, 'every extreme parameter set stays finite and in range (including a zero and an inverted levels span)');
}

// ------------------------------------------------------------- monotonicity
// A tone adjustment must never make a brighter input darker. A curve that
// overshoots inverts a band of tones, which looks like banding rather than
// like the bug it is.
{
  const MONO = {
    brightnessContrast: [{ brightness: 0.4, contrast: 0.7 }, { brightness: -0.6, contrast: 0.9 }],
    levels: [{ master: { inBlack: 0.1, inWhite: 0.85, gamma: 2.2, outBlack: 0.05, outWhite: 0.95 } }],
    exposure: [{ exposure: 1.5, offset: 0.05, gamma: 1.6 }],
    curves: [{ rgb: [[0, 0], [0.25, 0.1], [0.3, 0.9], [0.75, 0.92], [1, 1]] }],
    posterize: [{ levels: 6 }],
    gradientMap: [{ stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }] }],
  };
  for (const [kind, sets] of Object.entries(MONO)) {
    for (const p of sets) {
      const N = 4096;
      const ramp = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) {
        const v = i / (N - 1);
        ramp[i * 4] = ramp[i * 4 + 1] = ramp[i * 4 + 2] = v;
        ramp[i * 4 + 3] = 1;
      }
      applyAdjust(kind, { ...adjustDefaults(kind), ...p }, ramp, N, 1);
      let drops = 0;
      for (let i = 1; i < N; i++) if (ramp[i * 4] < ramp[(i - 1) * 4] - 1e-6) drops++;
      eq(drops, 0, `${kind}: monotone on a grey ramp (${JSON.stringify(p).slice(0, 48)})`);
    }
  }
}

// ----------------------------------------------------------- known anchors
{
  const one = (kind, p, rgb) => {
    const b = new Float32Array([...rgb, 1]);
    applyAdjust(kind, { ...adjustDefaults(kind), ...p }, b, 1, 1);
    return [b[0], b[1], b[2]];
  };

  // Invert is an involution.
  let w = 0;
  for (const c of COLS) {
    const once = one('invert', {}, c);
    const twice = one('invert', {}, once);
    for (let i = 0; i < 3; i++) w = Math.max(w, Math.abs(twice[i] - c[i]));
  }
  ok(w < 1e-6, `invert applied twice is the identity (worst ${w.toExponential(2)})`);

  // Black & White's defaults are Photoshop's, and these six are the published
  // percentages: red 40, yellow 60, green 40, cyan 60, blue 20, magenta 80.
  const bwCases = [[[1, 0, 0], 0.4], [[1, 1, 0], 0.6], [[0, 1, 0], 0.4], [[0, 1, 1], 0.6], [[0, 0, 1], 0.2], [[1, 0, 1], 0.8]];
  for (const [rgb, want] of bwCases) {
    const g = one('blackWhite', {}, rgb);
    eq(g[0], want, `blackWhite default on ${JSON.stringify(rgb)} is ${want * 100}%, as Photoshop's is`, 2e-6);
    ok(Math.abs(g[0] - g[1]) < 1e-7 && Math.abs(g[1] - g[2]) < 1e-7, 'and it is actually grey');
  }

  // Posterize must hit the endpoints exactly. Quantising with n instead of
  // (n-1) steps leaves the darkest band off black, which is visible.
  for (const n of [2, 3, 4, 8, 16]) {
    eq(one('posterize', { levels: n }, [0, 0, 0])[0], 0, `posterize ${n}: black stays black`);
    eq(one('posterize', { levels: n }, [1, 1, 1])[0], 1, `posterize ${n}: white stays white`, 1e-6);
    // every output must be on the lattice
    const N = 512;
    const ramp = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { ramp[i * 4] = i / (N - 1); ramp[i * 4 + 3] = 1; }
    applyAdjust('posterize', { levels: n }, ramp, N, 1);
    const seen = new Set();
    for (let i = 0; i < N; i++) seen.add(Math.round(ramp[i * 4] * (n - 1)));
    eq(seen.size, n, `posterize ${n}: produces exactly ${n} distinct levels`);
  }

  // Threshold.
  eq(one('threshold', { level: 0.5 }, [0, 0, 0])[0], 0, 'threshold: black is below');
  eq(one('threshold', { level: 0.5 }, [1, 1, 1])[0], 1, 'threshold: white is above');
  eq(one('threshold', { level: 0 }, [0, 0, 0])[0], 1, 'threshold at 0: everything is above (>=)');
  eq(one('threshold', { level: 1 }, [1, 1, 1])[0], 1, 'threshold at 1: white is still above');

  // Desaturate methods differ in the documented way.
  const c = [0.8, 0.4, 0.1];
  eq(one('desaturate', { mode: 'average' }, c)[0], (0.8 + 0.4 + 0.1) / 3, 'desaturate average', 1e-6);
  eq(one('desaturate', { mode: 'lightness' }, c)[0], (0.8 + 0.1) / 2, 'desaturate lightness', 1e-6);
  eq(one('desaturate', { mode: 'luminosity' }, c)[0], luma709(0.8, 0.4, 0.1), 'desaturate luminosity', 1e-6);

  // Exposure is a LINEAR-light gain: +1 stop doubles the linear value, so a
  // linear 0.25 must land on 0.5 exactly.
  const { srgbToLinear, linearToSrgb } = await import('../js/core/color.js');
  const inp = linearToSrgb(0.25);
  const outv = one('exposure', { exposure: 1 }, [inp, inp, inp])[0];
  eq(srgbToLinear(outv), 0.5, '+1 stop of exposure doubles the LINEAR value', 1e-5);
  const outv2 = one('exposure', { exposure: -1 }, [linearToSrgb(0.5), 0, 0])[0];
  eq(srgbToLinear(outv2), 0.25, '-1 stop halves it', 1e-5);

  // Gradient map endpoints.
  const gm = { stops: [{ pos: 0, color: [1, 0, 0] }, { pos: 1, color: [0, 0, 1] }] };
  eq(one('gradientMap', gm, [0, 0, 0])[0], 1, 'gradient map: black takes the first stop');
  eq(one('gradientMap', gm, [1, 1, 1])[2], 1, 'gradient map: white takes the last stop');

  // Channel mixer with a swap matrix really swaps.
  const sw = one('channelMixer', { matrix: [[0, 0, 1], [0, 1, 0], [1, 0, 0]] }, [0.2, 0.5, 0.9]);
  eq(sw[0], 0.9, 'channel mixer: R takes B', 1e-6);
  eq(sw[2], 0.2, 'and B takes R', 1e-6);
}

// ------------------------------------------------------------ sampleStops
{
  const stops = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }];
  eq(sampleStops(stops, 0)[0], 0, 'sampleStops at 0');
  eq(sampleStops(stops, 1)[0], 1, 'sampleStops at 1');
  eq(sampleStops(stops, 0.5)[0], 0.5, 'sampleStops halfway, default midpoint', 1e-9);
  eq(sampleStops(stops, -5)[0], 0, 'below the first stop clamps');
  eq(sampleStops(stops, 5)[0], 1, 'above the last stop clamps');
  // A midpoint moves where the halfway colour lands.
  const mid = [{ pos: 0, color: [0, 0, 0], mid: 0.25 }, { pos: 1, color: [1, 1, 1] }];
  ok(sampleStops(mid, 0.25)[0] > 0.49 && sampleStops(mid, 0.25)[0] < 0.51,
    'a midpoint of 0.25 puts the half-way colour at t=0.25');
  // Unsorted input must still work -- a gradient editor lets you drag a stop
  // past its neighbour.
  const unsorted = [{ pos: 1, color: [1, 1, 1] }, { pos: 0, color: [0, 0, 0] }];
  eq(sampleStops(unsorted, 0)[0], 0, 'unsorted stops are sorted before use');
  // Coincident stops must not divide by zero.
  const coincident = [{ pos: 0.5, color: [1, 0, 0] }, { pos: 0.5, color: [0, 1, 0] }];
  ok(Number.isFinite(sampleStops(coincident, 0.5)[0]), 'coincident stops do not divide by zero');
}

// ------------------------------------------------------------ .cube LUTs
{
  // An identity LUT must be the identity, which is the only way to tell a
  // correct trilinear sample from a transposed one. .cube is R-FASTEST, and
  // writing it G- or B-fastest produces a plausible-looking colour shift.
  const size = 8;
  const lines = ['TITLE "identity"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`);
  }
  const { lut, size: s2 } = parseCube(lines.join('\n'));
  eq(s2, size, 'parseCube reads LUT_3D_SIZE');
  eq(lut.length, size ** 3 * 3, 'and the right number of entries');
  let w = 0;
  for (const c of COLS) {
    const o = sampleLut3d(lut, size, c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) w = Math.max(w, Math.abs(o[i] - c[i]));
  }
  ok(w < 1e-6, `an identity .cube LUT is the identity through sampleLut3d (worst ${w.toExponential(2)}) -- this is what catches a transposed index`);

  // A LUT that swaps red and blue must actually swap them.
  const sw = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) sw.push(`${b} ${g} ${r}`);
  const p2 = parseCube(sw.join('\n'));
  const o = sampleLut3d(p2.lut, 2, 1, 0, 0);
  eq(o[2], 1, 'a red/blue swapping LUT puts red into blue');
  eq(o[0], 0, 'and nothing into red');

  // DOMAIN_MIN/MAX must be honoured, or a 0..255 LUT maps everything to black.
  const dom = ['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 255 255 255'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    dom.push(`${r * 255} ${g * 255} ${b * 255}`);
  }
  const p3 = parseCube(dom.join('\n'));
  const o3 = sampleLut3d(p3.lut, 2, 1, 1, 1);
  eq(o3[0], 1, 'a 0..255 DOMAIN_MAX is rescaled to 0..1');

  let bad = 0;
  for (const text of ['', 'TITLE "x"', 'LUT_3D_SIZE 2\n0 0 0', 'LUT_1D_SIZE 16\n0 0 0']) {
    try { parseCube(text); } catch (e) { bad++; }
  }
  eq(bad, 4, 'a malformed, truncated or 1-D .cube file is rejected with an error rather than silently half-read');
}

// ------------------------------- THE NON-DESTRUCTIVE EQUIVALENCE (plan #13)
// An adjustment LAYER at full opacity with no mask must be bit-identical to
// applying the same adjustment destructively. This is the property that makes
// non-destructive editing trustworthy, and it needs no reference at all.
{
  let worstEq = 0, whereEq = '';
  for (const kind of ADJUST_KINDS) {
    const params = adjustDefaults(kind);
    const W = 24, H = 16;
    const pix = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      pix[i * 4] = rnd(); pix[i * 4 + 1] = rnd(); pix[i * 4 + 2] = rnd(); pix[i * 4 + 3] = 1;
    }

    // (a) destructive: adjust the pixels, then composite
    const docA = new Doc({ w: W, h: H });
    const la = new Layer({ type: 'raster', surface: new Surface(W, H, 4, 16) });
    la.surface.writeRect(rect(0, 0, W, H), pix);
    const flat = la.surface.readRect(rect(0, 0, W, H));
    applyAdjust(kind, params, flat, W, H);
    la.surface.writeRect(rect(0, 0, W, H), flat);
    docA.layers.push(la);
    const a = compositeDoc(docA, docA.bounds);

    // (b) non-destructive: the same pixels under an adjustment layer
    const docB = new Doc({ w: W, h: H });
    const lb = new Layer({ type: 'raster', surface: new Surface(W, H, 4, 16) });
    lb.surface.writeRect(rect(0, 0, W, H), pix);
    docB.layers.push(lb, new Layer({ type: 'adjustment', adjust: { kind, params } }));
    const b = compositeDoc(docB, docB.bounds, { applyAdjust });

    const d = worst(a, b);
    if (d.w > worstEq) { worstEq = d.w; whereEq = kind; }
    // 16-bit storage round trip is the only difference allowed: the
    // destructive path writes the adjusted pixels back through the surface.
    ok(d.w <= 1 / 65535 + 1e-7, `${kind}: an adjustment LAYER equals the destructive apply (worst ${d.w.toExponential(2)})`);
  }
  note(`non-destructive equivalence: worst ${worstEq.toExponential(2)} (${whereEq}), bounded by one 16-bit step`);

  // And at zero opacity an adjustment layer must do nothing at all.
  const W = 16, H = 8;
  const docC = newDoc(W, H, { background: [0.3, 0.6, 0.2, 1] });
  const base = compositeDoc(docC, docC.bounds, { applyAdjust });
  docC.layers.push(new Layer({ type: 'adjustment', opacity: 0, adjust: { kind: 'invert', params: {} } }));
  const withZero = compositeDoc(docC, docC.bounds, { applyAdjust });
  eq(worst(base, withZero).w, 0, 'an adjustment layer at zero opacity changes nothing');

  // At half opacity it must be exactly half way there.
  docC.layers[1].opacity = 0.5;
  const half = compositeDoc(docC, docC.bounds, { applyAdjust });
  docC.layers[1].opacity = 1;
  const full = compositeDoc(docC, docC.bounds, { applyAdjust });
  let wHalf = 0;
  for (let i = 0; i < base.length; i++) wHalf = Math.max(wHalf, Math.abs(half[i] - (base[i] + full[i]) / 2));
  ok(wHalf < 1e-6, `at 50% opacity it is exactly half way between (worst ${wHalf.toExponential(2)})`);

  // A hidden adjustment layer must be skipped.
  docC.layers[1].visible = false;
  const hidden = compositeDoc(docC, docC.bounds, { applyAdjust });
  eq(worst(base, hidden).w, 0, 'a hidden adjustment layer is skipped');
}

// ------------------------------------------------------------ curve module
{
  const f = monotoneSpline(IDENTITY_CURVE);
  let w = 0;
  for (let i = 0; i <= 2000; i++) { const x = i / 2000; w = Math.max(w, Math.abs(f(x) - x)); }
  ok(w < 1e-12, `the identity curve is exactly the identity (worst ${w.toExponential(2)})`);

  // Monotonicity over randomly generated point sets -- this is the whole
  // reason for Fritsch-Carlson rather than a natural spline.
  let nonMono = 0, overshoot = 0;
  for (let t = 0; t < 400; t++) {
    const n = 2 + Math.floor(rnd() * 6);
    const xs = [0];
    for (let i = 1; i < n - 1; i++) xs.push(rnd());
    xs.push(1);
    xs.sort((a, b) => a - b);
    const ys = xs.map(() => rnd()).sort((a, b) => a - b);   // monotone data
    const pts = xs.map((x, i) => [x, ys[i]]);
    const g = monotoneSpline(pts);
    let prev = -Infinity;
    const lo = Math.min(...ys), hi = Math.max(...ys);
    for (let i = 0; i <= 1500; i++) {
      const v = g(i / 1500);
      if (v < prev - 1e-9) nonMono++;
      if (v < lo - 1e-9 || v > hi + 1e-9) overshoot++;
      prev = v;
    }
  }
  eq(nonMono, 0, 'a monotone point set gives a monotone curve, over 400 random sets');
  eq(overshoot, 0, 'and the curve never leaves the range of its own control points');

  // Duplicate x values would divide by zero in the secant slope.
  const dup = monotoneSpline([[0, 0], [0.5, 0.2], [0.5, 0.8], [1, 1]]);
  let finite = true;
  for (let i = 0; i <= 500; i++) if (!Number.isFinite(dup(i / 500))) finite = false;
  ok(finite, 'duplicate x values are de-duplicated rather than dividing by zero');

  // One point behaves as an offset, zero points as the identity.
  const single = monotoneSpline([[0.5, 0.7]]);
  eq(single(0.5), 0.7, 'a single point passes through itself');
  const none = monotoneSpline([]);
  eq(none(0.42), 0.42, 'no points is the identity');

  // Out-of-range input is clamped, not extrapolated into nonsense.
  const curve = monotoneSpline([[0.2, 0.3], [0.8, 0.9]]);
  ok(curve(-1) >= 0 && curve(-1) <= 1, 'input below 0 stays in range');
  ok(curve(2) >= 0 && curve(2) <= 1, 'input above 1 stays in range');

  // LUT sampling must track direct evaluation closely enough for 16-bit.
  const steep = monotoneSpline([[0, 0], [0.25, 0.1], [0.3, 0.9], [0.75, 0.92], [1, 1]]);
  const lut = buildLut(steep);
  let lw = 0;
  for (let i = 0; i <= 20000; i++) { const x = i / 20000; lw = Math.max(lw, Math.abs(sampleLut(lut, x) - steep(x))); }
  ok(lw < 1 / 65535, `a ${LUT_SIZE}-entry LUT tracks the curve inside one 16-bit step (worst ${lw.toExponential(2)})`);
  eq(sampleLut(lut, -1), lut[0], 'sampleLut clamps below');
  eq(sampleLut(lut, 2), lut[lut.length - 1], 'sampleLut clamps above');
  eq(sampleLut(lut, NaN), lut[0], 'sampleLut does not propagate NaN');

  ok(isIdentityCurve([[0, 0], [1, 1]]), 'isIdentityCurve on the identity');
  ok(!isIdentityCurve([[0, 0], [0.5, 0.6], [1, 1]]), 'and not on a real curve');
  ok(isIdentityCurve([[1, 1], [0, 0]]), 'and it sorts first');
}

done(`${ADJUST_KINDS.length} adjustments: identity, alpha, range, monotonicity and non-destructive equivalence all hold`);
