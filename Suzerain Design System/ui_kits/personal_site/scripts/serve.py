"""Local dev server that never lets the browser cache.

`python -m http.server` sends Last-Modified but no Cache-Control, so browsers
cache heuristically — and in-browser Babel's fetch of each .jsx was served the
pre-edit file across reloads. The workaround was a never-used port per check,
which is why .claude/launch.json kept growing personal_site_87xx entries.
`no-store` makes one origin serve the working copy every time.

    python scripts/serve.py [port] [directory]    # defaults: 8765, the site root
"""
import functools
import http.server
import pathlib
import sys

SITE = pathlib.Path(__file__).resolve().parent.parent


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # A conditional request would still be answered 304 from Last-Modified;
    # no-store should stop the browser sending one, but don't rely on it.
    def send_head(self):
        for h in ("If-Modified-Since", "If-None-Match"):
            del self.headers[h]
        return super().send_head()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = sys.argv[2] if len(sys.argv) > 2 else str(SITE)
    handler = functools.partial(NoStoreHandler, directory=root)
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"serving {root} at http://localhost:{port}/ (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
