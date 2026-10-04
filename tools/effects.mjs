// Oracle: layer effects.
//
// There is no reference implementation of "Photoshop's drop shadow" to compare
// against -- the effects are stylistic, and their exact look is a choice. What
// is NOT a choice is the set of properties the compositor has to keep for them
// to be usable, and those are all exactly stateable:
//
//   region consistency  compositing a sub-rect == that window of the whole
//                       composite, BIT-IDENTICAL. This is the one that matters.
//                       An effect reads outside the rect it draws into, so it
//                       is where every margin bug lands, and a margin bug is
//                       invisible until you scroll.
//   translation         move the pixels, the whole result moves with them
//   fill opacity        at Fill 0 the output cannot depend on the layer's
//                       COLOUR, only on its alpha -- that IS the feature
//   opacity 0           an effect at zero opacity is an absent effect
//   containment         an inner effect writes no pixel where alpha is 0;
//                       an outer one writes none where alpha is 1
//   order               the draw order is fixed, not the order of the list
//
// Two independent references do get used where one exists: scipy for the blur
// the shadow is built on, and closed-form geometry for the stroke -- the ink
// in a ring stroked around a disc is pi((R+s)^2 - R^2) and nothing else.

import { Doc, Layer } from '../js/core/doc.js';
import { compositeDoc } from '../js/core/composite.js';
import { Surface } from '../js/core/tiles.js';
import { rect, mulberry32 } from '../js/core/util.js';
import {
  EFFECT_TYPES, EFFECT_FIELDS, EFFECT_LABELS, effectDefaults,
  effectMargin, layerMargin, hasEffects, renderEffects,
} from '../js/core/effects.js';
import { History } from '../js/core/history.js';
import { ok, eq, worst, note, done } from './_harness.mjs';
import { runPython, havePython } from './_py.mjs';

const W = 61, H = 47;        // prime, so no stride accident hides anything

/** A document with one raster layer carrying a shape, plus a backdrop. */
function buildDoc(effects, { shape = 'blob', seed = 1, dx = 0, dy = 0, color = null } = {}) {
  const doc = new Doc({ w: W, h: H });
  doc.layers = [];
  // A mid-grey backdrop, so a multiply shadow and a screen glow both show.
  const back = new Surface(W, H, 4, 16);
  const bb = new Float32Array(W * H * 4);
  const rnd = mulberry32(seed * 7919);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    bb[p] = 0.35 + rnd() * 0.3; bb[p + 1] = 0.4 + rnd() * 0.3; bb[p + 2] = 0.45 + rnd() * 0.3;
    bb[p + 3] = 1;
  }
  back.writeRect(rect(0, 0, W, H), bb);
  doc.layers.push(new Layer({ name: 'bg', surface: back }));

  const surf = new Surface(W, H, 4, 16);
  const sb = new Float32Array(W * H * 4);
  const col = color || [0.15, 0.45, 0.85];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = 0;
      if (shape === 'blob') {
        // Two overlapping discs and a bar: concave corners and a thin neck,
        // which is where a stroke or a bevel built by dilation goes wrong.
        const d1 = Math.hypot(x - (18 + dx), y - (20 + dy));
        const d2 = Math.hypot(x - (34 + dx), y - (26 + dy));
        const inBar = y - dy >= 14 && y - dy <= 18 && x - dx >= 20 && x - dx <= 44;
        a = (d1 < 9 || d2 < 7 || inBar) ? 1 : 0;
        // a soft edge somewhere, so nothing assumes a binary mask
        if (!a && Math.min(d1 - 9, d2 - 7) < 1.2) a = 0.45;
      } else if (shape === 'disc') {
        const d = Math.hypot(x + 0.5 - (W / 2 + dx), y + 0.5 - (H / 2 + dy));
        a = d <= 12 ? 1 : 0;
      }
      if (!a) continue;
      const p = (y * W + x) * 4;
      sb[p] = col[0]; sb[p + 1] = col[1]; sb[p + 2] = col[2]; sb[p + 3] = a;
    }
  }
  surf.writeRect(rect(0, 0, W, H), sb);
  doc.layers.push(new Layer({ name: 'fx', surface: surf, effects }));
  return doc;
}

const ALL = EFFECT_TYPES.map((t) => effectDefaults(t));

/** Every effect, with its parameters shaken about so no default is load-bearing. */
function variants(seed) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  return EFFECT_TYPES.map((type) => {
    const fx = effectDefaults(type);
    for (const f of EFFECT_FIELDS[type]) {
      const [, key, kind, ...rest] = f;
      if (kind === 'num') {
        const [lo, hi] = rest;
        fx[key] = lo + rnd() * (hi - lo);
      } else if (kind === 'bool') fx[key] = rnd() < 0.5;
      else if (kind === 'sel') fx[key] = pick(rest[0]);
      else if (kind === 'col') fx[key] = [rnd(), rnd(), rnd()];
    }
    // Keep the sizes modest or a 61x47 document is entirely inside the effect.
    if (fx.size !== undefined) fx.size = Math.min(fx.size, 14);
    if (fx.distance !== undefined) fx.distance = Math.min(fx.distance, 10);
    return fx;
  });
}

// ------------------------------------------------- the catalogue is complete

