gh codespace ports visibility 3000:public -c "$CODESPACE_NAME"
gh codespace ports visibility 8081:public -c "$CODESPACE_NAME"

# blue 快捷命令（幂等：已存在则不重复追加）
grep -q "alias blue=" ~/.bashrc 2>/dev/null || \
  echo "alias blue='/workspaces/yunxiu-app/scripts/blue-start.sh'" >> ~/.bashrc
