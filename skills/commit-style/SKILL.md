---
name: 提交信息规范
description: 按约定式提交（Conventional Commits）撰写 commit message 与 PR 标题
---

# 提交信息规范

写 commit message 或 PR 标题时遵循：

- 格式：`type(scope): 摘要`；type 取 feat / fix / chore / docs / refactor / test。
- 摘要用中文、祈使句、不超过 50 字，不加句号。
- 正文（可选）：空一行后说明「为什么改」，不逐行复述 diff。
- 破坏性变更：摘要加 `!`，正文写 `BREAKING CHANGE:` 说明。

示例：`fix(memory): 合并候选在跨会话场景下保留原始贡献`
