// The adjustments catalogue.
//
// Every entry is a pure function over a dense Float32 RGBA buffer, straight
// alpha, in the document's encoded space, applied in place. That single
// signature is what lets the SAME function serve a destructive Image >
// Adjustments command and a non-destructive adjustment layer -- and it is why
// the two are provably identical rather than two implementations that drift.
//
// Alpha is never touched. An adjustment changes colour; a pixel that was
// transparent stays transparent, and a tone curve that dragged alpha with it
// would make a feathered edge harden or dissolve.
//
// Each entry also carries `fields`, a declarative form description, so the UI
// generates its dialog from the same place the maths lives. A parameter that
// exists in one and not the other is then impossible rather than merely
// unlikely.

import { clamp, clamp01, lerp, luma709, wrapHue, hueDelta, round } from './util.js';
import {
  srgbToLinear, linearToSrgb, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb,
  rgbToLab, labToRgb,
} from './color.js';
import { monotoneSpline, buildLut, sampleLut, IDENTITY_CURVE, isIdentityCurve } from './curve.js';
import { gaussianBlur } from './convolve.js';

/** Apply a per-channel LUT to RGB, leaving alpha alone. */
function applyLuts(buf, lutR, lutG, lutB) {
  for (let p = 0; p < buf.length; p += 4) {
    buf[p] = sampleLut(lutR, buf[p]);
    buf[p + 1] = sampleLut(lutG, buf[p + 1]);
    buf[p + 2] = sampleLut(lutB, buf[p + 2]);
  }
  return buf;
}

/** Apply one LUT to all three channels. */
function applyLut(buf, lut) { return applyLuts(buf, lut, lut, lut); }

// ------------------------------------------------------------------ invert

function invert(buf) {
  for (let p = 0; p < buf.length; p += 4) {
    buf[p] = 1 - buf[p]; buf[p + 1] = 1 - buf[p + 1]; buf[p + 2] = 1 - buf[p + 2];
  }
  return buf;
}

// ------------------------------------------------- brightness / contrast

/**
 * Brightness is a PROPORTIONAL move towards white or black, not an offset.
 * An offset clips: +0.3 on a photograph flattens everything above 0.7 into
 * pure white and the highlights are gone for good. Moving towards the
 * endpoint instead compresses rather than clips, which is also what makes the
 * slider feel linear.
 *
 * Contrast pivots about mid grey with tan((c+1)*pi/4), so c = 1 is infinite
 * contrast (a threshold) and c = -1 is flat grey, with a smooth ramp between.
 */
function brightnessContrast(buf, w, h, p) {
  const b = clamp(p.brightness ?? 0, -1, 1);
  const c = clamp(p.contrast ?? 0, -1, 1);
  const f = Math.tan(((c + 1) * Math.PI) / 4);
  const lut = buildLut((x) => {
    let v = b >= 0 ? x + (1 - x) * b : x * (1 + b);
    v = (v - 0.5) * f + 0.5;
    return clamp01(v);
  });
  return applyLut(buf, lut);
}

// ------------------------------------------------------------------ levels

function levelChannel(inBlack, inWhite, gamma, outBlack, outWhite) {
  const span = inWhite - inBlack;
  const g = 1 / Math.max(1e-4, gamma);
  return (x) => {
    // A zero or inverted input span is a legitimate thing to drag to: it
    // means "everything becomes the output black or white", not NaN.
    //
    // Through the LUT this is belt and braces -- the division would give
    // +/-Infinity, which clamps to the same 1 and 0, and the single NaN at
    // x == inWhite is never sampled. It matters if the function is ever
    // called directly, which is why it stays.
    let v = span === 0 ? (x >= inWhite ? 1 : 0) : (x - inBlack) / span;
    v = clamp01(v);
    if (gamma !== 1) v = Math.pow(v, g);
    return clamp01(outBlack + v * (outWhite - outBlack));
  };
}

function levels(buf, w, h, p) {
  const def = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 };
  const master = { ...def, ...(p.master || {}) };
  const per = p.channels || {};
  const lutFor = (ch) => {
    const c = { ...def, ...(per[ch] || {}) };
    const fc = levelChannel(c.inBlack, c.inWhite, c.gamma, c.outBlack, c.outWhite);
    const fm = levelChannel(master.inBlack, master.inWhite, master.gamma, master.outBlack, master.outWhite);
    // Per-channel first, then the master -- the order Photoshop uses, and it
    // matters: a master gamma applied before a channel's black point gives a
    // different colour cast.
    return buildLut((x) => fm(fc(x)));
  };
  return applyLuts(buf, lutFor('r'), lutFor('g'), lutFor('b'));
}

// ------------------------------------------------------------------ curves

