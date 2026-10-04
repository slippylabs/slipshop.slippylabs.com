// A small DOM toolkit for the editor's panels.
//
// Same contract as SlipStudio's js/studio/ui.js, for the same reason: every
// control is bound to a getter and two setters -- onInput for live preview
// while dragging, onCommit when the gesture ends. That split is what makes a
// slider sweep ONE undo step instead of two hundred, and it has to be in the
// control rather than in each panel or it gets forgotten somewhere.

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  add(n, children);
  return n;
}

function add(parent, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) { add(parent, k); continue; }
    parent.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
}

/**
 * replaceChildren that filters out nothing-values.
 *
 * Plain replaceChildren(null) inserts the literal text "null" into the panel,
 * which is a bug SlipStudio hit in two panels before it was centralised. Every
 * render in this app goes through here.
 */
export function setChildren(root, ...kids) {
  if (!root) return root;
  root.replaceChildren();
  add(root, kids);
  return root;
}

/** Remember which panels are open, by title, across re-renders. Panels
 *  re-render on every selection change, and a <details> that resets each time
 *  is unusable. */
const panelOpen = new Map();

export function panel(title, { open = true, note: noteText, id } = {}, ...body) {
  const isOpen = panelOpen.has(title) ? panelOpen.get(title) : open;
  const d = el('details', { class: 'sp-panel', open: isOpen, id });
  const sum = el('summary', { text: title });
  d.appendChild(sum);
  const inner = el('div', { class: 'sp-panel-body' }, noteText ? el('p', { class: 'sp-note', text: noteText }) : null, ...body);
  d.appendChild(inner);
  d.addEventListener('toggle', () => panelOpen.set(title, d.open));
  return d;
}

export function row(label, control, { title, wide } = {}) {
  return el('div', { class: `sp-row${wide ? ' wide' : ''}`, title },
    label ? el('label', { text: label }) : null,
    el('div', { class: 'sp-ctl' }, control));
}

export function button(label, onclick, { cls = 'sp-btn', title, id, disabled } = {}) {
  return el('button', { type: 'button', class: cls, onclick, title, id, disabled });
}

/** label text has to go in as text, not as an attribute */
export function btn(label, onclick, opts = {}) {
  const b = button(label, onclick, opts);
  b.textContent = label;
  return b;
}

export function slider({ get, onInput, onCommit, min = 0, max = 1, step = 0.01, fmt }) {
  const r = el('input', { type: 'range', min, max, step, value: get() });
  const n = el('input', { class: 'sp-num', type: 'number', min, max, step, value: round(get(), step) });
  const show = (v) => { r.value = v; n.value = round(v, step); };
  r.addEventListener('input', () => { const v = +r.value; n.value = round(v, step); if (onInput) onInput(v); });
  r.addEventListener('change', () => { if (onCommit) onCommit(+r.value); });
  n.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, +n.value || 0));
    show(v);
    if (onCommit) onCommit(v);
  });
  const wrap = el('div', { class: 'sp-ctl' }, r, n);
  wrap.sync = () => show(get());
  return wrap;
}

function round(v, step) {
  const dp = step >= 1 ? 0 : String(step).split('.')[1]?.length || 2;
  return Number(v).toFixed(dp);
}

export function number({ get, onCommit, min, max, step = 1 }) {
  const n = el('input', { class: 'sp-num', type: 'number', value: get(), min, max, step });
  n.addEventListener('change', () => {
    let v = +n.value || 0;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    n.value = v;
    onCommit(v);
  });
  n.sync = () => { n.value = get(); };
  return n;
}

export function select({ get, onCommit, options }) {
  const s = el('select', { class: 'sp-select' });
  for (const o of options) {
    const [value, label] = Array.isArray(o) ? o : [o, o];
    s.appendChild(el('option', { value, text: label }));
  }
  s.value = get();
  s.addEventListener('change', () => onCommit(s.value));
  s.sync = () => { s.value = get(); };
  return s;
}

/** A grouped select, for the 27 blend modes. */
export function selectGroups({ get, onCommit, groups }) {
  const s = el('select', { class: 'sp-select' });
  for (const [groupLabel, items] of groups) {
    const g = el('optgroup', { label: groupLabel });
    for (const [value, label] of items) g.appendChild(el('option', { value, text: label }));
    s.appendChild(g);
  }
  s.value = get();
  s.addEventListener('change', () => onCommit(s.value));
  s.sync = () => { s.value = get(); };
  return s;
}

export function checkbox({ get, onCommit, label }) {
  const i = el('input', { type: 'checkbox' });
  i.checked = !!get();
  i.addEventListener('change', () => onCommit(i.checked));
  const l = el('label', { class: 'sp-ctl', style: { cursor: 'pointer' } }, i, el('span', { text: label || '' }));
  l.sync = () => { i.checked = !!get(); };
  return l;
}

export function text({ get, onCommit, placeholder }) {
  const i = el('input', { class: 'sp-text', type: 'text', value: get() || '', placeholder });
  i.addEventListener('change', () => onCommit(i.value));
  // A global hotkey must not fire while someone is typing a layer name.
  i.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') i.blur();
  });
  i.sync = () => { if (document.activeElement !== i) i.value = get() || ''; };
  return i;
}

