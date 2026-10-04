#!/usr/bin/env bash
# Re-introduce each bug the engine exists to prevent, one at a time, and
# confirm the oracle that guards it FAILS. An oracle that cannot fail proves
# nothing -- two of the first controls written here did not fire, and both
# times the oracle was wrong rather than the control.
#
# Every mutation is applied to the real working tree and reverted from a
# backup, even on Ctrl-C. Run it ALONE: never alongside run_all.sh or a
# browser suite.
#
# ONLY=<regex> controls.sh   runs a subset.
# If you edit a line a control mutates, update its FROM string or the whole
# run aborts with "could not apply".
set -uo pipefail
cd "$(dirname "$0")/.."

declare -a NAMES FILES FROMS TOS TESTS
add() { NAMES+=("$1"); FILES+=("$2"); FROMS+=("$3"); TOS+=("$4"); TESTS+=("$5"); }

# ---------------------------------------------------------------- blend.js
add "overlay arguments not swapped" js/core/blend.js \
  'const overlay = (b, s) => hardLight(s, b);' \
  'const overlay = (b, s) => hardLight(b, s);' blend

add "Lum() uses Rec.709 instead of the spec weights" js/core/blend.js \
  'export const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;' \
  'export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;' blend

add "color-dodge degenerate cases in the wrong order" js/core/blend.js \
  '  if (b === 0) return 0;              // order matters: dodge(0,1) is 0, not 1
  if (s === 1) return 1;' \
  '  if (s === 1) return 1;
  if (b === 0) return 0;' blend

add "color-burn degenerate cases in the wrong order" js/core/blend.js \
  '  if (b === 1) return 1;              // order matters: burn(1,0) is 1, not 0
  if (s === 0) return 0;' \
  '  if (s === 0) return 0;
  if (b === 1) return 1;' blend

add "the (1 - ab) term dropped from the blend step" js/core/blend.js \
  'const cr = (1 - ab) * cs[i] + ab * b[i];' \
  'const cr = b[i];' blend

add "soft-light D() threshold at 0.5 not 0.25" js/core/blend.js \
  'const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);' \
  'const d = b <= 0.5 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);' blend

add "exclusion missing its factor of 2" js/core/blend.js \
  'const exclusion = (b, s) => b + s - 2 * b * s;' \
  'const exclusion = (b, s) => b + s - b * s;' blend

add "hard-light missing the -1 on the screen branch" js/core/blend.js \
  'const hardLight = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));' \
  'const hardLight = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s));' blend

add "composite forgets to un-premultiply" js/core/blend.js \
  '    out[i] = (as * cr + ab * cb[i] * (1 - as)) / ao;' \
  '    out[i] = (as * cr + ab * cb[i] * (1 - as));' blend

add "SetSat drops the - mn offset" js/core/blend.js \
  '    ((c[0] - mn) * s) / (mx - mn),' \
  '    (c[0] * s) / (mx - mn),' blend

add "Sat() is max instead of max - min" js/core/blend.js \
  'const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);' \
  'const sat = (c) => Math.max(c[0], c[1], c[2]);' blend

add "SetLum skips ClipColor (channels escape the cube)" js/core/blend.js \
  '  return clipColor([c[0] + d, c[1] + d, c[2] + d]);' \
  '  return [c[0] + d, c[1] + d, c[2] + d];' blend

# ---------------------------------------------------------------- color.js
add "the XYZ white point is the book value, not the matrix's own" js/core/color.js \
  'export const D65 = M_RGB2XYZ.map((row) => row[0] + row[1] + row[2]);' \
  'export const D65 = [0.95047, 1, 1.08883];' color

add "the XYZ->RGB matrix is typed, not inverted" js/core/color.js \
  'const M_XYZ2RGB = invert3(M_RGB2XYZ);' \
  'const M_XYZ2RGB = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];' color

add "the sRGB transfer function uses a plain 2.2 gamma" js/core/color.js \
  '  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);' \
  '  return Math.pow(c, 2.2);' color

add "Lab uses the rounded epsilon instead of 216/24389" js/core/color.js \
  'export const EPS = 216 / 24389;        // 0.008856451679...' \
  'export const EPS = 0.008856;        // 0.008856451679...' color

