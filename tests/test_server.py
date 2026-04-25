"""Tests for server.storage and the HTTP server end-to-end."""

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["CERT_KEEPER_HOME"] = self.tmp
        for mod in [m for m in list(sys.modules) if m.startswith("server")]:
            del sys.modules[mod]
        from server import storage  # noqa: PLC0415
        self.storage = storage

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_site_writes_all_formats(self):
        res = self.storage.save_site({
            "site_id": "demo",
            "name": "Demo",
            "url": "https://example.com",
            "cookies": "a=1; b=2",
            "localStorage": {"k": "v"},
        })
        site_dir = Path(res["path"])
        self.assertEqual(res["cookie_count"], 2)
        for name in ("cookies.txt", "cookies.json", "storage_state.json", "raw.json"):
            self.assertTrue((site_dir / name).exists(), name)
        if os.name == "posix":
            mode = (site_dir / "cookies.txt").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_save_site_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            self.storage.save_site({"site_id": "../etc", "url": "https://x"})

    def test_storage_state_contains_localstorage(self):
        res = self.storage.save_site({
            "site_id": "ls",
            "url": "https://example.com",
            "cookies_detail": [{"name": "c", "value": "1", "domain": "example.com"}],
            "localStorage": {"k": "v"},
        })
        state = json.loads((Path(res["path"]) / "storage_state.json").read_text())
        self.assertEqual(state["origins"][0]["origin"], "https://example.com")
        self.assertEqual(state["origins"][0]["localStorage"], [{"name": "k", "value": "v"}])


class HttpServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.port = _free_port()
        env = os.environ.copy()
        env["CERT_KEEPER_HOME"] = cls.tmp
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "server.cookie_server", "--port", str(cls.port)],
            cwd=ROOT, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            cls.proc.terminate()
            raise RuntimeError("server did not start in time")
        cls.token = (Path(cls.tmp) / ".token").read_text().strip()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _post(self, path, body, *, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Cert-Keeper-Token"] = token
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_status_unauthenticated(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/status", timeout=5) as r:
            self.assertEqual(r.status, 200)
            data = json.loads(r.read())
            self.assertTrue(data["ok"])

    def test_save_requires_token(self):
        status, _ = self._post("/save", {"site_id": "x", "url": "https://x", "cookies": "a=1"})
        self.assertEqual(status, 401)

    def test_save_with_token(self):
        status, body = self._post(
            "/save",
            {"site_id": "good", "url": "https://x.com", "cookies": "a=1; b=2"},
            token=self.token,
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["cookie_count"], 2)

    def test_save_rejects_bad_site_id(self):
        status, body = self._post(
            "/save",
            {"site_id": "../oops", "url": "https://x", "cookies": "a=1"},
            token=self.token,
        )
        self.assertEqual(status, 400)
        self.assertIn("invalid", body["error"])


class NativeHostTests(unittest.TestCase):
    def test_roundtrip(self):
        tmp = tempfile.mkdtemp()
        env = os.environ.copy()
        env["CERT_KEEPER_HOME"] = tmp
        proc = subprocess.Popen(
            [sys.executable, "-m", "server.native_host"],
            cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            def send(obj):
                data = json.dumps(obj).encode()
                proc.stdin.write(struct.pack("<I", len(data)) + data)
                proc.stdin.flush()

            def recv():
                n = struct.unpack("<I", proc.stdout.read(4))[0]
                return json.loads(proc.stdout.read(n))

            send({"action": "ping"})
            self.assertTrue(recv()["ok"])

            send({"action": "save", "payload": {
                "site_id": "nh", "url": "https://x.com", "cookies": "a=1",
            }})
            reply = recv()
            self.assertTrue(reply["ok"])
            self.assertEqual(reply["site_id"], "nh")
        finally:
            proc.stdin.close()
            proc.wait(timeout=5)
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
