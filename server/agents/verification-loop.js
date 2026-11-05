/* global module */
/**
 * Phase 3 第 1 项：验证闭环（确定性验证 + 独立 Reviewer + 冲突裁决 + 人工审批节点）。
 *
 * 职责边界：
 * - 确定性验证：只做不依赖模型的机械校验（结构/必填字段/引用可解析/版本一致/哈希匹配/
 *   证据可解析/来源链完整），失败即拒绝，不进入 completed。
 * - 独立审校：审校必须是一个**独立任务**（不同 taskId、独立 worker 作用域，由既有
 *   orchestrator 路由到 reviewer），本模块只负责登记与解析结论，不自己执行模型。
 * - 冲突裁决：机械校验与审校结论相反时，绝不静默取一方；默认保守（不通过）+ 标记
 *   conflict，交给人工审批节点。
 * - 人工审批：复用 approvals.js（riskLevel/expiresAt/超时只标 overdue，绝不自动通过），
 *   只新增两个受控的"门禁操作"（review.conflict / review.escalate）。
 *
 * 不新增 HTTP 路由、不改 state-machine.js / 状态词表、不重建产物存储。
 */
const tasks = require('./tasks');
const artifactStore = require('./artifact-store');
const artifactCommit = require('./artifact-commit');
const approvals = require('./approvals');
const orchestrator = require('./orchestrator');
const { AgentError } = require('./errors');

const REVIEWER_BOT_ID = 'reviewer';
const REVIEW_CAPABILITY = 'review.verify';
const REVIEW_TASK_TYPE = 'review.verify';
const REVIEW_GOAL_MAX = 2000;
const REVIEW_CONTENT_MAX = 1200;
const REVIEW_EVIDENCE_MAX = 8;

// 确定性验证错误码：每个都对应一类机械失败，直接写入任务 errorCode。
const VERIFY_CODES = Object.freeze({
  structure: 'verification_structure_invalid',
  field: 'verification_field_missing',
  ref: 'verification_ref_unresolvable',
  version: 'verification_version_mismatch',
  hash: 'verification_hash_mismatch',
  evidence: 'verification_evidence_invalid',
  provenance: 'verification_provenance_broken',
});

// 裁决结果码（非确定性校验码）。
const DECISION_CODES = Object.freeze({
  conflict: 'verification_conflict',
  reviewRejected: 'review_rejected',
  reviewNeedsHuman: 'review_needs_human',
});

// §27：Verification Engine 是 trustLevel 的唯一写入者。策略版本取值原文未定义（待确认）。
const TRUST_POLICY_VERSION = 'trust-rules-v1';

// 仅测试使用的故障注入。生产默认关闭；用于验收要求的"失败注入"，注入的是一个
// 校验错误码，不是伪造产物——真实的哈希/引用损坏另有常规用例覆盖。
let faultInjection = null;

function setFaultInjection(next) {
  faultInjection = next && typeof next === 'object' ? { ...next } : null;
}

function failure(name, code, detail = '') {
  return { name, ok: false, code, detail: String(detail || '').slice(0, 200) };
}

function mapStoreCode(errorCode) {
  if (errorCode === 'artifact_content_corrupted') return VERIFY_CODES.hash;
  if (errorCode === 'artifact_version_mismatch') return VERIFY_CODES.version;
  if (
    errorCode === 'artifact_not_found' ||
    errorCode === 'artifact_content_missing' ||
    errorCode === 'artifact_content_too_large'
  ) {
    return VERIFY_CODES.ref;
  }
  return VERIFY_CODES.ref;
}

/**
 * 确定性验证（不依赖模型）。
 * @returns {{ok:boolean, errorCode:string|null, failures:Array, checks:Array, artifactCount:number}}
 */
