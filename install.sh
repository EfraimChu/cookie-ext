#!/usr/bin/env bash
# Cert Keeper —— 一键安装脚本
#
# 用法（推荐通过 jsDelivr 公开 CDN 拉取，无需克隆仓库）：
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/install.sh | bash
#
# 也可指定具体 tag / commit：
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@v3.1.0/install.sh | bash
#
# 环境变量：
#   CERT_KEEPER_REPO     默认 EfraimChu/cookie-ext
#   CERT_KEEPER_VERSION  默认 latest（拉最新 GitHub Release）
#   CERT_KEEPER_PREFIX   默认 ~/.my-cert（解压目录）
#   CERT_KEEPER_BIN      默认 ~/.local/bin（软链目录）
#   CERT_KEEPER_NO_PATH=1  跳过往 shell rc 写 PATH
#
# 仅安装 Python bridge + CLI；浏览器扩展请仍走 chrome://extensions「加载已解压的扩展程序」。

set -euo pipefail

REPO="${CERT_KEEPER_REPO:-EfraimChu/cookie-ext}"
VERSION="${CERT_KEEPER_VERSION:-latest}"
PREFIX="${CERT_KEEPER_PREFIX:-$HOME/.my-cert}"
BIN_DIR="${CERT_KEEPER_BIN:-$HOME/.local/bin}"

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

die() { c_red "✗ $*" >&2; exit 1; }

# ── 1. 前置检查 ───────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need curl
need unzip
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  die "未找到 python3，请先安装 Python ≥ 3.7"
fi

PY_VER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
case "$PY_VER" in
  3.[0-6]) die "Python 版本过低（${PY_VER}），需要 ≥ 3.7" ;;
esac

c_blue "▶ Cert Keeper 安装器"
c_dim  "  仓库:      $REPO"
c_dim  "  版本:      $VERSION"
c_dim  "  安装目录:  $PREFIX"
c_dim  "  CLI 软链:  $BIN_DIR/cert-keeper"
c_dim  "  Python:    $PY ($PY_VER)"
echo

# ── 2. 解析最终版本号 + 下载链接 ─────────────────────────────
api="https://api.github.com/repos/$REPO/releases"
if [ "$VERSION" = "latest" ]; then
  api="$api/latest"
else
  api="$api/tags/$VERSION"
fi

c_blue "▶ 查询 release 信息..."
release_json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api") \
  || die "无法访问 GitHub API（${api}）"

# 用 Python 解析 JSON，避免依赖 jq
parsed=$(printf '%s' "$release_json" | "$PY" -c '
import json, sys
r = json.load(sys.stdin)
tag = r.get("tag_name") or ""
asset = ""
for a in r.get("assets", []):
    n = a.get("name", "")
    if n.startswith("cert-keeper-") and n.endswith(".zip"):
        asset = a.get("browser_download_url", "")
        break
print(tag)
print(asset)
')
tag=$(printf '%s\n' "$parsed" | sed -n '1p')
asset_url=$(printf '%s\n' "$parsed" | sed -n '2p')

[ -n "$tag" ]       || die "未取到 tag_name"
[ -n "$asset_url" ] || die "release $tag 中未找到 cert-keeper-*.zip 资源"

c_green "✓ 将安装版本：$tag"
c_dim   "  下载: $asset_url"

# ── 3. 下载并解压 ────────────────────────────────────────────
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

zip_path="$tmp/cert-keeper.zip"
c_blue "▶ 下载发行包..."
curl -fL --progress-bar -o "$zip_path" "$asset_url"

# 校验 sha256（如果发布带了 .sha256）
sha_url="${asset_url}.sha256"
if curl -fsSL -o "$tmp/sum" "$sha_url" 2>/dev/null; then
  expected=$(awk '{print $1}' "$tmp/sum")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$zip_path" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$zip_path" | awk '{print $1}')
  else
    actual=""
  fi
  if [ -n "$actual" ]; then
    [ "$expected" = "$actual" ] || die "SHA-256 校验失败：期望 ${expected}，实际 $actual"
    c_green "✓ SHA-256 校验通过"
  fi
fi

c_blue "▶ 解压到 $PREFIX..."
mkdir -p "$PREFIX"
# 如果旧版本存在，先备份再清理同名子目录
if [ -d "$PREFIX/cert-keeper" ]; then
  backup="$PREFIX/.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$PREFIX/cert-keeper" "$backup"
  c_dim "  已将旧版本备份到 $backup"
fi
unzip -q "$zip_path" -d "$PREFIX"
[ -d "$PREFIX/cert-keeper" ] || die "解压后未找到 cert-keeper/ 目录"

# 标记当前版本
echo "$tag" > "$PREFIX/.version"

# ── 4. 创建 CLI 软链 ────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/cert-keeper/cli/cert-keeper" "$BIN_DIR/cert-keeper"
chmod +x "$PREFIX/cert-keeper/cli/cert-keeper"
c_green "✓ 已创建 CLI 软链：$BIN_DIR/cert-keeper"

# ── 5. PATH 提示（不强制写 rc）──────────────────────────────
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  if [ "${CERT_KEEPER_NO_PATH:-}" = "1" ]; then
    c_dim "  提示：$BIN_DIR 不在 PATH 中（CERT_KEEPER_NO_PATH=1，已跳过自动写入）"
  else
    rc=""
    case "${SHELL:-}" in
      */zsh)  rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      */fish) rc="$HOME/.config/fish/config.fish" ;;
    esac
    # shellcheck disable=SC2016 # 故意写入字面量 $HOME，让 rc 在加载时再展开
    line='export PATH="$HOME/.local/bin:$PATH"'
    if [ -n "$rc" ] && [ -f "$rc" ] && ! grep -qsF "$line" "$rc"; then
      printf '\n# Added by cert-keeper installer\n%s\n' "$line" >> "$rc"
      c_green "✓ 已向 $rc 追加 PATH（重新打开终端或 source 后生效）"
    else
      c_dim "  请手动把 $BIN_DIR 加入 PATH，例如：echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc"
    fi
  fi
fi

# ── 6. 后续步骤提示 ─────────────────────────────────────────
echo
c_green "🎉 安装完成！"
cat <<TIP

下一步：

  # 1) 启动本地桥（守护进程）
  cert-keeper start --daemon

  # 2) 查看共享 token（扩展设置面板里要填这个，或改用 Native Messaging）
  cert-keeper token

  # 3) 在 Chrome 加载扩展
  #    chrome://extensions → 开发者模式 → 加载已解压的扩展程序
  #    选择目录： $PREFIX/cert-keeper

  # 4) 想免 token？注册 Native Messaging host（chrome://extensions 里复制扩展 ID）
  cert-keeper install-native-host --extension-id <扩展ID>

文档：
  $PREFIX/cert-keeper/README.md
  $PREFIX/cert-keeper/AGENTS.md   ← AI agent 接入指引

卸载：
  curl -fsSL https://cdn.jsdelivr.net/gh/$REPO@$tag/uninstall.sh | bash
TIP
