// The editor: everything that is not the engine and not the DOM.
//
// It owns the document, the history, the selection, the current tool and the
// colours, and it is the only thing that writes to any of them. Panels read
// from here and call commands; nothing reaches into the document directly.
//
// Rendering is SCHEDULED, never immediate. An edit marks a dirty rect and
// asks for a frame; the frame composites that rect and nothing else. Painting
// a stroke that composited the whole document per pointer event would be
// unusable above about 1000 pixels square, and the dirty rect is what the
// tiled compositor exists to make cheap.

import { Doc, Layer, newDoc, validate } from '../core/doc.js';
import { History, edit as guardedEdit } from '../core/history.js';
import { compositeDoc } from '../core/composite.js';
import { Surface } from '../core/tiles.js';
import { applyAdjust } from '../core/adjust.js';
import { newSelection, selectionBounds, isEmptySelection, marchingAnts } from '../core/select.js';
import { rect, rectUnion, rectIntersect, rectEmpty, clamp, clamp01 } from '../core/util.js';
import { defaultBrush } from '../core/brush.js';
import { parseHex, toHex } from '../core/color.js';

export class Editor {
  constructor() {
    this.doc = newDoc(1200, 800);
    this.history = new History({ limit: 120 });
    this.activeId = this.doc.layers[0].id;
    /** The layer mask is edited instead of the pixels when this is on. */
    this.editingMask = false;
    this.tool = 'brush';
    this.fg = [0, 0, 0];
    this.bg = [1, 1, 1];
    this.brush = defaultBrush();
    this.zoom = 1;
    this.pan = [0, 0];
    this.swatches = [
      '#000000', '#ffffff', '#ff4655', '#ff9130', '#ffe066', '#39ff8f',
      '#1c8a52', '#4cc9f0', '#3a86ff', '#8338ec', '#ff006e', '#8d6e63',
      '#c0c0c0', '#606060', '#2b2b2b', '#f8f4e3', '#7f5539', '#0b6e4f',
      '#114b5f', '#f6ae2d',
    ];
    this.listeners = new Set();
    this.dirty = rect(0, 0, 0, 0);
    this.frame = null;
    this.antsVersion = 0;
    this.statusExtra = '';
  }

