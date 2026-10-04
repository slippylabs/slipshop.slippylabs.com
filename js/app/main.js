// Boot.

import { Editor } from './editor.js';
import { View } from './view.js';
import { TOOLS, TOOL_BY_ID, Gesture, defaultToolOptions, isPaintTool } from './tools.js';
import { renderDock } from './panels.js';
import { buildMenus, commands } from './menus.js';
import { el, setChildren, dropdown, btn, toast, hint, closeModal } from './ui.js';
import { Layer } from '../core/doc.js';
import { Surface } from '../core/tiles.js';
import { compositeDoc } from '../core/composite.js';
import { applyAdjust } from '../core/adjust.js';
import { resize, orient as orientBuf } from '../core/resample.js';
import { rect, rectEmpty, clamp } from '../core/util.js';
import { toHex } from '../core/color.js';
import * as io from './io.js';

const $ = (id) => document.getElementById(id);

const ed = new Editor();
const opt = defaultToolOptions();
const stage = $('stage');
const view = new View(ed, stage, $('canvas-wrap'), $('view'), $('overlay'));
const ctx = { internalClipboard: null };
const C = commands(ed, view, opt, ctx);

// --------------------------------------------------------- document edits
// These change the document's SIZE, so every layer, mask and the selection
// must be rebuilt together -- a surface left at the old size would fail
// validate() and draw nothing.

function mapSurfaces(w, h, fn) {
  for (const { layer } of ed.doc.walk()) {
    if (layer.surface) layer.surface = fn(layer.surface, w, h);
    if (layer.mask) layer.mask = fn(layer.mask, w, h);
  }
  if (ed.doc.selection) ed.doc.selection = fn(ed.doc.selection, w, h);
  ed.doc.w = w;
  ed.doc.h = h;
}

/** Read a surface out as RGBA (masks get expanded) and write a new one back. */
function remapSurface(s, nw, nh, transformFn) {
  const r = rect(0, 0, s.w, s.h);
  const raw = s.readRect(r);
  const isMask = s.channels === 1;
  let px = raw;
  if (isMask) {
    px = new Float32Array(r.w * r.h * 4);
    for (let i = 0; i < raw.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = raw[i]; px[i * 4 + 3] = 1; }
  }
  const out = transformFn(px, r.w, r.h);
  const next = new Surface(nw, nh, s.channels, s.depth);
  if (isMask) {
    const m = new Float32Array(nw * nh);
    for (let i = 0; i < m.length; i++) m[i] = out[i * 4];
    next.writeRect(rect(0, 0, nw, nh), m);
  } else {
    next.writeRect(rect(0, 0, nw, nh), out);
  }
  return next;
}

ctx.resample = (w, h, filter) => {
  ed.history.begin('Image size', ed.doc);
  mapSurfaces(w, h, (s) => remapSurface(s, w, h, (px, sw, sh) => resize(px, sw, sh, w, h, filter)));
  ed.history.commit();
  afterDocChange();
  toast(`Resized to ${w} x ${h}`);
};

ctx.crop = (box) => {
  ed.history.begin('Crop', ed.doc);
  mapSurfaces(box.w, box.h, (s) => remapSurface(s, box.w, box.h, (px, sw, sh) => {
    const out = new Float32Array(box.w * box.h * 4);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const sx = box.x + x, sy = box.y + y;
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
        const sp = (sy * sw + sx) * 4, dp = (y * box.w + x) * 4;
        for (let c = 0; c < 4; c++) out[dp + c] = px[sp + c];
      }
    }
    return out;
  }));
  ed.doc.selection = null;
  ed.history.commit();
  afterDocChange();
  toast(`Cropped to ${box.w} x ${box.h}`);
};

ctx.resizeCanvas = (w, h, anchor) => {
  const dx = anchor.includes('left') ? 0 : (anchor.includes('right') ? w - ed.doc.w : Math.round((w - ed.doc.w) / 2));
  const dy = anchor.includes('top') ? 0 : (anchor.includes('bottom') ? h - ed.doc.h : Math.round((h - ed.doc.h) / 2));
  ctx.crop({ x: -dx, y: -dy, w, h });
};

ctx.orient = (op) => {
  const swapped = op === 'rot90' || op === 'rot270';
  const nw = swapped ? ed.doc.h : ed.doc.w;
  const nh = swapped ? ed.doc.w : ed.doc.h;
  ed.history.begin('Rotate', ed.doc);
  mapSurfaces(nw, nh, (s) => remapSurface(s, nw, nh, (px, sw, sh) => orientBuf(px, sw, sh, op).data));
  ed.history.commit();
  afterDocChange();
};

