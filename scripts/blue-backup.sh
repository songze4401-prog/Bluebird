#!/bin/bash
# Bluebird 数据备份（Linux / Codespaces）
# 把数据目录里的全部数据文件带时间戳拷贝到仓库之外。
# 只读源目录：不修改、不删除、不覆盖源文件；不覆盖已存在的备份目录。
# 运行期产物（.bluebird.lock、*.tmp.*）不备份：锁文件混进备份会在恢复时误报「已有实例在运行」。
#
#   bash scripts/blue-backup.sh            # -> $HOME/bluebird-backups/data-<ts>/
#   bash scripts/blue-backup.sh /mnt/usb   # 指定输出根目录
#
# 源目录默认取 BLUEBIRD_DATA_DIR，否则 <仓库根>/server/data（与服务端一致）；
# 输出根目录默认取 BLUEBIRD_BACKUP_DIR，否则 $HOME/bluebird-backups。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${BLUEBIRD_DATA_DIR:-$REPO_ROOT/server/data}"
OUT_ROOT="${BLUEBIRD_BACKUP_DIR:-${HOME:-/tmp}/bluebird-backups}"

if [ $# -ge 1 ] && [ -n "$1" ]; then
  OUT_ROOT="$1"
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "✗ 数据目录不存在: $DATA_DIR"
  exit 1
fi

# 运行期产物：单实例锁、写入中的临时文件
is_runtime_file() {
  case "$1" in
    .bluebird.lock|*.tmp.*|*.tmp-*) return 0 ;;
    *) return 1 ;;
  esac
}

# 列出数据文件（含点文件），跳过运行期产物
FILES=""
SKIPPED=""
for src in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  if is_runtime_file "$name"; then
    SKIPPED="$SKIPPED $name"
    continue
  fi
  FILES="$FILES$src
"
done

if [ -z "$FILES" ]; then
  echo "✗ 数据目录里没有可备份的数据文件: $DATA_DIR"
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
TARGET="$OUT_ROOT/data-$STAMP"

# 不覆盖已存在的备份目录：同名则追加序号
n=2
while [ -e "$TARGET" ]; do
  TARGET="$OUT_ROOT/data-$STAMP-$n"
  n=$((n + 1))
done

mkdir -p "$TARGET" || { echo "✗ 无法创建备份目录: $TARGET"; exit 1; }

# 服务端每次落盘都是「写临时文件 + 原子改名」，改名窗口内可能短暂读不到旧文件，故失败重试一次
copy_one() {
  cp -a "$1" "$TARGET/" 2>/dev/null && return 0
  sleep 0.5
  cp -a "$1" "$TARGET/" 2>/dev/null
}

MANIFEST="$TARGET/MANIFEST.txt"
{
  echo "# Bluebird data backup"
  echo "# source:  $DATA_DIR"
  echo "# utc:     $STAMP"
  echo "# skipped:${SKIPPED:- (none)}"
  echo "# files:   (name  bytes  sha256)"
} > "$MANIFEST"

fail=0
count=0
total=0

while IFS= read -r src; do
  [ -n "$src" ] || continue

  name="$(basename "$src")"

  if ! copy_one "$src"; then
    echo "✗ 复制失败（源文件可能正在被写入）: $name"
    fail=1
    continue
  fi

  size="$(wc -c < "$src" | tr -d ' ')"
  hash="$(sha256sum "$src" | cut -d' ' -f1)"

  echo "$name  $size  $hash" >> "$MANIFEST"
  count=$((count + 1))
  total=$((total + size))

  dst="$TARGET/$name"
  if [ ! -f "$dst" ]; then
    echo "✗ 缺少副本: $name"
    fail=1
  elif [ "$(sha256sum "$dst" | cut -d' ' -f1)" != "$hash" ]; then
    echo "✗ 校验不一致: $name"
    fail=1
  fi
done <<< "$FILES"

if [ "$fail" -ne 0 ]; then
  echo "✗ 校验失败，备份可能不完整: $TARGET"
  exit 1
fi

echo "✓ 备份完成：$count 个文件，$total 字节，SHA-256 已校验"
echo "  源:   $DATA_DIR"
echo "  目标: $TARGET"
[ -n "$SKIPPED" ] && echo "  未备份（运行期产物）:$SKIPPED"
echo "  恢复：停服 → 用该目录内容替换数据目录 → 启动（见 AGENTS.md「Data safety & backup」）"