function curves(buf, w, h, p) {
  const rgb = p.rgb || IDENTITY_CURVE;
  const per = p.channels || {};
  const fm = isIdentityCurve(rgb) ? null : monotoneSpline(rgb);
  const lutFor = (ch) => {
    const pts = per[ch];
    const fc = pts && !isIdentityCurve(pts) ? monotoneSpline(pts) : null;
    if (!fc && !fm) return null;
    return buildLut((x) => {
      let v = fc ? fc(x) : x;
      if (fm) v = fm(v);
      return v;
    });
  };
  const lr = lutFor('r'), lg = lutFor('g'), lb = lutFor('b');
  if (!lr && !lg && !lb) return buf;
  const id = buildLut((x) => x);
  return applyLuts(buf, lr || id, lg || id, lb || id);
}

// ---------------------------------------------------------------- exposure

/**
 * Exposure is the one adjustment that is MEANINGLESS in encoded space: a stop
 * is a doubling of light, so the gain has to happen in linear. Doing it on
 * encoded values gives something that looks like exposure in the midtones and
 * wrong everywhere else.
 */
function exposure(buf, w, h, p) {
  const stops = p.exposure ?? 0;
  const offset = p.offset ?? 0;
  const gamma = Math.max(1e-4, p.gamma ?? 1);
  const gain = Math.pow(2, stops);
  const lut = buildLut((x) => {
    let v = srgbToLinear(x) * gain + offset;
    if (v < 0) v = 0;
    if (gamma !== 1) v = Math.pow(v, 1 / gamma);
    return clamp01(linearToSrgb(v));
  });
  return applyLut(buf, lut);
}

// -------------------------------------------------------------- hue / sat

const BANDS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const BAND_CENTRE = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

/**
 * Weight for a band at a hue: 1 within 30 degrees of the centre, falling to 0
 * by 60. Photoshop's four draggable range handles are this with the inner and
 * outer edges exposed; the fixed falloff keeps the panel to three sliders per
 * band and still blends smoothly, which is the part that matters -- a hard
 * band edge leaves a visible seam across a sky.
 */
function bandWeight(hue, centre) {
  const d = Math.abs(hueDelta(centre, hue));
  if (d <= 30) return 1;
  if (d >= 60) return 0;
  const t = (60 - d) / 30;
  return t * t * (3 - 2 * t);
}

function hueSaturation(buf, w, h, p) {
  const m = p.master || {};
  const mh = m.hue ?? 0, ms = m.saturation ?? 0, ml = m.lightness ?? 0;
  const bands = p.bands || {};
  const colorize = !!p.colorize;
  const cHue = p.colorizeHue ?? 0, cSat = p.colorizeSaturation ?? 0.25, cLight = p.colorizeLightness ?? 0;
  const active = BANDS.filter((b) => bands[b] && (bands[b].hue || bands[b].saturation || bands[b].lightness));

  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    let hsl = rgbToHsl(buf[p0], buf[p0 + 1], buf[p0 + 2]);
    if (colorize) {
      // Colorize throws the original hue away: the pixel keeps its lightness
      // and takes the chosen hue and saturation.
      let L = hsl[2];
      if (cLight > 0) L = L + (1 - L) * cLight;
      else if (cLight < 0) L = L * (1 + cLight);
      const out = hslToRgb(cHue, clamp01(cSat), clamp01(L));
      buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
      continue;
    }
    let [H, S, L] = hsl;
    let dh = mh, ds = ms, dl = ml;
    for (const b of active) {
      const wgt = bandWeight(H, BAND_CENTRE[b]);
      if (wgt === 0) continue;
      const cfg = bands[b];
      dh += (cfg.hue ?? 0) * wgt;
      ds += (cfg.saturation ?? 0) * wgt;
      dl += (cfg.lightness ?? 0) * wgt;
    }
    H = wrapHue(H + dh);
    // Saturation is a proportional move, like brightness, so +1 saturates
    // fully and -1 is grey, with no clipping in between.
    S = ds >= 0 ? S + (1 - S) * ds : S * (1 + ds);
    L = dl >= 0 ? L + (1 - L) * dl : L * (1 + dl);
    const out = hslToRgb(H, clamp01(S), clamp01(L));
    buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
  }
  return buf;
}

// ---------------------------------------------------------------- vibrance

/**
 * Vibrance boosts the LEAST saturated colours most, so skies and foliage lift
 * while skin tones (already fairly saturated) stay put. A plain saturation
 * slider does the opposite and that is why portraits go orange.
 */
function vibrance(buf, w, h, p) {
  const amount = clamp(p.amount ?? 0, -1, 1);
  if (amount === 0) return buf;
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const [H, S, L] = rgbToHsl(buf[p0], buf[p0 + 1], buf[p0 + 2]);
    const weight = 1 - S;                 // low saturation gets the full boost
    const a = amount * weight;
    const S2 = a >= 0 ? S + (1 - S) * a : S * (1 + a);
    const out = hslToRgb(H, clamp01(S2), L);
    buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
  }
  return buf;
}

