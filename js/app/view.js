// The viewport: pan, zoom, and getting composited pixels onto the screen.
//
// The backing canvas is at DOCUMENT resolution and the browser scales it with
// CSS. That is what makes a dirty-rect update cheap: an edit composites one
// rectangle and putImageData's it at its own offset, and the browser rescales
// for free on the compositor thread. Compositing at screen resolution instead
// would mean re-rendering the whole visible area on every zoom and pan.
//
// Above 100% the canvas switches to `pixelated`, because at 800% you want to
// see the pixels, not a smooth interpolation of them.

import { rect, rectIntersect, rectEmpty, clamp } from '../core/util.js';

export const ZOOM_STEPS = [
  0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67,
  1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32,
];

export class View {
  constructor(ed, stage, wrap, canvas, overlay) {
    this.ed = ed;
    this.stage = stage;
    this.wrap = wrap;
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false, alpha: true });
    this.octx = overlay.getContext('2d');
    this.antsPhase = 0;
    this.antsTimer = null;
    this.resizeToDoc();
  }

  /** Match the backing canvases to the document size. */
  resizeToDoc() {
    const { w, h } = this.ed.doc;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.overlay.width = w;
      this.overlay.height = h;
    }
    this.layout();
    this.repaint(this.ed.doc.bounds);
  }

  /** Position and size the wrapper for the current zoom and pan. */
  layout() {
    const { w, h } = this.ed.doc;
    const z = this.ed.zoom;
    const sw = w * z, sh = h * z;
    const sr = this.stage.getBoundingClientRect();
    // Centre the document, then apply the pan. Centring in the layout rather
    // than in the pan means "Fit on screen" does not have to compute a pan.
    const left = Math.round((sr.width - sw) / 2 + this.ed.pan[0]);
    const top = Math.round((sr.height - sh) / 2 + this.ed.pan[1]);
    Object.assign(this.wrap.style, {
      width: `${sw}px`, height: `${sh}px`, left: `${left}px`, top: `${top}px`,
    });
    this.wrap.classList.toggle('sp-pixelated', z >= 1.5);
    this.drawAnts();
  }

  /** Composite a document rect and blit it into the backing canvas. */
  repaint(r) {
    const box = rectIntersect(r || this.ed.doc.bounds, this.ed.doc.bounds);
    if (rectEmpty(box)) return;
    const data = this.ed.render(box);
    const img = this.ctx.createImageData(box.w, box.h);
    const out = img.data;
    // Float 0..1 straight alpha -> 8-bit non-premultiplied, which is exactly
    // what ImageData holds.
    for (let i = 0, n = box.w * box.h; i < n; i++) {
      const p = i * 4;
      out[p] = data[p] * 255 + 0.5;
      out[p + 1] = data[p + 1] * 255 + 0.5;
      out[p + 2] = data[p + 2] * 255 + 0.5;
      out[p + 3] = data[p + 3] * 255 + 0.5;
    }
    this.ctx.putImageData(img, box.x, box.y);
  }

  // ------------------------------------------------------------ coordinates

  /** Client coordinates -> document coordinates (floating point). */
  toDoc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const z = this.ed.zoom;
    return [(clientX - r.left) / z, (clientY - r.top) / z];
  }

  /** Document coordinates -> client. */
  toClient(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const z = this.ed.zoom;
    return [r.left + x * z, r.top + y * z];
  }

  // ------------------------------------------------------------------ zoom

  setZoom(z, anchor) {
    const old = this.ed.zoom;
    const next = clamp(z, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    if (next === old) return;
    if (anchor) {
      // Keep the document point under the cursor fixed, which is the only
      // zoom behaviour that does not feel like the image is running away.
      const [dx, dy] = this.toDoc(anchor[0], anchor[1]);
      this.ed.zoom = next;
      this.layout();
      const [nx, ny] = this.toDoc(anchor[0], anchor[1]);
      this.ed.pan[0] += (nx - dx) * next;
      this.ed.pan[1] += (ny - dy) * next;
    } else {
      this.ed.zoom = next;
    }
    this.layout();
    this.ed.emit('view');
  }

  zoomStep(dir, anchor) {
    const z = this.ed.zoom;
    if (dir > 0) {
      const next = ZOOM_STEPS.find((s) => s > z + 1e-6);
      this.setZoom(next === undefined ? z : next, anchor);
    } else {
      const below = ZOOM_STEPS.filter((s) => s < z - 1e-6);
      this.setZoom(below.length ? below[below.length - 1] : z, anchor);
    }
  }

  fit() {
    const sr = this.stage.getBoundingClientRect();
    const { w, h } = this.ed.doc;
    const pad = 32;
    const z = Math.min((sr.width - pad) / w, (sr.height - pad) / h);
    this.ed.pan = [0, 0];
    this.setZoom(Math.min(1, Math.max(ZOOM_STEPS[0], z)));
    this.layout();
    this.ed.emit('view');
  }

  actualPixels() {
    this.ed.pan = [0, 0];
    this.setZoom(1);
    this.ed.emit('view');
  }

  panBy(dx, dy) {
    this.ed.pan[0] += dx;
    this.ed.pan[1] += dy;
    this.layout();
  }

  // --------------------------------------------------------- marching ants

  /**
   * The selection outline, drawn as a dashed path on the overlay canvas.
   *
   * Two dashes in opposite phase, black over white, so the line is visible on
   * any image -- a single black dash disappears on a dark photograph, which
   * is the whole reason Photoshop's ants are two-tone.
   *
   * The line width is divided by the zoom so it stays one SCREEN pixel: at
   * 800% a 1-document-pixel line would be 8px thick and hide the edge it is
   * describing.
   */
  drawAnts() {
    const g = this.octx;
    const { w, h } = this.ed.doc;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const paths = this.ed.selectionPaths;
    if (!paths || !paths.length) { this.stopAnts(); return; }
    const z = Math.max(0.05, this.ed.zoom);
    const lw = 1 / z;
    const dash = 4 / z;
    g.lineWidth = lw;
    for (const [colour, offset] of [['#ffffff', 0], ['#000000', dash]]) {
      g.strokeStyle = colour;
      g.setLineDash([dash, dash]);
      g.lineDashOffset = offset + this.antsPhase / z;
      g.beginPath();
      for (const p of paths) {
        g.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
        g.closePath();
      }
      g.stroke();
    }
    this.startAnts();
  }

  startAnts() {
    if (this.antsTimer !== null) return;
    // 8 fps, not 60: the ants only need to crawl, and a rAF loop for a dashed
    // outline keeps a laptop fan on for no reason.
    this.antsTimer = setInterval(() => {
      this.antsPhase = (this.antsPhase + 1) % 8;
      this.drawAnts();
    }, 125);
  }

  stopAnts() {
    if (this.antsTimer === null) return;
    clearInterval(this.antsTimer);
    this.antsTimer = null;
  }

  /** Draw a transient overlay shape (a marquee being dragged, a crop box). */
  drawPreview(fn) {
    const g = this.octx;
    const { w, h } = this.ed.doc;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const z = Math.max(0.05, this.ed.zoom);
    g.lineWidth = 1 / z;
    g.setLineDash([4 / z, 4 / z]);
    g.strokeStyle = '#ffffff';
    fn(g, 1 / z);
    g.setLineDash([]);
  }

  clearPreview() { this.drawAnts(); }
}
