"""Chrome Native Messaging host for cert-keeper.

The browser launches this script (path is in the host manifest, see
``install_native_host.py``).  Communication uses Chrome's framed protocol on
stdin / stdout: a 4-byte little-endian length prefix followed by a UTF-8 JSON
payload.

We accept the same payloads the HTTP ``/save`` endpoint accepts:

    {"action": "save",            "payload": {...}}
    {"action": "save-recording",  "payload": {...}}
    {"action": "status"}
    {"action": "ping"}

and reply with ``{"ok": true, ...}`` or ``{"ok": false, "error": "..."}``.

Native messaging implicitly authenticates the caller via the
``allowed_origins`` list in the host manifest, so no token is required here.
"""

from __future__ import annotations

import json
import struct
import sys
import traceback

from . import storage

_MAX_MESSAGE_BYTES = 16 * 1024 * 1024  # Chrome's documented limit is 64 MB; be conservative


def _read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None  # browser closed the pipe
    (size,) = struct.unpack("<I", raw_len)
    if size <= 0 or size > _MAX_MESSAGE_BYTES:
        raise ValueError(f"invalid native message size: {size}")
    data = sys.stdin.buffer.read(size)
    if len(data) < size:
        raise EOFError("truncated native message")
    return json.loads(data.decode("utf-8"))


def _write_message(obj: dict) -> None:
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _dispatch(msg: dict) -> dict:
    action = msg.get("action")
    payload = msg.get("payload") or {}
    if action == "save":
        return {"ok": True, **storage.save_site(payload)}
    if action == "save-recording":
        return {"ok": True, **storage.save_recording(payload)}
    if action == "status":
        return {"ok": True, "sites": storage.list_sites()}
    if action == "ping":
        return {"ok": True, "pong": True}
    return {"ok": False, "error": f"unknown action: {action!r}"}


def main() -> int:
    while True:
        try:
            msg = _read_message()
        except (ValueError, EOFError) as exc:
            _write_message({"ok": False, "error": str(exc)})
            return 1
        if msg is None:
            return 0
        try:
            reply = _dispatch(msg)
        except Exception as exc:  # noqa: BLE001 – report any failure back
            reply = {
                "ok": False,
                "error": str(exc),
                "trace": traceback.format_exc(limit=4),
            }
        _write_message(reply)


if __name__ == "__main__":
    raise SystemExit(main())
