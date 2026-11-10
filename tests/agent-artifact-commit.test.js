/* global require, process, __dirname */
/**
 * Phase 1 前置 ③：Artifact 与完成提交协议回归。
 *
 * 覆盖 §11 五步：
 *  a) 正常完成：产物先落盘 → 引用随状态同次写入 → completed，stateVersion 递增，磁盘可复读；
 *  b) 产物写失败：不得 completed，无副作用工具进 retrying，有副作用工具进 recovery；
 *  c) 产物已写但状态提交失败：保持 pending-commit → 扫描标记 orphan → 幂等重试重新关联；
 *  d) 幂等：重复提交同一引用不产生重复产物、refCount 不重复累加；
 *  e) 清理：有引用不清理，无引用且超 TTL 才清理，清理留审计；
 *  f) 回归：不带产物引用的既有完成路径行为不变；
 *  g) 硬约束：已提交产物不得删除，错误产物只标记 invalidated 并保留审计记录。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 * 真实调用：a/b 走真实 HTTP stub Provider + 真实 runtime 队列，
 * 只在 b 注入 fs 层写入错误（不替换业务函数）；c 只注入 transitionTask 失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-artifact-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';

const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const { normalizeWorkerResult } = require('../server/agents/worker-result');
const { AgentError } = require('../server/agents/errors');

let providerServer;
let providerId;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'artifact-test-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function lastUserText(messages) {
  return String((messages.at(-1) || {}).content || '');
}

function taskGoal(messages) {
  const match = lastUserText(messages).match(/目标：(.+)/);
  return match ? match[1].trim() : '产物任务';
}

test.before(async () => {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { data: [{ id: 'artifact-test-model' }] });
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
      json(res, 200, completion(`已处理：${taskGoal(parsed.messages || [])}`));
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
    name: 'Artifact Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'artifact-test-model',
        name: 'Artifact Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  providerId = added.provider.id;
  config.updateConfig('memory', {
    enabled: true,
    modelProfile: {
      providerId,
      modelId: 'artifact-test-model',
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 20000,
    },
  });
  const credential = credentials.putCredential({
    botId: 'memory',
    providerId,
    apiKey: 'artifact-bot-key',
  });
  config.setCredentialId('memory', credential.credentialId);
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

function makeTask(overrides = {}) {
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '产物协议任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...overrides,
  });
}

// maxAttempts 在 createTask 时从环境变量读取；这里按需临时覆盖（与 agent-worker 一致）。
function makeRetryTask(goal, maxAttempts, overrides = {}) {
  const previous = process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS;
  process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = String(maxAttempts);
  try {
    return makeTask({ goal, ...overrides });
  } finally {
    if (previous === undefined) delete process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS;
    else process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = previous;
  }
}

function toRunning(taskId) {
  tasks.transitionTask(taskId, { to: 'accepted' });
  tasks.transitionTask(taskId, { to: 'running' });
  return tasks.getRawTask(taskId);
}

async function waitForStatus(taskId, statuses, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && statuses.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return tasks.getTask(taskId);
}

function readArtifactsFromDisk() {
  if (!fs.existsSync(artifactStore.ARTIFACTS_FILE)) return [];
  return Object.values(
    JSON.parse(fs.readFileSync(artifactStore.ARTIFACTS_FILE, 'utf8')).artifacts
  );
}

// b) 注入真实 fs 写入错误：只对产物临时文件生效，其余写入不受影响。
function injectArtifactWriteFailure(t) {
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).includes('agent-artifacts.json.tmp')) {
      const error = new Error('ENOSPC: no space left on device (injected)');
      error.code = 'ENOSPC';
      throw error;
    }
    return realOpen.call(fs, file, ...args);
  });
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

// ---- a. 正常完成 ----

test('a. 正常完成：产物先落盘，引用随状态同次写入，stateVersion 递增且磁盘可复读', async () => {
  const task = makeTask({ goal: 'ARTIFACT_OK 正常完成' });
  const versionBefore = task.stateVersion;
  runtime.startTask(task.taskId);
  const finished = await waitForTask(task.taskId);

  assert.equal(finished.status, 'completed');
  assert.equal(finished.result.status, 'completed');
  assert.equal(finished.result.artifacts.length, 1);
  const ref = finished.result.artifacts[0];
  assert.equal(ref.kind, 'message');
  assert.match(ref.id, /^art_[0-9a-f]{32}$/);
  assert.equal(ref.version, 1);
  assert.ok(Number.isInteger(finished.stateVersion) && finished.stateVersion > versionBefore);

  const artifact = artifactStore.get(ref.id);
  assert.ok(artifact, '磁盘上应能复读产物');
  assert.equal(artifact.status, 'active');
  assert.equal(artifact.commit, 'committed');
  assert.equal(artifact.refCount, 1);
  assert.equal(artifact.version, 1);
  assert.match(artifact.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(artifact.refs.map(item => item.taskId), [task.taskId]);

  // 任务文件与产物文件都是真实落盘的 JSON，可独立复读。
  const diskTask = JSON.parse(fs.readFileSync(tasks.TASKS_FILE, 'utf8')).tasks[task.taskId];
  assert.deepEqual(diskTask.result.artifacts, finished.result.artifacts);
  const diskArtifacts = readArtifactsFromDisk();
  assert.ok(diskArtifacts.some(item => item.id === ref.id));
});

// ---- b. 产物写失败 ----

test('b. 产物写失败：不得 completed；无副作用工具进 retrying，有副作用工具进 recovery', async t => {
  injectArtifactWriteFailure(t);

  const retryTask = makeRetryTask('ARTIFACT_WRITE_FAIL 重试', 2);
  runtime.startTask(retryTask.taskId);
  const retrying = await waitForStatus(retryTask.taskId, ['retrying', 'recovery', 'failed']);
  assert.equal(retrying.status, 'retrying');
  assert.equal(retrying.lastErrorCode, 'artifact_store_write_failed');
  assert.equal(retrying.result, null, '写失败时绝不能落 completed 结果');
  // 收口：避免退避到期后再次执行影响后续用例。
  runtime.cancelTask(retryTask.taskId);

  const recoveryTask = makeRetryTask('ARTIFACT_WRITE_FAIL 副作用', 2, {
    allowedTools: ['memory_remember'],
  });
  runtime.startTask(recoveryTask.taskId);
  const recovered = await waitForTask(recoveryTask.taskId);
  assert.equal(recovered.status, 'recovery');
  assert.equal(recovered.errorCode, 'artifact_store_write_failed');
  assert.equal(recovered.result.status, 'recovery');
  assert.equal(recovered.result.artifacts.length, 0);
});

// ---- c. 产物已写但状态提交失败 ----

test('c. 产物已写但状态提交失败：pending-commit → 扫描标记 orphan → 幂等重试重新关联', () => {
  const task = makeTask({ goal: 'ARTIFACT_COMMIT_FAIL 提交失败' });
  toRunning(task.taskId);

  const refs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_commit_fail',
    artifacts: [{ kind: 'memory', content: { id: 'm_commit_fail', decision: 'create' } }],
  });
  const artifactId = refs[0].id;
  assert.equal(artifactStore.get(artifactId).commit, 'pending-commit');

  // 注入状态提交失败：产物已写，任务仍 running。
  const original = tasks.transitionTask;
  tasks.transitionTask = () => {
    throw new AgentError('injected_transition_failure', '注入的状态提交失败', 500);
  };
  try {
    const result = normalizeWorkerResult({
      status: 'completed',
      summary: '提交失败',
      artifacts: refs,
      runId: 'run_commit_fail',
    });
    assert.throws(
      () => artifactCommit.completeTask(task.taskId, { completedAt: new Date().toISOString(), result }),
      /注入的状态提交失败/
    );
  } finally {
    tasks.transitionTask = original;
  }

  assert.equal(tasks.getTask(task.taskId).status, 'running', '状态未提交，任务不能 completed');
  assert.equal(artifactStore.get(artifactId).commit, 'pending-commit');
  assert.equal(artifactStore.get(artifactId).refCount, 0);

  // “重启扫描”：无引用且超过 TTL → 标记 orphan（仍不删除）。
  const scan = artifactCommit.scanPendingCommits({ ttlMs: 0 });
  assert.ok(scan.orphaned.includes(artifactId), JSON.stringify(scan));
  assert.equal(artifactStore.get(artifactId).commit, 'orphan');
  assert.ok(artifactStore.get(artifactId), 'orphan 仍保留记录，等待幂等关联或 TTL 清理');

  // 幂等重试：同一产物重新关联，不产生重复产物。
  const retriedRefs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_commit_retry',
    artifacts: [{ kind: 'memory', content: { id: 'm_commit_fail', decision: 'create' } }],
  });
  assert.equal(retriedRefs[0].id, artifactId, '同一产物必须复用同一 artifactId');
  artifactCommit.completeTask(task.taskId, {
    completedAt: new Date().toISOString(),
    result: normalizeWorkerResult({
      status: 'completed',
      summary: '提交重试成功',
      artifacts: retriedRefs,
      runId: 'run_commit_retry',
    }),
  });
  const converged = artifactStore.get(artifactId);
  assert.equal(converged.commit, 'committed');
  assert.equal(converged.refCount, 1);
  assert.equal(
    artifactStore.all().filter(item => item.kind === 'memory' && item.taskId === task.taskId).length,
    1
  );
  assert.equal(tasks.getTask(task.taskId).status, 'completed');
});

// ---- d. 幂等重试 ----

test('d. 幂等：重复提交同一产物引用不产生重复产物、refCount 不重复累加', () => {
  const task = makeTask({ goal: 'ARTIFACT_IDEMPOTENT 幂等' });
  toRunning(task.taskId);
  const content = [{ kind: 'memory', content: { id: 'm_idem', decision: 'create' } }];

  const first = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_idem_1',
    artifacts: content,
  });
  const second = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_idem_2',
    artifacts: content,
  });
  assert.equal(first[0].id, second[0].id);

  artifactStore.confirmRefs(first, { taskId: task.taskId, runId: 'run_idem_1' });
  artifactStore.confirmRefs(second, { taskId: task.taskId, runId: 'run_idem_2' });
  const artifact = artifactStore.get(first[0].id);
  assert.equal(artifact.refCount, 1, 'refCount 不能重复累加');
  assert.equal(artifact.refs.length, 1);
  assert.equal(artifact.commit, 'committed');
  assert.equal(
    artifactStore.all().filter(item => item.kind === 'memory' && item.taskId === task.taskId).length,
    1,
    '同一产物只允许一条记录'
  );
});

// ---- e. 清理 ----

test('e. 清理：有引用不清理；无引用且超 TTL 才清理；清理留审计', () => {
  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  // 1) 被任务引用但尚未提交的产物：不清理。
  const referenced = artifactStore.persist({
    kind: 'referenced',
    content: { n: 1 },
    taskId: null,
    now: twoHoursAgo,
  });
  const refTask = makeTask({ goal: 'ARTIFACT_CLEANUP_REF 有引用' });
  tasks.updateTask(refTask.taskId, {
    result: normalizeWorkerResult({
      status: 'failed',
      artifacts: [{ kind: referenced.kind, id: referenced.id, version: referenced.version }],
    }),
  });

  // 2) 无引用、超过 TTL：清理并留审计。
  const stale = artifactStore.persist({
    kind: 'stale',
    content: { n: 2 },
    taskId: null,
    now: twoHoursAgo,
  });
  // 3) 无引用、未超 TTL：保留。
  const fresh = artifactStore.persist({ kind: 'fresh', content: { n: 3 }, taskId: null });

  const cleanup = artifactCommit.cleanupOrphans({ now, ttlMs: 60 * 1000 });
  assert.ok(!cleanup.cleaned.includes(referenced.id), '有引用不能清理');
  const referencedKeep = cleanup.kept.find(item => item.id === referenced.id);
  assert.equal(referencedKeep.reason, 'referenced_by_task');
  assert.ok(cleanup.cleaned.includes(stale.id), '无引用且超 TTL 必须清理');
  assert.ok(!cleanup.cleaned.includes(fresh.id), '未超 TTL 不能清理');
  assert.equal(artifactStore.get(stale.id), null);
  assert.ok(artifactStore.get(referenced.id));
  assert.ok(artifactStore.get(fresh.id));

  const audit = artifactStore.auditEntries();
  const purged = audit.filter(
    entry => entry.action === 'artifact.purged' && entry.artifactId === stale.id
  );
  assert.equal(purged.length, 1, '清理动作必须写入审计');
  assert.equal(purged[0].contentHash, stale.contentHash);
  assert.match(String(purged[0].reason), /refscan:no-task-refs/);
});

// ---- f. 回归 ----

test('f. 回归：不带产物引用的既有完成路径行为不变', () => {
  const before = artifactStore.all().length;
  const task = makeTask({ goal: 'ARTIFACT_LEGACY 无产物' });
  toRunning(task.taskId);
  const versionBefore = tasks.getTask(task.taskId).stateVersion;
  const updated = tasks.transitionTask(task.taskId, {
    to: 'completed',
    completedAt: new Date().toISOString(),
    result: normalizeWorkerResult({ status: 'completed', summary: '无产物完成', artifacts: [] }),
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.result.artifacts.length, 0);
  assert.equal(updated.stateVersion, versionBefore + 1);
  assert.equal(artifactStore.all().length, before, '无产物路径不应写产物存储');
});

// ---- g. 硬约束 ----

test('g. 已提交产物不得删除；错误产物只标记 invalidated 并保留审计', () => {
  const task = makeTask({ goal: 'ARTIFACT_INVALIDATE 错误产物' });
  toRunning(task.taskId);
  const refs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_invalidate',
    artifacts: [{ kind: 'memory', content: { id: 'm_invalid', decision: 'create' } }],
  });
  artifactStore.confirmRefs(refs, { taskId: task.taskId, runId: 'run_invalidate' });
  const artifactId = refs[0].id;
  assert.equal(artifactStore.get(artifactId).commit, 'committed');

  const invalidated = artifactStore.markStatus(artifactId, 'invalidated', {
    reason: 'schema_mismatch',
  });
  assert.equal(invalidated.status, 'invalidated');
  assert.ok(artifactStore.get(artifactId), '错误产物必须保留，不能删除');

  const audit = artifactStore.auditEntries();
  assert.ok(
    audit.some(
      entry => entry.action === 'artifact.invalidated' && entry.artifactId === artifactId
    ),
    '标记必须留审计'
  );

  // 已提交 / 非 active 产物不参与自动清理。
  const cleanup = artifactCommit.cleanupOrphans({ now: Date.now() + 30 * 24 * 3600 * 1000 });
  assert.ok(!cleanup.cleaned.includes(artifactId));
  assert.ok(artifactStore.get(artifactId));
});

// ---- h/i. Phase 2 第 1 项：证据引用 fail-closed 与版本不可变 ----

function captureError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

test('h. 共享结论：证据缺失/未钉版本/不可读一律拒绝；带证据的结论可被同批次任务按版本追溯', () => {
  const producer = makeTask({ goal: 'CONCLUSION 证据门禁' });
  const consumer = makeTask({ goal: 'CONCLUSION 消费方' });
  const source = artifactStore.persist({
    kind: 'message',
    content: { text: '结论依据正文' },
    taskId: producer.taskId,
  });
  const base = {
    taskId: producer.taskId,
    subject: '共享结论',
    withTaskIds: [consumer.taskId],
  };

  const missingEvidence = captureError(() =>
    artifactCommit.publishSharedConclusion({ ...base, evidence: [] })
  );
  assert.equal(missingEvidence && missingEvidence.code, 'artifact_evidence_missing');
  assert.equal(missingEvidence.status, 409);

  const noVersion = captureError(() =>
    artifactCommit.publishSharedConclusion({
      ...base,
      evidence: [{ kind: 'message', id: source.id }],
    })
  );
  assert.equal(noVersion && noVersion.code, 'artifact_evidence_invalid');

  const unreadable = captureError(() =>
    artifactCommit.publishSharedConclusion({
      ...base,
      evidence: [{ kind: 'message', id: 'art_missing', version: 1 }],
    })
  );
  assert.equal(unreadable && unreadable.code, 'artifact_not_found');

  const countConclusions = () =>
    artifactStore.all().filter(item => item.kind === 'conclusion' && item.taskId === producer.taskId)
      .length;
  const before = countConclusions();
  const published = artifactCommit.publishSharedConclusion({
    ...base,
    evidence: [{ kind: 'message', id: source.id, version: source.version }],
  });
  assert.equal(countConclusions(), before + 1, '被拒绝的尝试不得写入结论产物');
  assert.deepEqual(published.ref, {
    kind: 'conclusion',
    id: published.artifact.id,
    version: published.artifact.version,
  });

  const read = artifactStore.readSharedArtifact(published.artifact.id, {
    requesterTaskId: consumer.taskId,
  });
  assert.deepEqual(read.content.evidence, [
    { kind: 'message', id: source.id, version: source.version },
  ]);
  const foreign = captureError(() =>
    artifactStore.readSharedArtifact(published.artifact.id, {
      requesterTaskId: 'task_foreign',
    })
  );
  assert.equal(foreign && foreign.code, 'artifact_not_shared');
  assert.ok(!JSON.stringify(foreign).includes('结论依据正文'));
  console.log(
    '[共享结论-证据门禁]',
    JSON.stringify({
      missing: missingEvidence.code,
      noVersion: noVersion.code,
      unreadable: unreadable.code,
      conclusionRef: published.ref,
      evidencePinned: read.content.evidence.map(item => `${item.id.slice(0, 12)}@v${item.version}`),
      foreignCode: foreign.code,
      bodyEchoed: JSON.stringify(foreign).includes('结论依据正文'),
    })
  );
});

test('i. 版本不可变：追加新版本后旧版内容不变，旧版证据引用仍可复读', () => {
  const producer = makeTask({ goal: 'IMMUTABLE 版本' });
  const consumer = makeTask({ goal: 'IMMUTABLE 消费方' });
  const v1 = artifactStore.persist({
    kind: 'message',
    content: { text: '第一版正文' },
    taskId: producer.taskId,
  });
  const v1Hash = v1.contentHash;
  const published = artifactCommit.publishSharedConclusion({
    taskId: producer.taskId,
    subject: '引用第一版',
    evidence: [{ kind: 'message', id: v1.id, version: v1.version }],
    withTaskIds: [consumer.taskId],
  });

  const v2 = artifactStore.persist({
    kind: 'message',
    content: { text: '第二版正文' },
    taskId: producer.taskId,
  });
  assert.equal(v2.version, 2);
  const v1After = artifactStore.get(v1.id);
  assert.equal(v1After.status, 'superseded');
  assert.equal(v1After.contentHash, v1Hash, '旧版内容地址不得改变');
  assert.equal(artifactStore.readContent(v1.id, { version: 1 }).content.text, '第一版正文');

  // 共享结论里的旧版证据引用仍可复读（来源可追溯）。
  const conclusion = artifactStore.readSharedArtifact(published.artifact.id, {
    requesterTaskId: consumer.taskId,
  });
  const evidence = conclusion.content.evidence[0];
  assert.equal(evidence.id, v1.id);
  assert.equal(evidence.version, 1);
  assert.equal(
    artifactStore.readContent(evidence.id, { version: evidence.version }).content.text,
    '第一版正文'
  );

  // 新的完成提交不能把已被 superseded 的旧版当 active 引用。
  const staleCommit = captureError(() =>
    artifactStore.assertRefsCommitReady([{ kind: 'message', id: v1.id, version: 1 }])
  );
  assert.equal(staleCommit && staleCommit.code, 'artifact_not_active');
  console.log(
    '[版本不可变]',
    JSON.stringify({
      v1: { id: v1.id.slice(0, 12), version: v1.version, status: v1After.status },
      v2: { id: v2.id.slice(0, 12), version: v2.version },
      hashUnchanged: v1After.contentHash === v1Hash,
      evidenceStillReadable: evidence.version === 1,
      staleCommitCode: staleCommit.code,
    })
  );
});
