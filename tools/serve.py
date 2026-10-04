#!/usr/bin/env python3
"""Local dev server for SlipShop.

Serves the working tree, not /var/www, so a browser test runs against what you
just edited. ES modules need the right MIME type or the browser refuses them.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webp": "image/webp",
        ".slipshop": "application/octet-stream",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        # No caching, or a test can pass against the previous edit.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8796
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
