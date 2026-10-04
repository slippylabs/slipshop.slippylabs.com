// Oracle: the document model. Structure, not pixels -- which is why it is all
// exact statements rather than a comparison against anything.

import { Doc, Layer, newDoc, validate, newId, resetIds, LAYER_TYPES } from '../js/core/doc.js';
import { Surface } from '../js/core/tiles.js';
import { MODES } from '../js/core/blend.js';
import { rect } from '../js/core/util.js';
import { ok, eq, note, done } from './_harness.mjs';

// ----------------------------------------------------------------- ordering
// Bottom-first is the single most load-bearing convention in the engine: the
// compositor walks the array forwards. Getting it backwards inverts every
// document and looks like a blend-mode bug.
{
  resetIds();
  const d = newDoc(16, 16);
  eq(d.layers.length, 1, 'File > New makes exactly one layer');
  eq(d.layers[0].name, 'Background', 'and it is the Background');
  const mid = d.addLayer(new Layer({ type: 'raster', name: 'mid' }));
  const top = d.addLayer(new Layer({ type: 'raster', name: 'top' }));
  eq(d.layers.map((l) => l.name).join(','), 'Background,mid,top', 'addLayer appends to the TOP (bottom-first array)');
  const ins = d.addLayer(new Layer({ type: 'raster', name: 'ins' }), 1);
  eq(d.layers.map((l) => l.name).join(','), 'Background,ins,mid,top', 'addLayer with an index inserts there');
  eq(d.layers[0].name, 'Background', 'index 0 is still the bottom of the stack');
}

// ----------------------------------------------------------------- defaults
{
  const l = new Layer({});
  eq(l.type, 'raster', 'a layer defaults to raster');
  eq(l.blend, 'normal', 'and to normal blend');
  eq(l.opacity, 1, 'and full opacity');
  eq(l.fillOpacity, 1, 'and full fill opacity');
  ok(l.visible, 'and visible');
  ok(!l.clipping, 'and not clipping');
  eq(l.mask, null, 'and unmasked');
  eq(l.children, null, 'a raster layer has no children array at all');
  const g = new Layer({ type: 'group' });
  eq(g.blend, 'pass-through', 'a group defaults to pass-through, as Photoshop does');
  ok(Array.isArray(g.children), 'and has a children array');
  eq(g.effectiveBlend, 'normal', 'pass-through behaves as normal when it has to be a mode');
  // Opacity is clamped on the way in, so nothing downstream has to.
  eq(new Layer({ opacity: 5 }).opacity, 1, 'opacity above 1 is clamped');
  eq(new Layer({ opacity: -2 }).opacity, 0, 'opacity below 0 is clamped');
  let threw = false;
  try { new Layer({ type: 'nonsense' }); } catch (e) { threw = true; }
  ok(threw, 'an unknown layer type throws at construction, not at composite time');
}

// -------------------------------------------------------------- isolation
// The rule: a group is isolated unless it is pass-through AND has nothing
// that would need a single result to act on (an opacity or a mask).
{
  const kids = () => [new Layer({ type: 'raster' })];
  const pt = new Layer({ type: 'group', children: kids() });
  eq(pt.isolated, false, 'pass-through at full opacity with no mask is NOT isolated');
  eq(typeof pt.isolated, 'boolean', 'and isolated is a boolean, never null');
  eq(new Layer({ type: 'group', blend: 'multiply', children: kids() }).isolated, true,
    'any real blend mode isolates the group');
  eq(new Layer({ type: 'group', opacity: 0.5, children: kids() }).isolated, true,
    'a pass-through group with opacity is isolated -- there must be one result to scale');
  const masked = new Layer({ type: 'group', children: kids() });
  masked.mask = new Surface(4, 4, 1, 8);
  eq(masked.isolated, true, 'a pass-through group with a mask is isolated too');
  masked.maskEnabled = false;
  eq(masked.isolated, false, 'a disabled mask does not isolate it');
  eq(new Layer({ type: 'raster', blend: 'multiply' }).isolated, false, 'a raster layer is never isolated');
}

// ------------------------------------------------------------ walk / locate
{
  resetIds();
  const d = new Doc({ w: 8, h: 8 });
  const a = d.addLayer(new Layer({ type: 'raster', name: 'a' }));
  const g = d.addLayer(new Layer({ type: 'group', name: 'g' }));
  const b = new Layer({ type: 'raster', name: 'b' });
  const g2 = new Layer({ type: 'group', name: 'g2' });
  const c = new Layer({ type: 'raster', name: 'c' });
  g2.children.push(c);
  g.children.push(b, g2);
  const order = [...d.walk()].map((x) => `${x.layer.name}@${x.depth}`).join(' ');
  eq(order, 'a@0 g@0 b@1 g2@1 c@2', 'walk is depth-first and bottom-first, with depths');
  eq(d.layerCount, 5, 'layerCount counts nested layers');
  eq(d.find(c.id), c, 'find reaches a nested layer');
  eq(d.find('nope'), null, 'find returns null for an unknown id');
  const loc = d.locate(c.id);
  eq(loc.list, g2.children, 'locate returns the containing list');
  eq(loc.index, 0, 'and the index in it');
  eq(loc.parent, g2, 'and the parent group');
  eq(d.locate(a.id).parent, null, 'a top-level layer has a null parent');
  eq(d.locate('nope'), null, 'locate returns null for an unknown id');
}

