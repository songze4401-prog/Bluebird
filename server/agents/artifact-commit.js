/* global module */
/**
 * 产物提交协议（Phase 1 前置 ③，§11 五步的编排层）。
 *
 * 本文件把 artifact-store 与 task-store 串成一条提交链，顺序固定：
 *   产物落盘（pending-commit） → 校验引用 → task 状态与 result 同一次写入
 *   → 确认引用（committed）。任何一步失败都不允许静默 completed。
 *
 * 跨 Store 不假设分布式原子事务：产物已写但任务状态提交失败时，产物停在
 * pending-commit，由启动扫描按幂等关联收敛（§11 第 5 步）。
 */
const artifactStore = require('./artifact-store');
const tasks = require('./tasks');
const { AgentError } = require('./errors');

// Phase 2 第 1 项：共享结论的证据引用上限（沿用产物引用 schema {kind,id,version}）。
const EVIDENCE_MAX = 20;

// §38：orphan/pending-commit 默认 TTL 168 小时（7 天），可按环境配置。
const DEFAULT_ORPHAN_TTL_MS = 168 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = Math.max(
  0,
  Number(process.env.BLUEBIRD_AGENT_ARTIFACT_ORPHAN_TTL_MS) || DEFAULT_ORPHAN_TTL_MS
);

function ttlFor(options = {}) {
  return Number.isFinite(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : ORPHAN_TTL_MS;
}

/**
 * 第 1 步：Worker 先持久化产物。
 * 输入是产物内容描述 [{kind, content}]，输出是任务结果里可落库的引用
 * [{kind, id, version}]——保持 {kind,id} 既有形状，只增量一个 version。
 */
function persistTaskArtifacts({ taskId, runId = null, artifacts = [], now = Date.now() } = {}) {
  const refs = [];
  // 同一任务同一 kind 只保留最后一次产出；先前版本在存储里标 superseded 并留审计。
  const latest = new Map();
  for (const item of Array.isArray(artifacts) ? artifacts : []) {
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.kind || '');
    if (!kind) continue;
    latest.set(kind, item);
  }
  for (const item of latest.values()) {
    const artifact = artifactStore.persist({
      kind: item.kind,
      content: item.content,
      taskId,
      runId,
      now,
    });
    refs.push({ kind: artifact.kind, id: artifact.id, version: artifact.version });
  }
  return refs;
}

function refsOf(result) {
  return result && Array.isArray(result.artifacts) ? result.artifacts : [];
}

/**
 * 第 2/3 步：状态提交。
 * - 校验发生在 transitionTask 内（完成态必须满足产物引用可读/schema 合格）。
 * - 引用与状态在同一次 updateTask 落盘内写入，且 stateVersion 同一次 +1。
 * - 状态提交成功后确认产物引用；确认失败不推翻已提交的状态，只留审计，
 *   产物保持 pending-commit 等扫描收敛。
 */
function completeTask(taskId, options = {}) {
  const written = tasks.transitionTask(taskId, { ...options, to: 'completed' });
  const refs = refsOf(options.result);
  if (refs.length > 0) {
    try {
      artifactStore.confirmRefs(refs, {
        taskId,
        runId: options.result && options.result.runId ? options.result.runId : null,
      });
    } catch (error) {
      artifactStore.auditFailure('artifact.confirm_failed', {
        artifactId: (refs[0] && refs[0].id) || null,
        taskId,
        reason: (error && error.code) || 'confirm_failed',
      });
    }
  }
  return written;
}

/**
 * Phase 2 第 1 项：共享结论的证据引用。
 * fail-closed：缺证据数组 / 空数组 / 引用未钉住 version / 产物读不回来，一律拒绝，
 * 不写入任何结论产物。引用 schema 仍是既有的 {kind,id,version}。
 */
function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new AgentError('artifact_evidence_missing', '共享结论必须携带证据引用', 409, {
      refCount: 0,
    });
  }
  if (evidence.length > EVIDENCE_MAX) {
    throw new AgentError(
      'artifact_evidence_invalid',
      `证据引用最多 ${EVIDENCE_MAX} 条`,
      400,
      { refCount: evidence.length }
    );
  }
  const refs = [];
  for (const item of evidence) {
    if (!item || typeof item !== 'object') {
      throw new AgentError('artifact_evidence_invalid', '证据引用必须是对象', 400);
    }
    const id = String(item.id || '').slice(0, 120);
    if (!id) {
      throw new AgentError('artifact_evidence_invalid', '证据引用缺少 id', 400);
    }
    if (!Number.isInteger(item.version) || item.version < 1) {
      throw new AgentError('artifact_evidence_invalid', '证据引用必须钉住 version', 400, {
        artifactId: id,
      });
    }
    // 复读正文，证明该版本此刻可追溯；读不回来即不可作为共享结论的来源。
    const content = artifactStore.readContent(id, { version: item.version });
    refs.push({ kind: content.kind, id, version: item.version });
  }
  return refs;
}

