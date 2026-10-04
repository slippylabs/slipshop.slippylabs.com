// Rasterising a text layer.
//
// js/core/text.js lays text out; this draws it. The split is not arbitrary --
// only the browser knows how wide a glyph is, so the layout takes a `measure`
// callback and this file is the only place that can supply one.
//
// A text layer OWNS its surface. The spec is the truth and the pixels are
// derived, so every edit clears the surface and redraws it. That is what makes
// the text re-editable, and it is also why painting on a text layer has to
// rasterise it first: otherwise the next word you typed would erase the brush
// stroke.

import {
  layoutText, cssFont, textDefaults, placeOnPath, isIdentityWarp,
  unwarpPoint, warpedExtent,
} from '../core/text.js';
import { sampleAt } from '../core/resample.js';
import { rect, rectIntersect, clamp01 } from '../core/util.js';
import { toHex } from '../core/color.js';

/** One canvas, reused. Creating one per measurement is the slow way to do
 *  this, and a text layer re-measures on every keystroke. */
let measureCv = null;
function measureCtx() {
  if (!measureCv) measureCv = document.createElement('canvas');
  return measureCv.getContext('2d');
}

/**
 * A measure function and the font's own metrics for one spec.
 *
 * The cache is keyed on the font string and keeps the measured widths, which
 * matters more than it looks: `layoutText` measures every PREFIX of every
 * line, so a 40-character line is 41 calls, and a slider drag re-lays out on
 * every input event.
 */
export function textMeasurer(spec) {
  const g = measureCtx();
  const font = cssFont(spec);
  g.font = font;
  const cache = new Map();
  const measure = (s) => {
    if (s === '') return 0;
    let w = cache.get(s);
    if (w === undefined) {
      w = g.measureText(s).width;
      cache.set(s, w);
    }
    return w;
  };
  // fontBoundingBox* is the font's own declared ascent and descent, which is
  // what a line box should use; actualBoundingBox* is the ink of the string
  // you passed, so a line of "xxx" would claim no ascent at all.
  const m = g.measureText('Hg');
  const size = (spec && spec.fontSize) || textDefaults().fontSize;
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || size * 0.8;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || size * 0.2;
  return { measure, metrics: { ascent, descent }, font };
}

/** Lay a layer's text out, with the browser's metrics. */
export function layoutLayer(layer) {
  const spec = { ...textDefaults(), ...(layer.text || {}) };
  const { measure, metrics, font } = textMeasurer(spec);
  return { spec, font, metrics, layout: layoutText(spec, measure, metrics) };
}

/** The document rect a text layer's pixels will land in. */
export function textLayerBounds(doc, layer) {
  const { spec, layout } = layoutLayer(layer);
  const pad = Math.ceil(spec.fontSize * 0.6) + 4;
  let b = layout.box;
  if (spec.path && spec.path.length >= 2) {
    // On a path the glyphs go wherever the path goes, so the path's own extent
    // bounds them, not the flat layout's.
    const xs = spec.path.map((p) => p.x), ys = spec.path.map((p) => p.y);
    const reach = spec.fontSize * 1.5;
    b = {
      x: Math.min(...xs) - reach, y: Math.min(...ys) - reach,
      w: (Math.max(...xs) - Math.min(...xs)) + reach * 2,
      h: (Math.max(...ys) - Math.min(...ys)) + reach * 2,
    };
  } else if (!isIdentityWarp(spec.warp)) {
    // A warp is defined on the block's own unit square, so its extent scales
    // straight back out. `inflate` and `twist` push interior points further
    // than any corner, which is why the extent is sampled rather than taken
    // from the four corners.
    const e = warpedExtent(spec.warp.style, spec.warp);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const hx = b.w / 2, hy = b.h / 2;
    b = {
      x: cx + e.x0 * hx, y: cy + e.y0 * hy,
      w: (e.x1 - e.x0) * hx, h: (e.y1 - e.y0) * hy,
    };
  }
  const r = rect(
    Math.floor(b.x) - pad, Math.floor(b.y) - pad,
    Math.ceil(b.w) + pad * 2, Math.ceil(b.h) + pad * 2,
  );
  return rectIntersect(r, doc.bounds);
}