add "Lab uses the rounded kappa, so the toe is 7.787" js/core/color.js \
  'export const KAPPA = 24389 / 27;       // 903.296296..., so KAPPA/116 = 7.787037...' \
  'export const KAPPA = 7.787 * 116;       // 903.296296..., so KAPPA/116 = 7.787037...' color

add "OKLab skips the cube root" js/core/color.js \
  '  return mul3(M_LMS2OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));' \
  '  return mul3(M_LMS2OKLAB, lms[0], lms[1], lms[2]);' color

add "the OKLab inverses are the published ones, not computed" js/core/color.js \
  'const M_OKLAB2LMS = invert3(M_LMS2OKLAB);' \
  'const M_OKLAB2LMS = [[1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.2914855480]];' color

add "the HSL hue helper wraps the wrong third" js/core/color.js \
  '  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];' \
  '  return [f(h - 1 / 3), f(h), f(h + 1 / 3)];' color

add "CIEDE2000 averages h-prime without the 0/360 wrap cases" js/core/color.js \
  '  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;' \
  '  else if (true) hbarp = (h1p + h2p) / 2;' color

add "CIEDE2000 drops the RT rotation term" js/core/color.js \
  '  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);' \
  '  return Math.sqrt(tL * tL + tC * tC + tH * tH);' color

add "CIEDE2000 uses 25^7 wrong in the G factor" js/core/color.js \
  '  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));  // 25^7' \
  '  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 610351562)));  // 25^7' color

add "reflect() repeats the edge sample" js/core/util.js \
  '  const period = 2 * n - 2;' \
  '  const period = 2 * n;' util

add "round() is half-to-even instead of half-up" js/core/util.js \
  'export const round = (v) => Math.floor(v + 0.5);' \
  'export const round = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && (f & 1)) ? f + 1 : f; };' util

