// Blend modes and alpha compositing.
//
// The twelve separable and four non-separable modes are written straight from
// the W3C Compositing and Blending Level 1 spec, because that spec is what
// Chromium's canvas implements -- which makes the browser an exact, independent
// oracle for this file (tools/blend.mjs drives it). The rest are the Photoshop
// modes the spec does not define; those are checked against their own algebraic
// identities instead.
//
// Channels are 0..1 and in the document's ENCODED space. Blending in linear
// light is a document option applied by the compositor, not here: B() is a
// pure function of two numbers and must not know which space it is in.
//
// Two spec details that are easy to get wrong and silently plausible:
//   * Lum() uses 0.3/0.59/0.11, NOT Rec.709's 0.2126/0.7152/0.0722. Using
//     Rec.709 shifts every Luminosity/Color/Hue/Saturation result by a few
//     LSB -- a difference no picture shows and the oracle catches instantly.
//   * ColorDodge/ColorBurn need their degenerate cases in the spec's order.
//     Testing Cs first makes dodge(0, 1) return 1 instead of 0.

import { clamp01 } from './util.js';

/** W3C Lum(). */
export const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

/** W3C ClipColor(): pull an out-of-range colour back inside the cube while
 *  holding its luminosity, rather than clipping channels independently
 *  (which would shift the hue). */
function clipColor(c) {
  const L = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  if (n < 0) {
    const d = L - n;
    out = d === 0 ? [L, L, L] : [
      L + ((out[0] - L) * L) / d,
      L + ((out[1] - L) * L) / d,
      L + ((out[2] - L) * L) / d,
    ];
  }
  if (x > 1) {
    const d = x - L;
    out = d === 0 ? [L, L, L] : [
      L + ((out[0] - L) * (1 - L)) / d,
      L + ((out[1] - L) * (1 - L)) / d,
      L + ((out[2] - L) * (1 - L)) / d,
    ];
  }
  return out;
}

/** W3C SetLum(). */
function setLum(c, l) {
  const d = l - lum(c[0], c[1], c[2]);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

/** W3C Sat(). */
const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

/** W3C SetSat(). */
function setSat(c, s) {
  const mn = Math.min(c[0], c[1], c[2]);
  const mx = Math.max(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  return [
    ((c[0] - mn) * s) / (mx - mn),
    ((c[1] - mn) * s) / (mx - mn),
    ((c[2] - mn) * s) / (mx - mn),
  ];
}

// ------------------------------------------------- separable, per channel

const multiply = (b, s) => b * s;
const screen = (b, s) => b + s - b * s;
const darken = (b, s) => Math.min(b, s);
const lighten = (b, s) => Math.max(b, s);

function colorDodge(b, s) {
  if (b === 0) return 0;              // order matters: dodge(0,1) is 0, not 1
  if (s === 1) return 1;
  return Math.min(1, b / (1 - s));
}

function colorBurn(b, s) {
  if (b === 1) return 1;              // order matters: burn(1,0) is 1, not 0
  if (s === 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}

const hardLight = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));
const overlay = (b, s) => hardLight(s, b);

function softLight(b, s) {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
}

const difference = (b, s) => Math.abs(b - s);
const exclusion = (b, s) => b + s - 2 * b * s;

// ------------------------------------------------- Photoshop extras

const linearDodge = (b, s) => clamp01(b + s);               // "Add"
const subtract = (b, s) => clamp01(b - s);
const divide = (b, s) => (s === 0 ? (b === 0 ? 0 : 1) : clamp01(b / s));
const linearBurn = (b, s) => clamp01(b + s - 1);
const vividLight = (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1));
const linearLight = (b, s) => clamp01(b + 2 * s - 1);
const pinLight = (b, s) => (s <= 0.5 ? darken(b, 2 * s) : lighten(b, 2 * s - 1));
const hardMix = (b, s) => (vividLight(b, s) < 0.5 ? 0 : 1);
const negation = (b, s) => 1 - Math.abs(1 - b - s);