// --------------------------------------------------------- colour balance

/** Tonal weights that sum to 1 at every input, so a shift applied equally to
 *  all three ranges is a flat shift rather than a lumpy one. */
function tonalWeights(v) {
  const shadow = Math.max(0, 1 - v * 2);
  const high = Math.max(0, v * 2 - 1);
  return [shadow, 1 - shadow - high, high];
}

function colorBalance(buf, w, h, p) {
  const sh = p.shadows || [0, 0, 0];
  const mid = p.midtones || [0, 0, 0];
  const hi = p.highlights || [0, 0, 0];
  const preserve = p.preserveLuminosity !== false;
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const r = buf[p0], g = buf[p0 + 1], b = buf[p0 + 2];
    const before = luma709(r, g, b);
    const out = [r, g, b];
    for (let c = 0; c < 3; c++) {
      const [ws, wm, wh] = tonalWeights(out[c]);
      const shift = sh[c] * ws + mid[c] * wm + hi[c] * wh;
      out[c] = clamp01(shift >= 0 ? out[c] + (1 - out[c]) * shift : out[c] * (1 + shift));
    }
    if (preserve) {
      const after = luma709(out[0], out[1], out[2]);
      if (after > 1e-6) {
        const k = before / after;
        for (let c = 0; c < 3; c++) out[c] = clamp01(out[c] * k);
      }
    }
    buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
  }
  return buf;
}

// ------------------------------------------------------------ black & white

function blackWhite(buf, w, h, p) {
  // Photoshop's six sliders are multipliers on how much each hue family
  // contributes to the grey. Defaults are its own defaults.
  const g = {
    reds: p.reds ?? 0.4, yellows: p.yellows ?? 0.6, greens: p.greens ?? 0.4,
    cyans: p.cyans ?? 0.6, blues: p.blues ?? 0.2, magentas: p.magentas ?? 0.8,
  };
  const tint = p.tint ? { hue: p.tintHue ?? 40, sat: p.tintSaturation ?? 0.25 } : null;
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const r = buf[p0], gg = buf[p0 + 1], b = buf[p0 + 2];
    const [H, S, L] = rgbToHsl(r, gg, b);
    let weight = 0, wsum = 0;
    for (const band of BANDS) {
      const wgt = bandWeight(H, BAND_CENTRE[band]);
      if (wgt === 0) continue;
      weight += g[band] * wgt;
      wsum += wgt;
    }
    const mix = wsum > 0 ? weight / wsum : 0.5;
    // A saturated pixel's grey is its own brightness scaled by the slider for
    // its hue; a neutral pixel keeps its lightness, because a hue slider has
    // nothing to say about a grey. Blending the two by saturation reproduces
    // Photoshop's defaults exactly: pure red -> 40%, yellow -> 60%,
    // green -> 40%, cyan -> 60%, blue -> 20%, magenta -> 80%.
    const mx = Math.max(r, gg, b);
    const v = clamp01(lerp(L, mx * mix, S));
    if (tint) {
      const out = hslToRgb(tint.hue, tint.sat, v);
      buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
    } else {
      buf[p0] = buf[p0 + 1] = buf[p0 + 2] = v;
    }
  }
  return buf;
}

// ----------------------------------------------------------- photo filter

function photoFilter(buf, w, h, p) {
  const col = p.color || [1, 0.45, 0.1];
  const density = clamp01(p.density ?? 0.25);
  const preserve = p.preserveLuminosity !== false;
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const before = luma709(buf[p0], buf[p0 + 1], buf[p0 + 2]);
    const out = [0, 0, 0];
    // A filter over a lens MULTIPLIES, so that is the blend -- a mix towards
    // the filter colour would wash the image out instead of tinting it.
    for (let c = 0; c < 3; c++) out[c] = lerp(buf[p0 + c], buf[p0 + c] * col[c], density);
    if (preserve) {
      const after = luma709(out[0], out[1], out[2]);
      if (after > 1e-6) {
        const k = before / after;
        for (let c = 0; c < 3; c++) out[c] = clamp01(out[c] * k);
      }
    }
    buf[p0] = out[0]; buf[p0 + 1] = out[1]; buf[p0 + 2] = out[2];
  }
  return buf;
}

// ---------------------------------------------------------- channel mixer

