/**
 * P5-E / A-06 / §13：七因子风险路由回归。
 *
 * 口径：
 *  a) 七因子取最高适用等级；缺信息升一级；全未知（连任务类型都没有）按 R3 收口；
 *  b) Agent 不得自行降级：claimedLevel 只记录、只对比，永不参与计算；
 *  c) 等级 → 最低验证组合矩阵固定；R2/R3 的独立审校门槛不接受成本/延迟理由下调，
 *     确定性校验是任何等级都关不掉的绝对下限；
 *  d) autonomy-policy.verificationStrength 升级为七因子路由后，既有输出契约
 *    （高风险审校 / 证据弱审批 / 低风险不动）必须原样保持；
 *  e) 真实 runTask：R3 任务 risk.assessed 留审计、requiresReview 只升不降、
 *     独立审校不可用时转人工（waiting_approval + 审批记录）；
 *  f) 漏检率独立成行：与检出率互为补数，无分母一律 null + caveat。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-risk-policy-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '80';

const agent = require('../server/agent-runtime');
const riskPolicy = require('../server/agents/risk-policy');
const autonomyPolicy = require('../server/agents/autonomy-policy');
const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const approvals = require('../server/agents/approvals');
const evalIndicators = require('../server/agents/eval-indicators');
const manifestRegistry = require('../server/agents/manifest');

const AGENTS_DIR = path.join(TMP, 'agents');
let seq = 0;

const config = require('../server/agents/config');

function resetAll() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  manifestRegistry.setTestManifests({});
  // 配置缓存按 manifests 播种：清单变了必须清缓存，否则后注册的测试 bot 拿不到条目。
  config.reloadForTests();
}

function eventsOf(taskId, type) {
  const file = path.join(AGENTS_DIR, 'agent-events.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed.events) ? parsed.events : [];
  return list.filter(event => event.taskId === taskId && (!type || event.eventType === type));
}

async function waitForStatus(taskId, statuses, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < deadline) {
    task = tasks.getTask(taskId);
    if (task && (statuses.includes(task.status) || tasks.isTerminalStatus(task.status))) {
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return task;
}

// ---- 真实模型桩 ----
let providerServer = null;

async function setupProvider(botId = 'memory') {
  if (providerServer) providerServer.close();
  providerServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-p5e',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'p5e-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'P5-E 任务回复正文' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${providerServer.address().port}/v1`;
  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: `P5E Test Provider ${botId} ${Date.now()}`,
    baseUrl: base,
    apiKey: 'global-not-used',
    models: [{ id: 'p5e-test-model', name: 'P5E Test Model', capabilities: { tools: true } }],
  });
  assert.ok(added.provider, JSON.stringify(added));
  config.updateConfig(botId, {
    enabled: true,
    modelProfile: {
      providerId: added.provider.id,
      modelId: 'p5e-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId,
    providerId: added.provider.id,
    apiKey: 'p5e-bot-key',
  });
  config.setCredentialId(botId, credential.credentialId);
}

test.after(() => {
  agent.unregisterTool('p5e_danger');
  if (providerServer) providerServer.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

// ---- a/b/c. 纯函数引擎 ----

test('P5-E 七因子：取最高适用等级，缺信息升一级，全未知 R3，各因子映射正确', () => {
  // 各因子单独顶到各自的档；失败代价单独最高只到 R2（本仓库裁决）。
  const byReversibility = riskPolicy.assessRisk({
    taskType: 'x', toolRisks: ['read'], reversibility: 'irreversible',
  });
  assert.equal(byReversibility.factors.reversibility.level, 3);
  const byBlast = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], blastRadius: 'global' });
  assert.equal(byBlast.factors.blast_radius.level, 3);
  const bySensitivity = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], dataSensitivity: 'secret' });
  assert.equal(bySensitivity.factors.data_sensitivity.level, 3);
  const byExternal = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], externalSideEffects: true });
  assert.equal(byExternal.factors.external_side_effects.level, 3);
  const byCost = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], failureCost: 'high' });
  assert.equal(byCost.factors.failure_cost.level, 2, '失败代价映射到 2 档，映射本身不产生 R3');
  assert.equal(byCost.level, 'R3', '其余因子缺信息 → 按通用规则整体升一级到 R3');

  // 取最高：只读工具 + 不可逆 → R3。
  const combined = riskPolicy.assessRisk({
    taskType: 'x', toolRisks: ['read'], reversibility: 'irreversible',
  });
  assert.equal(combined.level, 'R3');
  assert.equal(combined.escalated, true, '其余因子缺失仍按规则升级（封顶 R3）');

  // 缺信息升一级：只读任务（known 0）+ 其余未知 → R1。
  const sparse = riskPolicy.assessRisk({ taskType: 'memory.recall', toolRisks: ['read'] });
  assert.equal(sparse.level, 'R1');
  assert.equal(sparse.escalated, true);
  assert.ok(sparse.missingFactors.length >= 1);

  // 全未知（连任务类型都没有）→ R3 fail-closed。
  const blind = riskPolicy.assessRisk({});
  assert.equal(blind.level, 'R3');
  assert.equal(blind.nothingKnown, true);

  // 未知工具标签 → 风险因子 missing（走升一级），不猜成只读；有任务类型
  // 就不是「全未知」，按低风险基线 + 升一级处理，而不是 R3。
  const unknownTool = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['mystery_risk'] });
  assert.equal(unknownTool.factors.inherent_risk.missing, true);
  assert.equal(unknownTool.escalated, true);
  assert.equal(unknownTool.level, 'R1');
  assert.equal(unknownTool.nothingKnown, false);
});

test('P5-E 来源污点：只有全部 verified 才算已知干净，混入未验证即缺信息升级', () => {
  const clean = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], taintLabels: ['verified'] });
  assert.equal(clean.factors.source_taint.level, 0);
  assert.equal(clean.factors.source_taint.missing, false);
  const mixed = riskPolicy.assessRisk({
    taskType: 'x', toolRisks: ['read'], taintLabels: ['verified', 'unverified'],
  });
  assert.equal(mixed.factors.source_taint.missing, true);
  const unlabeled = riskPolicy.assessRisk({ taskType: 'x', toolRisks: ['read'], taintLabels: ['unknown'] });
  assert.equal(unlabeled.factors.source_taint.missing, true);
});

test('P5-E 不得自行降级：claimedLevel 只记录只对比，永不参与计算', () => {
  const assessed = riskPolicy.assessRisk({
    taskType: 'x', toolRisks: ['read'], externalSideEffects: true,
    claimedLevel: 'R0',
  });
  assert.equal(assessed.level, 'R3', '自称 R0 不能把外部副作用任务降到 R0');
  assert.equal(assessed.claimedLevel, 'R0');
  assert.equal(assessed.claimedLevelRejected, true);
  const honest = riskPolicy.assessRisk({
    taskType: 'x', toolRisks: ['read'], claimedLevel: 'R2',
  });
  assert.equal(honest.claimedLevelRejected, false, '虚报更高等级不惩罚也不采纳');
});

test('P5-E 矩阵与下限：R2/R3 拒绝成本/延迟降级，deterministic 是绝对下限', () => {
  // 矩阵内容固定。
  assert.deepEqual(riskPolicy.minimumVerification('R0'), {
    level: 'R0', deterministic: true, evidenceChecked: false, independentReview: false, approvalOnWeakEvidence: false,
  });
  assert.deepEqual(riskPolicy.minimumVerification('R1'), {
    level: 'R1', deterministic: true, evidenceChecked: true, independentReview: false, approvalOnWeakEvidence: false,
  });
  assert.deepEqual(riskPolicy.minimumVerification('R3'), {
    level: 'R3', deterministic: true, evidenceChecked: true, independentReview: true, approvalOnWeakEvidence: true,
  });

  // R3：请求去掉独立审校，即使 citing 成本与延迟压力也拒绝。
  const r3 = riskPolicy.enforceVerificationFloor({
    level: 'R3',
    requested: { deterministic: true, evidenceChecked: true, independentReview: false },
    costPressure: true,
    latencyPressure: true,
  });
  assert.equal(r3.allowed, false);
  assert.equal(r3.reason, 'r2_r3_floor_not_downgradable_by_cost_or_latency');
  assert.equal(r3.verification.independentReview, true, '拒绝时返回的是下限组合');

  // R2 同样拒绝。
  const r2 = riskPolicy.enforceVerificationFloor({
    level: 'R2', requested: { deterministic: true, independentReview: false }, costPressure: true,
  });
  assert.equal(r2.allowed, false);

  // 任何等级都关不掉确定性校验。
  const det = riskPolicy.enforceVerificationFloor({
    level: 'R0', requested: { deterministic: false },
  });
  assert.equal(det.allowed, false);
  assert.equal(det.reason, 'deterministic_floor_mandatory');

  // R1 请求加强（evidenceChecked）允许。
  const r1up = riskPolicy.enforceVerificationFloor({
    level: 'R1', requested: { deterministic: true, evidenceChecked: true },
  });
  assert.equal(r1up.allowed, true);
});

test('P5-E autonomy-policy.verificationStrength：七因子路由保持既有输出契约', () => {
  // 高风险任务类型 → R3 → 审校；证据强不审批。
  const high = autonomyPolicy.verificationStrength({ taskType: 'action.execute' });
  assert.equal(high.requiresReview, true);
  assert.equal(high.requiresApproval, false);
  assert.equal(high.level, 'R3');
  assert.ok(high.assessment && high.assessment.policyVersion, '输出必须带七因子评估');
  assert.equal(high.verification.independentReview, true);
  // 证据弱 → R3 的审批位触发。
  const weak = autonomyPolicy.verificationStrength({ taskType: 'action.execute', evidenceStrength: 'weak' });
  assert.equal(weak.requiresApproval, true);
  // 低风险任务类型 → R1 → 不审校（与既有行为一致）。
  const low = autonomyPolicy.verificationStrength({ taskType: 'memory.recall' });
  assert.equal(low.requiresReview, false);
  assert.equal(low.level, 'R1', '缺信息升一级后的最低档');
  // 污点未验证 + 可逆写工具 → R2 → 审校。
  const tainted = autonomyPolicy.verificationStrength({
    taskType: 'memory.explain',
    toolRisks: ['reversible_write'],
    taintLabels: ['unverified'],
  });
  assert.equal(tainted.level, 'R2');
  assert.equal(tainted.requiresReview, true);
});

// ---- e/f. 真实 runTask 链路 ----

test('P5-E 真实链路：低风险任务 risk.assessed 留审计、不抬审校、正常完成', async () => {
  resetAll();
  await setupProvider('memory');
  seq += 1;
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `P5-E 低风险 ${seq}`,
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
  });
  runtime.startTask(task.taskId);
  const finished = await waitForStatus(task.taskId, ['completed']);
  assert.ok(finished, JSON.stringify(finished && finished.errorCode));
  assert.equal(finished.status, 'completed');
  assert.equal(finished.requiresReview, false, '低风险不得抬审校');
  const assessed = eventsOf(task.taskId, 'risk.assessed');
  assert.equal(assessed.length, 1, '每次运行恰好一条风险评估审计');
  assert.equal(assessed[0].payload.level, 'R1');
  assert.equal(assessed[0].payload.requiresReviewRaised, false);
});

test('P5-E 真实链路：高风险工具任务评估为 R3 → 只升不降打开审校 → 独立审校不可用时转人工', async () => {
  resetAll();
  // 测试清单必须先注册：config.updateConfig / createTask 都按 manifest 注册表校验 botId。
  manifestRegistry.setTestManifests({
    riskbot: {
      botId: 'riskbot',
      displayName: 'Risk Bot',
      description: 'P5-E 七因子测试用高风险 bot',
      capabilities: ['risk.execute'],
      acceptedTaskTypes: ['risk.execute'],
      taskContracts: {},
      entrypoints: ['direct_chat', 'delegated_task'],
      toolAllowlist: ['p5e_danger'],
      permissionProfileId: 'risk-test',
      concurrencyLimit: 2,
      defaultTimeoutMs: 60000,
      minTimeoutMs: 5000,
      maxTimeoutMs: 120000,
      routingPriority: 80,
      systemPrompt: '你是 P5-E 测试用高风险 Bot。',
    },
  });
  await setupProvider('riskbot');
  // 注册一个 high_risk 工具并挂到自定义 bot 的白名单上（memory bot 的白名单不可变）。
  agent.registerTool({
    name: 'p5e_danger',
    description: 'P5-E 测试高风险工具',
    parameters: { type: 'object', properties: {}, required: [] },
    readOnly: false,
    risk: 'high_risk',
    timeoutMs: 2000,
    validate: args => ({ ok: true, args: args || {} }),
    handler: async () => ({ ok: true, summary: 'dangerous' }),
  });
  try {
    seq += 1;
    const task = tasks.createTask({
      botId: 'riskbot',
      taskType: 'risk.execute',
      goal: `P5-E 高风险 ${seq}`,
      allowedTools: ['p5e_danger'],
      deadlineMs: 20000,
    });
    runtime.startTask(task.taskId);
    const escalated = await waitForStatus(task.taskId, ['waiting_approval']);
    assert.ok(escalated, JSON.stringify(escalated && escalated.errorCode));
    assert.equal(escalated.status, 'waiting_approval', 'R3 审校不可用必须转人工，不得静默通过');
    const raw = tasks.getRawTask(task.taskId);
    assert.equal(raw.requiresReview, true, 'R3 必须只升不降地打开独立审校');
    const assessed = eventsOf(task.taskId, 'risk.assessed');
    assert.equal(assessed.length, 1);
    assert.equal(assessed[0].payload.level, 'R3');
    assert.equal(assessed[0].payload.requiresReviewRaised, true);
    const approval = approvals
      .listApprovals('riskbot', { limit: 50 })
      .find(item => item.taskId === task.taskId);
    assert.ok(approval, '必须留下人工审批记录');
  } finally {
    manifestRegistry.setTestManifests({});
  }
});

// ---- g. 漏检率独立成行 ----

test('P5-E 漏检率：与检出率互为补数，无分母一律 null + caveat', () => {
  const events = [
    { eventType: 'verification.verdict', taskId: 't1', payload: { deterministicOk: false, verdict: 'fail' } },
    { eventType: 'verification.verdict', taskId: 't2', payload: { deterministicOk: false, verdict: 'pass' } },
  ];
  const detection = evalIndicators.reviewerDetection({ events });
  assert.equal(detection.detection.value, 0.5, '检出 1/2');
  assert.equal(detection.missRate.value, 0.5, '漏检 1/2');
  assert.equal(
    detection.detection.value + detection.missRate.value, 1, '互为补数'
  );
  assert.equal(detection.missRate.name, 'reviewer_miss_rate');
  // 无分母：null + caveat，绝不回落 0。
  const empty = evalIndicators.reviewerDetection({ events: [] });
  assert.equal(empty.missRate.known, false);
  assert.equal(empty.missRate.value, null);
  assert.ok(empty.missRate.caveat && empty.missRate.caveat.length > 4);
  // 名单与版本：v2 起漏检率在册。
  assert.ok(evalIndicators.INDICATOR_NAMES.includes('reviewer_miss_rate'));
  assert.equal(evalIndicators.computeAll({ events: [] }).policyVersion, 'p7-indicators-v2');
});
