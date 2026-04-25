"""HTTP server that receives credential payloads from the browser extension.

Run directly:

    python3 -m server.cookie_server          # foreground
    python3 -m server.cookie_server --daemon # background, PID file under ~/.my-cert
    python3 -m server.cookie_server --help

Endpoints:

* ``GET  /status``         – health check + list of saved sites
* ``POST /save``           – persist a single site payload
* ``POST /save-recording`` – persist an API recording

All POST endpoints require the ``X-Cert-Keeper-Token`` header to match the
value persisted at ``~/.my-cert/.token`` (auto-generated on first run).  The
``GET /status`` endpoint is unauthenticated for liveness checks but only
returns site identifiers, never cookie values.

The server binds to ``127.0.0.1`` only and refuses non-loopback peers.
"""

from __future__ import annotations

import argparse
import http.server
import json
import logging
import os
import signal
import socket
import sys
import threading
from pathlib import Path

from . import auth, storage

LOG = logging.getLogger("cert-keeper.server")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 19222
PID_FILE = storage.DEFAULT_BASE_DIR / ".server.pid"


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CertKeeper/1.0"

    # Keep the default stderr log noise down
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    # ---- helpers ----------------------------------------------------------
    def _reject_remote(self) -> bool:
        peer = self.client_address[0] if self.client_address else ""
        if peer not in ("127.0.0.1", "::1", "localhost"):
            self._json(403, {"error": "loopback only"})
            return True
        return False

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        # Allow the extension to call us from any origin; we rely on token auth.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            f"Content-Type, {auth.HEADER_NAME}",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 16 * 1024 * 1024:
            self._json(400, {"error": "invalid Content-Length"})
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._json(400, {"error": f"invalid JSON: {exc}"})
            return None
        if not isinstance(data, dict):
            self._json(400, {"error": "expected JSON object"})
            return None
        return data

    def _check_token(self) -> bool:
        token = self.headers.get(auth.HEADER_NAME)
        if not auth.verify(token):
            self._json(401, {"error": "invalid token"})
            return False
        return True

    # ---- routes -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self._json(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if self._reject_remote():
            return
        if self.path.split("?", 1)[0] != "/status":
            self._json(404, {"error": "not found"})
            return
        self._json(200, {
            "ok": True,
            "version": self.server_version,
            "sites": storage.list_sites(),
        })

    def do_POST(self) -> None:  # noqa: N802
        if self._reject_remote():
            return
        route = self.path.split("?", 1)[0]
        if route not in ("/save", "/save-recording"):
            self._json(404, {"error": "not found"})
            return
        if not self._check_token():
            return
        body = self._read_json()
        if body is None:
            return
        try:
            if route == "/save":
                result = storage.save_site(body)
            else:
                result = storage.save_recording(body)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        except OSError as exc:
            LOG.exception("save failed")
            self._json(500, {"error": f"io error: {exc}"})
            return
        self._json(200, {"ok": True, **result})


class _ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ---------------------------------------------------------------------------
# Daemonisation
# ---------------------------------------------------------------------------

def _is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_pid() -> int:
    try:
        return int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return 0


def stop_daemon() -> bool:
    pid = _read_pid()
    if not _is_running(pid):
        try:
            PID_FILE.unlink()
        except OSError:
            pass
        return False
    os.kill(pid, signal.SIGTERM)
    return True


def _daemonise() -> None:
    if sys.platform.startswith("win"):
        raise SystemExit("--daemon is not supported on Windows; run without --daemon "
                         "and use a service manager (NSSM, Task Scheduler, etc.)")
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    os.chdir("/")
    fd_null = os.open(os.devnull, os.O_RDWR)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            os.dup2(fd_null, stream.fileno())
        except (OSError, ValueError):
            pass


def _write_pid() -> None:
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))


def serve(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
    """Run the HTTP server until interrupted."""
    auth.load_or_create()  # ensure token exists before first request

    try:
        srv = _ThreadingServer((host, port), _Handler)
    except OSError as exc:
        raise SystemExit(f"cannot bind {host}:{port}: {exc}") from exc

    LOG.info("cert-keeper server listening on http://%s:%d", host, port)

    def _shutdown(*_):
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
        try:
            if _read_pid() == os.getpid():
                PID_FILE.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="cert-keeper local HTTP server")
    p.add_argument("--host", default=DEFAULT_HOST, help="bind host (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port (default: 19222)")
    p.add_argument("--daemon", action="store_true", help="run in background")
    p.add_argument("--stop", action="store_true", help="stop a running daemon")
    p.add_argument("--status", action="store_true", help="print daemon status and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.stop:
        ok = stop_daemon()
        print("stopped" if ok else "not running")
        return 0

    if args.status:
        pid = _read_pid()
        if _is_running(pid):
            try:
                with socket.create_connection((args.host, args.port), timeout=1):
                    pass
                print(f"running pid={pid} listening on http://{args.host}:{args.port}")
            except OSError:
                print(f"pid file present (pid={pid}) but port {args.port} not reachable")
        else:
            print("not running")
        return 0

    pid = _read_pid()
    if _is_running(pid):
        raise SystemExit(f"server already running (pid={pid})")

    if args.daemon:
        _daemonise()

    _write_pid()
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
