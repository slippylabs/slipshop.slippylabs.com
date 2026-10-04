// The menu bar, and the dialogs it opens.
//
// Every parameter dialog is GENERATED from the field table on the adjustment
// or filter itself (adjust.js and filters.js both carry one). That is the
// payoff of putting the table next to the maths: 19 adjustments and 31
// filters get a working dialog with live preview, correct ranges and correct
// defaults without fifty hand-written forms, and a parameter cannot exist in
// the dialog but not in the function.

import { el, panel, row, btn, slider, number, select, checkbox, text, toast, hint, setChildren, modal, download } from './ui.js';
import { ADJUSTMENTS, ADJUST_KINDS, applyAdjust, adjustDefaults, parseCube } from '../core/adjust.js';
import { FILTERS, FILTER_GROUPS, applyFilter, filterDefaults, radiusOf } from '../core/filters.js';
import { Layer, newDoc } from '../core/doc.js';
import { Surface } from '../core/tiles.js';
import { compositeDoc } from '../core/composite.js';
import { resize, orient, FILTERS as RESAMPLE_FILTERS } from '../core/resample.js';
import {
  selectAll, invertSelection, newSelection, featherSelection, expandSelection,
  contractSelection, borderSelection, smoothSelection, colorRange, applyCoverage, selectionBounds,
} from '../core/select.js';
import { monotoneSpline, IDENTITY_CURVE } from '../core/curve.js';
import { rect, rectEmpty, clamp, clamp01, luma709 } from '../core/util.js';
import { toHex, parseHex } from '../core/color.js';
import * as io from './io.js';
import { prettyMode } from './panels.js';

export function buildMenus(ed, view, opt, ctx) {
  const C = commands(ed, view, opt, ctx);
  return [
    ['File', () => [
      { label: 'New…', key: 'Ctrl+N', run: C.newDoc },
      { label: 'Open…', key: 'Ctrl+O', run: C.open },
      { label: 'Place as layer…', run: () => C.open(true) },
      { sep: true },
      { label: 'Save project', key: 'Ctrl+S', run: C.saveProject },
      { label: 'Export PNG', key: 'Ctrl+E', run: () => C.exportAs('image/png') },
      { label: 'Export JPEG…', run: () => C.exportDialog('image/jpeg') },
      { label: 'Export WebP…', run: () => C.exportDialog('image/webp') },
      { sep: true },
      { label: 'Restore autosave', run: C.restoreAutosave },
    ]],
    ['Edit', () => [
      { label: 'Undo', key: 'Ctrl+Z', run: () => ed.undo(), disabled: !ed.history.canUndo },
      { label: 'Redo', key: 'Ctrl+Shift+Z', run: () => ed.redo(), disabled: !ed.history.canRedo },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', run: () => C.copy(true) },
      { label: 'Copy', key: 'Ctrl+C', run: () => C.copy(false) },
      { label: 'Paste', key: 'Ctrl+V', run: C.paste },
      { sep: true },
      { label: 'Fill with foreground', key: 'Alt+Backspace', run: () => C.fill(ed.fg) },
      { label: 'Fill with background', key: 'Ctrl+Backspace', run: () => C.fill(ed.bg) },
      { label: 'Clear', key: 'Delete', run: C.clear },
      { label: 'Stroke selection…', run: C.strokeSelection },
    ]],
    ['Image', () => [
      { label: 'Image size…', key: 'Ctrl+Alt+I', run: C.imageSize },
      { label: 'Canvas size…', key: 'Ctrl+Alt+C', run: C.canvasSize },
      { label: 'Crop to selection', run: C.cropToSelection, disabled: !ed.selection },
      { label: 'Trim transparent', run: C.trim },
      { sep: true },
      { label: 'Rotate 90° clockwise', run: () => C.orient('rot90') },
      { label: 'Rotate 90° anticlockwise', run: () => C.orient('rot270') },
      { label: 'Rotate 180°', run: () => C.orient('rot180') },
      { label: 'Flip horizontal', run: () => C.orient('flipH') },
      { label: 'Flip vertical', run: () => C.orient('flipV') },
      { sep: true },
      { head: 'Adjustments (destructive)' },
      ...ADJUST_KINDS.map((k) => ({ label: ADJUSTMENTS[k].label, run: () => C.adjustDialog(k, false) })),
    ]],
    ['Layer', () => [
      { label: 'New layer', key: 'Ctrl+Shift+N', run: () => ed.addLayer() },
      { label: 'Duplicate layer', key: 'Ctrl+J', run: () => ed.duplicateLayer() },
      { label: 'Delete layer', run: () => ed.removeLayer() },
      { sep: true },
      { label: 'Group', key: 'Ctrl+G', run: () => ed.groupSelected() },
      { label: 'Merge down', key: 'Ctrl+E', run: () => ed.mergeDown() },
      { label: 'Flatten image', run: () => ed.flatten() },
      { sep: true },
      { label: ed.active && ed.active.mask ? 'Delete mask' : 'Add mask', run: () => (ed.active && ed.active.mask ? ed.removeMask() : ed.addMask(ed.activeId, { fromSelection: !!ed.selection })) },
      { label: 'Apply mask', run: () => ed.removeMask(ed.activeId, { apply: true }), disabled: !(ed.active && ed.active.mask) },
      { sep: true },
      { head: 'New adjustment layer' },
      ...ADJUST_KINDS.map((k) => ({ label: ADJUSTMENTS[k].label, run: () => C.adjustDialog(k, true) })),
      { sep: true },
      { label: 'New solid fill layer', run: C.fillLayer },
    ]],
    ['Select', () => [
      { label: 'All', key: 'Ctrl+A', run: C.selectAll },
      { label: 'Deselect', key: 'Ctrl+D', run: () => ed.deselect() },
      { label: 'Inverse', key: 'Ctrl+Shift+I', run: C.inverse, disabled: !ed.selection },
      { sep: true },
      { label: 'Colour range…', run: C.colourRange },
      { sep: true },
      { head: 'Modify' },
      { label: 'Expand…', run: () => C.modify('expand'), disabled: !ed.selection },
      { label: 'Contract…', run: () => C.modify('contract'), disabled: !ed.selection },
      { label: 'Feather…', run: () => C.modify('feather'), disabled: !ed.selection },
      { label: 'Border…', run: () => C.modify('border'), disabled: !ed.selection },
      { label: 'Smooth…', run: () => C.modify('smooth'), disabled: !ed.selection },
      { sep: true },
      { label: 'Selection from layer mask', run: C.selFromMask, disabled: !(ed.active && ed.active.mask) },
      { label: 'Selection from layer alpha', run: C.selFromAlpha },
    ]],
    ['Filter', () => FILTER_GROUPS.flatMap(([group, kinds]) => [
      { head: group },
      ...kinds.map((k) => ({ label: FILTERS[k].label, run: () => C.filterDialog(k) })),
    ])],
    ['View', () => [
      { label: 'Zoom in', key: 'Ctrl++', run: () => view.zoomStep(1) },
      { label: 'Zoom out', key: 'Ctrl+-', run: () => view.zoomStep(-1) },
      { label: 'Fit on screen', key: 'Ctrl+0', run: () => view.fit() },
      { label: 'Actual pixels', key: 'Ctrl+1', run: () => view.actualPixels() },
      { sep: true },
      { label: 'Keyboard shortcuts…', run: C.shortcuts },
      { label: 'About SlipShop…', run: C.about },
    ]],
  ];
}