function channelMixer(buf, w, h, p) {
  const m = p.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const con = p.constant || [0, 0, 0];
  const mono = !!p.monochrome;
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const r = buf[p0], g = buf[p0 + 1], b = buf[p0 + 2];
    if (mono) {
      const v = clamp01(m[0][0] * r + m[0][1] * g + m[0][2] * b + con[0]);
      buf[p0] = buf[p0 + 1] = buf[p0 + 2] = v;
    } else {
      buf[p0] = clamp01(m[0][0] * r + m[0][1] * g + m[0][2] * b + con[0]);
      buf[p0 + 1] = clamp01(m[1][0] * r + m[1][1] * g + m[1][2] * b + con[1]);
      buf[p0 + 2] = clamp01(m[2][0] * r + m[2][1] * g + m[2][2] * b + con[2]);
    }
  }
  return buf;
}

// ------------------------------------------------ posterize / threshold

function posterize(buf, w, h, p) {
  const n = Math.max(2, Math.round(p.levels ?? 4));
  // (n-1) steps between n levels, and the endpoints must land exactly on 0
  // and 1 -- rounding to n*x/n instead leaves the darkest band off black.
  const lut = buildLut((x) => round(x * (n - 1)) / (n - 1));
  return applyLut(buf, lut);
}

function threshold(buf, w, h, p) {
  const t = clamp01(p.level ?? 0.5);
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const v = luma709(buf[p0], buf[p0 + 1], buf[p0 + 2]) >= t ? 1 : 0;
    buf[p0] = buf[p0 + 1] = buf[p0 + 2] = v;
  }
  return buf;
}

function desaturate(buf, w, h, p) {
  const mode = p.mode || 'luminosity';
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const r = buf[p0], g = buf[p0 + 1], b = buf[p0 + 2];
    let v;
    if (mode === 'average') v = (r + g + b) / 3;
    else if (mode === 'lightness') v = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    else v = luma709(r, g, b);
    buf[p0] = buf[p0 + 1] = buf[p0 + 2] = v;
  }
  return buf;
}

// -------------------------------------------------------------- gradient map

export function sampleStops(stops, t) {
  if (!stops || !stops.length) return [t, t, t];
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (t <= s[0].pos) return s[0].color.slice(0, 3);
  if (t >= s[s.length - 1].pos) return s[s.length - 1].color.slice(0, 3);
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].pos && t <= s[i + 1].pos) {
      const span = s[i + 1].pos - s[i].pos;
      let f = span === 0 ? 0 : (t - s[i].pos) / span;
      // A midpoint moves where the halfway colour lands, as a power curve --
      // the little diamond between two stops in every gradient editor.
      const mid = s[i].mid === undefined ? 0.5 : clamp(s[i].mid, 0.01, 0.99);
      f = Math.pow(f, Math.log(0.5) / Math.log(mid));
      return [
        lerp(s[i].color[0], s[i + 1].color[0], f),
        lerp(s[i].color[1], s[i + 1].color[1], f),
        lerp(s[i].color[2], s[i + 1].color[2], f),
      ];
    }
  }
  return s[s.length - 1].color.slice(0, 3);
}

function gradientMap(buf, w, h, p) {
  const stops = p.stops || [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }];
  const reverse = !!p.reverse;
  const size = 1024;
  const map = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const t = reverse ? 1 - i / (size - 1) : i / (size - 1);
    const c = sampleStops(stops, t);
    map[i * 3] = c[0]; map[i * 3 + 1] = c[1]; map[i * 3 + 2] = c[2];
  }
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const v = clamp01(luma709(buf[p0], buf[p0 + 1], buf[p0 + 2]));
    const f = v * (size - 1);
    const i = f | 0;
    const j = Math.min(size - 1, i + 1);
    const t = f - i;
    buf[p0] = lerp(map[i * 3], map[j * 3], t);
    buf[p0 + 1] = lerp(map[i * 3 + 1], map[j * 3 + 1], t);
    buf[p0 + 2] = lerp(map[i * 3 + 2], map[j * 3 + 2], t);
  }
  return buf;
}

// ------------------------------------------------------- selective colour

const SEL_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

