"""Token helpers shared between the HTTP server and the Native Messaging host.

A long-lived random token is generated on first use and persisted at
``~/.my-cert/.token`` with mode 0600.  The browser extension reads the same
token (after being shown it once via the CLI / popup) and includes it in the
``X-Cert-Keeper-Token`` header on every request.

The token never leaves the local machine; it only protects against other
processes on the same machine writing to the local server.
"""

from __future__ import annotations

import hmac
import os
import secrets
import stat
from pathlib import Path

from .storage import DEFAULT_BASE_DIR

TOKEN_FILE = DEFAULT_BASE_DIR / ".token"
HEADER_NAME = "X-Cert-Keeper-Token"


def _write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, stat.S_IRWXU)
    except OSError:
        pass
    path.write_text(value, encoding="utf-8")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def load_or_create() -> str:
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    _write(TOKEN_FILE, token)
    return token


def reset() -> str:
    token = secrets.token_urlsafe(32)
    _write(TOKEN_FILE, token)
    return token


def verify(provided: str | None) -> bool:
    expected = load_or_create()
    if not provided:
        return False
    return hmac.compare_digest(expected, provided)
