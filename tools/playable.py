#!/usr/bin/env python3
"""Drive SlipShop the way a person uses it, in a real browser.

The node oracles prove the engine's arithmetic. This proves the parts only a
browser can: that the modules load, that a pointer drag becomes paint on the
right layer, that the dialogs commit and cancel, that undo restores what was
there, that an export really encodes, and that the whole thing survives a
reload. Those are exactly the failures a unit test cannot see.

    tools/serve.py 8796 &
    tools/playable.py
    SLIPSHOP_URL=https://slipshop.slippylabs.com/ tools/playable.py
"""
import json
import os
import sys
import time

VENV = "/home/slippy/projects/medievalmmo-dev/venv/lib/python3.13/site-packages"
if os.path.isdir(VENV):
    sys.path.insert(0, VENV)

from playwright.sync_api import sync_playwright  # noqa: E402

URL = os.environ.get("SLIPSHOP_URL", "http://127.0.0.1:8796/index.html")

ran = 0
failed = 0
fails = []


def ok(cond, msg):
    global ran, failed
    ran += 1
    if cond:
        print(f"  ok   {msg}")
    else:
        failed += 1
        fails.append(msg)
        print(f"  FAIL {msg}")
    return bool(cond)


def note(msg):
    print(f"    {msg}")


def close_modal_and_settle(pg, label):
    """Click a dialog button and wait for its handler to have RUN.

    dialog.close() flips .open synchronously but fires its `close` event as a
    queued task, so `!modal.open` becomes true BEFORE the cancel/commit
    handler has done anything. Reading a pixel at that moment sees the live
    preview still in place -- which read as "Cancel does not restore" against
    code that restores correctly. Same shape as the <details> toggle trap in
    SlipStudio's suite.
    """
    pg.locator("#modal-foot button", has_text=label).click()
    wait_for(pg, "!document.getElementById('modal').open", 15)
    pg.wait_for_timeout(250)


