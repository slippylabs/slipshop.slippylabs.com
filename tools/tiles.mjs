// Oracle: the tiled surface against a dense one.
//
// Tiling is where this engine's bugs will live. Every read and write has to
// stitch across 256-pixel boundaries, clip to a document whose size is not a
// multiple of the tile, and treat an unallocated tile as transparent -- and a
// mistake in any of those shows up as a faint seam every 256 pixels, which is
// exactly the kind of defect that survives a screenshot review.
//
// So the reference here is a DENSE surface: the same contract implemented the
// obvious way, one flat array, no tiles, no sparsity. It shares no code with
// the thing it checks. If the two ever disagree the tiled path is wrong,
// because the dense one has nowhere to hide a seam.

import { Surface, TILE } from '../js/core/tiles.js';
import { rect, rectIntersect, rectEmpty, toByte, toU16, mulberry32 } from '../js/core/util.js';
import { ok, eq, note, done } from './_harness.mjs';

// ------------------------------------------------------------ the reference

/** A deliberately naive surface: one array, every pixel always present. */
class Dense {
  constructor(w, h, channels = 4, depth = 8) {
    this.w = w; this.h = h; this.channels = channels; this.depth = depth;
    this.max = depth === 8 ? 255 : 65535;
    this.q = depth === 8 ? toByte : toU16;
    this.data = new (depth === 8 ? Uint8Array : Uint16Array)(w * h * channels);
  }

  readRect(r) {
    const C = this.channels;
    const out = new Float32Array(r.w * r.h * C);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const sx = r.x + x, sy = r.y + y;
        const d = (y * r.w + x) * C;
        if (sx < 0 || sy < 0 || sx >= this.w || sy >= this.h) continue;  // zero
        const s = (sy * this.w + sx) * C;
        for (let c = 0; c < C; c++) out[d + c] = this.data[s + c] / this.max;
      }
    }
    return out;
  }

  readRectBorder(r, mode) {
    const C = this.channels;
    const out = new Float32Array(r.w * r.h * C);
    const map = mode === 'reflect'
      ? (i, n) => { if (n === 1) return 0; const p = 2 * n - 2; const k = ((i % p) + p) % p; return k < n ? k : p - k; }
      : (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const sx = mode === 'zero' ? r.x + x : map(r.x + x, this.w);
        const sy = mode === 'zero' ? r.y + y : map(r.y + y, this.h);
        const d = (y * r.w + x) * C;
        if (sx < 0 || sy < 0 || sx >= this.w || sy >= this.h) continue;
        const s = (sy * this.w + sx) * C;
        for (let c = 0; c < C; c++) out[d + c] = this.data[s + c] / this.max;
      }
    }
    return out;
  }

  writeRect(r, src) {
    const C = this.channels;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const dx = r.x + x, dy = r.y + y;
        if (dx < 0 || dy < 0 || dx >= this.w || dy >= this.h) continue;
        const s = (y * r.w + x) * C;
        const d = (dy * this.w + dx) * C;
        for (let c = 0; c < C; c++) this.data[d + c] = this.q(src[s + c]);
      }
    }
  }

  clearRect(r) {
    const C = this.channels;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const dx = r.x + x, dy = r.y + y;
      if (dx < 0 || dy < 0 || dx >= this.w || dy >= this.h) continue;
      const d = (dy * this.w + dx) * C;
      for (let c = 0; c < C; c++) this.data[d + c] = 0;
    }
  }

  contentBounds() {
    const C = this.channels;
    const aOff = C === 4 ? 3 : 0;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.data[(y * this.w + x) * C + aOff] !== 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? rect(0, 0, 0, 0) : rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }
}

const same = (a, b) => {
  if (a.length !== b.length) return -1;
  let w = 0;
  for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i]));
  return w;
};

// --------------------------------------------------------- basic invariants

{
  const s = new Surface(600, 400);
  eq(s.tileCount, 0, 'a new surface allocates nothing -- sparse means transparent');
  eq(s.tx, 3, 'tile grid width for 600px');
  eq(s.ty, 2, 'tile grid height for 400px');
  eq(s.byteLength, 0, 'and costs no bytes');
  s.setPixel(599, 399, [1, 1, 1, 1]);
  eq(s.tileCount, 1, 'one pixel in the last tile allocates exactly one tile');
  ok(s.tileSpan(rect(700, 700, 10, 10)) === null, 'a rect entirely outside the document spans no tiles');
  ok(rectEmpty(s.clearRect(rect(-50, -50, 10, 10))), 'clearing entirely outside is a no-op');
  ok(rectEmpty(s.writeRect(rect(-50, -50, 10, 10), new Float32Array(400))), 'writing entirely outside is a no-op');
}