/** Every per-channel mode, by name. */
export const SEPARABLE = {
  normal: (b, s) => s,
  multiply,
  screen,
  overlay,
  darken,
  lighten,
  'color-dodge': colorDodge,
  'color-burn': colorBurn,
  'hard-light': hardLight,
  'soft-light': softLight,
  difference,
  exclusion,
  // --- not in the W3C spec ---
  'linear-dodge': linearDodge,
  'linear-burn': linearBurn,
  subtract,
  divide,
  'vivid-light': vividLight,
  'linear-light': linearLight,
  'pin-light': pinLight,
  'hard-mix': hardMix,
  negation,
};

/** Modes that need all three channels at once. */
export const NON_SEPARABLE = {
  hue: (cb, cs) => setLum(setSat(cs, sat(cb)), lum(cb[0], cb[1], cb[2])),
  saturation: (cb, cs) => setLum(setSat(cb, sat(cs)), lum(cb[0], cb[1], cb[2])),
  color: (cb, cs) => setLum(cs, lum(cb[0], cb[1], cb[2])),
  luminosity: (cb, cs) => setLum(cb, lum(cs[0], cs[1], cs[2])),
  // --- not in the W3C spec: pick one whole colour, do not mix channels ---
  'darker-color': (cb, cs) => (lum(cs[0], cs[1], cs[2]) < lum(cb[0], cb[1], cb[2]) ? cs : cb),
  'lighter-color': (cb, cs) => (lum(cs[0], cs[1], cs[2]) > lum(cb[0], cb[1], cb[2]) ? cs : cb),
};

/** The order they appear in the UI menu, grouped as Photoshop groups them. */
export const MODE_GROUPS = [
  ['Normal', ['normal']],
  ['Darken', ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color']],
  ['Lighten', ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color']],
  ['Contrast', ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix']],
  ['Inversion', ['difference', 'exclusion', 'subtract', 'divide', 'negation']],
  ['Component', ['hue', 'saturation', 'color', 'luminosity']],
];

export const MODES = MODE_GROUPS.flatMap(([, list]) => list);
export const isSeparable = (mode) => Object.hasOwn(SEPARABLE, mode);
export const isMode = (mode) => isSeparable(mode) || Object.hasOwn(NON_SEPARABLE, mode);

/** The twelve the browser can check us on, plus the four non-separable. */
export const W3C_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

/** The CSS/canvas name for a mode the browser knows, else null. */
export function cssName(mode) {
  return W3C_MODES.includes(mode) ? (mode === 'normal' ? 'source-over' : mode) : null;
}

/** B(Cb, Cs) for any mode, on a whole colour. */
export function blendColor(mode, cb, cs) {
  const sep = SEPARABLE[mode];
  if (sep) return [sep(cb[0], cs[0]), sep(cb[1], cs[1]), sep(cb[2], cs[2])];
  const ns = NON_SEPARABLE[mode];
  if (!ns) throw new Error(`unknown blend mode: ${mode}`);
  return ns(cb, cs);
}

/**
 * One source over one backdrop, both non-premultiplied, per the spec's three
 * steps: blend, composite, un-premultiply.
 *
 * The (1 - ab) term in step 1 is the part people drop. Without it a blend mode
 * has no effect where the backdrop is transparent -- which is right -- but a
 * PARTIALLY transparent backdrop blends as if it were opaque, so a soft brush
 * edge over empty space picks up a dark fringe. It is invisible on an opaque
 * photo and obvious on a logo.
 *
 * @returns [r,g,b,a] non-premultiplied
 */
export function composite(mode, cb, ab, cs, as) {
  if (as <= 0) return [cb[0], cb[1], cb[2], ab];
  const b = blendColor(mode, cb, cs);
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const out = [0, 0, 0, ao];
  for (let i = 0; i < 3; i++) {
    const cr = (1 - ab) * cs[i] + ab * b[i];
    out[i] = (as * cr + ab * cb[i] * (1 - as)) / ao;
  }
  return out;
}
