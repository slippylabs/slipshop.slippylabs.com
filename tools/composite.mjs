// Oracle: the whole layer stack against the browser's canvas.
//
// blend.mjs checks one pixel over one pixel. This checks the STACK: groups
// (isolated and pass-through), layer masks, opacity, clipping masks and blend
// modes, all interacting, against a browser that does the same job with its
// own primitives rather than with our arithmetic:
//
//   opacity        -> ctx.globalAlpha
//   layer mask     -> draw, then 'destination-in' with the mask as alpha
//   clipping mask  -> 'destination-in' with the base layer's coverage
//   isolated group -> an offscreen canvas, composited then drawn
//   pass-through   -> children drawn straight onto the backdrop
//
// What IS shared between the two sides, deliberately: the decision of which
// groups are isolated. That is a documented semantic choice (Photoshop's), not
// an implementation detail, so the oracle states it rather than testing it --
// and tests the arithmetic that follows from it.
//
// Runs on a float16 canvas for the same reason blend.mjs does: the unorm8
// pipeline quantises at every drawImage, and a four-layer stack goes through
// four of them, so the error compounds into something no tolerance can
// separate from a bug.

import { Doc, Layer, resetIds } from '../js/core/doc.js';
import { composite as sharedComposite } from '../js/core/blend.js';
import { compositeDoc } from '../js/core/composite.js';
import { Surface } from '../js/core/tiles.js';
import { W3C_MODES, cssName } from '../js/core/blend.js';
import { rect, mulberry32 } from '../js/core/util.js';
import { ok, eq, note, done, f16round } from './_harness.mjs';
import { runInBrowser } from './_browser.mjs';

const W = 48, H = 32;
const N = W * H;
const F16_REL = 4e-3;        // looser than blend.mjs: several draws compound
const F16_ABS = 1.5e-3;

