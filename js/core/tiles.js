// Sparse tiled pixel storage. One Surface is one channel-set of one layer, or
// one mask, or one selection -- the same engine for all of them, which is why
// feathering a selection and blurring a layer share their border handling.
//
// Three decisions that the rest of the engine leans on:
//
// 1. A MISSING TILE IS TRANSPARENT. Nothing is allocated until something is
//    written, so a 6000x4000 document with one brush stroke on a new layer
//    costs two tiles, not 94 MB. Every read path has to treat absent as zero
//    rather than as "not yet loaded", or the compositor would have to know
//    about storage.
//
// 2. STORAGE IS INTEGER, WORK IS FLOAT. Tiles are Uint8 or Uint16; an
//    operation reads a rect out as Float32 0..1, works, and writes back. Eight
//    bits of storage is affordable (4 B/px) where float32 would be 16, and
//    float32 WORKING buffers are what stop a chain of adjustments banding --
//    the mistake dither-studio's own comment warns about, where rounding to
//    bytes between steps destroys the result.
//
// 3. TILES ARE ALWAYS FULL. An edge tile of a document whose size is not a
//    multiple of TILE still holds TILE*TILE pixels; the ones outside the
//    document are kept zero and never read, because readRect clips to the
//    document first. The alternative -- ragged edge tiles -- puts a special
//    case in every loop in the engine.

import { clamp, round, toByte, toU16, rect, rectEmpty, rectIntersect, rectUnion } from './util.js';

export const TILE = 256;
export const TILE_PX = TILE * TILE;

/** How many tiles across and down a surface of this size needs. */
export const tilesAcross = (w) => Math.ceil(w / TILE);
export const tilesDown = (h) => Math.ceil(h / TILE);