{
  for (const t of EFFECT_TYPES) {
    ok(EFFECT_FIELDS[t] && EFFECT_FIELDS[t].length > 0, `${t}: has fields`);
    ok(typeof EFFECT_LABELS[t] === 'string', `${t}: has a label`);
    const d = effectDefaults(t);
    eq(d.type, t, `${t}: defaults carry the type`);
    for (const [, key] of EFFECT_FIELDS[t]) {
      ok(key in d, `${t}: field ${key} has a default`);
    }
  }
  // A field the panel can edit but nothing reads is a dead control. `opacity`
  // and `blend` are the two that leave effects.js unread on purpose: they come
  // back out in the returned descriptor and are applied by the COMPOSITOR, so
  // look for them there instead of excusing them.
  const fs = await import('node:fs');
  const srcText = fs.readFileSync(new URL('../js/core/effects.js', import.meta.url), 'utf8');
  const compText = fs.readFileSync(new URL('../js/core/composite.js', import.meta.url), 'utf8');
  ok(compText.includes('e.opacity'), 'the compositor applies each effect opacity');
  ok(compText.includes('e.blend'), 'the compositor applies each effect blend mode');
  for (const t of EFFECT_TYPES) {
    for (const [, key, kind] of EFFECT_FIELDS[t]) {
      if (kind === 'col') continue;          // read via fx.color / fx.highlight
      if (key === 'opacity') continue;       // applied by the compositor, above
      ok(srcText.includes(`fx.${key}`), `${t}: ${key} is read by the renderer`);
    }
  }
  note(`${EFFECT_TYPES.length} effects, ${EFFECT_TYPES.reduce((a, t) => a + EFFECT_FIELDS[t].length, 0)} fields`);
}

// ------------------------------------------- region consistency (the big one)

{
  // Composite the whole document, then composite windows of it, and demand the
  // windows are BIT-IDENTICAL to the corresponding part of the whole. Not
  // "close": the two take the same code path on the same numbers, so any
  // difference at all is a margin that is too small.
  const windows = [
    rect(0, 0, 13, 11), rect(17, 9, 20, 15), rect(30, 20, 31, 27),
    rect(W - 5, H - 5, 5, 5), rect(0, H - 7, 9, 7), rect(25, 0, 7, H),
  ];
  let worstDiff = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const vs = variants(seed);
    for (const fx of vs) {
      const doc = buildDoc([fx], { seed });
      const whole = compositeDoc(doc, null, {});
      for (const win of windows) {
        const part = compositeDoc(doc, win, {});
        let bad = 0;
        for (let y = 0; y < win.h; y++) {
          for (let x = 0; x < win.w; x++) {
            for (let c = 0; c < 4; c++) {
              const a = part[(y * win.w + x) * 4 + c];
              const b = whole[((win.y + y) * W + win.x + x) * 4 + c];
              const d = Math.abs(a - b);
              if (d > worstDiff) worstDiff = d;
              if (a !== b) bad++;
            }
          }
        }
        eq(bad, 0, `${fx.type} seed ${seed} window ${win.x},${win.y}: ${bad} pixels differ from the whole composite`);
      }
    }
  }
  // All nine at once, which is also the only configuration in which the draw
  // order and the margins interact.
  for (let seed = 11; seed <= 13; seed++) {
    const doc = buildDoc(variants(seed), { seed });
    const whole = compositeDoc(doc, null, {});
    for (const win of windows) {
      const part = compositeDoc(doc, win, {});
      let bad = 0;
      for (let y = 0; y < win.h; y++) {
        for (let x = 0; x < win.w; x++) {
          for (let c = 0; c < 4; c++) {
            if (part[(y * win.w + x) * 4 + c] !== whole[((win.y + y) * W + win.x + x) * 4 + c]) bad++;
          }
        }
      }
      eq(bad, 0, `all nine, seed ${seed}, window ${win.x},${win.y}: ${bad} differ`);
    }
  }
  note(`region consistency: worst difference ${worstDiff}`);
}

// -------------------------------------- the margin is sufficient, not assumed

{
  // Independently of the compositor: render each effect on a rect, and on the
  // same rect grown by its margin plus a lot more, and compare the middles.
  // If the margin were too small the extra context would change the answer.
  const EXTRA = 12;
  for (let seed = 21; seed <= 24; seed++) {
    for (const fx of variants(seed)) {
      const layer = { effects: [fx], opacity: 1, fillOpacity: 1 };
      const m = layerMargin(fx.type === 'gradientOverlay' ? layer : layer);
      const r = rect(14, 10, 24, 20);
      const read = (grow) => {
        const rg = rect(r.x - grow, r.y - grow, r.w + 2 * grow, r.h + 2 * grow);
        const doc = buildDoc([], { seed });
        const surf = doc.layers[1].surface;
        const src = surf.readRect(rg);
        const out = renderEffects(layer, src, rg, doc.bounds);
        const flat = [...out.below, ...out.above];
        return flat.map((e) => {
          const crop = new Float32Array(r.w * r.h * 4);
          for (let y = 0; y < r.h; y++) {
            const s = ((y + grow) * rg.w + grow) * 4;
            crop.set(e.buf.subarray(s, s + r.w * 4), y * r.w * 4);
          }
          return crop;
        });
      };
      const a = read(m), b = read(m + EXTRA);
      eq(a.length, b.length, `${fx.type}: same number of buffers at both margins`);
      for (let i = 0; i < a.length; i++) {
        const { w } = worst(a[i], b[i]);
        eq(w, 0, `${fx.type} seed ${seed}: margin ${m} differs from ${m + EXTRA} by ${w}`);
      }
    }
  }
  note(`margins: ${EFFECT_TYPES.map((t) => `${t.replace(/[a-z]/g, '')}${effectMargin(effectDefaults(t))}`).join(' ')}`);
}

