// Oracle: undo.
//
// The property is simple to state and brutal to satisfy: after ANY sequence of
// edits, undoing all of them must return the document bit-for-bit to where it
// started, and redoing them must return it bit-for-bit to where it ended. Not
// "look the same" -- identical, including which tiles are allocated.
//
// It is checked by recording a digest of the whole document after every step
// and then walking history at random, asserting the digest matches the one
// recorded for that position. A random walk finds the ordering bugs a
// straight undo-all never reaches: redo after a new edit, undo past a
// coalesced drag, a structural change sandwiched between two pixel changes.
//
// The second claim is about MEMORY, and it is the reason the engine is tiled
// at all: the history must store no more tiles than the edits actually
// touched. A snapshot-per-edit design passes the correctness property and
// fails this one, which is why both are here.

import { Doc, Layer, newDoc, resetIds } from '../js/core/doc.js';
import { History, edit } from '../js/core/history.js';
import { compositeDoc } from '../js/core/composite.js';
import { Surface, TILE } from '../js/core/tiles.js';
import { MODES } from '../js/core/blend.js';
import { rect, mulberry32, rectIntersect, rectEmpty } from '../js/core/util.js';
import { ok, eq, note, done } from './_harness.mjs';

// Not a multiple of TILE in either axis, and more than one tile in both, so
// seams and ragged edges are both in play. Kept small deliberately: the digest
// composites the whole document after every step and again on every move of
// the random walk, so this size is multiplied by about 560.
const W = 330, H = 270;

/** Everything that defines the document's observable state. */
function digest(doc) {
  const px = compositeDoc(doc, doc.bounds);
  let hash = 2166136261;
  for (let i = 0; i < px.length; i++) {
    const v = Math.round(px[i] * 65535);
    hash ^= v; hash = Math.imul(hash, 16777619);
  }
  const tree = [...doc.walk()].map(({ layer, depth }) =>
    [depth, layer.id, layer.type, layer.name, layer.visible, layer.opacity,
     layer.fillOpacity, layer.blend, layer.clipping, layer.maskEnabled,
     layer.surface ? layer.surface.tileCount : -1,
     layer.mask ? layer.mask.tileCount : -1].join('|')).join(';');
  return `${hash >>> 0}/${tree}`;
}

// ------------------------------------------------------- the random walk

resetIds(1);
const doc = newDoc(W, H);
const hist = new History({ limit: 1000 });
const rnd = mulberry32(0x5EED17);

/** A record of the state after each committed step. 0 is the initial state. */
const states = [digest(doc)];
let touchedTileBudget = 0;

function randRect() {
  const w = 1 + Math.floor(rnd() * 300);
  const h = 1 + Math.floor(rnd() * 300);
  return rect(Math.floor(rnd() * W) - 50, Math.floor(rnd() * H) - 50, w, h);
}

function tilesSpanned(surface, r) {
  const span = surface.tileSpan(r);
  if (!span) return 0;
  return (span.x1 - span.x0 + 1) * (span.y1 - span.y0 + 1);
}