export class Surface {
  /**
   * @param w        document width in pixels
   * @param h        document height
   * @param channels 4 for RGBA, 1 for a mask or a single channel
   * @param depth    8 or 16 bits per channel
   */
  constructor(w, h, channels = 4, depth = 8) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0) {
      throw new Error(`Surface needs non-negative integer dimensions, got ${w}x${h}`);
    }
    if (channels !== 1 && channels !== 4) throw new Error(`channels must be 1 or 4, got ${channels}`);
    if (depth !== 8 && depth !== 16) throw new Error(`depth must be 8 or 16, got ${depth}`);
    this.w = w;
    this.h = h;
    this.channels = channels;
    this.depth = depth;
    this.tx = tilesAcross(w);
    this.ty = tilesDown(h);
    /** Map<tileIndex, Uint8Array|Uint16Array> -- absent means transparent. */
    this.tiles = new Map();
  }

  get Ctor() { return this.depth === 8 ? Uint8Array : Uint16Array; }
  get max() { return this.depth === 8 ? 255 : 65535; }
  get bounds() { return rect(0, 0, this.w, this.h); }

  tileIndex(tx, ty) { return ty * this.tx + tx; }
  tileOrigin(idx) { return [(idx % this.tx) * TILE, Math.floor(idx / this.tx) * TILE]; }

  /** The tile, or undefined. Callers must handle undefined as transparent. */
  tile(tx, ty) { return this.tiles.get(this.tileIndex(tx, ty)); }

  /** The tile, allocating a zeroed one if it is missing. */
  ensure(tx, ty) {
    const i = this.tileIndex(tx, ty);
    let t = this.tiles.get(i);
    if (!t) {
      t = new this.Ctor(TILE_PX * this.channels);
      this.tiles.set(i, t);
    }
    return t;
  }

  /** Allocated tile count -- the memory story, and what the undo oracle bounds. */
  get tileCount() { return this.tiles.size; }
  get byteLength() { return this.tiles.size * TILE_PX * this.channels * (this.depth / 8); }

  /** The tile coordinate range a pixel rect touches, already clipped. */
  tileSpan(r) {
    const c = rectIntersect(r, this.bounds);
    if (rectEmpty(c)) return null;
    return {
      x0: Math.floor(c.x / TILE),
      y0: Math.floor(c.y / TILE),
      x1: Math.floor((c.x + c.w - 1) / TILE),
      y1: Math.floor((c.y + c.h - 1) / TILE),
      clipped: c,
    };
  }

  /** Every allocated tile index touching r, in row-major order. */
  *tilesIn(r) {
    const s = this.tileSpan(r);
    if (!s) return;
    for (let ty = s.y0; ty <= s.y1; ty++) {
      for (let tx = s.x0; tx <= s.x1; tx++) {
        const t = this.tile(tx, ty);
        if (t) yield { tx, ty, tile: t, idx: this.tileIndex(tx, ty) };
      }
    }
  }

  /**
   * Read a rect as Float32 0..1, channel-interleaved, row-major, w*h*channels
   * long. Anything outside the document or in an unallocated tile reads as 0.
   *
   * The rect may extend outside the document: a kernel needs that, and giving
   * it zeros (rather than refusing, or clamping the rect) is what keeps the
   * caller's indexing simple. Use readRectBorder for clamp/reflect instead.
   */
  readRect(r, out) {
    const n = r.w * r.h * this.channels;
    const dst = out || new Float32Array(n);
    if (out) dst.fill(0, 0, n); else { /* a fresh Float32Array is already zero */ }
    const span = this.tileSpan(r);
    if (!span) return dst;
    const inv = 1 / this.max;
    const C = this.channels;
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const t = this.tile(tx, ty);
        if (!t) continue;
        const ox = tx * TILE, oy = ty * TILE;
        // the overlap of this tile, the requested rect and the document
        const ix0 = Math.max(r.x, ox, 0);
        const iy0 = Math.max(r.y, oy, 0);
        const ix1 = Math.min(r.x + r.w, ox + TILE, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        for (let y = iy0; y < iy1; y++) {
          let s = ((y - oy) * TILE + (ix0 - ox)) * C;
          let d = ((y - r.y) * r.w + (ix0 - r.x)) * C;
          for (let x = ix0; x < ix1; x++) {
            for (let c = 0; c < C; c++) dst[d + c] = t[s + c] * inv;
            s += C; d += C;
          }
        }
      }
    }
    return dst;
  }

  /**
   * Read a rect with an edge policy for the part outside the DOCUMENT.
   * 'zero' (the default of readRect), 'clamp' or 'reflect'.
   *
   * This is the function a filter must use. Reading zeros outside a photo
   * makes a blur darken its own border, which is the classic "my gaussian has
   * a vignette" bug, and it is invisible until you look at the edge.
   */
  readRectBorder(r, mode = 'clamp', out) {
    if (mode === 'zero') return this.readRect(r, out);
    const C = this.channels;
    const dst = out || new Float32Array(r.w * r.h * C);
    const inv = 1 / this.max;
    const W = this.w, H = this.h;
    if (W === 0 || H === 0) { dst.fill(0); return dst; }
    const map = mode === 'reflect'
      ? (i, n) => { const p = 2 * n - 2; if (n === 1) return 0; const k = ((i % p) + p) % p; return k < n ? k : p - k; }
      : (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);
    for (let y = 0; y < r.h; y++) {
      const sy = map(r.y + y, H);
      const tyy = (sy / TILE) | 0;
      const oy = tyy * TILE;
      let d = y * r.w * C;
      for (let x = 0; x < r.w; x++) {
        const sx = map(r.x + x, W);
        const txx = (sx / TILE) | 0;
        const t = this.tile(txx, tyy);
        if (t) {
          const s = ((sy - oy) * TILE + (sx - txx * TILE)) * C;
          for (let c = 0; c < C; c++) dst[d + c] = t[s + c] * inv;
        } else {
          for (let c = 0; c < C; c++) dst[d + c] = 0;
        }
        d += C;
      }
    }
    return dst;
  }

  /**
   * Write Float32 0..1 data back into a rect, allocating tiles as needed and
   * clipping to the document. Returns the rect actually written.
   */
  writeRect(r, src) {
    const c = rectIntersect(r, this.bounds);
    if (rectEmpty(c)) return c;
    const C = this.channels;
    const q = this.depth === 8 ? toByte : toU16;
    const span = this.tileSpan(r);
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const ox = tx * TILE, oy = ty * TILE;
        const ix0 = Math.max(r.x, ox, 0);
        const iy0 = Math.max(r.y, oy, 0);
        const ix1 = Math.min(r.x + r.w, ox + TILE, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const t = this.ensure(tx, ty);
        for (let y = iy0; y < iy1; y++) {
          let d = ((y - oy) * TILE + (ix0 - ox)) * C;
          let s = ((y - r.y) * r.w + (ix0 - r.x)) * C;
          for (let x = ix0; x < ix1; x++) {
            for (let k = 0; k < C; k++) t[d + k] = q(src[s + k]);
            s += C; d += C;
          }
        }
      }
    }
    return c;
  }

  /** Set a rect to zero, dropping any tile it empties completely. */
  clearRect(r) {
    const c = rectIntersect(r, this.bounds);
    if (rectEmpty(c)) return c;
    const C = this.channels;
    const span = this.tileSpan(r);
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const t = this.tile(tx, ty);
        if (!t) continue;
        const ox = tx * TILE, oy = ty * TILE;
        const ix0 = Math.max(r.x, ox, 0);
        const iy0 = Math.max(r.y, oy, 0);
        const ix1 = Math.min(r.x + r.w, ox + TILE, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        if (ix1 - ix0 === TILE && iy1 - iy0 === TILE) {
          this.tiles.delete(this.tileIndex(tx, ty));
          continue;
        }
        for (let y = iy0; y < iy1; y++) {
          const d = ((y - oy) * TILE + (ix0 - ox)) * C;
          t.fill(0, d, d + (ix1 - ix0) * C);
        }
      }
    }
    return c;
  }

  /** Drop every tile that is entirely zero. Call after an erase. */
  trim() {
    let dropped = 0;
    for (const [i, t] of [...this.tiles]) {
      let empty = true;
      for (let k = 0; k < t.length; k++) if (t[k] !== 0) { empty = false; break; }
      if (empty) { this.tiles.delete(i); dropped++; }
    }
    return dropped;
  }

  /**
   * The tight pixel bounds of everything non-transparent, or an empty rect.
   * Used by Trim, by layer-effect extents and by the "what do I need to
   * recomposite" question.
   */
  contentBounds() {
    let out = rect(0, 0, 0, 0);
    const C = this.channels;
    const aOff = C === 4 ? 3 : 0;      // alpha for RGBA, the value itself for a mask
    for (const { tx, ty, tile } of this.tilesIn(this.bounds)) {
      const ox = tx * TILE, oy = ty * TILE;
      let minX = TILE, minY = TILE, maxX = -1, maxY = -1;
      const yEnd = Math.min(TILE, this.h - oy);
      const xEnd = Math.min(TILE, this.w - ox);
      for (let y = 0; y < yEnd; y++) {
        const row = y * TILE * C;
        for (let x = 0; x < xEnd; x++) {
          if (tile[row + x * C + aOff] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) {
        out = rectUnion(out, rect(ox + minX, oy + minY, maxX - minX + 1, maxY - minY + 1));
      }
    }
    return out;
  }

  /** One pixel, as floats. Slow by design -- for an eyedropper, not a loop. */
  getPixel(x, y) {
    const C = this.channels;
    const out = new Array(C).fill(0);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return out;
    const t = this.tile((x / TILE) | 0, (y / TILE) | 0);
    if (!t) return out;
    const s = ((y % TILE) * TILE + (x % TILE)) * C;
    const inv = 1 / this.max;
    for (let c = 0; c < C; c++) out[c] = t[s + c] * inv;
    return out;
  }

  setPixel(x, y, v) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const C = this.channels;
    const q = this.depth === 8 ? toByte : toU16;
    const t = this.ensure((x / TILE) | 0, (y / TILE) | 0);
    const d = ((y % TILE) * TILE + (x % TILE)) * C;
    for (let c = 0; c < C; c++) t[d + c] = q(v[c]);
  }

  /** Fill the whole surface with one constant colour. */
  fill(v) {
    const C = this.channels;
    const q = this.depth === 8 ? toByte : toU16;
    const vals = [];
    for (let c = 0; c < C; c++) vals.push(q(v[c]));
    const allZero = vals.every((x) => x === 0);
    if (allZero) { this.tiles.clear(); return; }
    // Only INSIDE the document. Filling a whole edge tile would leave colour
    // in pixels the document does not contain, which breaks the invariant the
    // rest of this file relies on (and made two equal-looking surfaces compare
    // unequal). Caught by a mutation control that the first oracle missed.
    for (let ty = 0; ty < this.ty; ty++) for (let tx = 0; tx < this.tx; tx++) {
      const t = this.ensure(tx, ty);
      const xEnd = Math.min(TILE, this.w - tx * TILE);
      const yEnd = Math.min(TILE, this.h - ty * TILE);
      for (let y = 0; y < yEnd; y++) {
        for (let x = 0; x < xEnd; x++) {
          const d = (y * TILE + x) * C;
          for (let c = 0; c < C; c++) t[d + c] = vals[c];
        }
      }
    }
  }

  clone() {
    const s = new Surface(this.w, this.h, this.channels, this.depth);
    for (const [i, t] of this.tiles) s.tiles.set(i, t.slice());
    return s;
  }

  /**
   * Equality of the pixels the document actually contains.
   *
   * Two things it deliberately does NOT care about, because neither is
   * visible: whether a transparent region is an absent tile or an allocated
   * all-zero one, and whatever sits in the dead corner of an edge tile
   * outside the document. An undo check that cared about either would fail on
   * a no-op.
   */
  equals(other) {
    if (this.w !== other.w || this.h !== other.h) return false;
    if (this.channels !== other.channels || this.depth !== other.depth) return false;
    const C = this.channels;
    const keys = new Set([...this.tiles.keys(), ...other.tiles.keys()]);
    for (const k of keys) {
      const a = this.tiles.get(k), b = other.tiles.get(k);
      const [ox, oy] = this.tileOrigin(k);
      const xEnd = Math.min(TILE, this.w - ox);
      const yEnd = Math.min(TILE, this.h - oy);
      if (xEnd <= 0 || yEnd <= 0) continue;            // wholly outside
      for (let y = 0; y < yEnd; y++) {
        const row = y * TILE * C;
        for (let x = 0; x < xEnd * C; x++) {
          const av = a ? a[row + x] : 0;
          const bv = b ? b[row + x] : 0;
          if (av !== bv) return false;
        }
      }
    }
    return true;
  }

  /**
   * Every pixel held in an allocated tile but outside the document must be
   * zero. Nothing reads those pixels, so a violation is invisible until it
   * reaches equals() or a codec -- which is exactly why it is asserted rather
   * than assumed.
   */
  outsideIsClean() {
    const C = this.channels;
    for (const [k, t] of this.tiles) {
      const [ox, oy] = this.tileOrigin(k);
      const xEnd = Math.max(0, Math.min(TILE, this.w - ox));
      const yEnd = Math.max(0, Math.min(TILE, this.h - oy));
      // Only the two dead bands, not the whole tile: the columns right of the
      // document edge in every live row, then every row below it.
      for (let y = 0; y < yEnd; y++) {
        const row = y * TILE * C;
        for (let i = xEnd * C; i < TILE * C; i++) {
          if (t[row + i] !== 0) return { ok: false, at: [ox + ((i / C) | 0), oy + y] };
        }
      }
      for (let y = yEnd; y < TILE; y++) {
        const row = y * TILE * C;
        for (let i = 0; i < TILE * C; i++) {
          if (t[row + i] !== 0) return { ok: false, at: [ox + ((i / C) | 0), oy + y] };
        }
      }
    }
    return { ok: true };
  }
}

/** A dense RGBA Float32 image, for the compositor's output and for codecs. */
export function flatten(surface, r) {
  const box = r || surface.bounds;
  return { w: box.w, h: box.h, data: surface.readRect(box) };
}