/** Draw a laid-out spec onto a 2D context whose origin is at (ox, oy). */
function paintLayout(g, spec, layout, font, ox, oy) {
  g.save();
  g.translate(-ox, -oy);
  g.font = font;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = toHex(spec.color || [0, 0, 0]);
  const onPath = spec.path && spec.path.length >= 2;

  for (const line of layout.lines) {
    if (onPath) {
      const placed = placeOnPath(line.chars, spec.path, {
        offset: spec.pathOffset, side: spec.pathSide, x0: line.x,
      });
      for (const c of placed) {
        if (c.ch === ' ') continue;
        g.save();
        g.translate(c.cx, c.cy);
        g.rotate(c.angle);
        // Each glyph is drawn centred on its own advance, because that is the
        // point whose tangent it was rotated to; drawing from the left edge
        // would lean every character by half its own width.
        g.fillText(c.ch, -c.width / 2, 0);
        g.restore();
      }
      continue;
    }
    // Off a path, draw the WHOLE line in one call whenever the positions are
    // the native ones -- no tracking and no justification. One fillText keeps
    // the font's kerning and ligatures; per-character drawing silently loses
    // both, which is visible in any serif face at a large size.
    if (!spec.tracking && !line.extraPerGap) {
      g.fillText(line.text, line.x, line.y);
    } else {
      for (const c of line.chars) g.fillText(c.ch, c.x, line.y);
    }
    const w = line.extraPerGap ? layout.blockWidth - line.indent : line.width;
    if (spec.underline) {
      const t = Math.max(1, spec.fontSize / 16);
      g.fillRect(line.x, line.y + layout.descent * 0.45, w, t);
    }
    if (spec.strikethrough) {
      const t = Math.max(1, spec.fontSize / 16);
      g.fillRect(line.x, line.y - layout.ascent * 0.3, w, t);
    }
  }
  g.restore();
}

/**
 * Rasterise a text layer into its own surface.
 *
 * @returns the rect written, or null if there was nothing to draw.
 */
export function renderTextLayer(doc, layer) {
  if (!layer.text || !layer.surface) return null;
  const { spec, layout, font, metrics } = layoutLayer(layer);
  const r = textLayerBounds(doc, layer);
  // The surface is cleared in FULL, not just over the new rect: the text may
  // have got shorter, and leaving the tail of the old render behind is the
  // obvious bug in any "redraw the derived pixels" design.
  layer.surface.clearRect(doc.bounds);
  if (r.w <= 0 || r.h <= 0 || !String(spec.content || '').length) return null;

  const cv = document.createElement('canvas');
  cv.width = r.w;
  cv.height = r.h;
  const g = cv.getContext('2d');

  if (isIdentityWarp(spec.warp) || (spec.path && spec.path.length >= 2)) {
    paintLayout(g, spec, layout, font, r.x, r.y);
    writeCanvas(layer.surface, g, r);
    return r;
  }

  // Warped: draw it flat at the same scale into its own buffer, then pull each
  // destination pixel from where the INVERSE warp says it came from. Drawing
  // the warp directly is not possible -- the canvas can transform a glyph
  // affinely and these shapes are not affine.
  const b = layout.box;
  const pad = Math.ceil(spec.fontSize * 0.6) + 4;
  const flat = rect(Math.floor(b.x) - pad, Math.floor(b.y) - pad, Math.ceil(b.w) + pad * 2, Math.ceil(b.h) + pad * 2);
  const fcv = document.createElement('canvas');
  fcv.width = Math.max(1, flat.w);
  fcv.height = Math.max(1, flat.h);
  const fg = fcv.getContext('2d');
  paintLayout(fg, spec, layout, font, flat.x, flat.y);
  const src = toFloat(fg.getImageData(0, 0, fcv.width, fcv.height), true);

  // The unit square is the LAYOUT box, not the padded canvas, so the warp
  // means the same thing whatever the padding happens to be.
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const hx = Math.max(1e-6, b.w / 2), hy = Math.max(1e-6, b.h / 2);
  const out = new Float32Array(r.w * r.h * 4);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < r.h; y++) {
    const dy = r.y + y + 0.5;
    for (let x = 0; x < r.w; x++) {
      const dx = r.x + x + 0.5;
      const [u, v] = unwarpPoint(spec.warp.style, (dx - cx) / hx, (dy - cy) / hy, spec.warp);
      const sx = cx + u * hx - flat.x;
      const sy = cy + v * hy - flat.y;
      if (sx < -1 || sy < -1 || sx > fcv.width + 1 || sy > fcv.height + 1) continue;
      sampleAt(src, fcv.width, fcv.height, sx, sy, 'bilinear', px);
      const p = (y * r.w + x) * 4;
      const a = clamp01(px[3]);
      if (a <= 0) continue;
      // Sampled PREMULTIPLIED and divided back out here: interpolating
      // straight colour across the edge of the glyph drags the colour of a
      // transparent pixel into a visible one, which is the dark fringe round
      // any warped or rotated cut-out.
      out[p] = clamp01(px[0] / a); out[p + 1] = clamp01(px[1] / a);
      out[p + 2] = clamp01(px[2] / a); out[p + 3] = a;
    }
  }
  layer.surface.writeRect(r, out);
  return r;
}

/** ImageData -> Float32 RGBA 0..1, optionally premultiplied for sampling. */
function toFloat(img, premul = false) {
  const n = img.width * img.height;
  const out = new Float32Array(n * 4);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = d[p + 3] / 255;
    const k = premul ? a : 1;
    out[p] = (d[p] / 255) * k;
    out[p + 1] = (d[p + 1] / 255) * k;
    out[p + 2] = (d[p + 2] / 255) * k;
    out[p + 3] = a;
  }
  return out;
}

function writeCanvas(surface, g, r) {
  const img = g.getImageData(0, 0, r.w, r.h);
  surface.writeRect(r, toFloat(img, false));
}
