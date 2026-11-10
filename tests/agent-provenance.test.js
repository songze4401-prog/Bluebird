/* global require, process */
/**
 * §16 provenance / taint 端到端回归（用例 a–e）。
 *
 * 口径（全部真跑 artifact-store + 任务存储 + Worker Runtime 与 Gateway，不 mock 存储/校验）：
 *  a) 正常任务：产物带 provenanceRefs（上游 artifact 引用）与 taintLabels（来源标签并集）；
 *  b) 派生继承：派生产物 taint 为上游并集，生产者清除被拒并留痕；
 *  c) 验证路径：只有 Verification Engine 能把 unverified 标记为 verified，非验证器被拒；
 *  d) Gateway 断裂：任务来源引用不可解析 → 每次工具调用被 fail-closed 拒绝并留痕；
 *  e) 持久化与旧数据：重启复读不变；缺字段旧记录读作 unknown。
 *
 * 原文只写"Task Contract 增加 provenanceRefs、taintLabels、taintPolicyVersion"与
 * "污点随摘要/引用/产物传播、Producer 不得自行移除、Gateway 每次调用校验"；
 * 标签取值与"何种污点禁止何种工具"未定义，见台账"待确认"。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-provenance-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const tasks = require('../server/agents/tasks');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const runtime = require('../server/agents/runtime');

let providerServer;
let providerId;

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

function completion(content, { toolCalls = null } = {}) {
  const message = toolCalls
    ? { role: 'assistant', content: null, tool_calls: toolCalls }
    : { role: 'assistant', content };
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'provenance-test-model',
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
      json(res, 200, { data: [{ id: 'provenance-test-model' }] });
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
      // 用例 d：先请求一次 memory_search；拿到 tool 结果（拒绝结果）后收敛成文本。
      if (goal.includes('PROV-D')) {
        const hasToolResult = messages.some(message => message && message.role === 'tool');
        if (!hasToolResult) {
          json(
            res,
            200,
            completion(null, { toolCalls: [toolCall('call_prov_d', 'memory_search', { query: '污点' })] })
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
    name: 'Provenance Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'provenance-test-model',
        name: 'Provenance Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, JSON.stringify(added));
  providerId = added.provider.id;
  for (const botId of ['researcher']) {
    config.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: 'provenance-test-model',
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

function makeProducerTask(goal, extra = {}) {
  return tasks.createTask({
    agentId: 'researcher',
    taskType: 'memory.recall',
    goal,
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    ...extra,
  });
}

function upstreamArtifact(sourceLabel) {
  return artifactStore.persist({
    kind: 'note',
    content: { text: `上游内容 ${sourceLabel}` },
    taskId: 'task_upstream',
    sourceLabels: [sourceLabel],
  });
}

// ---- a. 正常任务：产物带 provenanceRefs 与来源 taint 标签 ----

test('用例a：正常任务产物带 provenanceRefs 与来源 taint 标签', async () => {
  const upstream = upstreamArtifact('external:web');
  const ref = { kind: upstream.kind, id: upstream.id, version: upstream.version };
  const task = makeProducerTask('PROV-A 正常任务，产物带来源链', {
    provenanceRefs: [ref],
    taintLabels: ['external:web'],
  });

  assert.deepStrictEqual(task.provenanceRefs, [ref]);
  assert.ok(task.taintLabels.includes('external:web'), '任务 taint 必须含声明来源标签');

  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  assert.strictEqual(finished.status, 'completed');

  const refs = finished.result && Array.isArray(finished.result.artifacts)
    ? finished.result.artifacts
    : [];
  const messageRef = refs.find(item => item.kind === 'message');
  assert.ok(messageRef, '真实任务必须落 message 产物');
  const stored = artifactStore.get(messageRef.id);

  assert.deepStrictEqual(stored.provenanceRefs, [ref], '产物必须携带上游来源引用');
  assert.ok(stored.taintLabels.includes('external:web'), '产物必须继承上游来源标签');
  assert.ok(stored.taintLabels.includes('agent:derived'), '派生产物必须带自身来源标签');
  assert.strictEqual(stored.taintPolicyVersion, artifactStore.TAINT_POLICY_VERSION);
  // 任务公开视图同样可查询（只读克隆，不暴露原始存储对象）。
  assert.ok(finished.taintLabels.includes('external:web'), '任务视图必须能查询来源标签');
  assert.ok(finished.taintLabels.includes('unverified'), '继承的未验证标签不得被任务丢弃');
  assert.ok(!finished.taintLabels.includes('agent:derived'), 'agent:derived 只在派生产物上追加');

  evidenceLine('provenance-a', {
    taskId: task.taskId,
    artifact: messageRef,
    taskProvenanceRefs: finished.provenanceRefs,
    taskTaintLabels: finished.taintLabels,
    artifactProvenanceRefs: stored.provenanceRefs,
    artifactTaintLabels: stored.taintLabels,
    policyVersion: stored.taintPolicyVersion,
  });
});

// ---- b. 派生继承：并集 + 生产者清除被拒并留痕 ----

test('用例b：派生产物 taint 取并集，生产者清除被拒并留痕', () => {
  const upstream = upstreamArtifact('external:web');
  const derivedRefs = artifactCommit.persistTaskArtifacts({
    taskId: 'task_derived',
    artifacts: [{ kind: 'summary', content: { text: '派生摘要' } }],
    provenanceRefs: [{ kind: upstream.kind, id: upstream.id, version: upstream.version }],
  });
  assert.strictEqual(derivedRefs.length, 1);
  const derived = artifactStore.get(derivedRefs[0].id);

  assert.ok(derived.taintLabels.includes('external:web'), '派生必须继承上游标签');
  assert.ok(derived.taintLabels.includes('agent:derived'), '派生必须追加自身来源标签');
  assert.ok(derived.taintLabels.includes('unverified'), '新产物默认未验证');
  const before = derived.taintLabels.slice();

  assert.throws(
    () => artifactStore.setTaintLabels(derived.id, { labels: [], writer: 'producer' }),
    error => error.code === 'not_authorized' && error.status === 403,
    '生产者清除标签必须被拒'
  );
  const stored = artifactStore.get(derived.id);
  assert.deepStrictEqual(stored.taintLabels, before, '被拒写入不得改变已存标签');

  const rejections = artifactStore
    .auditEntries()
    .filter(
      entry =>
        entry.action === 'artifact.taint_write_rejected' && entry.artifactId === derived.id
    );
  assert.ok(rejections.length >= 1, '生产者清除必须留痕');

  // 任务写入路径同样不得清除（尤其是"清空标签"）。
  const task = makeProducerTask('PROV-B 派生继承检查');
  assert.throws(
    () => tasks.updateTask(task.taskId, { taintLabels: [] }),
    error => error.code === 'not_authorized' && error.status === 403
  );
  const taskRejections = eventsOf(task.taskId, 'task.taint_write_rejected');
  assert.strictEqual(taskRejections.length, 1);
  assert.strictEqual(taskRejections[0].payload.field, 'taintLabels');
  assert.strictEqual(taskRejections[0].payload.mode, 'updateTask');

  evidenceLine('provenance-b', {
    artifactId: derived.id,
    inheritedUnion: before,
    unchangedAfterReject: stored.taintLabels,
    artifactRejectionAudit: rejections.map(entry => entry.reason),
    taskRejection: taskRejections[0] && taskRejections[0].payload,
  });
});

// ---- c. 验证路径：只有 Verification Engine 能标记已验证 ----

test('用例c：只有验证路径能把 unverified 转为 verified', () => {
  const upstream = upstreamArtifact('tool:memory_remember');
  const derivedRefs = artifactCommit.persistTaskArtifacts({
    taskId: 'task_verify',
    artifacts: [{ kind: 'summary', content: { text: '待验证摘要' } }],
    provenanceRefs: [{ kind: upstream.kind, id: upstream.id, version: upstream.version }],
  });
  const derived = artifactStore.get(derivedRefs[0].id);
  assert.ok(derived.taintLabels.includes('unverified'));

  let rejected;
  assert.throws(
    () => artifactStore.markTaintVerified(derived.id, { writer: 'producer' }),
    error => {
      rejected = error;
      return error.code === 'not_authorized' && error.status === 403;
    },
    '非验证器路径必须被拒'
  );
  assert.ok(artifactStore.get(derived.id).taintLabels.includes('unverified'), '被拒后状态不变');
  const rejections = artifactStore
    .auditEntries()
    .filter(
      entry =>
        entry.action === 'artifact.taint_write_rejected' && entry.artifactId === derived.id
    );
  assert.ok(rejections.length >= 1);

  const verified = artifactStore.markTaintVerified(derived.id, {
    writer: artifactStore.TRUST_WRITER,
    reason: 'verification_passed',
  });
  assert.ok(!verified.taintLabels.includes('unverified'), '验证后必须移除 unverified');
  assert.ok(verified.taintLabels.includes('verified'), '验证后必须标记 verified');
  assert.ok(verified.taintLabels.includes('tool:memory_remember'), '验证不得抹掉来源标签');
  assert.strictEqual(verified.taintChangedBy, artifactStore.TRUST_WRITER);

  const changes = artifactStore
    .auditEntries()
    .filter(
      entry =>
        entry.action === 'artifact.taint_changed' &&
        entry.artifactId === derived.id &&
        String(entry.reason || '').includes('verification_passed')
    );
  assert.strictEqual(changes.length, 1);

  evidenceLine('provenance-c', {
    artifactId: derived.id,
    rejectedCode: rejected && rejected.code,
    rejectionAudits: rejections.map(entry => entry.reason),
    labelsAfterVerify: verified.taintLabels,
    changedBy: verified.taintChangedBy,
    changeAudit: changes[0] && changes[0].reason,
  });
});

// ---- d. Gateway 断裂：来源引用不可解析 → fail-closed + 留痕 ----

test('用例d：来源引用不可解析 → 工具调用 fail-closed 拒绝并留痕', async () => {
  const brokenRef = { kind: 'note', id: 'art_does_not_exist', version: 1 };
  const task = makeProducerTask('PROV-D 来源链断裂，工具调用应被拒', {
    provenanceRefs: [brokenRef],
  });
  assert.deepStrictEqual(task.provenanceRefs, [brokenRef]);
  assert.ok(task.taintLabels.includes('unknown'), '不可解析来源读作 unknown');

  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  assert.strictEqual(finished.status, 'completed', '拒绝工具调用不应让任务崩溃');

  const denied = eventsOf(task.taskId, 'tool.denied');
  assert.ok(denied.length >= 1, 'Gateway 拒绝必须留痕');
  assert.strictEqual(denied[0].payload.tool, 'memory_search');
  assert.strictEqual(denied[0].payload.errorCode, 'taint_provenance_broken');
  assert.strictEqual(denied[0].payload.mode, 'delegated_task');

  // 同一任务内没有一次真实执行（tool.denied 即拒绝路径）。
  evidenceLine('provenance-d', {
    taskId: task.taskId,
    brokenRef,
    taskTaintLabels: task.taintLabels,
    deniedEvent: denied[0] && denied[0].payload,
    status: finished.status,
  });
});

// ---- e. 持久化与旧数据 ----

test('用例e：重启复读不变；缺字段旧记录读 unknown', () => {
  const artifact = artifactStore.persist({
    kind: 'note',
    content: { text: '持久化基线' },
    taskId: 'task_persist',
    sourceLabels: ['external:file'],
  });
  const labelsBefore = artifactStore.readTaintLabels(artifact.id);
  assert.deepStrictEqual(labelsBefore, ['external:file', 'unverified']);

  // 重启语义：清掉模块缓存重新 require，仍按同一数据目录读盘。
  const storePath = require.resolve('../server/agents/artifact-store');
  delete require.cache[storePath];
  const reloaded = require('../server/agents/artifact-store');
  const labelsAfterRestart = reloaded.readTaintLabels(artifact.id);
  assert.deepStrictEqual(labelsAfterRestart, labelsBefore, '重启后复读必须不变');
  assert.deepStrictEqual(reloaded.readProvenanceRefs(artifact.id), []);

  // 旧数据：手工移除字段，读边界不得默认成"干净"。
  const raw = JSON.parse(fs.readFileSync(artifactStore.ARTIFACTS_FILE, 'utf8'));
  delete raw.artifacts[artifact.id].taintLabels;
  delete raw.artifacts[artifact.id].provenanceRefs;
  fs.writeFileSync(artifactStore.ARTIFACTS_FILE, JSON.stringify(raw, null, 2));

  const legacy = artifactStore.get(artifact.id);
  assert.strictEqual(legacy.taintLabels, undefined, '旧记录确实缺少 taintLabels');
  assert.strictEqual(legacy.provenanceRefs, undefined, '旧记录确实缺少 provenanceRefs');
  assert.deepStrictEqual(artifactStore.readTaintLabels(artifact.id), ['unknown']);
  assert.deepStrictEqual(artifactStore.readProvenanceRefs(artifact.id), []);

  evidenceLine('provenance-e', {
    artifactId: artifact.id,
    labelsBeforeRestart: labelsBefore,
    labelsAfterRestart,
    legacyTaintLabels: artifactStore.readTaintLabels(artifact.id),
    legacyProvenanceRefs: artifactStore.readProvenanceRefs(artifact.id),
    reason: '缺字段不得默认成干净：未知即最保守',
  });
});
