/* global module */
/**
 * P5-C2：对外发布门（publish-gate-v1）。
 *
 * 计划级声明（workflow-store PLAN_KEYS 的可选 `publishGate` 字段）：
 *   publishGate: { required: true, taskType?: 'memory.explain' }
 * 命中门（任务绑定该计划，且声明了 taskType 时必须匹配；未声明 taskType 视为
 * 计划内全部任务命中）的任务在验证通过后不直接 completed，而是：
 *   1. 把待交付结果落一份 kind='delivery' 的产物（pending-commit；引用随审批
 *      收口统一 confirm，未获批则按既有 TTL 收敛为 orphan——不交付不留正文副本）；
 *   2. `approvals.createApproval({operation:'plan.publish', taskId})` → 任务经既有
 *      moveTaskToApproval 停在 waiting_approval（不新造状态）；
 *   3. 批准 → approvals.execute → `deliverOnApproval`：读回 delivery 产物 →
 *      artifactCommit.completeTask（提交产物 + 任务 completed）→ result-delivery
 *      幂等回写父会话（bot-result-<taskId> 去重）；
 *   4. 拒绝 / 超时 → 既有 decide() 与 convergeExpiredWaitingApproval 收口任务，
 *      交付永不发生（fail-closed）。
 *
 * 审批记录 payload 只收固定标量键（正文进产物，不进审批记录）。
 */
const tasks = require('./tasks');
const workflowStore = require('./workflow-store');
const artifactStore = require('./artifact-store');
const artifactCommit = require('./artifact-commit');
const { normalizeWorkerResult } = require('./worker-result');

const PUBLISH_GATE_POLICY_VERSION = 'publish-gate-v1';
const SUMMARY_MAX = 8000;

function nowIso() {
  return new Date().toISOString();
}

function recordEvent(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({ botId: botId || 'system', eventType, payload, ...context });
  } catch (_) {
    /* 事件失败不改变门判定 */
  }
}

/**
 * 任务是否命中发布门。计划读不回（已被运行入口 fail-closed 收敛过）时返回 null，
 * 不在此重复拦截；没有计划血缘的任务永不命中。
 */
function gateForTask(task) {
  if (!task || !task.planId || !task.planVersion) return null;
  let plan;
  try {
    plan = workflowStore.getVersion(task.planId, task.planVersion);
  } catch (error) {
    console.warn(
      `[publish-gate] plan unreadable plan=${task.planId} code=${
        (error && error.code) || 'plan_unreadable'
      }`
    );
    return null;
  }
  const gate = plan.plan && plan.plan.publishGate;
  if (!gate || typeof gate !== 'object' || gate.required !== true) return null;
  if (gate.taskType && String(gate.taskType) !== String(task.taskType || '')) return null;
  return { planId: plan.planId, planVersion: plan.planVersion, publishGate: gate };
}

/**
 * 提出发布审批：结果落 delivery 产物（pending-commit），任务停 waiting_approval。
 * 返回审批快照；失败抛错由调用方 fail-safe（任务仍 running，走正常 completed）。
 */
function requestPublishApproval({ task, finalResult, runId = null, now = Date.now() } = {}) {
  const approvals = require('./approvals');
  if (!task || !task.taskId) throw new Error('publish gate: task required');
  const summary = String((finalResult && finalResult.summary) || '');
  const artifactRefs = Array.isArray(finalResult && finalResult.artifacts)
    ? finalResult.artifacts.filter(ref => ref && ref.id)
    : [];
  const staged = artifactStore.persist({
    kind: 'delivery',
    content: {
      goal: String(task.goal || '').slice(0, 2000),
      summary: summary.slice(0, SUMMARY_MAX),
      artifacts: artifactRefs,
      status: 'pending_publish',
    },
    taskId: task.taskId,
    runId: runId || null,
    provenanceRefs: Array.isArray(task.provenanceRefs) ? task.provenanceRefs : [],
    sourceLabels: ['agent:derived'],
    now,
  });
  const approval = approvals.createApproval({
    botId: task.agentId,
    operation: 'plan.publish',
    payload: {
      producerTaskId: task.taskId,
      planId: task.planId,
      planVersion: String(task.planVersion),
      deliveryArtifactId: staged.id,
      deliveryArtifactVersion: String(staged.version),
      taskType: String(task.taskType || ''),
    },
    taskId: task.taskId,
    sessionId: task.sessionId || null,
    requestedBy: 'agent',
  });
  recordEvent(
    task.agentId,
    'plan.publish_requested',
    {
      planId: task.planId,
      planVersion: task.planVersion,
      deliveryArtifactId: staged.id,
      taskType: task.taskType,
    },
    { taskId: task.taskId, runId: runId || null, sessionId: task.sessionId || null }
  );
  return { approval, stagedRef: { kind: staged.kind, id: staged.id, version: staged.version } };
}

