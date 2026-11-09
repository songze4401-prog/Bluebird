/* global require, process */
/**
 * §27 trustLevel 接入 verification-loop / runtime 的端到端回归（用例 a–d）。
 *
 * 口径（全部真跑 runtime + 独立 Reviewer，不 mock 验证器）：
 *  a) 确定性校验通过 → evidence_checked；独立 Reviewer（独立任务）通过 → independently_verified；
 *  b) Reviewer 判否 → 不得高于 declared，且审计记录降级原因；
 *  c) 越权写入（updateTask / transitionTask / artifactCommit / 非验证器 artifactStore 写入）
 *     → 被拒并留痕，已存值不变；
 *  d) 高 trustLevel 不带来任何读取权限（未共享产物仍读不到）。
 *
 * 用例 e（重启复读 + 旧数据缺字段）在 tests/agent-trust-level.test.js。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-trust-runtime-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const tasks = require('../server/agents/tasks');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const approvals = require('../server/agents/approvals');
const runtime = require('../server/agents/runtime');
const verificationLoop = require('../server/agents/verification-loop');

let providerServer;
let providerId;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function lastUserText(messages) {
  return String((messages.at(-1) || {}).content || '');
}

function taskGoal(messages) {
  const match = lastUserText(messages).match(/目标：(.+)/);
  return match ? match[1].trim() : '';
}

function completion(content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'trust-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function tryJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

// 确定性替身审校器（与 agent-verification-loop.test.js 同一口径）：
// 只看被审产物正文的 claims/facts 是否一致，不看样本标签。
function reviewContent(content) {
  let body = content && typeof content === 'object' ? content : {};
  if (typeof body.text === 'string') {
    const inner = tryJson(body.text);
    if (inner) body = inner;
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const claims = Array.isArray(body.claims) ? body.claims : [];
  const facts = Array.isArray(body.facts) ? body.facts : [];
  if (!claims.length && !subject) return { decision: 'pass', reasons: ['no_structured_claims'] };
  if (subject && !claims.length) return { decision: 'needs_human', reasons: ['claims_missing'] };
  if (claims.length && !facts.length) return { decision: 'needs_human', reasons: ['facts_missing'] };
  const contradiction = claims.some(claim => {
    if (!claim || typeof claim !== 'object') return true;
    const fact = facts.find(item => item && item.key === claim.key);
    if (!fact) return true;
    return String(fact.value) !== String(claim.value);
  });
  if (contradiction) return { decision: 'fail', reasons: ['claim_contradicts_evidence'] };
  return { decision: 'pass', reasons: ['claims_consistent'] };
}

function reviewReply(text) {
  const marker = '产物正文(JSON)：';
  const start = text.indexOf(marker);
  const raw = start >= 0 ? text.slice(start + marker.length).split('\n')[0].trim() : '{}';
  const content = tryJson(raw) || {};
  const { decision, reasons } = reviewContent(content);
  const refMatch = text.match(/被审产物：kind=\S+ id=(art_[A-Za-z0-9]+) version=(\d+)/);
  const evidence = refMatch ? [{ id: refMatch[1], version: Number(refMatch[2]) }] : [];
  return JSON.stringify({ decision, evidence, reasons });
}

test.before(async () => {
  providerServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { data: [{ id: 'trust-test-model' }] });
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
      const text = lastUserText(parsed.messages || []);
      if (text.includes('独立审校任务')) {
        json(res, 200, completion(reviewReply(text)));
        return;
      }
      if (text.includes('DEFECT_CONTRADICTION')) {
        json(
          res,
          200,
          completion(
            JSON.stringify({
              subject: '咖啡偏好结论',
              claims: [{ key: 'preference', value: '拿铁' }],
              facts: [{ key: 'preference', value: '美式' }],
            })
          )
        );
        return;
      }
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
    name: 'Trust Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'trust-test-model',
        name: 'Trust Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, JSON.stringify(added));
  providerId = added.provider.id;
  for (const botId of ['researcher', 'reviewer']) {
    config.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: 'trust-test-model',
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

async function waitForStatus(taskId, status, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && (task.status === status || tasks.isTerminalStatus(task.status))) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

function makeProducerTask(goal, { requiresReview = false } = {}) {
  const task = tasks.createTask({
    agentId: 'researcher',
    taskType: 'memory.recall',
    goal,
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
  });
  if (requiresReview) tasks.updateTask(task.taskId, { requiresReview: true });
  return task;
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

function trustChangesOf(taskId) {
  return artifactStore
    .auditEntries()
    .filter(entry => entry.taskId === taskId && entry.action === 'artifact.trust_level_changed');
}

// ---- a. 确定性通过 → evidence_checked；未触发审校不得到最高档 ----

test('用例a1：确定性校验通过 → evidence_checked（requiresReview=false 不升最高档）', async () => {
  const task = makeProducerTask('trust-a1 正常任务，不触发审校');
  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);

  assert.strictEqual(finished.status, 'completed');
  const refs = finished.result && Array.isArray(finished.result.artifacts)
    ? finished.result.artifacts
    : [];
  assert.ok(refs.length >= 1, '真实任务必须落产物');
  const levels = refs.map(ref => artifactStore.readTrustLevel(ref.id));
  assert.deepStrictEqual(levels, refs.map(() => 'evidence_checked'));
  assert.ok(!levels.includes('independently_verified'), '审校未触发不得跳到最高档');

  const primaryRef = verificationLoop.primaryArtifactRef(finished.result);
  const stored = artifactStore.get(primaryRef.id);
  assert.strictEqual(stored.trust.verifier, artifactStore.TRUST_WRITER);
  assert.strictEqual(stored.trust.policyVersion, verificationLoop.TRUST_POLICY_VERSION);
  assert.strictEqual(stored.trust.reason, 'deterministic_passed');

  evidenceLine('trust-a1', {
    taskId: task.taskId,
    status: finished.status,
    artifact: primaryRef,
    trustLevel: artifactStore.readTrustLevel(primaryRef.id),
    verifier: stored.trust.verifier,
    reason: stored.trust.reason,
    requiresReview: finished.requiresReview === true,
  });
});

// ---- a. 独立 Reviewer 通过 → independently_verified ----

test('用例a2：独立 Reviewer（独立任务）通过 → independently_verified', async () => {
  const task = makeProducerTask('trust-a2 正常任务，触发独立审校', { requiresReview: true });
  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);

  assert.strictEqual(finished.status, 'completed');
  const opened = eventsOf(task.taskId, 'verification.review_opened');
  assert.ok(opened.length >= 1, '必须真的建立独立审校任务');
  const reviewTaskId = opened[0].payload.reviewTaskId;
  assert.notStrictEqual(reviewTaskId, task.taskId, '审校必须是独立任务，不得自审自批');

  const primaryRef = verificationLoop.primaryArtifactRef(finished.result);
  const stored = artifactStore.get(primaryRef.id);
  assert.strictEqual(artifactStore.readTrustLevel(primaryRef.id), 'independently_verified');
  assert.strictEqual(stored.trust.verifier, artifactStore.TRUST_WRITER);
  assert.strictEqual(stored.trust.reason, 'independent_review_passed');
  assert.ok(
    String(stored.trust.scope || '').includes(reviewTaskId),
    'trust 记录必须能追溯到独立审校任务'
  );

  const changes = trustChangesOf(task.taskId).filter(entry => entry.artifactId === primaryRef.id);
  assert.deepStrictEqual(
    changes.map(entry => entry.reason),
    [
      'untrusted->declared|producer_declared',
      'declared->evidence_checked|deterministic_passed',
      'evidence_checked->independently_verified|independent_review_passed',
    ],
    '档位必须按有序语义逐级升'
  );

  evidenceLine('trust-a2', {
    taskId: task.taskId,
    reviewTaskId,
    artifact: primaryRef,
    trustLevel: artifactStore.readTrustLevel(primaryRef.id),
    trustScope: stored.trust.scope,
    changeReasons: changes.map(entry => entry.reason),
  });
});

// ---- b. Reviewer 判否 → 不高于 declared，且记录降级原因 ----

test('用例b：Reviewer 判否 → 降回 declared 并记录原因', async () => {
  const task = makeProducerTask('DEFECT_CONTRADICTION trust-b 结论与证据矛盾', {
    requiresReview: true,
  });
  runtime.startTask(task.taskId);
  const held = await waitForStatus(task.taskId, 'waiting_approval');

  assert.strictEqual(held.status, 'waiting_approval', '机械通过 + 审校判否 = 冲突，必须交人工');
  const opened = eventsOf(task.taskId, 'verification.review_opened');
  const reviewTask = await waitForTerminal(opened[0].payload.reviewTaskId);
  const verdict = verificationLoop.parseVerdict(reviewTask);
  assert.strictEqual(verdict.decision, 'fail', '替身审校应判定结论与证据矛盾');

  const changes = trustChangesOf(task.taskId);
  assert.ok(changes.length >= 1, '降级必须留审计');
  const artifactId = changes[changes.length - 1].artifactId;
  assert.strictEqual(artifactStore.readTrustLevel(artifactId), 'declared');
  const downgrade = changes.find(
    entry => entry.artifactId === artifactId && entry.reason === 'evidence_checked->declared|verification_conflict'
  );
  assert.ok(downgrade, '必须记录 evidence_checked -> declared 的降级原因');
  const stored = artifactStore.get(artifactId);
  assert.strictEqual(stored.trust.reason, 'verification_conflict');

  const requested = eventsOf(task.taskId, 'verification.approval_requested');
  assert.ok(requested.length >= 1);
  approvals.reject(requested[0].payload.approvalId, { reason: '信任等级用例收尾' });
  await waitForStatus(task.taskId, 'cancelled');

  evidenceLine('trust-b', {
    taskId: task.taskId,
    reviewTaskId: reviewTask.taskId,
    reviewerVerdict: verdict.decision,
    artifactId,
    trustLevel: artifactStore.readTrustLevel(artifactId),
    trustReason: stored.trust.reason,
    downgradeAudit: downgrade && downgrade.reason,
    taskStatus: tasks.getTask(task.taskId).status,
  });
});

// ---- c. 越权写入 → 被拒 + 留痕，已存值不变 ----

test('用例c：非 Verification Engine 路径写 trustLevel → 被拒并留痕', () => {
  const task = makeProducerTask('trust-c 越权写入检查');
  runtime.cancelTask(task.taskId);
  const artifact = artifactStore.persist({
    kind: 'note',
    content: { fact: '越权写入基线' },
    taskId: task.taskId,
  });
  artifactStore.setTrustLevel(artifact.id, {
    level: 'declared',
    writer: artifactStore.TRUST_WRITER,
  });
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'declared');

  const attempts = [
    () => tasks.updateTask(task.taskId, { trustLevel: 'independently_verified' }),
    () => tasks.updateTask(task.taskId, { trust: { verifier: 'runtime' } }),
    () => tasks.transitionTask(task.taskId, { to: 'completed', trustLevel: 'independently_verified' }),
    () =>
      artifactCommit.completeTask(task.taskId, {
        result: { status: 'completed', summary: '越权完成', artifacts: [] },
        trustLevel: 'independently_verified',
      }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, error => {
      assert.strictEqual(error.code, 'not_authorized');
      assert.strictEqual(error.status, 403);
      return true;
    });
  }

  // 生产者直接经 artifactStore 写入也被拒（唯一写入者边界）。
  assert.throws(
    () => artifactStore.setTrustLevel(artifact.id, { level: 'independently_verified', writer: 'runtime' }),
    error => error.code === 'not_authorized' && error.status === 403
  );
  // persist 的未知字段不会生效：产物仍从 untrusted 开始。
  const forged = artifactStore.persist({
    kind: 'note',
    content: { fact: '伪造 trustLevel' },
    taskId: task.taskId,
    trustLevel: 'independently_verified',
  });
  assert.strictEqual(artifactStore.readTrustLevel(forged.id), 'untrusted');

  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'declared', '越权写入不得改变已存值');
  assert.strictEqual(tasks.getTask(task.taskId).status, 'cancelled', '拒绝必须发生在状态变更之前');

  const rejectedEvents = eventsOf(task.taskId, 'task.trust_level_write_rejected');
  assert.strictEqual(rejectedEvents.length, 4, '四次任务写入路径越权都必须留痕');
  const modes = rejectedEvents.map(event => event.payload.mode);
  assert.strictEqual(modes.filter(mode => mode === 'updateTask').length, 2);
  assert.strictEqual(modes.filter(mode => mode === 'transitionTask').length, 2);
  const artifactRejections = artifactStore
    .auditEntries()
    .filter(entry => entry.action === 'artifact.trust_level_write_rejected' && entry.artifactId === artifact.id);
  assert.ok(artifactRejections.length >= 1, '非验证器写入产物 trustLevel 也必须留痕');

  evidenceLine('trust-c', {
    taskId: task.taskId,
    artifactId: artifact.id,
    storedTrustLevel: artifactStore.readTrustLevel(artifact.id),
    rejectedEventModes: rejectedEvents.map(event => event.payload.mode),
    artifactRejectionAudit: artifactRejections.map(entry => entry.reason),
    forgedPersistLevel: artifactStore.readTrustLevel(forged.id),
  });
});

// ---- d. 高 trustLevel 与访问权限正交 ----

test('用例d：高 trustLevel 仍读不到未共享产物', async () => {
  const task = makeProducerTask('trust-d 高信任产物仍需显式共享', { requiresReview: true });
  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  assert.strictEqual(finished.status, 'completed');

  const primaryRef = verificationLoop.primaryArtifactRef(finished.result);
  assert.strictEqual(artifactStore.readTrustLevel(primaryRef.id), 'independently_verified');

  const outsider = makeProducerTask('trust-d outsider 未获共享');
  runtime.cancelTask(outsider.taskId);
  const access = artifactStore.sharedAccess(primaryRef.id, { requesterTaskId: outsider.taskId });
  assert.strictEqual(access.ok, false, '未登记共享给该任务的读取必须被拒绝');
  assert.strictEqual(access.state, 'requester_not_allowed');
  assert.throws(
    () => artifactStore.readSharedArtifact(primaryRef.id, { requesterTaskId: outsider.taskId }),
    error => {
      assert.strictEqual(error.code, 'artifact_not_shared');
      assert.strictEqual(error.status, 409);
      return true;
    },
    '高 trustLevel 不等于读取授权'
  );

  evidenceLine('trust-d', {
    taskId: task.taskId,
    artifactId: primaryRef.id,
    trustLevel: artifactStore.readTrustLevel(primaryRef.id),
    requesterTaskId: outsider.taskId,
    sharedWith: (artifactStore.get(primaryRef.id).share || {}).taskIds || [],
    access,
    deniedCode: 'artifact_not_shared',
  });
});