function selectiveColor(buf, w, h, p) {
  const adj = p.ranges || {};
  const relative = p.mode !== 'absolute';
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const r = buf[p0], g = buf[p0 + 1], b = buf[p0 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const [H, S] = rgbToHsl(r, g, b);

    // Six hue families weighted by how saturated the pixel is, plus the three
    // achromatic ranges Photoshop adds -- those are what let "Neutrals" lift a
    // grey cast and "Blacks" open up shadows.
    const weights = {};
    for (const band of BANDS) weights[band] = bandWeight(H, BAND_CENTRE[band]) * S;
    weights.whites = Math.max(0, (mn - 0.5) * 2);
    weights.blacks = Math.max(0, 1 - mx * 2);
    weights.neutrals = (1 - S) * (1 - Math.abs(mx + mn - 1));

    // Work in CMYK: separate the grey component K out of CMY, so the black
    // slider and the colour sliders cannot fight over the same ink.
    //
    // The division by (1 - k) is NOT optional, and leaving it out is a bug
    // that only shows up when every slider is at zero: with a plain
    // subtraction the decomposition does not invert the reconstruction below,
    // and selective colour with no adjustment at all shifted (0.30, 0.70,
    // 0.45) to (0.42, 0.70, 0.53). These two must be an exact inverse pair.
    let c = 1 - r, m = 1 - g, y = 1 - b;
    const k0 = Math.min(c, m, y);
    let k = k0;
    const d = 1 - k0;
    if (d > 1e-9) { c = (c - k0) / d; m = (m - k0) / d; y = (y - k0) / d; }
    else { c = 0; m = 0; y = 0; }            // pure black has no chroma to adjust

    let dc = 0, dm = 0, dy = 0, dk = 0;
    for (const range of SEL_RANGES) {
      const a = adj[range];
      if (!a) continue;
      const wgt = clamp01(weights[range] || 0);
      if (wgt <= 0) continue;
      dc += (a.cyan ?? 0) * wgt;
      dm += (a.magenta ?? 0) * wgt;
      dy += (a.yellow ?? 0) * wgt;
      dk += (a.black ?? 0) * wgt;
    }

    if (relative) {
      // Relative moves each ink by a PERCENTAGE OF WHAT IS ALREADY THERE, so
      // a range holding no cyan cannot gain any -- which is the whole point of
      // the mode, and why it is the default.
      c += c * dc; m += m * dm; y += y * dy; k += k * dk;
    } else {
      c += dc; m += dm; y += dy; k += dk;
    }
    c = clamp01(c); m = clamp01(m); y = clamp01(y); k = clamp01(k);

    // The standard CMYK -> RGB: ink over a grey level.
    buf[p0] = clamp01((1 - c) * (1 - k));
    buf[p0 + 1] = clamp01((1 - m) * (1 - k));
    buf[p0 + 2] = clamp01((1 - y) * (1 - k));
  }
  return buf;
}

// ------------------------------------------------------- white balance

/**
 * Temperature and tint as a scaling in LINEAR light, which is where a light
 * source's colour actually multiplies. The coefficients are a smooth
 * approximation rather than a real black-body curve: it is a creative slider
 * here, not a measurement, and saying so is better than implying otherwise.
 */
function whiteBalance(buf, w, h, p) {
  const temp = clamp(p.temperature ?? 0, -1, 1);
  const tint = clamp(p.tint ?? 0, -1, 1);
  const kr = Math.pow(2, temp * 0.6);
  const kb = Math.pow(2, -temp * 0.6);
  const kg = Math.pow(2, -tint * 0.4);
  const km = Math.pow(2, tint * 0.2);
  const lutR = buildLut((x) => clamp01(linearToSrgb(srgbToLinear(x) * kr * km)));
  const lutG = buildLut((x) => clamp01(linearToSrgb(srgbToLinear(x) * kg)));
  const lutB = buildLut((x) => clamp01(linearToSrgb(srgbToLinear(x) * kb * km)));
  return applyLuts(buf, lutR, lutG, lutB);
}

// ------------------------------------------------------- colour lookup

/** Trilinear sample of a cubic 3-D LUT stored as size^3 RGB triples. */
export function sampleLut3d(lut, size, r, g, b) {
  const s1 = size - 1;
  const fr = clamp01(r) * s1, fg = clamp01(g) * s1, fb = clamp01(b) * s1;
  const ir = Math.min(s1 - 1, Math.max(0, fr | 0));
  const ig = Math.min(s1 - 1, Math.max(0, fg | 0));
  const ib = Math.min(s1 - 1, Math.max(0, fb | 0));
  const tr = fr - ir, tg = fg - ig, tb = fb - ib;
  // .cube is R-fastest: index = r + g*size + b*size*size
  const at = (x, y, z, c) => lut[((x + y * size + z * size * size) * 3) + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(at(ir, ig, ib, c), at(ir + 1, ig, ib, c), tr);
    const c10 = lerp(at(ir, ig + 1, ib, c), at(ir + 1, ig + 1, ib, c), tr);
    const c01 = lerp(at(ir, ig, ib + 1, c), at(ir + 1, ig, ib + 1, c), tr);
    const c11 = lerp(at(ir, ig + 1, ib + 1, c), at(ir + 1, ig + 1, ib + 1, c), tr);
    out[c] = lerp(lerp(c00, c10, tg), lerp(c01, c11, tg), tb);
  }
  return out;
}