// --------------------------------------------------- translation equivariance

{
  // Shift the layer's pixels and the whole composite shifts with it. This is
  // what catches a sign error in the offset, an asymmetric blur, or a distance
  // field that leans one way -- all of which look plausible in isolation.
  // The gradient overlay is excluded BY DESIGN: it is anchored to the layer's
  // content bounds, which do move with it, but its ordered dither is keyed on
  // the absolute pixel coordinate, so the last bit does not move. That is the
  // right trade -- a dither that moved with the content would band.
  // The window excludes a border of the effect's own margin: a translated
  // layer is NOT a translated render near the canvas edge, because the edge
  // itself does not move. An inner shadow offsets the inverted alpha and
  // leaves a zero band at the leading edge of the CANVAS, which is anchored
  // there rather than to the content -- that band cost 4.25e-2 before the
  // border was taken out, and it is correct behaviour, not a bug.
  const DX = 3, DY = 3;
  // The honest version: the rendered effect buffers themselves.
  for (const type of EFFECT_TYPES) {
    if (type === 'gradientOverlay') continue;
    const fx = effectDefaults(type);
    const layer = { effects: [fx], opacity: 1, fillOpacity: 1 };
    const grab = (dx, dy) => {
      const doc = buildDoc([], { shape: 'disc', seed: 5, dx, dy });
      const r = doc.bounds;
      const out = renderEffects(layer, doc.layers[1].surface.readRect(r), r, r);
      return [...out.below, ...out.above].map((e) => e.buf);
    };
    const a = grab(0, 0), b = grab(DX, DY);
    const g = layerMargin(layer) + 2;
    for (let i = 0; i < a.length; i++) {
      let mx = 0;
      for (let y = g; y < H - g - DY; y++) {
        for (let x = g; x < W - g - DX; x++) {
          for (let c = 0; c < 4; c++) {
            mx = Math.max(mx, Math.abs(a[i][(y * W + x) * 4 + c] - b[i][((y + DY) * W + x + DX) * 4 + c]));
          }
        }
      }
      ok(mx < 2e-6, `${type}: translation-equivariant (worst ${mx.toExponential(2)})`);
    }
  }
}

// -------------------------------------------- fill opacity is the whole point

