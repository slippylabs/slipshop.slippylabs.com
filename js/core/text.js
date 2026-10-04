// Text layout.
//
// A text layer stores a SPEC, not pixels. The spec is laid out here and
// rasterised in js/app, and the layer keeps a rendered surface alongside the
// spec so the compositor needs to know nothing about fonts. Re-editable means
// exactly that: change a word, the layout and the surface are rebuilt.
//
// The one thing this file cannot do is measure a glyph. Font metrics live in
// the font, the browser owns the font, and reimplementing shaping would be a
// worse job done twice. So every entry point takes a `measure(str) -> width`
// callback. That is also what makes the layout testable: hand it a synthetic
// metric -- every character one unit wide -- and the wrapping, alignment,
// tracking and justification become exact arithmetic with an exact answer.
//
// Positions are in DOCUMENT pixels, y increasing downward, and a line's `y`
// is its BASELINE, not its top. Everything that draws text wants the baseline
// and everything that boxes it wants the top, so one of the two has to be
// derived; deriving the box from the baseline needs only the ascent, while the
// other way round needs the ascent on every line.

import { clamp, clamp01, lerp, TAU } from './util.js';

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'];

export function textDefaults() {
  return {
    content: 'Type here',
    fontFamily: 'sans-serif',
    fontSize: 48,
    fontWeight: 'normal',
    fontStyle: 'normal',
    /** A multiple of the font size, the CSS convention. */
    lineHeight: 1.2,
    /** Extra advance after each character, in pixels. Photoshop's Tracking. */
    tracking: 0,
    align: 'left',
    x: 0,
    y: 0,
    /** null for POINT text, which wraps only on an explicit newline; a number
     *  for PARAGRAPH text, which wraps to that width. */
    boxWidth: null,
    boxHeight: null,
    paragraphSpacing: 0,
    firstLineIndent: 0,
    color: [0, 0, 0],
    underline: false,
    strikethrough: false,
    warp: null,
    /** [{x, y}, ...] -- a polyline the baseline follows. */
    path: null,
    pathOffset: 0,
    pathSide: 'above',
  };
}

export const TEXT_FIELDS = [
  ['Size', 'fontSize', 'num', 4, 800, 1],
  ['Line height', 'lineHeight', 'num', 0.5, 4, 0.01],
  ['Tracking', 'tracking', 'num', -40, 200, 0.5],
  ['Align', 'align', 'sel', ALIGNMENTS],
  ['Paragraph gap', 'paragraphSpacing', 'num', 0, 200, 1],
  ['First indent', 'firstLineIndent', 'num', -200, 400, 1],
  ['Underline', 'underline', 'bool'],
  ['Strikethrough', 'strikethrough', 'bool'],
];

