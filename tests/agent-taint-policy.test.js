/* global require, process */
/**
 * §16 污点传播与工具阻断策略端到端回归（用例 f–j）。
 *
 * 口径（真跑 artifact-store / 任务存储 / Worker Scope / 真实 Gateway，不 mock 存储与校验）：
 *  f) 跨 Agent 读取：A 写带 external:web 的共享产物，B 读取后来源引用自动进入 B 的来源链，
 *     B 的派生产物 taint 含 external:web；
 *  g) 污点阻断：带 external:web 的任务请求副作用工具被 Gateway 拒绝（短码 + 规则 id +
 *     策略版本进审计），同一任务请求只读工具放行（证明是收窄不是全禁）；
 *  h) 收窄不扩张：上游高 trustLevel + 污点，不带来任何额外工具权限（正交性）；
 *  j) 断裂读：引用不可解析 → 任务 taint 加 unknown，不误判为干净；
 *  i) 策略版本：改策略产生新版本记录，旧产物保留原 policyVersion，未命中规则 fail-closed。
 *
 * 标签取值、"何种污点禁止何种工具"是**本仓库裁决的安全默认值**，不是 Notion 原文标准；
 * 见台账"待确认"与 taint-policy.js 头注释。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-taint-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const tasks = require('../server/agents/tasks');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const sessions = require('../server/agents/sessions');
const workerScope = require('../server/agents/worker-scope');
const taintPolicy = require('../server/agents/taint-policy');
const toolGateway = require('../server/agents/tool-gateway');
const runtime = require('../server/agents/runtime');

const BOT = 'memory';
const UPSTREAM_BOT = 'researcher';

let providerServer;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function taskGoal(messages) {
  const match = lastUserText(messages).match(/目标：(.+)/);
  return match ? match[1].trim() : '';
}

function toolResultCount(messages) {
  return messages.filter(message => message && message.role === 'tool').length;
}

function completion(content, { toolCalls = null } = {}) {
  const message = toolCalls
    ? { role: 'assistant', content: null, tool_calls: toolCalls }
    : { role: 'assistant', content };
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'taint-test-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  };
}

test.before(async () => {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { data: [{ id: 'taint-test-model' }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const messages = parsed.messages || [];
      const goal = taskGoal(messages);
      const toolResults = toolResultCount(messages);
      // 用例 g：第 1 回合请求副作用工具（应被拒），第 2 回合请求只读工具（应放行），
      // 第 3 回合收敛成文本。
      if (goal.includes('TAINT-G')) {
        if (toolResults === 0) {
          json(
            res,
            200,
            completion(null, {
              toolCalls: [toolCall('call_g_write', 'memory_remember', { text: '不应写入的污点内容' })],
            })
          );
          return;
        }
        if (toolResults === 1) {
          json(
            res,
            200,
            completion(null, {
              toolCalls: [toolCall('call_g_read', 'memory_search', { query: '污点' })],
            })
          );
          return;
        }
      }
      // 用例 h：高 trustLevel + 污点，一律请求副作用工具。
      if (goal.includes('TAINT-H1') || goal.includes('TAINT-H2')) {
        if (toolResults === 0) {
          json(
            res,
            200,
            completion(null, {
              toolCalls: [toolCall('call_h_write', 'memory_remember', { text: '不应写入' })],
            })
          );
          return;
        }
      }
      json(res, 200, completion(`已处理：${goal}`));
    });
  });
  // 本地 stub 默认 keepAliveTimeout（5s）掐掉的空闲连接会被 SDK（maxRetries:0）
  // 复用后连接失败——抬高服务端空闲超时，杜绝这条竞态（同 memory-bot）。
  providerServer.keepAliveTimeout = 30000;
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: 'Taint Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'taint-test-model',
        name: 'Taint Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, JSON.stringify(added));
  const providerId = added.provider.id;
  for (const botId of [BOT, UPSTREAM_BOT]) {
    config.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: 'taint-test-model',
        temperature: 0.2,
        maxTokens: 256,
        timeoutMs: 20000,
      },
    });
    const credential = credentials.putCredential({
      botId,
      providerId,
      apiKey: 'worker-bot-key',
    });
    config.setCredentialId(botId, credential.credentialId);
  }
});

test.after(async () => {
  if (providerServer) {
    if (typeof providerServer.closeAllConnections === 'function') {
      providerServer.closeAllConnections();
    }
    await new Promise(resolve => providerServer.close(resolve));
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

async function waitForTerminal(taskId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

function eventsOf(taskId, type) {
  const task = tasks.getRawTask(taskId);
  if (!task) return [];
  return tasks
    .listEvents(task.botId, { limit: 200 })
    .filter(event => event.taskId === taskId && event.eventType === type);
}

function evidenceLine(label, payload) {
  console.log(`[EVIDENCE] ${label} ${JSON.stringify(payload)}`);
}

function makeTask({ agentId = BOT, goal, allowedTools, ...extra }) {
  return tasks.createTask({
    agentId,
    // 上游跨 Agent 场景使用 researcher 接受的任务类型，消费方用 memory。
    taskType: agentId === UPSTREAM_BOT ? 'memory.recall' : 'memory.search',
    goal,
    allowedTools,
    deadlineMs: 30000,
    ...extra,
  });
}

function upstreamArtifact({ taskId, sourceLabels }) {
  return artifactStore.persist({
    kind: 'note',
    content: { text: `上游内容 ${sourceLabels.join(',')}` },
    taskId,
    sourceLabels,
  });
}

function refOf(artifact) {
  return { kind: artifact.kind, id: artifact.id, version: artifact.version };
}

// ---- f. 跨 Agent 读取继承来源引用与污点 ----

test('用例f：跨 Agent 读取自动追加来源引用，派生产物继承污点', () => {
  const taskA = makeTask({ agentId: UPSTREAM_BOT, goal: 'TAINT-F 上游任务', allowedTools: ['memory_search'] });
  const taskB = makeTask({ agentId: BOT, goal: 'TAINT-F 消费任务', allowedTools: ['memory_search'] });

  const upstream = upstreamArtifact({ taskId: taskA.taskId, sourceLabels: ['external:web'] });
  const ref = refOf(upstream);
  artifactStore.share(upstream.id, { withTaskIds: [taskB.taskId], byTaskId: taskA.taskId });

  const sessionB = sessions.createSession(BOT, { title: 'taint-f-consumer', scope: 'worker' });
  const scopeB = workerScope.openWorkerScope({
    botId: BOT,
    taskId: taskB.taskId,
    sessionId: sessionB.id,
    allowedTaskIds: [taskA.taskId],
  });

  assert.deepStrictEqual(tasks.getRawTask(taskB.taskId).provenanceRefs, []);
  scopeB.readSharedArtifact(upstream.id, { token: scopeB.token });

  // 读取即继承：B 的来源链自动出现 A 产物的 {kind,id,version}。
  assert.deepStrictEqual(tasks.getTask(taskB.taskId).provenanceRefs, [ref]);
  assert.ok(
    tasks.getRawTask(taskB.taskId).taintLabels.includes('external:web'),
    '读取后 B 的任务 taint 必须含 upstream 的 external:web'
  );
  const appended = eventsOf(taskB.taskId, 'task.provenance_appended');
  assert.ok(appended.length >= 1, '读继承必须留痕');
  assert.strictEqual(appended[0].payload.mode, 'worker.readSharedArtifact');

  // B 的派生产物继承上游污点并集。
  const derivedRefs = artifactCommit.persistTaskArtifacts({
    taskId: taskB.taskId,
    artifacts: [{ kind: 'summary', content: { text: 'B 基于共享产物的摘要' } }],
    provenanceRefs: tasks.getRawTask(taskB.taskId).provenanceRefs,
  });
  const derived = artifactStore.get(derivedRefs[0].id);
  assert.ok(derived.taintLabels.includes('external:web'), '派生产物必须继承 external:web');
  assert.ok(derived.taintLabels.includes('agent:derived'), '派生产物必须追加自身来源标签');
  // 只改任务记录，不改被读产物。
  assert.deepStrictEqual(artifactStore.get(upstream.id).provenanceRefs, []);

  evidenceLine('taint-f', {
    upstreamTaskId: taskA.taskId,
    consumerTaskId: taskB.taskId,
    sharedRef: ref,
    consumerProvenanceRefs: tasks.getTask(taskB.taskId).provenanceRefs,
    consumerTaintLabels: tasks.getRawTask(taskB.taskId).taintLabels,
    appendEvent: appended[0] && appended[0].payload,
    derivedArtifact: { id: derived.id, taintLabels: derived.taintLabels },
    upstreamUnchanged: artifactStore.get(upstream.id).provenanceRefs,
  });
});

// ---- j. 断裂读：引用不可解析 → unknown，不误判干净 ----

test('用例j：读取引用不可解析 → 任务 taint 加 unknown，不误判为干净', () => {
  const taskB = makeTask({ agentId: BOT, goal: 'TAINT-J 断裂读', allowedTools: ['memory_search'] });
  const sessionB = sessions.createSession(BOT, { title: 'taint-j-broken', scope: 'worker' });
  const scopeB = workerScope.openWorkerScope({
    botId: BOT,
    taskId: taskB.taskId,
    sessionId: sessionB.id,
  });

  const missingId = 'art_taint_missing_never_exists';
  let thrown;
  assert.throws(
    () => scopeB.projectSharedContext({ refs: [{ id: missingId, version: 1 }], token: scopeB.token }),
    error => {
      thrown = error;
      return error.code === 'artifact_not_found';
    },
    '不可解析引用必须拒绝投影'
  );

  const live = tasks.getRawTask(taskB.taskId);
  assert.ok(live.taintLabels.includes('unknown'), '断裂读必须把 unknown 记进任务 taint');
  assert.ok(
    live.provenanceRefs.some(ref => ref.id === missingId && ref.version === 1),
    '不可解析引用仍必须留痕（不静默丢弃）'
  );
  // 不误判干净：读边界不得返回空集合。
  assert.deepStrictEqual(
    artifactStore.readTaintLabels(live),
    live.taintLabels.slice().sort(),
    '任务 taint 必须可读且非空'
  );
  assert.ok(artifactStore.readTaintLabels(live).length > 0);
  const denied = eventsOf(taskB.taskId, 'worker.scope_denied');
  assert.ok(denied.length >= 1);

  evidenceLine('taint-j', {
    taskId: taskB.taskId,
    missingId,
    thrownCode: thrown && thrown.code,
    taskTaintLabels: live.taintLabels,
    taskProvenanceRefs: live.provenanceRefs,
    readTaintLabels: artifactStore.readTaintLabels(live),
    deniedEvent: denied[0] && denied[0].payload,
  });
});

// ---- g. 污点阻断与只读放行 ----

test('用例g：污点任务请求副作用工具被拒，只读工具放行', async () => {
  const task = makeTask({
    agentId: BOT,
    goal: 'TAINT-G 污点阻断',
    allowedTools: ['memory_remember', 'memory_search'],
    taintLabels: ['external:web'],
  });
  assert.ok(task.taintLabels.includes('external:web'));

  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  assert.strictEqual(finished.status, 'completed', '拒绝工具不应让任务崩溃');

  const denied = eventsOf(task.taskId, 'tool.denied');
  const writeDenied = denied.find(event => event.payload.tool === 'memory_remember');
  assert.ok(writeDenied, '副作用工具必须被 Gateway 拒绝');
  assert.strictEqual(writeDenied.payload.errorCode, 'taint_tool_denied');
  assert.strictEqual(writeDenied.payload.ruleId, 'untrusted-side-effect-deny');
  assert.strictEqual(writeDenied.payload.detail, 'untrusted-side-effect-deny');
  assert.strictEqual(writeDenied.payload.policyVersion, 'taint-policy-v1');

  // 同一任务只读工具必须真实执行（不是全禁）。
  const completed = eventsOf(task.taskId, 'tool.completed');
  assert.ok(
    completed.some(event => event.payload.tool === 'memory_search' && event.payload.ok === true),
    '只读工具 memory_search 必须被放行并完成'
  );
  assert.ok(
    !completed.some(event => event.payload.tool === 'memory_remember'),
    '副作用工具不得出现在完成事件'
  );

  // 每次判定都留审计：policyVersion + 规则 id。
  const decisions = eventsOf(task.taskId, 'tool.policy_decision');
  const writeDecision = decisions.find(event => event.payload.tool === 'memory_remember');
  const readDecision = decisions.find(event => event.payload.tool === 'memory_search');
  assert.strictEqual(writeDecision.payload.decision, 'deny');
  assert.strictEqual(writeDecision.payload.policyVersion, 'taint-policy-v1');
  assert.strictEqual(writeDecision.payload.ruleId, 'untrusted-side-effect-deny');
  assert.strictEqual(readDecision.payload.decision, 'allow');
  assert.strictEqual(readDecision.payload.ruleId, 'untrusted-read-only-allow');

  evidenceLine('taint-g', {
    taskId: task.taskId,
    taskTaintLabels: task.taintLabels,
    deniedWrite: writeDenied.payload,
    allowedRead: completed.find(event => event.payload.tool === 'memory_search').payload,
    writeDecision: writeDecision.payload,
    readDecision: readDecision.payload,
    status: finished.status,
  });
});

// ---- h. 收窄而非扩张：高 trustLevel + 污点不带来额外权限 ----

test('用例h：高 trustLevel + 污点不带来任何额外工具权限', async () => {
  const verified = upstreamArtifact({ taskId: 'task_h_upstream', sourceLabels: ['external:web'] });
  artifactStore.setTrustLevel(verified.id, {
    level: 'independently_verified',
    writer: artifactStore.TRUST_WRITER,
    reason: 'taint-orthogonality-check',
  });
  assert.strictEqual(artifactStore.readTrustLevel(verified.id), 'independently_verified');

  // h1：任务允许写工具，但上游有污点 → 污点策略收窄（拒绝）。
  const taskH1 = makeTask({
    agentId: BOT,
    goal: 'TAINT-H1 高信任但污点',
    allowedTools: ['memory_remember', 'memory_search'],
    provenanceRefs: [refOf(verified)],
  });
  assert.ok(taskH1.taintLabels.includes('external:web'), '上游污点必须随引用继承');
  runtime.startTask(taskH1.taskId);
  const finishedH1 = await waitForTerminal(taskH1.taskId);
  assert.strictEqual(finishedH1.status, 'completed');

  const deniedH1 = eventsOf(taskH1.taskId, 'tool.denied');
  const writeDenied = deniedH1.find(event => event.payload.tool === 'memory_remember');
  assert.ok(writeDenied, '高 trustLevel 不能解锁被污点收窄的写工具');
  assert.strictEqual(writeDenied.payload.errorCode, 'taint_tool_denied');
  assert.strictEqual(writeDenied.payload.ruleId, 'untrusted-side-effect-deny');
  assert.strictEqual(writeDenied.payload.policyVersion, 'taint-policy-v1');

  // h2：任务未授权写工具 → 原有授权先拒；污点策略无法放大 allowedTools。
  const taskH2 = makeTask({
    agentId: BOT,
    goal: 'TAINT-H2 未授权写工具',
    allowedTools: ['memory_search'],
    provenanceRefs: [refOf(verified)],
  });
  runtime.startTask(taskH2.taskId);
  const finishedH2 = await waitForTerminal(taskH2.taskId);
  assert.strictEqual(finishedH2.status, 'completed');

  const deniedH2 = eventsOf(taskH2.taskId, 'tool.denied');
  const writeDeniedH2 = deniedH2.find(event => event.payload.tool === 'memory_remember');
  assert.ok(writeDeniedH2, '未授权写工具必须被拒');
  assert.strictEqual(writeDeniedH2.payload.errorCode, 'task_tool_denied');
  assert.strictEqual(writeDeniedH2.payload.policyVersion, null, '未授权拒绝不经过污点策略');

  evidenceLine('taint-h', {
    trustLevel: artifactStore.readTrustLevel(verified.id),
    upstreamTaintLabels: artifactStore.readTaintLabels(verified.id),
    h1: {
      taskTaintLabels: taskH1.taintLabels,
      denied: writeDenied.payload,
    },
    h2: {
      allowedTools: taskH2.allowedTools,
      denied: writeDeniedH2.payload,
    },
    conclusion: 'trustLevel 与污点正交；策略只收窄，未授权工具不被放大',
  });
});

// ---- i. 策略版本：新版本记录、旧产物保留原版本、未命中规则 fail-closed ----

test('用例i：策略版本记录生效，旧产物保留原 policyVersion，未命中规则 fail-closed', () => {
  const legacy = upstreamArtifact({ taskId: 'task_i_legacy', sourceLabels: ['external:web'] });
  assert.strictEqual(legacy.taintPolicyVersion, 'taint-policy-v1');
  const versionsBefore = taintPolicy.listVersions();
  assert.strictEqual(versionsBefore.length, 1);
  assert.strictEqual(versionsBefore[0].policyLabel, 'taint-policy-v1');
  assert.strictEqual(versionsBefore[0].retiredAt, null);

  const created = taintPolicy.createVersion({
    rules: [
      { id: 'empty-allow', when: { taint: 'empty' }, effect: 'allow' },
      { id: 'trusted-allow', when: { taint: 'trusted' }, effect: 'allow' },
      { id: 'untrusted-deny-all', when: { taint: 'untrusted' }, effect: 'deny' },
    ],
    note: '测试用收窄策略：untrusted 连只读也拒绝',
    now: Date.parse('2026-11-05T01:00:00.000Z'),
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.policyVersion, 'taint-policy-v2');

  const versionsAfter = taintPolicy.listVersions();
  const retired = versionsAfter.find(item => item.policyLabel === 'taint-policy-v1');
  const active = versionsAfter.find(item => item.policyLabel === 'taint-policy-v2');
  assert.ok(retired && retired.retiredAt, '旧版本必须留下失效记录');
  assert.ok(active && active.retiredAt === null, '新版本必须记录生效');
  assert.deepStrictEqual(active.ruleIds, ['empty-allow', 'trusted-allow', 'untrusted-deny-all']);

  // 旧产物保留落盘时的版本，不被回写。
  assert.strictEqual(artifactStore.get(legacy.id).taintPolicyVersion, 'taint-policy-v1');
  const fresh = upstreamArtifact({ taskId: 'task_i_fresh', sourceLabels: ['external:web'] });
  assert.strictEqual(fresh.taintPolicyVersion, 'taint-policy-v2', '新产物按当前版本落盘');

  // 真实 Gateway：新策略下 unverified 只读被拒；未分类标签 fail-closed。
  const authorizer = toolGateway.createToolAuthorizer({
    allowedTools: ['memory_search'],
    getTaintState: () => ({ provenanceRefs: [], taintLabels: ['external:web'] }),
    toolMeta: { memory_search: { name: 'memory_search', readOnly: true, risk: 'read' } },
  });
  const untrustedVerdict = authorizer('memory_search');
  assert.strictEqual(untrustedVerdict.ok, false);
  assert.strictEqual(untrustedVerdict.code, 'taint_tool_denied');
  assert.strictEqual(untrustedVerdict.ruleId, 'untrusted-deny-all');
  assert.strictEqual(untrustedVerdict.policyVersion, 'taint-policy-v2');

  const unclassified = taintPolicy.evaluate({
    taintLabels: ['weird:foo'],
    tool: { name: 'memory_search', readOnly: true },
  });
  assert.strictEqual(unclassified.allowed, false, '未命中规则必须拒绝');
  assert.strictEqual(unclassified.ruleId, 'unclassified-fail-closed');
  assert.strictEqual(unclassified.reason, 'no_rule_matched_fail_closed');
  const authorizerUnclassified = toolGateway.createToolAuthorizer({
    allowedTools: ['memory_search'],
    getTaintState: () => ({ provenanceRefs: [], taintLabels: ['weird:foo'] }),
    toolMeta: { memory_search: { name: 'memory_search', readOnly: true, risk: 'read' } },
  });
  const unclassifiedVerdict = authorizerUnclassified('memory_search');
  assert.strictEqual(unclassifiedVerdict.ok, false);
  assert.strictEqual(unclassifiedVerdict.code, 'taint_tool_denied');
  assert.strictEqual(unclassifiedVerdict.ruleId, 'unclassified-fail-closed');
  assert.strictEqual(unclassifiedVerdict.policyVersion, 'taint-policy-v2');

  evidenceLine('taint-i', {
    legacyArtifactPolicyVersion: artifactStore.get(legacy.id).taintPolicyVersion,
    freshArtifactPolicyVersion: fresh.taintPolicyVersion,
    policyFile: taintPolicy.POLICY_FILE,
    versions: versionsAfter,
    untrustedVerdict: {
      ruleId: untrustedVerdict.ruleId,
      policyVersion: untrustedVerdict.policyVersion,
    },
    unclassified: {
      ruleId: unclassified.ruleId,
      reason: unclassified.reason,
      gatewayCode: unclassifiedVerdict.code,
    },
  });
});