const STEPS = 160;
let noops = 0;
for (let step = 0; step < STEPS; step++) {
  const entriesBefore = hist.past.length;
  const kind = rnd();
  const rasters = [...doc.walk()].map((x) => x.layer).filter((l) => l.type === 'raster');

  if (kind < 0.4 && rasters.length) {
    // paint: a pixel edit through the guarded helper
    const L = rasters[Math.floor(rnd() * rasters.length)];
    const r = randRect();
    const clipped = rectIntersect(r, doc.bounds);
    touchedTileBudget += tilesSpanned(L.surface, r);
    edit(hist, doc, `paint ${step}`, L.surface, r, () => {
      if (rectEmpty(clipped)) return;
      const buf = new Float32Array(clipped.w * clipped.h * 4);
      for (let i = 0; i < buf.length; i++) buf[i] = rnd();
      L.surface.writeRect(clipped, buf);
    });
  } else if (kind < 0.5 && rasters.length) {
    // erase
    const L = rasters[Math.floor(rnd() * rasters.length)];
    const r = randRect();
    touchedTileBudget += tilesSpanned(L.surface, r);
    edit(hist, doc, `erase ${step}`, L.surface, r, () => { L.surface.clearRect(r); });
  } else if (kind < 0.62) {
    // add a layer -- structural
    hist.begin(`add ${step}`, doc);
    const l = new Layer({ type: rnd() < 0.2 ? 'group' : 'raster', blend: MODES[Math.floor(rnd() * MODES.length)] });
    if (l.type === 'raster') l.surface = doc.newSurface(4);
    if (l.type === 'group') {
      // A group with no children makes "the snapshot lost the children"
      // unobservable, which is how that control slipped through once.
      const kn = 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < kn; k++) {
        const kid = new Layer({ type: 'raster', blend: MODES[Math.floor(rnd() * MODES.length)] });
        kid.surface = doc.newSurface(4);
        const kr = rect(Math.floor(rnd() * 300), Math.floor(rnd() * 300), 60, 60);
        const kb = new Float32Array(60 * 60 * 4);
        for (let i = 0; i < kb.length; i++) kb[i] = rnd();
        kid.surface.writeRect(kr, kb);
        l.children.push(kid);
      }
    }
    doc.layers.splice(Math.floor(rnd() * (doc.layers.length + 1)), 0, l);
    hist.commit();
  } else if (kind < 0.72 && doc.layers.length > 1) {
    // delete a layer -- structural
    hist.begin(`delete ${step}`, doc);
    doc.layers.splice(Math.floor(rnd() * doc.layers.length), 1);
    hist.commit();
  } else if (kind < 0.82 && doc.layers.length > 1) {
    // reorder -- structural
    hist.begin(`reorder ${step}`, doc);
    const from = Math.floor(rnd() * doc.layers.length);
    const to = Math.floor(rnd() * doc.layers.length);
    const [l] = doc.layers.splice(from, 1);
    doc.layers.splice(to, 0, l);
    hist.commit();
  } else if (kind < 0.92) {
    // a property drag: MANY changes, which must collapse to one undo step
    const all = [...doc.walk()].map((x) => x.layer);
    const L = all[Math.floor(rnd() * all.length)];
    const label = `opacity ${step}`;
    for (let i = 0; i < 25; i++) {
      hist.begin(label, doc);           // same label: coalesces
      L.opacity = rnd();
    }
    hist.commit();
  } else if (rasters.length) {
    // add or toggle a mask -- structural plus pixels
    const L = rasters[Math.floor(rnd() * rasters.length)];
    hist.begin(`mask ${step}`, doc);
    if (!L.mask) {
      L.mask = doc.newSurface(1);
      const r = rect(0, 0, 200, 150);
      hist.touch(L.mask, r);
      touchedTileBudget += tilesSpanned(L.mask, r);
      const m = new Float32Array(200 * 150);
      for (let i = 0; i < m.length; i++) m[i] = rnd();
      L.mask.writeRect(r, m);
    } else {
      L.maskEnabled = !L.maskEnabled;
    }
    hist.commit();
  } else {
    continue;
  }
  // A step whose rect fell entirely outside the document changes nothing and
  // must push NO entry -- an undo step that does nothing is a real annoyance,
  // so the absence is the correct behaviour and is recorded as such.
  if (hist.past.length > entriesBefore) states.push(digest(doc));
  else noops += 1;
}

note(`${STEPS} steps -> ${hist.past.length} undo entries (${noops} steps were no-ops and correctly pushed nothing), ${states.length} recorded states`);
eq(hist.past.length, states.length - 1, 'each effective step produced exactly one undo entry (drags coalesced)');
ok(noops > 0, 'the sweep included at least one no-op edit, so the "pushes nothing" path is exercised');

// ----------------------------------------------- undo all the way back
let pos = states.length - 1;
while (hist.canUndo) { hist.undo(doc); pos--; }
eq(pos, 0, 'undoing everything walks back to step 0');
eq(digest(doc), states[0], 'the document is BIT-IDENTICAL to its initial state');

// ----------------------------------------------- redo all the way forward
while (hist.canRedo) { hist.redo(doc); pos++; }
eq(pos, states.length - 1, 'redoing everything walks forward to the last step');
eq(digest(doc), states[states.length - 1], 'the document is BIT-IDENTICAL to its final state');

// ----------------------------------------------- a random walk through history
let mismatches = 0;
for (let i = 0; i < 400; i++) {
  if (rnd() < 0.5) { if (hist.canUndo) { hist.undo(doc); pos--; } }
  else { if (hist.canRedo) { hist.redo(doc); pos++; } }
  if (digest(doc) !== states[pos]) mismatches++;
}
eq(mismatches, 0, `400 random undo/redo moves all landed on the recorded state`);

