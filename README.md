# Bluebird

Bluebird（云岫）是一个单用户、本地优先的个人 AI 陪伴应用：Expo / React Native 客户端 + 本机 Express API + 本地 JSON/图片数据目录。它没有云端多租户、数据库或微服务；会话、长期记忆、情绪、人格、在线状态、模型配置和附件都保存在运行 API 的机器上。

首期专业 Agent 为 Memory Bot：独立 Manifest/Registry/配置、AES-256-GCM 加密凭证、独立 Bot 会话、直接对话与主控委派共用 Runtime、任务/事件 API 和真实工作台。实现边界与未完成项见 [`docs/memory-bot.md`](docs/memory-bot.md)。

## Stack

- Client: React Native 0.88 / Expo 58 / TypeScript；单入口 `App.tsx`，无 Expo Router。
- API: Node.js / Express 5.2，默认 `:3000`，**必须单进程运行**（数据目录由进程内缓存整文件重写，启动时强制单实例锁）。
- Models: 内置 DeepSeek（`DEEPSEEK_API_KEY`）+ 用户配置的 OpenAI Chat Completions 兼容服务。
- Storage: `server/data/`（或 `BLUEBIRD_DATA_DIR`）下的 JSON 文件 + `uploads/` + `sticker-repo/`。

## Quick start

```bash
npm install

# 配置（不要提交 .env；客户端与服务端 token 必须一致）
cp .env.example .env
cp server/.env.example server/.env

node server/index.js       # API :3000
npx expo start             # Metro :8081
```

`server/.env` 读取 `DEEPSEEK_API_KEY`、`BLUEBIRD_API_TOKEN`、`PORT`、`MEMORY_ENABLED`、`BLUEBIRD_MONITORING`、`BLUEBIRD_CORS_ORIGINS`（浏览器来源白名单，未配置时只允许本地 Expo Web 开发端口）；根 `.env` 读取 `EXPO_PUBLIC_API_URL`、`EXPO_PUBLIC_BLUEBIRD_API_TOKEN`。

## Quality gates

```bash
npm test                    # backend: auto-discovers tests/*.test.js (116 files / 2390 checks)
npm run test:unit -- --ci   # frontend: 22 suites / 188 cases
npx tsc --noEmit            # TypeScript
npm run lint                # Expo ESLint
npm run eval:context        # real-model capability eval (needs DEEPSEEK_API_KEY; not in CI)
npm run eval:retrieval      # fixed-corpus unified retrieval eval (lexical/exact; no external model)
npm run eval:embedding      # real embedding + hybrid + reranker open-domain eval (needs a real embedding/reranker service; not in CI)
```

CI (`.github/workflows/ci.yml`) runs TypeScript, lint, the fixed evaluations, and a single coverage-verifier invocation that executes every backend suite and Jest once on Node 22, plus two data-isolation tripwires that ensure tests never read or write the real `server/data`.

## Data safety

- Everything the user owns lives in one directory: `server/data/` or `BLUEBIRD_DATA_DIR`. It is gitignored.
- The API must run as a single process; a second instance is refused by the startup lock.
- Each session retains up to 1000 messages; `/history` returns at most 200 per page and the client loads older pages with a `before` cursor. Trimming releases unreferenced upload files.
- Back up with `node scripts/bluebird-backup.js` (recursive snapshot + SHA-256 manifest). API keys are excluded by default; see `AGENTS.md` for `--encrypt-secrets`.
- Rehearse restore with `node scripts/bluebird-restore-drill.js`.
- `api-keys.json` is plaintext at rest (best-effort `0600`); do not commit the data directory or `.env` files.

## Observability

- 只读控制台：设置抽屉 →「系统监控」；总览 / Trace / 上下文·记忆 / 工具 / 模型·成本 / 错误·事件 / 安全·可靠性 / 健康·告警。
- 真实链路埋点覆盖 HTTP、会话、上下文、记忆检索、模型、工具、SSE 与落盘；事件/Trace/审计/告警分别有界存储于 `server/data/monitoring/`（`BLUEBIRD_DATA_DIR` 可覆盖）。
- 默认启用；`BLUEBIRD_MONITORING=0` 可关闭，前端会显示 disabled/degraded，而不是健康。API 只读、复用 Bearer 鉴权，入口为 `/monitoring/*`。
- Token 用量优先使用供应商 usage；成本未配置费率时显示“未配置”，不编造金额。外部通知未配置，当前只有站内告警。
- 契约、指标口径、告警规则、容量上限与未完成项见 `docs/observability.md`。

## Documentation

- `AGENTS.md` — architecture, data safety, commands, tests, and rules. This is the primary engineering reference.
- `docs/phase5-charter-2026-11-06.md` — Phase 5 立项书：Notion v1.0 未实现项的交付包拆分、每轮验收定义、轮数估算（14–20 轮，中位 16）与里程碑对应的台账预期状态。
- `docs/phase5a-eval-tiers-and-comparators.md` — Phase 5-A 第 1 轮（§14）：评测集四类分层与可见性裁剪、泄漏检测与轮换退役、五类可比较基线与配置记录身份，含 `--matrix`/`--leak-scan` 实测输出与已知限制。
- `docs/phase5a-quality-indicators-2026-11-07.md` — Phase 5-A 第 2 轮（§7）：八项质量指标的可执行口径（过度拆解率、并行耗时收益、失败恢复率、重复副作用率、证据完整率、来源独立性、Reviewer 检出率、审批命中率与误拦截率），unknown 绝不回落成 0 的三条硬约束、两份实测语料的逐行数字，以及本轮实测发现的四处假数与修法。
- `docs/phase5b-throttle-breaker-storm-2026-11-07.md` — Phase 5-B 第 1–3 轮（§26）：Run/Task/Agent/Provider 四维限流阈值、Provider/工具/Worker 三态熔断（滑动窗口 + 半开探测名额 + 确定性错误不计故障率）、重规划风暴五条细则，三处生产接入（`createChatCompletion`、工具网关、路由剔除）与审计落账口径，以及第 3 轮的闸门开/关本地开销基准（三态归因、可比性硬规则、慢上游对照与基准自身的已知限制）。
- `docs/handover-2026-11-03.md` — handover snapshot: current baseline, what P1–P6 actually proves, unverified/blocked items with evidence, hard constraints, and the acceptance command chain.
- `docs/persona-custom-prompt.md` — the user-authored persona text: field contract, priority order, untrusted-text handling, and validation error codes.
- `docs/unified-retrieval.md` — unified semantic retrieval/knowledge index: contracts, source connectors, hybrid pipeline, API, limits, verified/blocked capabilities.
- `docs/p5-profile-feedback.md` — traceable profile and confirm/deny/correct feedback: derived-view contract, source trace, idempotency, tombstones, API and limits.
- `docs/p6-ops-visualization.md` — Memory Center profile/timeline/graph, manual governance, audit console and permission checks.
- `docs/observability.md` — monitoring architecture, event/metric contract, alert rules, retention, privacy, and known gaps.
- `MODEL_ROUTING_RISKS.md` — current status of model-routing risks; the 2026-10-25 original is archived under `docs/archive/`.

## License

MIT