/**
 * 发布共享结论：先校验证据（fail-closed），再落 conclusion 产物并登记共享。
 * 结论正文内嵌证据引用集合，使"每个共享结论可追溯来源"可被读方复核。
 */
function publishSharedConclusion({
  taskId,
  runId = null,
  subject = '',
  evidence = [],
  withTaskIds = [],
  now = Date.now(),
} = {}) {
  const owner = String(taskId || '').slice(0, 120);
  if (!owner) throw new AgentError('artifact_ref_invalid', '共享结论缺少 taskId', 400);
  const evidenceRefs = normalizeEvidence(evidence);
  const artifact = artifactStore.persist({
    kind: 'conclusion',
    content: {
      subject: String(subject).slice(0, 4000),
      evidence: evidenceRefs,
    },
    taskId: owner,
    runId,
    now,
  });
  artifactStore.share(artifact.id, { withTaskIds, byTaskId: owner, now });
  return {
    artifact,
    ref: { kind: artifact.kind, id: artifact.id, version: artifact.version },
    evidence: evidenceRefs,
  };
}

function referencedArtifacts() {
  const map = new Map();
  for (const task of tasks.allTasks()) {
    for (const ref of refsOf(task.result)) {
      if (ref && ref.id && !map.has(ref.id)) {
        map.set(ref.id, task);
      }
    }
  }
  return map;
}

function ageOf(artifact, now) {
  const base = artifact.lastCheckedAt || artifact.createdAt;
  const parsed = Date.parse(base);
  return Number.isFinite(parsed) ? now - parsed : null;
}

/**
 * 第 5 步（恢复侧）：扫描 pending-commit / orphan。
 * - 任务记录已持有引用 → 幂等关联（不新增产物、不重复累加 refCount）。
 * - 无引用且未超 TTL → 只刷新最后检查时间（TTL 从最后一次检查起算，§38）。
 * - 无引用且超 TTL → 标记 orphan（仍未删除）。
 */
function scanPendingCommits({ now = Date.now(), ttlMs } = {}) {
  const ttl = ttlFor({ ttlMs });
  const refs = referencedArtifacts();
  const result = {
    scanned: 0,
    reconciled: [],
    orphaned: [],
    pending: [],
    ttlMs: ttl,
  };

  for (const artifact of artifactStore.all()) {
    if (artifact.commit === 'committed') continue;
    result.scanned += 1;
    const owner = refs.get(artifact.id);
    if (owner) {
      artifactStore.confirmRefs([{ kind: artifact.kind, id: artifact.id }], {
        taskId: owner.taskId,
        runId: (owner.result && owner.result.runId) || null,
        now,
      });
      result.reconciled.push(artifact.id);
      continue;
    }
    const age = ageOf(artifact, now);
    if (age !== null && age >= ttl) {
      artifactStore.markOrphan(artifact.id, { reason: 'no_task_reference', now });
      result.orphaned.push(artifact.id);
    } else {
      artifactStore.markScanned(artifact.id, { now });
      result.pending.push(artifact.id);
    }
  }
  return result;
}

/**
 * 第 5 步（清理侧）：先做引用扫描，再判断 TTL。
 * 只有 active + 无任何任务引用 + 超过 TTL 的 pending-commit/orphan 才物理清理；
 * superseded / invalidated 永不自动清理（审计保留），committed 更不允许删除。
 */
function cleanupOrphans({ now = Date.now(), ttlMs } = {}) {
  const ttl = ttlFor({ ttlMs });
  const refs = referencedArtifacts();
  const result = {
    scanned: 0,
    cleaned: [],
    kept: [],
    ttlMs: ttl,
  };
  for (const artifact of artifactStore.all()) {
    if (artifact.commit !== 'orphan' && artifact.commit !== 'pending-commit') continue;
    result.scanned += 1;
    if (refs.has(artifact.id)) {
      result.kept.push({ id: artifact.id, reason: 'referenced_by_task' });
      continue;
    }
    if (artifact.status !== 'active') {
      result.kept.push({ id: artifact.id, reason: `status:${artifact.status}` });
      continue;
    }
    const age = ageOf(artifact, now);
    if (age === null || age < ttl) {
      result.kept.push({ id: artifact.id, reason: 'ttl_not_expired' });
      continue;
    }
    artifactStore.purge(artifact.id, {
      reason: 'orphan_ttl_expired',
      now,
      refScan: 'no-task-refs',
    });
    result.cleaned.push(artifact.id);
  }
  return result;
}

module.exports = {
  DEFAULT_ORPHAN_TTL_MS,
  ORPHAN_TTL_MS,
  persistTaskArtifacts,
  completeTask,
  scanPendingCommits,
  cleanupOrphans,
  normalizeEvidence,
  publishSharedConclusion,
};