// ----------------------------------------------- memory
note(`history holds ${hist.tileCount} tile records for ${touchedTileBudget} tile-touches, ${(hist.byteLength / 1048576).toFixed(1)} MB`);
ok(hist.tileCount <= touchedTileBudget,
  `history stores no more tiles than the edits touched (${hist.tileCount} <= ${touchedTileBudget})`);
// The decisive comparison: what a snapshot-per-edit design would have cost.
const snapshotCost = (states.length - 1) * W * H * 4;
ok(hist.byteLength < snapshotCost,
  `and far less than a layer snapshot per edit would (${(hist.byteLength / 1048576).toFixed(1)} MB vs ${(snapshotCost / 1048576).toFixed(0)} MB)`);

// ----------------------------------------------- the smaller guarantees
{
  resetIds(1);
  const d = newDoc(300, 200);
  const h = new History({ limit: 3 });
  const L = d.addLayer(new Layer({ type: 'raster' }));
  for (let i = 0; i < 6; i++) {
    edit(h, d, `s${i}`, L.surface, rect(0, 0, 10, 10), () => {
      L.surface.writeRect(rect(0, 0, 10, 10), new Float32Array(400).fill(i / 10));
    });
  }
  eq(h.past.length, 3, 'the history respects its limit');
  eq(h.labels.past.join(','), 's3,s4,s5', 'and drops the OLDEST entries, keeping the newest');
}

{
  resetIds(1);
  const d = newDoc(300, 200);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster' }));
  const paint = (v) => edit(h, d, `p${v}`, L.surface, rect(0, 0, 10, 10), () => {
    L.surface.writeRect(rect(0, 0, 10, 10), new Float32Array(400).fill(v));
  });
  paint(0.25); paint(0.5);
  h.undo(d);
  ok(h.canRedo, 'after an undo there is something to redo');
  paint(0.75);
  ok(!h.canRedo, 'a NEW edit after an undo discards the redo branch');
  eq(L.surface.getPixel(0, 0)[0], 0.75, 'and the new edit is what is on the canvas', 0.004);
  h.undo(d);
  // 0.25 stores as 64/255 at 8 bits, so compare with a quantisation tolerance
  eq(L.surface.getPixel(0, 0)[0], 0.25, 'undoing it returns to the state before it', 0.004);
}

{
  const d = newDoc(100, 100);
  const h = new History();
  let threw = false;
  try { h.touch(d.layers[0].surface, rect(0, 0, 4, 4)); } catch (e) { threw = true; }
  ok(threw, 'touch() outside a transaction throws rather than silently losing the undo');
  eq(h.commit(), null, 'committing nothing pushes nothing');
  eq(h.undo(d), null, 'undo with an empty history returns null');
  eq(h.redo(d), null, 'redo with an empty history returns null');
}

{
  // A structural snapshot holds surfaces by REFERENCE, so undoing a rename
  // must not revert pixels painted after it.
  resetIds(1);
  const d = newDoc(200, 200);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster', name: 'before' }));
  h.begin('rename', d);
  L.name = 'after';
  h.commit();
  edit(h, d, 'paint', L.surface, rect(0, 0, 8, 8), () => {
    L.surface.writeRect(rect(0, 0, 8, 8), new Float32Array(256).fill(1));
  });
  h.undo(d);                      // undo the paint
  h.undo(d);                      // undo the rename
  eq(d.find(L.id).name, 'before', 'undoing a rename restores the name');
  const L2 = d.find(L.id);
  eq(L2.surface.getPixel(0, 0)[3], 0, 'and the pixels are at their pre-paint state (both undone)');

  h.redo(d); h.redo(d);
  eq(d.find(L.id).name, 'after', 'redo restores the rename');
  eq(d.find(L.id).surface.getPixel(0, 0)[3], 1, 'and the paint');
}

{
  // abort() must forget the transaction without pushing anything.
  const d = newDoc(100, 100);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster' }));
  h.begin('x', d);
  h.touch(L.surface, rect(0, 0, 4, 4));
  h.abort();
  eq(h.past.length, 0, 'abort() pushes nothing');
  ok(!h.canUndo, 'and leaves nothing to undo');
}

{
  // Coalescing only applies to the SAME label; a different one must split.
  const d = newDoc(100, 100);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster', name: 'n' }));
  h.begin('a', d); L.opacity = 0.5;
  h.begin('a', d); L.opacity = 0.4;
  h.begin('b', d); L.opacity = 0.3;
  h.commit();
  eq(h.past.length, 2, 'a different label commits the previous transaction');
  eq(h.labels.past.join(','), 'a,b', 'and both are recorded in order');
}

