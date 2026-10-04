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
    const z = Math.max(0.05, this.ed.zoom);
    const paths = this.ed.selectionPaths;
    if (paths && paths.length) {
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
      g.setLineDash([]);
      this.startAnts();
    } else {
      this.stopAnts();
    }
    // The bezier path overlay shares this canvas, so it has to be redrawn
    // every time the ants are -- the crawl repaints eight times a second and
    // would otherwise wipe the path out between frames.
    this.paintPathOverlay(g, z);
    this.paintFreezeOverlay(g);
  }

  /**
   * The liquify freeze mask, as a red wash.
   *
   * Drawn at MESH resolution and scaled up, not per pixel: the mask lives on
   * the mesh, and interpolating it to every pixel to draw a translucent
   * overlay would cost more than the warp it is guarding.
   */
  paintFreezeOverlay(g) {
    const s = this.ed.liquify;
    if (!s) return;
    const m = s.mesh;
    let any = false;
    for (let i = 0; i < m.freeze.length; i++) if (m.freeze[i] > 0.01) { any = true; break; }
    if (!any) return;
    g.save();
    for (let j = 0; j < m.ny; j++) {
      for (let i = 0; i < m.nx; i++) {
        const v = m.freeze[j * m.nx + i];
        if (v <= 0.01) continue;
        g.fillStyle = `rgba(255,70,70,${(v * 0.35).toFixed(3)})`;
        g.fillRect(m.nodeX(i) - m.step / 2, m.nodeY(j) - m.step / 2, m.step, m.step);
      }
    }
    g.restore();
  }

  /**
   * The active bezier path: its outline, its anchors and their handles.
   *
   * Every size is divided by the zoom so it stays constant in SCREEN pixels.
   * At 800% a 4-document-pixel anchor would be 32px across and cover the
   * curve it is meant to let you grab.
   */
  paintPathOverlay(g, z) {
    const rec = this.ed.activePath;
    if (!rec || !rec.path || !rec.path.subpaths.length) return;
    const lw = 1 / z;
    const an = 3.5 / z;

    g.lineWidth = lw * 1.6;
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    const trace = () => {
      g.beginPath();
      for (const sp of rec.path.subpaths) {
        const a = sp.anchors;
        if (!a.length) continue;
        g.moveTo(a[0].x, a[0].y);
        const n = sp.closed ? a.length : a.length - 1;
        for (let i = 0; i < n; i++) {
          const c = a[i], d = a[(i + 1) % a.length];
          g.bezierCurveTo(c.outX, c.outY, d.inX, d.inY, d.x, d.y);
        }
        if (sp.closed) g.closePath();
      }
    };
    trace();
    g.stroke();
    g.lineWidth = lw * 0.8;
    g.strokeStyle = '#39ff8f';
    trace();
    g.stroke();

    // Handles, then anchors on top: a corner point has its handles sitting
    // exactly on it, and the anchor is the bigger target.
    g.lineWidth = lw;
    g.strokeStyle = 'rgba(57,255,143,0.55)';
    g.fillStyle = '#04120b';
    for (const sp of rec.path.subpaths) {
      for (const a of sp.anchors) {
        for (const [hx, hy] of [[a.inX, a.inY], [a.outX, a.outY]]) {
          if (Math.abs(hx - a.x) < 1e-9 && Math.abs(hy - a.y) < 1e-9) continue;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(hx, hy);
          g.stroke();
          g.beginPath();
          g.arc(hx, hy, an * 0.7, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
      }
    }
    for (const sp of rec.path.subpaths) {
      sp.anchors.forEach((a, i) => {
        g.beginPath();
        g.rect(a.x - an, a.y - an, an * 2, an * 2);
        // The first anchor is filled, so you can see where closing the path
        // would snap to.
        g.fillStyle = i === 0 ? '#39ff8f' : '#04120b';
        g.fill();
        g.strokeStyle = '#39ff8f';
        g.stroke();
      });
    }
  }

  /** Redraw the overlay after a path edit. */
  drawPaths() { this.drawAnts(); }

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
