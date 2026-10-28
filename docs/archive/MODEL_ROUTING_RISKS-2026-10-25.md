# 模型切换 / 图片自动路由：剩余风险清单

- 范围：请求级 `providerId` + `modelId` 链路、全局默认兼容、图片视觉能力路由、`modelRoute` 结构化回报
- 生成时间：2026-10-25
- 依据：本次改造的实现代码、`tests/model-routing.test.js`（21 项）、`tests/model-providers.test.js`（113 项）、全量回归（20 文件 / 722 项）、真实 DeepSeek 非流式 E2E
- 判定口径：只有「代码可证 + 测试可证」的项才标记为已验证，其余一律列为风险

## 风险总览

| # | 风险 | 等级 | 状态 |
|---|---|---|---|
| 1 | 前端请求体与气泡提示没有自动化测试 | 中 | 未验证 |
| 2 | 自动路由提示不落盘，重新加载历史后消失 | 中 | 设计限制 |
| 3 | 自动路由限定同服务商，跨服务商不会借用视觉模型 | 中 | 设计限制 |
| 4 | 真实供应商只验证了非流式，真实 SSE 未验证 | 中 | 未验证 |
| 5 | 自定义第三方服务商（含视觉）无真实端到端验证 | 中 | 未验证 |
| 6 | 新测试未纳入 CI（CI 禁止修改） | 中 | 已知缺口 |
| 7 | 无 lint 依赖，lint 检查未执行 | 低 | 已知缺口 |
| 8 | 「发出请求后再切模型不影响在途请求」仅由代码结构保证 | 低 | 部分验证 |
| 9 | 供应商回显 `upstreamModel` 不可信 | 低 | 已验证并规避 |
| 10 | 1x1 极小图片会被供应商拒绝（400） | 低 | 已验证，非本链路缺陷 |
| 11 | 路由提示只挂在最后一格分条气泡 | 低 | 设计取舍 |
| 12 | 全局默认仍可被任意已授权客户端修改 | 低 | 既有架构 |

## 逐项说明

### 1. 前端请求体与气泡提示没有自动化测试（中）

- 仓库没有 React Native / Jest 测试框架，`App.tsx` 的 payload 组装（`sendMessage`、`sendContinuation`）、`buildModelNote` 文案、`ChatBubble` 的提示渲染均无自动化用例。
- 目前只有：`npx tsc --noEmit` 通过 + 代码审阅；请求级语义由服务端测试（模拟前端携带 ids）覆盖。
- 也就是说：**「前端真的把当前所选模型发出去了」这一点没有运行时证据**，仅有静态证据。
- 补强建议：引入 RN 测试框架后，对 payload 构造做纯函数化并加单测；或做一次真机/浏览器抓包验证。

### 2. 自动路由提示不落盘（中）

- `Message.modelNote` 只存在于前端内存消息；后端历史只存正文与附件，不存 `modelRoute`。
- 后果：杀掉 App 或重新进入历史会话后，之前「因图片自动切换模型」的提示消失；用户无法回溯当轮实际使用的模型。
- 补强建议：若需要可追溯，应在消息落盘结构里增加 `modelRoute` 字段（涉及存储格式变更与迁移，本次未做）。

### 3. 自动路由限定同服务商（中）

- 实现调用 `resolveVisionTarget({ providerId })`，只在**所选服务商内部**挑视觉模型（默认视觉模型优先，其次第一个启用的视觉模型）。
- 所选服务商没有视觉模型时返回 `400 capability`，不会跨服务商借用别家的视觉模型。
- 这是刻意保持的原有能力路由边界：避免把 A 家的请求悄悄转到 B 家（数据与计费都会跨主体）。
- 若期望「任意服务商都能带图」，需要产品层面先确认是否允许跨服务商路由。

### 4. 真实供应商只验证了非流式（中）

- 真实 DeepSeek E2E 只覆盖 `POST /chat`（普通切换 + 带图自动路由）；`/chat/stream` 的真实 SSE 行为只有本地 mock 覆盖。
- 因此「真实环境下 `done` 事件里的 `modelRoute` 与上游一致」缺少供应商侧证据。
- 不得把 mock 结果表述为真实供应商端到端结论。