export function colorInput({ get, onInput, onCommit }) {
  const i = el('input', { type: 'color', value: get() });
  i.addEventListener('input', () => { if (onInput) onInput(i.value); });
  i.addEventListener('change', () => { if (onCommit) onCommit(i.value); });
  i.sync = () => { i.value = get(); };
  return i;
}

let toastTimer = null;
export function toast(msg, { bad = false, ms = 2600 } = {}) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `sp-toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'sp-toast'; }, ms);
}

let hintTimer = null;
export function hint(msg, ms = 4200) {
  const h = document.getElementById('hint');
  if (!h) return;
  h.textContent = msg || '';
  h.className = msg ? 'sp-stage-hint show' : 'sp-stage-hint';
  clearTimeout(hintTimer);
  if (msg) hintTimer = setTimeout(() => { h.className = 'sp-stage-hint'; }, ms);
}

/**
 * A modal with OK/Cancel. Resolves to true on OK.
 *
 * `onLive` is called whenever a control changes, for a live preview; the
 * caller is responsible for reverting if the dialog is cancelled.
 */
export function modal(title, body, { okLabel = 'OK', cancelLabel = 'Cancel', onOk, onCancel, wide } = {}) {
  const dlg = document.getElementById('modal');
  const head = document.getElementById('modal-head');
  const bodyEl = document.getElementById('modal-body');
  const foot = document.getElementById('modal-foot');
  head.textContent = title;
  setChildren(bodyEl, body);
  if (wide) dlg.style.maxWidth = '720px'; else dlg.style.removeProperty('max-width');
  return new Promise((resolve) => {
    const finish = (okPressed) => {
      dlg.removeEventListener('close', onClose);
      if (okPressed) { if (onOk) onOk(); } else if (onCancel) onCancel();
      resolve(okPressed);
    };
    const onClose = () => finish(dlg.returnValue === 'ok');
    const ok = btn(okLabel, () => { dlg.returnValue = 'ok'; dlg.close('ok'); }, { cls: 'sp-btn sp-primary' });
    const cancel = btn(cancelLabel, () => { dlg.returnValue = 'cancel'; dlg.close('cancel'); });
    setChildren(foot, cancel, ok);
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', onClose, { once: true });
    dlg.showModal();
    ok.focus();
  });
}

export function closeModal() {
  const dlg = document.getElementById('modal');
  if (dlg && dlg.open) dlg.close('cancel');
}

/** Trigger a download. Revokes the URL, which is otherwise a leak per save. */
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A dropdown menu button. Items are {label, key, run, disabled, sep, head}. */
export function dropdown(label, itemsFn) {
  const wrap = el('div', { class: 'sp-drop' });
  const b = btn(label, () => {
    const isOpen = wrap.classList.contains('open');
    document.querySelectorAll('.sp-drop.open').forEach((d) => d.classList.remove('open'));
    if (!isOpen) {
      setChildren(list, ...itemsFn().map(renderItem));
      wrap.classList.add('open');
      place();
    }
  });
  const list = el('div', { class: 'sp-drop-list', role: 'menu' });
  wrap.append(b, list);

  // The list is position:fixed so it escapes .sp-top's overflow clip (see the
  // .sp-drop-list rule in style.css for why). Fixed means viewport
  // coordinates, so they are computed here rather than written in CSS, and
  // refreshed by the listeners below whenever the page moves underneath.
  function place() {
    const r = b.getBoundingClientRect();
    list.style.top = `${Math.round(r.bottom)}px`;
    // Hang it off the button's left edge, but never off the side of the
    // screen -- the rightmost menus open near the edge of a phone, where a
    // 212px list would otherwise lay half of itself out of view.
    const w = list.offsetWidth || 212;
    const left = Math.min(r.left, Math.max(4, window.innerWidth - w - 4));
    list.style.left = `${Math.round(Math.max(4, left))}px`;
    // Only as tall as the room actually below the button. Without this the
    // 39-item Filter menu runs off the bottom of a short window with no way
    // to reach the end of it.
    const room = window.innerHeight - r.bottom - 8;
    list.style.maxHeight = `${Math.round(Math.max(160, Math.min(540, room)))}px`;
  }
  wrap._placeDropList = place;

  function renderItem(it) {
    if (it.sep) return el('hr');
    if (it.head) return el('div', { class: 'sp-drop-head', text: it.head });
    const row2 = el('button', { type: 'button', disabled: !!it.disabled, onclick: () => {
      wrap.classList.remove('open');
      it.run();
    } }, el('span', { text: it.label }), it.key ? el('span', { class: 'sp-key', text: it.key }) : null);
    return row2;
  }
  return wrap;
}

// One global click closes any open dropdown. Registered once.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sp-drop')) {
    document.querySelectorAll('.sp-drop.open').forEach((d) => d.classList.remove('open'));
  }
});

// A fixed list does not travel with the button it hangs off, so anything that
// moves that button has to move the list too. Scroll is captured because it
// fires on .sp-top itself (the menu bar scrolls sideways on a narrow screen)
// and scroll events do not bubble.
function repositionOpenDropdown() {
  const open = document.querySelector('.sp-drop.open');
  if (open && open._placeDropList) open._placeDropList();
}
window.addEventListener('resize', repositionOpenDropdown);
document.addEventListener('scroll', repositionOpenDropdown, true);

// Escape closes the menu, which a keyboard user otherwise could not do.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.sp-drop.open');
  if (!open.length) return;
  open.forEach((d) => d.classList.remove('open'));
});
