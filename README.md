# Cert Keeper · Chrome 扩展 + 本地凭据桥

让多个站点的 cookies / localStorage 周期性落到本机 `~/.my-cert/<站点>/`，
任何 agent / shell 工具都能直接读文件用，**不用自己再写登录或浏览器自动化**。

> 想让 AI agent 接入？请先看 [AGENTS.md](./AGENTS.md)。

---

## 安装

### 方式一：一键安装（推荐，公开 CDN）

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/install.sh | bash
```

脚本会：

1. 通过 GitHub Release API 取最新版本；
2. 下载 `cert-keeper-<version>.zip`，校验 SHA-256；
3. 解压到 `~/.cert-keeper/cert-keeper/`；
4. 在 `~/.local/bin/` 创建 `cert-keeper` 软链；
5. 必要时把 `~/.local/bin` 写入 `.zshrc` / `.bashrc`。

可用环境变量覆盖默认值：

| 变量                   | 默认                 | 用途                                |
| ---------------------- | -------------------- | ----------------------------------- |
| `CERT_KEEPER_VERSION`  | `latest`             | 装指定版本，例如 `v3.1.0`           |
| `CERT_KEEPER_PREFIX`   | `~/.cert-keeper`     | 解压目录                            |
| `CERT_KEEPER_BIN`      | `~/.local/bin`       | CLI 软链目录                        |
| `CERT_KEEPER_NO_PATH`  | -                    | `=1` 跳过自动写 PATH                |
| `CERT_KEEPER_REPO`     | `EfraimChu/cookie-ext` | 用 fork 时改这里                    |

### 方式二：从 GitHub Release 手动下载

- 在 [Releases](../../releases/latest) 下载 `cert-keeper-<version>.zip`
- 解压到任意位置
- 进入解压目录后执行 `./cli/cert-keeper start --daemon`

### 方式三：从源码

```bash
git clone https://github.com/EfraimChu/cookie-ext.git
cd cookie-ext
./cli/cert-keeper start --daemon
```

### 加载浏览器扩展

`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压后的目录。

> Chrome 不允许非 Web Store 扩展自动更新。要升级时重新跑一次 `install.sh`，再到扩展页点「重新加载」即可。

---

## 卸载

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/uninstall.sh | bash
```

默认保留 `~/.my-cert/`（已抓到的凭据）。要彻底清理：

```bash
CERT_KEEPER_PURGE=1 curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/uninstall.sh | bash
```

---

## CLI 速查

```text
cert-keeper start [--daemon] [--port 19222]   # 启动本地桥
cert-keeper stop                              # 停止守护进程
cert-keeper status                            # 健康 + 已抓到的站点
cert-keeper show <site> [--format txt|json|storage-state]
cert-keeper path <site> [--format txt|json|storage-state]
cert-keeper token [--reset] [-q]              # 查看 / 重置共享 token
cert-keeper install-native-host --extension-id <id> [--uninstall]
```

`<id>` 是 `chrome://extensions` 开发者模式下显示的 32 位扩展 ID。

---

## Native Messaging（可选，免 token）

可以让扩展走 Chrome 原生管道而不是 TCP，省掉端口冲突和 token 配置：

```bash
cert-keeper install-native-host --extension-id <扩展ID>
```

然后在扩展设置面板里勾选「优先使用 Native Messaging」。HTTP 模式仍作为兜底。

---

## 凭据落盘位置

默认基目录 `~/.my-cert/`（可用环境变量 `CERT_KEEPER_HOME` 覆盖）。
每个站点一个目录，同时落 4 种格式，让任何工具都能开箱即用：

| 文件                 | 格式                       | 例子                                                                |
| -------------------- | -------------------------- | ------------------------------------------------------------------- |
| `cookies.txt`        | Netscape                   | `curl -b cookies.txt`、`yt-dlp --cookies cookies.txt`                |
| `cookies.json`       | 完整 cookie 字段数组       | Python `requests`、Node、Go 等                                       |
| `storage_state.json` | Playwright 兼容            | `browser.new_context(storage_state="storage_state.json")`            |
| `raw.json`           | 扩展原始 payload           | 调试 / 取 `_saved_at` 时间戳                                         |

文件权限统一 `0600`，目录 `0700`。

### Agent 接入示例

```bash
# curl
curl -b ~/.my-cert/datasuite/cookies.txt https://datasuite.shopee.io/api/me
```

```python
# Python (requests)
import json, os, requests
path = os.path.expanduser("~/.my-cert/datasuite/cookies.json")
jar = {c["name"]: c["value"] for c in json.load(open(path))}
requests.get("https://datasuite.shopee.io/api/me", cookies=jar)
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

## HTTP 端点

| 方法 | 路径              | 鉴权                  | 说明                            |
| ---- | ----------------- | --------------------- | ------------------------------- |
| GET  | `/status`         | 无                    | 健康检查 + 站点列表（不含值）   |
| POST | `/save`           | `X-Cert-Keeper-Token` | 落盘单站点 payload              |
| POST | `/save-recording` | `X-Cert-Keeper-Token` | 落盘 API 录制                   |

token 通过 `cert-keeper token` 获取或重置。服务只监听 `127.0.0.1` 并主动拒绝非 loopback 客户端。

---

## 功能清单

### 🔐 凭据同步
- 抓 cookies + 选定的 localStorage key
- 周期同步（间隔可配置，工作时段限制可关闭）
- 发现关键 cookie 变化（去抖 8 秒）即触发增量同步，无需等下一个心跳
- `pendingSync` 失败队列会自动重放，不会"丢同步"
- 双通道：HTTP `localhost:19222`（带 token） 或 Chrome Native Messaging

### 🎬 API 录制
- 录制任意标签页的 XHR / Fetch（URL、方法、请求头、body、状态、耗时）
- 支持过滤 / 编辑 / 导出为 JSON 或 cURL

### 🧩 Skill 模板生成
- 把录制串自动转成 Cursor Skill markdown 模板

---

## 开发

```bash
python -m unittest discover -s tests -v   # 跑后端 + Native Messaging 测试
scripts/build.sh                          # 本地复刻 release zip 到 dist/
node --check background.js popup.js config.js
```

CI（`.github/workflows/ci.yml`）会跑同样的检查，外加 manifest 解析与 build 烟雾测试。

发布走 `.github/workflows/release.yml`，推 `v*` tag 后自动产物：把扩展 + server + CLI + 安装脚本 + README + AGENTS 一起打包成 zip 上传到 GitHub Release。

---

## 架构图

```
                ┌────────────────────────┐
                │ Chrome 扩展             │
                │  · cookies.onChanged    │
                │  · alarms (周期同步)    │
                │  · pendingSync 重试队列 │
                └────────┬───────────────┘
                         │
              ┌──────────┴──────────────┐
              ▼                         ▼
   POST /save (HTTP, token)   chrome.runtime.connectNative
              │                         │
              └──────────┬──────────────┘
                         ▼
                ┌────────────────────────┐
                │ cert-keeper 本地桥      │
                │  server.cookie_server   │
                │  server.native_host     │
                └────────┬───────────────┘
                         ▼
            ~/.my-cert/<站点>/{cookies.txt,
                                cookies.json,
                                storage_state.json,
                                raw.json}
```

---

## 协议

MIT