/** Build a matched pair: a Doc for us, a plain description for the page. */
function buildStack(seed) {
  const rnd = mulberry32(seed);
  resetIds(1);
  const doc = new Doc({ w: W, h: H });
  const desc = [];

  const pixels = () => {
    const a = new Float32Array(N * 4);
    const style = rnd();
    for (let i = 0; i < N; i++) {
      const p = i * 4;
      if (style < 0.3) {
        // hard-edged blocks: exercises coverage transitions
        const on = ((i % W) >> 3 ^ ((i / W) | 0) >> 3) & 1;
        a[p] = on ? 0.9 : 0.1; a[p + 1] = on ? 0.2 : 0.7; a[p + 2] = on ? 0.4 : 0.8;
        a[p + 3] = on ? 1 : 0.35;
      } else if (style < 0.6) {
        // a gradient with a transparent corner
        const x = (i % W) / W, y = ((i / W) | 0) / H;
        a[p] = x; a[p + 1] = y; a[p + 2] = 1 - x * y; a[p + 3] = Math.min(1, x + y);
      } else {
        for (let c = 0; c < 4; c++) a[p + c] = rnd();
      }
      // float16 on both sides, so neither is blending different numbers
      for (let c = 0; c < 4; c++) a[p + c] = f16round(a[p + c]);
    }
    return a;
  };

  const maskData = () => {
    const m = new Float32Array(N);
    const kind = rnd();
    for (let i = 0; i < N; i++) {
      const x = (i % W) / W, y = ((i / W) | 0) / H;
      m[i] = f16round(kind < 0.5 ? x : (x + y) / 2);
    }
    return m;
  };

  const surfaceFrom = (data) => {
    const s = new Surface(W, H, 4, 16);     // 16-bit, so storage is not the bottleneck
    s.writeRect(rect(0, 0, W, H), data);
    return s;
  };
  const maskFrom = (data) => {
    const s = new Surface(W, H, 1, 16);
    s.writeRect(rect(0, 0, W, H), data);
    return s;
  };

  const makeLayer = (depth) => {
    const asGroup = depth < 2 && rnd() < 0.35;
    const blend = W3C_MODES[Math.floor(rnd() * W3C_MODES.length)];
    const opacity = f16round([1, 1, 0.75, 0.4, 0.15][Math.floor(rnd() * 5)]);
    const hasMask = rnd() < 0.4;
    const clipping = depth === 0 && rnd() < 0.3;

    if (asGroup) {
      const passThrough = rnd() < 0.5;
      const kids = [];
      const kidDesc = [];
      const kn = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < kn; i++) {
        const { layer, d } = makeLayer(depth + 1);
        kids.push(layer); kidDesc.push(d);
      }
      const gVisible = rnd() > 0.1;
      const g = new Layer({
        type: 'group', blend: passThrough ? 'pass-through' : blend,
        opacity: passThrough ? 1 : opacity, children: kids, clipping,
        visible: gVisible,
      });
      if (hasMask && !passThrough) { g.mask = maskFrom(maskData()); }
      return {
        layer: g,
        d: {
          type: 'group', isolated: g.isolated, blend: cssName(g.effectiveBlend),
          opacity: g.opacity, clipping, visible: gVisible, children: kidDesc,
          mask: g.mask ? Array.from(g.mask.readRect(rect(0, 0, W, H))) : null,
        },
      };
    }

    const data = pixels();
    // visible and fillOpacity are varied here because two mutation controls --
    // "an invisible layer is composited anyway" and "fillOpacity is ignored" --
    // did not fire without them. Every stack kept both at their defaults, so
    // the compositor could have ignored either and no check would have moved.
    const visible = rnd() > 0.12;
    // fillOpacity is chosen so that opacity * fillOpacity stays at or above
    // 0.1. Below that the comparison stops being about us: a canvas stores
    // PREMULTIPLIED colour, so at a combined alpha of 0.0375 a float16 store
    // loses about 2.6% of the colour on the way in and back out, and the
    // reference's own precision dominates the result. The engine's behaviour
    // at low alpha is covered properly by blend.mjs, which tests down to
    // 0.0625 with a conditioning-aware allowance.
    const fillChoices = [1, 1, 1, 0.6, 0.25].filter((f) => opacity * f >= 0.1);
    const fillOpacity = f16round(fillChoices[Math.floor(rnd() * fillChoices.length)] ?? 1);
    const l = new Layer({ type: 'raster', blend, opacity, clipping, visible, fillOpacity, surface: surfaceFrom(data) });
    let mk = null;
    if (hasMask) { mk = maskData(); l.mask = maskFrom(mk); }
    return {
      layer: l,
      d: {
        type: 'raster', blend: cssName(blend), clipping, visible,
        // The canvas has one knob where we have two: globalAlpha. Fill opacity
        // scales the layer's own pixels and opacity scales the whole layer,
        // and with no layer effects in play their product is the coverage --
        // which is exactly what the compositor computes.
        opacity: opacity * fillOpacity,
        // read back THROUGH the surface, so both sides see the same quantised
        // values -- comparing against the pre-quantisation floats would be
        // measuring the 16-bit storage, not the compositor
        data: Array.from(l.surface.readRect(rect(0, 0, W, H))),
        mask: mk ? Array.from(l.mask.readRect(rect(0, 0, W, H))) : null,
      },
    };
  };

  const count = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < count; i++) {
    const { layer, d } = makeLayer(0);
    // the bottom layer cannot be a clipping layer -- there is nothing to clip to
    if (i === 0) { layer.clipping = false; d.clipping = false; }
    doc.layers.push(layer);
    desc.push(d);
  }
  return { doc, desc };
}