function afterDocChange() {
  view.resizeToDoc();
  view.fit();
  ed.emit('doc');
  renderAll();
}
ctx.afterDocChange = afterDocChange;
ctx.pickTool = (id) => setTool(id);

// --------------------------------------------------------------- the text tool
ctx.placeText = (x, y) => {
  // A click makes a re-editable TEXT LAYER, not pixels. The spec lives on the
  // layer and the surface is derived from it, so the words stay editable --
  // which also means the layer has to be rasterised before anything paints on
  // it, or the next keystroke would redraw over the brush stroke.
  const l = ed.addTextLayer(x, y, {
    content: opt.text || 'Type here',
    fontFamily: opt.fontFamily,
    fontSize: opt.fontSize,
    fontWeight: opt.fontWeight,
  });
  hint('Text layer added \u2014 edit it in the Text panel. Painting on it will rasterise it.');
  return l;
};

// ------------------------------------------------------------------ chrome

function renderMenubar() {
  const menus = buildMenus(ed, view, opt, ctx);
  setChildren($('menubar'), ...menus.map(([label, items]) => dropdown(label, items)));
}

function renderRail() {
  const rail = $('rail');
  const kids = [];
  let group = TOOLS[0].group;
  for (const t of TOOLS) {
    if (t.group !== group) { kids.push(el('div', { class: 'sp-rail-gap' })); group = t.group; }
    kids.push(el('button', {
      type: 'button',
      class: `sp-tool${ed.tool === t.id ? ' on' : ''}`,
      title: `${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}`,
      dataset: { tool: t.id },
      'aria-pressed': ed.tool === t.id ? 'true' : 'false',
      text: t.icon,
      onclick: () => setTool(t.id),
    }));
  }
  setChildren(rail, ...kids);
}

function setTool(id) {
  if (!TOOL_BY_ID[id] || ed.tool === id) return;
  // Leaving the liquify tool banks the warp. Carrying an open session into
  // another tool would mean the next brush stroke landed on pixels that are
  // still only a preview, and the stroke would vanish on the next dab.
  if (ed.tool === 'liquify' && id !== 'liquify') ed.commitLiquify();
  ed.tool = id;
  renderRail();
  renderDock(ed, view, opt, $('dock'));
  const t = TOOL_BY_ID[id];
  hint(t.label);
  updateCursor();
}

function updateCursor() {
  const map = {
    hand: 'grab', zoom: 'zoom-in', move: 'move', eyedropper: 'crosshair',
    crop: 'crosshair', text: 'text',
  };
  stage.style.cursor = map[ed.tool] || 'crosshair';
}

function renderStatus() {
  $('zoom-label').textContent = `${ed.zoom < 0.1 ? (ed.zoom * 100).toFixed(1) : Math.round(ed.zoom * 100)}%`;
  $('st-size').textContent = `${ed.doc.w} × ${ed.doc.h}`;
  $('doc-title').textContent = ed.doc.name || 'Untitled';
  const held = ed.doc.byteLength + ed.history.byteLength;
  $('st-mem').textContent = `${(held / 1048576).toFixed(1)} MB`;
  $('btn-undo').disabled = !ed.history.canUndo;
  $('btn-redo').disabled = !ed.history.canRedo;
}

function renderAll() {
  renderMenubar();
  renderRail();
  renderDock(ed, view, opt, $('dock'));
  renderStatus();
  updateCursor();
}

// ------------------------------------------------------------------ events