{
  // An edit that touches nothing must not leave an empty step behind.
  const d = newDoc(100, 100);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster' }));
  edit(h, d, 'offscreen', L.surface, rect(-900, -900, 10, 10), () => {});
  eq(h.past.length, 0, 'an edit entirely outside the document pushes no undo entry');
  ok(!h.canUndo, 'and leaves nothing to undo');
}

{
  // A BRUSH STROKE touches the same tiles over and over inside one
  // transaction, and only the FIRST capture is the original. Re-capturing on
  // a later dab would store a half-painted tile and undo would leave the
  // stroke half there. Nothing else in this oracle exercises that, which is
  // how the control for it was missed.
  resetIds(1);
  const d = newDoc(400, 300);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster' }));
  // paint a known background first, so "original" is not just transparent
  edit(h, d, 'base', L.surface, d.bounds, () => {
    L.surface.fill([0.2, 0.4, 0.6, 1]);
  });
  const before = L.surface.readRect(d.bounds);

  h.begin('Brush', null);
  const dab = new Float32Array(30 * 30 * 4).fill(1);
  let dabs = 0;
  for (let i = 0; i < 40; i++) {
    // a walk that keeps coming back over the same tiles
    const r = rect(60 + (i % 7) * 9, 60 + (i % 5) * 11, 30, 30);
    h.touch(L.surface, r);
    L.surface.writeRect(r, dab);
    dabs++;
  }
  h.commit();
  eq(h.past.length, 2, `a ${dabs}-dab stroke is one undo entry`);
  const painted = L.surface.readRect(d.bounds);
  let changed = 0;
  for (let i = 0; i < painted.length; i++) if (painted[i] !== before[i]) changed++;
  ok(changed > 1000, 'the stroke really changed a lot of pixels');
  h.undo(d);
  const after = L.surface.readRect(d.bounds);
  let diff = 0;
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) diff++;
  eq(diff, 0, 'undoing the stroke restores the ORIGINAL tiles, not a half-painted one');
  h.redo(d);
  const re = L.surface.readRect(d.bounds);
  let rdiff = 0;
  for (let i = 0; i < re.length; i++) if (re[i] !== painted[i]) rdiff++;
  eq(rdiff, 0, 'and redo puts the finished stroke back exactly');
}

{
  // A group with children, through a structural undo.
  resetIds(1);
  const d = newDoc(200, 150);
  const h = new History();
  h.begin('add group', d);
  const g = new Layer({ type: 'group', name: 'G', blend: 'multiply' });
  const k1 = new Layer({ type: 'raster', name: 'k1', surface: d.newSurface(4) });
  const k2 = new Layer({ type: 'raster', name: 'k2', surface: d.newSurface(4) });
  k1.surface.fill([1, 0, 0, 1]);
  k2.surface.fill([0, 0, 1, 0.5]);
  g.children.push(k1, k2);
  d.layers.push(g);
  h.commit();
  eq(d.layerCount, 4, 'the group and its two children are in the document');
  h.undo(d);
  eq(d.layerCount, 1, 'undo removes the group and its children');
  h.redo(d);
  eq(d.layerCount, 4, 'redo brings all three back');
  const back = d.find(g.id);
  ok(back && back.children && back.children.length === 2, 'and the group still HAS its two children');
  eq(back.children.map((c) => c.name).join(','), 'k1,k2', 'in the same order');
  eq(back.children[0].surface.getPixel(0, 0)[0], 1, 'with their pixels intact', 0.004);
  eq(back.blend, 'multiply', 'and the group keeps its blend mode');
}

{
  // offset is the one MUTABLE ARRAY on a layer. If the snapshot stores the
  // same array object, mutating it in place changes the snapshot too and the
  // undo is a no-op.
  resetIds(1);
  const d = newDoc(100, 100);
  const h = new History();
  const L = d.addLayer(new Layer({ type: 'raster' }));
  L.offset = [0, 0];
  h.begin('move', d);
  L.offset[0] = 25;                     // mutated IN PLACE, not reassigned
  L.offset[1] = -9;
  h.commit();
  eq(d.find(L.id).offset.join(','), '25,-9', 'the move took effect');
  h.undo(d);
  eq(d.find(L.id).offset.join(','), '0,0', 'undo restores the offset -- the snapshot copied the array');
  h.redo(d);
  eq(d.find(L.id).offset.join(','), '25,-9', 'and redo reapplies it');
}

done('undo is exact in both directions, coalesces drags, and costs only the tiles touched');