function verifyDeterministic({ taskId = null, result = null, now = Date.now() } = {}) {
  const failures = [];
  const refs = [];
  const result_ = result && typeof result === 'object' && !Array.isArray(result) ? result : null;

  if (!result_) {
    failures.push(failure('result_shape', VERIFY_CODES.structure, '结果对象缺失'));
  } else if (result_.status !== 'completed') {
    failures.push(
      failure('result_shape', VERIFY_CODES.structure, `result.status=${String(result_.status)}`)
    );
  }
  if (result_) {
    const summary = typeof result_.summary === 'string' ? result_.summary.trim() : '';
    if (!summary) failures.push(failure('required_fields', VERIFY_CODES.field, 'summary 为空'));
    if (result_.artifacts !== undefined && !Array.isArray(result_.artifacts)) {
      failures.push(failure('result_shape', VERIFY_CODES.structure, 'artifacts 不是数组'));
    }
    if (Array.isArray(result_.artifacts)) refs.push(...result_.artifacts);
  }

  const seen = new Set();
  for (const ref of refs) {
    const label = ref && ref.id ? String(ref.id) : 'unknown';
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      failures.push(failure('artifact_refs', VERIFY_CODES.structure, '产物引用不是对象'));
      continue;
    }
    const kind = typeof ref.kind === 'string' ? ref.kind.trim() : '';
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    if (!kind || !id) {
      failures.push(failure('required_fields', VERIFY_CODES.field, `引用字段缺失 ${label}`));
      continue;
    }
    if (!Number.isInteger(ref.version) || ref.version < 1) {
      failures.push(
        failure('required_fields', VERIFY_CODES.field, `引用未钉住 version ${label}`)
      );
      continue;
    }
    if (seen.has(`${id}@${ref.version}`)) continue;
    seen.add(`${id}@${ref.version}`);

    const stored = artifactStore.get(id);
    if (!stored) {
      failures.push(failure('refs_resolvable', VERIFY_CODES.ref, `产物不存在 ${id}`));
      continue;
    }
    if (stored.status !== 'active') {
      failures.push(
        failure('refs_resolvable', VERIFY_CODES.ref, `产物不可用 ${id}:${String(stored.status)}`)
      );
    }
    if (stored.kind !== kind) {
      failures.push(
        failure('version_consistent', VERIFY_CODES.version, `kind 不一致 ${id}:${kind}`)
      );
    }
    if (stored.version !== ref.version) {
      failures.push(
        failure(
          'version_consistent',
          VERIFY_CODES.version,
          `版本不一致 ${id}: ref=${ref.version} store=${stored.version}`
        )
      );
      continue;
    }

    let content;
    try {
      // 复读正文并校验 contentHash；读不回来等价于失败（fail-closed）。
      content = artifactStore.readContent(id, { version: ref.version });
    } catch (error) {
      failures.push(
        failure(
          'content_readable',
          mapStoreCode(error && error.code),
          `${id}: ${(error && error.code) || 'read_failed'}`
        )
      );
      continue;
    }
    if (content.contentHash !== stored.contentHash) {
      // readContent 已校验一次；这里再核对回读值与索引一致，双保险。
      failures.push(failure('hash_match', VERIFY_CODES.hash, `哈希不一致 ${id}`));
    }

    const evidence = content.content && content.content.evidence;
    if (content.kind === 'conclusion' && (!Array.isArray(evidence) || evidence.length === 0)) {
      // 结论产物必须携带可解析证据（与 Phase 2 的 fail-closed 语义一致）。
      failures.push(
        failure('evidence_resolvable', VERIFY_CODES.evidence, `结论缺少证据引用 ${id}`)
      );
    }
    if (Array.isArray(evidence) && evidence.length > 0) {
      if (evidence.length > REVIEW_EVIDENCE_MAX) {
        failures.push(
          failure('evidence_resolvable', VERIFY_CODES.evidence, `证据过多 ${id}`)
        );
      }
      for (const item of evidence) {
        if (!item || typeof item !== 'object' || !item.id) {
          failures.push(failure('evidence_resolvable', VERIFY_CODES.evidence, `证据缺 id ${id}`));
          continue;
        }
        if (!Number.isInteger(item.version) || item.version < 1) {
          failures.push(
            failure('evidence_resolvable', VERIFY_CODES.evidence, `证据未钉版本 ${id}`)
          );
          continue;
        }
        try {
          artifactStore.readContent(String(item.id), { version: item.version });
        } catch (error) {
          failures.push(
            failure(
              'evidence_resolvable',
              VERIFY_CODES.evidence,
              `${String(item.id)}: ${(error && error.code) || 'read_failed'}`
            )
          );
        }
      }
    }

    if (content.kind === 'conclusion') {
      try {
        artifactStore.resolveProvenance(id, { version: ref.version });
      } catch (error) {
        failures.push(
          failure(
            'provenance_intact',
            VERIFY_CODES.provenance,
            `${id}: ${(error && error.code) || 'chain_broken'}`
          )
        );
      }
    }
  }

  if (
    faultInjection &&
    faultInjection.deterministic &&
    (!faultInjection.taskId || String(faultInjection.taskId) === String(taskId || ''))
  ) {
    failures.push(
      failure('fault_injection', String(faultInjection.deterministic), '测试注入的确定性校验失败')
    );
  }

  const checkNames = [
    'result_shape',
    'required_fields',
    'artifact_refs',
    'refs_resolvable',
    'version_consistent',
    'content_readable',
    'hash_match',
    'evidence_resolvable',
    'provenance_intact',
    'fault_injection',
  ];
  const checks = checkNames.map(name => ({
    name,
    ok: !failures.some(item => item.name === name),
    code: (failures.find(item => item.name === name) || {}).code || null,
  }));

  return {
    ok: failures.length === 0,
    errorCode: failures.length ? failures[0].code : null,
    failures,
    checks,
    artifactCount: refs.length,
    taskId: taskId ? String(taskId) : null,
    verifiedAt: new Date(now).toISOString(),
  };
}