/** The CSS shorthand a canvas wants. Kept here so the spec has one owner. */
export function cssFont(spec) {
  const s = { ...textDefaults(), ...spec };
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`.trim();
}

// ------------------------------------------------------------------ wrapping

/**
 * Break one paragraph into lines no wider than `width`.
 *
 * Breaks at spaces, and only falls back to breaking mid-word when a single
 * word does not fit on a line of its own -- the alternative, letting it
 * overflow, loses text off the edge of a paragraph box, which is worse than an
 * ugly break. A width of null or <= 0 means no wrapping at all, which is what
 * point text is.
 */
export function wrapParagraph(para, width, advance) {
  if (!para) return [''];
  if (!width || width <= 0) return [para];
  const out = [];
  // Split KEEPING the spaces attached to the word before them, so trailing
  // spaces do not push a line over the limit and then wrap to nothing.
  const words = para.match(/\S+\s*/g) || [para];
  let line = '';
  for (const w of words) {
    const word = w.replace(/\s+$/, '');
    const trail = w.slice(word.length);
    const trial = line + w;
    // Measured without the trailing space: a space at the end of a line is
    // invisible, so it must not decide where the line breaks.
    if (line && advance(trial.replace(/\s+$/, '')) > width) {
      out.push(line.replace(/\s+$/, ''));
      line = '';
    }
    if (advance(word) > width && !line) {
      // One word longer than the whole line: break it by character.
      let chunk = '';
      for (const ch of word) {
        if (chunk && advance(chunk + ch) > width) { out.push(chunk); chunk = ''; }
        chunk += ch;
      }
      line = chunk + trail;
      continue;
    }
    line += w;
  }
  out.push(line.replace(/\s+$/, ''));
  return out;
}

// -------------------------------------------------------------------- layout

/**
 * Lay a spec out into positioned lines and characters.
 *
 * @param measure (str) -> advance width in pixels, with the spec's font set.
 * @returns {
 *   lines:  [{ text, x, y, width, para, chars: [{ ch, x, width }] }],
 *   box:    { x, y, w, h } -- the text's extent, top-left origin
 *   lineHeight, ascent, descent
 * }
 *
 * Every character's x comes from measuring the PREFIX before it, not from
 * summing per-character widths. Those are different numbers whenever the font
 * kerns, and the prefix is the one that matches what the browser draws when it
 * is handed the whole string -- so at tracking 0 the per-character positions
 * reproduce the native rendering exactly instead of drifting apart by a pixel
 * per pair.
 */
export function layoutText(spec, measure, metrics = {}) {
  const s = { ...textDefaults(), ...spec };
  const lineHeight = s.fontSize * s.lineHeight;
  const ascent = metrics.ascent === undefined ? s.fontSize * 0.8 : metrics.ascent;
  const descent = metrics.descent === undefined ? s.fontSize * 0.2 : metrics.descent;
  const track = s.tracking;
  /** The advance of a run, tracking included but not trailing. */
  const advance = (t) => (t.length ? measure(t) + track * (t.length - 1) : 0);

  const paras = String(s.content === undefined ? '' : s.content).split('\n');
  const raw = [];
  paras.forEach((para, pi) => {
    for (const text of wrapParagraph(para, s.boxWidth, advance)) raw.push({ text, para: pi });
  });

  const widths = raw.map((l) => advance(l.text));
  // A point text block is as wide as its widest line; a paragraph is as wide
  // as its box, because that is what the alignment is measured against.
  const blockWidth = s.boxWidth && s.boxWidth > 0 ? s.boxWidth : Math.max(0, ...widths);

  const lines = [];
  let y = s.y;
  let prevPara = 0;
  raw.forEach((l, i) => {
    if (i > 0) {
      y += lineHeight;
      if (l.para !== prevPara) y += s.paragraphSpacing;
    }
    prevPara = l.para;
    const indent = (i === 0 || raw[i - 1].para !== l.para) ? s.firstLineIndent : 0;
    const avail = blockWidth - indent;
    const w = widths[i];
    let x = s.x + indent;
    if (s.align === 'center') x += (avail - w) / 2;
    else if (s.align === 'right') x += avail - w;

    // Justify stretches the GAPS, never the glyphs, and never on the last
    // line of a paragraph -- a justified last line is the single most
    // recognisable sign of a layout engine that does not know it is one.
    const lastOfPara = i === raw.length - 1 || raw[i + 1].para !== l.para;
    let extraPerGap = 0;
    if (s.align === 'justify' && !lastOfPara) {
      const gaps = (l.text.match(/ /g) || []).length;
      if (gaps > 0) extraPerGap = (avail - w) / gaps;
    }

    const chars = [];
    let cx = x;
    let gapsSeen = 0;
    const cps = [...l.text];
    for (let k = 0; k < cps.length; k++) {
      const prefix = cps.slice(0, k).join('');
      const base = x + (k ? measure(prefix) + track * k : 0) + extraPerGap * gapsSeen;
      const nextPrefix = cps.slice(0, k + 1).join('');
      const w1 = measure(nextPrefix) - (k ? measure(prefix) : 0);
      chars.push({ ch: cps[k], x: base, width: w1 });
      if (cps[k] === ' ') gapsSeen++;
      cx = base + w1;
    }
    lines.push({
      text: l.text, para: l.para, x, y, width: w, indent, extraPerGap, chars,
      end: cx,
    });
  });

  const h = lines.length ? (lines[lines.length - 1].y - lines[0].y) + ascent + descent : 0;
  let bx = s.x, bw = blockWidth;
  if (!s.boxWidth || s.boxWidth <= 0) {
    // Point text: the box hugs the lines, which may start left of the anchor
    // when they are centred or right-aligned.
    const xs = lines.map((l) => l.x);
    const xe = lines.map((l) => l.x + l.width);
    bx = lines.length ? Math.min(...xs) : s.x;
    bw = lines.length ? Math.max(...xe) - bx : 0;
  }
  return {
    lines,
    box: { x: bx, y: s.y - ascent, w: bw, h },
    lineHeight, ascent, descent, blockWidth,
  };
}

// --------------------------------------------------------------- text on path

/** The cumulative arc length of a polyline, and its total. */
export function polylineArc(path) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  return acc;
}

/**
 * The point and tangent at arc length `t` along a polyline.
 *
 * Past either end it EXTRAPOLATES along the terminal segment rather than
 * clamping. Clamping would pile every overflowing character on top of the last
 * point, which reads as a bug; running off the end reads as "the path is too
 * short", which is the truth.
 */
export function pointAtArc(path, acc, t) {
  const n = path.length;
  if (n === 0) return { x: 0, y: 0, angle: 0 };
  if (n === 1) return { x: path[0].x, y: path[0].y, angle: 0 };
  let i = 1;
  while (i < n - 1 && acc[i] < t) i++;
  const a = path[i - 1], b = path[i];
  const segLen = acc[i] - acc[i - 1];
  const u = segLen > 0 ? (t - acc[i - 1]) / segLen : 0;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/**
 * Place a laid-out line's characters along a path.
 *
 * Each character is positioned at its own advance along the arc and rotated to
 * the local tangent, which is why this takes the LAYOUT's characters rather
 * than re-measuring: the spacing a path version uses must be the same spacing
 * the flat version uses, or turning the path on would reflow the text.
 */
export function placeOnPath(chars, path, { offset = 0, side = 'above', x0 = 0 } = {}) {
  if (!path || path.length < 2) return chars.map((c) => ({ ...c, angle: 0, cx: c.x, cy: 0 }));
  const acc = polylineArc(path);
  const flip = side === 'below' ? -1 : 1;
  return chars.map((c) => {
    // The character's own distance along the path is where it sat on the flat
    // line, measured from the line's start.
    const t = offset + (c.x - x0) + c.width / 2;
    const p = pointAtArc(path, acc, t);
    // Perpendicular to the tangent, pointing "up" on screen.
    const nx = Math.sin(p.angle) * flip;
    const ny = -Math.cos(p.angle) * flip;
    return {
      ...c,
      cx: p.x + nx * 0,
      cy: p.y + ny * 0,
      nx, ny,
      angle: p.angle + (side === 'below' ? Math.PI : 0),
    };
  });
}

// ----------------------------------------------------------------- warp text

export const WARP_STYLES = [
  'none', 'arc', 'arcLower', 'arcUpper', 'arch', 'bulge',
  'shellLower', 'shellUpper', 'flag', 'wave', 'fish', 'rise',
  'fisheye', 'inflate', 'squeeze', 'twist',
];

export function warpDefaults() {
  return { style: 'arc', bend: 0.5, horizontal: 0, vertical: 0 };
}

/**
 * The bend range a style can be inverted over.
 *
 * The three radial shapes stop being injective at the bottom of the nominal
 * range, so there is no inverse there to resample with: `inflate` at -1
 * collapses the interior to a point, `twist` swirls it through half a turn,
 * and `fisheye` degenerates into a projection onto the unit circle, which
 * sends every point on a ray to the same place. All three show up as a
 * stubborn 0.1-0.2 residual in the inverse, which at raster scale is a fifth
 * of the text block in the wrong position. Everything else is a bounded
 * displacement and is fine over the full range.
 */
export const WARP_BEND_RANGE = {
  inflate: [-0.95, 1],
  twist: [-0.95, 0.95],
  fisheye: [-0.9, 1],
};
export function bendRange(style) { return WARP_BEND_RANGE[style] || [-1, 1]; }

export const WARP_FIELDS = [
  ['Style', 'style', 'sel', WARP_STYLES],
  ['Bend', 'bend', 'num', -1, 1, 0.01],
  ['Horizontal', 'horizontal', 'num', -1, 1, 0.01],
  ['Vertical', 'vertical', 'num', -1, 1, 0.01],
];

/**
 * The FORWARD warp: where a point inside the text's box ends up.
 *
 * Normalised coordinates, u and v both in -1..1 with 0 at the centre, because
 * every one of these shapes is defined relative to the block rather than to
 * the document. v is -1 at the TOP, matching screen y.
 *
 * The rasteriser needs the inverse of this to resample, and there is no closed
 * form for most of them, so it inverts numerically. Expressing the forward map
 * is still the right choice: the forward map is what the shapes are DEFINED
 * by, and a hand-derived inverse for sixteen of them would be sixteen chances
 * to be subtly wrong in a way that still looks like a warp.
 */
export function warpPoint(style, u, v, p = {}) {
  const bend = p.bend === undefined ? 0.5 : p.bend;
  const hz = p.horizontal || 0;
  const vt = p.vertical || 0;
  let x = u, y = v;

  // A bend of zero is EXACTLY the identity for every shape, not merely close
  // to it. Three of these go through polar coordinates, and a round trip
  // through atan2 and cos leaves 2.2e-16 behind -- harmless for a pixel, but
  // it means "bend 0 changes nothing" stops being a statement the oracle can
  // make exactly, and that statement is worth more than the detour.
  if (bend) switch (style) {
    case 'none': break;
    case 'arc':
      // A uniform vertical bow: the whole block rides a parabola.
      y = v - bend * (1 - u * u);
      break;
    case 'arcLower':
      // Only the bottom edge bows, so the shift is scaled by how far down the
      // point is -- (1 + v) / 2 is 0 at the top and 1 at the bottom.
      y = v - bend * (1 - u * u) * (1 + v) / 2;
      break;
    case 'arcUpper':
      y = v - bend * (1 - u * u) * (1 - v) / 2;
      break;
    case 'arch':
      y = v - bend * (1 - u * u) * 0.5;
      break;
    case 'bulge':
      // Horizontal fattening instead of vertical bowing.
      x = u * (1 + bend * (1 - v * v) * 0.5);
      break;
    case 'shellLower':
      y = v - bend * Math.abs(u) * (1 + v) / 2;
      break;
    case 'shellUpper':
      y = v + bend * Math.abs(u) * (1 - v) / 2;
      break;
    case 'flag':
      y = v + bend * Math.sin(u * Math.PI) * 0.5;
      break;
    case 'wave':
      y = v + bend * Math.sin(u * TAU) * 0.4;
      break;
    case 'fish':
      y = v * (1 - bend * (1 - Math.abs(u)) * 0.5);
      break;
    case 'rise':
      y = v - bend * (u + 1) / 2;
      break;
    case 'fisheye': {
      // A radial lens. The scale is 1 at the centre and shrinks outward, so
      // the middle of the block grows and the corners pull in.
      const r = Math.hypot(u, v);
      const k = 1 + bend * (1 - clamp01(r));
      x = u / k; y = v / k;
      break;
    }
    case 'inflate': {
      const k = 1 + bend * (1 - u * u) * (1 - v * v);
      x = u * k; y = v * k;
      break;
    }
    case 'squeeze':
      x = u * (1 - bend * (1 - v * v) * 0.5);
      break;
    case 'twist': {
      const r = Math.hypot(u, v);
      const a = Math.atan2(v, u) + bend * (1 - clamp01(r)) * Math.PI;
      x = Math.cos(a) * r; y = Math.sin(a) * r;
      break;
    }
    default: break;
  }
  // The two secondary dials are a shear each, applied after the shape: that
  // is the order Photoshop uses, and it is the one that keeps Horizontal
  // Distortion meaning "lean the warped text" rather than "warp leaning text".
  if (hz) x += hz * y * 0.5;
  if (vt) y += vt * x * 0.5;
  return [x, y];
}

/**
 * Invert the warp at one point: DAMPED Newton on the 2x2 Jacobian.
 *
 * Plain Newton is not enough. `twist` and `inflate` are strongly nonlinear at
 * a large bend, and undamped steps overshoot and then wander -- 12 of 1600
 * sample points came back with a residual around 0.5, which at raster scale
 * is half the text block. Halving the step until the residual actually falls
 * fixes all of them, and costs nothing where Newton was already converging
 * because the first trial step is accepted.
 *
 * Where a warp is genuinely NOT injective -- `inflate` at bend exactly -1
 * collapses the whole interior to a point -- there is no answer to find, and
 * the best available is the closest point Newton reached. The field editors
 * keep the bend inside the injective range so the rasteriser never has to.
 */
export function unwarpPoint(style, x, y, p = {}, iters = 24) {
  let u = x, v = y;
  const EPS = 1e-5;
  const resid = (uu, vv) => {
    const [fx, fy] = warpPoint(style, uu, vv, p);
    return Math.hypot(fx - x, fy - y);
  };
  let r0 = resid(u, v);
  for (let i = 0; i < iters && r0 > 1e-13; i++) {
    const [fx, fy] = warpPoint(style, u, v, p);
    const ex = fx - x, ey = fy - y;
    const [ax, ay] = warpPoint(style, u + EPS, v, p);
    const [bx, by] = warpPoint(style, u, v + EPS, p);
    const j00 = (ax - fx) / EPS, j01 = (bx - fx) / EPS;
    const j10 = (ay - fy) / EPS, j11 = (by - fy) / EPS;
    const det = j00 * j11 - j01 * j10;
    if (!det || !Number.isFinite(det)) break;
    const du = -(j11 * ex - j01 * ey) / det;
    const dv = -(j00 * ey - j10 * ex) / det;
    let step = 1;
    let moved = false;
    for (let k = 0; k < 24; k++) {
      const nu = u + du * step, nv = v + dv * step;
      const r = resid(nu, nv);
      if (r < r0) { u = nu; v = nv; r0 = r; moved = true; break; }
      step *= 0.5;
    }
    if (!moved) break;
  }
  return [u, v];
}

/** Is this warp the identity? A bend of 0 with no shear leaves text alone, and
 *  the rasteriser skips a whole resampling pass when it does. */
export function isIdentityWarp(warp) {
  if (!warp || warp.style === 'none') return true;
  return !warp.bend && !warp.horizontal && !warp.vertical;
}

/**
 * How far outside its own box a warped block can reach.
 *
 * Sampled on the boundary of the unit square rather than reasoned about:
 * these are sixteen unrelated formulas plus two shears, and `inflate` moves
 * interior points further than any corner, so a corners-only bound is wrong
 * for exactly the shape that needs it most.
 *
 * What makes the sample a BOUND rather than an estimate is the padding: the
 * box is inflated by half the largest step between neighbouring samples,
 * which covers an extremum sitting between two of them. Without it the grid
 * missed `shellLower`, whose maximum is exactly on the centre line, by 2.4e-2
 * -- five pixels clipped off the top of a 400px block. Measured over every
 * style, every bend at the ends of its range and both shears, the padded box
 * now contains a 501x501 resample with 2.1e-2 to spare at any grid size.
 */
export function warpedExtent(style, p = {}, n = 32) {
  const m = n;
  const grid = [];
  for (let i = 0; i <= m; i++) {
    const row = [];
    for (let j = 0; j <= m; j++) {
      row.push(warpPoint(style, -1 + (2 * i) / m, -1 + (2 * j) / m, p));
    }
    grid.push(row);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, step = 0;
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= m; j++) {
      const [x, y] = grid[i][j];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (i > 0) step = Math.max(step, Math.abs(x - grid[i - 1][j][0]), Math.abs(y - grid[i - 1][j][1]));
      if (j > 0) step = Math.max(step, Math.abs(x - grid[i][j - 1][0]), Math.abs(y - grid[i][j - 1][1]));
    }
  }
  const pad = step / 2;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
