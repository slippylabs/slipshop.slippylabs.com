#!/usr/bin/env python3
"""The link-preview image (og-image.png, 1200x630) and the hub card banner
(640x360 WebP) -- both photographs of the real editor, mid-edit.

The document in the shot is built BY THE ENGINE, in the page: clouds, a
gradient, a couple of adjustment layers and a brush stroke. That keeps the art
honest (it is what the tool actually produces) and it exercises the same code
the oracles check, so a broken filter shows up as a broken picture.

    tools/make_og.py [--banner ~/art.slippylabs.com/shots/slipshop.webp]
"""
import argparse
import functools
import http.server
import io
import os
import socketserver
import sys
import threading
import time

sys.path.insert(0, "/home/slippy/projects/medievalmmo-dev/venv/lib/python3.13/site-packages")
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
    }

    def log_message(self, *a):
        pass


# The scene, built with the editor's own commands.
SCENE = r"""
async () => {
  const S = window.__slipshop;
  const ed = S.ed;
  const { Layer } = await import('./js/core/doc.js');
  const { applyFilter } = await import('./js/core/filters.js');
  const { renderGradient, twoStop } = await import('./js/core/gradient.js');
  const { applyAdjust } = await import('./js/core/adjust.js');
  const { Stroke, applyStroke } = await import('./js/core/brush.js');
  const { rect } = await import('./js/core/util.js');

  ed.newDocument(1500, 1000, { background: [0.04, 0.09, 0.08, 1] });
  const r = ed.doc.bounds;

  // A sky: clouds, warm into cool.
  const sky = ed.doc.layers[0];
  const buf = sky.surface.readRect(r);
  applyFilter('clouds', { scale: 320, octaves: 7, seed: 11, fg: [0.06, 0.12, 0.22], bg: [0.95, 0.62, 0.35] }, buf, r.w, r.h);
  sky.surface.writeRect(r, buf);
  sky.name = 'Sky';

  // A graded overlay, on Soft Light, which is a blend mode you can see.
  const grad = ed.addLayer({ name: 'Grade', blend: 'soft-light', opacity: 0.85 });
  const g = renderGradient(r, twoStop([1, 0.45, 0.1], [0.1, 0.3, 0.9]), {
    shape: 'linear', x0: 0, y0: 0, x1: r.w, y1: r.h, dither: true,
  });
  grad.surface.writeRect(r, g);

  // Hills, cut out of a solid with the engine's own noise, then multiplied.
  const hills = ed.addLayer({ name: 'Hills', blend: 'multiply' });
  const hb = new Float32Array(r.w * r.h * 4);
  applyFilter('clouds', { scale: 520, octaves: 4, seed: 7, fg: [0, 0, 0], bg: [1, 1, 1] }, hb, r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const p = (y * r.w + x) * 4;
      const ridge = 0.62 + hb[p] * 0.22;
      const below = y / r.h > ridge;
      hb[p] = 0.10; hb[p + 1] = 0.16; hb[p + 2] = 0.20;
      hb[p + 3] = below ? 1 : 0;
    }
  }
  hills.surface.writeRect(r, hb);

  // A real brush stroke, with the real brush engine.
  const paint = ed.addLayer({ name: 'Paint' });
  ed.setFg([1, 0.93, 0.7]);
  const st = new Stroke(r.w, r.h, { size: 46, hardness: 0.25, spacing: 0.08, flow: 0.5, smoothing: 0 });
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    st.add(180 + t * 1140, 700 - Math.sin(t * Math.PI * 1.4) * 150, 0.35 + 0.65 * Math.sin(t * Math.PI));
  }
  applyStroke(paint, st, r, { color: ed.fg, opacity: 0.9 });

  // A non-destructive Curves layer on top, so the panel shows one.
  ed.doc.layers.push(new Layer({
    type: 'adjustment', name: 'Curves',
    adjust: { kind: 'curves', params: { rgb: [[0, 0.02], [0.3, 0.26], [0.72, 0.8], [1, 0.99]], channels: {} } },
  }));

  ed.doc.name = 'golden-hour';
  ed.activeId = paint.id;
  ed.history.clear();
  S.setTool('brush');
  ed.invalidate();
  ed.emit('doc');
  ed.emit('layers');
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  S.view.fit();
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  return { w: ed.doc.w, h: ed.doc.h, layers: ed.doc.layerCount };
}
"""


def shoot(pg, base, w, h):
    pg.set_viewport_size({"width": w, "height": h})
    pg.goto(base, wait_until="domcontentloaded")
    pg.wait_for_function("window.__slipshop && window.__slipshop.ready", timeout=60000)
    info = pg.evaluate(SCENE)
    print(f"  scene: {info['w']}x{info['h']}, {info['layers']} layers")
    # Open the panels worth showing, and let the thumbnails render.
    pg.evaluate("""
      document.querySelectorAll('.sp-panel').forEach(d => {
        const t = d.querySelector('summary')?.textContent || '';
        d.open = /Layers|Colour|Brush/.test(t);
      });
    """)
    pg.wait_for_timeout(1200)
    img = Image.open(io.BytesIO(pg.screenshot(timeout=120000))).convert("RGB")
    # A flat frame means the capture ran before anything drew.
    px = list(img.resize((120, 64)).getdata())
    distinct = len({(r >> 3, g >> 3, b >> 3) for r, g, b in px})
    assert distinct > 40, f"the capture looks flat ({distinct} distinct colours) -- it photographed an empty editor"
    print(f"  {w}x{h}: {distinct} distinct colours")
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--banner", help="also write a 640x360 WebP card banner here")
    ap.add_argument("--port", type=int, default=8797)
    args = ap.parse_args()

    handler = functools.partial(Quiet, directory=ROOT)
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", args.port), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{args.port}/index.html"

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox", "--disable-gpu",
                                     "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page()
        # 1200x630 is the og:image size every other site on the estate uses.
        og = shoot(pg, base, 1200, 630)
        og.save(os.path.join(ROOT, "og-image.png"))
        print(f"  wrote og-image.png ({os.path.getsize(os.path.join(ROOT, 'og-image.png')) // 1024} KB)")

        if args.banner:
            # The hub card is 640x360. Shoot it at 1280x720 and downscale, so
            # the text in the panels is legible rather than aliased.
            card = shoot(pg, base, 1280, 720)
            card = card.resize((640, 360), Image.LANCZOS)
            os.makedirs(os.path.dirname(os.path.abspath(args.banner)), exist_ok=True)
            card.save(args.banner, "WEBP", quality=88, method=6)
            print(f"  wrote {args.banner} ({os.path.getsize(args.banner) // 1024} KB)")
        b.close()
    srv.shutdown()


if __name__ == "__main__":
    main()
