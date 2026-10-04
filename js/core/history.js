// Undo.
//
// Two kinds of change need two different mechanisms, and using one for both is
// why a browser image editor usually either eats memory or loses edits:
//
//  * PIXELS -- a brush stroke, a filter, a fill. Recorded as the previous
//    contents of the TILES it touched. A 40-pixel dab on a 6000x4000 document
//    costs one 256 KB tile, not a 96 MB layer copy. Tiles are captured lazily,
//    the first time a stroke touches each one, so the cost is the area you
//    actually painted.
//
//  * STRUCTURE -- add, delete, reorder, rename, opacity, blend mode, mask
//    enable. Recorded as a snapshot of the layer TREE, with pixel surfaces
//    held by reference rather than copied. The tree is a few KB of plain
//    objects, and SlipStudio's state.js already makes the argument for
//    snapshots over inverse operations: a snapshot cannot be subtly wrong the
//    way a hand-written inverse can.
//
// A transaction can carry both, which is what "delete the selected area and
// drop the empty layer" needs.
//
// preview/commit: a slider drag emits hundreds of changes and must collapse to
// ONE undo step. begin() opens a transaction, the edit calls touch() as it
// goes, and commit() pushes a single entry. Re-entering begin() with the same
// label while a transaction is open coalesces into it.

import { TILE, Surface } from './tiles.js';
import { Layer, Doc } from './doc.js';
import { rect, rectEmpty } from './util.js';

const LAYER_PROPS = [
  'id', 'type', 'name', 'visible', 'opacity', 'fillOpacity', 'blend', 'locked',
  'clipping', 'maskEnabled', 'offset',
];

/** A structural snapshot: plain data, with surfaces held by REFERENCE. */
function snapTree(list) {
  return list.map((l) => {
    const o = {};
    for (const k of LAYER_PROPS) o[k] = Array.isArray(l[k]) ? l[k].slice() : l[k];
    o.surface = l.surface;                 // reference, never a copy
    o.mask = l.mask;
    o.effects = l.effects ? l.effects.map((e) => ({ ...e })) : [];
    o.adjust = l.adjust ? { kind: l.adjust.kind, params: { ...l.adjust.params } } : null;
    o.fill = l.fill ? { ...l.fill } : null;
    o.text = l.text ? { ...l.text } : null;
    o.shape = l.shape ? { ...l.shape } : null;
    o.blendIf = l.blendIf ? { ...l.blendIf } : null;
    o.children = l.children ? snapTree(l.children) : null;
    return o;
  });
}

function restoreTree(snap) {
  return snap.map((o) => {
    const l = new Layer({ type: o.type, id: o.id });
    for (const k of LAYER_PROPS) l[k] = Array.isArray(o[k]) ? o[k].slice() : o[k];
    l.surface = o.surface;
    l.mask = o.mask;
    l.effects = o.effects.map((e) => ({ ...e }));
    l.adjust = o.adjust ? { kind: o.adjust.kind, params: { ...o.adjust.params } } : null;
    l.fill = o.fill ? { ...o.fill } : null;
    l.text = o.text ? { ...o.text } : null;
    l.shape = o.shape ? { ...o.shape } : null;
    l.blendIf = o.blendIf ? { ...o.blendIf } : null;
    l.children = o.children ? restoreTree(o.children) : (o.type === 'group' ? [] : null);
    return l;
  });
}

class Transaction {
  constructor(label) {
    this.label = label;
    /** Map<Surface, Map<tileIndex, typedArray|null>> -- the state BEFORE. */
    this.tiles = new Map();
    this.treeBefore = null;
    this.selBefore = undefined;
    this.touchedTiles = 0;
  }

  /** Record the current contents of every tile in r, once per tile. */
  touch(surface, r) {
    const span = surface.tileSpan(r);
    if (!span) return;
    let m = this.tiles.get(surface);
    if (!m) { m = new Map(); this.tiles.set(surface, m); }
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const idx = surface.tileIndex(tx, ty);
        if (m.has(idx)) continue;                  // already captured this stroke
        const t = surface.tiles.get(idx);
        m.set(idx, t ? t.slice() : null);          // null == was unallocated
        this.touchedTiles++;
      }
    }
  }

  get isEmpty() { return this.tiles.size === 0 && this.treeBefore === null && this.selBefore === undefined; }
}