// Reading a never-written surface must be all zeros, at every alignment.
{
  const s = new Surface(300, 300);
  for (const r of [rect(0, 0, 300, 300), rect(-10, -10, 40, 40), rect(250, 250, 100, 100), rect(TILE - 2, TILE - 2, 5, 5)]) {
    const d = s.readRect(r);
    ok(d.every((v) => v === 0), `readRect of an empty surface is zero at ${JSON.stringify(r)}`);
  }
}

// ----------------------------------------- tiled vs dense: random sequences
// Sizes chosen so the document is NOT a multiple of the tile in either axis
// (515 x 270 leaves 3px and 14px ragged edges), because an exact multiple
// hides every clipping mistake.

const CASES = [
  { w: 515, h: 270, channels: 4, depth: 8 },
  { w: 515, h: 270, channels: 4, depth: 16 },
  { w: 300, h: 300, channels: 1, depth: 8 },
  { w: TILE, h: TILE, channels: 4, depth: 8 },          // exactly one tile
  { w: TILE * 2, h: TILE, channels: 4, depth: 8 },       // exact multiple
  { w: 1, h: 1, channels: 4, depth: 8 },                 // degenerate
  { w: 7, h: 3, channels: 1, depth: 16 },                // smaller than a tile
];

let totalOps = 0;
for (const cfg of CASES) {
  const tag = `${cfg.w}x${cfg.h} c${cfg.channels} d${cfg.depth}`;
  const S = new Surface(cfg.w, cfg.h, cfg.channels, cfg.depth);
  const D = new Dense(cfg.w, cfg.h, cfg.channels, cfg.depth);
  const rnd = mulberry32(0xC0FFEE ^ cfg.w ^ (cfg.depth << 8) ^ cfg.channels);
  const C = cfg.channels;

  let worstRead = 0, worstBorder = 0, boundsBad = 0;
  for (let step = 0; step < 220; step++) {
    // A rect that can start outside, end outside, and straddle tile seams.
    const x = Math.floor(rnd() * (cfg.w + 2 * TILE)) - TILE;
    const y = Math.floor(rnd() * (cfg.h + 2 * TILE)) - TILE;
    const w = 1 + Math.floor(rnd() * (TILE * 1.5));
    const h = 1 + Math.floor(rnd() * (TILE * 1.5));
    const r = rect(x, y, w, h);

    const kind = rnd();
    if (kind < 0.55) {
      const buf = new Float32Array(w * h * C);
      for (let i = 0; i < buf.length; i++) buf[i] = rnd();
      S.writeRect(r, buf);
      D.writeRect(r, buf);
      totalOps++;
    } else if (kind < 0.7) {
      S.clearRect(r);
      D.clearRect(r);
      totalOps++;
    } else {
      // read and compare at a rect unrelated to anything written
      const a = S.readRect(r), b = D.readRect(r);
      worstRead = Math.max(worstRead, same(a, b));
      for (const mode of ['zero', 'clamp', 'reflect']) {
        const p = S.readRectBorder(r, mode), q = D.readRectBorder(r, mode);
        worstBorder = Math.max(worstBorder, same(p, q));
      }
      totalOps++;
    }

    if (step % 25 === 0) {
      const bs = S.contentBounds(), bd = D.contentBounds();
      if (JSON.stringify(bs) !== JSON.stringify(bd)) boundsBad++;
    }
  }

  // A full-document read is the decisive comparison: every tile, every seam,
  // every ragged edge, in one array.
  const full = rect(0, 0, cfg.w, cfg.h);
  const wFull = same(S.readRect(full), D.readRect(full));
  ok(wFull === 0, `${tag}: the whole document matches the dense surface exactly (worst ${wFull})`);
  ok(worstRead === 0, `${tag}: every sampled readRect matched (worst ${worstRead})`);
  ok(worstBorder === 0, `${tag}: every border mode matched (worst ${worstBorder})`);
  eq(boundsBad, 0, `${tag}: contentBounds matched the dense scan every time`);

  // Reading a rect in one go must equal reading it in pieces -- this is the
  // property every tiled filter depends on and the one a seam breaks.
  const pieces = [];
  const stride = 37;                      // coprime with 256, so it lands mid-tile
  let piecewiseBad = 0;
  for (let yy = 0; yy < cfg.h; yy += stride) {
    for (let xx = 0; xx < cfg.w; xx += stride) {
      const rr = rectIntersect(rect(xx, yy, stride, stride), full);
      if (rectEmpty(rr)) continue;
      const a = S.readRect(rr), b = D.readRect(rr);
      if (same(a, b) !== 0) piecewiseBad++;
    }
  }
  eq(piecewiseBad, 0, `${tag}: reading in ${stride}px pieces agrees with the dense surface everywhere`);

  // Sparsity: no tile may be allocated that is entirely zero after a trim,
  // and a trim must not change what the surface reads as.
  const before = S.readRect(full);
  const dropped = S.trim();
  const after = S.readRect(full);
  eq(same(before, after), 0, `${tag}: trim() drops ${dropped} empty tiles without changing any pixel`);
  let emptyLeft = 0;
  for (const [, t] of S.tiles) if (t.every((v) => v === 0)) emptyLeft++;
  eq(emptyLeft, 0, `${tag}: no all-zero tile survives a trim`);

  const clean = S.outsideIsClean();
  ok(clean.ok, `${tag}: after ${220} random ops the out-of-document corner is still zero${clean.ok ? '' : ` (dirty at ${clean.at})`}`);

  // clone must be independent.
  const c = S.clone();
  ok(c.equals(S), `${tag}: a clone equals its original`);
  c.writeRect(rect(0, 0, 1, 1), new Float32Array(C).fill(1));
  const stillSame = same(S.readRect(full), before);
  eq(stillSame, 0, `${tag}: writing to the clone does not touch the original`);

  // equals() must treat an absent tile and an all-zero tile as identical,
  // because they are -- an undo check that cares would fail on a no-op.
  const e1 = new Surface(cfg.w, cfg.h, C, cfg.depth);
  const e2 = new Surface(cfg.w, cfg.h, C, cfg.depth);
  e2.ensure(0, 0);
  ok(e1.equals(e2) && e2.equals(e1), `${tag}: absent and all-zero tiles compare equal`);
}