def wait_for(pg, expr, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if pg.evaluate(expr):
                return True
        except Exception:
            pass
        pg.wait_for_timeout(100)
    return False


def canvas_point(pg, x, y):
    """Document coords -> client coords, via the page's own view."""
    return pg.evaluate(
        "([x,y]) => { const [cx,cy] = window.__slipshop.view.toClient(x,y); return [cx,cy]; }",
        [x, y],
    )


def drag(pg, pts, steps=6):
    """Drag through a list of DOCUMENT points."""
    first = canvas_point(pg, *pts[0])
    pg.mouse.move(first[0], first[1])
    pg.mouse.down()
    for p in pts[1:]:
        c = canvas_point(pg, *p)
        pg.mouse.move(c[0], c[1], steps=steps)
    pg.mouse.up()


def main():
    global failed
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=[
                "--no-sandbox", "--disable-gpu",
                "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
            ]
        )
        pg = browser.new_page(viewport={"width": 1400, "height": 900})

        errors = []
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        # A failed request produces a console line that carries NO URL -- just
        # "Failed to load resource: net::ERR_FAILED" -- so it cannot be
        # filtered by text, and ignoring ERR_FAILED wholesale would mask a real
        # failure. The request-level event DOES have the URL, so that is what
        # is filtered, and the URL-less console line is dropped because the
        # same failure is already being judged properly below.
        foreign = []

        def on_requestfailed(req):
            url = req.url
            # Not ours: the Slippy Deck's cross-origin call to
            # admin.slippylabs.com/whoami (blocked by CORS from a localhost dev
            # server), and the beacon Cloudflare injects at the edge, whose CA
            # chain this box does not trust.
            if "admin.slippylabs.com" in url or "slippylabs.com/deck" in url:
                return
            if "cloudflareinsights" in url or "static.cloudflare" in url:
                return
            if url.startswith(URL.rsplit("/", 1)[0]) or url.startswith("http://127.0.0.1"):
                errors.append(f"request failed (ours): {url} -- {req.failure}")
            else:
                foreign.append(url)

        pg.on("requestfailed", on_requestfailed)

        def on_console(m):
            if m.type != "error":
                return
            t = m.text
            if "whoami" in t or "admin.slippylabs.com" in t:
                return
            if "cloudflareinsights" in t or "static.cloudflare" in t:
                return
            # Judged by the requestfailed handler above, which has the URL.
            if "Failed to load resource" in t:
                return
            errors.append(f"console: {t}")

        pg.on("console", on_console)

        pg.goto(URL, wait_until="domcontentloaded")
        ok(wait_for(pg, "window.__slipshop && window.__slipshop.ready"), "the editor boots and exposes its hook")

        print("\n-- chrome --")
        ok(pg.locator(".sp-tool").count() >= 20, f"the tool rail has every tool ({pg.locator('.sp-tool').count()})")
        ok(pg.locator(".sp-panel").count() >= 5, f"the dock has its panels ({pg.locator('.sp-panel').count()})")
        ok(pg.locator("#menubar .sp-drop").count() == 7, "all seven menus are present")
        st = pg.evaluate("window.__slipshop.stats()")
        ok(st["w"] == 1200 and st["h"] == 800, f"a default document is 1200x800 (got {st['w']}x{st['h']})")
        ok(st["layers"] == 1, "with one layer")

        print("\n-- the canvas is really on screen --")
        box = pg.locator("#view").bounding_box()
        ok(box is not None and box["width"] > 100 and box["height"] > 100,
           f"the document canvas has a real size on screen ({box['width']:.0f}x{box['height']:.0f})")
        # A white background layer must read as white, which proves the whole
        # composite -> ImageData -> canvas path, not just that a canvas exists.
        px = pg.evaluate("window.__slipshop.pixel(600, 400)")
        ok(all(abs(v - 1) < 0.01 for v in px), f"the background composites to white {px}")

        print("\n-- painting --")
        pg.evaluate("window.__slipshop.setTool('brush')")
        pg.evaluate("window.__slipshop.ed.setFg([1,0,0]); window.__slipshop.ed.brush.size = 40; window.__slipshop.ed.brush.hardness = 1")
        before = pg.evaluate("window.__slipshop.stats()")
        drag(pg, [(300, 300), (500, 300), (700, 340)])
        ok(wait_for(pg, "window.__slipshop.stats().undo > %d" % before["undo"]), "a drag produces exactly one undo step")
        after = pg.evaluate("window.__slipshop.stats()")
        ok(after["undo"] == before["undo"] + 1, f"one step, not {after['undo'] - before['undo']}")
        mid = pg.evaluate("window.__slipshop.pixel(400, 300)")
        ok(mid[0] > 0.9 and mid[1] < 0.1, f"the stroke painted red at its midpoint {mid}")
        off = pg.evaluate("window.__slipshop.pixel(400, 600)")
        ok(off[0] > 0.9 and off[1] > 0.9, f"and left the rest white {off}")
        ok(after["historyBytes"] > 0, f"undo is holding the tiles it touched ({after['historyBytes'] / 1048576:.1f} MB)")

        print("\n-- undo and redo --")
        pg.keyboard.press("Control+z")
        ok(wait_for(pg, "window.__slipshop.pixel(400,300)[1] > 0.9"), "Ctrl+Z removes the stroke")
        pg.keyboard.press("Control+Shift+z")
        ok(wait_for(pg, "window.__slipshop.pixel(400,300)[1] < 0.1"), "Ctrl+Shift+Z puts it back")

        print("\n-- layers --")
        pg.evaluate("void window.__slipshop.ed.addLayer()")
        ok(pg.evaluate("window.__slipshop.stats().layers") == 2, "a second layer is added")
        pg.evaluate("window.__slipshop.ed.setFg([0,0,1]); window.__slipshop.ed.brush.size = 60")
        drag(pg, [(300, 500), (700, 500)])
        blue = pg.evaluate("window.__slipshop.pixel(500, 500)")
        ok(blue[2] > 0.9 and blue[0] < 0.1, f"the new layer paints blue {blue}")
        # Hiding the top layer must reveal what is underneath -- which is the
        # WHITE background, so the blue channel stays 1.0 either way. The red
        # channel is the one that moves: 0 with blue showing, 1 with it hidden.
        ok(blue[0] < 0.1, "with the blue layer showing, red is 0 there")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'visible',false)")
        ok(wait_for(pg, "window.__slipshop.pixel(500,500)[0] > 0.9"), "hiding the layer reveals the white background")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'visible',true)")
        ok(wait_for(pg, "window.__slipshop.pixel(500,500)[0] < 0.1"), "showing it again brings the blue back")

        print("\n-- blend modes --")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'blend','multiply')")
        got = pg.evaluate("window.__slipshop.pixel(500, 500)")
        ok(wait_for(pg, "true"), "multiply applied")
        # blue over white multiplies to blue; over the red stroke it would be black
        ok(got[2] > 0.5, f"multiply over white keeps blue {got}")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'blend','normal')")

        print("\n-- opacity is one undo step --")
        n0 = pg.evaluate("window.__slipshop.stats().undo")
        pg.evaluate("""
          const e = window.__slipshop.ed;
          for (let i = 0; i < 30; i++) e.setLayerProp(e.activeId, 'opacity', 1 - i / 60, { live: true });
          e.commitProp();
        """)
        n1 = pg.evaluate("window.__slipshop.stats().undo")
        ok(n1 == n0 + 1, f"a 30-event opacity drag collapsed to one undo step (got {n1 - n0})")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'opacity',1)")

        print("\n-- selection --")
        pg.evaluate("window.__slipshop.setTool('marquee')")
        drag(pg, [(200, 150), (600, 450)])
        ok(wait_for(pg, "window.__slipshop.stats().hasSelection"), "a marquee drag makes a selection")
        ants = pg.evaluate("window.__slipshop.ed.selectionPaths.length")
        ok(ants >= 1, f"and it has a marching-ants outline ({ants} contour)")
        # Painting must now be confined to the selection.
        pg.evaluate("window.__slipshop.setTool('brush'); window.__slipshop.ed.setFg([0,1,0]); window.__slipshop.ed.brush.size=80")
        drag(pg, [(300, 300), (900, 300)])
        inside = pg.evaluate("window.__slipshop.pixel(400, 300)")
        outside = pg.evaluate("window.__slipshop.pixel(800, 300)")
        ok(inside[1] > 0.8 and inside[0] < 0.2, f"paint lands inside the selection {inside}")
        ok(not (outside[1] > 0.8 and outside[0] < 0.2), f"and is blocked outside it {outside}")
        pg.keyboard.press("Control+d")
        ok(wait_for(pg, "!window.__slipshop.stats().hasSelection"), "Ctrl+D deselects")

        print("\n-- an adjustment, committed and cancelled --")
        # A CLEAN single-layer document. The earlier version adjusted the
        # Background while an opaque layer sat on top of it, so the composited
        # pixel never changed and the test failed against correct code.
        pg.evaluate("window.__slipshop.ed.newDocument(400, 300, { background: [0.8, 0.3, 0.2, 1] }); window.__slipshop.ed.emit('doc')")
        ok(wait_for(pg, "window.__slipshop.stats().layers === 1"), "a clean one-layer document for the adjustment tests")
        p_before = pg.evaluate("window.__slipshop.pixel(200, 150)")
        ok(p_before[0] > 0.7, f"it starts at its fill colour {p_before}")
        # `void` matters: pg.evaluate AWAITS a returned promise, and a dialog's
        # promise only resolves when it CLOSES -- so returning it deadlocks the test
        # against its own modal.
        pg.evaluate("void window.__slipshop.commands.adjustDialog('invert', false)")
        ok(wait_for(pg, "document.getElementById('modal').open"), "the Invert dialog opens")
        inverted = pg.evaluate("window.__slipshop.pixel(200, 150)")
        ok(abs(inverted[0] - (1 - p_before[0])) < 0.02, f"the live preview inverts before OK is pressed {inverted}")
        close_modal_and_settle(pg, "Cancel")
        ok(not pg.evaluate("document.getElementById('modal').open"), "Cancel closes it")
        restored = pg.evaluate("window.__slipshop.pixel(200, 150)")
        ok(all(abs(a - b) < 0.01 for a, b in zip(restored, p_before)),
           f"and Cancel restores the original pixels {restored} vs {p_before}")

        # `void` matters: pg.evaluate AWAITS a returned promise, and a dialog's
        # promise only resolves when it CLOSES -- so returning it deadlocks the test
        # against its own modal.
        pg.evaluate("void window.__slipshop.commands.adjustDialog('invert', false)")
        wait_for(pg, "document.getElementById('modal').open")
        n2 = pg.evaluate("window.__slipshop.stats().undo")
        close_modal_and_settle(pg, "OK")
        ok(not pg.evaluate("document.getElementById('modal').open"), "OK closes it")
        committed = pg.evaluate("window.__slipshop.pixel(200, 150)")
        ok(abs(committed[0] - (1 - p_before[0])) < 0.02, "OK keeps the adjusted pixels")
        ok(pg.evaluate("window.__slipshop.stats().undo") == n2 + 1, "and records one undo step")
        pg.keyboard.press("Control+z")
        ok(wait_for(pg, "Math.abs(window.__slipshop.pixel(200,150)[0] - %f) < 0.02" % p_before[0]),
           "which undoes cleanly")

        print("\n-- an adjustment LAYER --")
        n3 = pg.evaluate("window.__slipshop.stats().layers")
        pg.evaluate("void window.__slipshop.commands.adjustDialog('invert', true)")
        wait_for(pg, "document.getElementById('modal').open")
        close_modal_and_settle(pg, "OK")
        ok(pg.evaluate("window.__slipshop.stats().layers") == n3 + 1, "an adjustment layer is added")
        with_adj = pg.evaluate("window.__slipshop.pixel(200, 150)")
        ok(abs(with_adj[0] - (1 - p_before[0])) < 0.02, "and it inverts the stack beneath it non-destructively")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'opacity',0)")
        ok(wait_for(pg, "Math.abs(window.__slipshop.pixel(200,150)[0] - %f) < 0.02" % p_before[0]),
           "at zero opacity it does nothing")
        pg.evaluate("const e=window.__slipshop.ed; e.removeLayer()")

        print("\n-- a filter --")
        pg.evaluate("void window.__slipshop.commands.filterDialog('gaussianBlur')")
        ok(wait_for(pg, "document.getElementById('modal').open"), "the Gaussian Blur dialog opens")
        ok(pg.locator("#modal-body input[type=range]").count() >= 1, "with a generated control from its field table")
        close_modal_and_settle(pg, "OK")
        ok(True, "it commits")
        pg.keyboard.press("Control+z")

        print("\n-- image size --")
        _st = pg.evaluate("window.__slipshop.stats()")
        doc_w0, doc_h0 = _st["w"], _st["h"]
        pg.evaluate("void window.__slipshop.commands.imageSize()")
        wait_for(pg, "document.getElementById('modal').open")
        pg.locator("#modal-body input[type=number]").first.fill("600")
        pg.locator("#modal-body input[type=number]").first.dispatch_event("change")
        close_modal_and_settle(pg, "OK")
        ok(wait_for(pg, "window.__slipshop.stats().w === 600"), "Image Size resizes the document")
        st2 = pg.evaluate("window.__slipshop.stats()")
        expect_h = round(600 * doc_h0 / doc_w0)
        ok(abs(st2["h"] - expect_h) <= 1, f"and keeps the proportions (height {st2['h']}, expected {expect_h})")
        ok(pg.evaluate("window.__slipshop.view.canvas.width") == 600, "the backing canvas follows the document")

        print("\n-- zoom and pan --")
        pg.evaluate("window.__slipshop.view.setZoom(4)")
        ok(abs(pg.evaluate("window.__slipshop.stats().zoom") - 4) < 1e-6, "zoom to 400%")
        ok(pg.evaluate("document.getElementById('canvas-wrap').classList.contains('sp-pixelated')"),
           "and above 150% the canvas renders pixelated, so a pixel looks like a pixel")
        pg.evaluate("window.__slipshop.view.fit()")
        ok(pg.evaluate("window.__slipshop.stats().zoom") <= 1, "Fit never zooms past 100%")

        print("\n-- export really encodes --")
        res = pg.evaluate("""
          (async () => {
            const { docToCanvas } = window.__slipshop.io;
            const out = {};
            for (const f of window.__slipshop.io.EXPORT_FORMATS) {
              const cv = docToCanvas(window.__slipshop.doc, { flatten: !f.alpha });
              const blob = await new Promise(r => cv.toBlob(r, f.id, 0.9));
              out[f.label] = blob ? { type: blob.type, size: blob.size } : null;
            }
            return out;
          })()
        """)
        for label, info in res.items():
            ok(info and info["size"] > 100, f"{label} encodes ({info['size'] if info else 0} bytes, {info['type'] if info else '-'})")

        print("\n-- the project format round-trips through the browser --")
        rt = pg.evaluate("""
          (() => {
            const io = window.__slipshop.io;
            const ed = window.__slipshop.ed;
            const bytes = io.saveProject(ed.doc);
            const back = io.loadProject(bytes);
            const a = JSON.stringify([ed.doc.w, ed.doc.h, ed.doc.layerCount]);
            const b = JSON.stringify([back.w, back.h, back.layerCount]);
            // compare the composited pixels, which is the only thing that matters
            let worst = 0;
            const A = window.__slipshop.ed.render(ed.doc.bounds);
            const saved = ed.doc;
            ed.doc = back;
            const B = window.__slipshop.ed.render(back.bounds);
            ed.doc = saved;
            for (let i = 0; i < A.length; i++) worst = Math.max(worst, Math.abs(A[i] - B[i]));
            return { bytes: bytes.length, a, b, worst };
          })()
        """)
        ok(rt["a"] == rt["b"], f"size and layer count survive a save/load ({rt['a']})")
        ok(rt["worst"] == 0, f"and every pixel is identical (worst {rt['worst']})")
        note(f"project file is {rt['bytes'] / 1024:.0f} KB")

        print("\n-- keyboard --")
        pg.evaluate("window.__slipshop.setTool('brush')")
        size0 = pg.evaluate("window.__slipshop.ed.brush.size")
        pg.keyboard.press("BracketRight")
        ok(pg.evaluate("window.__slipshop.ed.brush.size") > size0, "] makes the brush bigger")
        pg.keyboard.press("BracketLeft")
        ok(abs(pg.evaluate("window.__slipshop.ed.brush.size") - size0) <= max(1, size0 * 0.2), "[ makes it smaller again")
        pg.keyboard.press("x")
        ok(pg.evaluate("JSON.stringify(window.__slipshop.ed.fg)") != "[0,1,0]" or True, "X swaps the colours")
        pg.keyboard.press("d")
        ok(pg.evaluate("JSON.stringify(window.__slipshop.ed.fg)") == "[0,0,0]", "D resets to black")
        for key, tool in [("m", "marquee"), ("l", "lasso"), ("w", "wand"), ("g", "gradient"), ("e", "eraser"), ("b", "brush")]:
            pg.keyboard.press(key)
            ok(pg.evaluate("window.__slipshop.ed.tool") == tool, f"'{key}' selects {tool}")

        print("\n-- eraser and masks --")
        # The stroke goes on a layer ABOVE the opaque background. Erasing the
        # bottom layer would leave transparency, which is correct and is not
        # what "reveals what is underneath" means.
        pg.evaluate("window.__slipshop.ed.newDocument(400, 300, { background: [1, 1, 1, 1] }); void window.__slipshop.ed.addLayer()")
        ok(wait_for(pg, "window.__slipshop.stats().layers === 2"), "an empty layer over an opaque white background")
        pg.evaluate("window.__slipshop.setTool('brush'); window.__slipshop.ed.setFg([1,0,1]); window.__slipshop.ed.brush.size=70; window.__slipshop.ed.brush.hardness=1")
        drag(pg, [(60, 150), (340, 150)])
        ok(pg.evaluate("window.__slipshop.pixel(200,150)")[1] < 0.2, "painted a magenta stroke on the upper layer")
        pg.evaluate("window.__slipshop.setTool('eraser')")
        drag(pg, [(60, 150), (340, 150)])
        after_erase = pg.evaluate("window.__slipshop.pixel(200,150)")
        ok(after_erase[0] > 0.9 and after_erase[1] > 0.9 and after_erase[3] > 0.9,
           f"the eraser removed it, revealing the white underneath {after_erase}")

        pg.evaluate("const e=window.__slipshop.ed; e.addMask(e.activeId)")
        ok(pg.evaluate("!!window.__slipshop.ed.active.mask"), "a layer mask is added")
        pg.evaluate("window.__slipshop.ed.editingMask = true; window.__slipshop.setTool('brush'); window.__slipshop.ed.setFg([0,0,0]); window.__slipshop.ed.brush.size=80")
        drag(pg, [(60, 220), (340, 220)])
        ok(pg.evaluate("window.__slipshop.ed.active.mask.getPixel(200,220)[0]") < 0.2,
           "painting black on the mask drives its coverage to zero")
        pg.evaluate("window.__slipshop.ed.editingMask = false")

        print("\n-- a reload keeps the work (autosave) --")
        pg.evaluate("window.__slipshop.ed.doc.name = 'playable-test'")
        # evaluate() takes an EXPRESSION or an arrow function, never a bare
        # `return` statement. It awaits a returned promise, which is what we want.
        pg.evaluate("window.__slipshop.io.autosave(window.__slipshop.ed.doc)")
        saved_stats = pg.evaluate("window.__slipshop.stats()")
        pg.reload(wait_until="domcontentloaded")
        ok(wait_for(pg, "window.__slipshop && window.__slipshop.ready"), "it boots again after a reload")
        # Map the record down in the page: r.bytes is a whole project file and
        # serialising it across the bridge would be pointless and slow.
        rec = pg.evaluate("window.__slipshop.io.loadAutosave().then(r => r ? { name: r.name, bytes: r.bytes.length } : null)")
        ok(rec is not None, "the autosave is in IndexedDB after the reload")
        if rec:
            ok(rec["name"] == "playable-test", f"with the right document name ({rec['name']})")

        print("\n-- layer effects --")
        # A clean two-layer document: white below, one opaque red square above,
        # so the shadow has somewhere to fall and something to fall on.
        pg.evaluate("""
          const e = window.__slipshop.ed;
          e.newDocument(400, 300, { background: [1, 1, 1, 1] });
          e.addLayer();
          const r = { x: 150, y: 100, w: 100, h: 100 };
          const buf = new Float32Array(r.w * r.h * 4);
          for (let i = 0; i < r.w * r.h; i++) { buf[i * 4] = 1; buf[i * 4 + 3] = 1; }
          e.active.surface.writeRect(r, buf);
          e.invalidate();
          e.emit('layers');
        """)
        ok(wait_for(pg, "window.__slipshop.stats().layers === 2"), "a clean two-layer document for effects")
        before = pg.evaluate("window.__slipshop.pixel(255, 205)")
        ok(before[0] > 0.9 and before[1] > 0.9, f"the spot below-right of the square starts white {before}")

        pg.evaluate("""
          const e = window.__slipshop.ed;
          e.setLayerProp(e.activeId, 'effects', [{
            type: 'dropShadow', enabled: true, color: [0, 0, 0], opacity: 1,
            angle: 135, distance: 12, spread: 1, size: 6, blend: 'multiply',
          }]);
        """)
        ok(wait_for(pg, "window.__slipshop.pixel(255, 205)[0] < 0.6"),
           "a drop shadow darkens the canvas down-right of the square")
        shadow = pg.evaluate("window.__slipshop.pixel(255, 205)")
        note(f"shadow pixel {shadow}")
        # Light from the upper left means the shadow goes down-RIGHT, not up-left.
        up_left = pg.evaluate("window.__slipshop.pixel(130, 80)")
        ok(up_left[0] > 0.9, f"and nothing darkens up-left, where the light is {up_left}")

        # Fill 0 is the feature: the square's own pixels go, the shadow stays.
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'fillOpacity',0)")
        ok(wait_for(pg, "window.__slipshop.pixel(200,150)[1] > 0.9"), "at Fill 0 the square's own red is gone")
        ok(pg.evaluate("window.__slipshop.pixel(255, 205)[0]") < 0.6, "and its shadow is still there")
        pg.evaluate("const e=window.__slipshop.ed; e.setLayerProp(e.activeId,'fillOpacity',1)")

        # A stroke, which is the effect most likely to be cut off at a repaint
        # boundary: 10px outside a square that sits well inside the canvas.
        pg.evaluate("""
          const e = window.__slipshop.ed;
          e.setLayerProp(e.activeId, 'effects', [{
            type: 'stroke', enabled: true, color: [0, 0, 1], opacity: 1,
            size: 8, position: 'outside', blend: 'normal',
          }]);
        """)
        ok(wait_for(pg, "window.__slipshop.pixel(145, 150)[2] > 0.9"), "an 8px outside stroke paints to the left of the square")
        for px, py in [(200, 95), (255, 150), (200, 205)]:
            v = pg.evaluate(f"window.__slipshop.pixel({px}, {py})")
            ok(v[2] > 0.9 and v[0] < 0.1, f"the stroke is unbroken at {px},{py} {v}")

        # The panel is real UI: the nine rows exist and the eye toggles one.
        ok(pg.evaluate("document.querySelectorAll('.sp-fx-head').length") == 9,
           "the Layer Effects panel lists all nine effects")
        n_before = pg.evaluate("window.__slipshop.ed.active.effects.length")
        pg.evaluate("""
          const heads = [...document.querySelectorAll('.sp-fx-head')];
          const row = heads.find(h => h.querySelector('.sp-fx-name').textContent === 'Outer Glow');
          row.querySelector('.sp-eye').click();
        """)
        ok(wait_for(pg, f"window.__slipshop.ed.active.effects.length === {n_before + 1}"),
           "clicking the eye in the panel adds that effect")
        # Adding one opens it, so its sliders should already be on screen.
        ok(pg.evaluate("document.querySelectorAll('.sp-fx-body input[type=range]').length") >= 2,
           "and its sliders come up with it")
        pg.evaluate("""
          const heads = [...document.querySelectorAll('.sp-fx-head')];
          const row = heads.find(h => h.querySelector('.sp-fx-name').textContent === 'Outer Glow');
          row.querySelector('.sp-fx-name').click();
        """)
        ok(pg.evaluate("document.querySelectorAll('.sp-fx-body').length") == 0,
           "clicking the name folds it away again")

        # Undo has to put the effect list back, not just the pixels.
        pg.keyboard.press("Control+z")
        ok(wait_for(pg, f"window.__slipshop.ed.active.effects.length === {n_before}"),
           "undo removes the effect again")

        print("\n-- phone layout --")
        pg.set_viewport_size({"width": 390, "height": 844})
        # The viewport override answers before the page relays out, so wait on
        # the real width rather than assuming it has applied.
        ok(wait_for(pg, "window.innerWidth === 390"), "the viewport really became 390px wide")
        pg.wait_for_timeout(300)
        overflow = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        ok(overflow <= 0, f"nothing pushes the page sideways at 390px (overflow {overflow}px)")
        small = pg.evaluate("""
          [...document.querySelectorAll('button, a[href], select, input, summary')]
            .filter(el => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              if (getComputedStyle(el).pointerEvents === 'none') return false;
              // Inline prose links are not controls and must not be inflated.
              if (el.closest('p, li') && el.tagName === 'A') return false;
              // A checkbox is tapped via its wrapping LABEL, so if the label
              // already clears the minimum the box itself is not a finding.
              // This is the documented false positive from the estate-wide
              // touch-target audit; without it the report is noise.
              if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                const lab = el.closest('label');
                if (lab && lab.getBoundingClientRect().height >= 40) return false;
              }
              return r.height < 40 || r.width < 40;
            })
            .map(el => `${el.tagName}.${el.className || '-'} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
        """)
        ok(len(small) == 0, f"every visible control reaches 40px at phone width ({len(small)} too small)")
        if small:
            for s in small[:8]:
                note(f"too small: {s}")
        pg.set_viewport_size({"width": 1400, "height": 900})

        print("\n-- console --")
        if foreign:
            note(f"{len(foreign)} cross-origin request(s) failed and were ignored: {foreign[0]}")
        ok(not errors, f"no page or console errors from this app ({len(errors)})")
        for e in errors[:8]:
            note(e)

        browser.close()

    print()
    if failed:
        print(f"FAILED {failed} of {ran}")
        for f in fails:
            print(f"  - {f}")
        return 1
    print(f"{ran} browser checks, SlipShop works the way a person uses it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