# ---------------------------------------------------------------- tiles.js
add "readRect ignores the document edge inside an edge tile" js/core/tiles.js \
  '        const ix1 = Math.min(r.x + r.w, ox + TILE, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        for (let y = iy0; y < iy1; y++) {
          let s = ((y - oy) * TILE + (ix0 - ox)) * C;' \
  '        const ix1 = Math.min(r.x + r.w, ox + TILE);
        const iy1 = Math.min(r.y + r.h, oy + TILE);
        for (let y = iy0; y < iy1; y++) {
          let s = ((y - oy) * TILE + (ix0 - ox)) * C;' tiles

add "readRect stops one pixel short of each tile edge (a seam every 256px)" js/core/tiles.js \
  '        const ix1 = Math.min(r.x + r.w, ox + TILE, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        for (let y = iy0; y < iy1; y++) {
          let s = ((y - oy) * TILE + (ix0 - ox)) * C;' \
  '        const ix1 = Math.min(r.x + r.w, ox + TILE - 1, this.w);
        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        for (let y = iy0; y < iy1; y++) {
          let s = ((y - oy) * TILE + (ix0 - ox)) * C;' tiles

add "tileIndex is transposed (row-major vs column-major)" js/core/tiles.js \
  '  tileIndex(tx, ty) { return ty * this.tx + tx; }' \
  '  tileIndex(tx, ty) { return tx * this.ty + ty; }' tiles

add "tileOrigin disagrees with tileIndex" js/core/tiles.js \
  '  tileOrigin(idx) { return [(idx % this.tx) * TILE, Math.floor(idx / this.tx) * TILE]; }' \
  '  tileOrigin(idx) { return [Math.floor(idx / this.tx) * TILE, (idx % this.tx) * TILE]; }' tiles

add "writeRect allocates a tile before checking the overlap is non-empty" js/core/tiles.js \
  '        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const t = this.ensure(tx, ty);' \
  '        const t = this.ensure(tx, ty);
        if (ix1 <= ix0 || iy1 <= iy0) continue;' tiles

add "clearRect deletes a tile it only partly covers" js/core/tiles.js \
  '        if (ix1 - ix0 === TILE && iy1 - iy0 === TILE) {' \
  '        if (ix1 - ix0 >= 1 && iy1 - iy0 >= 1) {' tiles

add "the reflect border repeats the edge sample" js/core/tiles.js \
  "      ? (i, n) => { const p = 2 * n - 2; if (n === 1) return 0; const k = ((i % p) + p) % p; return k < n ? k : p - k; }" \
  "      ? (i, n) => { const p = 2 * n; if (n === 1) return 0; const k = ((i % p) + p) % p; return k < n ? k : p - k - 1; }" tiles

add "the clamp border clamps to the tile, not the document" js/core/tiles.js \
  '      : (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);' \
  '      : (i, n) => (i < 0 ? 0 : i >= n ? n : i);' tiles

add "writeRect forgets to clip to the document height" js/core/tiles.js \
  '        const iy1 = Math.min(r.y + r.h, oy + TILE, this.h);
        if (ix1 <= ix0 || iy1 <= iy0) continue;' \
  '        const iy1 = Math.min(r.y + r.h, oy + TILE);
        if (ix1 <= ix0 || iy1 <= iy0) continue;' tiles

add "equals() treats an absent tile as different from an all-zero one" js/core/tiles.js \
  '          const av = a ? a[row + x] : 0;
          const bv = b ? b[row + x] : 0;' \
  '          const av = a ? a[row + x] : -1;
          const bv = b ? b[row + x] : 0;' tiles

add "equals() compares the dead corner outside the document too" js/core/tiles.js \
  '      const xEnd = Math.min(TILE, this.w - ox);
      const yEnd = Math.min(TILE, this.h - oy);
      if (xEnd <= 0 || yEnd <= 0) continue;            // wholly outside' \
  '      const xEnd = TILE;
      const yEnd = TILE;
      if (xEnd <= 0 || yEnd <= 0) continue;            // wholly outside' tiles

add "contentBounds reads channel 0 instead of alpha for RGBA" js/core/tiles.js \
  '    const aOff = C === 4 ? 3 : 0;      // alpha for RGBA, the value itself for a mask' \
  '    const aOff = 0;      // alpha for RGBA, the value itself for a mask' tiles

add "a transparent fill stores zeros instead of freeing the tiles" js/core/tiles.js \
  '    if (allZero) { this.tiles.clear(); return; }' \
  '    if (allZero) { /* keep them */ }' tiles

add "clone shares its tile arrays with the original" js/core/tiles.js \
  '    for (const [i, t] of this.tiles) s.tiles.set(i, t.slice());' \
  '    for (const [i, t] of this.tiles) s.tiles.set(i, t);' tiles

# ------------------------------------------------------------- composite.js
add "clipBase snapshots the accumulated backdrop, not the base layer" js/core/composite.js \
  '      clipBase = clipBase && clipBase.length === n ? clipBase : new Float32Array(n);
      clipBase.set(cov);' \
  '      clipBase = clipBase && clipBase.length === n ? clipBase : new Float32Array(n);
      for (let i = 0; i < n; i++) clipBase[i] = dst[i * 4 + 3];' composite

add "a clipping layer is clipped in colour instead of coverage" js/core/composite.js \
  '      for (let i = 0; i < n; i++) cov[i] *= clipBase[i];' \
  '      for (let i = 0; i < n; i++) src[i * 4] *= clipBase[i];' composite

add "a pass-through group is isolated instead" js/core/composite.js \
  '    if (layer.type === '"'"'group'"'"' && !layer.isolated) {' \
  '    if (false) {' composite

add "the layer mask multiplies colour rather than coverage" js/core/composite.js \
  '    for (let i = 0; i < n; i++) cov[i] *= m[i];' \
  '    for (let i = 0; i < n; i++) src[i * 4] *= m[i];' composite

add "a non-clipping layer does not reset the clip base" js/core/composite.js \
  '      if (!layer.clipping) clipBase = null;
      continue;
    }

    src.fill(0);' \
  '      continue;
    }

    src.fill(0);' composite

add "the hot loop drops the (1 - ab) term (copy number two)" js/core/composite.js \
  '        const cr = (1 - ab) * cs[c] + ab * b;' \
  '        const cr = b;' composite

add "the hot loop forgets to un-premultiply" js/core/composite.js \
  '        const v = (as * cr + ab * cb[c] * (1 - as)) / ao;
        dst[p + c] = linear ? linearToSrgb(v) : v;' \
  '        const v = (as * cr + ab * cb[c] * (1 - as));
        dst[p + c] = linear ? linearToSrgb(v) : v;' composite