ed.on((what) => {
  if (what.startsWith('paint:')) {
    try { view.repaint(JSON.parse(what.slice(6))); } catch (e) { view.repaint(); }
    renderStatus();
    scheduleAutosave();
    return;
  }
  if (what === 'rasterised') {
    // Emitted when something had to turn a text or shape layer into pixels
    // before it could write to it. The layer panel has already been rebuilt by
    // the 'layers' event that came with it; this is the user-facing half.
    hint(`${ed.lastRasterised} was rasterised so it could be edited as pixels.`);
    return;
  }
  if (what === 'liquify') {
    // The freeze mask lives on the overlay, and the Apply/Reset buttons and
    // the hint text in the tool options depend on whether a session is open.
    view.drawAnts();
    renderDock(ed, view, opt, $('dock'));
    renderStatus();
    return;
  }
  if (what === 'paths') {
    renderDock(ed, view, opt, $('dock'));
    view.drawPaths();
    return;
  }
  if (what === 'layers' || what === 'history' || what === 'doc' || what === 'tool') {
    renderDock(ed, view, opt, $('dock'));
    renderMenubar();
  }
  if (what === 'selection') {
    view.drawAnts();
    renderMenubar();
  }
  if (what === 'colour' || what === 'brushpreview') {
    renderDock(ed, view, opt, $('dock'));
  }
  if (what === 'view' || what === 'doc') renderStatus();
  if (what === 'layers' || what === 'doc') { view.repaint(); renderStatus(); }
  // Undo and redo restore doc.paths along with everything else, so the
  // overlay has to be redrawn on a history event too -- not only when a path
  // tool emits.
  if (what === 'history' || what === 'doc') view.drawPaths();
});

// --------------------------------------------------------------- pointer

let gesture = null;
let spaceDown = false;

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  // A middle button or the space bar always pans, whatever tool is active.
  const wantsPan = e.button === 1 || spaceDown;
  stage.setPointerCapture(e.pointerId);
  gesture = new Gesture(ed, view, opt);
  gesture.onCrop = ctx.crop;
  gesture.onText = ctx.placeText;
  e.spacePan = wantsPan;
  gesture.start(e);
  e.preventDefault();
});

stage.addEventListener('pointermove', (e) => {
  const [x, y] = view.toDoc(e.clientX, e.clientY);
  $('st-pos').textContent = `${Math.floor(x)}, ${Math.floor(y)}`;
  if (gesture && gesture.active) gesture.move(e);
});

const endGesture = (e) => {
  if (!gesture) return;
  gesture.end(e);
  gesture = null;
  renderStatus();
};
stage.addEventListener('pointerup', endGesture);
stage.addEventListener('pointercancel', (e) => { if (gesture) { gesture.cancel(); gesture = null; } });

// Wheel zooms around the cursor; with shift it pans, which is what a
// trackpad user expects.
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || !e.shiftKey) {
    view.zoomStep(e.deltaY < 0 ? 1 : -1, [e.clientX, e.clientY]);
  } else {
    view.panBy(-e.deltaX, -e.deltaY);
  }
}, { passive: false });

window.addEventListener('resize', () => view.layout());

// Drag and drop a file anywhere on the editor.
['dragover', 'drop'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  try {
    for (const f of files) {
      if (/\.slipshop$/i.test(f.name)) {
        ed.setDocument(io.loadProject(new Uint8Array(await f.arrayBuffer())));
        afterDocChange();
      } else if (ed.doc.layers.length === 1 && ed.doc.layers[0].locked && ed.history.past.length === 0) {
        ed.setDocument(await io.docFromImage(f));
        afterDocChange();
      } else {
        const l = await io.layerFromImage(ed.doc, f);
        ed.history.begin('Place image', ed.doc);
        ed.doc.layers.push(l);
        ed.history.commit();
        ed.activeId = l.id;
        ed.invalidate();
        ed.emit('layers');
      }
    }
    toast('Opened');
  } catch (err) { toast(err.message, { bad: true }); }
});

// -------------------------------------------------------------- keyboard

const TOOL_KEYS = {};
for (const t of TOOLS) if (t.key) TOOL_KEYS[t.key] = t.id;

