// The document: layers, masks, channels and the selection.
//
// LAYER ORDER IS BOTTOM-FIRST. layers[0] is the bottom of the stack and the
// last element is the top. That is compositing order, so the hot loop never
// reverses anything; the UI reverses for display, once, where it is cheap. The
// opposite choice puts a .slice().reverse() in the inner loop of the only
// function whose speed matters.

import { Surface } from './tiles.js';
import { MODES, isMode } from './blend.js';
import { rect, clamp01 } from './util.js';

export const LAYER_TYPES = ['raster', 'group', 'adjustment', 'fill', 'text', 'shape'];

let nextId = 1;
/** Ids are strings so they can go in a JSON project and a DOM dataset. */
export function newId(prefix = 'l') { return `${prefix}${nextId++}`; }
/** Tests need a deterministic sequence. */
export function resetIds(n = 1) { nextId = n; }

export class Layer {
  constructor(opts = {}) {
    const type = opts.type || 'raster';
    if (!LAYER_TYPES.includes(type)) throw new Error(`unknown layer type: ${type}`);
    this.id = opts.id || newId();
    this.type = type;
    this.name = opts.name || defaultName(type);
    this.visible = opts.visible !== false;
    this.opacity = opts.opacity === undefined ? 1 : clamp01(opts.opacity);
    /** Fill opacity scales the layer's own pixels but NOT its effects --
     *  which is the whole point of having both, and what "knockout" text with
     *  a stroke relies on. */
    this.fillOpacity = opts.fillOpacity === undefined ? 1 : clamp01(opts.fillOpacity);
    this.blend = opts.blend || (type === 'group' ? 'pass-through' : 'normal');
    this.locked = !!opts.locked;
    /** Clip to the alpha of the nearest non-clipping layer below. */
    this.clipping = !!opts.clipping;
    this.surface = opts.surface || null;        // raster pixels, or null
    this.mask = opts.mask || null;              // 1-channel Surface, or null
    this.maskEnabled = opts.maskEnabled !== false;
    this.children = opts.children || (type === 'group' ? [] : null);
    this.effects = opts.effects || [];
    /** For an adjustment layer: { kind, params }. */
    this.adjust = opts.adjust || null;
    /** For a fill layer: { kind: 'solid'|'gradient'|'pattern', ... }. */
    this.fill = opts.fill || null;
    this.text = opts.text || null;
    this.shape = opts.shape || null;
    /** Blend If: per-channel ranges that limit where this layer shows. */
    this.blendIf = opts.blendIf || null;
    this.offset = opts.offset || [0, 0];
  }

  /** A group with any blend mode other than pass-through is ISOLATED: its
   *  children composite against transparency, not against the backdrop.
   *  Photoshop also isolates a pass-through group once it has an opacity or a
   *  mask, because there is otherwise no single result to scale or mask. */
  get isolated() {
    if (this.type !== 'group') return false;
    if (this.blend !== 'pass-through') return true;
    return this.opacity < 1 || !!(this.mask && this.maskEnabled);
  }

  get effectiveBlend() { return this.blend === 'pass-through' ? 'normal' : this.blend; }
}

function defaultName(type) {
  return {
    raster: 'Layer', group: 'Group', adjustment: 'Adjustment',
    fill: 'Fill', text: 'Text', shape: 'Shape',
  }[type];
}

