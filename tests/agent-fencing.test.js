/* global require, process, __dirname */
/**
 * P5-C 第 1 轮：fencing / generation token（Notion §10 + §20 第 349 步，台账 FM-4）。
 *
 * 目标场景：计划迁移或租约易主之后，**旧 Worker 还在跑**。它手里的授权是旧代次的，
 * 但进程没死、工具还能调、产物还能写。本文件证明四件事：
 *  - 代次单调且落盘可读回，文件被改坏/回退时 fail-closed，绝不重置成 0；
 *  - 旧代次的副作用在**真实工具路径**上被拦，handler 一次都不执行、账本零行；
 *  - 真实 runTask 一次完整运行会签发令牌、终态时撤销，旧令牌之后连复读都过不去；
 *  - §10 迁移的六种映射里只有 migrated 换发、cancelled/revalidated 收回，
 *    continued 保持原代次（running 节点不因计划出新版本被拦）。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5c1-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '80';

const agent = require('../server/agent-runtime');
const errors = require('../server/agents/errors');
const fencing = require('../server/agents/fencing');
const ledger = require('../server/agents/op-ledger');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const store = require('../server/agents/workflow-store');
const { createSideEffectGuard } = require('../server/agents/side-effect-guard');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
}

function register(name, handler) {
  agent.registerTool({
    name,
    description: `P5-C 测试工具 ${name}`,
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
    },
    readOnly: false,
    timeoutMs: 2000,
    validate: args =>
      args && typeof args === 'object' ? { ok: true, args } : { ok: false, error: 'bad_args' },
    handler,
  });
}

function contextFor(guard) {
  return {
    sessionId: 'bs_p5c',
    userText: 'P5-C 测试用户原话',
    cache: new Map(),
    sideEffect: guard,
  };
}

function ledgerRows(taskId) {
  return Object.values(ledger.read().ops).filter(entry => entry.taskId === taskId);
}

function eventsOf(taskId, type) {
  const file = path.join(AGENTS_DIR, 'agent-events.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed.events) ? parsed.events : [];
  return list.filter(event => event.taskId === taskId && (!type || event.eventType === type));
}

test.after(() => {
  // memory_remember 是真实工具名，这里只是在本文件里临时覆盖，进程结束即失效，不注销。
  agent.unregisterTool('fence_write');
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. 代次单调、落盘可读回；改坏或回退一律 fail-closed，绝不重置成 0', () => {
  resetAll();
  const first = fencing.issue({ taskId: 'task_a', planId: 'plan_x', planVersion: 1, runId: 'run_1' });
  assert.equal(first.generation, 1);
  assert.equal(first.policyVersion, 'fencing-v1');
  assert.ok(first.tokenId.startsWith('ft_'));

  const second = fencing.issue({ taskId: 'task_a', planId: 'plan_x', planVersion: 1, runId: 'run_2' });
  assert.equal(second.generation, 2, '同一任务重新签发必须拿到更高代次');
  assert.notEqual(second.tokenId, first.tokenId);
  assert.equal(fencing.recover().counter, 2, '计数器必须落盘');
  assert.equal(fencing.current('task_a').generation, 2);

  assert.equal(fencing.verify({ taskId: 'task_a', token: second }).ok, true);
  const stale = fencing.verify({ taskId: 'task_a', token: first });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_generation');
  assert.equal(stale.heldGeneration, 1);
  assert.equal(stale.currentGeneration, 2);

  // 计数器被改小（小于已签发代次）：不是"修复"，是文件坏了 → 全部拒绝。
  const raw = JSON.parse(fs.readFileSync(fencing.FENCING_FILE, 'utf8'));
  raw.counter = 1;
  fs.writeFileSync(fencing.FENCING_FILE, JSON.stringify(raw), 'utf8');
  assert.throws(() => fencing.recover(), /代次存储不可用/);
  assert.equal(fencing.verify({ taskId: 'task_a', token: second }).code, 'fencing_unavailable');

  // 文件被写成非 JSON：同样拒绝，不当作空存储。
  fs.writeFileSync(fencing.FENCING_FILE, '{broken', 'utf8');
  assert.equal(fencing.verify({ taskId: 'task_a', token: second }).code, 'fencing_unavailable');
});

test('b. 五类拒绝各有独立短码：缺失/伪造/未来代次/撤销/过期', () => {
  resetAll();
  const token = fencing.issue({ taskId: 'task_b', planId: 'plan_b', planVersion: 1 });

  assert.equal(fencing.verify({ taskId: 'task_b' }).code, 'fencing_token_missing');
  assert.equal(fencing.verify({ taskId: 'task_unknown', token }).code, 'fencing_token_missing');
  assert.equal(fencing.verify({ taskId: 'task_b', token: { ...token, tokenId: 'ft_forged' } }).code, 'fencing_token_invalid');
  assert.equal(fencing.verify({ taskId: 'task_b', token: { ...token, generation: 99 } }).code, 'fencing_token_invalid');
  assert.equal(fencing.verify({ taskId: 'task_b', token: { ...token, taskId: 'task_other' } }).code, 'fencing_token_invalid');

  const revoked = fencing.revoke({ taskId: 'task_b', reason: 'task_terminal:completed' });
  assert.equal(revoked.changed, true);
  assert.equal(fencing.verify({ taskId: 'task_b', token }).code, 'fencing_revoked');
  assert.equal(fencing.revoke({ taskId: 'task_b', reason: 'again' }).changed, false, '重复撤销不该重复记账');
  assert.equal(fencing.revoke({ taskId: 'task_never_issued' }), null);

  // 失败模式口径：这四类归 FM-4；存储不可用归恢复流程，不冒充版本竞争。
  for (const code of ['stale_generation', 'fencing_revoked', 'fencing_token_invalid', 'fencing_token_missing']) {
    assert.equal(errors.classifyFailureMode({ errorCode: code }), 'plan_version_race', code);
  }
  assert.equal(errors.classifyFailureMode({ errorCode: 'fencing_unavailable' }), null);
  assert.equal(errors.failureModeDisposition('plan_version_race').retryable, false);
});

test('c. 真实工具路径：旧代次的副作用被拦，handler 零执行、账本零行；新代次正常执行', async () => {
  resetAll();
  let calls = 0;
  register('fence_write', async () => {
    calls += 1;
    return { ok: true, summary: 'written' };
  });

  const oldToken = fencing.issue({ taskId: 'task_c', planId: 'plan_c', planVersion: 1, runId: 'run_old' });
  const newToken = fencing.issue({ taskId: 'task_c', planId: 'plan_c', planVersion: 1, runId: 'run_new' });

  const blocked = await agent.executeToolCall(
    'fence_write',
    { x: 1 },
    contextFor(createSideEffectGuard({ agentId: 'memory', taskId: 'task_c', fencingToken: oldToken }))
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'stale_generation');
  assert.match(blocked.error, /写入资格已失效/);
  assert.equal(calls, 0, '被拦的调用连 handler 都不该进');
  assert.equal(ledgerRows('task_c').length, 0, '被拦的调用不该留下账本意图行');

  const executed = await agent.executeToolCall(
    'fence_write',
    { x: 1 },
    contextFor(createSideEffectGuard({ agentId: 'memory', taskId: 'task_c', fencingToken: newToken }))
  );
  assert.equal(executed.ok, true);
  assert.equal(calls, 1);
  const rows = ledgerRows('task_c');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'succeeded');

  // 撤销后同一个令牌也过不去（任务终态场景）。
  fencing.revoke({ taskId: 'task_c', reason: 'task_terminal:completed' });
  const afterRevoke = await agent.executeToolCall(
    'fence_write',
    { x: 2 },
    contextFor(createSideEffectGuard({ agentId: 'memory', taskId: 'task_c', fencingToken: newToken }))
  );
  assert.equal(afterRevoke.code, 'fencing_revoked');
  assert.equal(calls, 1);
});

// ---- 真实 runTask：签发 → 校验 → 终态撤销 ----

let providerServer = null;

async function setupProvider() {
  providerServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const messages = parsed.messages || [];
      const hasToolResult = messages.some(message => message.role === 'tool');
      const reply = payload => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (!hasToolResult) {
        reply({
          id: 'chatcmpl-p5c-tool',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'p5c-test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_p5c_write',
                    type: 'function',
                    function: { name: 'memory_remember', arguments: JSON.stringify({ x: 7 }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage,
        });
        return;
      }
      reply({
        id: 'chatcmpl-p5c',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'p5c-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'P5-C 任务已完成' },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: 'P5C Test Provider',
    baseUrl: base,
    apiKey: 'global-not-used',
    models: [{ id: 'p5c-test-model', name: 'P5C Test Model', capabilities: { tools: true } }],
  });
  assert.ok(added.provider, JSON.stringify(added));
  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'p5c-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId: added.provider.id,
    apiKey: 'p5c-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
}

async function waitForTask(taskId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

test('d. 真实 runTask：运行开始签发、副作用按新代次放行、终态撤销且审计落账', async () => {
  resetAll();
  await setupProvider();
  let calls = 0;
  register('memory_remember', async () => {
    calls += 1;
    return { ok: true, summary: 'written' };
  });

  try {
    const task = tasks.createTask({
      botId: 'memory',
      taskType: 'memory.search',
      goal: 'P5C 真实运行',
      allowedTools: ['memory_remember'],
      deadlineMs: 20000,
    });
    runtime.startTask(task.taskId);
    const finished = await waitForTask(task.taskId);

    assert.equal(finished && finished.status, 'completed', JSON.stringify(finished && finished.errorCode));
    assert.equal(calls, 1, '有资格的那次运行真的执行了副作用');
    assert.equal(ledgerRows(task.taskId).length, 1);

    const record = fencing.current(task.taskId);
    assert.ok(record, '运行开始必须签发令牌');
    assert.ok(record.generation >= 1);
    assert.ok(record.revokedAt, '终态必须撤销写入资格');
    assert.equal(record.revokeReason, `task_terminal:${finished.status}`);

    const issued = eventsOf(task.taskId, 'plan.fencing_issued');
    assert.equal(issued.length, 1);
    assert.equal(issued[0].payload.generation, record.generation);
    const revoked = eventsOf(task.taskId, 'plan.fencing_revoked');
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].payload.generation, record.generation);

    // 复读旧令牌：任务已终态，任何迟到写入都过不去。
    const late = fencing.verify({
      taskId: task.taskId,
      token: {
        taskId: task.taskId,
        tokenId: record.tokenId,
        generation: record.generation,
      },
    });
    assert.equal(late.code, 'fencing_revoked');
  } finally {
    if (providerServer) {
      if (typeof providerServer.closeAllConnections === 'function') providerServer.closeAllConnections();
      await new Promise(resolve => providerServer.close(resolve));
      providerServer = null;
    }
  }
});

// ---- §10 迁移映射 → 代次处置 ----

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

test('e. 迁移桥：只有 migrated 换发、cancelled/revalidated 收回、continued 保持原代次', () => {
  resetAll();
  const step = store.buildStep({
    toolName: 'memory_search',
    args: { query: 'bluebird', limit: 3 },
    label: '查记忆',
    schemaVersion: 'message-v1',
    permissionScope: 'task',
    acceptanceDigest: 'acc_v1',
  });
  const created = store.createPlan({ plan: basePlan({ steps: [step] }) });
  const now = Date.now();

  // 四种任务的旧令牌都先签发，模拟"迁移前它们各自有过一次运行"。
  const queued = fencing.issue({ taskId: 'task_queued', planId: created.planId, planVersion: 1 });
  const running = fencing.issue({ taskId: 'task_running', planId: created.planId, planVersion: 1 });
  const tainted = fencing.issue({ taskId: 'task_tainted', planId: created.planId, planVersion: 1 });
  const removed = fencing.issue({ taskId: 'task_removed', planId: created.planId, planVersion: 1 });

  const taintedArtifact = {
    id: 'art_tainted_p5c',
    stepKey: step.stepKey,
    argsDigest: step.argsDigest,
    createdAt: new Date(now).toISOString(),
    taint: ['external:web'],
    provenanceRefs: ['agent:researcher', 'external:web'],
    schemaVersion: 'message-v1',
    permissionScope: 'task',
    acceptanceDigest: 'acc_v1',
    dependsOnVersions: {},
  };

  const summary = store.migratePlanVersion({
    planId: created.planId,
    plan: basePlan({ steps: [step] }),
    tasks: [
      { taskId: 'task_queued', status: 'queued', planVersion: 1, stepKey: step.stepKey },
      { taskId: 'task_running', status: 'running', planVersion: 1, stepKey: step.stepKey },
      {
        taskId: 'task_tainted',
        status: 'completed',
        planVersion: 1,
        stepKey: step.stepKey,
        result: { artifacts: [{ kind: 'message', id: taintedArtifact.id, version: 1 }] },
      },
      { taskId: 'task_removed', status: 'queued', planVersion: 1, stepKey: 'step_gone' },
    ],
    artifacts: [taintedArtifact],
    now,
  });

  assert.equal(summary.saved.planVersion, 2);
  const byTask = new Map(summary.migrations.map(item => [item.taskId, item]));
  assert.equal(byTask.get('task_queued').mapping, 'migrated');
  assert.equal(byTask.get('task_running').mapping, 'continued');
  assert.equal(byTask.get('task_tainted').mapping, 'revalidated');
  assert.equal(byTask.get('task_removed').mapping, 'cancelled');
  assert.deepEqual(summary.fencing.issued, ['task_queued']);
  assert.deepEqual(new Set(summary.fencing.revoked), new Set(['task_tainted', 'task_removed']));
  assert.deepEqual(summary.fencing.kept, ['task_running']);

  // migrated：旧令牌过期，新令牌代次更高且带 v2。
  const reissued = fencing.current('task_queued');
  assert.equal(reissued.planVersion, 2);
  assert.ok(reissued.generation > queued.generation);
  assert.equal(fencing.verify({ taskId: 'task_queued', token: queued }).code, 'stale_generation');

  // continued：running 节点保持原代次（§10 不因计划出新版本换掉正在跑的节点）。
  assert.equal(fencing.verify({ taskId: 'task_running', token: running }).ok, true);
  assert.equal(fencing.current('task_running').planVersion, 1);

  // cancelled / revalidated：旧资格收回。
  assert.equal(fencing.verify({ taskId: 'task_tainted', token: tainted }).code, 'fencing_revoked');
  assert.equal(fencing.verify({ taskId: 'task_removed', token: removed }).code, 'fencing_revoked');
});

test('f. 启动对账：代次文件损坏 → 非终态任务 recovery；读得回来则补撤终态令牌', () => {
  resetAll();
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: 'P5C 恢复对账',
    allowedTools: [],
    deadlineMs: 20000,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  const token = fencing.issue({ taskId: task.taskId, planId: null, planVersion: null });

  fs.writeFileSync(fencing.FENCING_FILE, '{broken', 'utf8');
  const summary = runtime.convergeFencingTokens();
  assert.equal(summary.available, false);
  assert.equal(summary.storeCorrupted, true);
  assert.deepEqual(summary.failedTaskIds, [task.taskId]);
  const failedTask = tasks.getRawTask(task.taskId);
  assert.equal(failedTask.status, 'recovery');
  assert.equal(failedTask.errorCode, 'fencing_unavailable');
  assert.equal(eventsOf(task.taskId, 'task.uncertain').length, 1);

  // 修好文件后重启：计数器只增不减，终态任务令牌被补撤。
  resetAll();
  const ok1 = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: 'G1', allowedTools: [] });
  const issued = fencing.issue({ taskId: ok1.taskId });
  tasks.transitionTask(ok1.taskId, { to: 'accepted' });
  tasks.transitionTask(ok1.taskId, { to: 'running' });
  const healthy = runtime.convergeFencingTokens();
  assert.equal(healthy.available, true);
  assert.equal(healthy.counter, issued.generation, '计数器原样保留，不重建');
  assert.equal(healthy.sealed, 0, '非终态任务的令牌不动');

  tasks.transitionTask(ok1.taskId, { to: 'completed' });
  const sealed = runtime.convergeFencingTokens();
  assert.equal(sealed.sealed, 1);
  assert.ok(fencing.current(ok1.taskId).revokedAt);
  assert.equal(fencing.verify({ taskId: ok1.taskId, token: issued }).code, 'fencing_revoked');
});

test('g. 审计白名单：代次字段真的落进事件，不被 safePayload 静默丢掉', () => {
  resetAll();
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: 'P5C 审计字段',
    allowedTools: [],
  });
  tasks.appendEvent({
    botId: 'memory',
    taskId: task.taskId,
    eventType: 'plan.fencing_denied',
    payload: {
      errorCode: 'stale_generation',
      heldGeneration: 1,
      currentGeneration: 2,
      generation: 2,
      planId: 'plan_x',
      planVersion: 2,
      phase: 'artifact_persist',
      policyVersion: 'fencing-v1',
    },
  });
  const [event] = eventsOf(task.taskId, 'plan.fencing_denied');
  assert.ok(event, '事件类型必须在 EVENT_TYPES 白名单里');
  assert.equal(event.payload.heldGeneration, 1);
  assert.equal(event.payload.currentGeneration, 2);
  assert.equal(event.payload.generation, 2);
  assert.equal(event.payload.planId, 'plan_x');
  assert.equal(event.payload.planVersion, 2);
  assert.equal(event.payload.phase, 'artifact_persist');
});

test('h. 清理：只删"已撤销 + 任务已终态"，活跃记录与未终态任务一律保留', () => {
  resetAll();
  const active = fencing.issue({ taskId: 'task_active' });
  const revokedTerminal = fencing.issue({ taskId: 'task_revoked_terminal' });
  const revokedRunning = fencing.issue({ taskId: 'task_revoked_running' });
  fencing.revoke({ taskId: 'task_revoked_terminal', reason: 'task_terminal:completed' });
  fencing.revoke({ taskId: 'task_revoked_running', reason: 'plan_migration:cancelled' });

  const result = fencing.cleanup({ terminalTaskIds: ['task_revoked_terminal', 'task_active'] });
  assert.equal(result.removed, 1);
  assert.equal(fencing.current('task_active').generation, active.generation);
  assert.equal(fencing.current('task_revoked_terminal'), null);
  assert.equal(fencing.current('task_revoked_running').generation, revokedRunning.generation);
  // 记录被删不会让旧令牌复活：没有记录就是 token_missing，仍然拒绝。
  assert.equal(
    fencing.verify({ taskId: 'task_revoked_terminal', token: revokedTerminal }).code,
    'fencing_token_missing'
  );
  assert.equal(fencing.verify({ taskId: 'task_active', token: active }).ok, true);
});
