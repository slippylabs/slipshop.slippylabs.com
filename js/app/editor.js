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
import { textDefaults } from '../core/text.js';
import { renderTextLayer } from './textlayer.js';
import {
  newPath, clonePath, pathFromContours, fillCoverage, strokeCoverage,
  shapePath, pathBounds,
} from '../core/path.js';
import { shapeDefaults, renderShape, shapeBounds } from '../core/shape.js';
import { Mesh, applyBrush, warpBuffer, warpSourceRect, DEFAULT_STEP } from '../core/liquify.js';
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
    /** Which saved path the pen tool draws into and the overlay shows. */
    this.activePathId = null;
    /** The live liquify session: the original pixels plus a mesh. */
    this.liquify = null;
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
    // Bank an open liquify session before the layer changes: it holds the
    // ORIGINAL pixels of the layer it started on, and applying it to a
    // different one would overwrite that layer with a warp of another.
    if (this.liquify) this.commitLiquify();
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
    // Through cloneLayer, not a second inline copy of the field list: this had
    // its own and the two drifted, so a duplicate silently lost its effects,
    // its text spec and its Blend If ranges.
    const copy = cloneLayer(src);
    copy.name = `${src.name} copy`;
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
    this.activePathId = null;
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
    this.activePathId = (doc.paths && doc.paths.length) ? doc.paths[0].id : null;
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
  // --------------------------------------------------------------- text

  /**
   * A new re-editable text layer. The spec is the truth; the surface is
   * derived from it and rebuilt on every edit.
   */
  addTextLayer(x, y, spec = {}) {
    this.history.begin('Text layer', this.doc);
    const loc = this.doc.locate(this.activeId);
    const text = {
      ...textDefaults(), x, y, color: [...this.fg], ...spec,
    };
    const l = new Layer({
      type: 'text',
      name: shortName(text.content),
      surface: this.doc.newSurface(4),
      text,
    });
    const list = loc ? loc.list : this.doc.layers;
    list.splice(loc ? loc.index + 1 : list.length, 0, l);
    renderTextLayer(this.doc, l);
    this.history.commit();
    this.activeId = l.id;
    this.invalidate();
    this.emit('layers');
    return l;
  }

  /**
   * Change a text layer's spec and redraw it.
   *
   * The surface is touched over the WHOLE document before the redraw, because
   * renderTextLayer clears all of it -- the text may have got shorter, and an
   * undo that only restored the new, smaller rect would leave the tail of the
   * old render behind.
   */
  setText(id, patch, { live = false } = {}) {
    const l = this.doc.find(id);
    if (!l || !l.text || !l.surface) return;
    this.history.begin('Edit text', this.doc);
    this.history.touch(l.surface, this.doc.bounds);
    // Follow the content with the layer's name only while the name is still
    // the one this derived last time. No extra flag to keep in sync, and a
    // name the user typed is never overwritten.
    const autoNamed = l.name === shortName(l.text.content);
    l.text = { ...l.text, ...patch };
    if (autoNamed) l.name = shortName(l.text.content);
    renderTextLayer(this.doc, l);
    if (!live) this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  /**
   * Turn a text layer into ordinary pixels.
   *
   * Painting on a text layer has to do this first: the spec owns the surface,
   * so the next keystroke would redraw over the brush stroke. Photoshop asks;
   * this does it and says so, which is the same outcome with one fewer dialog.
   */
  /**
   * Called by anything that is about to write pixels: if the target is a text
   * layer, turn it into one first. Returns true if it had to.
   *
   * One call at each entry point rather than a side effect inside the `target`
   * getter -- that getter is also read to SAMPLE pixels, by the eyedropper and
   * the histogram, and rasterising a layer because something looked at it is
   * the kind of surprise that is very hard to track down later.
   */
  rasterizeForPaint() {
    const l = this.active;
    if (!l || this.editingMask) return false;
    if (!l.text && !l.shape) return false;
    if (l.text) this.rasterizeText(l.id, { silent: true });
    else this.rasterizeShape(l.id);
    return true;
  }

  rasterizeText(id = this.activeId, { silent = false } = {}) {
    const l = this.doc.find(id);
    if (!l || !l.text) return false;
    // Recorded here rather than only in rasterizeForPaint: the Text panel's
    // own Rasterise button comes straight in, and the hint that follows the
    // event would otherwise name whatever was rasterised last time.
    this.lastRasterised = l.name;
    this.history.begin('Rasterise text', this.doc);
    l.text = null;
    l.type = 'raster';
    this.history.commit();
    this.emit('layers');
    if (!silent) this.emit('rasterised');
    return true;
  }

  // --------------------------------------------------------------- paths

  get activePath() {
    return (this.doc.paths || []).find((p) => p.id === this.activePathId) || null;
  }

  /** The path the pen tool draws into, created on first use. Photoshop calls
   *  it the Work Path and so does this; naming it is what SAVES it. */
  ensureWorkPath() {
    let p = this.activePath;
    if (p) return p;
    p = { id: `path-${++pathSeq}`, name: 'Work Path', path: newPath() };
    this.history.begin('New path', this.doc);
    this.doc.paths.push(p);
    this.history.commit();
    this.activePathId = p.id;
    this.emit('paths');
    return p;
  }

  addPath(path, name = 'Path') {
    this.history.begin('New path', this.doc);
    const p = { id: `path-${++pathSeq}`, name, path: clonePath(path) };
    this.doc.paths.push(p);
    this.history.commit();
    this.activePathId = p.id;
    this.invalidate();
    this.emit('paths');
    return p;
  }

  setPathGeometry(id, path, { live = false, label = 'Edit path' } = {}) {
    const p = (this.doc.paths || []).find((q) => q.id === id);
    if (!p) return;
    this.history.begin(label, this.doc);
    p.path = clonePath(path);
    if (!live) this.history.commit();
    this.emit('paths');
  }

  renamePath(id, name) {
    const p = (this.doc.paths || []).find((q) => q.id === id);
    if (!p) return;
    this.history.begin('Rename path', this.doc);
    p.name = name || 'Path';
    this.history.commit();
    this.emit('paths');
  }

  removePath(id = this.activePathId) {
    const i = (this.doc.paths || []).findIndex((q) => q.id === id);
    if (i < 0) return;
    this.history.begin('Delete path', this.doc);
    this.doc.paths.splice(i, 1);
    this.history.commit();
    if (this.activePathId === id) {
      this.activePathId = this.doc.paths.length ? this.doc.paths[Math.min(i, this.doc.paths.length - 1)].id : null;
    }
    this.emit('paths');
  }

  /** Paint a path's fill or stroke onto the active pixel layer. */
  paintPath(id = this.activePathId, mode = 'fill', opts = {}) {
    const p = (this.doc.paths || []).find((q) => q.id === id);
    if (!p) return false;
    if (this.rasterizeForPaint()) this.emit('rasterised');
    const surface = this.target;
    if (!surface || (this.active && this.active.locked)) return false;
    const out = mode === 'stroke'
      ? strokeCoverage(p.path, {
        width: opts.width || 2, cap: opts.cap || 'round', join: opts.join || 'miter',
        miterLimit: opts.miterLimit || 10, dash: opts.dash || null,
      })
      : fillCoverage(p.path, { evenOdd: !!opts.evenOdd });
    if (!out.cov.length) return false;
    const r = rectIntersect(out.r, this.doc.bounds);
    if (rectEmpty(r)) return false;
    const colour = opts.color || this.fg;
    this.editTarget(mode === 'stroke' ? 'Stroke path' : 'Fill path', r, () => {
      const dst = surface.readRect(r);
      const sel = this.selection ? this.selection.readRect(r) : null;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const i = y * r.w + x;
          const si = (r.y + y - out.r.y) * out.r.w + (r.x + x - out.r.x);
          let a = out.cov[si];
          if (sel) a *= sel[i];
          if (a <= 0) continue;
          if (surface.channels === 1) { dst[i] = dst[i] + (1 - dst[i]) * a; continue; }
          const q = i * 4;
          const ab = dst[q + 3];
          const ao = a + ab * (1 - a);
          for (let c = 0; c < 3; c++) dst[q + c] = (colour[c] * a + dst[q + c] * ab * (1 - a)) / ao;
          dst[q + 3] = ao;
        }
      }
      surface.writeRect(r, dst);
    });
    return true;
  }

  /** A path becomes a selection. */
  pathToSelection(id = this.activePathId, mode = 'new', { evenOdd = false } = {}) {
    const p = (this.doc.paths || []).find((q) => q.id === id);
    if (!p) return false;
    const out = fillCoverage(p.path, { evenOdd });
    if (!out.cov.length) return false;
    const r = this.doc.bounds;
    const buf = new Float32Array(r.w * r.h);
    for (let y = 0; y < out.r.h; y++) {
      const dy = out.r.y + y;
      if (dy < 0 || dy >= r.h) continue;
      for (let x = 0; x < out.r.w; x++) {
        const dx = out.r.x + x;
        if (dx < 0 || dx >= r.w) continue;
        buf[dy * r.w + dx] = out.cov[y * out.r.w + x];
      }
    }
    this.history.begin('Path to selection', this.doc);
    const prev = this.doc.selection ? this.doc.selection.readRect(r) : null;
    const sel = this.doc.newSurface(1);
    if (prev && mode !== 'new') {
      for (let i = 0; i < buf.length; i++) {
        const a = prev[i], b = buf[i];
        buf[i] = mode === 'add' ? Math.min(1, a + b)
          : mode === 'subtract' ? Math.max(0, a - b)
            : mode === 'intersect' ? a * b
              : Math.abs(a - b);
      }
    }
    sel.writeRect(r, buf);
    this.doc.selection = sel;
    this.history.commit();
    this.antsVersion++;
    this.emit('selection');
    return true;
  }

  /** ...and a selection becomes a path. The crack contours are axis-aligned,
   *  so the path reproduces the mask exactly rather than smoothing it. */
  selectionToPath(name = 'Selection path') {
    if (!this.doc.selection) return null;
    const contours = marchingAnts(this.doc.selection);
    if (!contours.length) return null;
    return this.addPath(pathFromContours(contours), name);
  }

  // --------------------------------------------------------------- shapes

  addShapeLayer(shape) {
    this.history.begin('Shape layer', this.doc);
    const loc = this.doc.locate(this.activeId);
    const spec = { ...shapeDefaults(), fill: [...this.fg], ...shape };
    // Build the geometry NOW. renderShape draws nothing at all when
    // path.subpaths is empty, and shapeDefaults() starts it empty -- callers
    // pass kind/box/params, not a path. Without this a new shape layer is
    // added, named and selected, and is completely invisible until something
    // happens to call setShape (which does build it), which looks like the
    // shape tool is broken rather than like one missing line.
    if (spec.box && !(spec.path && spec.path.subpaths && spec.path.subpaths.length)) {
      spec.path = shapePath(spec.kind, spec.box, spec.params || {});
    }
    const l = new Layer({
      type: 'shape',
      name: (spec.kind || 'Shape').replace(/^./, (c) => c.toUpperCase()),
      surface: this.doc.newSurface(4),
      shape: spec,
    });
    const list = loc ? loc.list : this.doc.layers;
    list.splice(loc ? loc.index + 1 : list.length, 0, l);
    this.renderShapeLayer(l);
    this.history.commit();
    this.activeId = l.id;
    this.invalidate();
    this.emit('layers');
    return l;
  }

  /** Redraw a shape layer's surface from its spec. Clears the WHOLE surface
   *  first, for the same reason a text layer does: the shape may have shrunk,
   *  and the tail of the old render is not part of the new one. */
  renderShapeLayer(l) {
    if (!l.shape || !l.surface) return null;
    l.surface.clearRect(this.doc.bounds);
    const r = rectIntersect(shapeBounds(l.shape), this.doc.bounds);
    if (rectEmpty(r)) return null;
    l.surface.writeRect(r, renderShape(l.shape, r));
    return r;
  }

  setShape(id, patch, { live = false } = {}) {
    const l = this.doc.find(id);
    if (!l || !l.shape || !l.surface) return;
    this.history.begin('Edit shape', this.doc);
    this.history.touch(l.surface, this.doc.bounds);
    l.shape = { ...l.shape, ...patch };
    if (patch.kind || patch.params || patch.box) {
      const box = patch.box || l.shape.box;
      if (box) l.shape.path = shapePath(l.shape.kind, box, l.shape.params || {});
    }
    this.renderShapeLayer(l);
    if (!live) this.history.commit();
    this.invalidate();
    this.emit('layers');
  }

  rasterizeShape(id = this.activeId) {
    const l = this.doc.find(id);
    if (!l || !l.shape) return false;
    this.lastRasterised = l.name;
    this.history.begin('Rasterise shape', this.doc);
    l.shape = null;
    l.type = 'raster';
    this.history.commit();
    this.emit('layers');
    return true;
  }

  // -------------------------------------------------------------- liquify

  /**
   * Start a liquify session on the active layer.
   *
   * The session holds the layer's ORIGINAL pixels and a mesh. Every dab goes
   * into the mesh and the layer is re-rendered from the original each time --
   * never from the previous render. That is the whole quality argument for
   * doing it this way: resampling the pixels once per stroke would soften the
   * image a little every time, and fifty strokes into a portrait the
   * difference is obvious. Accumulating in the mesh costs one resample from
   * the untouched original however many strokes have gone before.
   */
  beginLiquify() {
    const l = this.active;
    if (!l) return null;
    if (this.liquify && this.liquify.layerId === l.id) return this.liquify;
    this.commitLiquify();
    if (this.rasterizeForPaint()) this.emit('rasterised');
    const surface = this.target;
    if (!surface || surface.channels !== 4 || l.locked) return null;
    this.liquify = {
      layerId: l.id,
      surface,
      original: surface.clone(),
      mesh: new Mesh(this.doc.w, this.doc.h, DEFAULT_STEP),
      dirty: false,
    };
    this.emit('liquify');
    return this.liquify;
  }

  /** One brush dab, then a re-render from the original. */
  liquifyDab(tool, p) {
    const s = this.beginLiquify();
    if (!s) return false;
    if (!applyBrush(s.mesh, tool, p)) return false;
    if (tool === 'freeze' || tool === 'thaw') { s.dirty = true; this.emit('liquify'); return true; }
    s.dirty = true;
    this.renderLiquify();
    return true;
  }

  renderLiquify() {
    const s = this.liquify;
    if (!s) return;
    const dr = this.doc.bounds;
    const sr = warpSourceRect(dr, s.mesh);
    const src = s.original.readRect(sr);
    s.surface.clearRect(dr);
    s.surface.writeRect(dr, warpBuffer(src, sr, dr, s.mesh));
    this.invalidate(dr);
    this.emit('liquify');
  }

  /** Throw the warp away and put the layer back as it was. */
  resetLiquify() {
    const s = this.liquify;
    if (!s) return;
    s.mesh.reset();
    this.renderLiquify();
  }

  /** Bank the warp as one undo step. */
  commitLiquify() {
    const s = this.liquify;
    this.liquify = null;
    if (!s) return false;
    if (!s.dirty || s.mesh.isIdentity) {
      // Nothing happened, or the mesh was reset back to nothing. Put the
      // original pixels back and push NO undo entry: an undo step that does
      // nothing is its own bug.
      s.surface.tiles.clear();
      for (const [k, t] of s.original.tiles) s.surface.tiles.set(k, t);
      this.invalidate();
      this.emit('liquify');
      return false;
    }
    // The history has to be handed the state BEFORE the warp, and the warp is
    // already live in the surface -- so swap the original back in, record it,
    // then re-render. Recording the live pixels instead would make undo a
    // no-op, which is the same shape of bug the filter dialogs hit.
    const warped = new Map();
    for (const [k, t] of s.surface.tiles) warped.set(k, t);
    s.surface.tiles.clear();
    for (const [k, t] of s.original.tiles) s.surface.tiles.set(k, t);
    this.history.begin('Liquify', null);
    this.history.touch(s.surface, this.doc.bounds);
    s.surface.tiles.clear();
    for (const [k, t] of warped) s.surface.tiles.set(k, t);
    this.history.commit();
    this.invalidate();
    this.emit('history');
    this.emit('liquify');
    return true;
  }

  editTarget(label, r, fn) {
    const surface = this.target;
    if (!surface) return;
    guardedEdit(this.history, this.doc, label, surface, r, fn);
    this.invalidate(r);
    this.emit('history');
  }
}

let pathSeq = 0;

/** A layer name from its text: the first line, trimmed to something that fits
 *  the panel, so a text layer is recognisable without opening it. */
function shortName(content) {
  const first = String(content || '').split('\n')[0].trim();
  if (!first) return 'Text';
  return first.length > 22 ? `${first.slice(0, 21)}\u2026` : first;
}

function cloneLayer(src) {
  // Everything the layer carries, not just the fields that existed when this
  // was written: a duplicate that silently lost its effects, its text spec or
  // its Blend If ranges is a duplicate of something else.
  const copy = new Layer({
    type: src.type, name: src.name, visible: src.visible, opacity: src.opacity,
    fillOpacity: src.fillOpacity, blend: src.blend, clipping: src.clipping,
    locked: src.locked, maskEnabled: src.maskEnabled,
    offset: Array.isArray(src.offset) ? src.offset.slice() : src.offset,
    adjust: src.adjust ? structuredClone(src.adjust) : null,
    fill: src.fill ? { ...src.fill } : null,
    text: src.text ? structuredClone(src.text) : null,
    shape: src.shape ? structuredClone(src.shape) : null,
    blendIf: src.blendIf ? structuredClone(src.blendIf) : null,
    effects: src.effects ? structuredClone(src.effects) : [],
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