{
  // At Fill 0 the layer's own pixels contribute nothing, so the output cannot
  // depend on their COLOUR -- only on their alpha, which the effects are built
  // from. Change the colour, get the same image.
  for (const type of EFFECT_TYPES) {
    const fx = effectDefaults(type);
    const mk = (color) => {
      const doc = buildDoc([fx], { seed: 3, color });
      doc.layers[1].fillOpacity = 0;
      return compositeDoc(doc, null, {});
    };
    const a = mk([0.1, 0.2, 0.3]), b = mk([0.9, 0.8, 0.1]);
    const { w } = worst(a, b);
    eq(w, 0, `${type}: at Fill 0 the output must not depend on the layer's colour (differs by ${w})`);
    // ...and it must still have DRAWN something, or the check above is vacuous.
    const plain = (() => {
      const doc = buildDoc([], { seed: 3 });
      doc.layers[1].fillOpacity = 0;
      return compositeDoc(doc, null, {});
    })();
    ok(worst(a, plain).w > 1e-3, `${type}: at Fill 0 the effect is still visible`);
  }
  // Fill does not touch the effects: the effect-only part of the image is the
  // same at Fill 0 and Fill 1 wherever the layer's own alpha is zero.
  for (const type of ['dropShadow', 'outerGlow', 'stroke']) {
    const fx = { ...effectDefaults(type), position: 'outside' };
    const mk = (f) => {
      const doc = buildDoc([fx], { seed: 4 });
      doc.layers[1].fillOpacity = f;
      return compositeDoc(doc, null, {});
    };
    const a = mk(0), b = mk(1);
    const alpha = buildDoc([], { seed: 4 }).layers[1].surface.readRect(rect(0, 0, W, H));
    let mx = 0;
    for (let i = 0; i < W * H; i++) {
      if (alpha[i * 4 + 3] > 0) continue;
      for (let c = 0; c < 4; c++) mx = Math.max(mx, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    }
    eq(mx, 0, `${type}: outside the shape, Fill makes no difference (${mx})`);
  }
}

// ------------------------------------------------------- zero and disabled

{
  const plain = compositeDoc(buildDoc([], { seed: 9 }), null, {});
  for (const type of EFFECT_TYPES) {
    const off = { ...effectDefaults(type), enabled: false };
    eq(worst(compositeDoc(buildDoc([off], { seed: 9 }), null, {}), plain).w, 0,
      `${type}: enabled:false is an absent effect`);
    eq(layerMargin({ effects: [off] }), 0, `${type}: a disabled effect needs no margin`);
    if ('opacity' in effectDefaults(type)) {
      const zero = { ...effectDefaults(type), opacity: 0 };
      eq(worst(compositeDoc(buildDoc([zero], { seed: 9 }), null, {}), plain).w, 0,
        `${type}: opacity 0 is an absent effect`);
    }
    ok(hasEffects({ effects: [effectDefaults(type)] }), `${type}: hasEffects sees it`);
    ok(!hasEffects({ effects: [off] }), `${type}: hasEffects ignores a disabled one`);
  }
  // An effect list on an invisible layer draws nothing at all. The baseline is
  // the SAME stack with the effects removed -- comparing against `plain`, whose
  // layer is still visible, compares the layer as well and is 0.5 away before
  // any effect is involved.
  const run = (effects, mutate) => {
    const d = buildDoc(effects, { seed: 9 });
    mutate(d.layers[1]);
    return compositeDoc(d, null, {});
  };
  eq(worst(run(ALL, (l) => { l.visible = false; }), run([], (l) => { l.visible = false; })).w, 0,
    'a hidden layer draws no effects');
  // Layer opacity 0 likewise -- effects scale by opacity, not by fill.
  eq(worst(run(ALL, (l) => { l.opacity = 0; }), run([], (l) => { l.opacity = 0; })).w, 0,
    'layer opacity 0 draws no effects');
  // ...and Fill 0 is NOT the same thing: the effects must survive it.
  ok(worst(run(ALL, (l) => { l.fillOpacity = 0; }), run([], (l) => { l.fillOpacity = 0; })).w > 1e-3,
    'Fill 0 keeps the effects');
}

// --------------------------------------------------------------- containment

{
  const doc = buildDoc([], { seed: 2 });
  const r = doc.bounds;
  const src = doc.layers[1].surface.readRect(r);
  const INNER = ['innerShadow', 'innerGlow', 'colorOverlay', 'gradientOverlay', 'satin'];
  const OUTER = ['dropShadow', 'outerGlow'];
  for (const type of [...INNER, ...OUTER, 'stroke', 'bevel']) {
    for (let seed = 31; seed <= 33; seed++) {
      const fx = variants(seed)[EFFECT_TYPES.indexOf(type)];
      const out = renderEffects({ effects: [fx], opacity: 1, fillOpacity: 1 }, src, r, r);
      const flat = [...out.below, ...out.above];
      for (const e of flat) {
        let outside = 0, insideSolid = 0;
        for (let i = 0; i < W * H; i++) {
          const a = src[i * 4 + 3];
          const v = e.buf[i * 4 + 3];
          if (a === 0 && v > 1e-7) outside++;
          if (a === 1 && v > 1e-7) insideSolid++;
        }
        if (INNER.includes(type)) eq(outside, 0, `${type} seed ${seed}: drew ${outside} pixels outside the shape`);
        if (OUTER.includes(type)) eq(insideSolid, 0, `${type} seed ${seed}: drew ${insideSolid} pixels inside solid alpha`);
        // Nothing may ever be out of range or non-finite.
        let bad = 0;
        for (let i = 0; i < e.buf.length; i++) {
          const v = e.buf[i];
          if (!Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9) bad++;
        }
        eq(bad, 0, `${type} seed ${seed}: ${bad} values outside 0..1`);
      }
    }
  }
  // An inside stroke is contained; an outside stroke touches nothing solid.
  for (const [pos, key] of [['inside', 'outside'], ['outside', 'insideSolid']]) {
    const out = renderEffects({ effects: [{ ...effectDefaults('stroke'), position: pos, size: 3 }], opacity: 1, fillOpacity: 1 }, src, r, r);
    const e = [...out.below, ...out.above][0];
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const a = src[i * 4 + 3], v = e.buf[i * 4 + 3];
      if (key === 'outside' ? (a === 0 && v > 1e-7) : (a === 1 && v > 1e-7)) n++;
    }
    // An inside stroke of 3px cannot reach the centre of a 9px disc, and an
    // outside one cannot reach solid interior.
    eq(n, 0, `stroke ${pos}: ${n} pixels on the wrong side`);
    eq(out.below.length + out.above.length, 1, `stroke ${pos}: one buffer`);
    eq(pos === 'inside' ? out.above.length : out.below.length, 1, `stroke ${pos}: on the ${pos === 'inside' ? 'above' : 'below'} side`);
  }
}

// ------------------------------------------- the stroke's area is closed-form

