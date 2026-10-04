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
      const g = new Layer({
        type: 'group', blend: passThrough ? 'pass-through' : blend,
        opacity: passThrough ? 1 : opacity, children: kids, clipping,
      });
      if (hasMask && !passThrough) { g.mask = maskFrom(maskData()); }
      return {
        layer: g,
        d: {
          type: 'group', isolated: g.isolated, blend: cssName(g.effectiveBlend),
          opacity: g.opacity, clipping, children: kidDesc,
          mask: g.mask ? Array.from(g.mask.readRect(rect(0, 0, W, H))) : null,
        },
      };
    }

    const data = pixels();
    const l = new Layer({ type: 'raster', blend, opacity, clipping, surface: surfaceFrom(data) });
    let mk = null;
    if (hasMask) { mk = maskData(); l.mask = maskFrom(mk); }
    return {
      layer: l,
      d: {
        type: 'raster', blend: cssName(blend), opacity, clipping,
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

done(`the layer stack matches the browser's own compositor (worst ${worstAll.toFixed(2)}x tolerance)`);