function colorLookup(buf, w, h, p) {
  const lut = p.lut;
  const size = p.size || 0;
  if (!lut || size < 2) return buf;
  const amount = p.amount === undefined ? 1 : clamp01(p.amount);
  for (let p0 = 0; p0 < buf.length; p0 += 4) {
    const o = sampleLut3d(lut, size, buf[p0], buf[p0 + 1], buf[p0 + 2]);
    buf[p0] = lerp(buf[p0], o[0], amount);
    buf[p0 + 1] = lerp(buf[p0 + 1], o[1], amount);
    buf[p0 + 2] = lerp(buf[p0 + 2], o[2], amount);
  }
  return buf;
}

/** Parse an Adobe/Resolve .cube file. Returns { lut, size } or throws. */
export function parseCube(text) {
  let size = 0;
  const vals = [];
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (m) { size = parseInt(m[1], 10); continue; }
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1-D .cube LUTs are not supported, only LUT_3D_SIZE');
    let d = line.match(/^DOMAIN_MIN\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/i);
    if (d) { domainMin = [+d[1], +d[2], +d[3]]; continue; }
    d = line.match(/^DOMAIN_MAX\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/i);
    if (d) { domainMax = [+d[1], +d[2], +d[3]]; continue; }
    if (/^[A-Za-z_]/.test(line)) continue;                      // TITLE and friends
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) vals.push(parts[0], parts[1], parts[2]);
  }
  if (!size) throw new Error('no LUT_3D_SIZE in the .cube file');
  if (vals.length !== size * size * size * 3) {
    throw new Error(`.cube says size ${size} (${size ** 3} entries) but has ${vals.length / 3}`);
  }
  const lut = new Float32Array(vals.length);
  // A non-unit domain is rare and silently wrong if ignored, so rescale it.
  for (let i = 0; i < vals.length; i++) {
    const c = i % 3;
    const span = domainMax[c] - domainMin[c] || 1;
    lut[i] = (vals[i] - domainMin[c]) / span;
  }
  return { lut, size };
}

// ---------------------------------------------------- shadows / highlights

/**
 * Lift shadows and recover highlights using a BLURRED luminance as the mask,
 * which is what makes it local rather than a global curve: a dark face
 * against a bright window gets lifted without flattening the window.
 *
 * The radius is the whole character of the effect. Too small and it haloes
 * every edge; too large and it degenerates into a tone curve.
 */
function shadowsHighlights(buf, w, h, p) {
  const sAmount = clamp01(p.shadowAmount ?? 0.3);
  const sTone = clamp01(p.shadowTone ?? 0.5);
  const hAmount = clamp01(p.highlightAmount ?? 0);
  const hTone = clamp01(p.highlightTone ?? 0.5);
  const radius = Math.max(0, p.radius ?? 30);
  if (sAmount === 0 && hAmount === 0) return buf;

  // A luminance copy, blurred, as an RGBA buffer so gaussianBlur can take it.
  const lum = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    const v = luma709(buf[i], buf[i + 1], buf[i + 2]);
    lum[i] = lum[i + 1] = lum[i + 2] = v;
    lum[i + 3] = 1;
  }
  if (radius > 0) gaussianBlur(lum, w, h, radius, 'clamp');

  for (let i = 0; i < buf.length; i += 4) {
    const L = lum[i];
    // Tone width controls how far up the range each correction reaches.
    const sMask = Math.pow(clamp01(1 - L / Math.max(1e-4, sTone)), 2);
    const hMask = Math.pow(clamp01((L - (1 - hTone)) / Math.max(1e-4, hTone)), 2);
    const lift = sAmount * sMask;
    const pull = hAmount * hMask;
    for (let c = 0; c < 3; c++) {
      let v = buf[i + c];
      if (lift > 0) v = v + (1 - v) * lift;
      if (pull > 0) v = v * (1 - pull);
      buf[i + c] = clamp01(v);
    }
  }
  return buf;
}

// ------------------------------------------------------------- the registry
//
// `neutral`, where present, is a parameter set for which the adjustment is
// exactly the identity. The oracle asserts that over thousands of colours,
// and it is worth having: with no sliders moved at all, selective colour was
// shifting (0.30, 0.70, 0.45) to (0.42, 0.70, 0.53), because its CMYK
// decomposition and its reconstruction were not an inverse pair. No visual
// review would have found that -- you have to look for the identity.
//
// Entries with NO neutral are the ones that are destructive by definition:
// invert, threshold, posterize, desaturate, blackWhite, gradientMap. Their
// anchors are asserted individually instead.

