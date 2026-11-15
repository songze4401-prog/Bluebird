# 蓝鸟 UI 移植对照表（bluebird-home-v7 → RN 工程，2026-11-15）

> 原型：`bluebird-home-v7.html`（外部交付物，单文件含全部界面与交互）。
> 清单：《蓝鸟移植清单.md》（3 屏幕 + 9 弹层 + 5 小件 + 全局系统 + 占位 + 禁做）。
> 分支 `feat/ui-bluebird-port`。施工规矩按清单执行：**一个都不丢、不接后端、空件占位、不引新依赖**。

## 0. 接入方式（重要）

- 新 UI 是 **mock 预览壳**：全部数据来自 `data/mock.ts`（原型 state 原样移植），不接 `/chat`、`/persona`、`/agent-policy`、`/memory` 任何后端。
- 旧壳仍是生产默认，**App.tsx 一行开关**：`app/shell-config.ts` 的 `UI_V7_PREVIEW = false`。翻 `true` 即进入 v7 预览壳（`app/BluebirdApp.tsx`），再翻回即一行回滚。
- 旧壳的现有测试（app-smoke 等 22 套 / 190 用例）原样保留且全部通过。

## 1. 屏幕（3/3）

| 清单# | 组件 | RN 文件 | 状态 |
|---|---|---|---|
| 1 | 主页 | `app/HomeScreen.tsx` | ✅（Greeting 测宽对齐逗号、入口双卡、任务·定时＋开关弹跳、数据三切+迷你柱走势、四格钮、进行中 5 条、已完成 >4 条底部渐隐、对话记录、我的面板空时整块隐藏） |
| 2 | 聊天 | `app/ChatScreen.tsx` | ✅（悬浮身份组压胶囊 8px、用户黑泡右/Blue 白泡左上小角、时间戳、工具标签→工具抽屉、打字三点、加号面板 34→248 形变、图片/文件 toast 占位、模型切换→抽屉） |
| 3 | 设置 | `app/SettingsScreen.tsx` | ✅（3D 倾斜跟手卡、切换账号/系统监控只读/通知开关、外观三态+圆形扩散、壁纸横滑、强调色六圆、语言/字号/关于 v0.4.1/退出登录） |

壳 `app/BluebirdApp.tsx`：UiStateProvider + 双 pane 轨道横滑（380ms 原型同款缓动）+ 底部悬浮导航（pill 高亮滑移、选中展开标签、设置键不占 pill）+ StatusBar 深浅联动。

## 2. 弹层（9/9，一个文件一个）

| 清单# | 组件 | RN 文件 | 状态 |
|---|---|---|---|
| 1 | 编辑 | `components/EditProfileSheet.tsx` | ✅ 头像上传同步聊天图标 + 名字铅笔聚焦 + 模型 ✓ 清单 + ＋自定义添加 + 人设 4000 字计数 |
| 2 | 任务详情 | `components/TaskDetailSheet.tsx` | ✅ 阶段 ✓●○✕ 四态、结果、失败红框、Worker 产物、取消/重试/继续、已完成的重新发起 |
| 3 | 记忆面板 | `components/MemoryPanelSheet.tsx` | ✅ 等你确认（记住/不用了）→ Blue 记住的（✕ 删除）；**无任何记忆功能开关**（禁做 #2） |
| 4 | 更换头像 | `components/AvatarSheet.tsx` | ✅ 预设格子 4 列 + 从本机选择 |
| 5 | 添加定时任务 | `components/TaskAddSheet.tsx` | ✅ 时间+任务+添加（空名 toast 不关闭） |
| 6 | 新建可视化面板 | `components/VizPanelSheet.tsx` | ✅ 名称+类型三分段+创建 |
| 7 | 模型切换 | `components/ModelPickerSheet.tsx` | ✅ 拖拽抽屉（半屏吸附/快速下滑关闭） |
| 8 | 工具调用详情 | `components/ToolDetailSheet.tsx` | ✅ 拖拽抽屉，状态/工具/结果/耗时 |
| 9 | 拖拽行为 | `components/useDrawerGesture.ts` | ✅ 7/8 共用：橡皮筋 0.25、vy>0.85 关、0/半屏锚点弹簧吸附 |

