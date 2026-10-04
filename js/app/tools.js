// Tools: everything that turns a pointer gesture into an edit.
//
// A paint tool cannot simply composite each stamp onto the layer as it
// arrives. Flow accumulates within a stroke and opacity caps the whole
// stroke, so the layer has to show "original pixels, with the WHOLE stroke so
// far applied once" at every moment. That needs the original pixels back, so
// each paint session keeps a sparse BACKUP of the tiles the stroke has
// touched, restores from it, and re-applies the accumulated coverage. Without
// that, a 20%-opacity brush darkens every time the pointer wobbles over a
// spot it already covered.
//
// The backup is the same sparse Surface as everything else, so it costs the
// tiles the stroke actually touched.

import { Stroke, applyStroke, defaultBrush } from '../core/brush.js';
import { Surface, TILE } from '../core/tiles.js';
import {
  rectCoverage, ellipseCoverage, polygonCoverage, applyCoverage, magicWand,
  newSelection, featherSelection,
} from '../core/select.js';
import { renderGradient, twoStop, fgToTransparent, bucketFill, GRADIENT_SHAPES } from '../core/gradient.js';
import { compositeDoc } from '../core/composite.js';
import { applyAdjust } from '../core/adjust.js';
import { gaussianBlur, unsharpMask } from '../core/convolve.js';
import { luma709, rect, rectUnion, rectIntersect, rectEmpty, clamp, clamp01, lerp } from '../core/util.js';
import { toHex } from '../core/color.js';
import { hint, toast } from './ui.js';