// ------------------------------------------------- the out-of-document corner
// An edge tile of a 515-wide document holds 256 columns but the document only
// reaches column 514, so 253 columns of the last tile are not part of the
// image. Nothing reads them -- which means anything that writes them is
// invisible until it reaches equals() or a codec. fill() did exactly that.
for (const cfg of [{ w: 515, h: 270 }, { w: 300, h: 300 }, { w: 7, h: 3 }]) {
  const S = new Surface(cfg.w, cfg.h, 4, 8);
  S.fill([1, 0.5, 0.25, 1]);
  const clean = S.outsideIsClean();
  ok(clean.ok, `${cfg.w}x${cfg.h}: fill() leaves the out-of-document corner zero${clean.ok ? '' : ` (dirty at ${clean.at})`}`);
  S.writeRect(rect(cfg.w - 2, cfg.h - 2, TILE, TILE), new Float32Array(TILE * TILE * 4).fill(1));
  const clean2 = S.outsideIsClean();
  ok(clean2.ok, `${cfg.w}x${cfg.h}: writeRect past the edge leaves it zero${clean2.ok ? '' : ` (dirty at ${clean2.at})`}`);
  // Two surfaces that render identically must compare EQUAL even if one of
  // them has a dirty corner. Poison only the pixels outside the document --
  // filling the whole tile would change real pixels too and the comparison
  // would be legitimately false, which is how the first version of this test
  // passed while asserting nothing.
  const T = S.clone();
  let poisoned = 0;
  for (const [k, t] of T.tiles) {
    const [ox, oy] = T.tileOrigin(k);
    const xEnd = Math.max(0, Math.min(TILE, T.w - ox));
    const yEnd = Math.max(0, Math.min(TILE, T.h - oy));
    for (let y = 0; y < yEnd; y++) {
      for (let x = xEnd; x < TILE; x++) {
        const d = (y * TILE + x) * 4;
        for (let c = 0; c < 4; c++) t[d + c] = 200;
        poisoned++;
      }
    }
    for (let y = yEnd; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = (y * TILE + x) * 4;
        for (let c = 0; c < 4; c++) t[d + c] = 200;
        poisoned++;
      }
    }
  }
  const hasDead = poisoned > 0;
  ok(!hasDead || S.equals(T), `${cfg.w}x${cfg.h}: equals() ignores ${poisoned} poisoned out-of-document pixels`);
  ok(S.equals(T) === T.equals(S), `${cfg.w}x${cfg.h}: equals() is symmetric`);
}

// readRect must not leak a poisoned out-of-document pixel into its output.
{
  const S = new Surface(515, 270, 4, 8);
  S.fill([0.1, 0.2, 0.3, 1]);
  for (const [, t] of S.tiles) t.fill(255);          // poison every tile wholesale
  const d = S.readRect(rect(500, 260, 60, 30));      // straddles the edge
  let leaked = 0;
  for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) {
    const inDoc = 500 + x < 515 && 260 + y < 270;
    const v = d[(y * 60 + x) * 4];
    if (!inDoc && v !== 0) leaked++;
  }
  eq(leaked, 0, 'readRect returns zero outside the document even when the tile holds data there');
}

