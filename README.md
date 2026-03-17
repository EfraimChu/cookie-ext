# Cert Keeper — Chrome Extension

Multi-site credential management + API recording for building Cursor Skills.

## Features

### 🔐 Credential Sync
- Extract **cookies** and **localStorage** from multiple configured sites
- One-click sync all credentials to local server (`~/.my-cert/`)
- Auto-sync every 30 minutes during work hours (Mon–Fri 9:30–19:00)
- Auto-detect current tab for quick site addition

### 🎬 API Recording
- Record all XHR/Fetch requests on any tab
- Capture: URL, method, headers, request body, status, response headers, duration
- View / filter / search recorded requests
- **Edit** any field (method, URL, body) inline
- **Copy as cURL** for individual requests
- **Export** as JSON or save to disk

### 🧩 Skill Generation
- Convert recorded API chains into Cursor Skill markdown templates
- Includes: step-by-step API docs, key headers, request bodies, cURL examples
- Use recordings to analyze feature workflows and build reliable automation

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this directory
4. Pin the extension for quick access

## Local Server

The extension pushes credentials to a local Python server:

```bash
python3 cookie_server.py            # foreground
python3 cookie_server.py --daemon   # background with PID management
```

Endpoints:
- `POST /save` — receive site credentials from extension
- `POST /save-recording` — save API recording to disk
- `GET /status` — health check + list saved sites

Storage: `~/.my-cert/`

## CLI Tools

| Command | Description |
|---------|-------------|
| `refresh-cookie` | Start server, wait for extension push |
| `refresh-cookie -s` | Show saved credential status |
| `one-check` | Full auth chain verification |

## Architecture

```
Chrome Extension (Cert Keeper)
    ↓ POST /save (cookies + localStorage)
    ↓ POST /save-recording (API chain)
localhost:19222 (cookie_server.py)
    ↓ saves to ~/.my-cert/<site>/
    ↓ syncs to skill configs (env files, mcp.json)
```

## License

MIT