{
  // A stroke of width s around a disc of radius R has area pi((R+s)^2 - R^2)
  // for an outside stroke, pi(R^2 - (R-s)^2) inside, and the ring centred on
  // the edge for centre. No reference library needed, and it catches both a
  // half-pixel shift and the classic "dilate then subtract" square corner.
  const R = 12;
  const doc = buildDoc([], { shape: 'disc', seed: 5 });
  const src = doc.layers[1].surface.readRect(doc.bounds);
  for (const size of [1, 2, 3, 5, 8]) {
    for (const position of ['outside', 'inside', 'centre']) {
      const out = renderEffects(
        { effects: [{ ...effectDefaults('stroke'), size, position }], opacity: 1, fillOpacity: 1 },
        src, doc.bounds, doc.bounds);
      const buf = [...out.below, ...out.above][0].buf;
      let ink = 0;
      for (let i = 0; i < W * H; i++) ink += buf[i * 4 + 3];
      let lo, hi;
      if (position === 'outside') { lo = R; hi = R + size; }
      else if (position === 'inside') { lo = R - size; hi = R; }
      else { lo = R - size / 2; hi = R + size / 2; }
      const want = Math.PI * (hi * hi - lo * lo);
      // The disc itself is a binary mask on a pixel grid, so its radius is
      // only accurate to about half a pixel; the allowance is the perimeter
      // times that, which is the honest bound and NOT a fudge factor.
      const tol = 2 * Math.PI * hi * 0.75 + 4;
      eq(ink, want, `stroke ${position} ${size}px on r=${R}: ink ${ink.toFixed(1)} vs pi ring ${want.toFixed(1)}`, tol);
    }
  }
  // The ring area alone does not pin the ANTIALIASING: dropping the half-pixel
  // ramp for a hard in/out test shifts the area by about the perimeter times a
  // half, which is inside the honest tolerance above. So state the property
  // directly -- a stroke has partial coverage along both of its edges -- rather
  // than hoping a total catches it.
  for (const position of ['outside', 'inside', 'centre']) {
    const out = renderEffects(
      { effects: [{ ...effectDefaults('stroke'), size: 4, position }], opacity: 1, fillOpacity: 1 },
      src, doc.bounds, doc.bounds);
    const buf = [...out.below, ...out.above][0].buf;
    let touched = 0, partial = 0;
    for (let i = 0; i < W * H; i++) {
      const v = buf[i * 4 + 3];
      if (v > 1e-6) touched++;
      if (v > 1e-6 && v < 1 - 1e-6) partial++;
    }
    ok(touched > 100, `stroke ${position}: touched ${touched} pixels`);
    // Fewer than the two full edges you might expect: the distance field of a
    // binary disc takes the square roots of integers, so only the pixels
    // landing within half a pixel of either threshold are partial -- measured
    // at 68/388 outside, 28/264 inside, 95/497 centre. A hard in/out test
    // gives exactly zero, so the bar is an absolute count rather than a
    // fraction, set well below the measurement and well above nothing.
    ok(partial > 20, `stroke ${position} is antialiased (${partial}/${touched} partial)`);
  }
  note('stroke area checked against the closed-form ring, and its edges are antialiased');
}

// ------------------------------------------------- the shadow's blur is scipy

if (havePython()) {
  // The shadow is an offset, spread, blurred copy of the alpha. With spread 0
  // and distance 0 it is exactly a gaussian of sigma = size/3 with a clamped
  // border, multiplied by (1 - alpha). scipy is the independent reference for
  // the blur; the rest is arithmetic this asserts directly.
  const doc = buildDoc([], { seed: 2 });
  const r = doc.bounds;
  const src = doc.layers[1].surface.readRect(r);
  const alpha = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = src[i * 4 + 3];

  for (const size of [3, 6, 12]) {
    const sigma = size / 3;
    const out = renderEffects(
      { effects: [{ ...effectDefaults('dropShadow'), size, distance: 0, spread: 0, color: [0, 0, 0] }], opacity: 1, fillOpacity: 1 },
      src, r, r);
    const got = out.below[0].buf;
    // scipy's radius comes from `truncate`; ours is ceil(3*sigma), so state it
    // rather than letting the default decide -- the same pinning convolve.mjs
    // does. An unpinned truncate is a silently different kernel.
    const want = runPython(`
from scipy.ndimage import gaussian_filter
rad = int(np.ceil(3.0 * ${sigma}))
OUT = gaussian_filter(IN, sigma=${sigma}, mode='nearest', truncate=rad / ${sigma})
`, alpha, [H, W]);
    let mx = 0;
    for (let i = 0; i < W * H; i++) {
      const expect = want[i] * (1 - alpha[i]);
      mx = Math.max(mx, Math.abs(got[i * 4 + 3] - expect));
    }
    ok(mx < 2e-6, `dropShadow size ${size}: alpha vs scipy gaussian x (1-alpha), worst ${mx.toExponential(2)}`);
  }
  note('shadow blur pinned to scipy.ndimage.gaussian_filter');
} else {
  note('scipy absent, blur reference skipped');
}

// ------------------------------------------------- spread hardens BEFORE the blur

{
  // Spread is applied to the coverage before it is blurred, which is why 100%
  // spread gives a hard-edged shadow at any size rather than a bigger blurry
  // one. The consequence, and the thing to assert: on an already-hard shape
  // the spread is the IDENTITY, because there is nothing left to harden. Move
  // it after the blur and a spread of 1 instead saturates the whole blur
  // kernel into a hard disc the size of the shape plus the blur radius -- a
  // shadow that GROWS with the Size slider instead of softening.
  const d2 = buildDoc([], { shape: 'disc', seed: 5 });        // a binary mask
  const s2 = d2.layers[1].surface.readRect(d2.bounds);
  const run = (spread) => renderEffects(
    { effects: [{ ...effectDefaults('dropShadow'), distance: 0, size: 9, spread }], opacity: 1, fillOpacity: 1 },
    s2, d2.bounds, d2.bounds).below[0].buf;
  const none = run(0), full = run(1);
  eq(worst(none, full).w, 0, 'on a hard-edged shape, spread changes nothing');
  // ...and the check is not vacuous: the shadow it did produce is soft.
  let soft = 0;
  for (let i = 0; i < W * H; i++) {
    const v = none[i * 4 + 3];
    if (v > 1e-6 && v < 1 - 1e-6) soft++;
  }
  ok(soft > 200, `and that shadow is soft (${soft} partial pixels)`);
  // The inner shadow and the inner glow run the identical remap on the
  // inverted alpha, under the name Choke.
  for (const type of ['innerShadow', 'innerGlow']) {
    const go = (v) => renderEffects(
      { effects: [{ ...effectDefaults(type), distance: 0, size: 9, source: 'edge', choke: v }], opacity: 1, fillOpacity: 1 },
      s2, d2.bounds, d2.bounds).above[0].buf;
    eq(worst(go(0), go(1)).w, 0, `${type}: on a hard-edged shape, choke changes nothing`);
  }
}