// ------------------------------------------------- allocation is exactly tight
// Visiting one tile too many costs an allocation, and an all-zero tile that
// trim() would later remove hides it -- so count before trimming.
for (const [w, h] of [[515, 270], [256, 256], [600, 400]]) {
  const S = new Surface(w, h, 4, 8);
  const r = rect(10, 10, 20, 20);                     // wholly inside tile (0,0)
  S.writeRect(r, new Float32Array(20 * 20 * 4).fill(1));
  eq(S.tileCount, 1, `${w}x${h}: a write inside one tile allocates exactly one`);
  const S2 = new Surface(w, h, 4, 8);
  const r2 = rect(TILE - 1, TILE - 1, 2, 2);          // the 2x2 crossing the seam
  S2.writeRect(r2, new Float32Array(2 * 2 * 4).fill(1));
  const expect = (TILE < w ? 2 : 1) * (TILE < h ? 2 : 1);
  eq(S2.tileCount, expect, `${w}x${h}: a 2x2 on the tile seam allocates exactly ${expect}`);
  const S3 = new Surface(w, h, 4, 8);
  S3.writeRect(rect(-TILE * 2, -TILE * 2, TILE, TILE), new Float32Array(TILE * TILE * 4).fill(1));
  eq(S3.tileCount, 0, `${w}x${h}: a write entirely outside allocates nothing`);
  // A rect whose far edge lands EXACTLY on a tile boundary is the case that
  // separates floor((x+w-1)/TILE) from floor((x+w)/TILE). Any other rect
  // gives the same answer for both, which is why an off-by-one in the span
  // can hide from a random sweep.
  const S4 = new Surface(w, h, 4, 8);
  S4.writeRect(rect(0, 0, TILE, TILE), new Float32Array(TILE * TILE * 4).fill(1));
  eq(S4.tileCount, 1, `${w}x${h}: a write of exactly one tile allocates exactly one, not four`);
}

// ---------------------------------------------- contentBounds reads ALPHA
// Random data makes every channel non-zero together, so a bounds scan that
// reads channel 0 instead of alpha looks correct. These two pixels separate
// them: one is transparent but coloured (an erased pixel that kept its RGB),
// the other is opaque black.
{
  const S = new Surface(300, 300, 4, 8);
  S.setPixel(10, 10, [1, 1, 1, 0]);        // transparent, bright -- NOT content
  S.setPixel(200, 150, [0, 0, 0, 1]);      // opaque black -- IS content
  const b = S.contentBounds();
  eq(JSON.stringify(b), JSON.stringify(rect(200, 150, 1, 1)),
    'contentBounds counts opaque black and ignores transparent white (it reads alpha)');
  const M = new Surface(300, 300, 1, 8);
  M.setPixel(5, 7, [0.5]);
  eq(JSON.stringify(M.contentBounds()), JSON.stringify(rect(5, 7, 1, 1)),
    'for a 1-channel mask the value itself is the coverage');
}

// ------------------------------------------------------- quantisation story
// Storage is integer, so a write-read round trip must land on the nearest
// representable value and must be STABLE: reading and rewriting the same data
// cannot drift, or a filter applied twice would differ from applying it to
// its own output.
for (const depth of [8, 16]) {
  const S = new Surface(64, 64, 4, depth);
  const r = rect(0, 0, 64, 64);
  const buf = new Float32Array(64 * 64 * 4);
  const rnd = mulberry32(5);
  for (let i = 0; i < buf.length; i++) buf[i] = rnd();
  S.writeRect(r, buf);
  const a = S.readRect(r);
  S.writeRect(r, a);
  const b = S.readRect(r);
  eq(same(a, b), 0, `depth ${depth}: a read-write round trip is idempotent (no drift on repeat)`);
  const maxV = depth === 8 ? 255 : 65535;
  let qErr = 0;
  for (let i = 0; i < buf.length; i++) qErr = Math.max(qErr, Math.abs(a[i] - buf[i]));
  ok(qErr <= 0.5 / maxV + 1e-7, `depth ${depth}: quantisation error is at most half a step (${qErr.toExponential(2)})`);
}

// Fill with transparent must free every tile rather than store zeros.
{
  const S = new Surface(515, 270);
  S.fill([1, 0, 0, 1]);
  eq(S.tileCount, S.tx * S.ty, 'an opaque fill allocates every tile');
  S.fill([0, 0, 0, 0]);
  eq(S.tileCount, 0, 'filling with transparent frees them all again');
}

note(`${totalOps} random operations across ${CASES.length} surface shapes, including ragged edges and 1x1`);
note('the dense reference shares no code with the tiled surface');
done('tiled storage is indistinguishable from a dense one');
