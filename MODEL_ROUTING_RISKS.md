# 模型切换 / 图片自动路由：剩余风险清单

- 状态：**2026-10-28 复核**。2026-10-25 的原始版本完整保留在 [`docs/archive/MODEL_ROUTING_RISKS-2026-10-25.md`](docs/archive/MODEL_ROUTING_RISKS-2026-10-25.md)。
- 范围：请求级 `providerId` + `modelId` 链路、全局默认兼容、图片视觉能力路由、`modelRoute` 结构化回报。
- 复核依据：当前代码与测试；本地实际运行 `npm test`（39 个文件 / 1313 项）、`npm run test:unit -- --ci`（7 套 / 106 项），未运行真实供应商调用。
- 判定口径：只有「代码可证 + 测试可证」的项才标记为已验证；真实供应商与自定义服务商行为仍按未验证处理。

## 风险总览

| # | 风险 | 等级 | 2026-10-28 状态 |
|---|---|---|---|
| 1 | 前端请求体与气泡提示的自动化覆盖不完整 | 中 | 部分解决：气泡/消息变换有测试；模型选择 payload 仍缺直接断言 |
| 2 | 自动路由提示不落盘，重新加载历史后消失 | 中 | 仍有效（设计限制） |
| 3 | 自动路由限定同服务商，跨服务商不借用视觉模型 | 中 | 仍有效（设计限制） |
| 4 | 真实供应商只验证了非流式，真实 SSE 未验证 | 中 | 仍未验证 |
| 5 | 自定义第三方服务商（含视觉）无真实端到端验证 | 中 | 仍未验证 |
| 6 | 新测试未纳入 CI | 中 | 已解决 |
| 7 | 无 lint 依赖，lint 检查未执行 | 低 | 已解决 |
| 8 | 「发出请求后再切模型不影响在途请求」仅由代码结构保证 | 低 | 部分验证 |
| 9 | 供应商回显 `upstreamModel` 不可信 | 低 | 已验证并规避 |
| 10 | 1x1 极小图片会被供应商拒绝（400） | 低 | 仍有效（供应商限制） |
| 11 | 路由提示只挂在最后一格分条气泡 | 低 | 仍有效（设计取舍） |
| 12 | 全局默认仍可被任意已授权客户端修改 | 低 | 仍有效（既有架构） |

## 逐项说明

### 1. 前端请求体与气泡提示的自动化覆盖不完整（中，部分解决）

- 已覆盖：`buildModelNote`、`ChatBubble` 提示渲染、消息分条/映射有单元测试；`use-chat-session` 验证了发送 payload 的 `message` / `sessionId`。
- 仍未覆盖：请求体里的 `providerId` / `modelId` 没有直接断言。也就是说，「所选模型确实被前端发出」仍主要由代码结构和类型保证，而不是测试断言。
- 影响：如果 payload 组装回归，服务端会回退到全局默认模型；UI 可能显示所选模型，但实际调用的是默认模型。
- 补强方式：在 `tests/unit/use-chat-session.test.tsx` 增加带 `selectedModel` 的发送断言。本次仅复核，不改动该链路。

### 2. 自动路由提示不落盘（中，设计限制）

- `modelNote` 只存在前端消息；服务端消息结构没有 `modelRoute`，历史读回后提示消失。
- 影响：用户无法在历史中回溯某轮是否因图片自动切换了模型。
- 若要可追溯，需要扩展消息存储格式与迁移；本次不改。

### 3. 自动路由限定同服务商（中，设计限制）

- `resolveVisionTarget` 只在所选服务商内部选择视觉模型；没有视觉模型时返回 `capability` 400，不跨服务商。
- 影响：避免跨服务商的数据与计费转移；代价是所选服务商没有视觉模型时不能带图。
- 若要跨服务商，需要产品先确认数据/计费边界。

### 4. 真实 DeepSeek SSE 未验证（中）

- 2026-10-25 的原始验证只覆盖真实 DeepSeek 非流式；真实 SSE 仍只有本地 mock 覆盖。
- 本次未调用真实供应商，不能据此宣称真实 SSE 的 `done.modelRoute` 与上游一致。
- 验证方式：在 `server/.env` 配置真实 key，使用独立 `BLUEBIRD_DATA_DIR`，跑 `/chat` 与 `/chat/stream` 并核对 `model` / `upstreamModel` / `modelRoute`。

### 5. 自定义视觉服务商未做真实端到端（中）

- 自动视觉路由只在本地 OpenAI 兼容 mock 上验证；不同服务商对 `image_url` 的格式、尺寸要求不同。
- 验证方式：选一家真实兼容服务商，带图跑通并核对错误分类；失败时应如实返回，不得伪装成功。

### 6. 新测试未纳入 CI（中，已解决）

- `tests/model-routing.test.js`、`tests/agent-tools.test.js` 已在 CI 中；CI 仍保留显式 runner 清单，并由 `scripts/verify-test-coverage.js` 与基线对账，未列入清单的测试文件会直接导致 CI 失败，不再静默漏测。`npm test` 本地仍自动发现 `tests/*.test.js`。
- 证据：`.github/workflows/ci.yml`。

### 7. 无 lint 依赖，lint 检查未执行（低，已解决）

- `package.json` 已包含 ESLint 9 与 `eslint-config-expo`；本地 `npm run lint` 通过。
- 本次已将 `npm run lint` 加入 CI。
- 注意：lint 通过不等于运行时行为正确；它只是静态质量门。

### 8. 在途模型切换仅由代码结构保证（低，部分验证）

- 前端在请求入口快照 `selectedModel`，服务端按请求级 ids 解析；现有 `use-chat-session` 测试验证了会话 A→B 的 stale 响应丢弃，但没有专门模拟「模型切换时旧请求仍在途」。
- 影响：代码结构上正确；缺少针对模型切换时序的独立回归用例。

### 9. `upstreamModel` 不可信（低，已验证并规避）

- 真实 DeepSeek 会对 `deepseek-chat` 请求回显 `deepseek-flash`；代码把 `model`（本系统实际下发）与 `upstreamModel`（供应商回显）分开，路由判断只使用前者。
- 继续禁止用 `upstreamModel` 证明切换成功。

### 10. 1x1 极小图片被供应商拒绝（低，供应商限制）

- 真实 DeepSeek 曾拒绝 1x1 PNG（400）；这是供应商输入限制，不是本链路缺陷。系统会如实返回错误。
- 本次未重新验证；客户端仍可能上传极小图片。

### 11. 路由提示只挂在最后一格分条气泡（低，设计取舍）

- `buildReplyBubbles` 只在最后一格挂 `modelNote`，避免整轮重复；`tests/unit/chat-messages.test.ts` 有断言。
- 副作用：只读第一格时可能错过提示。

### 12. 全局默认可被任意已授权客户端修改（低，既有架构）

- 请求级选择不写回全局默认，但 `PUT /model-providers/default` 仍会修改共享默认值；单用户本地架构下可接受。
- 若未来多客户端/多用户，需要明确默认值的并发语义。

## 复现命令

```bash
npm test
npm run test:unit -- --ci
npx tsc --noEmit
npm run lint
```

真实供应商验证需要 `server/.env` 中的 `DEEPSEEK_API_KEY`，并使用独立临时数据目录，避免污染 `server/data`。
