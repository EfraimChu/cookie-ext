# AGENTS.md — 写给 AI Agent 的项目指南

> 这份文档是为 Cursor / Claude Code / Copilot CLI 等 AI agent 准备的**机器可读项目说明**。  
> 人类开发者请看 [README.md](./README.md)。

## 1. 项目一句话说明

Cert Keeper = **Chrome 扩展 + 本地 Python 桥**。扩展把多个站点的 cookies / localStorage 周期性
落到 `~/.my-cert/<site>/` 下，**任何 agent 都能直接读文件用**，无需在 agent 里再写一遍登录 / 反爬 / 浏览器自动化。

如果你（agent）的任务里出现"调用 Shopee 内部站点 API / DataSuite / 后台 BI"之类，**先来这里读 cookies，不要自己 launch 浏览器**。

## 2. 快速判断这个项目能不能帮你

| 你在做的事                                                   | 用法                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 用 `curl` / `wget` / `yt-dlp` / `httpx` 调内部接口           | `-b ~/.my-cert/<site>/cookies.txt`                                      |
| Python `requests`                                            | 读 `~/.my-cert/<site>/cookies.json`，转成 `dict` 传给 `requests.get`    |
| `Playwright` / `puppeteer` 注入会话                          | `storage_state="~/.my-cert/<site>/storage_state.json"`                  |
| 想知道某个 cookie 的最后更新时间 / 完整属性                  | `~/.my-cert/<site>/raw.json`，里面有 `_saved_at` 时间戳和 `cookies_detail` |
| 想列出当前都有哪些站点的凭据                                 | `cert-keeper status` 或 `GET http://localhost:19222/status`             |

## 3. 仓库结构（关键路径）

```
.
├── manifest.json                  Chrome MV3 扩展清单
├── background.js                  扩展 SW（ESM）：调度同步、重试队列、Native Messaging
├── popup.{html,js}                扩展弹窗 UI + 设置面板
├── recorder.{html,js,css}         API 录制器（XHR/Fetch → JSON / cURL）
├── interceptor*.js                录制器注入到目标页的 hook
├── config.js                      扩展共享常量（DEFAULT_SITES / SETTINGS / TOKEN_HEADER）
│
├── server/                        本地 Python 桥（仓库自带，会被打包进 release）
│   ├── cookie_server.py           HTTP 模式: 127.0.0.1:19222 + token 鉴权
│   ├── native_host.py             Chrome Native Messaging host（stdin/stdout 长度前缀协议）
│   ├── install_native_host.py     一次性安装：写 host manifest 到各浏览器目录
│   ├── storage.py                 ★ 落盘逻辑：四种格式 + 0600 权限
│   └── auth.py                    ~/.my-cert/.token 生成与校验
│
├── cli/cert-keeper                Python CLI 入口（脚本而非包）
├── install.sh / uninstall.sh      公开 CDN 一键安装脚本（jsDelivr）
├── scripts/build.sh               打 release zip
├── tests/test_server.py           unittest，CI 必跑
└── .github/workflows/             CI（ci.yml） + 发布（release.yml）
```

## 4. 你最常用的两件事

### 4.1 读取 cookies（消费方）

```python
# 标准做法 —— 不要 launch 浏览器
import json, os, requests
site = "datasuite"
with open(os.path.expanduser(f"~/.my-cert/{site}/cookies.json")) as f:
    jar = {c["name"]: c["value"] for c in json.load(f)}
r = requests.get("https://datasuite.shopee.io/api/me", cookies=jar, timeout=10)
```

如果文件不存在 / `_saved_at` 太旧（>1 小时），提示用户去扩展里点一次"⬆ 一键同步"或检查
`cert-keeper status` 是否在跑。**不要尝试自己登录。**

### 4.2 启停本地桥

```bash
cert-keeper start --daemon    # 后台启动 HTTP 桥
cert-keeper status            # 健康 + 已抓到的站点
cert-keeper token -q          # 取 token（要把它配进扩展或写 X-Cert-Keeper-Token 头）
cert-keeper stop
```

## 5. 修改这个项目时的强约束

如果你被指派**修改本仓库**，必须遵守以下不变量：

