#!/usr/bin/env python3
"""Serves only the test form, on localhost. The answer key is never served."""
import http.server
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
PAGES = {"/": "form.html", "/form.html": "form.html", "/frame.html": "frame.html"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        name = PAGES.get(path)
        fixture = HERE / "live" / "fixtures" / path.removeprefix("/fixtures/")
        if path.startswith("/fixtures/") and fixture.suffix == ".html" and fixture.parent.name == "fixtures" and fixture.is_file():
            body = fixture.read_bytes()
        elif name:
            body = (HERE / name).read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(port=8765):
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"http://127.0.0.1:{port}/form.html")
    serve(port).serve_forever()