const PAGE = `
const W = ${W}, H = ${H};
function mk() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { colorType: 'float16', willReadFrequently: true });
  if (g.getContextAttributes().colorType !== 'float16') throw new Error('no float16 canvas');
  return { c, g };
}
function fromRGBA(arr) {
  const t = mk();
  t.g.putImageData(new ImageData(new Float16Array(arr), W, H, { pixelFormat: 'rgba-float16' }), 0, 0);
  return t;
}
function fromMask(arr) {
  // alpha carries the coverage; the colour is irrelevant under destination-in
  const d = new Float16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) d[i * 4 + 3] = arr[i];
  const t = mk();
  t.g.putImageData(new ImageData(d, W, H, { pixelFormat: 'rgba-float16' }), 0, 0);
  return t;
}
function keepWhere(layer, alphaSrc) {
  const t = mk();
  t.g.drawImage(layer.c, 0, 0);
  t.g.globalCompositeOperation = 'destination-in';
  t.g.drawImage(alphaSrc.c, 0, 0);
  t.g.globalCompositeOperation = 'source-over';
  return t;
}
function drawList(dst, list) {
  let clipBase = null;
  for (const L of list) {
    if (L.visible === false) {
      // A hidden base ends its clipping group EMPTY -- an empty canvas, so
      // destination-in removes everything clipped to it.
      if (!L.clipping) clipBase = mk();
      continue;
    }
    if (L.type === 'group' && !L.isolated) { drawList(dst, L.children); if (!L.clipping) clipBase = null; continue; }
    let lc;
    if (L.type === 'group') { lc = mk(); drawList(lc.g, L.children); }
    else lc = fromRGBA(L.data);
    if (L.mask) lc = keepWhere(lc, fromMask(L.mask));
    if (L.clipping && clipBase) lc = keepWhere(lc, clipBase);
    dst.globalCompositeOperation = L.blend;
    if (dst.globalCompositeOperation !== L.blend) throw new Error('mode not supported: ' + L.blend);
    dst.globalAlpha = L.opacity;
    dst.drawImage(lc.c, 0, 0);
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'source-over';
    if (!L.clipping) {
      clipBase = mk();
      clipBase.g.globalAlpha = L.opacity;
      clipBase.g.drawImage(lc.c, 0, 0);
      clipBase.g.globalAlpha = 1;
    }
  }
}
const STACKS = __STACKS__;
const out = new Float32Array(STACKS.length * W * H * 4);
STACKS.forEach((s, k) => {
  const base = mk();
  drawList(base.g, s);
  const r = base.g.getImageData(0, 0, W, H, { pixelFormat: 'rgba-float16' }).data;
  for (let i = 0; i < r.length; i++) out[k * W * H * 4 + i] = r[i];
});
const b = new Uint8Array(out.buffer);
let str = ''; const CH = 0x8000;
for (let i = 0; i < b.length; i += CH) str += String.fromCharCode.apply(null, b.subarray(i, i + CH));
window.__out = btoa(str);
`;

const STACKS = 14;
const built = [];
for (let s = 0; s < STACKS; s++) built.push(buildStack(0xA11CE + s * 7919));

note(`${STACKS} random stacks of ${W}x${H}, ${built.reduce((a, b) => a + b.doc.layerCount, 0)} layers total`);
const page = PAGE.replace('__STACKS__', JSON.stringify(built.map((b) => b.desc)));
const buf = Buffer.from(runInBrowser(page), 'base64');
const got = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
eq(got.length, STACKS * N * 4, 'the browser returned one composited buffer per stack');

let worstAll = 0, whereAll = '';
for (let s = 0; s < STACKS; s++) {
  const mine = compositeDoc(built[s].doc, built[s].doc.bounds);
  let bad = 0, w = 0, where = '';
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    const o = s * N * 4 + p;
    // Where the result is transparent the colour is not defined: a canvas
    // stores premultiplied, so it reports zero whatever we computed.
    const transparent = got[o + 3] < 0.01 && mine[p + 3] < 0.01;
    const upto = transparent ? 3 : 4;
    for (let c = (transparent ? 3 : 0); c < upto + (transparent ? 1 : 0); c++) {
      const tol = F16_ABS + F16_REL * Math.abs(mine[p + c]);
      const d = Math.abs(got[o + c] - mine[p + c]);
      if (d / tol > w) { w = d / tol; where = `stack ${s} px ${i % W},${(i / W) | 0} ch${c} got ${got[o + c]} want ${mine[p + c]}`; }
      if (d > tol) bad++;
    }
  }
  if (w > worstAll) { worstAll = w; whereAll = where; }
  if (bad !== 0 && process.env.DEBUG_STACK) {
    const flat = [];
    const walk = (list, d) => list.forEach((l) => { flat.push(`${' '.repeat(d)}${l.type} blend=${l.blend} op=${l.opacity.toFixed(2)} fill=${l.fillOpacity.toFixed(2)} vis=${l.visible} clip=${l.clipping} mask=${!!l.mask}`); if (l.children) walk(l.children, d + 2); });
    walk(built[s].doc.layers, 0);
    console.log(`  --- stack ${s} ---`);
    for (const line of flat) console.log('   ', line);
    console.log('    worst:', where);
  }
  ok(bad === 0, `stack ${s} (${built[s].doc.layerCount} layers): ${bad} of ${N * 4} channels differ from the browser`);
}
note(`worst = ${worstAll.toFixed(3)} x tolerance ${worstAll > 0.9 ? `(${whereAll})` : ''}`);