  // --------------------------------------------------------------- events

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'all') { for (const fn of this.listeners) fn(what); }

  // --------------------------------------------------------------- layers

  get active() { return this.doc.find(this.activeId) || this.doc.layers[this.doc.layers.length - 1] || null; }

  /** The surface an edit should write to: the layer's pixels, or its mask. */
  get target() {
    const l = this.active;
    if (!l) return null;
    if (this.editingMask && l.mask) return l.mask;
    return l.surface;
  }

  setActive(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.editingMask = false;
    this.emit('layers');
  }

  /** A new raster layer above the active one. */
  addLayer(opts = {}) {
    this.history.begin('New layer', this.doc);
    const loc = this.doc.locate(this.activeId);
    const l = new Layer({ type: 'raster', name: opts.name || 'Layer', ...opts });
    if (l.type === 'raster' && !l.surface) l.surface = this.doc.newSurface(4);
    const list = loc ? loc.list : this.doc.layers;
    const at = loc ? loc.index + 1 : list.length;
    list.splice(at, 0, l);
    this.history.commit();
    this.activeId = l.id;
    this.invalidate();
    this.emit('layers');
    return l;
  }

  removeLayer(id = this.activeId) {
    const loc = this.doc.locate(id);
    if (!loc) return;
    if (this.doc.layers.length === 1 && loc.list === this.doc.layers) return;   // never zero layers
    this.history.begin('Delete layer', this.doc);
    loc.list.splice(loc.index, 1);
    this.history.commit();
    const next = loc.list[Math.max(0, loc.index - 1)] || this.doc.layers[this.doc.layers.length - 1];
    this.activeId = next ? next.id : null;
    this.invalidate();
    this.emit('layers');
  }

  duplicateLayer(id = this.activeId) {
    const loc = this.doc.locate(id);
    if (!loc) return;
    const src = loc.list[loc.index];
    this.history.begin('Duplicate layer', this.doc);
    const copy = new Layer({
      type: src.type, name: `${src.name} copy`, visible: src.visible,
      opacity: src.opacity, fillOpacity: src.fillOpacity, blend: src.blend,
      clipping: src.clipping, adjust: src.adjust ? structuredClone(src.adjust) : null,
      fill: src.fill ? { ...src.fill } : null,
    });
    if (src.surface) copy.surface = src.surface.clone();
    if (src.mask) copy.mask = src.mask.clone();
    if (src.children) copy.children = src.children.map((c) => cloneLayer(c));
    loc.list.splice(loc.index + 1, 0, copy);
    this.history.commit();
    this.activeId = copy.id;
    this.invalidate();
    this.emit('layers');
    return copy;
  }

  moveLayer(id, delta) {
    const loc = this.doc.locate(id);
    if (!loc) return;
    const to = loc.index + delta;
    if (to < 0 || to >= loc.list.length) return;
    this.history.begin('Reorder layer', this.doc);
    const [l] = loc.list.splice(loc.index, 1);
    loc.list.splice(to, 0, l);
    this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  /** Change a layer property as one undo step, coalescing a drag. */
  setLayerProp(id, key, value, { live = false } = {}) {
    const l = this.doc.find(id);
    if (!l) return;
    this.history.begin(`Layer ${key}`, this.doc);
    l[key] = value;
    if (!live) this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  commitProp() { this.history.commit(); this.emit('history'); }

  addMask(id = this.activeId, { fromSelection = false } = {}) {
    const l = this.doc.find(id);
    if (!l || l.mask) return;
    this.history.begin('Add mask', this.doc);
    l.mask = this.doc.newSurface(1);
    if (fromSelection && this.doc.selection) {
      const r = this.doc.bounds;
      l.mask.writeRect(r, this.doc.selection.readRect(r));
    } else {
      l.mask.fill([1]);
    }
    this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  removeMask(id = this.activeId, { apply = false } = {}) {
    const l = this.doc.find(id);
    if (!l || !l.mask) return;
    this.history.begin(apply ? 'Apply mask' : 'Delete mask', this.doc);
    if (apply && l.surface) {
      const r = this.doc.bounds;
      this.history.touch(l.surface, r);
      const px = l.surface.readRect(r);
      const m = l.mask.readRect(r);
      for (let i = 0; i < m.length; i++) px[i * 4 + 3] *= m[i];
      l.surface.writeRect(r, px);
    }
    l.mask = null;
    this.editingMask = false;
    this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  groupSelected() {
    const loc = this.doc.locate(this.activeId);
    if (!loc) return;
    this.history.begin('Group layers', this.doc);
    const [l] = loc.list.splice(loc.index, 1);
    const g = new Layer({ type: 'group', name: 'Group' });
    g.children.push(l);
    loc.list.splice(loc.index, 0, g);
    this.history.commit();
    this.activeId = g.id;
    this.invalidate();
    this.emit('layers');
  }

  /** Merge the active layer down into the one below it. */
  mergeDown() {
    const loc = this.doc.locate(this.activeId);
    if (!loc || loc.index === 0) return;
    const top = loc.list[loc.index];
    const below = loc.list[loc.index - 1];
    if (!below.surface || below.type !== 'raster') return;
    // Composite just these two, which is exactly what merging means: the
    // result must look identical to what was on screen.
    const sub = new Doc({ w: this.doc.w, h: this.doc.h, depth: this.doc.depth });
    sub.layers = [cloneRef(below), cloneRef(top)];
    const r = this.doc.bounds;
    const flat = compositeDoc(sub, r, { applyAdjust });
    this.history.begin('Merge down', this.doc);
    this.history.touch(below.surface, r);
    below.surface.writeRect(r, flat);
    below.opacity = 1;
    below.blend = 'normal';
    below.mask = null;
    loc.list.splice(loc.index, 1);
    this.history.commit();
    this.activeId = below.id;
    this.invalidate();
    this.emit('layers');
  }

  flatten() {
    const r = this.doc.bounds;
    const flat = compositeDoc(this.doc, r, { applyAdjust });
    this.history.begin('Flatten image', this.doc);
    const l = new Layer({ type: 'raster', name: 'Background', surface: this.doc.newSurface(4) });
    l.surface.writeRect(r, flat);
    this.doc.layers = [l];
    this.history.commit();
    this.activeId = l.id;
    this.invalidate();
    this.emit('layers');
  }

  // ------------------------------------------------------------ selection

  get selection() { return this.doc.selection; }

  setSelection(sel, label = 'Selection') {
    this.history.begin(label, this.doc);
    this.doc.selection = sel;
    this.history.commit();
    this.antsVersion++;
    this.emit('selection');
  }

  /** The selection surface, created on demand. */
  ensureSelection() {
    if (!this.doc.selection) this.doc.selection = newSelection(this.doc);
    return this.doc.selection;
  }

  deselect() {
    if (!this.doc.selection) return;
    this.setSelection(null, 'Deselect');
  }

  get selectionPaths() {
    if (!this.doc.selection) return null;
    if (this._antsCache && this._antsCache.v === this.antsVersion) return this._antsCache.paths;
    const paths = marchingAnts(this.doc.selection);
    this._antsCache = { v: this.antsVersion, paths };
    return paths;
  }

  // -------------------------------------------------------------- colours

  get fgHex() { return toHex(this.fg); }
  get bgHex() { return toHex(this.bg); }
  setFg(c) { this.fg = Array.isArray(c) ? c.slice(0, 3) : parseHex(c).slice(0, 3); this.emit('colour'); }
  setBg(c) { this.bg = Array.isArray(c) ? c.slice(0, 3) : parseHex(c).slice(0, 3); this.emit('colour'); }
  swapColours() { const t = this.fg; this.fg = this.bg; this.bg = t; this.emit('colour'); }
  resetColours() { this.fg = [0, 0, 0]; this.bg = [1, 1, 1]; this.emit('colour'); }

  // ------------------------------------------------------------ rendering

  /** Mark a document region as needing a recomposite. */
  invalidate(r) {
    this.dirty = r ? rectUnion(this.dirty, rectIntersect(r, this.doc.bounds)) : this.doc.bounds;
    this.requestFrame();
  }

  requestFrame() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const r = this.dirty;
      this.dirty = rect(0, 0, 0, 0);
      if (!rectEmpty(r)) this.emit('paint:' + JSON.stringify(r));
    });
  }

  /** Composite a region, with adjustment layers wired up. */
  render(r) {
    return compositeDoc(this.doc, r, { applyAdjust });
  }

  // ----------------------------------------------------------- documents

  newDocument(w, h, opts = {}) {
    this.doc = newDoc(w, h, opts);
    this.history.clear();
    this.activeId = this.doc.layers[0].id;
    this.editingMask = false;
    this.antsVersion++;
    this.zoom = 1;
    this.pan = [0, 0];
    this.emit('doc');
  }

  setDocument(doc) {
    const problems = validate(doc);
    if (problems.length) throw new Error(`invalid document: ${problems[0]}`);
    this.doc = doc;
    this.history.clear();
    this.activeId = doc.layers[doc.layers.length - 1].id;
    this.editingMask = false;
    this.antsVersion++;
    this.emit('doc');
  }

  undo() { if (this.history.undo(this.doc)) { this.afterHistory(); } }
  redo() { if (this.history.redo(this.doc)) { this.afterHistory(); } }

  afterHistory() {
    if (!this.doc.find(this.activeId)) {
      const last = this.doc.layers[this.doc.layers.length - 1];
      this.activeId = last ? last.id : null;
    }
    this.antsVersion++;
    this.invalidate();
    this.emit('layers');
    this.emit('history');
  }

  /** Run an edit on the active target with undo recorded. */
  editTarget(label, r, fn) {
    const surface = this.target;
    if (!surface) return;
    guardedEdit(this.history, this.doc, label, surface, r, fn);
    this.invalidate(r);
    this.emit('history');
  }
}

function cloneLayer(src) {
  const copy = new Layer({
    type: src.type, name: src.name, visible: src.visible, opacity: src.opacity,
    fillOpacity: src.fillOpacity, blend: src.blend, clipping: src.clipping,
    adjust: src.adjust ? structuredClone(src.adjust) : null,
    fill: src.fill ? { ...src.fill } : null,
  });
  if (src.surface) copy.surface = src.surface.clone();
  if (src.mask) copy.mask = src.mask.clone();
  if (src.children) copy.children = src.children.map(cloneLayer);
  return copy;
}

/** A shallow stand-in that shares the pixels -- for compositing a subset
 *  without copying any surface. */
function cloneRef(src) {
  const l = new Layer({
    type: src.type, name: src.name, visible: src.visible, opacity: src.opacity,
    fillOpacity: src.fillOpacity, blend: src.blend === 'pass-through' ? 'normal' : src.blend,
    clipping: false, adjust: src.adjust, fill: src.fill, id: src.id,
  });
  l.surface = src.surface;
  l.mask = src.mask;
  l.maskEnabled = src.maskEnabled;
  l.children = src.children;
  return l;
}
