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
- `server/` — Express API, entry `server/index.js`, listens on port 3000 (`PORT`). Routes: `/chat` (DeepSeek via the `openai` SDK), `/history`, `/history/clear`, `/history/recall`, `/memory`, `/memory/clear`, `/memory/delete`, `/emotion`; all except `/` require `Authorization: Bearer <token>` and pass through a rate-limit middleware. `server/memory.js` and `server/emotion.js` hold the domain logic; JSON state lives in `server/data/`.
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

## Testing

Three suites: `tests/emotion.test.js` (31), `tests/memory.test.js` (37), `tests/api.test.js` (22) — 90 checks total.

```bash
npm install --no-save express cors dotenv openai   # api.test.js only
node --test tests/emotion.test.js tests/memory.test.js
node tests/api.test.js
```

- **Every suite must isolate its data directory.** Point `process.env.BLUEBIRD_DATA_DIR` at an `fs.mkdtempSync()` temp dir and remove it in a top-level `after()` hook.
- **Set that env var before `require`-ing any server module.** `server/{memory,emotion,index}.js` resolve their data path once at module load, so setting it afterwards silently does nothing and the test falls back to the real directory.
- **Never read or write `server/data/` from a test.** It holds the real memory, chat history, and emotion state; `.gitignore` excludes it, so anything a test wipes there cannot be recovered.
- The two `node:test` suites declare `{ concurrency: 1 }` on every `describe`: suites within a file share one data file, and the corruption-recovery case renames it to `.corrupt`.
- To disable the LLM in a test, assign `process.env.DEEPSEEK_API_KEY = ''` — do **not** `delete` it. `dotenv` only fills keys that are absent, so a deleted key is re-injected from `server/.env` when `server/index.js` loads, which sends real requests and incurs real cost.
- Verify isolation by seeding `server/data/` with sentinel content, running the full suite, and checking the files are byte-identical afterwards.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries; add them with `npx expo install`. Docs: https://docs.expo.dev/versions/latest/index.md
- Local persistence uses `@react-native-async-storage/async-storage` — do not introduce other storage dependencies.
- `.env` files hold secrets (API keys, tokens) and are configured per machine — never edit or overwrite them as part of code changes.