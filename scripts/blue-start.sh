#!/bin/bash
# Bluebird 一键启动：后端 API (3000) + Expo Metro (8081)
# 幂等：已在运行的服务不会重复启动

# 从脚本自身位置推导仓库根目录，不依赖固定的工作区名
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "✗ 无法进入项目目录: $REPO_ROOT"; exit 1; }

echo "Bluebird starting..."

# ---- 后端 API :3000 ----
if curl -sf -o /dev/null --max-time 2 http://localhost:3000/; then
  echo "✓ API :3000 (已在运行)"
else
  nohup node server/index.js > /tmp/bluebird-api.log 2>&1 &
  sleep 2
  if curl -sf -o /dev/null --max-time 2 http://localhost:3000/; then
    echo "✓ API :3000"
  else
    echo "✗ API :3000 启动失败，日志: /tmp/bluebird-api.log"
    exit 1
  fi
fi

# ---- Expo Metro :8081 ----
if curl -sf -o /dev/null --max-time 2 http://localhost:8081/status; then
  echo "✓ Expo :8081 (已在运行)"
else
  EXPO_PACKAGER_PROXY_URL="https://${CODESPACE_NAME}-8081.app.github.dev" \
    nohup npx expo start > /tmp/bluebird-expo.log 2>&1 &

  # Metro 冷启动较慢，最多等 40 秒
  for i in $(seq 1 40); do
    sleep 1
    if curl -sf -o /dev/null --max-time 2 http://localhost:8081/status; then
      break
    fi
  done

  if curl -sf -o /dev/null --max-time 2 http://localhost:8081/status; then
    echo "✓ Expo :8081"
  else
    echo "✗ Expo :8081 启动失败，日志: /tmp/bluebird-expo.log"
    exit 1
  fi
fi

echo "✓ Ready"