// ------------------------------------------- the effect lands where it should

{
  // Region consistency cannot see a UNIFORM mistake: shift every cropped
  // effect buffer by one row and the whole composite shifts with it, so the
  // sub-rects still agree with the whole. The missing statement is an absolute
  // one -- so put a hard-edged shadow at a known offset under a known square
  // and demand the darkened pixels are exactly the square translated by it,
  // minus the square itself.
  const SQ = { x: 20, y: 14, w: 18, h: 16 };
  const OFF = 10;                                  // angle 180: light from the
  const doc = new Doc({ w: W, h: H });              // left, so the shadow is
  doc.layers = [];                                  // cast to the right
  const bg = new Surface(W, H, 4, 16);
  bg.fill([1, 1, 1, 1]);
  doc.layers.push(new Layer({ name: 'white', surface: bg }));
  const sq = new Surface(W, H, 4, 16);
  const qb = new Float32Array(SQ.w * SQ.h * 4);
  for (let i = 0; i < SQ.w * SQ.h; i++) { qb[i * 4 + 3] = 1; }      // opaque black
  sq.writeRect(rect(SQ.x, SQ.y, SQ.w, SQ.h), qb);
  doc.layers.push(new Layer({
    name: 'square', surface: sq,
    effects: [{ type: 'dropShadow', enabled: true, color: [1, 0, 0], opacity: 1, angle: 180, distance: OFF, spread: 1, size: 0, blend: 'normal' }],
  }));
  const out = compositeDoc(doc, null, {});
  const inSq = (x, y) => x >= SQ.x && x < SQ.x + SQ.w && y >= SQ.y && y < SQ.y + SQ.h;
  const inShadow = (x, y) => inSq(x - OFF, y);
  let wrong = 0, red = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // Pure red only where the shadow shows and the square does not.
      const isRed = out[p] > 0.99 && out[p + 1] < 0.01 && out[p + 2] < 0.01;
      const want = inShadow(x, y) && !inSq(x, y);
      if (isRed) red++;
      if (isRed !== want) wrong++;
    }
  }
  eq(wrong, 0, `the shadow is exactly the square offset by ${OFF} (${wrong} pixels wrong)`);
  eq(red, OFF * SQ.h, `and covers exactly ${OFF * SQ.h} pixels (got ${red})`);

  // The same square with an inside stroke, which is read through the crop on
  // the other side of the layer's pixels.
  doc.layers[1].effects = [{ type: 'stroke', enabled: true, color: [0, 1, 0], opacity: 1, size: 2, position: 'inside', blend: 'normal' }];
  const st = compositeDoc(doc, null, {});
  let green = 0, leaked = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const isGreen = st[p + 1] > 0.9 && st[p] < 0.1;
      if (!isGreen) continue;
      green++;
      if (!inSq(x, y)) leaked++;
    }
  }
  eq(leaked, 0, `an inside stroke stays inside the square (${leaked} leaked)`);
  // A 2px inside border of an 18x16 rectangle: 18*16 - 14*12 = 120 pixels.
  eq(green, SQ.w * SQ.h - (SQ.w - 4) * (SQ.h - 4), `and is a 2px border (${green} pixels)`);
}

// ---------------------------------------------------------- angle convention