/** 选取送审产物：优先 conclusion，其次 message，最后第一个引用。 */
function primaryArtifactRef(result) {
  const refs =
    result && Array.isArray(result.artifacts) ? result.artifacts.filter(Boolean) : [];
  const chosen =
    refs.find(ref => ref.kind === 'conclusion') ||
    refs.find(ref => ref.kind === 'message') ||
    refs[0];
  return chosen ? { kind: chosen.kind, id: chosen.id, version: chosen.version } : null;
}

function audit(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({
      botId,
      taskId: context.taskId || null,
      runId: context.runId || null,
      sessionId: context.sessionId || null,
      eventType,
      payload,
    });
  } catch (error) {
    console.warn(
      `[verification] event write failed type=${eventType} code=${
        (error && error.code) || 'event_write_failed'
      }`
    );
  }
}

function buildReviewGoal({ producerTaskId, ref, content }) {
  let body = '';
  try {
    body = JSON.stringify(content === undefined ? null : content);
  } catch (_) {
    body = String(content);
  }
  if (body.length > REVIEW_CONTENT_MAX) body = `${body.slice(0, REVIEW_CONTENT_MAX)}…`;
  const goal = [
    '独立审校任务：只按"被审产物"的正文核对结论与证据是否一致，不得采信生产者的自述。',
    `被审产物：kind=${ref.kind} id=${ref.id} version=${ref.version} 生产者任务=${producerTaskId}`,
    `产物正文(JSON)：${body}`,
    '输出要求：只输出一行 JSON：',
    '{"decision":"pass|fail|needs_human","evidence":[{"id":"art_...","version":1}],"reasons":["..."]}',
    '其中 pass/fail 必须携带至少一条可解析的产物证据；缺证据一律按 needs_human 处理。',
  ].join('\n');
  return goal.length > REVIEW_GOAL_MAX ? goal.slice(0, REVIEW_GOAL_MAX) : goal;
}

/**
 * 建立独立审校任务（复用既有 orchestrator → reviewer 路由）。
 * 独立性硬约束：审校任务必须有不同 taskId，且生产者不能是 reviewer 自己。
 */
