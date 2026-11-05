/* global require, process */
/**
 * Phase 3 第 1 项：验证闭环回归。
 *
 * 覆盖四件事：
 * 1) 确定性验证（不依赖模型）：结构/必填字段/引用可解析/版本一致/哈希匹配/证据可解析；
 * 2) 独立 Reviewer：审校是独立任务（不同 taskId、独立 worker 作用域），复用
 *    orchestrator → reviewer 路由，结论表达 通过/不通过/需人工 且带证据引用；
 * 3) 冲突处理：机械校验与审校相反时不得静默取一方；默认保守（不通过 + conflict）
 *    并交人工审批；
 * 4) 人工审批节点：复用 approvals.js 的 riskLevel/expiresAt，**超时绝不解释为通过**。
 *
 * 验收证据：
 * - 失败注入 ≥3 处（确定性校验失败 / 审校一致判否 / 两者冲突），每处都断言真实
 *   任务的终态与错误码，并把证据行打印成 [EVIDENCE] 前缀（可直接贴报告）；
 * - 构造缺陷样本 10 条（结构缺失、引用断链、版本不符、哈希不符、证据断链、
 *   结论缺证据、结论与证据矛盾等），统计 TP/TN/FP/FN；
 * - 审校器在混淆矩阵里是**确定性替身**（不是真实模型），真实模型检出能力"未验证"。
 *
 * 使用真实任务 / 真实产物存储 / 真实审批记录；模型用本地 HTTP stub，不依赖外部 API。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-verification-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const tasks = require('../server/agents/tasks');
const sessions = require('../server/agents/sessions');
const artifactStore = require('../server/agents/artifact-store');
const approvals = require('../server/agents/approvals');
const runtime = require('../server/agents/runtime');
const verificationLoop = require('../server/agents/verification-loop');
const conflictRecordModule = require('../server/agents/conflict-record');

let providerServer;
let providerBase;
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
    model: 'verify-test-model',
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

/**
 * 确定性替身审校器：只看"被审产物"正文，独立核对结论（claims）与证据（facts）
 * 是否一致。它不接收"样本标签"，因此混淆矩阵不是按标签作弊。
 * 真实模型下的审校质量未验证（见报告）。
 */
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
      json(res, 200, { data: [{ id: 'verify-test-model' }] });
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
      const text = lastUserText(messages);
      if (text.includes('独立审校任务')) {
        json(res, 200, completion(reviewReply(text)));
        return;
      }
      // 生产者 stub：可返回"结构化结论"，用于制造可被审校核对的矛盾。
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
      json(res, 200, completion(`已处理：${taskGoal(messages)}`));
    });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  providerBase = `http://127.0.0.1:${providerServer.address().port}/v1`;

  const apiConfigs = require('../server/api-configs');
  const config = require('../server/agents/config');
  const credentials = require('../server/agents/credentials');
  const added = apiConfigs.addModelProvider({
    name: 'Verify Test Provider',
    baseUrl: providerBase,
    apiKey: 'global-not-used',
    models: [
      {
        id: 'verify-test-model',
        name: 'Verify Test Model',
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  assert.ok(added.provider, JSON.stringify(added));
  providerId = added.provider.id;
  for (const botId of ['researcher', 'executor', 'reviewer']) {
    config.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: 'verify-test-model',
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
  verificationLoop.setFaultInjection(null);
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

async function waitForTerminal(taskId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

async function waitForStatus(taskId, status, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && (task.status === status || tasks.isTerminalStatus(task.status))) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return tasks.getTask(taskId);
}

function makeProducerTask(goal, { requiresReview = false, botId = 'researcher' } = {}) {
  const task = tasks.createTask({
    agentId: botId,
    taskType: botId === 'executor' ? 'memory.write' : 'memory.recall',
    goal,
    allowedTools: botId === 'executor' ? ['memory_search', 'memory_remember'] : ['memory_search'],
    deadlineMs: 20000,
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

// ---- 1. 独立 Reviewer 的独立性与作用域 ----

test('独立审校：不同 taskId、独立 worker 作用域、路由到 reviewer，且共享登记被审产物', async () => {
  const producer = makeProducerTask('独立性检查：产出待审结论');
  runtime.cancelTask(producer.taskId); // 只用于产物归属，避免队列把生产者再跑一遍

  const note = artifactStore.persist({
    kind: 'note',
    content: { fact: '用户偏好拿铁' },
    taskId: producer.taskId,
  });
  const conclusion = artifactStore.persist({
    kind: 'conclusion',
    content: {
      subject: '咖啡偏好',
      evidence: [{ kind: 'note', id: note.id, version: note.version }],
      claims: [{ key: 'preference', value: '拿铁' }],
      facts: [{ key: 'preference', value: '拿铁' }],
    },
    taskId: producer.taskId,
  });
  const ref = { kind: 'conclusion', id: conclusion.id, version: conclusion.version };

  const opened = verificationLoop.openReview({
    producerTaskId: producer.taskId,
    artifactRef: ref,
  });
  const reviewTask = await waitForTerminal(opened.reviewTaskId);

  assert.notStrictEqual(reviewTask.taskId, producer.taskId, '审校必须是独立任务');
  assert.strictEqual(reviewTask.botId, 'reviewer', '审校必须路由到 reviewer');
  assert.ok(reviewTask.sessionId && reviewTask.sessionId !== producer.sessionId, '独立 worker 作用域');
  const session = sessions.getSession('reviewer', reviewTask.sessionId);
  assert.ok(session, '审校任务有自己的 worker 会话');
  assert.strictEqual(session.scope, 'worker', '审校会话是 worker 作用域');
  assert.strictEqual(session.owner.taskId, reviewTask.taskId, 'worker 会话归属审校任务');

  const stored = artifactStore.get(conclusion.id);
  assert.ok(stored.share && stored.share.taskIds.includes(reviewTask.taskId), '被审产物已登记共享');
  assert.deepStrictEqual(stored.share.taskIds.filter(id => id === producer.taskId), [], '共享不回流给被审任务');

  // 自查自批必须被拒绝。
  const reviewerOwned = tasks.createTask({
    agentId: 'reviewer',
    taskType: 'review.verify',
    goal: '自审任务',
    deadlineMs: 20000,
  });
  runtime.cancelTask(reviewerOwned.taskId);
  assert.throws(
    () =>
      verificationLoop.openReview({
        producerTaskId: reviewerOwned.taskId,
        artifactRef: ref,
      }),
    error => error.code === 'verification_review_not_independent'
  );

  evidenceLine('independent-review', {
    producerTaskId: producer.taskId,
    reviewTaskId: reviewTask.taskId,
    reviewBotId: reviewTask.botId,
    reviewSessionId: reviewTask.sessionId,
    sharedWith: stored.share.taskIds,
    verdict: verificationLoop.parseVerdict(reviewTask).decision,
  });
});

// ---- 2. 注入点 A：确定性校验失败 ----

test('注入点A：确定性校验失败 → 任务不得进入 completed', async () => {
  const task = makeProducerTask('INJECT_A 正常产出，注入机械校验失败');
  verificationLoop.setFaultInjection({
    deterministic: verificationLoop.VERIFY_CODES.hash,
    taskId: task.taskId,
  });
  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  verificationLoop.setFaultInjection(null);

  assert.strictEqual(finished.status, 'failed');
  assert.strictEqual(finished.errorCode, verificationLoop.VERIFY_CODES.hash);
  assert.strictEqual(finished.result.status, 'failed');
  const rejected = eventsOf(task.taskId, 'verification.rejected');
  assert.ok(rejected.length >= 1, '拒绝必须留审计');
  assert.strictEqual(rejected[0].payload.checkCode, verificationLoop.VERIFY_CODES.hash);

  evidenceLine('inject-a', {
    taskId: task.taskId,
    finalStatus: finished.status,
    errorCode: finished.errorCode,
    event: rejected[0] && { type: rejected[0].type, payload: rejected[0].payload },
  });
});

// ---- 3. 注入点 B：机械校验失败 + Reviewer 一致判否 ----

test('注入点B：Reviewer 判否（与机械失败一致）→ 任务 failed，且审校是独立任务', async () => {
  const task = makeProducerTask('DEFECT_CONTRADICTION 结论与证据矛盾且缺证据', {
    requiresReview: true,
  });
  verificationLoop.setFaultInjection({
    deterministic: verificationLoop.VERIFY_CODES.hash,
    taskId: task.taskId,
  });
  runtime.startTask(task.taskId);
  const finished = await waitForTerminal(task.taskId);
  verificationLoop.setFaultInjection(null);

  assert.strictEqual(finished.status, 'failed');
  const reviewOpened = eventsOf(task.taskId, 'verification.review_opened');
  assert.ok(reviewOpened.length >= 1, '必须真的开了独立审校任务');
  const reviewTask = await waitForTerminal(reviewOpened[0].payload.reviewTaskId);
  assert.strictEqual(reviewTask.botId, 'reviewer');
  assert.notStrictEqual(reviewTask.taskId, task.taskId);
  const verdict = verificationLoop.parseVerdict(reviewTask);
  assert.strictEqual(verdict.decision, 'fail', '替身审校应检出结论与证据矛盾');
  assert.ok(verdict.evidence.length >= 1, '审校结论必须带证据引用');

  const rejected = eventsOf(task.taskId, 'verification.rejected');
  assert.ok(rejected.length >= 1);

  evidenceLine('inject-b', {
    taskId: task.taskId,
    reviewTaskId: reviewTask.taskId,
    reviewerVerdict: verdict.decision,
    reviewerEvidence: verdict.evidence,
    finalStatus: finished.status,
    errorCode: finished.errorCode,
    event: rejected[0] && rejected[0].payload,
  });
});

// ---- 4. 注入点 C：两者冲突 → 人工审批；超时不得视为通过 ----

test('注入点C：机械失败 vs 审校通过 → 冲突走人工审批；超时只标 overdue，任务不完成', async () => {
  const task = makeProducerTask('CLEAN_CONFLICT 机械注入失败但审校通过', {
    requiresReview: true,
  });
  verificationLoop.setFaultInjection({
    deterministic: verificationLoop.VERIFY_CODES.version,
    taskId: task.taskId,
  });
  runtime.startTask(task.taskId);
  const held = await waitForStatus(task.taskId, 'waiting_approval');
  verificationLoop.setFaultInjection(null);

  assert.strictEqual(held.status, 'waiting_approval', '冲突不得静默取一方，必须停在审批节点');
  const conflictEvents = eventsOf(task.taskId, 'verification.conflict');
  assert.ok(conflictEvents.length >= 1, '冲突必须留审计');
  assert.strictEqual(conflictEvents[0].payload.conflict, true);

  const reviewOpened = eventsOf(task.taskId, 'verification.review_opened');
  const reviewTask = await waitForTerminal(reviewOpened[0].payload.reviewTaskId);
  const verdict = verificationLoop.parseVerdict(reviewTask);
  assert.strictEqual(verdict.decision, 'pass');

  const requested = eventsOf(task.taskId, 'verification.approval_requested');
  assert.ok(requested.length >= 1);
  const approvalId = requested[0].payload.approvalId;
  const pending = approvals.getApproval(approvalId);
  assert.strictEqual(pending.status, 'pending');
  assert.strictEqual(pending.riskLevel, 'R2', '冲突审批是 R2（有 SLA）');

  // 超时：只标 overdue，状态保持 pending，任务仍是 waiting_approval（绝不通过）。
  approvals.markOverdue(approvalId, { now: Date.now() + 31 * 60 * 1000 });
  const afterTimeout = approvals.getApproval(approvalId);
  assert.strictEqual(afterTimeout.status, 'pending');
  assert.strictEqual(afterTimeout.overdue, true);
  const taskAfterTimeout = tasks.getTask(task.taskId);
  assert.strictEqual(taskAfterTimeout.status, 'waiting_approval');
  assert.notStrictEqual(taskAfterTimeout.status, 'completed');

  // 人工拒绝 → 任务 cancelled（确定的裁决路径，而非静默通过）。
  approvals.reject(approvalId, { reason: '冲突人工拒绝' });
  const cancelled = await waitForStatus(task.taskId, 'cancelled');
  assert.strictEqual(cancelled.status, 'cancelled');

  evidenceLine('inject-c', {
    taskId: task.taskId,
    reviewTaskId: reviewTask.taskId,
    reviewerVerdict: verdict.decision,
    deterministicInjected: verificationLoop.VERIFY_CODES.version,
    approval: {
      approvalId,
      riskLevel: pending.riskLevel,
      statusAfterTimeout: afterTimeout.status,
      overdue: afterTimeout.overdue,
      expiresAt: pending.expiresAt,
    },
    taskAfterTimeout: taskAfterTimeout.status,
    finalStatus: cancelled.status,
    conflictEvent: conflictEvents[0].payload,
  });
});

// ---- 5. 人工审批通过：明确的覆盖路径 ----

test('人工审批通过：冲突任务完成后仍保留人工覆盖审计（不是静默通过）', async () => {
  const task = makeProducerTask('CLEAN_APPROVE 冲突后人工批准', { requiresReview: true });
  verificationLoop.setFaultInjection({
    deterministic: verificationLoop.VERIFY_CODES.ref,
    taskId: task.taskId,
  });
  runtime.startTask(task.taskId);
  const held = await waitForStatus(task.taskId, 'waiting_approval');
  verificationLoop.setFaultInjection(null);
  assert.strictEqual(held.status, 'waiting_approval');

  const requested = eventsOf(task.taskId, 'verification.approval_requested');
  const approvalId = requested[0].payload.approvalId;
  approvals.approve(approvalId, { reason: '人工确认覆盖冲突' });
  const executed = await approvals.execute(approvalId);
  assert.strictEqual(executed.status, 'completed');
  const finished = await waitForTerminal(task.taskId);
  assert.strictEqual(finished.status, 'completed');

  evidenceLine('approval-approve', {
    taskId: task.taskId,
    approvalId,
    approvalStatus: executed.status,
    approvalResult: executed.result,
    taskStatus: finished.status,
    taskSummary: finished.result && finished.result.summary,
  });
});

// ---- 6. 裁决纯函数：双向冲突 + 保守默认 ----

test('冲突裁决：机械通过/审校否 与 机械失败/审校通过 都判 conflict；无法结论一律不通过', () => {
  const detOk = { ok: true, errorCode: null };
  const detFail = { ok: false, errorCode: verificationLoop.VERIFY_CODES.evidence };
  const reviewPass = { decision: 'pass', valid: true, evidence: [{ id: 'art_x', version: 1 }] };
  const reviewFail = { decision: 'fail', valid: true, evidence: [{ id: 'art_x', version: 1 }] };
  const reviewHuman = { decision: 'needs_human', valid: true, evidence: [] };
  const reviewBroken = { decision: 'needs_human', valid: false, code: 'review_verdict_unparseable' };

  assert.strictEqual(verificationLoop.resolveConflict(detOk, reviewPass).outcome, 'pass');
  assert.strictEqual(verificationLoop.resolveConflict(detOk, reviewFail).outcome, 'conflict');
  assert.strictEqual(verificationLoop.resolveConflict(detFail, reviewPass).outcome, 'conflict');
  assert.strictEqual(verificationLoop.resolveConflict(detFail, reviewFail).outcome, 'fail');
  assert.strictEqual(verificationLoop.resolveConflict(detOk, reviewHuman).outcome, 'needs_human');
  assert.strictEqual(verificationLoop.resolveConflict(detOk, reviewBroken).outcome, 'needs_human');
  assert.strictEqual(verificationLoop.resolveConflict(detFail, reviewHuman).outcome, 'fail');
  assert.notStrictEqual(verificationLoop.resolveConflict(detOk, reviewHuman).outcome, 'pass');
  assert.notStrictEqual(verificationLoop.resolveConflict(detOk, reviewBroken).outcome, 'pass');

  // 高风险（写记忆）且审校无法给出结论 → 审批升级为 R3，而不是直接完成。
  const highRiskTask = { allowedTools: ['memory_remember'], taskType: 'memory.write' };
  const escalated = verificationLoop.planGate({
    deterministic: detOk,
    review: reviewHuman,
    task: highRiskTask,
  });
  assert.strictEqual(escalated.action, 'approval');
  assert.strictEqual(escalated.operation, 'review.escalate');

  console.log(
    `[EVIDENCE] resolve-conflict ${JSON.stringify({
      detOk_reviewPass: verificationLoop.resolveConflict(detOk, reviewPass).outcome,
      detOk_reviewFail: verificationLoop.resolveConflict(detOk, reviewFail).outcome,
      detFail_reviewPass: verificationLoop.resolveConflict(detFail, reviewPass).outcome,
      detFail_reviewFail: verificationLoop.resolveConflict(detFail, reviewFail).outcome,
      detOk_reviewUnparseable: verificationLoop.resolveConflict(detOk, reviewBroken).outcome,
    })}`
  );
});

// ---- 7. Reviewer 检出率（构造样本混淆矩阵）----

test('构造样本检出率：10 条样本的 TP/TN/FP/FN（构造样本，不代表真实缺陷分布）', async () => {
  const samples = buildSamples();
  const results = [];
  for (const sample of samples) {
    results.push(await evaluateSample(sample));
  }

  const tp = results.filter(item => item.label === 1 && item.flagged).length;
  const fn = results.filter(item => item.label === 1 && !item.flagged).length;
  const tn = results.filter(item => item.label === 0 && !item.flagged).length;
  const fp = results.filter(item => item.label === 0 && item.flagged).length;
  const detectionRate = tp + fn === 0 ? 0 : tp / (tp + fn);
  const falsePositiveRate = fp + tn === 0 ? 0 : fp / (fp + tn);

  assert.strictEqual(results.filter(item => item.label === 1).length, 7, '7 条缺陷样本');
  assert.strictEqual(results.filter(item => item.label === 0).length, 3, '3 条干净样本');
  // 缺陷样本全部被拒（确定性校验或独立审校拦下），干净样本中 2 条通过。
  assert.strictEqual(tp, 7);
  assert.strictEqual(fn, 0);
  assert.strictEqual(tn, 2);
  assert.strictEqual(fp, 1);

  console.log(
    `[EVIDENCE] confusion-matrix ${JSON.stringify({
      note: '构造样本，不代表真实缺陷分布；审校器为确定性替身，真实模型检出能力未验证',
      TP: tp,
      FN: fn,
      TN: tn,
      FP: fp,
      detectionRate,
      falsePositiveRate,
      rows: results.map(item => ({
        id: item.id,
        label: item.label,
        flagged: item.flagged,
        stage: item.stage,
        detail: item.detail,
      })),
    })}`
  );
});

function buildSamples() {
  return [
    {
      id: 'clean_message',
      label: 0,
      build: taskId => {
        const message = artifactStore.persist({
          kind: 'message',
          content: { text: '已处理：普通检索' },
          taskId,
        });
        return {
          summary: '已处理：普通检索',
          refs: [{ kind: 'message', id: message.id, version: message.version }],
        };
      },
    },
    {
      id: 'clean_conclusion',
      label: 0,
      build: taskId => {
        const note = artifactStore.persist({
          kind: 'note',
          content: { fact: '用户偏好拿铁' },
          taskId,
        });
        const conclusion = artifactStore.persist({
          kind: 'conclusion',
          content: {
            subject: '咖啡偏好',
            evidence: [{ kind: 'note', id: note.id, version: note.version }],
            claims: [{ key: 'preference', value: '拿铁' }],
            facts: [{ key: 'preference', value: '拿铁' }],
          },
          taskId,
        });
        return {
          summary: '咖啡偏好结论',
          refs: [{ kind: 'conclusion', id: conclusion.id, version: conclusion.version }],
        };
      },
    },
    {
      id: 'clean_ambiguous',
      label: 0,
      build: taskId => {
        const note = artifactStore.persist({ kind: 'note', content: { fact: '线索' }, taskId });
        const conclusion = artifactStore.persist({
          kind: 'conclusion',
          content: {
            subject: '待定结论',
            evidence: [{ kind: 'note', id: note.id, version: note.version }],
            claims: [{ key: 'k', value: 'v' }],
            facts: [],
          },
          taskId,
        });
        return {
          summary: '待定结论',
          refs: [{ kind: 'conclusion', id: conclusion.id, version: conclusion.version }],
        };
      },
    },
    {
      id: 'structure_missing_summary',
      label: 1,
      build: taskId => {
        const message = artifactStore.persist({ kind: 'message', content: { text: 'x' }, taskId });
        return {
          summary: '',
          refs: [{ kind: 'message', id: message.id, version: message.version }],
        };
      },
    },
    {
      id: 'ref_dangling',
      label: 1,
      build: taskId => {
        const message = artifactStore.persist({ kind: 'message', content: { text: 'x' }, taskId });
        return {
          summary: '引用断链',
          refs: [{ kind: 'message', id: `${message.id}_missing`, version: 1 }],
        };
      },
    },
    {
      id: 'version_mismatch',
      label: 1,
      build: taskId => {
        const message = artifactStore.persist({ kind: 'message', content: { text: 'x' }, taskId });
        return {
          summary: '版本不符',
          refs: [{ kind: 'message', id: message.id, version: message.version + 1 }],
        };
      },
    },
    {
      id: 'hash_mismatch',
      label: 1,
      build: taskId => {
        const message = artifactStore.persist({ kind: 'message', content: { text: 'x' }, taskId });
        tamperArtifactContent(message.id, { text: '被篡改的正文' });
        return {
          summary: '哈希不符',
          refs: [{ kind: 'message', id: message.id, version: message.version }],
        };
      },
    },
    {
      id: 'evidence_broken',
      label: 1,
      build: taskId => {
        const conclusion = artifactStore.persist({
          kind: 'conclusion',
          content: {
            subject: '证据断链',
            evidence: [{ kind: 'note', id: 'art_missing_evidence', version: 1 }],
            claims: [{ key: 'k', value: 'v' }],
            facts: [{ key: 'k', value: 'v' }],
          },
          taskId,
        });
        return {
          summary: '证据断链',
          refs: [{ kind: 'conclusion', id: conclusion.id, version: conclusion.version }],
        };
      },
    },
    {
      id: 'conclusion_without_evidence',
      label: 1,
      build: taskId => {
        const conclusion = artifactStore.persist({
          kind: 'conclusion',
          content: {
            subject: '结论缺证据',
            claims: [{ key: 'k', value: 'v' }],
            facts: [{ key: 'k', value: 'v' }],
          },
          taskId,
        });
        return {
          summary: '结论缺证据',
          refs: [{ kind: 'conclusion', id: conclusion.id, version: conclusion.version }],
        };
      },
    },
    {
      id: 'claim_contradicts_evidence',
      label: 1,
      build: taskId => {
        const note = artifactStore.persist({
          kind: 'note',
          content: { fact: '证据是美式' },
          taskId,
        });
        const conclusion = artifactStore.persist({
          kind: 'conclusion',
          content: {
            subject: '结论与证据矛盾',
            evidence: [{ kind: 'note', id: note.id, version: note.version }],
            claims: [{ key: 'preference', value: '拿铁' }],
            facts: [{ key: 'preference', value: '美式' }],
          },
          taskId,
        });
        return {
          summary: '结论与证据矛盾',
          refs: [{ kind: 'conclusion', id: conclusion.id, version: conclusion.version }],
        };
      },
    },
  ];
}

function tamperArtifactContent(id, content) {
  const file = path.join(TMP, 'agents', 'artifact-contents', `${id}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.content = content;
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
}

async function evaluateSample(sample) {
  const task = makeProducerTask(`缺陷样本 ${sample.id}`);
  runtime.cancelTask(task.taskId);
  const built = sample.build(task.taskId);
  const result = { status: 'completed', summary: built.summary, artifacts: built.refs };
  const deterministic = verificationLoop.verifyDeterministic({
    taskId: task.taskId,
    result,
  });

  let review = null;
  let plan;
  let stage;
  if (!deterministic.ok) {
    stage = 'deterministic';
    plan = { outcome: 'fail', action: 'reject', errorCode: deterministic.errorCode };
  } else {
    const primary = verificationLoop.primaryArtifactRef(result);
    const opened = verificationLoop.openReview({
      producerTaskId: task.taskId,
      artifactRef: primary,
    });
    const reviewTask = await waitForTerminal(opened.reviewTaskId);
    review = verificationLoop.parseVerdict(reviewTask);
    plan = verificationLoop.planGate({ deterministic, review, task });
    stage = plan.action === 'complete' ? 'pass' : `review:${review.decision}`;
  }
  return {
    id: sample.id,
    label: sample.label,
    flagged: plan.action !== 'complete',
    stage,
    detail: plan.errorCode || (review && review.code) || null,
  };
}

// ---- 8. A-04 冲突裁决权 / 证据顺序 / 升级路径 ----

function makeConflictRecord({ subjectKey, conflictType = 'factual', candidateRefs = ['art_a', 'art_b'] }) {
  const record = conflictRecordModule.createRecord({
    subjectKey,
    conflictType,
    candidateRefs,
    evidenceRefs: ['evidence:fixture'],
    rationale: 'A-04 测试构造',
  });
  conflictRecordModule.persist(record);
  return record;
}

test('A-04 证据不足 → 自动仲裁拒绝，升级走既有 review.conflict 审批', () => {
  const record = makeConflictRecord({ subjectKey: 'a04-insufficient' });
  // 机械证据不结论（ok=null），无独立审校证据 → 自动裁决必须拒绝。
  const decision = verificationLoop.arbitrateConflict({
    conflictRecord: record,
    arbiter: verificationLoop.ARBITERS.verificationEngine,
    evidence: [{ source: 'deterministic', ok: null }],
  });
  assert.strictEqual(decision.status, 'denied');
  assert.strictEqual(decision.errorCode, 'arbiter_evidence_insufficient');
  assert.strictEqual(decision.policyVersion, 'conflict-arbitration-v1');

  const producer = makeProducerTask('A-04 证据不足升级');
  runtime.cancelTask(producer.taskId);
  const approval = verificationLoop.escalateConflict({
    producerTask: producer,
    conflictRecord: record,
    reason: '证据不足，无法自动裁决',
  });
  assert.strictEqual(approval.operation, 'review.conflict');
  assert.ok(['review.conflict', 'review.escalate'].includes(approval.operation));
  assert.strictEqual(
    conflictRecordModule.getRecord(record.conflictId).resolutionStatus,
    'escalated'
  );
  console.log(
    `[EVIDENCE] a04-escalate ${JSON.stringify({
      decision: decision.status,
      errorCode: decision.errorCode,
      approvalId: approval.approvalId,
      operation: approval.operation,
      recordStatus: conflictRecordModule.getRecord(record.conflictId).resolutionStatus,
      policyVersion: decision.policyVersion,
    })}`
  );
});

test('A-04 证据冲突 → 按证据顺序裁决并留痕（机械事实优先于独立审校）', () => {
  const record = makeConflictRecord({ subjectKey: 'a04-precedence' });
  const evidence = [
    { source: 'reviewer', ok: false, independent: true, reviewerTaskId: 'task_review_1' },
    { source: 'deterministic', ok: true, candidateRef: 'art_a', code: null },
  ];
  // 独立性：与生产者不同任务且是 reviewer bot。
  assert.strictEqual(
    verificationLoop.isIndependentReviewEvidence({
      reviewerTaskId: 'task_review_1',
      producerTaskId: 'task_producer',
      reviewerBotId: 'reviewer',
    }),
    true
  );
  assert.strictEqual(
    verificationLoop.isIndependentReviewEvidence({
      reviewerTaskId: 'task_producer',
      producerTaskId: 'task_producer',
      reviewerBotId: 'reviewer',
    }),
    false
  );

  const decision = verificationLoop.arbitrateConflict({
    conflictRecord: record,
    arbiter: verificationLoop.ARBITERS.verificationEngine,
    evidence,
  });
  assert.strictEqual(decision.status, 'resolved');
  assert.strictEqual(decision.selectedCandidateRef, 'art_a');
  assert.strictEqual(decision.method, 'rule');
  assert.strictEqual(decision.rationale, 'deterministic_precedence');
  // 证据顺序：deterministic(3) 必须排在 independent-review(2) 之前。
  assert.strictEqual(decision.evidenceOrder[0].source, 'deterministic');
  assert.strictEqual(decision.evidenceOrder[0].precedence, 3);
  assert.strictEqual(decision.evidenceOrder[1].source, 'reviewer');
  assert.strictEqual(decision.evidenceOrder[1].precedence, 2);

  const producer = makeProducerTask('A-04 顺序裁决');
  runtime.cancelTask(producer.taskId);
  const stored = verificationLoop.recordArbitration({
    conflictRecord: record,
    decision,
    producerTask: producer,
    runId: 'run_a04',
  });
  assert.strictEqual(stored.resolutionStatus, 'resolved');
  assert.strictEqual(stored.resolutionMethod, 'rule');
  assert.strictEqual(stored.selectedCandidateRef, 'art_a');
  assert.strictEqual(stored.decidedBy, 'verification-engine');

  const event = tasks
    .listEvents(producer.botId, { limit: 200 })
    .find(
      item =>
        item.taskId === producer.taskId &&
        item.eventType === 'verification.verdict' &&
        item.payload &&
        item.payload.ruleId === 'deterministic_precedence'
    );
  assert.ok(event, '裁决必须留下可追审计事件');
  assert.strictEqual(event.payload.policyVersion, 'conflict-arbitration-v1');
  console.log(
    `[EVIDENCE] a04-precedence ${JSON.stringify({
      decision: decision.status,
      rationale: decision.rationale,
      order: decision.evidenceOrder,
      selected: stored.selectedCandidateRef,
      auditRuleId: event.payload.ruleId,
    })}`
  );
});

test('A-04 裁决者越权被拒：reviewer 不得推翻机械结论，未知主体/越界类型一律 403', () => {
  const record = makeConflictRecord({ subjectKey: 'a04-denied' });
  const deterministicOnly = [{ source: 'deterministic', ok: true, candidateRef: 'art_a' }];

  // reviewer 在机械证据已结论时越权。
  const reviewerDenied = verificationLoop.arbitrateConflict({
    conflictRecord: record,
    arbiter: verificationLoop.ARBITERS.reviewer,
    evidence: deterministicOnly,
  });
  assert.strictEqual(reviewerDenied.status, 'denied');
  assert.strictEqual(reviewerDenied.errorCode, 'arbiter_scope_exceeded');
  assert.throws(
    () =>
      verificationLoop.recordArbitration({
        conflictRecord: record,
        decision: reviewerDenied,
      }),
    error => error.code === 'arbiter_scope_exceeded' && error.status === 403
  );
  // 越权被拒后记录保持 open，未被静默改写。
  assert.strictEqual(conflictRecordModule.getRecord(record.conflictId).resolutionStatus, 'open');

  // policy 类冲突只能人工，reviewer 越界。
  const policyRecord = makeConflictRecord({
    subjectKey: 'a04-policy',
    conflictType: 'policy',
  });
  const policyDenied = verificationLoop.arbitrateConflict({
    conflictRecord: policyRecord,
    arbiter: verificationLoop.ARBITERS.reviewer,
    evidence: [{ source: 'reviewer', ok: true, independent: true, candidateRef: 'art_a' }],
  });
  assert.strictEqual(policyDenied.errorCode, 'arbiter_scope_exceeded');

  // 未知裁决主体一律拒绝。
  const unknown = verificationLoop.authorizeArbiter({
    arbiter: 'gateway',
    conflictType: 'factual',
    evidence: [],
  });
  assert.strictEqual(unknown.allowed, false);
  assert.strictEqual(unknown.errorCode, 'arbiter_unknown');
  console.log(
    `[EVIDENCE] a04-denied ${JSON.stringify({
      reviewer: reviewerDenied.errorCode,
      policy: policyDenied.errorCode,
      unknown: unknown.errorCode,
      recordStatus: conflictRecordModule.getRecord(record.conflictId).resolutionStatus,
    })}`
  );
});
