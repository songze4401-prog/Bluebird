#!/bin/bash
# Bluebird 数据备份（Linux / Codespaces）—— 兼容入口，实现在 scripts/bluebird-backup.js
#
# 为什么改成委托：旧版本只 `cp` 数据目录的**顶层文件**，`uploads/`（聊天图片）与
# `sticker-repo/`（表情包仓库）是目录，会被静默跳过——备份看着成功，恢复时图片全没了。
# 现在只有一份实现（Node），两个历史入口都转发过去，杜绝行为分叉。
#
#   bash scripts/blue-backup.sh                 # -> $HOME/bluebird-backups/data-<ts>/
#   bash scripts/blue-backup.sh /mnt/usb        # 位置参数 = 备份根（等价 --out-dir）
#   bash scripts/blue-backup.sh --check         # 新式参数原样透传
#
# 源目录取 BLUEBIRD_DATA_DIR，否则 <仓库根>/server/data；备份根取 BLUEBIRD_BACKUP_DIR，
# 否则 $HOME/bluebird-backups。退出码：0 成功 / 1 备份失败 / 2 状态检查未通过。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/bluebird-backup.js"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 node（备份 CLI 依赖 Node 运行）"
  exit 1
fi

if [ $# -ge 1 ] && [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
  # 位置参数：历史上表示「备份根」，映射为 --out-dir
  exec node "$CLI" --out-dir "$1" "${@:2}"
fi

exec node "$CLI" "$@"
