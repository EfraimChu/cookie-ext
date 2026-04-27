#!/usr/bin/env bash
# Cert Keeper —— 卸载脚本
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/EfraimChu/cookie-ext@latest/uninstall.sh | bash
#
# 环境变量同 install.sh：CERT_KEEPER_PREFIX、CERT_KEEPER_BIN
# 不会动 ~/.my-cert（保留已抓取的凭据）；想一并清理请加 CERT_KEEPER_PURGE=1

set -euo pipefail

PREFIX="${CERT_KEEPER_PREFIX:-$HOME/.my-cert}"
BIN_DIR="${CERT_KEEPER_BIN:-$HOME/.local/bin}"
PURGE="${CERT_KEEPER_PURGE:-0}"

c_blue() { printf '\033[34m%s\033[0m\n' "$*"; }
c_green(){ printf '\033[32m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

# 1) 停掉守护进程（如果还在跑）
if [ -x "$BIN_DIR/cert-keeper" ]; then
  c_blue "▶ 停止守护进程..."
  "$BIN_DIR/cert-keeper" stop || true
fi

# 2) 删 CLI 软链
if [ -L "$BIN_DIR/cert-keeper" ] || [ -f "$BIN_DIR/cert-keeper" ]; then
  rm -f "$BIN_DIR/cert-keeper"
  c_green "✓ 已删除 $BIN_DIR/cert-keeper"
fi

# 3) 删安装目录（只删程序子目录和版本文件，不删数据目录本身）
if [ -d "$PREFIX/cert-keeper" ]; then
  rm -rf "$PREFIX/cert-keeper"
  c_green "✓ 已删除 $PREFIX/cert-keeper"
fi
rm -f "$PREFIX/.version"

# 4) 视情况清理凭据 / Native Messaging manifest
if [ "$PURGE" = "1" ]; then
  if [ -d "$HOME/.my-cert" ]; then
    rm -rf "$HOME/.my-cert"
    c_green "✓ 已删除 $HOME/.my-cert（包括 token 与已抓取的 cookies）"
  fi
  case "$(uname -s)" in
    Darwin)
      base="$HOME/Library/Application Support"
      ;;
    Linux)
      base="$HOME/.config"
      ;;
    *)
      base=""
      ;;
  esac
  if [ -n "$base" ]; then
    for d in "Google/Chrome" "Chromium" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
      f="$base/$d/NativeMessagingHosts/io.shopee.cert_keeper.json"
      [ -f "$f" ] && rm -f "$f" && c_green "✓ 已删除 $f"
    done
  fi
else
  c_dim "  保留 ~/.my-cert（凭据数据）；如需一并清理：CERT_KEEPER_PURGE=1 重跑"
fi

c_green "🧹 卸载完成"