export class Doc {
  constructor(opts = {}) {
    const w = opts.w ?? 1024;
    const h = opts.h ?? 768;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      throw new Error(`document size must be positive integers, got ${w}x${h}`);
    }
    this.w = w;
    this.h = h;
    this.depth = opts.depth || 8;
    this.space = opts.space || 'srgb';
    /** Blend in encoded space by default -- what Photoshop, CSS and the canvas
     *  all do, and what makes the browser a valid oracle. Linear is offered
     *  because it is the physically right answer for photographic work. */
    this.linearBlend = !!opts.linearBlend;
    this.layers = opts.layers || [];
    /** An 8-bit coverage mask, or null for "everything". */
    this.selection = opts.selection || null;
    this.name = opts.name || 'Untitled';
    this.guides = opts.guides || { h: [], v: [] };
    this.meta = opts.meta || {};
  }

  get bounds() { return rect(0, 0, this.w, this.h); }

  newSurface(channels = 4) { return new Surface(this.w, this.h, channels, this.depth); }

  addLayer(layer, index) {
    const l = layer instanceof Layer ? layer : new Layer(layer);
    if (l.type === 'raster' && !l.surface) l.surface = this.newSurface(4);
    if (index === undefined) this.layers.push(l); else this.layers.splice(index, 0, l);
    return l;
  }

  /** Depth-first walk, bottom-first within each level. */
  *walk(list = this.layers, depth = 0, parent = null) {
    for (const l of list) {
      yield { layer: l, depth, parent };
      if (l.children) yield* this.walk(l.children, depth + 1, l);
    }
  }

  find(id) {
    for (const { layer } of this.walk()) if (layer.id === id) return layer;
    return null;
  }

  /** The list containing a layer, and its index in it. */
  locate(id, list = this.layers, parent = null) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list, index: i, parent };
      if (list[i].children) {
        const r = this.locate(id, list[i].children, list[i]);
        if (r) return r;
      }
    }
    return null;
  }

  get layerCount() { let n = 0; for (const _ of this.walk()) n++; return n; }
  get byteLength() {
    let n = 0;
    for (const { layer } of this.walk()) {
      if (layer.surface) n += layer.surface.byteLength;
      if (layer.mask) n += layer.mask.byteLength;
    }
    return n;
  }
}

/** A document with one opaque white layer, which is what File > New means. */
export function newDoc(w, h, opts = {}) {
  const d = new Doc({ w, h, ...opts });
  const bg = d.addLayer(new Layer({ type: 'raster', name: 'Background', locked: true }));
  bg.surface = d.newSurface(4);
  bg.surface.fill(opts.background || [1, 1, 1, 1]);
  return d;
}

/** Validate a stack before it reaches the compositor, so a bad blend name or
 *  a group cycle fails loudly here rather than drawing nothing. */
export function validate(doc) {
  const problems = [];
  const seen = new Set();
  const visit = (list, depth) => {
    if (depth > 32) { problems.push('layer nesting deeper than 32'); return; }
    for (const l of list) {
      if (seen.has(l)) { problems.push(`layer ${l.id} appears twice in the stack`); continue; }
      seen.add(l);
      if (!LAYER_TYPES.includes(l.type)) problems.push(`layer ${l.id}: unknown type ${l.type}`);
      if (l.type === 'group') {
        if (l.blend !== 'pass-through' && !isMode(l.blend)) problems.push(`layer ${l.id}: unknown blend ${l.blend}`);
      } else if (!isMode(l.blend)) {
        problems.push(`layer ${l.id}: unknown blend ${l.blend}`);
      }
      if (l.surface && (l.surface.w !== doc.w || l.surface.h !== doc.h)) {
        problems.push(`layer ${l.id}: surface is ${l.surface.w}x${l.surface.h}, document is ${doc.w}x${doc.h}`);
      }
      if (l.mask && (l.mask.w !== doc.w || l.mask.h !== doc.h)) {
        problems.push(`layer ${l.id}: mask is ${l.mask.w}x${l.mask.h}, document is ${doc.w}x${doc.h}`);
      }
      if (l.mask && l.mask.channels !== 1) problems.push(`layer ${l.id}: a mask must be 1 channel`);
      if (l.type === 'adjustment' && !l.adjust) problems.push(`layer ${l.id}: adjustment layer with no adjust spec`);
      if (l.children) visit(l.children, depth + 1);
    }
  };
  visit(doc.layers, 0);
  if (doc.selection && doc.selection.channels !== 1) problems.push('the selection must be 1 channel');
  return problems;
}
