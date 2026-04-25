# Changelog

## v3.1.0 (2026-04-25)

首次公开发布。

- Chrome MV3 扩展：周期同步多站点 cookies / localStorage
- 本地 HTTP 桥（`server/cookie_server.py`，127.0.0.1:19222）+ Native Messaging 双通道
- CLI 入口 `cert-keeper`：start / stop / status / token / install-native-host
- API 录制器：XHR/Fetch → JSON / cURL
- 一键安装脚本：`curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/install.sh | bash`
