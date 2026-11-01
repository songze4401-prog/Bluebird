#!/usr/bin/env node
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
    'persona panel: split-reply rules (incl. short-segment regression), /persona API, customPrompt (defaults, old-file migration, strict type/length/body-size validation with the stored file left byte-identical, reset clears it), custom block in the final /chat and /chat/stream model request, empty value = legacy prompt, malicious text neutralized and tool gating unchanged, prompt injection, per-mode splitting, corruption protection',
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
    'agent tool calling V1: three gates (switch / capability / no-new-image), history-image and MIME boundary, 3-round cap, per-session memory scope, tool timeout & abort, late-result handling, toolSteps persistence & read-back, SSE tool_start/tool_end, model semantics on downgrade',
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
    'lifecycle golden path: supersede/delete/withdraw visibility in final request and unified search, session isolation',
  'memory-state-units':
    'normalizeMemoryState mapping, breaker/exception/timeout degradation without blocking, requestId in engine/trace, time budget',
  'memory-degradation-golden':
    'real server with MEMORY_ENABLED=false: chat still works, memoryState=empty, no memory block injected, stable across turns',
  'memory-budget-golden':
    'budget trimming: 10 memories → memoryMaxItems=8 → final request injects ≤8, token budget enforced',
  'agent-dispatch':
    'main tool → Bot task, parent-memory read/write scope, approval delivery, result SSE/snapshot, failure delivery, dedupe, outbox recovery',
  'agent-router':
    'router decision chain, task contract v1, fast/slow budgets, idempotency/priority queue, route events privacy, delegate_to_bot compatibility',
  'agent-worker':
    'worker lifecycle/runId, session owner/scope/lifecycle, context projection, tool gateway audit, unified result schema, cancel/timeout/model-failure terminal states, concurrency isolation',
  'agent-recovery':
    'state machine transitions, task-store schema migration, leases/retry backoff/checkpoint version/run history, restart recovery (queued/uncertain/live lease), SIGKILL fault injection, delivery idempotency and crash redelivery',
  'agent-watchdog':
    'watchdog health classification, action planning with whitelist/cooldown/breaker, intake pause and resume, offline recovery, escalation, audit fields, dry-run, external supervisor restart drill',
  'monitoring-api':
    'monitoring API + real HTTP/context/agent/SSE/persistence instrumentation (model SDK stubbed)',
  'agent-runtime-guards':
    'agent runtime guards: cross-session MERGE dedupe scope, task deadlineMs, policy maxRounds, abort-listener cleanup',
  'agent-storage-limits':
    'agent event outbox hard cap, overflow accounting (drop_oldest) and outbox recovery',
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