export const ADJUSTMENTS = {
  brightnessContrast: {
    label: 'Brightness / Contrast', group: 'Tone',
    defaults: { brightness: 0, contrast: 0 },
    neutral: { brightness: 0, contrast: 0 },
    fields: [['Brightness', 'brightness', 'num', -1, 1, 0.01], ['Contrast', 'contrast', 'num', -1, 1, 0.01]],
    apply: brightnessContrast,
  },
  levels: {
    label: 'Levels', group: 'Tone',
    defaults: { master: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }, channels: {} },
    neutral: { master: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }, channels: {} },
    fields: [
      ['Black in', 'master.inBlack', 'num', 0, 1, 0.002],
      ['White in', 'master.inWhite', 'num', 0, 1, 0.002],
      ['Gamma', 'master.gamma', 'num', 0.1, 9.99, 0.01],
      ['Black out', 'master.outBlack', 'num', 0, 1, 0.002],
      ['White out', 'master.outWhite', 'num', 0, 1, 0.002],
    ],
    apply: levels,
  },
  curves: {
    label: 'Curves', group: 'Tone',
    defaults: { rgb: IDENTITY_CURVE, channels: {} },
    neutral: { rgb: IDENTITY_CURVE, channels: {} },
    fields: [['Curve', 'rgb', 'curve']],
    apply: curves,
  },
  exposure: {
    label: 'Exposure', group: 'Tone',
    defaults: { exposure: 0, offset: 0, gamma: 1 },
    neutral: { exposure: 0, offset: 0, gamma: 1 },
    fields: [
      ['Exposure', 'exposure', 'num', -5, 5, 0.01],
      ['Offset', 'offset', 'num', -0.5, 0.5, 0.001],
      ['Gamma', 'gamma', 'num', 0.1, 4, 0.01],
    ],
    apply: exposure,
  },
  shadowsHighlights: {
    label: 'Shadows / Highlights', group: 'Tone',
    defaults: { shadowAmount: 0.3, shadowTone: 0.5, highlightAmount: 0, highlightTone: 0.5, radius: 30 },
    neutral: { shadowAmount: 0, highlightAmount: 0 },
    fields: [
      ['Shadows', 'shadowAmount', 'num', 0, 1, 0.01],
      ['Shadow range', 'shadowTone', 'num', 0.05, 1, 0.01],
      ['Highlights', 'highlightAmount', 'num', 0, 1, 0.01],
      ['Highlight range', 'highlightTone', 'num', 0.05, 1, 0.01],
      ['Radius', 'radius', 'num', 0, 200, 1],
    ],
    apply: shadowsHighlights,
  },
  hueSaturation: {
    label: 'Hue / Saturation', group: 'Colour',
    defaults: { master: { hue: 0, saturation: 0, lightness: 0 }, bands: {}, colorize: false, colorizeHue: 0, colorizeSaturation: 0.25, colorizeLightness: 0 },
    neutral: { master: { hue: 0, saturation: 0, lightness: 0 }, bands: {}, colorize: false },
    fields: [
      ['Hue', 'master.hue', 'num', -180, 180, 1],
      ['Saturation', 'master.saturation', 'num', -1, 1, 0.01],
      ['Lightness', 'master.lightness', 'num', -1, 1, 0.01],
      ['Colorize', 'colorize', 'bool'],
      ['Tint hue', 'colorizeHue', 'num', 0, 360, 1],
      ['Tint sat', 'colorizeSaturation', 'num', 0, 1, 0.01],
    ],
    apply: hueSaturation,
  },
  vibrance: {
    label: 'Vibrance', group: 'Colour',
    defaults: { amount: 0 },
    neutral: { amount: 0 },
    fields: [['Vibrance', 'amount', 'num', -1, 1, 0.01]],
    apply: vibrance,
  },
  colorBalance: {
    label: 'Colour Balance', group: 'Colour',
    defaults: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true },
    neutral: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true },
    fields: [
      ['Shadows R', 'shadows.0', 'num', -1, 1, 0.01],
      ['Shadows G', 'shadows.1', 'num', -1, 1, 0.01],
      ['Shadows B', 'shadows.2', 'num', -1, 1, 0.01],
      ['Mid R', 'midtones.0', 'num', -1, 1, 0.01],
      ['Mid G', 'midtones.1', 'num', -1, 1, 0.01],
      ['Mid B', 'midtones.2', 'num', -1, 1, 0.01],
      ['High R', 'highlights.0', 'num', -1, 1, 0.01],
      ['High G', 'highlights.1', 'num', -1, 1, 0.01],
      ['High B', 'highlights.2', 'num', -1, 1, 0.01],
      ['Keep luminosity', 'preserveLuminosity', 'bool'],
    ],
    apply: colorBalance,
  },
  whiteBalance: {
    label: 'White Balance', group: 'Colour',
    defaults: { temperature: 0, tint: 0 },
    neutral: { temperature: 0, tint: 0 },
    fields: [['Temperature', 'temperature', 'num', -1, 1, 0.01], ['Tint', 'tint', 'num', -1, 1, 0.01]],
    apply: whiteBalance,
  },
  photoFilter: {
    label: 'Photo Filter', group: 'Colour',
    defaults: { color: [1, 0.45, 0.1], density: 0.25, preserveLuminosity: true },
    neutral: { color: [1, 0.45, 0.1], density: 0, preserveLuminosity: true },
    fields: [['Colour', 'color', 'col'], ['Density', 'density', 'num', 0, 1, 0.01], ['Keep luminosity', 'preserveLuminosity', 'bool']],
    apply: photoFilter,
  },
  channelMixer: {
    label: 'Channel Mixer', group: 'Colour',
    defaults: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], constant: [0, 0, 0], monochrome: false },
    neutral: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], constant: [0, 0, 0], monochrome: false },
    fields: [
      ['R from R', 'matrix.0.0', 'num', -2, 2, 0.01], ['R from G', 'matrix.0.1', 'num', -2, 2, 0.01], ['R from B', 'matrix.0.2', 'num', -2, 2, 0.01],
      ['G from R', 'matrix.1.0', 'num', -2, 2, 0.01], ['G from G', 'matrix.1.1', 'num', -2, 2, 0.01], ['G from B', 'matrix.1.2', 'num', -2, 2, 0.01],
      ['B from R', 'matrix.2.0', 'num', -2, 2, 0.01], ['B from G', 'matrix.2.1', 'num', -2, 2, 0.01], ['B from B', 'matrix.2.2', 'num', -2, 2, 0.01],
      ['Monochrome', 'monochrome', 'bool'],
    ],
    apply: channelMixer,
  },
  selectiveColor: {
    label: 'Selective Colour', group: 'Colour',
    defaults: { ranges: {}, mode: 'relative' },
    neutral: { ranges: {}, mode: 'relative' },
    fields: [['Mode', 'mode', 'sel', ['relative', 'absolute']]],
    apply: selectiveColor,
  },
  colorLookup: {
    label: 'Colour Lookup (.cube)', group: 'Colour',
    defaults: { lut: null, size: 0, amount: 1 },
    neutral: { lut: null, size: 0, amount: 1 },
    fields: [['Amount', 'amount', 'num', 0, 1, 0.01]],
    apply: colorLookup,
  },
  blackWhite: {
    label: 'Black & White', group: 'Mono',
    defaults: { reds: 0.4, yellows: 0.6, greens: 0.4, cyans: 0.6, blues: 0.2, magentas: 0.8, tint: false, tintHue: 40, tintSaturation: 0.25 },
    fields: [
      ['Reds', 'reds', 'num', -2, 3, 0.01], ['Yellows', 'yellows', 'num', -2, 3, 0.01],
      ['Greens', 'greens', 'num', -2, 3, 0.01], ['Cyans', 'cyans', 'num', -2, 3, 0.01],
      ['Blues', 'blues', 'num', -2, 3, 0.01], ['Magentas', 'magentas', 'num', -2, 3, 0.01],
      ['Tint', 'tint', 'bool'], ['Tint hue', 'tintHue', 'num', 0, 360, 1], ['Tint sat', 'tintSaturation', 'num', 0, 1, 0.01],
    ],
    apply: blackWhite,
  },
  desaturate: {
    label: 'Desaturate', group: 'Mono',
    defaults: { mode: 'luminosity' },
    fields: [['Method', 'mode', 'sel', ['luminosity', 'average', 'lightness']]],
    apply: desaturate,
  },
  gradientMap: {
    label: 'Gradient Map', group: 'Map',
    defaults: { stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }], reverse: false },
    fields: [['Reverse', 'reverse', 'bool']],
    apply: gradientMap,
  },
  invert: { label: 'Invert', group: 'Map', defaults: {}, fields: [], apply: invert },
  posterize: {
    label: 'Posterize', group: 'Map',
    defaults: { levels: 4 },
    fields: [['Levels', 'levels', 'num', 2, 255, 1]],
    apply: posterize,
  },
  threshold: {
    label: 'Threshold', group: 'Map',
    defaults: { level: 0.5 },
    fields: [['Level', 'level', 'num', 0, 1, 0.004]],
    apply: threshold,
  },
};

export const ADJUST_KINDS = Object.keys(ADJUSTMENTS);

/** Apply one adjustment by name. The signature compositeDoc() expects. */
export function applyAdjust(kind, params, buf, w, h) {
  const a = ADJUSTMENTS[kind];
  if (!a) throw new Error(`unknown adjustment: ${kind}`);
  return a.apply(buf, w, h, { ...a.defaults, ...(params || {}) });
}

/** Defaults for a kind, deep enough to edit without aliasing the catalogue. */
export function adjustDefaults(kind) {
  const a = ADJUSTMENTS[kind];
  if (!a) throw new Error(`unknown adjustment: ${kind}`);
  return structuredClone(a.defaults);
}