// --------------------------------------- the inlined formula vs the shared one
// blendOnto() in composite.js re-implements blend.js's composite() inline,
// because allocating three arrays per pixel dominates the hot loop. Two copies
// of the same formula is a real hazard: a fix to one is easy to miss in the
// other. This pins them together, so the duplication cannot drift silently.
{
  const rnd = mulberry32(31337);
  let bad = 0, w = 0;
  for (const mode of W3C_MODES) {
    const doc = new Doc({ w: 16, h: 1 });
    const base = new Layer({ type: 'raster', surface: new Surface(16, 1, 4, 16) });
    const top = new Layer({ type: 'raster', blend: mode, surface: new Surface(16, 1, 4, 16) });
    const bd = new Float32Array(16 * 4), sd = new Float32Array(16 * 4);
    for (let i = 0; i < 16 * 4; i++) { bd[i] = rnd(); sd[i] = rnd(); }
    base.surface.writeRect(rect(0, 0, 16, 1), bd);
    top.surface.writeRect(rect(0, 0, 16, 1), sd);
    doc.layers.push(base, top);
    const got = compositeDoc(doc, doc.bounds);
    // the shared, generic implementation, from the same quantised inputs
    const bq = base.surface.readRect(rect(0, 0, 16, 1));
    const sq = top.surface.readRect(rect(0, 0, 16, 1));
    for (let i = 0; i < 16; i++) {
      const p = i * 4;
      const want = sharedComposite(mode, [bq[p], bq[p + 1], bq[p + 2]], bq[p + 3],
                                         [sq[p], sq[p + 1], sq[p + 2]], sq[p + 3]);
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(got[p + c] - want[c]);
        if (d > w) w = d;
        if (d > 1e-6) bad++;
      }
    }
  }
  ok(bad === 0, `the inlined hot-loop formula equals blend.js composite() for all ${W3C_MODES.length} modes (worst ${w.toExponential(2)})`);
}

// ------------------------------------------------- compositing a region
// The viewport repaints rectangles, so compositing a box must equal the same
// box cut out of a full composite. A layer mask or a clip base read with the
// wrong origin breaks this and nothing else.
for (let s = 0; s < 4; s++) {
  const doc = built[s].doc;
  const whole = compositeDoc(doc, doc.bounds);
  let bad = 0;
  for (const r of [rect(0, 0, 7, 5), rect(13, 9, 11, 7), rect(W - 3, H - 3, 3, 3), rect(5, 0, 1, H)]) {
    const part = compositeDoc(doc, r);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      for (let c = 0; c < 4; c++) {
        const a = part[(y * r.w + x) * 4 + c];
        const b = whole[((r.y + y) * W + (r.x + x)) * 4 + c];
        if (Math.abs(a - b) > 1e-6) bad++;
      }
    }
  }
  eq(bad, 0, `stack ${s}: compositing a sub-rect matches the same region of the whole`);
}

