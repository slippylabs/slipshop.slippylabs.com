// The dock: tool options, colour, brush, layers, history.
//
// Every panel re-renders from scratch on the event it cares about. That is
// only affordable because the panels are small, and it removes a whole class
// of bug -- a control showing a value the document no longer has. The one
// thing that must survive a re-render is which panels are open, which ui.js
// remembers by title.

import { el, panel, row, btn, slider, number, select, selectGroups, checkbox, text, colorInput, toast, hint, setChildren, modal } from './ui.js';
import { MODE_GROUPS } from '../core/blend.js';
import { TOOLS, TOOL_BY_ID, isPaintTool, isSelectTool } from './tools.js';
import { GRADIENT_SHAPES } from '../core/gradient.js';
import { toHex, parseHex, rgbToHsv, hsvToRgb } from '../core/color.js';
import { rect, clamp01, luma709 } from '../core/util.js';
import { compositeDoc } from '../core/composite.js';
import { applyAdjust } from '../core/adjust.js';
import { EFFECT_TYPES, EFFECT_FIELDS, EFFECT_LABELS, effectDefaults } from '../core/effects.js';
import { resize } from '../core/resample.js';

const BLEND_GROUPS = MODE_GROUPS.map(([g, list]) => [g, list.map((m) => [m, prettyMode(m)])]);
function prettyMode(m) {
  return m.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function renderDock(ed, view, opt, dock) {
  setChildren(dock,
    toolOptionsPanel(ed, view, opt),
    colourPanel(ed),
    brushPanel(ed, opt),
    layersPanel(ed, view),
    effectsPanel(ed),
    historyPanel(ed),
    infoPanel(ed),
  );
}

// ------------------------------------------------------------ tool options

function toolOptionsPanel(ed, view, opt) {
  const t = TOOL_BY_ID[ed.tool];
  const body = [];
  const rerender = () => ed.emit('tool');

  if (isSelectTool(ed.tool)) {
    body.push(row('Mode', select({
      get: () => opt.selectMode,
      options: [['new', 'New'], ['add', 'Add (Shift)'], ['subtract', 'Subtract (Alt)'], ['intersect', 'Intersect'], ['xor', 'Exclude']],
      onCommit: (v) => { opt.selectMode = v; },
    })));
    body.push(row('Feather', slider({
      get: () => opt.feather, min: 0, max: 100, step: 0.5,
      onCommit: (v) => { opt.feather = v; },
    })));
    body.push(row('', checkbox({ get: () => opt.antialias, label: 'Antialias', onCommit: (v) => { opt.antialias = v; } })));
  }
  if (ed.tool === 'wand' || ed.tool === 'bucket') {
    body.push(row('Tolerance', slider({
      get: () => opt.tolerance, min: 0, max: 100, step: 1,
      onCommit: (v) => { opt.tolerance = v; },
    })));
    body.push(row('', checkbox({ get: () => opt.contiguous, label: 'Contiguous', onCommit: (v) => { opt.contiguous = v; } })));
    body.push(row('', checkbox({ get: () => opt.sampleAll, label: 'Sample all layers', onCommit: (v) => { opt.sampleAll = v; } })));
  }
  if (ed.tool === 'gradient') {
    body.push(row('Shape', select({
      get: () => opt.gradientShape,
      options: GRADIENT_SHAPES.map((s) => [s, prettyMode(s)]),
      onCommit: (v) => { opt.gradientShape = v; },
    })));
    body.push(row('Colours', select({
      get: () => opt.gradientKind,
      options: [['fg-bg', 'Foreground to Background'], ['fg-transparent', 'Foreground to Transparent'], ['black-white', 'Black to White']],
      onCommit: (v) => { opt.gradientKind = v; },
    })));
    body.push(row('', checkbox({ get: () => opt.gradientReverse, label: 'Reverse', onCommit: (v) => { opt.gradientReverse = v; } })));
    body.push(row('', checkbox({ get: () => opt.gradientDither, label: 'Dither', onCommit: (v) => { opt.gradientDither = v; } })));
  }
  if (ed.tool === 'shape') {
    body.push(row('Shape', select({
      get: () => opt.shapeKind, options: [['rect', 'Rectangle'], ['ellipse', 'Ellipse']],
      onCommit: (v) => { opt.shapeKind = v; },
    })));
  }
  if (ed.tool === 'smudge' || ed.tool === 'blur' || ed.tool === 'sharpen') {
    body.push(row('Strength', slider({
      get: () => opt.strength, min: 0.02, max: 1, step: 0.01,
      onCommit: (v) => { opt.strength = v; },
    })));
  }
  if (ed.tool === 'dodge' || ed.tool === 'burn') {
    body.push(row('Exposure', slider({
      get: () => opt.exposure, min: 0.01, max: 1, step: 0.01,
      onCommit: (v) => { opt.exposure = v; },
    })));
  }
  if (ed.tool === 'clone') {
    body.push(row('', checkbox({ get: () => opt.cloneAligned, label: 'Aligned', onCommit: (v) => { opt.cloneAligned = v; } })));
    body.push(row('', checkbox({ get: () => opt.sampleAll, label: 'Sample all layers', onCommit: (v) => { opt.sampleAll = v; } })));
    body.push(el('p', { class: 'sp-note', text: ed.cloneSource ? `Source: ${Math.round(ed.cloneSource[0])}, ${Math.round(ed.cloneSource[1])}` : 'Alt-click to set the source.' }));
  }
  if (ed.tool === 'text') {
    body.push(row('Text', text({ get: () => opt.text, onCommit: (v) => { opt.text = v; } }), { wide: true }));
    body.push(row('Size', number({ get: () => opt.fontSize, min: 4, max: 800, step: 1, onCommit: (v) => { opt.fontSize = v; } })));
    body.push(row('Font', select({
      get: () => opt.fontFamily,
      options: [['sans-serif', 'Sans'], ['serif', 'Serif'], ['monospace', 'Mono'], ['cursive', 'Cursive'], ['Consolas, monospace', 'Consolas']],
      onCommit: (v) => { opt.fontFamily = v; },
    })));
    body.push(row('Weight', select({
      get: () => opt.fontWeight, options: [['normal', 'Normal'], ['bold', 'Bold'], ['900', 'Black']],
      onCommit: (v) => { opt.fontWeight = v; },
    })));
    body.push(el('p', { class: 'sp-note', text: 'Click on the canvas to place the text.' }));
  }
  if (!body.length) {
    // "Brush has no options" is a lie -- they are in the Brush panel below,
    // which is where every paint tool's settings live. Say so.
    body.push(el('p', { class: 'sp-note', text: isPaintTool(ed.tool)
      ? `${t.label} uses the Brush panel below: size, hardness, opacity, flow, spacing and the pressure dynamics.`
      : `${t ? t.label : 'Tool'} has no options.` }));
  }
  return panel(`Tool — ${t ? t.label : ''}`, { open: true }, ...body);
}

// ----------------------------------------------------------------- colour

function colourPanel(ed) {
  const sw = el('div', { class: 'sp-colour-pair' });
  const fg = el('button', { class: 'sp-swatch-fg', title: 'Foreground', style: { background: toHex(ed.fg) } });
  const bg = el('button', { class: 'sp-swatch-bg', title: 'Background', style: { background: toHex(ed.bg) } });
  const swap = el('button', { class: 'sp-swap', title: 'Swap (X)', text: '⇄', onclick: () => ed.swapColours() });
  sw.append(bg, fg, swap);

  // An HSV square plus a hue strip. Drawn with canvas rather than CSS
  // gradients so the picked colour is exactly the pixel under the cursor --
  // a CSS gradient's interpolation is not something we can read back.
  const sv = el('canvas', { class: 'sp-sv', width: 180, height: 92 });
  const hue = el('canvas', { class: 'sp-hue', width: 180, height: 14 });
  let [h0] = rgbToHsv(ed.fg[0], ed.fg[1], ed.fg[2]);

  const drawSV = () => {
    const g = sv.getContext('2d');
    const img = g.createImageData(sv.width, sv.height);
    for (let y = 0; y < sv.height; y++) {
      for (let x = 0; x < sv.width; x++) {
        const c = hsvToRgb(h0, x / (sv.width - 1), 1 - y / (sv.height - 1));
        const p = (y * sv.width + x) * 4;
        img.data[p] = c[0] * 255; img.data[p + 1] = c[1] * 255; img.data[p + 2] = c[2] * 255; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  };
  const drawHue = () => {
    const g = hue.getContext('2d');
    const img = g.createImageData(hue.width, hue.height);
    for (let x = 0; x < hue.width; x++) {
      const c = hsvToRgb((x / (hue.width - 1)) * 360, 1, 1);
      for (let y = 0; y < hue.height; y++) {
        const p = (y * hue.width + x) * 4;
        img.data[p] = c[0] * 255; img.data[p + 1] = c[1] * 255; img.data[p + 2] = c[2] * 255; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  };
  drawSV(); drawHue();

  const svDrag = (e) => {
    const r = sv.getBoundingClientRect();
    const x = clamp01((e.clientX - r.left) / r.width);
    const y = clamp01((e.clientY - r.top) / r.height);
    ed.setFg(hsvToRgb(h0, x, 1 - y));
  };
  sv.addEventListener('pointerdown', (e) => { sv.setPointerCapture(e.pointerId); svDrag(e); });
  sv.addEventListener('pointermove', (e) => { if (sv.hasPointerCapture(e.pointerId)) svDrag(e); });

  const hueDrag = (e) => {
    const r = hue.getBoundingClientRect();
    h0 = clamp01((e.clientX - r.left) / r.width) * 360;
    drawSV();
    const [, s, v] = rgbToHsv(ed.fg[0], ed.fg[1], ed.fg[2]);
    ed.setFg(hsvToRgb(h0, s || 1, v || 1));
  };
  hue.addEventListener('pointerdown', (e) => { hue.setPointerCapture(e.pointerId); hueDrag(e); });
  hue.addEventListener('pointermove', (e) => { if (hue.hasPointerCapture(e.pointerId)) hueDrag(e); });

  const hex = el('input', { class: 'sp-text', type: 'text', value: toHex(ed.fg), spellcheck: 'false' });
  hex.addEventListener('change', () => {
    const c = parseHex(hex.value);
    if (!c) { toast('That is not a colour', { bad: true }); hex.value = toHex(ed.fg); return; }
    ed.setFg(c);
  });

  fg.addEventListener('click', () => hex.focus());
  bg.addEventListener('click', () => ed.swapColours());

  const swatches = el('div', { class: 'sp-swatches' },
    ed.swatches.map((c) => el('button', {
      type: 'button', style: { background: c }, title: c,
      onclick: (e) => { if (e.altKey) ed.setBg(c); else ed.setFg(c); },
    })));

  return panel('Colour', { open: true },
    el('div', { class: 'sp-ctl', style: { alignItems: 'flex-start', gap: '9px' } }, sw,
      el('div', { style: { flex: '1 1 auto', minWidth: '0' } }, hex)),
    sv, hue, swatches,
    el('p', { class: 'sp-note', text: 'X swaps, D resets. Alt-click a swatch for the background.' }));
}

// ------------------------------------------------------------------ brush

function brushPanel(ed, opt) {
  if (!isPaintTool(ed.tool)) return null;
  const b = ed.brush;
  const live = () => ed.emit('brushpreview');
  const dyn = (key, label) => row(label, select({
    get: () => (b[key] && b[key].by) || 'off',
    options: [['off', 'Off'], ['pressure', 'Pressure'], ['tilt', 'Tilt'], ['velocity', 'Speed'], ['random', 'Random']],
    onCommit: (v) => { b[key] = { ...(b[key] || {}), by: v }; live(); },
  }));
  return panel('Brush', { open: true },
    row('Size', slider({ get: () => b.size, min: 1, max: 500, step: 1, onInput: (v) => { b.size = v; live(); }, onCommit: (v) => { b.size = v; live(); } })),
    row('Hardness', slider({ get: () => b.hardness, min: 0, max: 1, step: 0.01, onInput: (v) => { b.hardness = v; live(); }, onCommit: (v) => { b.hardness = v; live(); } })),
    row('Opacity', slider({ get: () => b.opacity, min: 0, max: 1, step: 0.01, onCommit: (v) => { b.opacity = v; } })),
    row('Flow', slider({ get: () => b.flow, min: 0.01, max: 1, step: 0.01, onCommit: (v) => { b.flow = v; } })),
    row('Spacing', slider({ get: () => b.spacing, min: 0.01, max: 2, step: 0.01, onCommit: (v) => { b.spacing = v; } })),
    row('Roundness', slider({ get: () => b.roundness, min: 0.05, max: 1, step: 0.01, onCommit: (v) => { b.roundness = v; live(); } })),
    row('Angle', slider({ get: () => b.angle, min: -90, max: 90, step: 1, onCommit: (v) => { b.angle = v; live(); } })),
    row('Smoothing', slider({ get: () => b.smoothing, min: 0, max: 0.95, step: 0.01, onCommit: (v) => { b.smoothing = v; } })),
    row('Scatter', slider({ get: () => b.scatter, min: 0, max: 3, step: 0.05, onCommit: (v) => { b.scatter = v; } })),
    row('Count', number({ get: () => b.scatterCount, min: 1, max: 16, step: 1, onCommit: (v) => { b.scatterCount = v; } })),
    dyn('sizeDynamics', 'Size by'),
    dyn('flowDynamics', 'Flow by'),
    el('p', { class: 'sp-note', text: '[ and ] change the size. Flow builds up within a stroke; opacity caps it.' }));
}

// ----------------------------------------------------------------- layers

function layersPanel(ed, view) {
  const list = el('div', { class: 'sp-layers' });
  const active = ed.active;

  const renderList = (layers, depth) => {
    // Displayed TOP-FIRST, which is the opposite of the storage order. The
    // array is bottom-first because that is compositing order; reversing for
    // display happens exactly here and nowhere else.
    const out = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const sel = active && l.id === active.id;
      const eye = el('button', {
        class: `sp-eye${l.visible ? '' : ' off'}`, title: l.visible ? 'Hide' : 'Show',
        text: l.visible ? '◉' : '○',
        onclick: (e) => { e.stopPropagation(); ed.setLayerProp(l.id, 'visible', !l.visible); },
      });
      const thumb = el('canvas', { class: 'sp-thumb', width: 30, height: 24 });
      drawThumb(ed, l, thumb);
      const meta = [];
      if (l.blend !== 'normal' && l.blend !== 'pass-through') meta.push(prettyMode(l.blend));
      if (l.opacity < 1) meta.push(`${Math.round(l.opacity * 100)}%`);
      if (l.locked) meta.push('\u{1F512}');
      if (l.effects && l.effects.some((e) => e && e.enabled !== false)) meta.push('fx');
      const r = el('div', {
        class: `sp-layer${sel ? ' sel' : ''}${l.clipping ? ' clipped' : ''}`,
        dataset: { layer: l.id },
        onclick: () => ed.setActive(l.id),
      },
        eye, thumb,
        el('span', { class: 'sp-layer-name', text: `${l.clipping ? '↳ ' : ''}${l.name}` }),
        el('span', { class: 'sp-layer-meta' }, meta.join(' '),
          l.mask ? el('span', {
            class: `sp-mask-chip${ed.editingMask && sel ? '' : ' off'}`,
            title: ed.editingMask && sel ? 'Editing the mask' : 'Click to edit the mask',
            style: { background: ed.editingMask && sel ? '#39ff8f' : 'transparent' },
            onclick: (e) => { e.stopPropagation(); ed.setActive(l.id); ed.editingMask = !ed.editingMask; ed.emit('layers'); },
          }) : null),
      );
      out.push(r);
      if (l.children && l.children.length) {
        out.push(el('div', { class: 'sp-layer-kids' }, renderList(l.children, depth + 1)));
      }
    }
    return out;
  };
  setChildren(list, ...renderList(ed.doc.layers, 0));

  const l = active;
  return panel('Layers', { open: true },
    list,
    el('div', { class: 'sp-btn-row' },
      btn('+', () => ed.addLayer(), { title: 'New layer' }),
      btn('⧉', () => ed.duplicateLayer(), { title: 'Duplicate' }),
      btn('▲', () => ed.moveLayer(ed.activeId, 1), { title: 'Move up' }),
      btn('▼', () => ed.moveLayer(ed.activeId, -1), { title: 'Move down' }),
      btn('\u{1F5D1}', () => ed.removeLayer(), { title: 'Delete' })),
    l ? row('Blend', selectGroups({
      get: () => l.blend,
      groups: l.type === 'group' ? [['Group', [['pass-through', 'Pass Through']]], ...BLEND_GROUPS] : BLEND_GROUPS,
      onCommit: (v) => ed.setLayerProp(l.id, 'blend', v),
    })) : null,
    l ? row('Opacity', slider({
      get: () => l.opacity, min: 0, max: 1, step: 0.01,
      onInput: (v) => ed.setLayerProp(l.id, 'opacity', v, { live: true }),
      onCommit: (v) => { ed.setLayerProp(l.id, 'opacity', v, { live: true }); ed.commitProp(); },
    })) : null,
    l ? row('Fill', slider({
      get: () => l.fillOpacity, min: 0, max: 1, step: 0.01,
      onInput: (v) => ed.setLayerProp(l.id, 'fillOpacity', v, { live: true }),
      onCommit: (v) => { ed.setLayerProp(l.id, 'fillOpacity', v, { live: true }); ed.commitProp(); },
    })) : null,
    l ? row('Name', text({ get: () => l.name, onCommit: (v) => ed.setLayerProp(l.id, 'name', v || 'Layer') })) : null,
    l ? row('', checkbox({ get: () => l.clipping, label: 'Clip to layer below', onCommit: (v) => ed.setLayerProp(l.id, 'clipping', v) })) : null,
    l ? row('', checkbox({ get: () => l.locked, label: 'Lock', onCommit: (v) => ed.setLayerProp(l.id, 'locked', v) })) : null,
    el('div', { class: 'sp-btn-row' },
      btn(l && l.mask ? 'Remove mask' : 'Add mask', () => {
        if (l && l.mask) ed.removeMask(); else ed.addMask(ed.activeId, { fromSelection: !!ed.selection });
      }),
      l && l.mask ? btn('Apply mask', () => ed.removeMask(ed.activeId, { apply: true })) : null,
      btn('Group', () => ed.groupSelected()),
      btn('Merge down', () => ed.mergeDown())));
}

// ------------------------------------------------------------ layer effects

/** Which effect's fields are expanded. Kept outside the panel because the
 *  panel is thrown away and rebuilt on every document event. */
let openEffect = null;

function effectsPanel(ed) {
  const l = ed.active;
  if (!l) return panel('Layer Effects', { open: false }, hintRow('Select a layer.'));

  const byType = new Map((l.effects || []).map((e) => [e.type, e]));

  /** Read-modify-write through history, so every change is one undo step.
   *  The list is replaced rather than mutated: the undo snapshot copies the
   *  effects it was given, and editing those objects in place would rewrite
   *  the past as well as the present. */
  const write = (type, patch, { live = false } = {}) => {
    const next = (l.effects || []).map((e) => (e.type === type ? { ...e, ...patch } : e));
    if (!byType.has(type)) next.push({ ...effectDefaults(type), ...patch });
    ed.setLayerProp(l.id, 'effects', next, { live });
  };
  const drop = (type) => ed.setLayerProp(l.id, 'effects', (l.effects || []).filter((e) => e.type !== type));

  const rows = [];
  for (const type of EFFECT_TYPES) {
    const have = byType.get(type);
    const on = !!have && have.enabled !== false;
    const head = el('div', { class: `sp-fx-head${openEffect === type ? ' open' : ''}` },
      el('button', {
        class: `sp-eye${on ? '' : ' off'}`, text: on ? '◉' : '○',
        title: on ? 'Disable' : 'Enable',
        onclick: (e) => {
          e.stopPropagation();
          // Open it BEFORE the write: setLayerProp emits 'layers', which
          // rebuilds this whole panel, so anything set afterwards is read on
          // the next event rather than this one and the new effect comes up
          // folded away.
          if (!have) { openEffect = type; write(type, { enabled: true }); }
          else write(type, { enabled: !on });
        },
      }),
      el('button', {
        class: 'sp-fx-name', text: EFFECT_LABELS[type],
        onclick: () => { openEffect = openEffect === type ? null : type; ed.emit('layers'); },
      }),
      have ? el('button', { class: 'sp-fx-x', text: '×', title: 'Remove', onclick: (e) => { e.stopPropagation(); drop(type); } }) : null,
    );
    rows.push(head);
    if (openEffect !== type) continue;
    const fx = { ...effectDefaults(type), ...(have || {}) };
    const body = [];
    for (const [label, key, kind, ...rest] of EFFECT_FIELDS[type]) {
      if (kind === 'num') {
        const [min, max, step] = rest;
        body.push(row(label, slider({
          get: () => fx[key], min, max, step,
          onInput: (v) => write(type, { [key]: v }, { live: true }),
          onCommit: (v) => { write(type, { [key]: v }, { live: true }); ed.commitProp(); },
        })));
      } else if (kind === 'bool') {
        body.push(row('', checkbox({ get: () => !!fx[key], label, onCommit: (v) => write(type, { [key]: v }) })));
      } else if (kind === 'sel') {
        body.push(row(label, select({
          get: () => fx[key],
          options: rest[0].map((v) => [v, v[0].toUpperCase() + v.slice(1)]),
          onCommit: (v) => write(type, { [key]: v }),
        })));
      } else if (kind === 'col') {
        body.push(row(label, colorInput({
          get: () => toHex(fx[key]),
          onCommit: (hex) => { const c = parseHex(hex); if (c) write(type, { [key]: c.slice(0, 3) }); },
        })));
      }
    }
    if (type === 'gradientOverlay') {
      // Two stops is enough for an overlay and keeps the panel one line; the
      // full stop editor lives in the gradient tool, which this borrows from.
      const stops = fx.stops || effectDefaults(type).stops;
      body.push(row('From', colorInput({
        get: () => toHex(stops[0].color),
        onCommit: (hex) => { const c = parseHex(hex); if (c) write(type, { stops: [{ pos: 0, color: c.slice(0, 3) }, { ...stops[stops.length - 1] }] }); },
      })));
      body.push(row('To', colorInput({
        get: () => toHex(stops[stops.length - 1].color),
        onCommit: (hex) => { const c = parseHex(hex); if (c) write(type, { stops: [{ ...stops[0] }, { pos: 1, color: c.slice(0, 3) }] }); },
      })));
    }
    rows.push(el('div', { class: 'sp-fx-body' }, ...body));
  }

  const n = (l.effects || []).filter((e) => e.enabled !== false).length;
  return panel('Layer Effects', { open: n > 0, note: n ? `${n} active` : undefined },
    el('div', { class: 'sp-fx-list' }, ...rows),
    el('div', { class: 'sp-btn-row' },
      btn('Clear', () => { openEffect = null; ed.setLayerProp(l.id, 'effects', []); }, { title: 'Remove every effect' }),
      btn('Copy', () => { copiedEffects = (l.effects || []).map((e) => ({ ...e })); toast('Effects copied'); }),
      btn('Paste', () => {
        if (!copiedEffects) return toast('Nothing copied', { bad: true });
        ed.setLayerProp(l.id, 'effects', copiedEffects.map((e) => ({ ...e })));
      })),
    hintRow('Fill drops the layer\'s own pixels and keeps its effects \u2014 a stroke with nothing inside it.'));
}

let copiedEffects = null;

function hintRow(t) { return el('p', { class: 'sp-note', text: t }); }

function drawThumb(ed, layer, cv) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const src = layer.surface || layer.mask;
  if (!src) {
    g.fillStyle = '#1c8a52';
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#04120b';
    g.font = '9px monospace';
    g.fillText(layer.type === 'adjustment' ? 'adj' : layer.type.slice(0, 3), 3, 15);
    return;
  }
  // Downscale from the document rather than from content bounds, so the
  // thumbnail shows WHERE on the canvas the pixels are.
  const r = rect(0, 0, src.w, src.h);
  const px = src.readRect(r);
  const rgba = src.channels === 1 ? maskToRgba(px) : px;
  const small = resize(rgba, r.w, r.h, cv.width, cv.height, 'bilinear');
  const img = g.createImageData(cv.width, cv.height);
  for (let i = 0; i < cv.width * cv.height; i++) {
    const p = i * 4;
    img.data[p] = small[p] * 255; img.data[p + 1] = small[p + 1] * 255;
    img.data[p + 2] = small[p + 2] * 255; img.data[p + 3] = small[p + 3] * 255;
  }
  g.putImageData(img, 0, 0);
}

function maskToRgba(px) {
  const out = new Float32Array(px.length * 4);
  for (let i = 0; i < px.length; i++) {
    out[i * 4] = px[i]; out[i * 4 + 1] = px[i]; out[i * 4 + 2] = px[i]; out[i * 4 + 3] = 1;
  }
  return out;
}

// ---------------------------------------------------------------- history

function historyPanel(ed) {
  const h = ed.history;
  const items = [];
  items.push(el('div', { class: `sp-hist${h.past.length === 0 ? ' now' : ''}`, text: 'Open', onclick: () => { while (h.canUndo) ed.undo(); } }));
  h.past.forEach((e, i) => {
    items.push(el('div', {
      class: `sp-hist${i === h.past.length - 1 ? ' now' : ''}`, text: e.label,
      onclick: () => { const steps = h.past.length - 1 - i; for (let k = 0; k < steps; k++) ed.undo(); },
    }));
  });
  [...h.future].reverse().forEach((e, i) => {
    items.push(el('div', {
      class: 'sp-hist future', text: e.label,
      onclick: () => { for (let k = 0; k <= i; k++) ed.redo(); },
    }));
  });
  return panel('History', { open: false },
    el('div', { class: 'sp-history' }, ...items),
    el('div', { class: 'sp-btn-row' },
      btn('Undo', () => ed.undo(), { disabled: !h.canUndo }),
      btn('Redo', () => ed.redo(), { disabled: !h.canRedo })),
    el('p', { class: 'sp-note', text: `${h.past.length} step${h.past.length === 1 ? '' : 's'}, ${(h.byteLength / 1048576).toFixed(1)} MB of pixels held` }));
}

// ------------------------------------------------------------------- info

function infoPanel(ed) {
  const d = ed.doc;
  const hist = el('canvas', { class: 'sp-histogram', width: 256, height: 56 });
  drawHistogram(ed, hist);
  return panel('Info', { open: false },
    hist,
    el('div', { class: 'sp-note' },
      `${d.w} x ${d.h} px, ${d.depth}-bit, ${d.layerCount} layer${d.layerCount === 1 ? '' : 's'}`,
      el('br'),
      `pixels held: ${(d.byteLength / 1048576).toFixed(1)} MB`),
    btn('Refresh histogram', () => drawHistogram(ed, hist)));
}

function drawHistogram(ed, cv) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  // Sample rather than read every pixel: a histogram of a 24-megapixel image
  // does not need every pixel to look the same, and the panel must not stall
  // the UI.
  const step = Math.max(1, Math.floor(Math.sqrt((ed.doc.w * ed.doc.h) / 250000)));
  const w = Math.max(1, Math.floor(ed.doc.w / step));
  const h = Math.max(1, Math.floor(ed.doc.h / step));
  const px = resize(compositeDoc(ed.doc, ed.doc.bounds, { applyAdjust }), ed.doc.w, ed.doc.h, w, h, 'bilinear');
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (px[p + 3] < 0.004) continue;
    for (let c = 0; c < 3; c++) bins[c][Math.min(255, Math.max(0, Math.round(px[p + c] * 255)))]++;
  }
  let max = 1;
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) if (bins[c][i] > max) max = bins[c][i];
  g.globalCompositeOperation = 'lighter';
  const cols = ['#ff4655', '#39ff8f', '#4cc9f0'];
  for (let c = 0; c < 3; c++) {
    g.fillStyle = cols[c];
    g.globalAlpha = 0.55;
    for (let i = 0; i < 256; i++) {
      const bh = (bins[c][i] / max) * cv.height;
      g.fillRect(i, cv.height - bh, 1, bh);
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

export { prettyMode };