{
  // 90 degrees is UP, as the dial shows it, which means a NEGATIVE y offset --
  // screen y grows downward. Getting this backwards is the single most common
  // bug in a shadow, and it looks fine until you compare with anything else.
  const doc0 = buildDoc([], { shape: 'disc', seed: 5 });
  const src = doc0.layers[1].surface.readRect(doc0.bounds);
  const centroid = (angle) => {
    const out = renderEffects(
      { effects: [{ ...effectDefaults('dropShadow'), angle, distance: 10, size: 0, spread: 1 }], opacity: 1, fillOpacity: 1 },
      src, doc0.bounds, doc0.bounds);
    const buf = out.below[0].buf;
    let sx = 0, sy = 0, m = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = buf[(y * W + x) * 4 + 3];
      sx += x * a; sy += y * a; m += a;
    }
    return [sx / m, sy / m, m];
  };
  const [, cy90] = centroid(90);
  const [, cy270] = centroid(-90);
  const [cx0] = centroid(0);
  const [cx180] = centroid(180);
  // The angle is where the LIGHT is, so the shadow falls the other way: a
  // light overhead puts the shadow below. Asserting the shadow follows the
  // dial instead is self-consistent and passes, which is exactly how the sign
  // survived until the inner shadow was checked against the same light.
  ok(cy90 > cy270 + 8, `angle 90 (light above) puts the shadow down: y ${cy90.toFixed(1)} vs ${cy270.toFixed(1)}`);
  ok(cx0 < cx180 - 8, `angle 0 (light to the right) puts the shadow left: x ${cx0.toFixed(1)} vs ${cx180.toFixed(1)}`);
  // ...and the same for an inner shadow, which comes from the opposite side
  // and is therefore easy to get consistent-but-inverted.
  const inner = (angle) => {
    const out = renderEffects(
      { effects: [{ ...effectDefaults('innerShadow'), angle, distance: 8, size: 1, choke: 1 }], opacity: 1, fillOpacity: 1 },
      src, doc0.bounds, doc0.bounds);
    const buf = out.above[0].buf;
    let sy = 0, m = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = buf[(y * W + x) * 4 + 3];
      sy += y * a; m += a;
    }
    return sy / m;
  };
  // Light from above darkens the TOP inside edge -- the same light, the same
  // direction, so the two shadows agree about the dial.
  ok(inner(90) < inner(-90) - 2, `inner shadow at 90 sits high: ${inner(90).toFixed(1)} vs ${inner(-90).toFixed(1)}`);
}

// -------------------------------------------------------------- bevel lighting

{
  // Flip the light 180 degrees and highlight and shadow swap. The lighting term
  // is (n . l - lz), which is odd in the horizontal part of l, so this is an
  // exact statement about the formula and not an impression of the look.
  const doc = buildDoc([], { shape: 'disc', seed: 5 });
  const src = doc.layers[1].surface.readRect(doc.bounds);
  const run = (angle) => {
    const out = renderEffects(
      { effects: [{ ...effectDefaults('bevel'), angle, soften: 0, highlight: [1, 1, 1], shadow: [0, 0, 0], highlightOpacity: 1, shadowOpacity: 1 }], opacity: 1, fillOpacity: 1 },
      src, doc.bounds, doc.bounds);
    return out.above[0].buf;
  };
  const a = run(135), b = run(-45);
  let mx = 0, lit = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    // white in a <-> black in b, same alpha
    const whiteA = a[p] > 0.5, whiteB = b[p] > 0.5;
    if (a[p + 3] > 1e-3) {
      lit++;
      if (whiteA === whiteB) mx++;
    }
  }
  ok(lit > 200, `bevel lit ${lit} pixels`);
  // The lighting term is now exactly odd in the light's horizontal direction,
  // so only the terminator itself -- where k is 0 and the sign is arbitrary --
  // may fail to flip.
  ok(mx < lit * 0.02, `bevel: flipping the light swaps highlight and shadow (${mx}/${lit} did not)`);
  // Altitude 90 is straight down the surface normal: nothing is lit or shaded,
  // because every slope departs from the flat term equally in both directions.
  const flat = renderEffects(
    { effects: [{ ...effectDefaults('bevel'), altitude: 90, soften: 0 }], opacity: 1, fillOpacity: 1 },
    src, doc.bounds, doc.bounds).above[0].buf;
  let maxA = 0;
  for (let i = 0; i < W * H; i++) maxA = Math.max(maxA, flat[i * 4 + 3]);
  ok(maxA < 1e-6, `bevel at altitude 90 is unlit (max alpha ${maxA.toExponential(2)})`);
}

// -------------------------------------------------------------- draw order

{
  // The order is fixed by the effect type, not by the order of the list, so
  // reordering the panel cannot change the image.
  const vs = variants(41);
  const forward = compositeDoc(buildDoc(vs, { seed: 41 }), null, {});
  const reversed = compositeDoc(buildDoc([...vs].reverse(), { seed: 41 }), null, {});
  eq(worst(forward, reversed).w, 0, 'the draw order does not depend on the list order');

  // And it IS an order: a stroke sits over a colour overlay.
  const doc = buildDoc([], { shape: 'disc', seed: 5 });
  const src = doc.layers[1].surface.readRect(doc.bounds);
  const out = renderEffects({
    effects: [effectDefaults('stroke'), effectDefaults('colorOverlay'), effectDefaults('bevel')],
    opacity: 1, fillOpacity: 1,
  }, src, doc.bounds, doc.bounds);
  const order = [...out.below, ...out.above].map((e) => e.type);
  eq(order.indexOf('colorOverlay') < order.indexOf('bevel'), true, 'overlay before bevel');
  eq(out.below.map((e) => e.type).join(','), 'stroke', 'an outside stroke draws below the pixels');
}

// ---------------------------------------------------- the mask shapes the effect

