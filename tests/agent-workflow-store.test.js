/**
 * Phase 1 / C1：Workflow Store 存储层回归。
 *
 * 本文件是「计划不可变 + 引用优先 + 上限拒绝」的证据。C1 不接线，
 * 所以这里只测 Store 自身，不经过 router / runtime。
 *
 * 覆盖：
 *  a) 空 Store、首次追加的 planId/版本分配；
 *  b) digest 与键序无关；内容被篡改 → plan_corrupt；
 *  c) 版本不可变（追加新版不改旧版）、返回值为深拷贝；
 *  d) 版本号单调 +1；「回退」= 追加同内容新版本；
 *  e) A 类：单计划 >8 KB 拒绝，且磁盘字节不变（无半截状态）；
 *  f) A 类：steps >32、单 step >1 KB、未知字段、非法类型拒绝；
 *  g) A 类：planId 过长 / planVersion 非法拒绝；
 *  h) B 类：单计划保留 ≤10 版，只淘汰「未引用 + 最旧」；
 *  i) 已终态/recovery 任务的 pin 防裁剪，解 pin 后才可裁；
 *  j) liveRefs（任务文件现场扫描）同样防裁剪；
 *  k) 审计先写后删（auditOnly 演示「审计已提交、删除未执行」窗口）；
 *  l) Store 不可解析 / 结构非法 → plan_store_corrupted；
 *  m) getVersion 区分 缺失 / 版本不符。
 *
 * 未覆盖（如实标注）：Store 8 MB 体积上限（需要 2000 条计划才触顶，单测成本过高），
 * 与「单实例多进程并发写」一样留待后续压测。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-workflow-store-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const store = require('../server/agents/workflow-store');

const DAY_MS = 24 * 60 * 60 * 1000;

function basePlan(overrides = {}) {
  return {
    intent: 'general',
    enabled: true,
    layers: {
      history: true,
      summary: true,
      memory: true,
      knowledge: true,
      memoryTypes: null,
      memoryCategories: null,
      episodicOnly: false,
      knowledgeSources: null,
    },
    budgets: {
      history: { recentBudgetTokens: 3200, longRangeMaxItems: 6, summaryBudgetTokens: 800 },
      retrieval: { memoryMaxItems: 8, memoryTotalMax: 1600 },
      knowledge: { limit: 4, tokenBudget: 900, timeoutMs: 900 },
    },
    noAnswerThreshold: 0.04,
    reasons: ['general_default'],
    steps: [],
    allowedTools: ['memory_search'],
    budget: null,
    goalDigest: 'sha256:goal',
    ...overrides,
  };
}

function step(overrides = {}) {
  return store.buildStep({
    toolName: 'memory_search',
    args: { query: 'bluebird', limit: 3 },
    label: '查记忆',
    ...overrides,
  });
}

function resetStore() {
  for (const file of [store.WORKFLOW_FILE, store.AUDIT_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (_) {
      // ignore
    }
  }
}

function readBytes() {
  return fs.readFileSync(store.WORKFLOW_FILE, 'utf8');
}

function readStoreJson() {
  return JSON.parse(readBytes());
}

function writeRaw(text) {
  fs.mkdirSync(path.dirname(store.WORKFLOW_FILE), { recursive: true });
  fs.writeFileSync(store.WORKFLOW_FILE, text, 'utf8');
}

function assertCode(fn, code) {
  assert.throws(fn, error => {
    assert.strictEqual(error.code, code);
    return true;
  });
}

test.beforeEach(resetStore);

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. 缺文件返回空 Store；首次追加分配 plan_ 前缀与版本 1', () => {
  const empty = store.read();
  assert.deepStrictEqual(empty.plans, {});
  assert.deepStrictEqual(empty.refs, {});
  assert.strictEqual(empty.schemaVersion, 1);
  assert.strictEqual(fs.existsSync(store.WORKFLOW_FILE), false);

  const created = store.createPlan({ plan: basePlan() });
  assert.match(created.planId, /^plan_[0-9a-f-]{36}$/);
  assert.strictEqual(created.planVersion, 1);
  assert.strictEqual(created.headVersion, 1);
  assert.match(created.digest, /^sha256:[0-9a-f]{64}$/);

  const raw = readStoreJson();
  assert.strictEqual(raw.schemaVersion, 1);
  assert.strictEqual(raw.plans[created.planId].headVersion, 1);
  assert.strictEqual(raw.plans[created.planId].versions['1'].version, 1);
  assert.strictEqual(raw.plans[created.planId].versions['1'].digest, created.digest);
});

test('b. digest 与键序无关；内容篡改后读取判 plan_corrupt', () => {
  const first = store.createPlan({ plan: basePlan() });
  const reordered = basePlan({
    budgets: {
      knowledge: { timeoutMs: 900, tokenBudget: 900, limit: 4 },
      retrieval: { memoryTotalMax: 1600, memoryMaxItems: 8 },
      history: { summaryBudgetTokens: 800, longRangeMaxItems: 6, recentBudgetTokens: 3200 },
    },
  });
  assert.strictEqual(store.digestPlan(basePlan()), store.digestPlan(reordered));

  const raw = readStoreJson();
  raw.plans[first.planId].versions['1'].plan.noAnswerThreshold = 0.99;
  writeRaw(JSON.stringify(raw));

  assertCode(() => store.getVersion(first.planId, 1), 'plan_corrupt');
  // 单版本损坏不影响整个 Store 可读：其余版本仍能解析。
  assert.strictEqual(store.read().schemaVersion, 1);
});

test('c. 版本不可变；返回的 plan 是深拷贝', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['v1_reason'] }) });
  store.appendVersion({
    planId: created.planId,
    plan: basePlan({ reasons: ['v2_reason'] }),
  });

  const v1 = store.getVersion(created.planId, 1);
  assert.deepStrictEqual(v1.plan.reasons, ['v1_reason']);
  const v2 = store.getVersion(created.planId, 2);
  assert.deepStrictEqual(v2.plan.reasons, ['v2_reason']);
  assert.strictEqual(v2.headVersion, 2);

  v1.plan.reasons.push('mutated_by_caller');
  assert.deepStrictEqual(store.getVersion(created.planId, 1).plan.reasons, ['v1_reason']);
});

test('d. 版本号单调 +1；「回退」= 追加内容相同的新版本', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['original'] }) });
  const second = store.appendVersion({
    planId: created.planId,
    plan: basePlan({ reasons: ['changed'] }),
  });
  assert.strictEqual(second.planVersion, 2);

  // 回退：内容回到第一版，但版本号继续 +1，历史版本不动。
  const rollback = store.appendVersion({
    planId: created.planId,
    plan: basePlan({ reasons: ['original'] }),
  });
  assert.strictEqual(rollback.planVersion, 3);
  assert.strictEqual(rollback.digest, created.digest);
  assert.deepStrictEqual(store.getVersion(created.planId, 2).plan.reasons, ['changed']);
  assert.strictEqual(store.getVersion(created.planId, 3).digest, created.digest);
});

test('e. A 类：计划 >8 KB 拒绝，磁盘字节不变（无半截状态）', () => {
  const created = store.createPlan({ plan: basePlan() });
  const before = readBytes();

  const huge = basePlan({ budgets: { note: 'a'.repeat(9000) } });
  assertCode(
    () => store.appendVersion({ planId: created.planId, plan: huge }),
    'plan_too_large'
  );
  assert.strictEqual(readBytes(), before, '拒绝后 Store 字节必须与拒绝前一致');

  // 首次创建就超限时：文件根本不该出现。
  resetStore();
  assertCode(() => store.createPlan({ plan: huge }), 'plan_too_large');
  assert.strictEqual(fs.existsSync(store.WORKFLOW_FILE), false);
});

test('f. A 类：steps >32、单 step >1 KB、未知字段、非法类型均拒绝', () => {
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: Array.from({ length: 33 }, () => step()) }) }),
    'plan_step_limit'
  );

  const oversizedStep = { ...step(), padding: 'p'.repeat(2000) };
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: [oversizedStep] }) }),
    'plan_step_too_large'
  );

  assertCode(
    () => store.createPlan({ plan: basePlan({ surprise: 'unknown' }) }),
    'plan_invalid'
  );
  assertCode(
    () => store.createPlan({ plan: basePlan({ enabled: 'yes' }) }),
    'plan_invalid'
  );
  assertCode(
    () => store.createPlan({ plan: basePlan({ noAnswerThreshold: NaN }) }),
    'plan_invalid'
  );
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: [{ toolName: 'x' }] }) }),
    'plan_invalid'
  );
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: [step({ label: 'L'.repeat(201) })] }) }),
    'plan_invalid'
  );
  // 轮 2：step.agentId 可选字段——合法值接受并原样读回；非法类型/超长拒绝。
  const agentStep = { ...step(), agentId: 'researcher' };
  const withAgent = store.createPlan({ plan: basePlan({ steps: [agentStep] }) });
  const readBack = store.getVersion(withAgent.planId, 1);
  assert.strictEqual(readBack.plan.steps[0].agentId, 'researcher');
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: [{ ...step(), agentId: 42 }] }) }),
    'plan_invalid'
  );
  assertCode(
    () => store.createPlan({ plan: basePlan({ steps: [{ ...step(), agentId: 'a'.repeat(81) }] }) }),
    'plan_invalid'
  );
  // 32 条恰好通过。
  const ok = store.createPlan({ plan: basePlan({ steps: Array.from({ length: 32 }, () => step()) }) });
  assert.strictEqual(ok.planVersion, 1);
});

test('g. A 类：planId 过长、planVersion 非正整数拒绝', () => {
  const created = store.createPlan({ plan: basePlan() });
  for (const bad of [0, -1, 1.5, '1', null]) {
    assertCode(() => store.getVersion(created.planId, bad), 'plan_version_mismatch');
  }
  // planId 超过 80 字符：长度校验先拦下；不存在的合法 planId 走 plan_missing。
  const longId = `plan_${'y'.repeat(76)}`;
  assert.strictEqual(longId.length, 81);
  assertCode(() => store.appendVersion({ planId: longId, plan: basePlan() }), 'plan_invalid');
  assertCode(
    () => store.appendVersion({ planId: 'plan_unknown', plan: basePlan() }),
    'plan_missing'
  );
});

test('h. B 类：单计划保留 ≤10 版，只淘汰未引用最旧版', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['v1'] }) });
  for (let version = 2; version <= 11; version += 1) {
    store.appendVersion({
      planId: created.planId,
      plan: basePlan({ reasons: [`v${version}`] }),
    });
  }

  const raw = readStoreJson();
  const versions = Object.keys(raw.plans[created.planId].versions);
  assert.strictEqual(versions.length, store.MAX_VERSIONS_PER_PLAN);
  assert.strictEqual(raw.plans[created.planId].headVersion, 11);
  assert.strictEqual(versions.includes('1'), false, '最旧的未引用版本应被淘汰');
  assert.strictEqual(versions.includes('2'), true, '只淘汰超出的部分');
  assert.strictEqual(store.getVersion(created.planId, 11).plan.reasons[0], 'v11');
  assertCode(() => store.getVersion(created.planId, 1), 'plan_version_mismatch');
});

test('i. 已终态/recovery 任务仍引用 → 不裁剪；解 pin 才可裁', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['pinned_v1'] }) });
  // pin 不区分任务状态：已终态、recovery 的任务一样占 pin（人工追溯还要读）。
  store.pinRef({ taskId: 'task_terminal', planId: created.planId, planVersion: 1 });

  for (let version = 2; version <= 12; version += 1) {
    store.appendVersion({
      planId: created.planId,
      plan: basePlan({ reasons: [`v${version}`] }),
    });
  }
  const pinned = store.getVersion(created.planId, 1);
  assert.deepStrictEqual(pinned.plan.reasons, ['pinned_v1']);
  const raw = readStoreJson();
  assert.strictEqual(Object.keys(raw.plans[created.planId].versions).length, 10);

  store.unpinRef('task_terminal');
  // 解除引用后未到 7 天 TTL：仍然保留（版本数已回到上限内）。
  assert.strictEqual(store.getVersion(created.planId, 1).planVersion, 1);

  // 时间推进到 TTL 之外：解 pin 后整条血缘成为孤儿（无任何引用），被整体清理。
  const later = Date.now() + 8 * DAY_MS;
  const summary = store.prune({ now: later });
  assert.strictEqual(summary.removedPlans, 1);
  assertCode(() => store.getVersion(created.planId, 1), 'plan_missing');
});

test('j. liveRefs（任务文件现场扫描）同样防裁剪', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['live_v1'] }) });
  for (let version = 2; version <= 12; version += 1) {
    store.appendVersion({
      planId: created.planId,
      plan: basePlan({ reasons: [`v${version}`] }),
      liveRefs: [{ planId: created.planId, planVersion: 1 }],
    });
  }
  assert.deepStrictEqual(store.getVersion(created.planId, 1).plan.reasons, ['live_v1']);

  // Store 里没有 ref，但裁剪前重扫 liveRefs：仍然不裁。
  const summary = store.prune({
    liveRefs: [{ planId: created.planId, planVersion: 1 }],
    now: Date.now() + 8 * DAY_MS,
  });
  assert.deepStrictEqual(store.getVersion(created.planId, 1).plan.reasons, ['live_v1']);
  assert.strictEqual(summary.pinned, 1);
  // 被引用的 v1 单独留下，其余未引用旧版本按 TTL 清掉。
  assert.deepStrictEqual(
    Object.keys(readStoreJson().plans[created.planId].versions),
    ['1']
  );
});

test('k. 审计先写后删：auditOnly 只写审计、不删版本', () => {
  const created = store.createPlan({ plan: basePlan({ reasons: ['v1'] }) });
  store.appendVersion({ planId: created.planId, plan: basePlan({ reasons: ['v2'] }) });
  // 让血缘「仍被引用」，这样 v1 走的是「解除引用 TTL」而不是整条孤儿清理。
  store.pinRef({ taskId: 'task_pinned', planId: created.planId, planVersion: 2 });

  const before = readBytes();
  const later = Date.now() + 8 * DAY_MS;

  const auditOnly = store.prune({ now: later, auditOnly: true });
  assert.strictEqual(auditOnly.removedVersions, 0);

  const auditRaw = JSON.parse(fs.readFileSync(store.AUDIT_FILE, 'utf8'));
  assert.strictEqual(auditRaw.entries.length, 1);
  assert.strictEqual(auditRaw.entries[0].action, 'prune_version');
  assert.strictEqual(auditRaw.entries[0].reason, 'unreferenced_ttl');
  assert.strictEqual(auditRaw.entries[0].planId, created.planId);
  // 删除没执行：Store 字节完全没变，版本 1 仍可读。
  assert.strictEqual(readBytes(), before);
  assert.strictEqual(store.getVersion(created.planId, 1).planVersion, 1);

  // 正常裁剪：先补审计，再删除。
  const pruned = store.prune({ now: later });
  assert.strictEqual(pruned.removedVersions, 1);
  const auditAfter = JSON.parse(fs.readFileSync(store.AUDIT_FILE, 'utf8'));
  assert.strictEqual(auditAfter.entries.length, 2);
  assertCode(() => store.getVersion(created.planId, 1), 'plan_version_mismatch');
  assert.strictEqual(store.getVersion(created.planId, 2).plan.reasons[0], 'v2');
});

test('l. Store 不可解析 / 结构非法 → plan_store_corrupted', () => {
  writeRaw('{not json');
  assertCode(() => store.read(), 'plan_store_corrupted');

  writeRaw(JSON.stringify({ schemaVersion: 1, plans: [], refs: {} }));
  assertCode(() => store.read(), 'plan_store_corrupted');

  resetStore();
  const created = store.createPlan({ plan: basePlan() });
  const raw = readStoreJson();
  raw.plans[created.planId].versions['1'].digest = 'md5:abc';
  writeRaw(JSON.stringify(raw));
  assertCode(() => store.read(), 'plan_store_corrupted');
});

test('m. getVersion 区分「计划缺失」与「版本不符」', () => {
  const created = store.createPlan({ plan: basePlan() });

  assertCode(() => store.getVersion('plan_missing_id', 1), 'plan_missing');
  assertCode(() => store.getVersion(created.planId, 2), 'plan_version_mismatch');
  assertCode(() => store.getVersion(created.planId, 999), 'plan_version_mismatch');

  // 指定一个不存在的血缘做重规划：拒绝而不是静默新建。
  assertCode(
    () => store.appendVersion({ planId: 'plan_unknown', plan: basePlan() }),
    'plan_missing'
  );
});

// ---- A-01 计划版本迁移：§13 七项复用检查 + 运行中节点 + 副作用补偿 ----

function artifactFixture(overrides = {}) {
  const s = step();
  return {
    id: 'art_fixture',
    stepKey: s.stepKey,
    argsDigest: s.argsDigest,
    createdAt: new Date().toISOString(),
    taint: [],
    provenanceRefs: ['agent:researcher'],
    schemaVersion: 'message-v1',
    permissionScope: 'task',
    acceptanceDigest: 'acc_v1',
    dependsOnVersions: {},
    ...overrides,
  };
}

test('A-01 §13 复用检查逐项 fail-closed：输入/污点/时效/schema/验收/权限/依赖版本', () => {
  const s = step();
  const now = Date.now();
  const clean = artifactFixture();
  const baseStep = {
    stepKey: s.stepKey,
    argsDigest: s.argsDigest,
    schemaVersion: 'message-v1',
    permissionScope: 'task',
    acceptanceDigest: 'acc_v1',
  };

  const ok = store.artifactReuseDecision({ artifact: clean, step: baseStep, now });
  assert.strictEqual(ok.reusable, true);
  assert.deepStrictEqual(ok.reasons, []);

  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: clean,
      step: { ...baseStep, stepKey: 'f'.repeat(64) },
      now,
    }).reasons,
    ['input_step_mismatch']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({ taint: ['external:web'] }),
      step: baseStep,
      now,
    }).reasons,
    ['provenance_tainted']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      }),
      step: baseStep,
      now,
    }).reasons,
    ['stale']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({ schemaVersion: 'message-v2' }),
      step: baseStep,
      now,
    }).reasons,
    ['schema_mismatch']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({ acceptanceDigest: 'acc_v2' }),
      step: baseStep,
      now,
    }).reasons,
    ['acceptance_mismatch']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({ permissionScope: 'workspace' }),
      step: baseStep,
      now,
    }).reasons,
    ['permission_scope_mismatch']
  );
  assert.deepStrictEqual(
    store.artifactReuseDecision({
      artifact: artifactFixture({ dependsOnVersions: { step_b: 1 } }),
      step: { ...baseStep, dependsOn: ['step_b'] },
      deps: { step_b: 2 },
      now,
    }).reasons,
    ['dependency_version_mismatch:step_b']
  );
});

test('A-01 迁移：未开始节点迁新版本、运行中节点保原版本、可复用产物复用且保留 provenance/taint', () => {
  const s = store.buildStep({
    toolName: 'memory_search',
    args: { query: 'bluebird', limit: 3 },
    label: '查记忆',
    schemaVersion: 'message-v1',
    permissionScope: 'task',
    acceptanceDigest: 'acc_v1',
  });
  const created = store.createPlan({ plan: basePlan({ steps: [s] }) });
  const now = Date.now();
  const clean = artifactFixture({ id: 'art_clean', createdAt: new Date(now).toISOString() });
  const tainted = artifactFixture({
    id: 'art_tainted',
    createdAt: new Date(now).toISOString(),
    taint: ['external:web'],
    provenanceRefs: ['agent:researcher', 'external:web'],
  });
  const tasks = [
    { taskId: 'task_queued', status: 'queued', planVersion: 1, stepKey: s.stepKey },
    { taskId: 'task_running', status: 'running', planVersion: 1, stepKey: s.stepKey },
    {
      taskId: 'task_done_clean',
      status: 'completed',
      planVersion: 1,
      stepKey: s.stepKey,
      result: { artifacts: [{ kind: 'message', id: clean.id, version: 1 }] },
    },
    {
      taskId: 'task_done_tainted',
      status: 'completed',
      planVersion: 1,
      stepKey: s.stepKey,
      result: { artifacts: [{ kind: 'message', id: tainted.id, version: 1 }] },
    },
  ];

  const summary = store.migratePlanVersion({
    planId: created.planId,
    plan: basePlan({ steps: [s] }),
    tasks,
    artifacts: [clean, tainted],
    now,
  });

  assert.strictEqual(summary.saved.planVersion, 2);
  assert.strictEqual(summary.policyVersion, 'plan-migration-v1');
  assert.strictEqual(summary.toVersion, 2);

  const byTask = new Map(summary.migrations.map(item => [item.taskId, item]));
  // 未开始 → 迁到新版本。
  assert.strictEqual(byTask.get('task_queued').mapping, 'migrated');
  assert.strictEqual(byTask.get('task_queued').toPlanVersion, 2);
  // 运行中 → 保持原版本，避免半途换计划。
  assert.strictEqual(byTask.get('task_running').mapping, 'continued');
  assert.strictEqual(byTask.get('task_running').toPlanVersion, 1);
  // 可复用产物 → reused，且 provenance/taint 原样保留（未清洗）。
  assert.strictEqual(byTask.get('task_done_clean').mapping, 'reused');
  const reused = byTask.get('task_done_clean').artifacts[0];
  assert.deepStrictEqual(reused.provenanceRefs, clean.provenanceRefs);
  assert.deepStrictEqual(reused.taint, clean.taint);
  // 污点产物 → 不可复用，不得误复用。
  assert.strictEqual(byTask.get('task_done_tainted').mapping, 'revalidated');
  assert.ok(byTask.get('task_done_tainted').reasons.includes('provenance_tainted'));

  assert.strictEqual(summary.compensations.length, 1);
  const compensation = summary.compensations[0];
  assert.strictEqual(compensation.mode, 'reexecute');
  assert.strictEqual(compensation.artifactId, tainted.id);
  assert.ok(compensation.override.includes(`planMigration:${created.planId}:v2:`));
  // 复用既有 op-ledger override 语义：不同 override 派生不同 opKey（旧副作用不会被误复用）。
  assert.notStrictEqual(
    store.stepKeyFor({
      toolName: 'memory_search',
      args: { query: 'bluebird', limit: 3 },
      override: compensation.override,
    }),
    store.stepKeyFor({ toolName: 'memory_search', args: { query: 'bluebird', limit: 3 } })
  );

  // 迁移审计落既有 audit 文件，可追 mapping 与原因。
  const audit = JSON.parse(fs.readFileSync(store.AUDIT_FILE, 'utf8'));
  const migrationEntries = audit.entries.filter(entry => entry.action === 'migrate_plan');
  assert.ok(migrationEntries.length >= 4);
  assert.ok(
    migrationEntries.some(
      entry =>
        entry.taskId === 'task_done_tainted' &&
        entry.reason.includes('revalidated') &&
        entry.reason.includes('provenance_tainted')
    )
  );
  assert.ok(
    migrationEntries.some(
      entry => entry.taskId === 'task_running' && entry.reason.includes('continued')
    )
  );
});