function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    if (!ref || !ref.id || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/**
 * 审批批准后的交付（唯一副作用）：delivery 产物 → 结果收口 → 幂等回写父会话。
 * 产物链失败按既有审批语义收口 recovery，不静默 completed。
 */
function deliverOnApproval(record, { actor = null, now = Date.now() } = {}) {
  const resultDelivery = require('./result-delivery');
  const taskId = record && record.taskId;
  const payload = (record && record.payload) || {};
  if (!taskId) throw new Error('publish gate: approval without task');
  const task = tasks.getRawTask(taskId);
  if (!task) throw new Error('publish gate: task missing');
  if (task.status !== 'waiting_approval') {
    const error = new Error('publish gate: task not waiting_approval');
    error.code = 'task_not_waiting_approval';
    throw error;
  }
  tasks.transitionTask(taskId, { to: 'running' });
  try {
    const version = Number(payload.deliveryArtifactVersion);
    // readContent 返回 {content: <正文>} 包裹；正文才是 staging 写入的 JSON 对象。
    const stagedRead = artifactStore.readContent(String(payload.deliveryArtifactId || ''), {
      version: Number.isInteger(version) && version > 0 ? version : undefined,
    });
    const body =
      stagedRead && typeof stagedRead === 'object' && stagedRead.content
        ? stagedRead.content
        : stagedRead;
    const contentRefs = body && Array.isArray(body.artifacts) ? body.artifacts : [];
    const deliveryRef = {
      kind: 'delivery',
      id: String(payload.deliveryArtifactId),
      version: Number.isInteger(version) && version > 0 ? version : 1,
    };
    const finishedAt = nowIso(now);
    const result = normalizeWorkerResult({
      status: 'completed',
      summary: String((body && body.summary) || '').slice(0, SUMMARY_MAX),
      artifacts: dedupeRefs([deliveryRef, ...contentRefs]),
      toolSteps: [],
      evidence: [],
      changes: [],
      requiresConfirmation: false,
      rounds: 0,
      stopReason: 'publish_gate',
      model: null,
      runId: task.runId || null,
      finishedAt,
    });
    artifactCommit.completeTask(taskId, { completedAt: finishedAt, result });
    tasks.recordRunFinish(taskId, {
      runId: result.runId,
      status: 'completed',
      finishedAt,
    });
    tasks.releaseLease(taskId);
    resultDelivery.deliverTaskOutcome(taskId, { status: 'completed', result });
    recordEvent(
      task.agentId,
      'task.completed',
      { status: 'completed', rounds: 0, toolCalls: 0, stopReason: 'publish_gate' },
      { taskId, runId: result.runId, sessionId: task.sessionId }
    );
    return {
      ref: deliveryRef,
      result,
      deliveredBy: String(actor || '').slice(0, 80) || null,
      policyVersion: PUBLISH_GATE_POLICY_VERSION,
    };
  } catch (error) {
    // 产物链失败：不能留在 running，也不能当作 completed——收口 recovery 等人工核对
    //（与 completeApprovalTask 的既有 catch 同口径）。
    const current = tasks.getRawTask(taskId);
    if (
      error &&
      typeof error.code === 'string' &&
      error.code.startsWith('artifact_') &&
      current &&
      current.status === 'running'
    ) {
      const recoveryResult = normalizeWorkerResult({
        status: 'recovery',
        summary: '',
        errorCode: error.code,
        runId: current.runId || null,
        finishedAt: nowIso(now),
      });
      tasks.transitionTask(taskId, {
        to: 'recovery',
        completedAt: recoveryResult.finishedAt,
        errorCode: error.code,
        result: recoveryResult,
      });
      const resultDelivery = require('./result-delivery');
      resultDelivery.deliverTaskOutcome(taskId, {
        status: 'recovery',
        result: recoveryResult,
        errorCode: error.code,
      });
    }
    throw error;
  }
}

module.exports = {
  gateForTask,
  requestPublishApproval,
  deliverOnApproval,
  PUBLISH_GATE_POLICY_VERSION,
};