function openReview({ producerTaskId, artifactRef, runId = null, now = Date.now() } = {}) {
  const producer = tasks.getRawTask(producerTaskId);
  if (!producer) throw new AgentError('task_not_found', '生产者任务不存在', 404);
  if (producer.botId === REVIEWER_BOT_ID) {
    throw new AgentError(
      'verification_review_not_independent',
      '审校任务不得由被审主体自查自批',
      409
    );
  }
  const ref = artifactRef && artifactRef.id ? artifactRef : null;
  if (!ref) throw new AgentError('artifact_ref_invalid', '缺少送审产物引用', 400);

  let content;
  try {
    content = artifactStore.readContent(ref.id, { version: ref.version });
  } catch (_) {
    throw new AgentError(
      'verification_ref_unresolvable',
      '送审产物不可读，无法建立审校任务',
      409,
      { artifactId: String(ref.id) }
    );
  }

  const goal = buildReviewGoal({ producerTaskId: producer.taskId, ref, content: content.content });
  const result = orchestrator.orchestrate(
    {
      agentId: REVIEWER_BOT_ID,
      capability: REVIEW_CAPABILITY,
      taskType: REVIEW_TASK_TYPE,
      goal,
      context: `producer_task:${producer.taskId}`,
    },
    {}
  );

  const reviewTask = result && result.task ? result.task : null;
  if (!reviewTask) {
    throw new AgentError('verification_review_unavailable', '审校任务创建失败', 503);
  }
  if (reviewTask.taskId === producer.taskId) {
    throw new AgentError(
      'verification_review_not_independent',
      '审校任务与被审任务必须是不同任务',
      409
    );
  }
  if (reviewTask.botId !== REVIEWER_BOT_ID) {
    throw new AgentError(
      'verification_review_not_independent',
      '审校任务必须路由到独立 reviewer',
      409
    );
  }

  // 共享登记：被审产物对该审校任务按当前版本可读，留下共享审计。
  try {
    artifactStore.share(ref.id, {
      withTaskIds: [reviewTask.taskId],
      byTaskId: producer.taskId,
      now,
    });
  } catch (error) {
    // 共享登记失败不阻塞审校（审校正文本已注入 goal）；但要留审计。
    audit(
      producer.botId,
      'verification.review_opened',
      {
        status: 'share_failed',
        errorCode: (error && error.code) || 'share_failed',
        reviewTaskId: reviewTask.taskId,
        producerTaskId: producer.taskId,
        artifactId: String(ref.id),
      },
      { taskId: producer.taskId, runId }
    );
  }

  audit(
    producer.botId,
    'verification.review_opened',
    {
      status: String(reviewTask.status || 'queued'),
      reviewTaskId: reviewTask.taskId,
      producerTaskId: producer.taskId,
      artifactId: String(ref.id),
      version: ref.version,
    },
    { taskId: producer.taskId, runId }
  );

  return {
    reviewTaskId: reviewTask.taskId,
    reviewTask,
    producerTaskId: producer.taskId,
    artifactRef: { kind: ref.kind, id: ref.id, version: ref.version },
  };
}

