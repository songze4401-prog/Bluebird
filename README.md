# Bluebird

Bluebird（云岫）是一个单用户、本地优先的个人 AI 陪伴应用：Expo / React Native 客户端 + 本机 Express API + 本地 JSON/图片数据目录。它没有云端多租户、数据库或微服务；会话、长期记忆、情绪、人格、在线状态、模型配置和附件都保存在运行 API 的机器上。

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

`server/.env` 读取 `DEEPSEEK_API_KEY`、`BLUEBIRD_API_TOKEN`、`PORT`、`MEMORY_ENABLED`；根 `.env` 读取 `EXPO_PUBLIC_API_URL`、`EXPO_PUBLIC_BLUEBIRD_API_TOKEN`。

## Quality gates

```bash
npm test                    # backend: auto-discovers tests/*.test.js (39 files / 1321 checks)
npm run test:unit -- --ci   # frontend: 7 suites / 108 cases
npx tsc --noEmit            # TypeScript
npm run lint                # Expo ESLint
```

CI (`.github/workflows/ci.yml`) runs the backend suites, TypeScript, lint, and Jest on Node 22, plus the runtime test-coverage verifier and two data-isolation tripwires that ensure tests never read or write the real `server/data`.

## Data safety

- Everything the user owns lives in one directory: `server/data/` or `BLUEBIRD_DATA_DIR`. It is gitignored.
- The API must run as a single process; a second instance is refused by the startup lock.
- Back up with `node scripts/bluebird-backup.js` (recursive snapshot + SHA-256 manifest). API keys are excluded by default; see `AGENTS.md` for `--encrypt-secrets`.
- Rehearse restore with `node scripts/bluebird-restore-drill.js`.
- `api-keys.json` is plaintext at rest (best-effort `0600`); do not commit the data directory or `.env` files.

## Documentation

- `AGENTS.md` — architecture, data safety, commands, tests, and rules. This is the primary engineering reference.
- `MODEL_ROUTING_RISKS.md` — current status of model-routing risks; the 2026-10-25 original is archived under `docs/archive/`.

## License

MIT
