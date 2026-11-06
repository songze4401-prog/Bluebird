#!/usr/bin/env node
/* global __dirname */
/*
 * 文档计数的单一来源（P3-01）。
 *
 * 真值来源只有一个：scripts/test-coverage-baseline.json（后端文件数 / 用例数）
 * 与 package.json 的 frontend 计数（由覆盖率脚本写回同一份基线）。
 * 任何文档里出现的「N 个测试文件 / N 项 / N 套」都必须由本脚本生成，
 * 否则文档与代码就会各说各话——这正是审计 P3-01 记录的一类漂移。
 *
 * 用法：
 *   node scripts/sync-doc-counts.js           # 把计数写回文档
 *   node scripts/sync-doc-counts.js --check   # 只校验，漂移则退出码 1（CI 用）
 *
 * 锚点（anchor）而不是标记（marker）：每条规则给一个正则和一个生成函数。
 * 正则必须在目标文件里恰好命中一次；命中 0 次或多次都直接报错——
 * 这说明文档被改过形状，必须人工确认，而不是静默跳过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'test-coverage-baseline.json');

// AGENTS.md 测试清单里每个文件的说明。搬进脚本后，计数与说明都由脚本统一生成，
// 文档里不再出现两份会各自漂移的清单。
const NOTES = {
  api: 'HTTP/auth/rate-limit/CORS/auth-before-body/JSON errors, custom runner',
  'atomic-write': 'temp+fsync+rename atomic writes, incl. a SIGKILL crash simulation',
  'chat-abort':
    'client disconnect on the non-stream /chat: the abort signal reaches the model call, the upstream call is cancelled, nothing is persisted (no ghost message), and the server stays healthy instead of writing to a closed socket',
  'corruption-contract':
    'detect/recover contract + all three modules routed through handleCorruption',
  'data-events': 'corruption + anomaly event logging & protection behaviour',
  'emotion-decay-global': 'global baseline decay incl. restart-safety',
  'memory-session-scope': 'contribution list, attribution, recall scope',
  presence:
    'presence V1: state rules, heartbeat expiry, dedupe/ordering, per-session wait, /chat wiring',
  'session-scope-e2e': 'live HTTP end-to-end for E2/E3',
  sessions:
    'sessions: legacy migration, CRUD/isolation, 1000-message retention, /history cursor pagination, trim metadata',
  persona:
    'persona panel: split-reply rules (single-message default, 400-char hard limit, short-segment regression), /persona API, customPrompt (defaults, old-file migration, strict type/length/body-size validation with the stored file left byte-identical, reset clears it), editable systemPrompt (built-in default vs effective, 8000-char limit, saved prompt replaces the core block in /chat and /chat/stream, blank falls back to built-in), custom block in the final /chat and /chat/stream model request, empty value = legacy prompt, malicious text neutralized and tool gating unchanged, prompt injection, corruption protection',
  'chat-stream':
    'SSE streaming: stream-strip rules, /chat/stream framing/deltas/done fields, persistence timing, continue mode, mid-stream error, pure-image memory extraction, /chat coexistence',
  multimodal:
    'multimodal: image upload validation (magic bytes/size/kind), auth, /chat vision-model routing & history blocks, attachment orphan GC incl. retention-trim cleanup',
  'sticker-repo':
    'sticker repo: sha256 dedupe, magic-byte validation, physical delete, legacy stickers.json migration, keyword/semantic search, candidate injection & [sticker:ID] reply validation',
  'model-providers':
    'multi-provider layer: config CRUD/enable-disable/defaults, key masking & leak scans, connection test (auth/429/500/404/timeout/oversize), stream & non-stream calls, error classification, model switching & vision capability, legacy DeepSeek compatibility, SSRF (loopback/private/link-local/metadata/credentials/protocol), persistence & restart, corruption protection',
  'model-routing':
    'request-level provider/model selection (A→A, B→B, no-ids default fallback, never writes the global default, invalid model = error + zero upstream calls), image vision routing (direct / auto-routed with modelRoute, no-vision provider = capability error), SSE done routing parity',
  'time-gap':
    'chat time-gap context: minute/hour/day gaps, user-vs-Blue gap split, session isolation, missing-time honesty',
  'context-engine-e2e':
    'Context Runtime real HTTP integration: no kill switch (always-on v3), long-history recall/summary in the actual request, no duplicate recent messages, stream path, Agent tool result forwarding and multi-round sent trace, explicit 413 input guard, session isolation, trace privacy',
  'agent-policy':
    'Agent policy schema/persistence/API, mode/tool whitelist, budgets, high-risk confirmation gate, trace privacy',
  'agent-tools':
    'agent tool calling V1: three gates (switch / capability / no-new-image), explicit delegation requests dispatched by the runtime even when the model returns text only (delegate removed from the follow-up request), history-image and MIME boundary, 3-round cap, per-session memory scope, tool timeout & abort, late-result handling, toolSteps persistence & read-back, SSE tool_start/tool_end, model semantics on downgrade',
  'memory-retrieval':
    'filters, hybrid scoring, budgets, explainable metadata, tool validation',
  'memory-semantic':
    'concept synonym/cross-language recall, hybrid ranking, semantic budgets',
  'memory-startup-lock':
    'incl. the refusal path when the data dir is unusable (no listening, explicit reason)',
  retrieval:
    'unified retrieval: contract/store lifecycle, five source connectors, hybrid fusion, policy gate, vector provider, context/Agent integration',
  'retrieval-api':
    'live HTTP: auth/405, document/code/web ingest -> search -> delete, knowledge_search neutralization, session isolation, rebuild/consistency, vector backfill 401/409',
  'retrieval-embeddings':
    'vector namespace reset, batch backfill, incremental embedding, reranker HTTP contract/fallback, engine rerank order, vector/reranker deadline downgrade',
  'memory-bot':
    'Memory Bot registry/config, AES-256-GCM vault, Bot sessions, tool loop and budget finalization, delivered-terminal task pruning, queue/SSE',
  'memory-maintenance':
    'explicit update/merge/supersede/archive/withdraw/delete, approval lifecycle, permissions',
  'memory-golden-path':
    'golden path: real /chat + stubbed provider, write→recall→inject into final request, session isolation, response memoryState empty→ok, requestId format',
  'memory-lifecycle-golden':
    'lifecycle golden path: supersede/delete/withdraw visibility in final request and unified search, session isolation, cross-session contradicting agent write parked as pending until confirmed',
  'memory-state-units':
    'normalizeMemoryState mapping, breaker/exception/timeout degradation without blocking, requestId in engine/trace, time budget',
  'memory-degradation-golden':
    'real server with MEMORY_ENABLED=false: chat still works, memoryState=empty, no memory block injected, stable across turns',
  'memory-budget-golden':
    'budget trimming: 10 memories → memoryMaxItems=8 → final request injects ≤8, token budget enforced',
  'agent-dispatch':
    'main tool → Bot task, explicit delegation intent detection, runtime-enforced delegate_to_bot dispatch even when the model does not call tools (policy-denied case documented), parent-memory read/write scope (agent rewrite of an existing memory parks a pending candidate until confirmed), parentUserId on the task, approval delivery, result SSE/snapshot, failure delivery, dedupe, outbox recovery',
  'agent-router':
    'router decision chain, task contract v1, fast/slow budgets, idempotency/priority queue, route events privacy, delegate_to_bot compatibility',
  'agent-worker':
    'worker lifecycle/runId, session owner/scope/lifecycle, context projection, tool gateway audit, unified result schema, cancel/timeout/model-failure terminal states, retry backoff via retrying state, concurrency isolation',
  'agent-recovery':
    'state machine transitions, task-store schema migration, leases/retry backoff/checkpoint version/run history, restart recovery (queued/retrying/recovery/live lease), SIGKILL fault injection, delivery idempotency and crash redelivery',
  'agent-watchdog':
    'watchdog health classification, action planning with whitelist/cooldown/breaker, intake pause and resume, offline recovery, escalation, audit fields, dry-run, external supervisor restart drill',
  'agent-op-ledger':
    'idempotency ledger storage (P1): strict canonicalArgs (key order, nested, optional/undefined vs null, string-vs-number, Chinese/space, delimiter ambiguity, NaN/cycle rejection), opKey hashing, begin/finish/markUnknown, 7-day retention and 5000-entry cleanup that never drops started/unknown',
  'agent-side-effect-ledger':
    'runtime idempotency wiring (P2): begin-before-execute, succeeded reuse without re-execution, started residue routes the task to recovery, timeout becomes unknown and blocks retry, failed retries in place with one row per opKey, dedupeKeyOverride escape hatch for intentional repeats, read-only tools write no ledger rows',
  'agent-workflow-store':
    'workflow store (C1): key-order-independent plan digest, immutable versions with monotonic +1 and rollback-as-new-version, 8 KB / 32-step / 1 KB-step hard rejects with no half-written file, 10-version soft prune that never evicts a referenced version (including terminal/recovery refs and task-scan live refs), audit-before-delete, corrupted-store and per-version corruption codes',
  'agent-workflow-binding':
    'task-to-plan binding (C2): plan is durably written before the task exists, A-class rejection leaves no task and no half-written plan, task-creation failure leaves only a harmless orphan plan, whole-store corruption fail-closes every bound non-terminal task to recovery while legacy planId=null tasks are untouched, per-task missing/mismatch/corrupt codes, planVersion and stateVersion never move each other, expectedVersion only honours stateVersion, idempotent replay adds no plan',
  'agent-workflow-crash':
    'workflow half-state crash injection (C3): a real SIGKILL right after the plan file is fsynced but before the task exists leaves exactly one durable orphan plan and zero task pointers (killed only after the marker, never by polling), and a constructed keyed-to-missing-plan task is fail-closed to recovery with plan_missing on restart while a healthy control task stays queued',
  'agent-crash-injection':
    'real SIGKILL crash injection (P5): handler-returned-but-unrecorded leaves one unknown ledger row and recovery without re-running the handler, artifacts persisted before state commit stay pending-commit and converge as pending, approval-record-before-state-move self-heals to waiting_approval, an interrupted read-only run leaves no intermediate state',
  'agent-approval-recovery':
    'approval execution idempotency (P3): begin-before-handler, crash-after-execution resumes to recovery without re-running the handler, a succeeded ledger row converges to executed instead of failed, approval-record-before-state-move (W5) leaves no dangling task, orphan waiting_approval tasks converge to recovery',
  'agent-artifact-content':
    'artifact content replay (A): durable per-artifact body, restart-time read-back with contentHash verification, corrupted/missing content fail-closed (never empty), version chain keeps superseded versions while old refs stay frozen, terminal-task-referenced versions are never cleaned, >256KB rejected with no half state',
  'agent-trust-level':
    '§27 trustLevel four-level ordered enum: only the Verification Engine may write it, other writers are rejected, invalid values are rejected without touching the stored value, and legacy records missing the field read as untrusted',
  'agent-task-transition-guard':
    '§24 write-permission guard: updateTask cannot write status or storage-owned stateVersion, and an illegal transition is rejected while leaving a from/to/reason audit event',
  'agent-run-limits':
    '§25 persisted hard limits: delegation depth 2, two replans per run (task-level counts also recorded), three run retries; counts survive restart and retries never reset them',
  'agent-conflict-record':
    '§28 ConflictRecord persistence and audit wired into the existing conflict approval path: records read back, audit entries queryable, decisions stay consistent with the stored record, and an unreadable store fails closed',
  'agent-error-contract':
    '§23 seven-field contract for validation_failed/not_authorized/budget_exceeded/dependency_failed/internal_error: all fields present, same input yields the same fingerprint, retryable follows the spec, and existing code/error/status keys are untouched',
  'agent-cycle-detection':
    '§17 delegation and artifact-lineage cycle detection with a readable cycle path: wired into the delegation entry and artifact persist path, cycles are rejected before any write, and legal chains pass',
  'agent-approval-request':
    '§29 Approval Request six states with illegal-transition rejection: an R2 expiry becomes expired and cannot be approved afterwards, and notification retries record attempts/lastError/nextRetryAt before stopping as exhausted',
  'agent-orphan-scheduler':
    'orphan cleanup on a production cadence (B): one startup run plus a 6h period driven by injectable fake timers, single-instance re-entry guard, failures logged without crashing or blocking the next run, TTL boundary measured to the millisecond, and no catch-up for periods missed while the process was down',
  'agent-failopen-enforcement':
    'fail-open decision wired into the real tool path (C): allowlist hit executes the handler with policyVersion in the audit, a miss denies with zero handler calls and a denied audit row, revocation takes effect on the next call, tasks without a frozen planId/planVersion are refused, R2/R3 still require approval even when an allowlist entry exists, and tools not registered as failOpenEligible keep their old behaviour',
  'agent-eval-tiers':
    '§14 evaluation splits (P5-A): dev/val/holdout/rotation validation with explicit failures for missing or illegal splits, per-split visibility clipping (holdout and rotation give neither sample nor answer to the optimized agent), leak scanning against hidden goals and answers, retirement priority leaked > overused > manual freeze, monotone and idempotent usage accounting, rotation plan with hidden-pool-exhausted alarm, and an optimizer report that only aggregates hidden buckets',
  'agent-eval-comparators':
    '§14 five comparator baselines and config records (P5-A): registry completeness with ablation restricted to wired mechanisms, config record rejecting missing fields while identity ignores codeCommit/evaluatedAt, same-baseline replay versus config-change comparison, per-comparator runtime effects (route/orchestration, reviewer subtask, whether replan really adds an attempt), upgrade eligibility requiring success-rate gain with no safety regression, and the offline CLI end to end (tiered run, usage recording, rotation plan, leak scan exit code, clipped optimizer report)',
  'agent-throttle-breaker-storm':
    '§26 four-dimension throttling, three-state circuit breaker and replan storm suppression (P5-B round 1): versioned thresholds that reference the §25 counters and the router capacity rule instead of duplicating them, leased semaphore (renew without double counting, deny with retryAfterMs, expired holders reclaimed), token bucket and bounded queue that never charge a rejected call, breaker sliding window with minSamples floor where deterministic errors stay out of the failure ratio plus half-open probe budget and re-arm, error-kind table cross-checked against model-adapter ERROR_STATUS, the five storm rules (improvement claim, equivalent rejected plan by plan digest + error fingerprint, cooldown, material plan diff, new-run evasion) with the §25 per-task limit enforced where production previously had no caller, and the real call path: createChatCompletion gated before any upstream request with error codes preserved and slots released on both stream and non-stream outcomes',
  'agent-circuit-enforcement':
    '§26 breaker enforcement on the tool gateway and routing side (P5-B round 2): per-domain error-code tables with deliberately different defaults for unclassified codes (model fails open to transient, tool/worker fail closed so healthy targets are never starved), ten transient tool failures open the circuit and the eleventh call returns tool_circuit_open with zero handler executions while the rejection is kept out of the dedupe cache, deterministic rejections (invalid_params) never enter the failure ratio, expiry plus two successful probes close the circuit and resume execution, a circuit-open agent is rejected by the production router with its own code agent_circuit_open/503 while not_authorized storms stay routable and an unreadable breaker file degrades to "no circuit" instead of refusing everything, limitsSnapshot exposes both tool: and worker: targets and survives a restart, and the storm denial actually lands in the event store (type whitelisted in tasks.EVENT_TYPES, list fields joined because safePayload drops arrays)',
  'reply-segmentation':
    'single-message default with a 400-char configurable hard limit, semantic split order (paragraph/newline/sentence), code-block and Markdown-link protection, English word boundaries',
  'monitoring-api':
    'monitoring API + real HTTP/context/agent/SSE/persistence instrumentation (model SDK stubbed)',
  'agent-runtime-guards':
    'agent runtime guards: cross-session MERGE dedupe scope, task deadlineMs, policy maxRounds, abort-listener cleanup',
  'agent-storage-limits':
    'agent event outbox hard cap, overflow accounting (drop_oldest) and outbox recovery',
  'memory-observability':
    'memory retrieval funnel (candidates/returned/injected), filter reason breakdown (expired/superseded/archived/pending/low-relevance), injected token attribution vs char count, sent-content hash, provider-vs-stub usage labeling and token reconciliation',
  'context-trace-verify':
    'end-to-end context trace: sent content hash recomputed from what the stub provider actually received, and stub usage labeled usage_source=stub (never counted as real provider usage)',
  'memory-user-scope':
    'user-level memory scope (P1): cross-session recall for the same user, strict cross-user denial, fail-closed without trusted identity, index scope visibility=user, write side on the same scope (cross-session correction/merge allowed, cross-user and no-identity writes rejected, withdrawal stays contribution-scoped)',
  'p3-acceptance':
    'P3 acceptance matrix (10 rows): cross-session recall, irrelevant-injection control, message-history isolation, cross-user denial, project scope (skipped: no Project entity), agent task isolation, withdrawn/expired/superseded exclusion, distinguishable failure states, large-store budget cap, trace content hash',
  'memory-ownership':
    'memory API ownership (multi-user P0 blocker): GET /memory + /memory/pending filtered by trusted userId, foreign ids return 403 with data unchanged, clear/clear-session never touch other users, approval executor refuses foreign targets including merge sourceIds, own operations still work',
  'session-ownership':
    'session ownership (multi-user P0 blocker): /sessions list filtered by userId, foreign session ids return 404 on /sessions/:id, /history, /presence, /chat, /chat/stream, /retrieval/search, /history/clear, /history/recall and DELETE with data unchanged, legacy sessions migrated to instance user, own operations still work',
};

function readBaseline(file = BASELINE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function computeCounts(baseline) {
  const names = Object.keys(baseline.files);
  const nodeSuiteFiles = baseline.nodeTestSuiteFiles || [];
  const runnerFiles = baseline.runnerFiles || [];
  const runnerSet = new Set(runnerFiles);

  let backendTotal = 0;
  let nodeTestSuiteTotal = 0;
  let runnerTotal = 0;
  let customRunnerCount = 0;
  let nodeRunnerCount = 0;

  for (const name of names) {
    const entry = baseline.files[name];
    backendTotal += entry.count;
    if (nodeSuiteFiles.includes(name)) nodeTestSuiteTotal += entry.count;
    if (runnerSet.has(name)) {
      runnerTotal += entry.count;
      if (entry.format === 'custom') customRunnerCount += 1;
      else nodeRunnerCount += 1;
    }
  }

  const count = name => {
    const entry = baseline.files[name];
    if (!entry) throw new Error(`基线里没有测试文件：${name}`);
    return entry.count;
  };

  return {
    files: names.length,
    backendTotal,
    nodeTestSuiteTotal,
    runnerTotal,
    runnerFiles: runnerFiles.length,
    nodeSuiteFiles: nodeSuiteFiles.length,
    customRunnerCount,
    nodeRunnerCount,
    nodeSuiteFileNames: nodeSuiteFiles,
    runnerFileNames: runnerFiles,
    frontend: baseline.frontend,
    count,
  };
}

// AGENTS.md 里的测试清单代码块。整块由脚本生成：文件顺序取自基线，
// 计数取自基线，说明取自本文件的 NOTES。
function buildRunnerList(ctx) {
  const eol = ctx.eol || '\n';
  const suiteLine = `node --test --test-concurrency=1 ${ctx.nodeSuiteFileNames
    .map(name => `tests/${name}.test.js`)
    .join(' ')}   # node:test suites (${ctx.nodeTestSuiteTotal})`;

  const runnerLines = ctx.runnerFileNames.map(name => {
    const command = `node tests/${name}.test.js`;
    const note = NOTES[name];
    const suffix = note ? ` — ${note}` : '';
    return `${command.padEnd(42)} # ${ctx.count(name)}${suffix}`;
  });

  return ['```bash', suiteLine, ...runnerLines, '```'].join(eol);
}

const TARGETS = [
  {
    file: 'AGENTS.md',
    id: 'agents-backend-totals',
    find: /(?:Forty-nine|\d+) files, \d+ checks total\./,
    build: ctx => `${ctx.files} files, ${ctx.backendTotal} checks total.`,
  },
  {
    file: 'AGENTS.md',
    id: 'agents-runner-list',
    find: /```bash\r?\nnode --test --test-concurrency=1 tests\/memory\.test\.js[\s\S]*?\r?\n```/,
    build: buildRunnerList,
  },
  {
    file: 'AGENTS.md',
    id: 'agents-suite-totals',
    find: /Seven `node:test` suites plus [\w-]+ direct-runner entries\./,
    build: ctx =>
      `Seven \`node:test\` suites plus ${ctx.runnerFiles} direct-runner entries.`,
  },
  {
    file: 'AGENTS.md',
    id: 'agents-runner-composition',
    find: /The [\w-]+ direct-runner entries consist of [\w-]+ custom-`check\(\)` scripts plus [\w-]+ `node:test` files invoked one file at a time; exit codes are authoritative, and there is no single TAP aggregate across all [\w-]+/,
    build: ctx =>
      `The ${ctx.runnerFiles} direct-runner entries consist of ${ctx.customRunnerCount} custom-\`check()\` scripts plus ${ctx.nodeRunnerCount} \`node:test\` files invoked one file at a time; exit codes are authoritative, and there is no single TAP aggregate across all ${ctx.runnerFiles}`,
  },
  {
    file: 'AGENTS.md',
    id: 'agents-frontend-totals',
    find: /Frontend unit tests \(\d+ suites \/ \d+ cases\)/,
    build: ctx =>
      `Frontend unit tests (${ctx.frontend.suites} suites / ${ctx.frontend.tests} cases)`,
  },
  {
    file: 'README.md',
    id: 'readme-backend-totals',
    find: /npm test {2,}# backend: auto-discovers tests\/\*\.test\.js \(\d+ files \/ \d+ checks\)/,
    build: ctx =>
      `npm test                    # backend: auto-discovers tests/*.test.js (${ctx.files} files / ${ctx.backendTotal} checks)`,
  },
  {
    file: 'README.md',
    id: 'readme-frontend-totals',
    find: /npm run test:unit -- --ci {3}# frontend: \d+ suites \/ \d+ cases/,
    build: ctx =>
      `npm run test:unit -- --ci   # frontend: ${ctx.frontend.suites} suites / ${ctx.frontend.tests} cases`,
  },
  {
    file: 'docs/memory-bot.md',
    id: 'memory-bot-delete-semantics',
    find: /`node tests\/delete-semantics\.test\.js`：\d+ 项/,
    build: ctx => `\`node tests/delete-semantics.test.js\`：${ctx.count('delete-semantics')} 项`,
  },
  {
    file: 'docs/memory-bot.md',
    id: 'memory-bot-maintenance',
    find: /`node tests\/memory-maintenance\.test\.js`：\d+ 项/,
    build: ctx => `\`node tests/memory-maintenance.test.js\`：${ctx.count('memory-maintenance')} 项`,
  },
  {
    file: 'docs/memory-bot.md',
    id: 'memory-bot-agent-dispatch',
    find: /`node tests\/agent-dispatch\.test\.js`：\d+ 项/,
    build: ctx => `\`node tests/agent-dispatch.test.js\`：${ctx.count('agent-dispatch')} 项`,
  },
  {
    file: 'docs/memory-bot.md',
    id: 'memory-bot-totals',
    find: /全量：`npm test` \d+ 个后端文件 \/ \d+ 项；Jest \d+ 套 \/ \d+ 项；覆盖率校验 backend \d+\/\d+、runner \d+\/\d+、frontend \d+\/\d+/,
    build: ctx =>
      `全量：\`npm test\` ${ctx.files} 个后端文件 / ${ctx.backendTotal} 项；Jest ${ctx.frontend.suites} 套 / ${ctx.frontend.tests} 项；覆盖率校验 backend ${ctx.backendTotal}/${ctx.backendTotal}、runner ${ctx.runnerTotal}/${ctx.runnerTotal}、frontend ${ctx.frontend.tests}/${ctx.frontend.tests}`,
  },
  {
    file: 'docs/memory-bot.md',
    id: 'memory-bot-coverage-line',
    find: /backend \d+\/\d+、nodeSuite \d+\/\d+、runner \d+\/\d+、frontend \d+\/\d+、CI \d+\/\d+/,
    build: ctx =>
      `backend ${ctx.backendTotal}/${ctx.backendTotal}、nodeSuite ${ctx.nodeTestSuiteTotal}/${ctx.nodeTestSuiteTotal}、runner ${ctx.runnerTotal}/${ctx.runnerTotal}、frontend ${ctx.frontend.tests}/${ctx.frontend.tests}、CI ${ctx.files}/${ctx.files}`,
  },
  {
    file: 'docs/unified-retrieval.md',
    id: 'unified-retrieval-suite-counts',
    find: /\| `node tests\/retrieval\.test\.js` \| \d+\/\d+ \|/,
    build: ctx => `| \`node tests/retrieval.test.js\` | ${ctx.count('retrieval')}/${ctx.count('retrieval')} |`,
  },
  {
    file: 'docs/unified-retrieval.md',
    id: 'unified-retrieval-api-counts',
    find: /\| `node tests\/retrieval-api\.test\.js` \| \d+\/\d+（/,
    build: ctx =>
      `| \`node tests/retrieval-api.test.js\` | ${ctx.count('retrieval-api')}/${ctx.count('retrieval-api')}（`,
  },
  {
    file: 'docs/unified-retrieval.md',
    id: 'unified-retrieval-embeddings-counts',
    find: /\| `node tests\/retrieval-embeddings\.test\.js` \| \d+\/\d+（/,
    build: ctx =>
      `| \`node tests/retrieval-embeddings.test.js\` | ${ctx.count('retrieval-embeddings')}/${ctx.count('retrieval-embeddings')}（`,
  },
  {
    file: 'docs/unified-retrieval.md',
    id: 'unified-retrieval-npm-test',
    find: /\| `npm test` \| \d+ 个后端测试文件 \/ \d+ 项全部通过 \|/,
    build: ctx =>
      `| \`npm test\` | ${ctx.files} 个后端测试文件 / ${ctx.backendTotal} 项全部通过 |`,
  },
  {
    file: 'docs/unified-retrieval.md',
    id: 'unified-retrieval-coverage',
    find: /\| `node scripts\/verify-test-coverage\.js` \| backend \d+\/\d+；nodeSuite \d+\/\d+；runner \d+\/\d+；frontend \d+\/\d+；CI \d+\/\d+ \|/,
    build: ctx =>
      `| \`node scripts/verify-test-coverage.js\` | backend ${ctx.backendTotal}/${ctx.backendTotal}；nodeSuite ${ctx.nodeTestSuiteTotal}/${ctx.nodeTestSuiteTotal}；runner ${ctx.runnerTotal}/${ctx.runnerTotal}；frontend ${ctx.frontend.tests}/${ctx.frontend.tests}；CI ${ctx.files}/${ctx.files} |`,
  },
  {
    file: 'docs/observability.md',
    id: 'observability-monitoring-count',
    find: /前端系统监控工作区 \+ \d+ 项 API\/链路测试/,
    build: ctx => `前端系统监控工作区 + ${ctx.count('monitoring-api')} 项 API/链路测试`,
  },
  {
    file: 'docs/persona-custom-prompt.md',
    id: 'persona-count',
    find: /`node tests\/persona\.test\.js`（\d+ 项）/,
    build: ctx => `\`node tests/persona.test.js\`（${ctx.count('persona')} 项）`,
  },
  {
    file: '.github/workflows/ci.yml',
    id: 'ci-header-counts',
    find: /# 回归兜底：覆盖率脚本单次执行后端 \d+ 个测试文件（\d+ 项）\+ 前端 \d+ 套单元测试（\d+ 项）/,
    build: ctx =>
      `# 回归兜底：覆盖率脚本单次执行后端 ${ctx.files} 个测试文件（${ctx.backendTotal} 项）+ 前端 ${ctx.frontend.suites} 套单元测试（${ctx.frontend.tests} 项）`,
  },
];

function applyTargets(text, targets, ctx) {
  const results = [];

  for (const target of targets) {
    const matches = text.match(new RegExp(target.find.source, 'g'));
    if (!matches || matches.length === 0) {
      results.push({ id: target.id, status: 'missing' });
      continue;
    }
    if (matches.length > 1) {
      results.push({ id: target.id, status: 'ambiguous', count: matches.length });
      continue;
    }

    const expected = target.build(ctx);
    const current = text.match(target.find)[0];
    if (current === expected) {
      results.push({ id: target.id, status: 'ok' });
      continue;
    }

    results.push({ id: target.id, status: 'changed', before: current, after: expected });
    text = text.replace(target.find, () => expected);
  }

  return { text, results };
}

function sync({ check = false } = {}) {
  const baseline = readBaseline();
  const ctx = computeCounts(baseline);

  const byFile = new Map();
  for (const target of TARGETS) {
    if (!byFile.has(target.file)) byFile.set(target.file, []);
    byFile.get(target.file).push(target);
  }

  const problems = [];
  const changed = [];
  const pending = [];

  for (const [file, targets] of byFile) {
    const absolute = path.join(ROOT, file);
    const original = fs.readFileSync(absolute, 'utf8');
    // 多行生成内容必须沿用文件原有的换行符（仓库里是 CRLF），
    // 否则一次同步就会把文件变成混合换行。
    const fileCtx = { ...ctx, eol: original.includes('\r\n') ? '\r\n' : '\n' };
    const { text, results } = applyTargets(original, targets, fileCtx);

    for (const result of results) {
      if (result.status === 'missing') {
        problems.push(`${file} / ${result.id}：锚点未命中（文档可能被改过形状）`);
      } else if (result.status === 'ambiguous') {
        problems.push(
          `${file} / ${result.id}：锚点命中 ${result.count} 次（必须唯一）`
        );
      } else if (result.status === 'changed') {
        changed.push(`${file} / ${result.id}`);
      }
    }

    if (text !== original) {
      if (check) {
        problems.push(`${file}：文档计数与基线不一致（--check 模式不写文件）`);
      } else {
        pending.push({ absolute, text });
      }
    }
  }

  // 全有或全无：任何一条锚点没命中，就一个文件都不写。
  // 半写状态比漂移更难排查。
  if (!problems.length) {
    for (const item of pending) {
      fs.writeFileSync(item.absolute, item.text);
    }
  }

  return { ctx, problems, changed };
}

function main() {
  const check = process.argv.includes('--check');
  const { ctx, problems, changed } = sync({ check });

  if (problems.length) {
    console.error('✖ 文档计数与基线不一致：');
    problems.forEach(problem => console.error(`  - ${problem}`));
    process.exit(1);
  }

  if (check) {
    console.log(
      `✔ 文档计数与基线一致：backend ${ctx.backendTotal}、` +
        `nodeSuite ${ctx.nodeTestSuiteTotal}、runner ${ctx.runnerTotal}、` +
        `frontend ${ctx.frontend.tests}、文件 ${ctx.files}`
    );
    return;
  }

  if (changed.length) {
    console.log(`已更新 ${changed.length} 处文档计数：`);
    changed.forEach(item => console.log(`  - ${item}`));
  } else {
    console.log('文档计数已是最新，无需修改');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  NOTES,
  TARGETS,
  readBaseline,
  computeCounts,
  buildRunnerList,
  applyTargets,
  sync,
};