document.addEventListener('keydown', (e) => {
  // Never steal a key from a text field.
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

  if (e.code === 'Space' && !spaceDown) {
    spaceDown = true;
    stage.style.cursor = 'grab';
    e.preventDefault();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const k = e.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); fn(); };
    if (k === 'z' && !e.shiftKey) return run(() => ed.undo());
    if ((k === 'z' && e.shiftKey) || k === 'y') return run(() => ed.redo());
    if (k === 'a') return run(() => C.selectAll());
    if (k === 'd') return run(() => ed.deselect());
    if (k === 'i' && e.shiftKey) return run(() => C.inverse());
    if (k === 'i' && e.altKey) return run(() => C.imageSize());
    if (k === 'c' && e.altKey) return run(() => C.canvasSize());
    if (k === 'n' && e.shiftKey) return run(() => ed.addLayer());
    if (k === 'n') return run(() => C.newDoc());
    if (k === 'o') return run(() => C.open());
    if (k === 's') return run(() => C.saveProject());
    if (k === 'e' && e.shiftKey) return run(() => ed.mergeDown());
    if (k === 'e') return run(() => C.exportAs('image/png'));
    if (k === 'j') return run(() => ed.duplicateLayer());
    if (k === 'g') return run(() => ed.groupSelected());
    if (k === 'c') return run(() => C.copy(false));
    if (k === 'x') return run(() => C.copy(true));
    if (k === 'v') return run(() => C.paste());
    if (k === '0') return run(() => view.fit());
    if (k === '1') return run(() => view.actualPixels());
    if (e.key === '+' || e.key === '=') return run(() => view.zoomStep(1));
    if (e.key === '-') return run(() => view.zoomStep(-1));
    if (e.key === 'Backspace') return run(() => C.fill(ed.bg));
    return;
  }

  if (e.altKey && e.key === 'Backspace') { e.preventDefault(); C.fill(ed.fg); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); C.clear(); return; }
  if (e.key === 'Escape') {
    if (gesture) { gesture.cancel(); gesture = null; }
    closeModal();
    return;
  }

  // Brush size and hardness.
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    const up = e.key === ']';
    if (e.shiftKey) {
      ed.brush.hardness = clamp(ed.brush.hardness + (up ? 0.1 : -0.1), 0, 1);
      hint(`Hardness ${Math.round(ed.brush.hardness * 100)}%`);
    } else {
      // Proportional, so one keypress is a useful change at 3px and at 300px.
      const step = Math.max(1, Math.round(ed.brush.size * 0.15));
      ed.brush.size = clamp(ed.brush.size + (up ? step : -step), 1, 2000);
      hint(`Size ${Math.round(ed.brush.size)}px`);
    }
    ed.emit('brushpreview');
    return;
  }
  if (e.key === 'x' || e.key === 'X') { ed.swapColours(); return; }
  if (e.key === 'd' || e.key === 'D') { ed.resetColours(); return; }
  if (/^[0-9]$/.test(e.key) && isPaintTool(ed.tool)) {
    ed.brush.opacity = e.key === '0' ? 1 : Number(e.key) / 10;
    hint(`Opacity ${Math.round(ed.brush.opacity * 100)}%`);
    ed.emit('brushpreview');
    return;
  }

  // Tool keys: the shifted form picks the alternative tool in the group,
  // which is how M/Shift+M give marquee and ellipse.
  const key = e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase();
  if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); e.preventDefault(); }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; updateCursor(); }
});

// ------------------------------------------------------------- status bar

$('zoom-in').onclick = () => view.zoomStep(1);
$('zoom-out').onclick = () => view.zoomStep(-1);
$('zoom-fit').onclick = () => view.fit();
$('btn-undo').onclick = () => ed.undo();
$('btn-redo').onclick = () => ed.redo();
$('btn-dock').onclick = () => $('dock').classList.toggle('open');

// ---------------------------------------------------------------- autosave

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(doAutosave, 4000);
}
async function doAutosave() {
  const n = await io.autosave(ed.doc);
  if (n) $('st-busy').classList.add('sp-hidden');
}
// A debounced save loses the last edit when the tab goes away, which is the
// one time it matters most -- so flush on pagehide, the same lesson
// SlipStudio's store learned.
window.addEventListener('pagehide', () => { clearTimeout(autosaveTimer); io.autosave(ed.doc); });
window.addEventListener('beforeunload', (e) => {
  if (ed.history.past.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// -------------------------------------------------------------------- boot

renderAll();
view.fit();
hint('Drop an image in, or start painting. Nothing leaves your machine.');

/** A read-only hook for the headless tests in tools/. */
window.__slipshop = {
  ed, view, opt, io,
  get doc() { return ed.doc; },
  commands: C,
  setTool,
  pixel: (x, y) => {
    const px = compositeDoc(ed.doc, rect(x, y, 1, 1), { applyAdjust });
    return [px[0], px[1], px[2], px[3]];
  },
  stats: () => ({
    w: ed.doc.w, h: ed.doc.h, layers: ed.doc.layerCount,
    tool: ed.tool, zoom: ed.zoom,
    undo: ed.history.past.length, redo: ed.history.future.length,
    bytes: ed.doc.byteLength, historyBytes: ed.history.byteLength,
    hasSelection: !!ed.doc.selection,
  }),
  ready: true,
};
