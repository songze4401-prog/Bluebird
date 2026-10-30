# Memory Center（记忆管理中心）— 设计与工程落地

分支：`qoder/ui-finalization`
入口：抽屉「Memory Center」、设置页「Memory Center」
定位：独立一级功能，替代原 `MemoryScreen` 的单一列表。

## 1. 页面结构

全屏 Modal，顶部为返回 / 标题 / 刷新，下面是四个分区标签：

| 分区 | 内容 | 数据来源 |
|---|---|---|
| 概览 | 总量、活跃、待确认、归档、历史版本；近 7 天新增柱状图；记忆摘要；待确认预览；重复/冲突计数；回答调用记忆未接入说明 | `GET /memory?scope=all`，全部在客户端聚合 |
| 管理 | 搜索、状态筛选、类型筛选、记忆列表、详情、确认/拒绝/归档/删除、清空全部、重复/冲突检查 | 同上 + `POST /memory/confirm` / `reject` / `archive` / `delete` / `clear` |
| 图谱 | 2D 关联网络：拖动平移、+/− 缩放、节点点击、关联详情 | 真实记忆的 `keywords`、`supersededBy`；本地确定性布局 |
| 生命周期 | 创建/更新/合并/取代/确认/归档等事件时间线；本次会话操作；写入尝试技术记录 | 条目字段 + `GET /memory/write-attempts` + 本地操作日志 |

视觉：浅色模式使用暖白画布、白色卡片和加深蓝色强调；总览顶部与图谱使用深色「仪表」面板，形成黑色极简的层次。深色模式下整体回到近黑。所有颜色来自 `theme.ts`，没有引入图表/图谱依赖。

## 2. 真实接口对接

| 能力 | 接口 | 状态 |
|---|---|---|
| 全部状态读取 | `GET /memory?scope=all` | 已接入；只读审计视图。路由复用 `getMemories` 已有的 `includeSuperseded/includeArchived/includePending` 选项，未改记忆引擎 |
| 写入尝试 | `GET /memory/write-attempts` | 已接入；失败时显示“暂不可用”，不阻塞主列表 |
| 确认待确认 | `POST /memory/confirm` | 已接入；成功后可合并到目标记忆，列表刷新 |
| 拒绝待确认 | `POST /memory/reject` | 已接入；成功后刷新 |
| 归档 | `POST /memory/archive` | 已接入；成功后刷新 |
| 删除 | `POST /memory/delete` | 已接入；优先 `id`，旧数据回退 `createdAt + content` |
| 清空全部 | `POST /memory/clear` | 已接入；二次确认，保留原有功能 |
| 搜索/分类 | 无新接口 | 客户端基于真实条目过滤，不发额外请求 |
| 重复检测 | 无新接口 | 客户端字符二元组 Jaccard（阈值 0.8），仅提示 |
| 冲突检测 | 无新接口 | 客户端启发式：同类型 + 共享关键词 + 正负表述不同；仅提示 |
| 图谱关联 | 无新接口 | 客户端由关键词共现和 `supersededBy` 推导；不是服务端神经图谱 |
| 生命周期 | 无新接口 | 客户端由条目字段、最近 20 次写入尝试和本次会话操作推导 |

## 3. 明确未实现（界面显示“未接入/未开放”）

- **编辑**：服务端没有单条记忆更新接口。详情页保留“编辑”说明，并提示在对话中更正；不伪造保存按钮。
- **单条撤回**：记忆中心没有单条撤回 API；原聊天消息撤回仍走 `/history/recall`。详情页明确说明。
- **完整事件审计**：服务端只保存每条记忆的 `lastDecision` 和最近 20 次写入尝试；拒绝、撤回、删除后的历史不可回溯。时间线只展示可验证字段和本次会话操作，不补造事件。
- **回答实际调用了哪些记忆**：当前 `/chat`/`/chat/stream` 响应和可查询 trace 不返回被注入记忆的 ID，只提供计数。概览和生命周期都明确显示“未接入”，不以计数冒充条目清单。
- **神经/向量图谱**：没有本地 embedding 或图数据库，图谱明确标注“关键词/版本关系推导”，不声称机器学习关联。
- **自动合并/修复冲突**：重复与冲突只做检测和详情跳转，不提供自动合并/编辑；服务端也没有对应的单条记忆操作接口。

## 4. 验证

- `npx tsc --noEmit`：通过
- `npm run lint`：通过
- `npx jest --runInBand`：17 个测试套件 / 162 项通过
- `npm test`：44 个后端测试文件 / 1526 项通过
- `node scripts/verify-test-coverage.js`：backend 1526/1526、nodeSuite 221/221、runner 1305/1305、frontend 162/162、CI 覆盖 44/44
- 新增后端断言：`scope=all` 可读归档条目；非法 `scope` 返回 400，不退化成默认列表
- 新增前端纯规则测试：概览、7 天趋势、摘要、重复/冲突、生命周期、写入尝试、图谱布局与截断、置信度/来源
- 新增屏幕测试：概览真实计数、搜索/类型筛选、详情字段、确认/删除/归档/拒绝/清空调用真实接口、检查面板、图谱节点详情、生命周期与写入记录
- Expo Web 实际构建 + 隔离临时后端：9 条真实记忆加载成功；`memory?scope=all` 和 `write-attempts` 均 200；概览显示 9 总量 / 6 活跃 / 1 待确认 / 1 归档 / 1 历史版本；管理、详情、图谱 9 节点 6 关联、生命周期 13 条事件均核对；浏览器控制台无错误
- 真实操作验证：在隔离后端点击待确认条目的“确认”，界面待确认 1→0、活跃 6→7；随后 `GET /memory?scope=all` 返回该条目 `status=active`、`lastDecision.action=confirm`，证明不是前端假更新
- 视觉限制：内置浏览器当前没有可见视口，未产出像素截图；Modal 的 slide 动画在隐藏视口会停在 `translateY`，核对时通过 DOM 将 transform 临时归零后检查布局。原生 iOS/Android 未跑实机。

## 5. 文件

- `components/MemoryCenterScreen.tsx` — 入口、数据加载、概览、动作编排
- `components/MemoryManageTab.tsx` — 搜索/分类/列表
- `components/MemoryGraphTab.tsx` — 图谱画布、平移/缩放、节点点击
- `components/MemoryLifecycleTab.tsx` — 时间线与写入尝试
- `components/MemoryDetailModal.tsx` — 详情与操作
- `components/MemoryInspectionModal.tsx` — 重复/冲突检查
- `components/memory-center-styles.ts` — 共享视觉层
- `lib/memory-center.ts` — 纯规则（概览、趋势、检测、事件）
- `lib/memory-graph.ts` — 图谱推导与确定性布局
- `server/index.js` — `GET /memory?scope=all` 只读视图
- `tests/unit/memory-center.test.ts`、`tests/unit/memory-center-screen.test.tsx`
- `tests/memory-agent-write.test.js` — `scope=all` / 非法 scope 断言
