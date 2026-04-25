"""Register the cert-keeper Native Messaging host with Chrome / Chromium.

Usage:

    python3 -m server.install_native_host --extension-id <id>
    python3 -m server.install_native_host --extension-id <id> --uninstall

Where ``<id>`` is the unpacked extension's ID shown on ``chrome://extensions``.

The script writes a JSON manifest in each platform-specific directory that
Chrome / Chromium / Edge / Brave look at on startup:

    macOS  : ~/Library/Application Support/<browser>/NativeMessagingHosts/
    Linux  : ~/.config/<browser>/NativeMessagingHosts/
    Windows: HKCU\\Software\\<Vendor>\\<Browser>\\NativeMessagingHosts\\<host>

The manifest points at the ``server.native_host`` module via a small
launcher script we also create, so users do not have to know the absolute
path of the Python interpreter at install time.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path

HOST_NAME = "io.shopee.cert_keeper"


def _user_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
        return [
            base / "Google" / "Chrome" / "NativeMessagingHosts",
            base / "Chromium" / "NativeMessagingHosts",
            base / "Microsoft Edge" / "NativeMessagingHosts",
            base / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
        ]
    if sys.platform.startswith("linux"):
        base = home / ".config"
        return [
            base / "google-chrome" / "NativeMessagingHosts",
            base / "chromium" / "NativeMessagingHosts",
            base / "microsoft-edge" / "NativeMessagingHosts",
            base / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
        ]
    # Windows is handled separately via the registry; see _install_windows().
    return []


def _make_launcher(repo_root: Path) -> Path:
    """Write a small launcher that invokes ``python3 -m server.native_host``."""
    bin_dir = repo_root / "server" / "_bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    if sys.platform.startswith("win"):
        launcher = bin_dir / "cert_keeper_native_host.bat"
        # Match the Unix launcher: cd into the repo root before invoking the
        # module so that imports work regardless of how Chrome spawns us.
        launcher.write_text(
            "@echo off\r\n"
            f'cd /d "{repo_root}"\r\n'
            f'"{sys.executable}" -m server.native_host %*\r\n',
            encoding="utf-8",
        )
        return launcher

    launcher = bin_dir / "cert_keeper_native_host.sh"
    launcher.write_text(
        "#!/usr/bin/env bash\n"
        f'cd "{repo_root}"\n'
        f'exec "{sys.executable}" -m server.native_host "$@"\n',
        encoding="utf-8",
    )
    os.chmod(
        launcher,
        stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR
        | stat.S_IRGRP | stat.S_IXGRP
        | stat.S_IROTH | stat.S_IXOTH,
    )
    return launcher


def _manifest(launcher: Path, extension_id: str) -> dict:
    return {
        "name": HOST_NAME,
        "description": "cert-keeper local credential bridge",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


_EXT_ID_RE = re.compile(r"^[a-p]{32}$")


def _validate_extension_id(extension_id: str) -> str:
    eid = extension_id.strip().lower()
    if not _EXT_ID_RE.match(eid):
        raise SystemExit(
            "extension id must be 32 lowercase letters a-p "
            "(see chrome://extensions in developer mode)"
        )
    return eid


def _install_unix(manifest: dict, *, uninstall: bool) -> list[str]:
    touched: list[str] = []
    for d in _user_dirs():
        d.mkdir(parents=True, exist_ok=True)
        target = d / f"{HOST_NAME}.json"
        if uninstall:
            if target.exists():
                target.unlink()
                touched.append(f"removed {target}")
            continue
        target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        touched.append(f"wrote {target}")
    return touched


def _install_windows(manifest: dict, manifest_path: Path, *, uninstall: bool) -> list[str]:
    import winreg  # type: ignore[import-not-found]

    touched: list[str] = []
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    if not uninstall:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        touched.append(f"wrote {manifest_path}")

    for vendor in (
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Chromium\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    ):
        key_path = f"{vendor}\\{HOST_NAME}"
        if uninstall:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                touched.append(f"deleted HKCU\\{key_path}")
            except FileNotFoundError:
                pass
            continue
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path))
        touched.append(f"set HKCU\\{key_path}")
    return touched


def install(extension_id: str, *, uninstall: bool = False) -> list[str]:
    repo_root = Path(__file__).resolve().parent.parent
    launcher = _make_launcher(repo_root)
    manifest = _manifest(launcher, _validate_extension_id(extension_id))

    if sys.platform.startswith("win"):
        manifest_path = repo_root / "server" / "_bin" / f"{HOST_NAME}.json"
        return _install_windows(manifest, manifest_path, uninstall=uninstall)
    return _install_unix(manifest, uninstall=uninstall)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="install Native Messaging host manifest")
    p.add_argument("--extension-id", required=True, help="Chrome extension id (32 chars a-p)")
    p.add_argument("--uninstall", action="store_true", help="remove the manifest instead")
    args = p.parse_args(argv)

    actions = install(args.extension_id, uninstall=args.uninstall)
    for line in actions:
        print(line)
    if not actions:
        print("no browser native-messaging directories were detected")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