### 5. 自定义第三方服务商无真实端到端验证（中）

- 视觉自动路由只在本地 mock 服务商（OpenAI Chat Completions 兼容桩）上验证；不同服务商对 `image_url` 的格式/尺寸/URL 要求不同（本次已遇到 DeepSeek 拒绝 1x1 图片）。
- 风险：换一家视觉服务商后，可能因图片格式或字段差异直接报错；错误会被如实透出（不会伪装成功），但可用性未验证。

### 6. 新测试未纳入 CI（中）

- `tests/model-routing.test.js` 为本次新增，只在本地手工运行。
- `.github/workflows/ci.yml` 显式枚举测试文件，且本次任务明确禁止修改 CI，所以该文件不会在 CI 中执行；CI 注释中的历史计数（575 项）也已过时。
- 补强建议：下次允许改 CI 时，把该文件加入枚举并同步计数。

### 7. 无 lint 依赖（低）

- `node_modules/.bin/eslint` 不存在，`package.json` 无 eslint；`npm run lint` 会触发 `expo lint` 自动安装依赖。
- 按「不擅自安装依赖」约束未执行，本次 lint 结果为空（未运行，而非通过）。

### 8. 在途请求模型固定仅由代码结构保证（低）

- 每次发送前把 `selectedModel` 快照进 payload（`const modelSelection = ...`），请求发出后再切换模型不会改动已发出的请求体。
- 没有专门的自动化用例模拟「请求在途时切换」的时序；结论来自代码结构审阅。

### 9. 供应商回显不可信（低，已规避）

- 真实验证：请求 `deepseek-chat` 时 DeepSeek 响应回显 `model: deepseek-flash`。
- 因此响应拆成 `model`（本系统实际下发）与 `upstreamModel`（供应商回显）两字段，路由判断只使用前者。
- 仍需注意：`upstreamModel` 不能用于任何"是否切换成功"的断言。

### 10. 极小图片被供应商拒绝（低，非本链路缺陷）

- 首次真实 E2E 用 1x1 PNG 被 DeepSeek 400 拒绝；直连探针确认原文为 `unsupported image ... formats: webp, png, jpeg, gif`。
- 换成 64x64 PNG 后直连与项目链路均 200。
- 风险残留：客户端若上传极小/异常图片，供应商会报错；系统会如实显示错误，不会伪装成功。

### 11. 路由提示只挂在最后一格分条气泡（低）

- 连续消息分条时，同一轮的所有气泡来自同一模型，提示只挂在最后一格以避免重复。
- 副作用：若用户只看到第一格就停止阅读，可能错过提示。

### 12. 全局默认仍可被任意已授权客户端修改（低）

- 全局默认（`api-configs.json` → `defaults`）仍通过 `PUT /model-providers/default` 修改；请求级选择不写回默认，但多客户端之间共享同一个默认值。
- 这是单用户本地架构的既有设计，不是本次引入。

## 明确不构成风险的部分（已验证）

- 请求级 A/B 切换：本地 mock 与真实 DeepSeek 均证明出站模型与所选一致。
- 未提供 ids 时回退全局默认：已测。
- 请求级选择不写回全局默认：内存与 `api-configs.json` 双边已测。
- 无效模型：500 `not_configured` 且零上游请求，不静默回退。
- 服务商无视觉模型 + 图片：400 `capability` 且零上游请求。
- `modelRoute` 在 `/chat` 与 SSE `done` 语义一致：已测。
- 全量回归 20 文件 / 722 项全绿，`server/data` 无测试污染。

## 复现命令

```bash
npx tsc --noEmit
node --test tests/emotion.test.js tests/memory.test.js tests/sticker-markers.test.js
node tests/model-routing.test.js
node tests/model-providers.test.js
node tests/multimodal.test.js
```

真实供应商验证需 `server/.env` 中存在 `DEEPSEEK_API_KEY`，并使用独立临时数据目录，避免污染 `server/data`。
