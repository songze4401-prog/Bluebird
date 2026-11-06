/* global require, process, __dirname */
/**
 * P5-B 第 2 轮：工具与 Worker 两个维度的熔断**真的阻断**（Notion §26，台账 B-07）。
 *
 * 第 1 轮只有判定与状态，阻断只接在 Provider 上；本轮把工具网关与路由选择也接上，
 * 因此这里全部走生产入口：`agent-runtime.executeToolCall` 与 `router.decideWithConfig`，
 * 不自己模拟判定逻辑。
 *
 * 覆盖：
 *  a) 三个域的错误码分类与"未归类码"的默认方向（model 保守当故障，tool/worker 保守不踢人）；
 *  b) 工具连续故障后不再执行 handler，且不写去重缓存、确定性拒绝不进故障计数；
 *  c) 半开探测成功后恢复执行；
 *  d) 熔断中的 Agent 被路由拒绝并给出独立码与 503；确定性故障不拒绝；熔断状态文件损坏时按"无熔断"处理；
 *  e) 观测出口能同时看见 tool:/worker: 两个域的目标，且状态跨"重启"读回一致。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5b2-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
// 注册表在缺少模型密钥时把 Agent 标成 degraded（model_not_available），
// 那会让路由在熔断判定之前就先用 agent_not_available 拒绝，测不到本体的码。
// 这里只需要"能选中"，因此给一个假密钥；本文件一次真实上游调用都不发。
process.env.DEEPSEEK_API_KEY = 'sk-circuit-test-key-0123456789';
process.env.BLUEBIRD_MONITORING = '0';

const agentRuntime = require('../server/agent-runtime');
const breaker = require('../server/agents/circuit-breaker');
const storm = require('../server/agents/storm-suppression');
const router = require('../server/agents/router');
const registry = require('../server/agents/registry');
const runtime = require('../server/agents/runtime');

const BREAKER_FILE = breaker.BREAKER_FILE;
const T0 = Date.UTC(2026, 10, 7, 6, 0, 0);

function resetBreaker() {
  breaker.resetForTests(BREAKER_FILE);
}

function freshContext() {
  return { sessionId: 'default', cache: new Map() };
}

function registerFlakyTool(name, mode) {
  agentRuntime.registerTool({
    name,
    description: '熔断验收工具',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    timeoutMs: 500,
    validate: args => (args && typeof args.q === 'string'
      ? { ok: true, args: { q: args.q } }
      : { ok: false, error: 'bad' }),
    handler: async () => mode(),
  });
}

test('a. 三个错误码域的分类与未归类码的默认方向', () => {
  assert.equal(breaker.DOMAIN_BY_KIND.provider, 'model');
  assert.equal(breaker.DOMAIN_BY_KIND.tool, 'tool');
  assert.equal(breaker.DOMAIN_BY_KIND.worker, 'worker');

  for (const code of breaker.TOOL_TRANSIENT_KINDS) {
    assert.equal(breaker.classifyOutcome({ ok: false, errorCode: code, domain: 'tool' }), 'transient');
  }
  for (const code of breaker.TOOL_DETERMINISTIC_KINDS) {
    assert.equal(breaker.classifyOutcome({ ok: false, errorCode: code, domain: 'tool' }), 'deterministic');
  }
  // 工具网关与副作用账本实际会发出的拒绝码，全部归在确定性里，不许漏。
  for (const code of ['confirmation_required', 'failopen_scope_incomplete', 'invalid_params', 'unknown_tool', 'unauthorized_write', 'policy_tool_denied', 'side_effect_unknown', 'side_effect_args_invalid', 'side_effect_ledger_unavailable', 'ledger_write_failed']) {
    assert.ok(breaker.TOOL_DETERMINISTIC_KINDS.includes(code), `工具拒绝码 ${code} 未归类，会被当成健康度故障`);
  }

  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'model_timeout', domain: 'worker' }), 'transient');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'dependency_failed', domain: 'worker' }), 'transient');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'not_authorized', domain: 'worker' }), 'deterministic');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'budget_exceeded', domain: 'worker' }), 'deterministic');

  // 默认方向刻意不同：model 域码空间封闭，漏判即失效；tool/worker 码空间开放，
  // 误判成故障会把健康对象踢出可用集。
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'brand_new', domain: 'model' }), 'transient');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'brand_new', domain: 'tool' }), 'deterministic');
  assert.equal(breaker.classifyOutcome({ ok: false, errorCode: 'brand_new', domain: 'worker' }), 'deterministic');
  assert.equal(breaker.DOMAIN_POLICIES.model.unknown, 'transient');
  assert.equal(breaker.DOMAIN_POLICIES.tool.unknown, 'deterministic');

  assert.throws(() => breaker.classifyOutcome({ ok: false, errorCode: 'x', domain: 'gateway' }), /未知熔断域/);
  resetBreaker();
  // record 不写 domain 时按 kind 推导，调用方不需要（也不该）重复声明。
  const recorded = breaker.record({ kind: 'tool', targetId: 'probe_tool', ok: false, errorCode: 'invalid_params' });
  assert.equal(recorded.domain, 'tool');
  assert.equal(recorded.outcome, 'deterministic');
  const workerRecord = breaker.record({ kind: 'worker', targetId: 'memory', ok: false, errorCode: 'model_timeout' });
  assert.equal(workerRecord.domain, 'worker');
  assert.equal(workerRecord.outcome, 'transient');
});

test('b. 工具网关：连续故障后 handler 一次都不再执行，且不写去重缓存', async () => {
  resetBreaker();
  let executions = 0;
  registerFlakyTool('circuit_flaky', async () => {
    executions += 1;
    return { ok: false, code: 'tool_error', error: '工具内部错误' };
  });
  const ctx = freshContext();
  const policy = breaker.effectivePolicy();

  for (let index = 0; index < policy.minSamples; index += 1) {
    const result = await agentRuntime.executeToolCall('circuit_flaky', { q: `x${index}` }, ctx);
    assert.equal(result.code, 'tool_error');
  }
  assert.equal(executions, policy.minSamples);
  assert.equal(breaker.snapshot().targets[0].state, 'open');

  const blocked = await agentRuntime.executeToolCall('circuit_flaky', { q: 'blocked' }, freshContext());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'tool_circuit_open');
  assert.equal(blocked.error, '该工具近期连续故障，已暂时熔断，请稍后重试');
  assert.ok(Number.isFinite(blocked.retryAfterMs) && blocked.retryAfterMs >= 0);
  assert.equal(blocked.breakerPolicyVersion, breaker.BREAKER_POLICY_VERSION);
  assert.equal(executions, policy.minSamples, '开闸期间 handler 调用数不得再增长');

  // 被挡的结果不进本轮去重缓存：缓存它会让同一请求后续连"恢复了没有"都不再问。
  const reuseCache = freshContext();
  const other = await agentRuntime.executeToolCall('circuit_flaky', { q: 'same' }, reuseCache);
  assert.equal(other.code, 'tool_circuit_open');
  assert.equal(reuseCache.cache.size, 0, '熔断拒绝不得写进去重缓存');

  // 确定性拒绝根本不进熔断计数：参数错与权限错不是工具健康度问题。
  const samplesBefore = breaker.snapshot().targets[0].samples;
  for (let index = 0; index < 15; index += 1) {
    const rejected = await agentRuntime.executeToolCall('circuit_flaky', null, freshContext());
    assert.equal(rejected.code, 'invalid_params');
  }
  const afterDeterministic = breaker.snapshot().targets[0];
  assert.equal(afterDeterministic.samples, samplesBefore, '参数校验被拒不得进故障率分母');
  assert.equal(afterDeterministic.state, 'open', '也不得因为"没有新故障"而合闸');

  agentRuntime.unregisterTool('circuit_flaky');
});

test('c. 工具恢复：开闸到期后探测成功两次即合闸并恢复执行', async () => {
  resetBreaker();
  const originalOpenMs = process.env.BLUEBIRD_BREAKER_OPEN_MS;
  // 500 是阈值表允许的最小开闸时长（env 越界即夹位），所以这里等到 700ms 再探测。
  process.env.BLUEBIRD_BREAKER_OPEN_MS = '5';
  let executions = 0;
  let failing = true;
  registerFlakyTool('circuit_recover', async () => {
    executions += 1;
    if (failing) return { ok: false, code: 'tool_error', error: '工具内部错误' };
    return { ok: true, summary: '恢复' };
  });
  const policy = breaker.effectivePolicy();
  assert.equal(policy.openMs, 500, 'env 越界必须夹到最小开闸时长，且在判定里生效');

  for (let index = 0; index < policy.minSamples; index += 1) {
    await agentRuntime.executeToolCall('circuit_recover', { q: `x${index}` }, freshContext());
  }
  assert.equal(breaker.snapshot().targets[0].state, 'open');

  await new Promise(resolve => setTimeout(resolve, 700));
  failing = false;
  const firstProbe = await agentRuntime.executeToolCall('circuit_recover', { q: 'p1' }, freshContext());
  assert.equal(firstProbe.ok, true, '到期后第一发探测要真的打出去');
  assert.equal(breaker.snapshot().targets[0].state, 'half_open');
  const secondProbe = await agentRuntime.executeToolCall('circuit_recover', { q: 'p2' }, freshContext());
  assert.equal(secondProbe.ok, true);

  const closed = breaker.snapshot().targets[0];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.samples, 0, '合闸即清空故障窗口，不带旧账继续判');
  assert.equal(closed.lastChangeReason, 'probe_success');

  failing = true;
  const recovered = await agentRuntime.executeToolCall('circuit_recover', { q: 'after' }, freshContext());
  assert.equal(recovered.code, 'tool_error', '合闸后恢复执行真实 handler');
  assert.equal(executions, policy.minSamples + 3);

  if (originalOpenMs === undefined) delete process.env.BLUEBIRD_BREAKER_OPEN_MS;
  else process.env.BLUEBIRD_BREAKER_OPEN_MS = originalOpenMs;
  agentRuntime.unregisterTool('circuit_recover');
});

test('d. 路由：熔断中的 Agent 被拒绝并给出独立码，确定性故障与状态损坏都不踢人', () => {
  resetBreaker();
  // 注册表在未配置真实模型服务商时把 Agent 一律标成 degraded（model_not_configured），
  // 那会让路由在熔断判定之前先用 agent_not_available 拒绝。这里要测的是熔断这一层，
  // 所以取真实 Agent 描述、只把"可用状态"改回来（契约、能力、工具白名单都用真实的），
  // 其余（配置读取、负载快照、熔断状态读取）全部走生产实现。
  const realMemory = registry.listAgents().find(agent => agent.botId === 'memory');
  assert.ok(realMemory, '验收前提：注册表里有 memory Agent');
  const enabledAgents = [{ ...realMemory, status: 'enabled', statusReason: null }];
  const liveRouter = router.createRouter({ getAgents: () => enabledAgents });
  const request = { agentId: 'memory', taskType: 'memory.search', goal: '查咖啡' };

  const plain = liveRouter.decide(request, {});
  assert.equal(plain.ok, true, '未熔断时应正常选中');
  assert.equal(plain.selectedAgentId, 'memory');

  // 瞬态故障堆到阈值 → 路由必须拒绝，且用独立码而不是复用"队列满/并发满"。
  const policy = breaker.effectivePolicy();
  for (let index = 0; index < policy.minSamples; index += 1) {
    breaker.record({ kind: 'worker', targetId: 'memory', ok: false, errorCode: 'model_timeout' });
  }
  const viaLive = liveRouter.decide(request, {});
  assert.equal(viaLive.ok, false, '生产入口自己读熔断状态，不需要调用方传');
  assert.equal(viaLive.code, 'agent_circuit_open');
  assert.equal(viaLive.status, 503);
  assert.equal(viaLive.message, '该 Agent 近期连续失败，已暂时熔断，请稍后重试');
  const circuitRow = viaLive.rejected.find(item => item.agentId === 'memory');
  assert.equal(circuitRow.circuitReason, 'circuit_open');
  assert.ok(circuitRow.retryAfterMs >= 0);
  assert.equal(circuitRow.reason, undefined, '熔断细节不占用 reason，避免给用户拼出无信息的一句');

  // 单元层同样可以只靠传入的负载快照判定（decide 保持纯函数）。
  const pure = router.decide(request, {
    agents: enabledAgents,
    routingConfig: require('../server/agents/routing-config').getRoutingConfig().config,
    load: { queuedTotal: 0, runningByAgent: {}, circuitByAgent: { memory: { allowed: false, reason: 'circuit_open', retryAfterMs: 1200 } } },
  });
  assert.equal(pure.code, 'agent_circuit_open');
  const pureAgain = router.decide(request, {
    agents: enabledAgents,
    routingConfig: require('../server/agents/routing-config').getRoutingConfig().config,
    load: { queuedTotal: 0, runningByAgent: {}, circuitByAgent: { memory: { allowed: false, reason: 'circuit_open', retryAfterMs: 1200 } } },
  });
  assert.equal(pure.code, pureAgain.code);
  assert.equal(pure.selectedAgentId, pureAgain.selectedAgentId);

  // 确定性故障（权限/预算/取消）堆满也不许把 Agent 踢出可用集。
  resetBreaker();
  for (let index = 0; index < policy.minSamples * 2; index += 1) {
    breaker.record({ kind: 'worker', targetId: 'memory', ok: false, errorCode: 'not_authorized' });
  }
  const stillRoutable = liveRouter.decide(request, {});
  assert.equal(stillRoutable.ok, true);
  assert.equal(stillRoutable.selectedAgentId, 'memory');
  const deterministicView = breaker.snapshot().targets.find(item => item.targetKey === 'worker:memory');
  assert.equal(deterministicView.state, 'closed');
  assert.equal(deterministicView.samples, 0);

  // 状态文件坏掉时按"无熔断"处理：观测故障不升级成可用性故障。
  resetBreaker();
  for (let index = 0; index < policy.minSamples; index += 1) {
    breaker.record({ kind: 'worker', targetId: 'memory', ok: false, errorCode: 'model_timeout' });
  }
  assert.equal(liveRouter.decide(request, {}).ok, false);
  fs.writeFileSync(BREAKER_FILE, '{ this is not json', 'utf8');
  const recovered = liveRouter.decide(request, {});
  assert.equal(recovered.ok, true, '熔断状态不可读时不得全量拒绝路由');
  assert.throws(() => breaker.load(), /熔断状态不可读/);

  // 写入侧仍然显式抛错：坏状态被吞在读取侧，不能也吞在记账侧。
  assert.throws(() => breaker.record({ kind: 'worker', targetId: 'memory', ok: true }), /熔断状态不可读/);
  resetBreaker();
});

test('e. 观测出口：tool 与 worker 两个域都能在快照里看见，且状态跨重启读回一致', async () => {
  resetBreaker();
  registerFlakyTool('circuit_observe', async () => ({ ok: false, code: 'tool_timeout', error: '超时' }));
  for (let index = 0; index < 10; index += 1) {
    await agentRuntime.executeToolCall('circuit_observe', { q: `x${index}` }, freshContext());
  }
  agentRuntime.unregisterTool('circuit_observe');
  breaker.record({ kind: 'worker', targetId: 'executor', ok: false, errorCode: 'dependency_failed' });

  const snapshot = runtime.limitsSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.policy.policyVersion, 'p5b-throttle-v1');
  assert.equal(snapshot.breaker.policyVersion, 'p5b-breaker-v1');
  assert.equal(snapshot.storm.policyVersion, 'p5b-storm-v1');
  const toolRow = snapshot.breaker.targets.find(item => item.targetKey === 'tool:circuit_observe');
  assert.equal(toolRow.state, 'open');
  assert.equal(toolRow.samples, 10);
  assert.equal(toolRow.lastTransientCode, 'tool_timeout');
  assert.ok(snapshot.breaker.openTargets.includes('tool:circuit_observe'));
  const workerRow = snapshot.breaker.targets.find(item => item.targetKey === 'worker:executor');
  assert.equal(workerRow.state, 'closed', '单次依赖失败不足以开闸');
  assert.equal(workerRow.samples, 1);

  // 跨"重启"：模块无缓存，读盘即事实来源，开闸状态必须还在。
  const reread = breaker.load();
  assert.equal(reread.targets['tool:circuit_observe'].state, 'open');
  assert.equal(reread.policyVersion, breaker.BREAKER_POLICY_VERSION);
  const queued = runtime.getQueueStats({ limits: true });
  assert.equal(queued.limits.available, true);
  assert.equal(runtime.getQueueStats().limits, undefined, '默认轮询不读三个状态文件');
});

test('f. 审计真的落账：风暴拒绝事件在白名单里，payload 键不被隐私过滤静默丢掉', () => {
  const tasks = require('../server/agents/tasks');
  storm.resetForTests(path.join(TMP, 'agents', 'replan-storm.json'));
  const task = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: '风暴审计落账验证' });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });

  const attempt = at => runtime.admitRetryAttempt({
    task: tasks.getTask(task.taskId),
    runId: 'run-1',
    errorCode: 'model_timeout',
    now: T0 + at,
  });
  assert.equal(attempt(0).allowed, true);
  assert.equal(attempt(1).allowed, true);
  const denied = attempt(2);
  assert.equal(denied.rule, 'replan_limit_reached');

  runtime.recordStormDenial({
    task: tasks.getTask(task.taskId),
    runId: 'run-1',
    errorCode: 'model_timeout',
    disposition: { status: 'failed' },
    stormGate: denied,
  });

  const events = tasks.listEvents('memory', { limit: 100 });
  const row = events.find(item => item.eventType === 'replan.storm_denied');
  assert.ok(row, '风暴拒绝必须留下可查事件，不能只 console.warn');
  assert.equal(row.taskId, task.taskId);
  assert.equal(row.payload.rule, 'replan_limit_reached');
  assert.equal(row.payload.rulesHit, 'replan_limit_reached');
  assert.equal(typeof row.payload.rulesHit, 'string', '列表类字段必须拼成字符串，否则被 safePayload 丢弃');
  assert.equal(row.payload.replanCount, 2);
  assert.equal(row.payload.status, 'failed');
  assert.equal(row.payload.errorCode, 'model_timeout');
  assert.equal(row.payload.policyVersion, storm.STORM_POLICY_VERSION);
  assert.ok(!JSON.stringify(row.payload).includes('风暴审计落账验证'), '事件不得携带 goal 正文');

  // 判定与落账不改写任务：终态仍由既有失败分支负责。
  assert.equal(tasks.getTask(task.taskId).status, 'running');
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