## 3. 小件（5/5）

| 清单# | 组件 | RN 文件 | 状态 |
|---|---|---|---|
| 1 | 问候语 | `components/Greeting.tsx` | ✅ 两行+第二行首字对齐逗号（隐藏 Text 测量） |
| 2 | 身份组 | `components/IdentityHeader.tsx` | ✅ 圆形图标 + 名字胶囊（压胶囊 8px），只在聊天页 |
| 3 | 任务行 | `components/TaskRow.tsx` | ✅ 进行中/已完成共用 |
| 4 | 壁纸选择 | `components/WallpaperPicker.tsx` | ✅ 默认/蓝色光晕/冰蓝/＋上传 |
| 5 | 假数据包 | `data/mock.ts` | ✅ 原型 state 全量移植 |

## 4. 全局系统（5/5）

| 清单# | 系统 | 落点 |
|---|---|---|
| 1 | 主题 | `app/ui-theme.ts`（token）+ `app/ui-state.tsx`（圆形扩散：切深色圆扩散盖满后提交、切浅色沿原圆心收回） |
| 2 | 壁纸 | `app/ui-state.tsx` WallpaperLayer：default 跟随主题 / 内置两张=半透明圆层近似径向渐变 / custom 用户图 |
| 3 | 弹簧动效 | 全部 RN 内置 Animated（按压回弹、开关左移+scaleX 弹跳、抽屉弹簧、加号面板形变） |
| 4 | 全面屏 | insets 手动避让（home top+8、thread top+76、输入条 bottom+12、底栏 bottom+12） |
| 5 | 命名 | 全站无「主控」、无「Bot」后缀（冒烟测试里有断言） |

## 5. 占位与禁做

- **占位**：我的面板区（空时整块隐藏，创建后显示）；加号面板图片/文件=toast 占位不真上传；连接/项目/搭建=toast 占位。
- **禁做**（清单六条全遵守）：未接后端；未带回滚动顶部模糊/深色磨砂/Agent 策略块/记忆开关/团队管理；命名未动；未引新依赖（动效全内置 Animated；图标 emoji；品牌标复用 assets/icon.png）。

## 6. RN 适配说明（原型→RN 的语义等价替换）

1. 内联 SVG 图标 → emoji/字符（零新依赖）。
2. CSS 径向渐变（壁纸/缩略图）→ 分层半透明圆 View。
3. sparkline SVG 折线 → 迷你柱状图。
4. `<select>` → 三分段按钮组。
5. `startViewTransition` 圆形揭示 → Animated 圆 scale 0↔1（切深色扩散提交、切浅色原路收回）。
6. 文件选择 → expo-image-picker（既有依赖）。
7. 拖拽抽屉 → PanResponder（vy>0.85 关闭、0/半屏锚点、橡皮筋 0.25）。
8. 全面屏避让 → useSafeAreaInsets 数值对齐原型 CSS。

## 7. 验收

- tsc --noEmit 全仓 0 错误；新增文件 eslint 0 告警。
- v7 冒烟测试 `tests/unit/ui-v7-smoke.test.tsx`（聊天首屏/底部导航/主页区块/设置行）通过；frontend 基线 22/190 → 23/191。
- **顺手修复 #85 轮的测试腐坏（5 处断言 / 3 个文件，全为 #85 应改而漏改，非本轮 UI 引入）**：
  - `tests/persona.test.js`（2 处）：frequent 分条用例改用官方覆盖通道 `BLUEBIRD_REPLY_MAX_CHARS=300` 收紧进程内上限保住原语义；续写用例替换为「机制已删除」断言（400 拒绝且不落盘）。77/77 全过。
  - `tests/api.test.js`（1 处）：续写模式断言从「缺正文不 400」改为「缺正文按 400 拒绝」。36/36 全过。
  - `tests/model-providers.test.js`（2 处）：max_tokens 期望 1200 → 8192。115/115 全过。
- 其余门禁结果见 PR CI。
- **人工验收方法（清单第七条）**：`UI_V7_PREVIEW = true` 起预览壳，与 `bluebird-home-v7.html` 并排逐格对比——布局、颜色、文字、交互。