// ----------------------------------------------------------------- validate
{
  const d = newDoc(32, 24);
  eq(JSON.stringify(validate(d)), '[]', 'a fresh document validates clean');

  const bad1 = newDoc(32, 24);
  bad1.layers[0].blend = 'nope';
  eq(validate(bad1).length, 1, 'an unknown blend mode is reported');

  const bad2 = newDoc(32, 24);
  bad2.addLayer(new Layer({ type: 'raster', surface: new Surface(10, 10, 4, 8) }));
  ok(validate(bad2).some((p) => p.includes('surface is 10x10')), 'a wrong-sized surface is reported');

  const bad3 = newDoc(32, 24);
  const l3 = bad3.addLayer(new Layer({ type: 'raster' }));
  l3.mask = new Surface(32, 24, 4, 8);           // 4 channels, not 1
  ok(validate(bad3).some((p) => p.includes('must be 1 channel')), 'a multi-channel mask is reported');

  const bad4 = newDoc(32, 24);
  bad4.addLayer(new Layer({ type: 'adjustment' }));
  ok(validate(bad4).some((p) => p.includes('no adjust spec')), 'an adjustment layer with no spec is reported');

  // The same layer object in two places is a cycle waiting to happen, and the
  // compositor would draw it twice.
  const bad5 = newDoc(32, 24);
  const shared = new Layer({ type: 'raster', surface: bad5.newSurface(4) });
  const g = bad5.addLayer(new Layer({ type: 'group' }));
  g.children.push(shared);
  bad5.layers.push(shared);
  ok(validate(bad5).some((p) => p.includes('appears twice')), 'a layer reachable twice is reported');

  // A group nested past the guard must be reported, not recursed into forever.
  const bad6 = newDoc(8, 8);
  let cur = bad6.addLayer(new Layer({ type: 'group' }));
  for (let i = 0; i < 40; i++) { const g2 = new Layer({ type: 'group' }); cur.children.push(g2); cur = g2; }
  ok(validate(bad6).some((p) => p.includes('deeper than 32')), 'runaway nesting is reported rather than hanging');

  // A group may carry pass-through, which is not a blend mode -- validate must
  // not reject it, and must still reject a bogus one.
  const okG = newDoc(8, 8);
  okG.addLayer(new Layer({ type: 'group', blend: 'pass-through' }));
  eq(JSON.stringify(validate(okG)), '[]', 'pass-through is accepted on a group');
  const badG = newDoc(8, 8);
  const gg = badG.addLayer(new Layer({ type: 'group' }));
  gg.blend = 'not-a-mode';
  eq(validate(badG).length, 1, 'but a bogus group blend is still rejected');
  // ...and pass-through is NOT valid on a raster layer.
  const badR = newDoc(8, 8);
  badR.layers[0].blend = 'pass-through';
  eq(validate(badR).length, 1, 'pass-through on a raster layer is rejected');
}

// -------------------------------------------------------------------- misc
{
  let threw = 0;
  for (const bad of [[0, 10], [10, 0], [-1, 5], [1.5, 5]]) {
    try { new Doc({ w: bad[0], h: bad[1] }); } catch (e) { threw++; }
  }
  eq(threw, 4, 'a non-positive or fractional document size throws');

  resetIds(1);
  const a = newId(), b = newId();
  ok(a !== b, 'ids are unique');
  eq(a, 'l1', 'and deterministic after resetIds, so a test can assert on them');
  eq(newId('m'), 'm3', 'a prefix is honoured and shares the counter');

  const d = newDoc(300, 200);
  eq(d.byteLength, d.layers[0].surface.byteLength, 'byteLength sums the layer surfaces');
  const empty = new Doc({ w: 300, h: 200 });
  empty.addLayer(new Layer({ type: 'raster' }));
  eq(empty.byteLength, 0, 'an untouched layer costs nothing, because its tiles are unallocated');
  eq(JSON.stringify(d.bounds), JSON.stringify(rect(0, 0, 300, 200)), 'bounds');
  eq(d.newSurface(1).channels, 1, 'newSurface honours the channel count');
  eq(d.newSurface(4).depth, d.depth, 'and inherits the document depth');
}

note('structure only: ordering, isolation, validation. The pixels are composite.mjs.');
done('the document model holds its invariants');