export const TOOLS = [
  { id: 'move', label: 'Move', icon: '✚', key: 'v', group: 0 },
  { id: 'marquee', label: 'Rectangular Select', icon: '▭', key: 'm', group: 1 },
  { id: 'ellipse', label: 'Elliptical Select', icon: '◯', key: 'M', group: 1 },
  { id: 'lasso', label: 'Lasso', icon: '❦', key: 'l', group: 1 },
  { id: 'polygon', label: 'Polygonal Lasso', icon: '⬠', key: 'L', group: 1 },
  { id: 'wand', label: 'Magic Wand', icon: '✨', key: 'w', group: 1 },
  { id: 'crop', label: 'Crop', icon: '⌗', key: 'c', group: 2 },
  { id: 'eyedropper', label: 'Eyedropper', icon: '⚗', key: 'i', group: 2 },
  { id: 'brush', label: 'Brush', icon: '✎', key: 'b', group: 3 },
  { id: 'pencil', label: 'Pencil', icon: '✒', key: 'B', group: 3 },
  { id: 'eraser', label: 'Eraser', icon: '⌫', key: 'e', group: 3 },
  { id: 'clone', label: 'Clone Stamp', icon: '⧉', key: 's', group: 3 },
  { id: 'smudge', label: 'Smudge', icon: '☛', key: 'r', group: 4 },
  { id: 'blur', label: 'Blur', icon: '◌', key: 'R', group: 4 },
  { id: 'sharpen', label: 'Sharpen', icon: '▲', key: null, group: 4 },
  { id: 'dodge', label: 'Dodge', icon: '◑', key: 'o', group: 4 },
  { id: 'burn', label: 'Burn', icon: '◐', key: 'O', group: 4 },
  { id: 'gradient', label: 'Gradient', icon: '▤', key: 'g', group: 5 },
  { id: 'bucket', label: 'Paint Bucket', icon: '⛃', key: 'G', group: 5 },
  { id: 'shape', label: 'Shape', icon: '■', key: 'u', group: 5 },
  { id: 'text', label: 'Text', icon: 'T', key: 't', group: 6 },
  { id: 'zoom', label: 'Zoom', icon: '⌕', key: 'z', group: 7 },
  { id: 'hand', label: 'Hand', icon: '✋', key: 'h', group: 7 },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

const PAINT_TOOLS = new Set(['brush', 'pencil', 'eraser', 'clone', 'smudge', 'blur', 'sharpen', 'dodge', 'burn']);
export const isPaintTool = (id) => PAINT_TOOLS.has(id);
const SELECT_TOOLS = new Set(['marquee', 'ellipse', 'lasso', 'polygon', 'wand']);
export const isSelectTool = (id) => SELECT_TOOLS.has(id);

/** Per-tool options the toolbar edits. */
export function defaultToolOptions() {
  return {
    selectMode: 'new',
    feather: 0,
    antialias: true,
    tolerance: 20,
    contiguous: true,
    sampleAll: false,
    gradientShape: 'linear',
    gradientKind: 'fg-bg',
    gradientReverse: false,
    gradientDither: true,
    shapeKind: 'rect',
    shapeFill: true,
    strength: 0.5,
    exposure: 0.3,
    cloneAligned: true,
    text: 'Type here',
    fontSize: 64,
    fontFamily: 'sans-serif',
    fontWeight: 'bold',
  };
}

/**
 * The live gesture. One of these exists between pointerdown and pointerup.
 */
export class Gesture {
  constructor(ed, view, opt) {
    this.ed = ed;
    this.view = view;
    this.opt = opt;
    this.active = false;
  }

  start(e) {
    const ed = this.ed;
    const [x, y] = this.view.toDoc(e.clientX, e.clientY);
    this.startDoc = [x, y];
    this.lastDoc = [x, y];
    this.startClient = [e.clientX, e.clientY];
    this.tool = ed.tool;
    this.alt = e.altKey;
    this.shift = e.shiftKey;
    this.active = true;
    this.points = [[x, y]];
    this.moved = false;

    // Space held, or the hand tool, pans whatever tool is selected.
    if (this.tool === 'hand' || e.spacePan) { this.mode = 'pan'; return; }
    if (this.tool === 'zoom') { this.mode = 'zoom'; return; }

    if (isPaintTool(this.tool)) return this.startPaint(e, x, y);
    if (this.tool === 'eyedropper') return this.pick(x, y);
    if (this.tool === 'bucket') return this.bucket(x, y);
    if (this.tool === 'move') return this.startMove();
    if (this.tool === 'wand') return this.wand(x, y);
    if (this.tool === 'gradient') { this.mode = 'gradient'; return; }
    if (this.tool === 'crop') { this.mode = 'crop'; return; }
    if (this.tool === 'shape') { this.mode = 'shape'; return; }
    if (this.tool === 'text') return this.placeText(x, y);
    this.mode = 'select';
  }

  move(e) {
    if (!this.active) return;
    const [x, y] = this.view.toDoc(e.clientX, e.clientY);
    this.moved = true;
    switch (this.mode) {
      case 'pan':
        this.view.panBy(e.clientX - this.startClient[0], e.clientY - this.startClient[1]);
        this.startClient = [e.clientX, e.clientY];
        return;
      case 'paint':
        return this.paintTo(e, x, y);
      case 'move':
        return this.moveTo(x, y);
      case 'select':
        this.points.push([x, y]);
        return this.previewSelect(x, y);
      case 'gradient':
      case 'crop':
      case 'shape':
        this.lastDoc = [x, y];
        return this.previewShape(x, y);
      case 'zoom':
        this.lastDoc = [x, y];
        return this.previewShape(x, y);
      default:
    }
  }

  end(e) {
    if (!this.active) return;
    this.active = false;
    const [x, y] = this.view.toDoc(e.clientX, e.clientY);
    switch (this.mode) {
      case 'paint': return this.endPaint();
      case 'move': return this.endMove();
      case 'select': return this.commitSelect(x, y);
      case 'gradient': return this.commitGradient(x, y);
      case 'crop': return this.commitCrop(x, y);
      case 'shape': return this.commitShape(x, y);
      case 'zoom': return this.commitZoom(e, x, y);
      default:
        this.view.clearPreview();
    }
  }

  cancel() {
    if (this.mode === 'paint' && this.session) {
      this.restoreAll();
      this.ed.history.abort();
    }
    this.active = false;
    this.view.clearPreview();
  }

  // ------------------------------------------------------------- painting

  startPaint(e, x, y) {
    const ed = this.ed;
    const layer = ed.active;
    const surface = ed.target;
    if (!surface) { toast('There is nothing to paint on -- add a layer', { bad: true }); this.active = false; return; }
    if (layer.locked) { toast(`${layer.name} is locked`, { bad: true }); this.active = false; return; }
    if (layer.type !== 'raster' && !ed.editingMask) {
      toast(`${layer.name} is not a pixel layer`, { bad: true }); this.active = false; return;
    }

    // The clone stamp needs its source set with alt-click before it can paint.
    if (this.tool === 'clone' && e.altKey) {
      this.ed.cloneSource = [x, y];
      hint('Clone source set. Now paint.');
      this.active = false;
      return;
    }
    if (this.tool === 'clone' && !this.ed.cloneSource) {
      toast('Alt-click to set the clone source first', { bad: true });
      this.active = false;
      return;
    }

    this.mode = 'paint';
    const brush = { ...ed.brush };
    if (this.tool === 'pencil') { brush.hardness = 1; brush.smoothing = 0; }
    this.stroke = new Stroke(ed.doc.w, ed.doc.h, brush);
    this.backup = new Surface(ed.doc.w, ed.doc.h, surface.channels, surface.depth);
    this.backedUp = new Set();
    this.surface = surface;
    this.session = true;
    this.cloneOffset = this.tool === 'clone'
      ? [this.ed.cloneSource[0] - x, this.ed.cloneSource[1] - y]
      : null;
    ed.history.begin(TOOL_BY_ID[this.tool].label, null);
    const r = this.stroke.add(x, y, pressureOf(e), tiltOf(e));
    this.flush(r);
  }

  paintTo(e, x, y) {
    const r = this.stroke.add(x, y, pressureOf(e), tiltOf(e));
    if (!rectEmpty(r)) this.flush(r);
  }

  /** Copy the original tiles of r into the backup, once each. */
  backupTiles(r) {
    const span = this.surface.tileSpan(r);
    if (!span) return;
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const idx = this.surface.tileIndex(tx, ty);
        if (this.backedUp.has(idx)) continue;
        this.backedUp.add(idx);
        const t = this.surface.tiles.get(idx);
        if (t) this.backup.tiles.set(idx, t.slice());
        // An absent tile stays absent in the backup, which is how "restore"
        // knows to delete rather than to zero.
      }
    }
    this.ed.history.touch(this.surface, r);
  }

  /**
   * Put the original pixels back, then re-apply the whole stroke over them.
   *
   * The rect is expanded to TILE BOUNDARIES first, and that is not an
   * optimisation -- it is the correctness condition. restore() can only work a
   * whole tile at a time (it swaps the stored array in), so if the re-apply
   * covered only the raw dirty rect, every part of an earlier dab that shared
   * a tile with this one would be restored to the original and never painted
   * again. The stroke came out as scattered fragments, or vanished entirely.
   * Restoring and re-applying over exactly the same area is what makes the
   * backup-and-replay scheme sound.
   */
  flush(r) {
    const clipped = rectIntersect(r, this.ed.doc.bounds);
    if (rectEmpty(clipped)) return;
    const aligned = this.tileAlign(clipped);
    this.backupTiles(aligned);
    this.restore(aligned);
    this.applyHere(aligned);
    this.ed.invalidate(clipped);
  }

  /** Grow a rect out to the tile grid, clipped to the document. */
  tileAlign(r) {
    const T = TILE;
    const x0 = Math.floor(r.x / T) * T;
    const y0 = Math.floor(r.y / T) * T;
    const x1 = Math.ceil((r.x + r.w) / T) * T;
    const y1 = Math.ceil((r.y + r.h) / T) * T;
    return rectIntersect(rect(x0, y0, x1 - x0, y1 - y0), this.ed.doc.bounds);
  }

  restore(r) {
    const span = this.surface.tileSpan(r);
    if (!span) return;
    for (let ty = span.y0; ty <= span.y1; ty++) {
      for (let tx = span.x0; tx <= span.x1; tx++) {
        const idx = this.surface.tileIndex(tx, ty);
        if (!this.backedUp.has(idx)) continue;
        const b = this.backup.tiles.get(idx);
        if (b) this.surface.tiles.set(idx, b.slice());
        else this.surface.tiles.delete(idx);
      }
    }
  }

  restoreAll() {
    for (const idx of this.backedUp) {
      const b = this.backup.tiles.get(idx);
      if (b) this.surface.tiles.set(idx, b.slice());
      else this.surface.tiles.delete(idx);
    }
    this.ed.invalidate();
  }

  /** Apply the accumulated stroke over one rect, per tool. */
  applyHere(r) {
    const ed = this.ed;
    const layer = ed.active;
    const sel = ed.selection;
    const cov = this.stroke.cov.readRect(r);
    const op = ed.brush.opacity;

    if (ed.editingMask && layer.mask) {
      // Painting a mask writes coverage, not colour: white reveals, black
      // hides, and the brush colour chooses which.
      const target = this.tool === 'eraser' ? 1 : luma709(ed.fg[0], ed.fg[1], ed.fg[2]);
      const cur = layer.mask.readRect(r);
      const s = sel ? sel.readRect(r) : null;
      for (let i = 0; i < cur.length; i++) {
        let a = cov[i] * op;
        if (s) a *= s[i];
        if (a <= 0) continue;
        cur[i] = lerp(cur[i], target, a);
      }
      layer.mask.writeRect(r, cur);
      return;
    }

    switch (this.tool) {
      case 'brush':
      case 'pencil':
        applyStroke(layer, this.stroke, r, { color: ed.fg, opacity: op, selection: sel });
        return;
      case 'eraser':
        applyStroke(layer, this.stroke, r, { opacity: op, mode: 'erase', selection: sel });
        return;
      case 'clone': {
        const src = this.sampleSource(r, this.cloneOffset);
        this.blendBuffer(r, cov, sel, (i, dst) => {
          const p = i * 4;
          return [src[p], src[p + 1], src[p + 2], src[p + 3]];
        });
        return;
      }
      case 'smudge': {
        // Smear: pull the colour from one brush-width behind the stroke.
        const back = this.strokeDirection();
        const src = this.sampleSource(r, [-back[0] * ed.brush.size * 0.3, -back[1] * ed.brush.size * 0.3]);
        this.blendBuffer(r, cov, sel, (i) => {
          const p = i * 4;
          return [src[p], src[p + 1], src[p + 2], src[p + 3]];
        }, this.opt.strength);
        return;
      }
      case 'blur':
      case 'sharpen': {
        const px = this.surface.readRect(r);
        const work = px.slice();
        if (this.tool === 'blur') gaussianBlur(work, r.w, r.h, Math.max(0.6, ed.brush.size / 12), 'clamp');
        else unsharpMask(work, r.w, r.h, { radius: Math.max(0.8, ed.brush.size / 14), amount: 1.6 });
        this.blendBuffer(r, cov, sel, (i) => {
          const p = i * 4;
          return [work[p], work[p + 1], work[p + 2], px[p + 3]];
        }, this.opt.strength);
        return;
      }
      case 'dodge':
      case 'burn': {
        const px = this.surface.readRect(r);
        const amt = this.opt.exposure;
        const up = this.tool === 'dodge';
        this.blendBuffer(r, cov, sel, (i) => {
          const p = i * 4;
          const o = [0, 0, 0, px[p + 3]];
          for (let c = 0; c < 3; c++) {
            const v = px[p + c];
            o[c] = clamp01(up ? v + (1 - v) * amt : v * (1 - amt));
          }
          return o;
        });
        return;
      }
      default:
        applyStroke(layer, this.stroke, r, { color: ed.fg, opacity: op, selection: sel });
    }
  }

  /** Composite a per-pixel colour source through the stroke coverage. */
  blendBuffer(r, cov, sel, colourAt, strength = 1) {
    const dst = this.surface.readRect(r);
    const s = sel ? sel.readRect(r) : null;
    const op = this.ed.brush.opacity * strength;
    for (let i = 0; i < r.w * r.h; i++) {
      let a = cov[i] * op;
      if (s) a *= s[i];
      if (a <= 0) continue;
      const c = colourAt(i, dst);
      const p = i * 4;
      const ab = dst[p + 3];
      const as = a * (c[3] === undefined ? 1 : c[3]);
      const ao = as + ab * (1 - as);
      if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) dst[p + k] = (c[k] * as + dst[p + k] * ab * (1 - as)) / ao;
      dst[p + 3] = ao;
    }
    this.surface.writeRect(r, dst);
  }

  /** Read pixels from an offset position, for clone and smudge. */
  sampleSource(r, offset) {
    const from = rect(Math.round(r.x + offset[0]), Math.round(r.y + offset[1]), r.w, r.h);
    if (this.opt.sampleAll) {
      return compositeDoc(this.ed.doc, from, { applyAdjust });
    }
    // The BACKUP, not the live surface: cloning from pixels this same stroke
    // has already painted smears the clone along the stroke instead of
    // copying the original.
    const merged = this.surface.readRect(from);
    const span = this.surface.tileSpan(from);
    if (span) {
      for (let ty = span.y0; ty <= span.y1; ty++) {
        for (let tx = span.x0; tx <= span.x1; tx++) {
          const idx = this.surface.tileIndex(tx, ty);
          if (!this.backedUp.has(idx)) continue;
          const b = this.backup.tiles.get(idx);
          const ox = tx * 256, oy = ty * 256;
          for (let y = 0; y < from.h; y++) {
            const sy = from.y + y;
            if (sy < oy || sy >= oy + 256) continue;
            for (let x = 0; x < from.w; x++) {
              const sx = from.x + x;
              if (sx < ox || sx >= ox + 256) continue;
              const d = (y * from.w + x) * 4;
              if (!b) { merged[d] = merged[d + 1] = merged[d + 2] = merged[d + 3] = 0; continue; }
              const sp = ((sy - oy) * 256 + (sx - ox)) * this.surface.channels;
              const inv = 1 / this.surface.max;
              for (let c = 0; c < 4; c++) merged[d + c] = b[sp + c] * inv;
            }
          }
        }
      }
    }
    return merged;
  }

  strokeDirection() {
    const a = this.stroke.last;
    if (!a || !this.prevLast) { this.prevLast = a ? { ...a } : null; return [1, 0]; }
    const dx = a.x - this.prevLast.x, dy = a.y - this.prevLast.y;
    this.prevLast = { ...a };
    const n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  }

  endPaint() {
    this.ed.history.commit();
    this.ed.emit('history');
    this.ed.emit('layers');
    if (this.tool === 'clone' && !this.opt.cloneAligned) {
      // Non-aligned: the source snaps back for the next stroke.
      this.ed.cloneSource = this.ed.cloneSource;
    }
    this.session = null;
  }

  // ------------------------------------------------------------- selection

  previewSelect(x, y) {
    const [sx, sy] = this.startDoc;
    this.view.drawPreview((g) => {
      g.beginPath();
      if (this.tool === 'marquee') {
        g.rect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy));
      } else if (this.tool === 'ellipse') {
        g.ellipse((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 0, 0, Math.PI * 2);
      } else {
        g.moveTo(this.points[0][0], this.points[0][1]);
        for (const p of this.points) g.lineTo(p[0], p[1]);
      }
      g.stroke();
    });
  }

  commitSelect(x, y) {
    const ed = this.ed;
    const [sx, sy] = this.startDoc;
    const mode = this.shift ? 'add' : (this.alt ? 'subtract' : this.opt.selectMode);
    let out = null;
    if (this.tool === 'marquee') {
      if (Math.abs(x - sx) < 0.5 || Math.abs(y - sy) < 0.5) { ed.deselect(); this.view.clearPreview(); return; }
      out = rectCoverage(null, sx, sy, x, y, { antialias: this.opt.antialias });
    } else if (this.tool === 'ellipse') {
      if (Math.abs(x - sx) < 0.5 || Math.abs(y - sy) < 0.5) { ed.deselect(); this.view.clearPreview(); return; }
      out = ellipseCoverage(null, sx, sy, x, y, { antialias: this.opt.antialias });
    } else {
      if (this.points.length < 3) { ed.deselect(); this.view.clearPreview(); return; }
      out = polygonCoverage(this.points, { antialias: this.opt.antialias });
    }
    this.commitCoverage(out, mode);
  }

  commitCoverage(out, mode) {
    const ed = this.ed;
    ed.history.begin('Selection', ed.doc);
    const sel = ed.ensureSelection();
    ed.history.touch(sel, ed.doc.bounds);
    applyCoverage(sel, out.r, out.cov, mode);
    if (this.opt.feather > 0) featherSelection(sel, this.opt.feather);
    ed.history.commit();
    ed.antsVersion++;
    ed.emit('selection');
    ed.emit('history');
    this.view.drawAnts();
  }

  wand(x, y) {
    const ed = this.ed;
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= ed.doc.w || iy >= ed.doc.h) { this.active = false; return; }
    const r = ed.doc.bounds;
    const src = this.opt.sampleAll
      ? compositeDoc(ed.doc, r, { applyAdjust })
      : (ed.active && ed.active.surface ? ed.active.surface.readRect(r) : compositeDoc(ed.doc, r, { applyAdjust }));
    // deltaE2000 per pixel over a large image is slow; above 2 megapixels the
    // fast RGB metric is used and the UI says so, rather than freezing.
    const fast = ed.doc.w * ed.doc.h > 2_000_000;
    const out = magicWand(src, r.w, r.h, ix, iy, {
      tolerance: this.opt.tolerance,
      contiguous: this.opt.contiguous,
      antialias: this.opt.antialias,
      fast,
    });
    this.commitCoverage(out, this.shift ? 'add' : (this.alt ? 'subtract' : this.opt.selectMode));
    if (fast) hint('Large image: the wand used a fast colour metric');
    this.active = false;
  }

  // ------------------------------------------------------------------ move

  startMove() {
    const ed = this.ed;
    const layer = ed.active;
    if (!layer || !layer.surface) { this.active = false; return; }
    if (layer.locked) { toast(`${layer.name} is locked`, { bad: true }); this.active = false; return; }
    this.mode = 'move';
    this.moveSnapshot = layer.surface.clone();
    this.moveLayer = layer;
    ed.history.begin('Move', null);
    ed.history.touch(layer.surface, ed.doc.bounds);
  }

  moveTo(x, y) {
    const dx = Math.round(x - this.startDoc[0]);
    const dy = Math.round(y - this.startDoc[1]);
    if (this.lastDelta && this.lastDelta[0] === dx && this.lastDelta[1] === dy) return;
    this.lastDelta = [dx, dy];
    const ed = this.ed;
    const r = ed.doc.bounds;
    const src = this.moveSnapshot.readRect(rect(r.x - dx, r.y - dy, r.w, r.h));
    this.moveLayer.surface.tiles.clear();
    this.moveLayer.surface.writeRect(r, src);
    ed.invalidate();
  }

  endMove() {
    this.ed.history.commit();
    this.ed.emit('history');
    this.moveSnapshot = null;
    this.lastDelta = null;
  }

  // -------------------------------------------------------------- gradient

  previewShape(x, y) {
    const [sx, sy] = this.startDoc;
    this.view.drawPreview((g, px) => {
      g.beginPath();
      if (this.mode === 'gradient') {
        g.moveTo(sx, sy); g.lineTo(x, y);
        g.stroke();
        g.setLineDash([]);
        g.beginPath();
        g.arc(sx, sy, 3 * px, 0, Math.PI * 2);
        g.arc(x, y, 3 * px, 0, Math.PI * 2);
        g.stroke();
        return;
      }
      if (this.mode === 'shape' && this.opt.shapeKind === 'ellipse') {
        g.ellipse((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 0, 0, Math.PI * 2);
      } else {
        g.rect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy));
      }
      g.stroke();
    });
  }

  commitGradient(x, y) {
    const ed = this.ed;
    const layer = ed.active;
    const surface = ed.target;
    if (!surface || layer.locked) { this.view.clearPreview(); return; }
    const [sx, sy] = this.startDoc;
    if (Math.hypot(x - sx, y - sy) < 1) { this.view.clearPreview(); return; }
    const r = ed.doc.bounds;
    let stops = twoStop(ed.fg, ed.bg);
    let alphaStops = null;
    if (this.opt.gradientKind === 'fg-transparent') {
      const g = fgToTransparent(ed.fg);
      stops = g.stops; alphaStops = g.alphaStops;
    } else if (this.opt.gradientKind === 'black-white') {
      stops = twoStop([0, 0, 0], [1, 1, 1]);
    }
    const grad = renderGradient(r, stops, {
      shape: this.opt.gradientShape, x0: sx, y0: sy, x1: x, y1: y,
      reverse: this.opt.gradientReverse, dither: this.opt.gradientDither, alphaStops,
    });
    ed.editTarget('Gradient', r, () => {
      const dst = surface.readRect(r);
      const sel = ed.selection ? ed.selection.readRect(r) : null;
      const chans = surface.channels;
      for (let i = 0; i < r.w * r.h; i++) {
        let a = grad[i * 4 + 3];
        if (sel) a *= sel[i];
        if (a <= 0) continue;
        if (chans === 1) { dst[i] = lerp(dst[i], luma709(grad[i * 4], grad[i * 4 + 1], grad[i * 4 + 2]), a); continue; }
        const p = i * 4;
        const ab = dst[p + 3];
        const ao = a + ab * (1 - a);
        if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }
        for (let c = 0; c < 3; c++) dst[p + c] = (grad[p + c] * a + dst[p + c] * ab * (1 - a)) / ao;
        dst[p + 3] = ao;
      }
      surface.writeRect(r, dst);
    });
    this.view.clearPreview();
  }

  bucket(x, y) {
    const ed = this.ed;
    const surface = ed.target;
    if (!surface || ed.active.locked) { this.active = false; return; }
    const ix = Math.floor(x), iy = Math.floor(y);
    const r = ed.doc.bounds;
    ed.editTarget('Paint Bucket', r, () => {
      const px = surface.readRect(r);
      if (surface.channels === 1) {
        // On a mask, the bucket fills coverage.
        const v = luma709(ed.fg[0], ed.fg[1], ed.fg[2]);
        const rgba = new Float32Array(r.w * r.h * 4);
        for (let i = 0; i < px.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]; rgba[i * 4 + 3] = 1; }
        const { cov } = bucketFill(rgba, r.w, r.h, ix, iy, [v, v, v], { tolerance: this.opt.tolerance, contiguous: this.opt.contiguous });
        for (let i = 0; i < px.length; i++) px[i] = lerp(px[i], v, cov[i]);
      } else {
        bucketFill(px, r.w, r.h, ix, iy, ed.fg, {
          tolerance: this.opt.tolerance, contiguous: this.opt.contiguous,
          antialias: this.opt.antialias, opacity: ed.brush.opacity,
        });
      }
      surface.writeRect(r, px);
    });
    this.active = false;
  }

  commitShape(x, y) {
    const ed = this.ed;
    const surface = ed.target;
    if (!surface || ed.active.locked) { this.view.clearPreview(); return; }
    const [sx, sy] = this.startDoc;
    if (Math.abs(x - sx) < 1 || Math.abs(y - sy) < 1) { this.view.clearPreview(); return; }
    const out = this.opt.shapeKind === 'ellipse'
      ? ellipseCoverage(null, sx, sy, x, y, { antialias: this.opt.antialias })
      : rectCoverage(null, sx, sy, x, y, { antialias: this.opt.antialias });
    const r = rectIntersect(out.r, ed.doc.bounds);
    if (rectEmpty(r)) { this.view.clearPreview(); return; }
    ed.editTarget('Shape', r, () => {
      const dst = surface.readRect(r);
      const sel = ed.selection ? ed.selection.readRect(r) : null;
      for (let y2 = 0; y2 < r.h; y2++) {
        for (let x2 = 0; x2 < r.w; x2++) {
          const si = (r.y + y2 - out.r.y) * out.r.w + (r.x + x2 - out.r.x);
          let a = out.cov[si];
          const i = y2 * r.w + x2;
          if (sel) a *= sel[i];
          if (a <= 0) continue;
          if (surface.channels === 1) { dst[i] = lerp(dst[i], luma709(ed.fg[0], ed.fg[1], ed.fg[2]), a); continue; }
          const p = i * 4;
          const ab = dst[p + 3];
          const ao = a + ab * (1 - a);
          for (let c = 0; c < 3; c++) dst[p + c] = (ed.fg[c] * a + dst[p + c] * ab * (1 - a)) / ao;
          dst[p + 3] = ao;
        }
      }
      surface.writeRect(r, dst);
    });
    this.view.clearPreview();
  }

  commitCrop(x, y) {
    const ed = this.ed;
    const [sx, sy] = this.startDoc;
    const x0 = Math.round(Math.min(sx, x)), y0 = Math.round(Math.min(sy, y));
    const x1 = Math.round(Math.max(sx, x)), y1 = Math.round(Math.max(sy, y));
    this.view.clearPreview();
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    if (this.onCrop) this.onCrop(rect(x0, y0, x1 - x0, y1 - y0));
  }

  commitZoom(e, x, y) {
    this.view.clearPreview();
    if (!this.moved) {
      this.view.zoomStep(this.alt ? -1 : 1, [e.clientX, e.clientY]);
      return;
    }
    // A dragged box zooms to fit it.
    const [sx, sy] = this.startDoc;
    const w = Math.abs(x - sx), h = Math.abs(y - sy);
    if (w < 4 || h < 4) return;
    const sr = this.view.stage.getBoundingClientRect();
    const z = Math.min(sr.width / w, sr.height / h);
    this.ed.pan = [0, 0];
    this.view.setZoom(z);
    const cx = (sx + x) / 2, cy = (sy + y) / 2;
    this.ed.pan = [
      (this.ed.doc.w / 2 - cx) * this.ed.zoom,
      (this.ed.doc.h / 2 - cy) * this.ed.zoom,
    ];
    this.view.layout();
  }

  pick(x, y) {
    const ed = this.ed;
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= ed.doc.w || iy >= ed.doc.h) { this.active = false; return; }
    const px = compositeDoc(ed.doc, rect(ix, iy, 1, 1), { applyAdjust });
    const c = [px[0], px[1], px[2]];
    if (this.alt) ed.setBg(c); else ed.setFg(c);
    hint(`Picked ${toHex(c)}`);
    this.active = false;
  }

  placeText(x, y) {
    this.active = false;
    if (this.onText) this.onText(x, y);
  }
}

function pressureOf(e) {
  // A mouse reports 0.5 while down and 0 otherwise; a pen reports the real
  // thing. Treating the mouse's 0.5 as "half pressure" makes every
  // mouse-drawn stroke thin, so it is normalised to full.
  if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
  return 1;
}

function tiltOf(e) {
  if (e.pointerType !== 'pen') return 0;
  const t = Math.max(Math.abs(e.tiltX || 0), Math.abs(e.tiltY || 0));
  return clamp01(t / 90);
}
