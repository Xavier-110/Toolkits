#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
action="${1:-start}"
if [[ $# -gt 1 || ( "$action" != start && "$action" != init ) ]]; then
  echo '用法：bash start-linux.sh [init|start]' >&2
  exit 2
fi

for command in node npm sha256sum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "缺少命令：$command" >&2
    exit 1
  fi
done

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ ! "$node_major" =~ ^[0-9]+$ || "$node_major" -lt 24 ]]; then
  echo '需要 Node.js 24 或更新版本' >&2
  exit 1
fi

platform="$(node -p "process.platform + '-' + process.arch")"
if [[ "$platform" != linux-* ]]; then
  echo '此脚本仅供 Linux 使用' >&2
  exit 1
fi

if [[ ! -f package-lock.json || ! -f server/start.mjs || ! -f server/init-admin.mjs ]]; then
  echo '发布包不完整，请在解压后的 ops-toolkit 目录运行' >&2
  exit 1
fi

lock_hash="$(sha256sum package-lock.json)"
lock_hash="${lock_hash%% *}"
stamp="${platform}:${lock_hash}"
if [[ ! -d node_modules || ! -f .linux-deps.sha256 || "$(<.linux-deps.sha256)" != "$stamp" ]]; then
  echo '首次在此 Linux 环境运行，安装生产依赖…'
  npm ci --omit=dev --no-audit --no-fund
  printf '%s\n' "$stamp" > .linux-deps.sha256
fi

if [[ "$action" == init ]]; then
  if [[ ! -t 0 ]]; then
    echo '初始化管理员需要交互终端' >&2
    exit 1
  fi
  exec node server/init-admin.mjs
fi

exec node server/start.mjs
