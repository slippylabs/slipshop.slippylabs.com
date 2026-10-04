// Opening and saving.
//
// Raster export goes through canvas.toBlob, which is a real, well-tested
// encoder for PNG, JPEG and WebP -- there is no reason to hand-roll those
// when the platform ships them. It does need one guard: toBlob is permitted
// by spec to return a DIFFERENT type than the one asked for, and Chromium
// does exactly that for AVIF (you ask for AVIF and get a PNG with an .avif
// name). image-format-lab hit this; every export here checks the type it got
// back and says so rather than writing a mislabelled file.
//
// The project format is our own, because nothing else holds a tiled, sparse,
// 16-bit layer stack: a small JSON header plus the raw tile blocks, in order.
// Only the tiles that exist are written, so a mostly-empty document is small.

import { Doc, Layer, newDoc } from '../core/doc.js';
import { Surface, TILE } from '../core/tiles.js';
import { compositeDoc, flattenOnto } from '../core/composite.js';
import { applyAdjust } from '../core/adjust.js';
import { rect } from '../core/util.js';
import { download, toast } from './ui.js';

const MAGIC = 'SLIPSHOP';
const VERSION = 1;

const LAYER_PROPS = [
  'id', 'type', 'name', 'visible', 'opacity', 'fillOpacity', 'blend', 'locked',
  'clipping', 'maskEnabled', 'offset',
];

// ------------------------------------------------------------------ export

/** Composite the document into an ImageData-backed canvas. */
export function docToCanvas(doc, { flatten = false, bg = [1, 1, 1] } = {}) {
  const r = doc.bounds;
  const px = flatten ? flattenOnto(doc, r, bg, { applyAdjust }) : compositeDoc(doc, r, { applyAdjust });
  const cv = document.createElement('canvas');
  cv.width = r.w;
  cv.height = r.h;
  const g = cv.getContext('2d');
  const img = g.createImageData(r.w, r.h);
  for (let i = 0, n = r.w * r.h; i < n; i++) {
    const p = i * 4;
    img.data[p] = px[p] * 255 + 0.5;
    img.data[p + 1] = px[p + 1] * 255 + 0.5;
    img.data[p + 2] = px[p + 2] * 255 + 0.5;
    img.data[p + 3] = px[p + 3] * 255 + 0.5;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

export const EXPORT_FORMATS = [
  { id: 'image/png', label: 'PNG', ext: 'png', alpha: true, quality: false },
  { id: 'image/jpeg', label: 'JPEG', ext: 'jpg', alpha: false, quality: true },
  { id: 'image/webp', label: 'WebP', ext: 'webp', alpha: true, quality: true },
];

/** Encode and download. Rejects if the browser silently swapped the format. */
export async function exportImage(doc, format, { quality = 0.92, name = 'untitled' } = {}) {
  const f = EXPORT_FORMATS.find((x) => x.id === format) || EXPORT_FORMATS[0];
  // JPEG has no alpha, so it must be flattened onto something. Leaving it to
  // the encoder gives black, which is never what anyone wants.
  const cv = docToCanvas(doc, { flatten: !f.alpha });
  const blob = await new Promise((res) => cv.toBlob(res, f.id, f.quality ? quality : undefined));
  if (!blob) throw new Error(`the browser could not encode ${f.label}`);
  if (blob.type !== f.id) {
    throw new Error(`this browser cannot encode ${f.label} -- it returned ${blob.type || 'an unknown type'} instead`);
  }
  download(`${name}.${f.ext}`, blob, f.id);
  return blob;
}

/** Which formats this browser can really encode, tested rather than assumed. */
export async function supportedFormats() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 2;
  const out = [];
  for (const f of EXPORT_FORMATS) {
    const blob = await new Promise((res) => cv.toBlob(res, f.id, 0.9));
    if (blob && blob.type === f.id) out.push(f);
  }
  return out;
}

// ------------------------------------------------------------------ import

/** Decode an image file into an RGBA Float32 buffer. */
export async function decodeImage(file) {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const img = g.getImageData(0, 0, cv.width, cv.height);
  const out = new Float32Array(cv.width * cv.height * 4);
  for (let i = 0; i < out.length; i++) out[i] = img.data[i] / 255;
  return { w: cv.width, h: cv.height, data: out };
}

/** A new document from one image. */
export async function docFromImage(file) {
  const { w, h, data } = await decodeImage(file);
  const doc = new Doc({ w, h, name: stripExt(file.name) });
  const l = new Layer({ type: 'raster', name: stripExt(file.name), surface: doc.newSurface(4) });
  l.surface.writeRect(rect(0, 0, w, h), data);
  doc.layers.push(l);
  return doc;
}

/** Add an image to an existing document as a new layer, centred. */
export async function layerFromImage(doc, file) {
  const { w, h, data } = await decodeImage(file);
  const l = new Layer({ type: 'raster', name: stripExt(file.name), surface: doc.newSurface(4) });
  const x = Math.round((doc.w - w) / 2);
  const y = Math.round((doc.h - h) / 2);
  l.surface.writeRect(rect(x, y, w, h), data);
  return l;
}

function stripExt(n) { return String(n || 'Layer').replace(/\.[^.]+$/, ''); }

// ------------------------------------------------------------------ project

function surfaceHeader(s, blocks) {
  if (!s) return null;
  const keys = [...s.tiles.keys()].sort((a, b) => a - b);
  for (const k of keys) blocks.push(s.tiles.get(k));
  return { channels: s.channels, depth: s.depth, tiles: keys };
}

function layerHeader(l, blocks) {
  const o = {};
  for (const k of LAYER_PROPS) o[k] = l[k];
  o.surface = surfaceHeader(l.surface, blocks);
  o.mask = surfaceHeader(l.mask, blocks);
  o.adjust = l.adjust ? { kind: l.adjust.kind, params: l.adjust.params } : null;
  o.fill = l.fill || null;
  o.text = l.text || null;
  o.blendIf = l.blendIf || null;
  o.children = l.children ? l.children.map((c) => layerHeader(c, blocks)) : null;
  return o;
}

/** Serialise a document to a single ArrayBuffer. */
export function saveProject(doc) {
  const blocks = [];
  const header = {
    magic: MAGIC,
    version: VERSION,
    w: doc.w, h: doc.h, depth: doc.depth, space: doc.space,
    linearBlend: doc.linearBlend,
    name: doc.name,
    tile: TILE,
    guides: doc.guides,
    layers: doc.layers.map((l) => layerHeader(l, blocks)),
    selection: surfaceHeader(doc.selection, blocks),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  let total = MAGIC.length + 1 + 4 + json.length;
  for (const b of blocks) total += b.byteLength;
  const buf = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i < MAGIC.length; i++) buf[o++] = MAGIC.charCodeAt(i);
  buf[o++] = VERSION;
  new DataView(buf.buffer).setUint32(o, json.length, true);
  o += 4;
  buf.set(json, o);
  o += json.length;
  for (const b of blocks) {
    buf.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), o);
    o += b.byteLength;
  }
  return buf;
}