export class History {
  constructor(opts = {}) {
    this.limit = opts.limit || 200;
    this.past = [];
    this.future = [];
    this.open = null;
    this.onChange = opts.onChange || null;
  }

  get canUndo() { return this.past.length > 0 || (this.open !== null && !this.open.isEmpty); }
  get canRedo() { return this.future.length > 0; }
  get labels() { return { past: this.past.map((e) => e.label), future: this.future.map((e) => e.label) }; }

  /**
   * Open a transaction. Calling it again with the SAME label while one is
   * open coalesces -- that is how a drag that fires a change per mouse-move
   * becomes one undo step. A different label commits the old one first.
   */
  begin(label, doc) {
    if (this.open) {
      if (this.open.label === label) return this.open;
      this.commit();
    }
    this.open = new Transaction(label);
    if (doc) {
      this.open.treeBefore = snapTree(doc.layers);
      this.open.selBefore = doc.selection;
    }
    return this.open;
  }

  /** Record pixels about to change. No-op outside a transaction, which is a
   *  bug in the caller, so it throws rather than silently losing the undo. */
  touch(surface, r) {
    if (!this.open) throw new Error('History.touch() outside a transaction -- call begin() first');
    this.open.touch(surface, r);
  }

  /** Like touch, but for a whole surface. */
  touchAll(surface) { this.touch(surface, surface.bounds); }

  commit() {
    const t = this.open;
    this.open = null;
    if (!t || t.isEmpty) return null;
    this.past.push(t);
    // Dropping the OLDEST entry is right: the newest edits are the ones a
    // person wants back.
    while (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    if (this.onChange) this.onChange();
    return t;
  }

  /** Throw the open transaction away, restoring nothing. For a cancelled drag
   *  the caller must undo its own partial writes first -- abort only forgets. */
  abort() { this.open = null; }

  /**
   * Undo and redo are the SAME operation: swap the stored tiles with the live
   * ones and the stored tree with the live tree. One copy of the changed data
   * serves both directions, which halves the memory an editor's history costs.
   */
  undo(doc) {
    if (this.open) this.commit();
    const t = this.past.pop();
    if (!t) return null;
    this.swap(t, doc);
    this.future.push(t);
    if (this.onChange) this.onChange();
    return t;
  }

  redo(doc) {
    const t = this.future.pop();
    if (!t) return null;
    this.swap(t, doc);
    this.past.push(t);
    if (this.onChange) this.onChange();
    return t;
  }

  swap(t, doc) {
    for (const [surface, m] of t.tiles) {
      for (const [idx, stored] of m) {
        const live = surface.tiles.get(idx);
        m.set(idx, live ? live : null);
        if (stored) surface.tiles.set(idx, stored);
        else surface.tiles.delete(idx);
      }
    }
    if (t.treeBefore) {
      const now = snapTree(doc.layers);
      doc.layers = restoreTree(t.treeBefore);
      t.treeBefore = now;
    }
    if (t.selBefore !== undefined) {
      const now = doc.selection;
      doc.selection = t.selBefore;
      t.selBefore = now;
    }
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.open = null;
    if (this.onChange) this.onChange();
  }

  /** What the history is costing, in bytes of stored tile data. */
  get byteLength() {
    let n = 0;
    for (const list of [this.past, this.future]) {
      for (const t of list) {
        for (const [, m] of t.tiles) {
          for (const [, v] of m) if (v) n += v.byteLength;
        }
      }
    }
    return n;
  }

  get tileCount() {
    let n = 0;
    for (const list of [this.past, this.future]) {
      for (const t of list) for (const [, m] of t.tiles) n += m.size;
    }
    return n;
  }
}

/**
 * The guarded edit: open a transaction, record the tiles, run the edit, commit.
 * Every pixel-writing path should go through this rather than calling touch()
 * by hand, because a forgotten touch() is an edit that cannot be undone and
 * nothing fails at the time.
 */
export function edit(history, doc, label, surface, r, fn) {
  history.begin(label, null);
  history.touch(surface, r);
  try {
    return fn();
  } finally {
    history.commit();
  }
}
