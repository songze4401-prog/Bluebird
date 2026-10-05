gh codespace ports visibility 3000:public -c "$CODESPACE_NAME"
gh codespace ports visibility 8081:public -c "$CODESPACE_NAME"

# blue 快捷命令（幂等：已存在则不重复追加）
# 通过脚本自身位置推导 blue-start.sh，不依赖固定的工作区名
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLUE_START="$DEV_DIR/../scripts/blue-start.sh"
grep -q "alias blue=" ~/.bashrc 2>/dev/null || \
  echo "alias blue='$BLUE_START'" >> ~/.bashrc