// ------------------------------------------- awkward clipping arrangements
// Hand-built, because a random generator will not reliably produce a hidden
// layer that is also the base of a clipping group -- and that arrangement is
// exactly where the clip base can be left pointing at the wrong layer.
{
  const mk = (fn) => {
    const sfc = new Surface(8, 8, 4, 16);
    const buf = new Float32Array(8 * 8 * 4);
    fn(buf);
    sfc.writeRect(rect(0, 0, 8, 8), buf);
    return sfc;
  };
  const solid = (c) => mk((b) => { for (let i = 0; i < 64; i++) { b[i * 4] = c[0]; b[i * 4 + 1] = c[1]; b[i * 4 + 2] = c[2]; b[i * 4 + 3] = 1; } });
  const leftHalf = (c) => mk((b) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
      const p = (y * 8 + x) * 4;
      b[p] = c[0]; b[p + 1] = c[1]; b[p + 2] = c[2]; b[p + 3] = 1;
    }
  });

  const build = (baseVisible) => {
    const d = new Doc({ w: 8, h: 8 });
    d.layers.push(
      new Layer({ type: 'raster', name: 'bottom', surface: solid([0, 0, 1]) }),       // blue, full
      new Layer({ type: 'raster', name: 'base', visible: baseVisible, surface: leftHalf([0, 1, 0]) }),  // green, left half
      new Layer({ type: 'raster', name: 'clipped', clipping: true, surface: solid([1, 0, 0]) }),        // red, clipped
    );
    return d;
  };

  const shown = compositeDoc(build(true), rect(0, 0, 8, 8));
  // left half: red clipped to the green base; right half: the blue bottom.
  ok(shown[(0 * 8 + 1) * 4] > 0.9 && shown[(0 * 8 + 1) * 4 + 1] < 0.1,
    'with a visible base, the clipped layer shows inside it');
  ok(shown[(0 * 8 + 6) * 4 + 2] > 0.9,
    'and not outside it -- the bottom layer shows through');

  const hidden = compositeDoc(build(false), rect(0, 0, 8, 8));
  let leaked = 0;
  for (let i = 0; i < 64; i++) if (hidden[i * 4] > 0.1) leaked++;
  eq(leaked, 0, 'HIDING the base hides everything clipped to it -- the red never appears');
  ok(hidden[0] < 0.1 && hidden[2] > 0.9, 'and the layer below shows everywhere instead');

  // A PASS-THROUGH GROUP ends any clipping group: a layer above it is not
  // clipped to whatever sat below the group. The random stacks do produce
  // pass-through groups and clipping layers, but almost never in that order
  // with a visible difference, so the control for this did not fire.
  const viaGroup = (passThrough) => {
    const d = new Doc({ w: 8, h: 8 });
    const g = new Layer({
      type: 'group', name: 'g',
      blend: passThrough ? 'pass-through' : 'multiply',
      children: [new Layer({ type: 'raster', name: 'inner', surface: solid([1, 1, 0]) })],
    });
    d.layers.push(
      new Layer({ type: 'raster', name: 'bottom', surface: solid([0, 0, 1]) }),
      new Layer({ type: 'raster', name: 'base', surface: leftHalf([0, 1, 0]) }),
      g,
      new Layer({ type: 'raster', name: 'clipped', clipping: true, surface: solid([1, 0, 0]) }),
    );
    return compositeDoc(d, rect(0, 0, 8, 8));
  };
  const pt = viaGroup(true);
  // Check the GREEN channel, not red: the group paints YELLOW (1,1,0) and the
  // clipping layer is RED (1,0,0), so red is 1 either way and says nothing.
  // Green is 0 where the red layer won and 1 where the yellow shows through.
  const g6 = pt[(0 * 8 + 6) * 4 + 1];
  const g1 = pt[(0 * 8 + 1) * 4 + 1];
  ok(g1 < 0.1 && g6 < 0.1,
    `a pass-through group ends the clipping chain -- the layer above it covers everything, not just the base below (green at x=1 ${g1.toFixed(2)}, x=6 ${g6.toFixed(2)})`);

  // A clipping layer with nothing below it to clip to must not clip to
  // whatever happened to be composited before, which is nothing here.
  const orphan = new Doc({ w: 8, h: 8 });
  orphan.layers.push(new Layer({ type: 'raster', name: 'orphan', clipping: true, surface: solid([1, 0, 1]) }));
  const o = compositeDoc(orphan, rect(0, 0, 8, 8));
  ok(o[0] > 0.9 && o[2] > 0.9, 'a clipping layer with no base below it draws normally rather than vanishing');
}

done(`the layer stack matches the browser's own compositor (worst ${worstAll.toFixed(2)}x tolerance)`);
