This is an Expo / React Native mobile application (Expo SDK 57) with a local Express backend in `server/`. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Architecture & navigation

- Single-screen app built from root `App.tsx`. **There is no Expo Router and no `src/app/` directory — do not add routes, route files, or navigation libraries.**
- Entry chain: `index.ts` (`registerRootComponent` + `SafeAreaProvider`) → root `App.tsx`, which renders the entire chat UI.
- Screen-like views are React Native `Modal` overlays opened from `App.tsx`: `components/MemoryScreen.tsx` (memory library) and `components/ThemeScreen.tsx` (accent-color picker).
- `components/` — UI components; each keeps its styles at the bottom of the file as `const createStyles = (theme: Theme) => StyleSheet.create({ ... })`.
- `theme.ts` — the theme system: mode (light/dark) × accent color. All light/dark color values are derived from the theme; components never hard-code them.
- `lib/` — shared non-UI code: `types.ts` (`Message`), `constants.ts` (API token, mood emoji, timing constants), `utils.ts` (helpers).
- `server/` — Express API, entry `server/index.js`, listens on port 3000 (`PORT`). Routes: `/chat` (DeepSeek via the `openai` SDK), `/sessions` (list/create), `/sessions/:id`, `/history`, `/history/clear`, `/history/recall`, `/memory`, `/memory/clear`, `/memory/delete`, `/emotion`; all except `/` require `Authorization: Bearer <token>` and pass through a rate-limit middleware. `server/sessions.js` owns multi-session storage and legacy migration, `server/memory.js` and `server/emotion.js` hold the domain logic; JSON state lives in `server/data/`.
  - Multi-session: `/chat`, `/history`, `/history/clear`, `/history/recall` all accept an optional `sessionId` (body for POST, query for GET). When omitted they fall back to the built-in `default` session, so clients that send no `sessionId` keep the legacy single-history behaviour. Unknown session ids are rejected with 404. `/chat` builds the model context from the session's stored messages; the client-supplied `history` is used as a fallback only for the `default` session (legacy clients) and only when that session is empty — a freshly created session never borrows another conversation's history. On first boot the legacy `server/data/chat-history.json` is imported into the `default` session, backed up in place, and never modified or deleted.
  - `/chat` persists before responding and returns `persisted` (`true`/`false`); a broken store therefore surfaces as `persisted: false` instead of a silent success. Persistence is synchronous, which also makes the same-session read-modify-write atomic (no `await` inside). Clients that disconnect before the reply is ready are not persisted, to avoid ghost messages.
  - Storage safety: `server/data/sessions.json` is the authoritative store. If it exists but cannot be read/parsed, or parses to an unexpected shape, the server enters read-only protection — it refuses all writes, leaves the file untouched at its original path (no rename, no delete), and serves a read-only fallback view built from the legacy history. Repairs must be done by hand on that file. This supersedes the older "rename to `.corrupt-<ts>`" behaviour, so `.corrupt-*` files and duplicate `.pre-multisession.bak-*` backups are no longer produced. `sessions.json` writes are `fsync`-ed before the atomic rename (see C2 note below); orphan `messages` keys with no matching session are reported on load rather than dropped silently.
- Deployment constraint (A3): the JSON state under `server/data/` is loaded once into a per-process in-memory cache and rewritten in full, so **the API must run as a single process**. Do not run multiple instances against the same data directory (or behind a load balancer without sticky routing) — concurrent instances would overwrite each other's state. Known limitation, not enforced in code.
- Known limitation (C2): `server/memory.js` and `server/emotion.js` still persist with plain `writeFile` + `rename` (no `fsync`), unlike `server/sessions.js`. Only a power loss between rename and flush could expose this; these two modules are intentionally left untouched in this phase.
- Config: the frontend reads `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_BLUEBIRD_API_TOKEN` from the root `.env` (Expo only exposes `EXPO_PUBLIC_*` variables); the backend reads `server/.env` (`DEEPSEEK_API_KEY`, `BLUEBIRD_API_TOKEN`, `PORT`, `MEMORY_ENABLED`). See both `.env.example` templates; the client and server tokens must match.

## Commands

Use npm (`package-lock.json` is the only lockfile) — do not switch package managers or add bun/yarn/pnpm lockfiles.

```bash
npm install                  # install dependencies
npx expo install <package>   # ALWAYS use for Expo/RN packages — resolves SDK-compatible versions
npx expo start               # start the Metro dev server (:8081)
node server/index.js         # start the backend API (:3000)
npx tsc --noEmit             # typecheck
npx expo lint                # lint
npx expo-doctor              # diagnose dependency and config issues
```

In the Codespaces devcontainer, `bash scripts/blue-start.sh` (alias `blue`) idempotently starts both the API (:3000) and Metro (:8081).

Run lint and typecheck before declaring any task done.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries; add them with `npx expo install`. Docs: https://docs.expo.dev/versions/latest/index.md
- Local persistence uses `@react-native-async-storage/async-storage` — do not introduce other storage dependencies.
- `.env` files hold secrets (API keys, tokens) and are configured per machine — never edit or overwrite them as part of code changes.