1. **文档使用中文。** README / AGENTS / 注释面向中文同事，对外英文术语保留即可。
2. **凭据不离开本机。** 任何新增网络调用都必须仅指向 `127.0.0.1`。`server/cookie_server.py` 已主动 `_reject_remote()`，新增 endpoint 也要保留这个检查。
3. **写凭据文件必须 0600 / 目录 0700。** 不要绕过 `server/storage.py` 的 `_atomic_write`。
4. **`site_id` 必须经过白名单校验**（见 `storage.save_site` 的 `isalnum()` 检查），防路径穿越。
5. **token 比对必须用 `hmac.compare_digest`**，不要用 `==`。
6. **不要在仓库里提交 `~/.my-cert/`、`*.token`、任何抓到的 cookies / storage_state**。`.gitignore` 已涵盖，新增工具产物要继续走 `dist/` / `server/_bin/`。
7. **MV3 service worker 是 ES module**（`manifest.json` 的 `"type": "module"`）。新增的扩展端代码用 `import` 语法，不要回退到 `importScripts`。
8. **改了 `server/` 必须跑 `python -m unittest discover -s tests`**；改了扩展端跑 `node --check background.js popup.js config.js`。CI（`.github/workflows/ci.yml`）已经会卡这两个。
9. **改 `manifest.json` 版本号要同步打 git tag `v<version>`**，发布工作流靠 tag 触发。
10. **不要新增依赖（除非真的必须）。** server / CLI 全部走 Python 标准库；扩展端无 node_modules。

## 6. 常用命令速查

```bash
# 开发
python -m unittest discover -s tests -v          # 跑全部测试
node --check background.js                       # 扩展端语法检查
scripts/build.sh                                 # 打本地 release zip 到 dist/

# 发布（需要 tag）
git tag v3.2.0 && git push origin v3.2.0         # 触发 .github/workflows/release.yml

# 公开 CDN 一键安装（终端用户角度）
curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/install.sh | bash

# 卸载
curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/uninstall.sh | bash
# 想连 ~/.my-cert 一并删：CERT_KEEPER_PURGE=1 ... | bash
```

## 7. 端点 & 数据契约

### 7.1 HTTP（`server/cookie_server.py`）

| 方法 | 路径              | 鉴权                 | 说明                            |
| ---- | ----------------- | -------------------- | ------------------------------- |
| GET  | `/status`         | 无                   | 健康检查 + 已保存站点列表（不含 cookie 值） |
| POST | `/save`           | `X-Cert-Keeper-Token` | 落盘单站点 payload              |
| POST | `/save-recording` | `X-Cert-Keeper-Token` | 落盘 API 录制                   |

只接受 loopback 客户端，最大 body 16 MiB。

### 7.2 Native Messaging（`server/native_host.py`）

每条消息：4 字节小端长度前缀 + UTF-8 JSON。支持 `action ∈ {ping, save, save-recording, status}`。
扩展通过 `chrome.runtime.connectNative("io.shopee.cert_keeper")` 接入。鉴权由 host manifest 的 `allowed_origins` 完成，无 token。

### 7.3 落盘文件（`~/.my-cert/<site_id>/`）

| 文件                 | 格式                       | 谁来用                                                     |
| -------------------- | -------------------------- | ---------------------------------------------------------- |
| `cookies.txt`        | Netscape                   | curl / wget / yt-dlp / httpie                              |
| `cookies.json`       | `[{name,value,domain,...}]` | requests / Node / Go / 任何脚本                            |
| `storage_state.json` | Playwright storage state   | `browser.new_context(storage_state=...)`                   |
| `raw.json`           | 扩展原始 payload           | 调试 / 取 `_saved_at` 时间戳 / `cookies_detail` 全字段     |

## 8. 触发器 & 重试语义（写新功能前必读）

- `chrome.alarms` 周期性同步（默认 10 分钟，**用户可改 / 可关工作时段限制**，见 `popup.js` 设置面板）
- `chrome.cookies.onChanged` 8s 去抖触发对应站点的增量同步（捕获新登录）
- 任何 deliver 失败的 payload 进 `chrome.storage.local.pendingSync` 队列，下一次 alarm / `onStartup` / 用户点"重传积压"时回放
- `autoSync` 有重入锁；写新调用方时优先走 `triggerSync` message，不要自己复制循环

## 9. 安全 & 隐私边界

- token 只防同机其他进程，不防同机攻破账户的攻击者
- HTTP 服务器只监听 127.0.0.1
- 凭据从不上传任何远端
- 录制器抓的 request body 可能含敏感信息 → 不要默认落盘到全局位置；当前实现写到 `~/.my-cert/_recordings/<name>.json`，权限 0600

## 10. 不要做的事

- ❌ 不要把 token / cookies 写进任何 commit / log / 报错信息
- ❌ 不要为了 "agent 易用" 关掉 token 校验或开 0.0.0.0 监听
- ❌ 不要绕过 `_atomic_write` 直接 `open().write()`（会出现半写文件）
- ❌ 不要新增 `<all_urls>` 之外的更宽松权限
- ❌ 不要在 README/AGENTS 给的示例里展示真实站点的真实 token
