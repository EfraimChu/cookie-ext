# Cert Keeper — Chrome Extension + Local Bridge

Multi-site credential sync (cookies + localStorage) and API recorder for
building Cursor Skills / agent automations.

The browser extension ships with a small Python bridge so that any local
agent / shell tool can read fresh cookies straight from disk without writing
its own browser-automation code.

---

## Features

### 🔐 Credential sync
- Extract **cookies** and **localStorage** from configured sites
- Auto-sync on a configurable interval (work-hours window can be turned off)
- Instant resync when monitored cookies change (no need to wait for the next tick)
- `pendingSync` retry queue – payloads that fail are replayed automatically
  the next time the server is reachable
- Two transports out of the box: HTTP `localhost:19222` (with shared token)
  or **Chrome Native Messaging** (no port required)

### 🎬 API recording
- Capture XHR / Fetch on any tab (URL, method, headers, body, status, duration)
- Edit / filter / export as JSON or cURL

### 🧩 Skill generation
- Convert recorded API chains into Cursor Skill markdown templates

---

## Install

### From a GitHub Release (recommended)

1. Go to the project's [Releases](../../releases/latest) page
2. Download `cert-keeper-<version>.zip` and unzip
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   pick the unzipped `cert-keeper/` directory
4. Start the local bridge:

   ```bash
   cd cert-keeper
   ./cli/cert-keeper start --daemon
   ```

5. Copy the auth token into the extension's **Settings** panel (or skip this
   step if you enable Native Messaging instead, see below):

   ```bash
   ./cli/cert-keeper token -q | pbcopy   # macOS; use `xclip -sel c` on Linux
   ```

> Chrome blocks auto-update for non-Web-Store extensions. To upgrade, download
> the new release zip and click *Reload* in `chrome://extensions`. The
> extension shows a hint when a new GitHub release is available.

### From source

```bash
git clone https://github.com/EfraimChu/cookie-ext.git
cd cookie-ext
./cli/cert-keeper start --daemon
# Then load the repo directory unpacked in chrome://extensions
```

---

## CLI

```text
cert-keeper start [--daemon] [--port 19222]   # run the local HTTP bridge
cert-keeper stop                              # stop the daemon
cert-keeper status                            # daemon + saved-sites status
cert-keeper show <site> [--format txt|json|storage-state]
cert-keeper path <site> [--format txt|json|storage-state]
cert-keeper token [--reset] [-q]              # print or rotate the shared token
cert-keeper install-native-host --extension-id <id> [--uninstall]
```

`<id>` is the 32-character extension id shown on `chrome://extensions` while
in developer mode.

---

## Native Messaging (optional)

Native Messaging lets the extension talk to the local bridge through Chrome's
own pipe instead of a TCP port. Benefits:

- no port conflicts, no firewall prompts
- no shared token to copy around
- works even when no HTTP server is running

Enable it once per user:

```bash
./cli/cert-keeper install-native-host --extension-id <your-extension-id>
```

Then tick **优先使用 Native Messaging** in the extension's settings panel.
HTTP remains as a fallback if the host is missing.

---

## Where credentials are stored

Default base directory: `~/.my-cert/` (override with `CERT_KEEPER_HOME`).
Each site gets its own directory with three formats so any agent can consume
cookies with no code changes:

| File                  | Format                       | Consumer examples                                                |
|-----------------------|------------------------------|-------------------------------------------------------------------|
| `cookies.txt`         | Netscape                     | `curl -b cookies.txt`, `wget`, `yt-dlp --cookies cookies.txt`     |
| `cookies.json`        | Array of cookie dicts        | `requests.cookies`, custom Python / Node code                     |
| `storage_state.json`  | Playwright-compatible        | `browser.new_context(storage_state="storage_state.json")`         |
| `raw.json`            | Raw extension payload        | Debugging, future formats                                         |

All files are written atomically with permission `0600`; site directories
are `0700`.

### Agent integration cheat-sheet

```bash
# curl
curl -b ~/.my-cert/datasuite/cookies.txt https://datasuite.shopee.io/api/me
```

```python
# Python (requests)
import json, os, requests
path = os.path.expanduser("~/.my-cert/datasuite/cookies.json")
cookies = {c["name"]: c["value"] for c in json.load(open(path))}
requests.get("https://datasuite.shopee.io/api/me", cookies=cookies)
```

```python
# Playwright
import os
from playwright.sync_api import sync_playwright
state = os.path.expanduser("~/.my-cert/space/storage_state.json")
with sync_playwright() as p:
    ctx = p.chromium.launch().new_context(storage_state=state)
```

---

## Endpoints (HTTP transport)

| Method | Path             | Auth     | Description                       |
|--------|------------------|----------|-----------------------------------|
| GET    | `/status`        | none     | Health check + list of sites      |
| POST   | `/save`          | token    | Persist a single site payload     |
| POST   | `/save-recording`| token    | Persist an API recording          |

Authentication header: `X-Cert-Keeper-Token: <token from "cert-keeper token">`.

The server only binds to `127.0.0.1` and additionally rejects non-loopback
clients.

---

## Development

```bash
python -m unittest discover -s tests -v   # storage + HTTP + native-host tests
scripts/build.sh                          # produce dist/cert-keeper-<v>.zip
```

CI (`.github/workflows/ci.yml`) runs the same checks plus a syntax pass on
every JS file.

Releases are produced automatically by `.github/workflows/release.yml` when a
tag matching `v*` is pushed; the workflow attaches the unified zip (extension
+ server + CLI) and a SHA-256 checksum to the GitHub Release.

---

## Architecture

```
                ┌────────────────────────┐
                │ Chrome Extension       │
                │  · cookies.onChanged   │
                │  · alarms (every N min)│
                │  · pendingSync queue   │
                └────────┬───────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
   POST /save (HTTP, token)   chrome.runtime.connectNative
              │                     │
              └──────────┬──────────┘
                         ▼
                ┌────────────────────────┐
                │ cert-keeper bridge     │
                │  server.cookie_server  │
                │  server.native_host    │
                └────────┬───────────────┘
                         ▼
            ~/.my-cert/<site>/{cookies.txt,
                               cookies.json,
                               storage_state.json,
                               raw.json}
```

## License

MIT