function extractJson(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * 解析审校任务结论。fail-closed：无法解析、缺证据、证据读不回来，一律降级为
 * needs_human，绝不把"看不懂"当成 pass。
 */
function parseVerdict(reviewTask) {
  const text =
    reviewTask && reviewTask.result && typeof reviewTask.result.summary === 'string'
      ? reviewTask.result.summary
      : '';
  const parsed = extractJson(text);
  if (!parsed) {
    return {
      decision: 'needs_human',
      valid: false,
      code: 'review_verdict_unparseable',
      reasons: ['verdict_unparseable'],
      evidence: [],
      reviewTaskId: reviewTask ? reviewTask.taskId : null,
    };
  }
  const decision = ['pass', 'fail', 'needs_human'].includes(parsed.decision)
    ? parsed.decision
    : 'needs_human';
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter(item => typeof item === 'string').map(item => item.slice(0, 200)).slice(0, 8)
    : [];

  let evidence = [];
  const rawEvidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (rawEvidence.length > 0) {
    try {
      evidence = artifactCommit.normalizeEvidence(rawEvidence.slice(0, REVIEW_EVIDENCE_MAX));
    } catch (error) {
      return {
        decision: 'needs_human',
        valid: false,
        code: 'review_evidence_invalid',
        reasons: [...reasons, `evidence:${(error && error.code) || 'invalid'}`],
        evidence: [],
        reviewTaskId: reviewTask ? reviewTask.taskId : null,
      };
    }
  }
  if (rawEvidence.length === 0 && decision !== 'needs_human') {
    return {
      decision: 'needs_human',
      valid: false,
      code: 'review_evidence_missing',
      reasons: [...reasons, 'evidence_missing'],
      evidence: [],
      reviewTaskId: reviewTask ? reviewTask.taskId : null,
    };
  }
  return {
    decision,
    valid: true,
    code: null,
    reasons,
    evidence,
    reviewTaskId: reviewTask ? reviewTask.taskId : null,
    raw: parsed,
  };
}

/**
 * 冲突裁决（纯函数，确定且可复现）。
 * 机械校验与审校结论相反 → conflict（保守不通过）；机械校验失败时它永远优先于
 * 审校的 pass；审校无法给出结论 → needs_human，绝不按通过处理。
 */
function resolveConflict(deterministic, review) {
  const detOk = Boolean(deterministic && deterministic.ok === true);
  const verdict = review && review.valid ? review.decision : 'needs_human';
  const deterministicCode = (deterministic && deterministic.errorCode) || VERIFY_CODES.structure;
  const reviewCode = (review && review.code) || DECISION_CODES.reviewNeedsHuman;

  if (detOk && verdict === 'pass') {
    return { outcome: 'pass', errorCode: null, deterministicCode: null, reviewDecision: 'pass' };
  }
  if (detOk && verdict === 'fail') {
    return {
      outcome: 'conflict',
      errorCode: DECISION_CODES.conflict,
      deterministicCode: null,
      reviewDecision: 'fail',
      reason: 'mechanical_pass_review_fail',
    };
  }
  if (!detOk && verdict === 'pass') {
    return {
      outcome: 'conflict',
      errorCode: DECISION_CODES.conflict,
      deterministicCode,
      reviewDecision: 'pass',
      reason: 'mechanical_fail_review_pass',
    };
  }
  if (!detOk && verdict === 'fail') {
    return {
      outcome: 'fail',
      errorCode: deterministicCode,
      deterministicCode,
      reviewDecision: 'fail',
      reason: 'agreement_fail',
    };
  }
  // detOk && needs_human
  if (detOk) {
    return {
      outcome: 'needs_human',
      errorCode: reviewCode,
      deterministicCode: null,
      reviewDecision: 'needs_human',
      reason: 'review_needs_human',
    };
  }
  // !detOk && needs_human：确定性失败是机械事实，优先。
  return {
    outcome: 'fail',
    errorCode: deterministicCode,
    deterministicCode,
    reviewDecision: 'needs_human',
    reason: 'mechanical_fail_authoritative',
  };
}

function isHighRiskTask(task) {
  const tools = task && Array.isArray(task.allowedTools) ? task.allowedTools : [];
  const highRiskTools = ['memory_remember', 'memory_forget', 'memory_update', 'memory_delete'];
  return tools.some(name => highRiskTools.includes(name)) || (task && task.taskType === 'memory.write');
}

/**
 * 把裁决结果映射到动作：
 * - pass → 允许完成
 * - fail → 直接拒绝（低风险）或转人工（高风险审校不通过）
 * - conflict / needs_human → 人工审批节点（默认不通过，标 conflict）
 */
function planGate({ deterministic, review, task }) {
  const resolution = resolveConflict(deterministic, review);
  if (resolution.outcome === 'pass') {
    return { ...resolution, action: 'complete', operation: null };
  }
  if (resolution.outcome === 'fail') {
    if (isHighRiskTask(task)) {
      return { ...resolution, action: 'approval', operation: 'review.escalate' };
    }
    return { ...resolution, action: 'reject', operation: null };
  }
  return {
    ...resolution,
    action: 'approval',
    operation: resolution.outcome === 'conflict' ? 'review.conflict' : 'review.escalate',
  };
}

function invalidateArtifactRefs(result, { reason = 'verification_failed', now = Date.now() } = {}) {
  const refs = result && Array.isArray(result.artifacts) ? result.artifacts : [];
  const invalidated = [];
  for (const ref of refs) {
    if (!ref || !ref.id) continue;
    try {
      artifactStore.markStatus(String(ref.id), 'invalidated', {
        reason: String(reason).slice(0, 120),
        now,
      });
      invalidated.push(String(ref.id));
    } catch (_) {
      // 标记失败不改变"拒绝"的结论；拒绝本身已由错误码落盘。
    }
  }
  return invalidated;
}

/**
 * 人工审批节点：复用 approvals.js 的 riskLevel / expiresAt。
 * 冲突用 review.conflict（R2，30 分钟 SLA：超时只标 overdue，任务按自身 deadline
 * 收敛，审批记录保持 pending，**永不**被解释为通过）；
 * 高风险审校不通过用 review.escalate（R3，无自动过期）。
 */
function requestHumanApproval({
  producerTask,
  artifactRef = null,
  resolution,
  deterministic = null,
  review = null,
  runId = null,
  now = Date.now(),
} = {}) {
  if (!producerTask || !producerTask.taskId) {
    throw new AgentError('task_not_found', '缺少被审任务', 404);
  }
  const operation =
    resolution && resolution.operation
      ? resolution.operation
      : resolution && resolution.outcome === 'conflict'
        ? 'review.conflict'
        : 'review.escalate';
  const payload = {
    producerTaskId: producerTask.taskId,
    artifactId: artifactRef ? String(artifactRef.id) : '',
    version: artifactRef ? Number(artifactRef.version) || 1 : 1,
    verdict: review && review.decision ? review.decision : 'needs_human',
    checkCode: (deterministic && deterministic.errorCode) || '',
    decision: resolution ? resolution.outcome : 'needs_human',
    conflict: Boolean(resolution && resolution.outcome === 'conflict'),
  };
  const record = approvals.createApproval({
    botId: producerTask.botId,
    operation,
    payload,
    taskId: producerTask.taskId,
    requestedBy: producerTask.botId,
    now,
  });

  audit(
    producerTask.botId,
    'verification.approval_requested',
    {
      status: 'pending',
      approvalId: record.approvalId,
      riskLevel: record.riskLevel,
      decision: resolution ? resolution.outcome : 'needs_human',
      taskType: operation,
      artifactId: payload.artifactId,
      version: payload.version,
      conflict: payload.conflict,
    },
    { taskId: producerTask.taskId, runId }
  );
  return record;
}

function auditResolution({ producerTask, deterministic, review, resolution, runId = null }) {
  const payload = {
    verdict: review && review.decision ? review.decision : 'needs_human',
    reviewTaskId: review && review.reviewTaskId ? review.reviewTaskId : null,
    producerTaskId: producerTask.taskId,
    deterministicOk: Boolean(deterministic && deterministic.ok === true),
    conflict: Boolean(resolution && resolution.outcome === 'conflict'),
    decision: resolution ? resolution.outcome : 'needs_human',
    checkCode: (deterministic && deterministic.errorCode) || '',
  };
  audit(
    producerTask.botId,
    resolution && resolution.outcome === 'conflict' ? 'verification.conflict' : 'verification.verdict',
    payload,
    { taskId: producerTask.taskId, runId }
  );
}

/**
 * §27：把验证结论映射到产物 trustLevel（Engine 侧唯一写入口的封装）。
 *
 * - 唯一写入者：始终以 artifactStore.TRUST_WRITER 调用 setTrustLevel；任务更新、
 *   artifact 直写等其他路径在各自入口被拒绝并留痕。
 * - 有序语义：untrusted < declared < evidence_checked < independently_verified，
 *   调用方按门禁顺序调用；失败路径显式降回 declared 并携带原因。
 * - 单个写入失败不改变验证结论（结论已由任务错误码/审计表达），只补审计。
 */
function applyArtifactTrustLevel({
  refs = [],
  level,
  reason = null,
  taskId = null,
  runId = null,
  evidenceRefs = [],
  scope = null,
  now = Date.now(),
} = {}) {
  const applied = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || !ref.id) continue;
    try {
      const artifact = artifactStore.setTrustLevel(String(ref.id), {
        level,
        writer: artifactStore.TRUST_WRITER,
        policyVersion: TRUST_POLICY_VERSION,
        evidenceRefs,
        scope,
        reason,
        now,
      });
      applied.push({
        id: artifact.id,
        level: artifact.trustLevel,
        rank: artifactStore.trustRank(artifact.trustLevel),
      });
    } catch (error) {
      artifactStore.auditFailure('artifact.trust_level_write_failed', {
        artifactId: String(ref.id),
        taskId,
        reason: (error && error.code) || 'trust_write_failed',
        now,
      });
    }
  }
  return applied;
}

module.exports = {
  VERIFY_CODES,
  DECISION_CODES,
  REVIEWER_BOT_ID,
  TRUST_POLICY_VERSION,
  verifyDeterministic,
  primaryArtifactRef,
  applyArtifactTrustLevel,
  openReview,
  parseVerdict,
  resolveConflict,
  planGate,
  invalidateArtifactRefs,
  requestHumanApproval,
  auditResolution,
  setFaultInjection,
};