// ---------------------------------------------------------------- commands

export function commands(ed, view, opt, ctx) {
  /** The surface an edit applies to, with a readable complaint if there is none. */
  const target = () => {
    const s = ed.target;
    if (!s) { toast('There is no pixel layer to edit', { bad: true }); return null; }
    if (ed.active && ed.active.locked) { toast(`${ed.active.name} is locked`, { bad: true }); return null; }
    return s;
  };

  /** Build a form from a field table, writing into `params`. */
  function fieldsForm(fields, params, onChange) {
    const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), params);
    const set = (path, v) => {
      const parts = path.split('.');
      let o = params;
      for (let i = 0; i < parts.length - 1; i++) {
        if (o[parts[i]] === undefined || o[parts[i]] === null) o[parts[i]] = {};
        o = o[parts[i]];
      }
      o[parts[parts.length - 1]] = v;
      onChange();
    };
    return fields.map(([label, path, kind, a, b, c]) => {
      if (kind === 'num') {
        return row(label, slider({
          get: () => Number(get(path)) || 0, min: a, max: b, step: c,
          onInput: (v) => set(path, v), onCommit: (v) => set(path, v),
        }));
      }
      if (kind === 'bool') return row('', checkbox({ get: () => !!get(path), label, onCommit: (v) => set(path, v) }));
      if (kind === 'sel') return row(label, select({ get: () => String(get(path)), options: a, onCommit: (v) => set(path, v) }));
      if (kind === 'col') {
        return row(label, el('input', {
          type: 'color', value: toHex(get(path) || [0, 0, 0]),
          oninput: (e) => set(path, parseHex(e.target.value).slice(0, 3)),
        }));
      }
      if (kind === 'curve') return curveEditor(() => get(path), (v) => set(path, v));
      return null;
    });
  }

  /**
   * The curve editor. Drag a point, click an empty spot to add one,
   * alt-click or right-click to remove. Reused from the same interaction
   * SlipStudio's profile editor uses, which is the only 2D point editor on
   * the estate that has been driven by a real test.
   */
  function curveEditor(getPts, setPts) {
    const cv = el('canvas', { class: 'sp-graph', width: 260, height: 260 });
    const g = cv.getContext('2d');
    let drag = -1;
    const toCv = (p) => [p[0] * cv.width, (1 - p[1]) * cv.height];
    const fromCv = (x, y) => [clamp01(x / cv.width), clamp01(1 - y / cv.height)];
    const draw = () => {
      const pts = getPts() || IDENTITY_CURVE;
      g.clearRect(0, 0, cv.width, cv.height);
      g.strokeStyle = 'rgba(57,255,143,0.16)';
      g.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo((i / 4) * cv.width, 0); g.lineTo((i / 4) * cv.width, cv.height);
        g.moveTo(0, (i / 4) * cv.height); g.lineTo(cv.width, (i / 4) * cv.height);
        g.stroke();
      }
      g.strokeStyle = 'rgba(217,251,232,0.25)';
      g.beginPath(); g.moveTo(0, cv.height); g.lineTo(cv.width, 0); g.stroke();
      const f = monotoneSpline(pts);
      g.strokeStyle = '#39ff8f';
      g.lineWidth = 1.6;
      g.beginPath();
      for (let x = 0; x <= cv.width; x++) {
        const y = (1 - f(x / cv.width)) * cv.height;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#d9fbe8';
      for (const p of pts) {
        const [cx, cy] = toCv(p);
        g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
      }
    };
    const hitAt = (x, y) => {
      const pts = getPts() || IDENTITY_CURVE;
      for (let i = 0; i < pts.length; i++) {
        const [cx, cy] = toCv(pts[i]);
        if (Math.hypot(cx - x, cy - y) < 9) return i;
      }
      return -1;
    };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * cv.width;
      const y = ((e.clientY - r.top) / r.height) * cv.height;
      const pts = [...(getPts() || IDENTITY_CURVE)].map((p) => [...p]);
      const hit = hitAt(x, y);
      if ((e.altKey || e.button === 2) && hit >= 0 && pts.length > 2) {
        pts.splice(hit, 1);
        setPts(pts); draw();
        return;
      }
      if (hit >= 0) { drag = hit; cv.setPointerCapture(e.pointerId); return; }
      pts.push(fromCv(x, y));
      pts.sort((a, b) => a[0] - b[0]);
      setPts(pts);
      drag = pts.findIndex((p) => Math.abs(p[0] - fromCv(x, y)[0]) < 1e-9);
      cv.setPointerCapture(e.pointerId);
      draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0 || !cv.hasPointerCapture(e.pointerId)) return;
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * cv.width;
      const y = ((e.clientY - r.top) / r.height) * cv.height;
      const pts = [...(getPts() || IDENTITY_CURVE)].map((p) => [...p]);
      pts[drag] = fromCv(x, y);
      pts.sort((a, b) => a[0] - b[0]);
      setPts(pts);
      draw();
    });
    cv.addEventListener('pointerup', () => { drag = -1; });
    draw();
    return el('div', { class: 'sp-row wide' }, cv,
      el('p', { class: 'sp-note', text: 'Drag to shape. Click to add a point, alt-click to remove one.' }));
  }

  /**
   * Run a pixel operation over the active layer with a LIVE PREVIEW.
   *
   * The preview writes real pixels and the dialog's Cancel restores them from
   * a backup, which is why the backup is taken once up front: re-reading the
   * layer after a preview would back up the previewed state and Cancel would
   * do nothing.
   */
  async function livePixelDialog(title, fields, params, run, { note } = {}) {
    // A filter or a destructive adjustment writes pixels, so a text layer has
    // to become an ordinary one first -- the same rule the brush follows.
    if (ed.rasterizeForPaint()) toast(`${ed.lastRasterised} rasterised`);
    const surface = target();
    if (!surface) return false;
    const r = ed.selection ? (rectEmpty(selectionBounds(ed.selection)) ? ed.doc.bounds : selectionBounds(ed.selection)) : ed.doc.bounds;
    const backup = surface.clone();
    let scheduled = false;

    const preview = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        // restore, then apply from the ORIGINAL pixels
        surface.tiles.clear();
        for (const [k, t] of backup.tiles) surface.tiles.set(k, t.slice());
        run(surface, r, params);
        ed.invalidate();
      });
    };

    const body = el('div', {}, note ? el('p', { class: 'sp-note', text: note }) : null, ...fieldsForm(fields, params, preview));
    preview();
    const ok = await modal(title, body, {
      onCancel: () => {
        surface.tiles.clear();
        for (const [k, t] of backup.tiles) surface.tiles.set(k, t.slice());
        ed.invalidate();
      },
    });
    if (!ok) return false;

    // Commit. The ORDER here is the whole thing, and getting it wrong is
    // silent: history.touch() records whatever is live at the moment it runs,
    // and after a live preview what is live is the ADJUSTED image. Touching
    // first stored the adjusted tiles as the "before", so undo restored the
    // adjustment instead of removing it -- and every later test that assumed
    // a clean base then failed for a reason that had nothing to do with it.
    //
    // So: keep the result, put the originals back, record THOSE, commit, and
    // only then write the result in.
    const after = surface.clone();
    surface.tiles.clear();
    for (const [k, t] of backup.tiles) surface.tiles.set(k, t.slice());
    ed.history.begin(title, null);
    ed.history.touch(surface, r);          // the original is live right now
    ed.history.commit();
    surface.tiles.clear();
    for (const [k, t] of after.tiles) surface.tiles.set(k, t.slice());
    ed.invalidate();
    ed.emit('history');
    ed.emit('layers');
    return true;
  }

  const C = {
    // ------------------------------------------------------------- file
    async newDoc() {
      const p = { w: 1200, h: 800, bg: 'white' };
      const body = el('div', {},
        row('Width', number({ get: () => p.w, min: 1, max: 16384, step: 1, onCommit: (v) => { p.w = Math.round(v); } })),
        row('Height', number({ get: () => p.h, min: 1, max: 16384, step: 1, onCommit: (v) => { p.h = Math.round(v); } })),
        row('Background', select({ get: () => p.bg, options: [['white', 'White'], ['transparent', 'Transparent'], ['fg', 'Foreground colour']], onCommit: (v) => { p.bg = v; } })),
        el('p', { class: 'sp-note', text: 'Nothing is uploaded. The document lives in this tab and in your browser’s local storage only.' }));
      if (!await modal('New document', body)) return;
      const bg = p.bg === 'transparent' ? [0, 0, 0, 0] : (p.bg === 'fg' ? [...ed.fg, 1] : [1, 1, 1, 1]);
      ed.newDocument(Math.round(p.w), Math.round(p.h), { background: bg });
      ctx.afterDocChange();
    },

    open(asLayer = false) {
      const input = document.getElementById('file-open');
      input.onchange = async () => {
        const files = [...input.files];
        input.value = '';
        if (!files.length) return;
        try {
          for (const f of files) {
            if (/\.slipshop$/i.test(f.name)) {
              const buf = new Uint8Array(await f.arrayBuffer());
              ed.setDocument(io.loadProject(buf));
              ctx.afterDocChange();
              toast(`Opened ${f.name}`);
              continue;
            }
            if (asLayer || files.length > 1 && f !== files[0]) {
              const l = await io.layerFromImage(ed.doc, f);
              ed.history.begin('Place image', ed.doc);
              ed.doc.layers.push(l);
              ed.history.commit();
              ed.activeId = l.id;
              ed.invalidate();
              ed.emit('layers');
            } else {
              ed.setDocument(await io.docFromImage(f));
              ctx.afterDocChange();
            }
          }
          toast('Opened');
        } catch (e) {
          toast(e.message, { bad: true });
        }
      };
      input.click();
    },

    saveProject() {
      try {
        const n = io.downloadProject(ed.doc);
        toast(`Saved ${(n / 1048576).toFixed(1)} MB`);
      } catch (e) { toast(e.message, { bad: true }); }
    },

    async exportAs(format, quality) {
      try {
        await io.exportImage(ed.doc, format, { quality, name: ed.doc.name || 'untitled' });
        toast('Exported');
      } catch (e) { toast(e.message, { bad: true }); }
    },

    async exportDialog(format) {
      const f = io.EXPORT_FORMATS.find((x) => x.id === format);
      const p = { quality: 0.92 };
      const body = el('div', {},
        row('Quality', slider({ get: () => p.quality, min: 0.1, max: 1, step: 0.01, onCommit: (v) => { p.quality = v; } })),
        f.alpha ? null : el('p', { class: 'sp-note', text: 'JPEG has no transparency, so the image is flattened onto white.' }));
      if (!await modal(`Export ${f.label}`, body)) return;
      C.exportAs(format, p.quality);
    },

    async restoreAutosave() {
      const rec = await io.loadAutosave();
      if (!rec) { toast('There is no autosave to restore', { bad: true }); return; }
      const when = new Date(rec.at).toLocaleString();
      const body = el('p', { class: 'sp-note', text: `Replace the current document with the autosave from ${when}? Anything not saved will be lost.` });
      if (!await modal('Restore autosave', body, { okLabel: 'Restore' })) return;
      try {
        ed.setDocument(io.loadProject(rec.bytes));
        ctx.afterDocChange();
        toast('Autosave restored');
      } catch (e) { toast(e.message, { bad: true }); }
    },

    // ------------------------------------------------------------- edit
    fill(colour) {
      const surface = target();
      if (!surface) return;
      const sel = ed.selection;
      const r = ed.doc.bounds;
      ed.editTarget('Fill', r, () => {
        const dst = surface.readRect(r);
        const s = sel ? sel.readRect(r) : null;
        const v = surface.channels === 1 ? luma709(colour[0], colour[1], colour[2]) : 0;
        for (let i = 0; i < r.w * r.h; i++) {
          const a = s ? s[i] : 1;
          if (a <= 0) continue;
          if (surface.channels === 1) { dst[i] = dst[i] + (v - dst[i]) * a; continue; }
          const p = i * 4;
          const ab = dst[p + 3];
          const ao = a + ab * (1 - a);
          for (let c = 0; c < 3; c++) dst[p + c] = (colour[c] * a + dst[p + c] * ab * (1 - a)) / ao;
          dst[p + 3] = ao;
        }
        surface.writeRect(r, dst);
      });
    },

    clear() {
      const surface = target();
      if (!surface) return;
      const sel = ed.selection;
      const r = ed.doc.bounds;
      ed.editTarget('Clear', r, () => {
        if (!sel) { surface.tiles.clear(); return; }
        const dst = surface.readRect(r);
        const s = sel.readRect(r);
        for (let i = 0; i < r.w * r.h; i++) {
          if (s[i] <= 0) continue;
          if (surface.channels === 1) { dst[i] *= 1 - s[i]; continue; }
          dst[i * 4 + 3] *= 1 - s[i];
        }
        surface.writeRect(r, dst);
        surface.trim();
      });
    },

    async copy(cut) {
      const r = ed.selection ? selectionBounds(ed.selection) : ed.doc.bounds;
      if (rectEmpty(r)) { toast('Nothing selected', { bad: true }); return; }
      const sub = { w: r.w, h: r.h };
      const px = compositeDoc(ed.doc, r, { applyAdjust });
      if (ed.selection) {
        const s = ed.selection.readRect(r);
        for (let i = 0; i < r.w * r.h; i++) px[i * 4 + 3] *= s[i];
      }
      const cv = document.createElement('canvas');
      cv.width = r.w; cv.height = r.h;
      const g = cv.getContext('2d');
      const img = g.createImageData(r.w, r.h);
      for (let i = 0; i < px.length; i++) img.data[i] = px[i] * 255 + 0.5;
      g.putImageData(img, 0, 0);
      try {
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast(cut ? 'Cut to the clipboard' : 'Copied to the clipboard');
      } catch (e) {
        // Clipboard write needs a permission and a secure context; keep an
        // in-page fallback so Copy/Paste still works without it.
        ctx.internalClipboard = { w: r.w, h: r.h, data: px };
        toast(cut ? 'Cut' : 'Copied');
      }
      if (cut) C.clear();
    },

    async paste() {
      let image = null;
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) { image = await it.getType(type); break; }
        }
      } catch (e) { /* fall through to the internal clipboard */ }
      try {
        if (image) {
          const l = await io.layerFromImage(ed.doc, image);
          ed.history.begin('Paste', ed.doc);
          ed.doc.layers.push(l);
          ed.history.commit();
          ed.activeId = l.id;
        } else if (ctx.internalClipboard) {
          const c = ctx.internalClipboard;
          const l = new Layer({ type: 'raster', name: 'Pasted', surface: ed.doc.newSurface(4) });
          l.surface.writeRect(rect(Math.round((ed.doc.w - c.w) / 2), Math.round((ed.doc.h - c.h) / 2), c.w, c.h), c.data);
          ed.history.begin('Paste', ed.doc);
          ed.doc.layers.push(l);
          ed.history.commit();
          ed.activeId = l.id;
        } else {
          toast('There is no image on the clipboard', { bad: true });
          return;
        }
        ed.invalidate();
        ed.emit('layers');
        toast('Pasted as a new layer');
      } catch (e) { toast(e.message, { bad: true }); }
    },

    async strokeSelection() {
      if (!ed.selection) { toast('Nothing selected', { bad: true }); return; }
      const p = { width: 3, position: 'centre' };
      const body = el('div', {},
        row('Width', number({ get: () => p.width, min: 1, max: 100, step: 1, onCommit: (v) => { p.width = v; } })),
        row('Position', select({ get: () => p.position, options: [['centre', 'Centre'], ['inside', 'Inside'], ['outside', 'Outside']], onCommit: (v) => { p.position = v; } })));
      if (!await modal('Stroke selection', body)) return;
      const surface = target();
      if (!surface) return;
      const r = ed.doc.bounds;
      const ring = ed.selection.clone();
      if (p.position === 'inside') contractSelection(ring, p.width / 2);
      else if (p.position === 'outside') expandSelection(ring, p.width / 2);
      borderSelection(ring, p.width);
      ed.editTarget('Stroke', r, () => {
        const dst = surface.readRect(r);
        const s = ring.readRect(r);
        for (let i = 0; i < r.w * r.h; i++) {
          const a = s[i];
          if (a <= 0) continue;
          if (surface.channels === 1) { dst[i] = dst[i] + (1 - dst[i]) * a; continue; }
          const q = i * 4;
          const ab = dst[q + 3];
          const ao = a + ab * (1 - a);
          for (let c = 0; c < 3; c++) dst[q + c] = (ed.fg[c] * a + dst[q + c] * ab * (1 - a)) / ao;
          dst[q + 3] = ao;
        }
        surface.writeRect(r, dst);
      });
    },

    // ------------------------------------------------------------ image
    async imageSize() {
      const p = { w: ed.doc.w, h: ed.doc.h, filter: 'bicubic', link: true };
      const aspect = ed.doc.w / ed.doc.h;
      let wCtl, hCtl;
      wCtl = number({ get: () => p.w, min: 1, max: 16384, step: 1, onCommit: (v) => {
        p.w = Math.max(1, Math.round(v));
        if (p.link) { p.h = Math.max(1, Math.round(p.w / aspect)); hCtl.sync(); }
      } });
      hCtl = number({ get: () => p.h, min: 1, max: 16384, step: 1, onCommit: (v) => {
        p.h = Math.max(1, Math.round(v));
        if (p.link) { p.w = Math.max(1, Math.round(p.h * aspect)); wCtl.sync(); }
      } });
      const body = el('div', {},
        row('Width', wCtl), row('Height', hCtl),
        row('', checkbox({ get: () => p.link, label: 'Keep proportions', onCommit: (v) => { p.link = v; } })),
        row('Resample', select({ get: () => p.filter, options: RESAMPLE_FILTERS.map((f) => [f, prettyMode(f)]), onCommit: (v) => { p.filter = v; } })),
        el('p', { class: 'sp-note', text: 'Lanczos is sharpest for photographs; Nearest keeps hard pixel edges for pixel art.' }));
      if (!await modal('Image size', body)) return;
      if (p.w === ed.doc.w && p.h === ed.doc.h) return;
      ctx.resample(p.w, p.h, p.filter);
    },

    async canvasSize() {
      const p = { w: ed.doc.w, h: ed.doc.h, anchor: 'center' };
      const body = el('div', {},
        row('Width', number({ get: () => p.w, min: 1, max: 16384, step: 1, onCommit: (v) => { p.w = Math.round(v); } })),
        row('Height', number({ get: () => p.h, min: 1, max: 16384, step: 1, onCommit: (v) => { p.h = Math.round(v); } })),
        row('Anchor', select({
          get: () => p.anchor,
          options: [['center', 'Centre'], ['topleft', 'Top left'], ['topright', 'Top right'], ['bottomleft', 'Bottom left'], ['bottomright', 'Bottom right']],
          onCommit: (v) => { p.anchor = v; },
        })));
      if (!await modal('Canvas size', body)) return;
      ctx.resizeCanvas(p.w, p.h, p.anchor);
    },

    cropToSelection() {
      const r = ed.selection ? selectionBounds(ed.selection) : null;
      if (!r || rectEmpty(r)) { toast('Nothing selected', { bad: true }); return; }
      ctx.crop(r);
    },

    trim() {
      let box = rect(0, 0, 0, 0);
      for (const { layer } of ed.doc.walk()) {
        if (!layer.surface) continue;
        const b = layer.surface.contentBounds();
        if (!rectEmpty(b)) {
          box = rectEmpty(box) ? b : {
            x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
            w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
            h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y),
          };
        }
      }
      if (rectEmpty(box)) { toast('Everything is transparent', { bad: true }); return; }
      if (box.w === ed.doc.w && box.h === ed.doc.h) { toast('There is nothing to trim'); return; }
      ctx.crop(box);
    },

    orient(op) { ctx.orient(op); },

    async adjustDialog(kind, asLayer) {
      const a = ADJUSTMENTS[kind];
      const params = adjustDefaults(kind);

      // A .cube LUT needs a file before it can do anything.
      const extra = [];
      if (kind === 'colorLookup') {
        const picker = el('input', { type: 'file', accept: '.cube', class: 'sp-text' });
        picker.addEventListener('change', async () => {
          const f = picker.files[0];
          if (!f) return;
          try {
            const { lut, size } = parseCube(await f.text());
            params.lut = lut;
            params.size = size;
            toast(`Loaded a ${size}x${size}x${size} LUT`);
            if (asLayer) return;
          } catch (e) { toast(e.message, { bad: true }); }
        });
        extra.push(row('LUT file', picker, { wide: true }));
      }

      if (asLayer) {
        const body = el('div', {}, ...extra, ...fieldsForm(a.fields, params, () => {
          if (pending) { pending.adjust.params = params; ed.invalidate(); }
        }));
        let pending = null;
        ed.history.begin(`${a.label} layer`, ed.doc);
        const loc = ed.doc.locate(ed.activeId);
        const list = loc ? loc.list : ed.doc.layers;
        pending = new Layer({ type: 'adjustment', name: a.label, adjust: { kind, params } });
        list.splice(loc ? loc.index + 1 : list.length, 0, pending);
        ed.history.commit();
        ed.activeId = pending.id;
        ed.invalidate();
        ed.emit('layers');
        const ok = await modal(`${a.label} layer`, body);
        if (!ok) { ed.undo(); return; }
        ed.emit('layers');
        return;
      }

      await livePixelDialog(a.label, a.fields, params, (surface, r, pr) => {
        const px = surface.readRect(r);
        if (surface.channels === 1) {
          const rgba = new Float32Array(r.w * r.h * 4);
          for (let i = 0; i < px.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]; rgba[i * 4 + 3] = 1; }
          applyAdjust(kind, pr, rgba, r.w, r.h);
          for (let i = 0; i < px.length; i++) px[i] = rgba[i * 4];
        } else {
          applyAdjust(kind, pr, px, r.w, r.h);
        }
        maskBySelection(surface, r, px);
        surface.writeRect(r, px);
      }, { note: extra.length ? 'Load a .cube file, then adjust the amount.' : undefined });
    },

    async filterDialog(kind) {
      const f = FILTERS[kind];
      const params = filterDefaults(kind);
      if (f.usesColours) { params.fg = ed.fg; params.bg = ed.bg; }
      const note = radiusOf(kind, params) === null
        ? 'This filter reads the whole layer, so it applies to all of it and is masked by the selection afterwards.'
        : undefined;
      await livePixelDialog(f.label, f.fields, params, (surface, r, pr) => {
        // A spatial filter must read OUTSIDE the region it writes, or it
        // seams at the boundary. The region is grown by the filter's own
        // radius, filtered, and only the middle kept.
        const grow = radiusOf(kind, pr);
        const whole = surface.bounds;
        const work = grow === null ? whole : {
          x: Math.max(0, r.x - grow), y: Math.max(0, r.y - grow),
          w: Math.min(whole.w, r.x + r.w + grow) - Math.max(0, r.x - grow),
          h: Math.min(whole.h, r.y + r.h + grow) - Math.max(0, r.y - grow),
        };
        const isMask = surface.channels === 1;
        const raw = surface.readRect(work);
        let px = raw;
        if (isMask) {
          px = new Float32Array(work.w * work.h * 4);
          for (let i = 0; i < raw.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = raw[i]; px[i * 4 + 3] = 1; }
        }
        if (f.usesColours) { pr.fg = ed.fg; pr.bg = ed.bg; }
        // Where the region sits in the layer. Add Noise keys its randomness on
        // the absolute pixel coordinate, so without this the grain would shift
        // whenever the filtered rect changed -- a live preview would crawl.
        pr.originX = work.x;
        pr.originY = work.y;
        applyFilter(kind, pr, px, work.w, work.h);
        // keep only the requested region
        const out = isMask ? new Float32Array(r.w * r.h) : new Float32Array(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) {
          for (let x = 0; x < r.w; x++) {
            const si = ((r.y + y - work.y) * work.w + (r.x + x - work.x));
            const di = y * r.w + x;
            if (isMask) out[di] = px[si * 4];
            else for (let c = 0; c < 4; c++) out[di * 4 + c] = px[si * 4 + c];
          }
        }
        maskBySelection(surface, r, out);
        surface.writeRect(r, out);
      }, { note });
    },

    async fillLayer() {
      const colour = [...ed.fg];
      ed.history.begin('Fill layer', ed.doc);
      const l = new Layer({ type: 'fill', name: 'Fill', fill: { kind: 'solid', color: [...colour, 1] } });
      ed.doc.layers.push(l);
      ed.history.commit();
      ed.activeId = l.id;
      ed.invalidate();
      ed.emit('layers');
    },

    // ----------------------------------------------------------- select
    selectAll() {
      ed.history.begin('Select all', ed.doc);
      ed.doc.selection = selectAll(ed.doc);
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    inverse() {
      if (!ed.selection) return;
      ed.history.begin('Inverse', ed.doc);
      ed.history.touch(ed.selection, ed.doc.bounds);
      invertSelection(ed.selection);
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    async modify(which) {
      if (!ed.selection) return;
      const labels = { expand: 'Expand', contract: 'Contract', feather: 'Feather', border: 'Border', smooth: 'Smooth' };
      const p = { amount: which === 'feather' ? 4 : 2 };
      const body = el('div', {},
        row('Pixels', number({ get: () => p.amount, min: 0.5, max: 500, step: 0.5, onCommit: (v) => { p.amount = v; } })));
      if (!await modal(`${labels[which]} selection`, body)) return;
      ed.history.begin(labels[which], ed.doc);
      ed.history.touch(ed.selection, ed.doc.bounds);
      const s = ed.selection;
      if (which === 'expand') expandSelection(s, p.amount);
      else if (which === 'contract') contractSelection(s, p.amount);
      else if (which === 'feather') featherSelection(s, p.amount);
      else if (which === 'border') borderSelection(s, p.amount);
      else smoothSelection(s, p.amount);
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    async colourRange() {
      const p = { fuzziness: 24 };
      const body = el('div', {},
        row('Fuzziness', slider({ get: () => p.fuzziness, min: 1, max: 100, step: 1, onCommit: (v) => { p.fuzziness = v; } })),
        el('p', { class: 'sp-note', text: `Selects everything within range of the foreground colour (${toHex(ed.fg)}). Use the eyedropper first.` }));
      if (!await modal('Colour range', body)) return;
      const r = ed.doc.bounds;
      const px = compositeDoc(ed.doc, r, { applyAdjust });
      const fast = r.w * r.h > 2_000_000;
      const out = colorRange(px, r.w, r.h, ed.fg, { fuzziness: p.fuzziness, fast });
      ed.history.begin('Colour range', ed.doc);
      const sel = ed.ensureSelection();
      ed.history.touch(sel, r);
      applyCoverage(sel, out.r, out.cov, 'new');
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    selFromMask() {
      const l = ed.active;
      if (!l || !l.mask) return;
      ed.history.begin('Selection from mask', ed.doc);
      const sel = ed.ensureSelection();
      ed.history.touch(sel, ed.doc.bounds);
      const r = ed.doc.bounds;
      sel.writeRect(r, l.mask.readRect(r));
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    selFromAlpha() {
      const l = ed.active;
      if (!l || !l.surface) { toast('That layer has no pixels', { bad: true }); return; }
      ed.history.begin('Selection from alpha', ed.doc);
      const sel = ed.ensureSelection();
      ed.history.touch(sel, ed.doc.bounds);
      const r = ed.doc.bounds;
      const px = l.surface.readRect(r);
      const cov = new Float32Array(r.w * r.h);
      for (let i = 0; i < cov.length; i++) cov[i] = px[i * 4 + 3];
      sel.writeRect(r, cov);
      ed.history.commit();
      ed.antsVersion++;
      ed.emit('selection');
      view.drawAnts();
    },

    // ------------------------------------------------------------- view
    shortcuts() {
      const rows = [
        ['Tools', 'V move, M marquee, L lasso, W wand, C crop, I eyedropper, B brush, E eraser, S clone, G gradient, T text, U shape, Z zoom, H hand'],
        ['Brush', '[ and ] size, Shift+[ ] hardness, 0-9 opacity'],
        ['Colour', 'X swap foreground and background, D reset to black and white'],
        ['Edit', 'Ctrl+Z undo, Ctrl+Shift+Z redo, Ctrl+A select all, Ctrl+D deselect, Ctrl+Shift+I inverse'],
        ['Fill', 'Alt+Backspace foreground, Ctrl+Backspace background, Delete clear'],
        ['Layers', 'Ctrl+Shift+N new, Ctrl+J duplicate, Ctrl+G group, Ctrl+E merge down'],
        ['View', 'Ctrl+0 fit, Ctrl+1 actual pixels, Ctrl+plus / Ctrl+minus zoom, Space drag to pan, wheel to zoom'],
        ['File', 'Ctrl+N new, Ctrl+O open, Ctrl+S save project, Ctrl+E export PNG'],
      ];
      modal('Keyboard shortcuts', el('div', {}, rows.map(([k, v]) => row(k, el('span', { class: 'sp-note', text: v }), { wide: false }))), { okLabel: 'Close', cancelLabel: 'Close' });
    },

    about() {
      modal('About SlipShop', el('div', {},
        el('p', { class: 'sp-note', text: 'An image editor that runs entirely in your browser. Nothing is uploaded, there is no account, and there is no server doing the work -- every pixel is processed on your own machine.' }),
        el('p', { class: 'sp-note', text: 'Layers with 27 blend modes, masks and clipping, selections with real feathering, a pressure-sensitive brush engine, 19 adjustments (destructive or as non-destructive layers), 31 filters, and undo that stores only the tiles you actually painted.' }),
        el('p', { class: 'sp-note' }, 'Part of ', el('a', { href: 'https://projects.slippylabs.com/', style: { color: '#39ff8f' }, text: 'Slippy Labs' }), '.')),
      { okLabel: 'Close', cancelLabel: 'Close' });
    },
  };

  /** Where there is a selection, blend the result back by its coverage. */
  function maskBySelection(surface, r, out) {
    const sel = ed.selection;
    if (!sel) return out;
    const s = sel.readRect(r);
    const before = surface.readRect(r);
    const chans = surface.channels;
    for (let i = 0; i < r.w * r.h; i++) {
      const a = s[i];
      if (a >= 1) continue;
      if (chans === 1) { out[i] = before[i] + (out[i] - before[i]) * a; continue; }
      for (let c = 0; c < 4; c++) {
        const p = i * 4 + c;
        out[p] = before[p] + (out[p] - before[p]) * a;
      }
    }
    return out;
  }

  return C;
}