{
  // Masking a layer must change its shadow, because the shadow comes from the
  // masked silhouette. If the mask were applied to the finished shadow instead
  // the mask's own shape would be punched out of the shadow -- so the test is
  // that the shadow APPEARS where the mask reveals nothing of the layer.
  const fx = { ...effectDefaults('dropShadow'), distance: 0, size: 6, spread: 0 };
  const doc = buildDoc([fx], { seed: 7 });
  const mask = new Surface(W, H, 1, 16);
  const mb = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mb[y * W + x] = x < W / 2 ? 1 : 0;
  mask.writeRect(rect(0, 0, W, H), mb);
  doc.layers[1].mask = mask;
  doc.layers[1].maskEnabled = true;
  const masked = compositeDoc(doc, null, {});
  doc.layers[1].maskEnabled = false;
  const unmasked = compositeDoc(doc, null, {});
  ok(worst(masked, unmasked).w > 1e-3, 'a layer mask changes the shadow');

  // The decisive part: in the masked-away half, the shadow of the REMAINING
  // half may bleed a few pixels across the mask edge, but far from it there
  // must be no shadow at all.
  const plainDoc = buildDoc([], { seed: 7 });
  plainDoc.layers[1].mask = mask;
  plainDoc.layers[1].maskEnabled = true;
  const plain = compositeDoc(plainDoc, null, {});
  let far = 0;
  for (let y = 0; y < H; y++) {
    for (let x = Math.ceil(W / 2) + 10; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) if (Math.abs(masked[i + c] - plain[i + c]) > 1e-6) far++;
    }
  }
  eq(far, 0, `${far} pixels of shadow survive well inside the masked-away half`);
}

// ------------------------------- the effects sit on the right side of the pixels

{
  // Hand-computed, because the question is purely about ORDER and a reference
  // would answer it with the same code. A 50%-opaque layer is the only way to
  // see the order at all: a solid one hides whatever is under it, and a drop
  // shadow is zeroed where alpha is 1, so with an opaque layer both orders
  // give the same image and the test proves nothing.
  const doc = new Doc({ w: 4, h: 4 });
  doc.layers = [];
  const bg = new Surface(4, 4, 4, 16);
  bg.fill([1, 1, 1, 1]);
  doc.layers.push(new Layer({ name: 'white', surface: bg }));
  const s2 = new Surface(4, 4, 4, 16);
  s2.fill([1, 0, 0, 0.5]);                    // red at half alpha

  // distance 0, size 0, spread 1: the shadow is a hard copy of the alpha,
  // held outside the layer by the (1 - alpha) term -- so coverage 0.5.
  const shadow = {
    type: 'dropShadow', enabled: true, color: [0, 0, 0], opacity: 1,
    angle: 0, distance: 0, spread: 1, size: 0, blend: 'normal',
  };
  doc.layers.push(new Layer({ name: 'fx', surface: s2, effects: [shadow] }));
  const got = compositeDoc(doc, rect(1, 1, 1, 1), {});
  // white -> black at 0.5 -> 0.5 grey -> red at 0.5
  const grey = 0.5;
  const wantR = 1 * 0.5 + grey * 0.5, wantG = 0 * 0.5 + grey * 0.5;
  eq(got[0], wantR, 'a drop shadow is UNDER the layer: red channel', 2e-5);
  eq(got[1], wantG, 'a drop shadow is UNDER the layer: green channel', 2e-5);

  // The same stack with a colour overlay, which goes the other way.
  doc.layers[1].effects = [{
    type: 'colorOverlay', enabled: true, color: [0, 0, 1], opacity: 1, blend: 'normal',
  }];
  const over = compositeDoc(doc, rect(1, 1, 1, 1), {});
  // white -> red at 0.5 = (1, .5, .5) -> blue at 0.5 = (.5, .25, .75)
  eq(over[0], 0.5, 'a colour overlay is OVER the layer: red channel', 2e-5);
  eq(over[1], 0.25, 'a colour overlay is OVER the layer: green channel', 2e-5);
  eq(over[2], 0.75, 'a colour overlay is OVER the layer: blue channel', 2e-5);
}

// ------------------------------------------------- undo survives an in-place edit

{
  // An effect holds arrays -- a colour, and the overlay's gradient stops. A
  // snapshot that copied the effect objects but SHARED those arrays would be
  // rewritten by the slider it was taken to protect, and undo would restore
  // the value it had just been handed. Mutating in place is exactly what a
  // careless caller does, so the snapshot has to be deep enough to survive it.
  const doc = buildDoc([effectDefaults('dropShadow'), effectDefaults('gradientOverlay')], { seed: 1 });
  const h = new History();
  h.begin('effects', doc);
  const l = doc.layers[1];
  l.effects[0].color[0] = 1;
  l.effects[0].color[1] = 1;
  l.effects[1].stops[0].color[2] = 1;
  l.effects[1].stops[0].pos = 0.4;
  l.effects[0].opacity = 0.11;
  h.commit();
  h.undo(doc);
  const back = doc.layers[1].effects;
  eq(back[0].color[0], 0, 'undo restores a shadow colour mutated in place');
  eq(back[0].opacity, effectDefaults('dropShadow').opacity, 'undo restores the shadow opacity');
  eq(back[1].stops[0].color[2], 0, 'undo restores a gradient stop colour mutated in place');
  eq(back[1].stops[0].pos, 0, 'undo restores a gradient stop position');
  // ...and redo puts the edit back, which is the half that a too-deep copy
  // would also break.
  h.redo(doc);
  const fwd = doc.layers[1].effects;
  eq(fwd[0].color[0], 1, 'redo reapplies the shadow colour');
  eq(fwd[1].stops[0].pos, 0.4, 'redo reapplies the gradient stop position');
}

done(`layer effects: ${EFFECT_TYPES.length} effects, region consistency bit-exact`);
