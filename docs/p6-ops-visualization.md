# P6 运营与可视化

日期：2026-11-03
范围：Memory Center 画像页、详情治理入口、生命周期时间线、关系图、系统监控审计页。

## 1. 入口

- **画像**：设置 → Memory Center →「画像」。
- **人工治理**：画像卡片上的确认/否认/纠正，或任意记忆详情 →「画像治理」。
- **时间线**：Memory Center →「生命周期」。
- **关系图**：Memory Center →「图谱」。
- **审计**：设置 →「系统监控」→「安全·可靠性」。

所有入口都需要 Bearer 鉴权；数据来自真实 `/profile`、`/memory?scope=all`、
`/monitoring/audit`，不使用本地伪造数据。

## 2. 画像页（P5 数据的界面）

画像每次从 `memory.json` 派生；页面展示：

- 当前 active 数量、待确认、冲突、已否认计数；
- `digest` 短指纹与“可重建 / 来源 memory.json”说明；
- 身份 / 偏好 / 目标 / 关系 / 事实分节；每个条目显示内容、状态、来源条数、
  确认次数与首条来源原话；
- 待确认与冲突待裁决分节；
- 反馈历史（动作、原因短码、时间、feedbackId）；
- 「显示历史版本」开关读取 `includeInactive=1`，展示 superseded / archived /
  denied / expired 及原因。

画像不是第二份存储，也没有可漂移的缓存；刷新/重启后 digest 由同一份
`memory.json` 重建。画像不改变 Context Runtime 的记忆注入路径。

## 3. 人工治理

| 动作 | UI 入口 | 行为 | 数据一致性 |
| --- | --- | --- | --- |
| 确认 | 待确认/冲突卡片；详情 | `POST /profile/feedback {action:'confirm'}` | 条目 active，确认次数 +1，反馈历史追加；刷新画像与记忆列表 |
| 否认 | 画像卡片；详情「画像治理」 | `POST /profile/feedback {action:'deny'}` | 归档 + `withdrawnAt` + 墓碑；当前画像/检索排除，历史视图与反馈历史保留 |
| 纠正 | 画像卡片；详情「画像治理」 | `POST /profile/feedback {action:'correct',content}` | 新 active 版本生效，旧 active/contested → superseded、旧 pending → archived；旧来源保留并追加更正原话；旧来源写墓碑 |

- 每个动作生成 `feedbackId`（`ui-<action>-...`），重复提交由服务端幂等返回；
- 纠正输入限制 100 字，空内容/与当前相同会在 UI 与服务端双重拒绝；
- 动作完成后同时刷新 `/memory?scope=all` 与 `/profile`，避免“列表已变、画像未变”；
- 详情仍保留既有的确认/拒绝/归档/删除接口，P5 的否认/纠正作为更可追溯的治理路径。

## 4. 时间线

生命周期时间线由三部分合并：

1. 条目字段：创建、最近决策、待确认、冲突、归档、取代；
2. P5 `feedbackHistory`：确认 / 否认 / 纠正（每条最多 20 条；最近决策与历史
   同一条时去重）；
3. 本次 Memory Center 操作与最近 20 次写入尝试（技术折叠区）。

筛选支持创建、更新、合并、取代、确认事件、否认事件、纠正事件、冲突事件、
归档与其他。已物理删除的条目及其事件不可回溯；否认/纠正保留归档与历史版本。

## 5. 关系图

节点来自真实记忆，边来自关键词共现与 `supersededBy`（版本取代）。P5 纠正会
生成新的活跃节点与取代边；否认保留归档节点用于审计。图谱不声称神经嵌入或
机器学习关联，布局是本地确定性计算。

## 6. 审计与权限

- `POST /profile/feedback` 成功写入 `profile.feedback` 审计，`reason` 为
  `confirm` / `deny` / `correct`；跨用户或非法目标写入 `result=denied`
  与原因短码。
- 系统监控「安全·可靠性」显示动作中文标签、结果与原因；支持“仅画像反馈”过滤。
- 审计只含动作、结果、原因、对象、操作者/会话引用与时间，不含记忆正文、
  来源原话或更正内容。
- `/monitoring/audit` 需要 Bearer 鉴权；跨用户反馈由服务端作用域返回 403，
  UI 只显示错误，不把失败伪装成成功。
- 实测（`tests/profile-audit-p6.test.js`，9 项）：confirm/correct 记 success，
  跨用户 deny 记 denied/forbidden，审计无正文哨兵，未鉴权 401，反馈后画像
  反映新版本且 pending 清空。

## 7. 验证与边界

- 前端 Jest：22 套 / 188 项；Memory Center 画像、否认、纠正、审计过滤均有
  渲染与请求断言；全部网络 mock，不读写真实数据。
- 后端：`tests/profile-audit-p6.test.js` 9 项；全量覆盖率门禁见 AGENTS/README。
- 浏览器验证使用 Expo Web + 真实后端临时数据目录，不触碰 `server/data`。
- 2026-11-03 实测（in-app browser 无障碍树/DOM，真实后端临时目录）：画像页显示
  5 条当前事实、待确认 1、冲突 2、已否认 1、`digest`、分节来源与反馈历史；
  点击“确认”后待确认与冲突归零、当前事实 6、反馈历史追加、`digest` 变化；
  系统监控「安全·可靠性」显示 4 条 `profile.feedback`（确认/纠正）与中文原因，
  无正文；生命周期显示 24 条事件并含确认/否认/纠正；记忆详情显示“画像治理”
  与纠正/否认入口。截图不可用（in-app browser 视口隐藏），因此以页面 DOM
  与无障碍文本作为浏览器证据，不声称做过像素级视觉验收。
- 未实现：实时推送治理事件（当前手动刷新，监控每 30 秒轮询）、撤销已否认条目
  的一键回滚（需新建更正）、前端编辑关键词/类型/置信度（API 支持，UI 目前只
  纠正内容）、服务端图数据库/向量关系图、完整审计留存（受监控保留策略限制）。