/** Read a document back. Throws with a readable reason on anything unexpected. */
export function loadProject(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < MAGIC.length + 5) throw new Error('not a SlipShop file (too short)');
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error('not a SlipShop file (bad signature)');
  }
  const version = u8[MAGIC.length];
  if (version > VERSION) throw new Error(`this file was written by a newer SlipShop (version ${version})`);
  const dv = new DataView(u8.buffer, u8.byteOffset);
  const jsonLen = dv.getUint32(MAGIC.length + 1, true);
  let o = MAGIC.length + 5;
  if (o + jsonLen > u8.length) throw new Error('the file header is truncated');
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(o, o + jsonLen)));
  o += jsonLen;
  if (header.tile && header.tile !== TILE) {
    throw new Error(`this file uses ${header.tile}px tiles and this build uses ${TILE}px`);
  }

  const doc = new Doc({
    w: header.w, h: header.h, depth: header.depth, space: header.space,
    linearBlend: header.linearBlend, name: header.name,
  });
  if (header.guides) doc.guides = header.guides;

  const readSurface = (h) => {
    if (!h) return null;
    const s = new Surface(doc.w, doc.h, h.channels, h.depth);
    const per = TILE * TILE * h.channels * (h.depth / 8);
    for (const k of h.tiles) {
      if (o + per > u8.length) throw new Error('the file ran out of tile data -- it is truncated');
      const Ctor = h.depth === 8 ? Uint8Array : Uint16Array;
      // Copy rather than view: the backing buffer may not be aligned for a
      // Uint16Array view, and a view would also pin the whole file in memory.
      const t = new Ctor(TILE * TILE * h.channels);
      new Uint8Array(t.buffer).set(u8.subarray(o, o + per));
      s.tiles.set(k, t);
      o += per;
    }
    return s;
  };

  const readLayer = (h) => {
    const l = new Layer({ type: h.type, id: h.id });
    for (const k of LAYER_PROPS) if (h[k] !== undefined) l[k] = h[k];
    l.surface = readSurface(h.surface);
    l.mask = readSurface(h.mask);
    l.adjust = h.adjust || null;
    l.fill = h.fill || null;
    l.text = h.text || null;
    l.blendIf = h.blendIf || null;
    l.children = h.children ? h.children.map(readLayer) : (h.type === 'group' ? [] : null);
    return l;
  };

  doc.layers = header.layers.map(readLayer);
  doc.selection = readSurface(header.selection);
  if (!doc.layers.length) throw new Error('the file contains no layers');
  return doc;
}

export function downloadProject(doc) {
  const bytes = saveProject(doc);
  download(`${doc.name || 'untitled'}.slipshop`, bytes, 'application/octet-stream');
  return bytes.length;
}

/** Autosave to IndexedDB, so a reload does not lose work. */
const DB_NAME = 'slipshop';
const STORE = 'docs';

function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function autosave(doc) {
  try {
    const db = await openDb();
    const bytes = saveProject(doc);
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ at: Date.now(), name: doc.name, bytes }, 'current');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return bytes.length;
  } catch (e) {
    // A private window, or blocked site data. Autosave is a convenience, so
    // failing it must never interrupt the editor.
    return 0;
  }
}

export async function loadAutosave() {
  try {
    const db = await openDb();
    const rec = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get('current');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rec || null;
  } catch (e) {
    return null;
  }
}

export async function clearAutosave() {
  try {
    const db = await openDb();
    await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = res;
      tx.onerror = res;
    });
    db.close();
  } catch (e) { /* nothing to clear */ }
}