add "output alpha uses the source alpha alone" js/core/composite.js \
  '    const ao = as + ab * (1 - as);
    if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }' \
  '    const ao = as;
    if (ao <= 0) { dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = 0; continue; }' composite

add "fillOpacity is ignored" js/core/composite.js \
  '  const o = layer.opacity * layer.fillOpacity;' \
  '  const o = layer.opacity;' composite

add "an invisible layer is composited anyway" js/core/composite.js \
  '    if (!layer.visible) continue;' \
  '    if (false) continue;' composite

# --------------------------------------------------------------- history.js
add "touch() re-captures a tile it already has (losing the original)" js/core/history.js \
  '        if (m.has(idx)) continue;                  // already captured this stroke' \
  '        if (false) continue;                  // already captured this stroke' history

add "swap() restores but does not record the other direction" js/core/history.js \
  '        const live = surface.tiles.get(idx);
        m.set(idx, live ? live : null);' \
  '        const live = surface.tiles.get(idx);' history

add "an unallocated tile is restored as an allocated zero tile" js/core/history.js \
  '        if (stored) surface.tiles.set(idx, stored);
        else surface.tiles.delete(idx);' \
  '        if (stored) surface.tiles.set(idx, stored);
        else surface.tiles.set(idx, new surface.Ctor(surface.tiles.values().next().value.length));' history

add "a new edit does not discard the redo branch" js/core/history.js \
  '    this.future.length = 0;
    if (this.onChange) this.onChange();
    return t;
  }' \
  '    if (this.onChange) this.onChange();
    return t;
  }' history

add "the history limit drops the NEWEST entry instead of the oldest" js/core/history.js \
  '    while (this.past.length > this.limit) this.past.shift();' \
  '    while (this.past.length > this.limit) this.past.pop();' history

add "begin() coalesces regardless of label, so everything is one step" js/core/history.js \
  '      if (this.open.label === label) return this.open;' \
  '      return this.open;' history

add "the structural snapshot CLONES surfaces instead of referencing them" js/core/history.js \
  '    o.surface = l.surface;                 // reference, never a copy' \
  '    o.surface = l.surface ? l.surface.clone() : null;' history

add "restoreTree forgets the children of a group" js/core/history.js \
  '    l.children = o.children ? restoreTree(o.children) : (o.type === '"'"'group'"'"' ? [] : null);' \
  '    l.children = o.type === '"'"'group'"'"' ? [] : null;' history

add "the tree snapshot shares its mutable arrays with the live layer" js/core/history.js \
  '    for (const k of LAYER_PROPS) o[k] = Array.isArray(l[k]) ? l[k].slice() : l[k];' \
  '    for (const k of LAYER_PROPS) o[k] = l[k];' history

add "edit() commits without recording the tiles first" js/core/history.js \
  '  history.begin(label, null);
  history.touch(surface, r);' \
  '  history.begin(label, null);' history

# ---------------------------------------------------------------- runner

BK=$(mktemp -d)
restore() {
  for f in "${FILES[@]}"; do
    b="$BK/$(echo "$f" | tr / _)"
    [ -f "$b" ] && cp "$b" "$f"
  done
}
trap restore EXIT INT TERM
for f in "${FILES[@]}"; do cp "$f" "$BK/$(echo "$f" | tr / _)"; done

ran=0; caught=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  if [ -n "${ONLY:-}" ] && ! echo "$name" | grep -qE "$ONLY"; then continue; fi
  file="${FILES[$i]}"; from="${FROMS[$i]}"; to="${TOS[$i]}"; test="${TESTS[$i]}"
  if ! FROM="$from" TO="$to" python3 - "$file" <<'PY'
import os, sys
p = sys.argv[1]
s = open(p).read()
a, b = os.environ['FROM'], os.environ['TO']
if a not in s:
    sys.exit(1)
open(p, 'w').write(s.replace(a, b, 1))
PY
  then
    echo "!! could not apply: $name"
    echo "   (its FROM string is no longer in $file -- update the control)"
    exit 2
  fi
  ran=$((ran + 1))
  printf '%-56s ' "${name:0:56}"
  if node "tools/$test.mjs" >/dev/null 2>&1; then
    echo "MISSED"
  else
    echo "caught"
    caught=$((caught + 1))
  fi
  restore
done

echo
echo "$caught of $ran re-introduced bugs caught"
[ "$caught" -eq "$ran" ]
