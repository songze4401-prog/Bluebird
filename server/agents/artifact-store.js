/* global module, __dirname */
/**
 * Artifact Store（Phase 1 前置 ③）。
 *
 * 范围：只负责 `agent-artifacts.json` 这一张产物表的读写与生命周期字段，
 * 以及配套的追加式审计 `agent-artifact-audit.json`。它不拥有任务状态权威
 * （任务状态仍只由 task-store/transitionTask 写入），也不承担 Blackboard 的
 * 内容存储职责——本阶段只记录产物元数据（含 contentHash），正文留在产出方。
 *
 * 与 §11 五步的关系：
 *   第 1 步：persist() 先落盘产物，返回 artifactRef（{kind,id} 由调用方组装，
 *            产物记录本身带 version）。
 *   第 2/3 步：引用随任务结果在同一次 transitionTask 写入；提交前由
 *            assertRefsCommitReady() 校验可读与 schema。
 *   第 4 步：persist/confirm 失败抛 artifact_* 错误，由 runtime 转 retrying/recovery。
 *   第 5 步：commit 字段区分 pending-commit / committed / orphan；确认无引用
 *            且超过 TTL 才允许清理，清理前写审计。
 *
 * 硬约束：已提交（committed）产物永不自动清理；错误产物标记 superseded /
 * invalidated 并保留审计记录，不能用删除掩盖状态回滚。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const ARTIFACTS_FILE = path.join(AGENTS_DIR, 'agent-artifacts.json');
const AUDIT_FILE = path.join(AGENTS_DIR, 'agent-artifact-audit.json');

const SCHEMA_VERSION = 1;
const AUDIT_SCHEMA_VERSION = 1;
const AUDIT_MAX = 500;
const ARTIFACT_MAX = 5000;

// 内容有效性（status）与提交生命周期（commit）是两个正交维度：
// 一个 active 产物可能仍处于 pending-commit，不能用一个枚举混装。
const STATUSES = Object.freeze(['active', 'superseded', 'invalidated']);
const COMMIT_STATES = Object.freeze(['pending-commit', 'committed', 'orphan']);

const KIND_MAX = 40;
const ID_MAX = 120;
const HASH_RE = /^[0-9a-f]{64}$/;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function empty() {
  return { version: SCHEMA_VERSION, artifacts: {} };
}

function emptyAudit() {
  return { version: AUDIT_SCHEMA_VERSION, entries: [] };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readArtifacts() {
  ensureDir();
  if (!fs.existsSync(ARTIFACTS_FILE)) return empty();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('artifact_store_corrupted', '产物存储无法解析', 500);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.artifacts ||
    typeof parsed.artifacts !== 'object' ||
    Array.isArray(parsed.artifacts)
  ) {
    throw new AgentError('artifact_store_corrupted', '产物存储结构无效', 500);
  }
  return parsed;
}

function writeArtifacts(store) {
  ensureDir();
  writeFileAtomicSync(ARTIFACTS_FILE, JSON.stringify(store, null, 2));
}

function readAudit() {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return emptyAudit();
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (_) {
    // 审计文件损坏不阻塞主流程；下一次写入会覆盖成合法结构。
  }
  return emptyAudit();
}

function appendAudit(action, artifact, extra = {}) {
  const audit = readAudit();
  audit.entries.push({
    at: nowIso(extra.now),
    action: String(action || '').slice(0, 60),
    artifactId: artifact && artifact.id ? String(artifact.id).slice(0, ID_MAX) : null,
    kind: artifact && artifact.kind ? String(artifact.kind).slice(0, KIND_MAX) : null,
    contentHash: artifact && artifact.contentHash ? artifact.contentHash : null,
    taskId: extra.taskId || (artifact && artifact.taskId) || null,
    runId: extra.runId || (artifact && artifact.runId) || null,
    reason: typeof extra.reason === 'string' ? extra.reason.slice(0, 200) : null,
  });
  audit.entries = audit.entries.slice(-AUDIT_MAX);
  ensureDir();
  writeFileAtomicSync(AUDIT_FILE, JSON.stringify(audit, null, 2));
}

function get(id) {
  const key = String(id || '').slice(0, ID_MAX);
  if (!key) return null;
  return readArtifacts().artifacts[key] || null;
}

function all() {
  return Object.values(readArtifacts().artifacts);
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content === undefined ? null : content);
  } catch (_) {
    return String(content);
  }
}

// identity 由 (taskId, kind, contentHash) 决定：同一任务重试产生同样输出时
// 拿到同一个 artifactId，从而幂等重试不会产生重复产物（第 5 步）。
function artifactIdFor(taskId, kind, contentHash) {
  const seed = `${taskId || 'unbound'}|${kind}|${contentHash}`;
  return `art_${sha256(seed).slice(0, 32)}`;
}

function assertKind(kind) {
  const value = String(kind || '').trim();
  if (!value || value.length > KIND_MAX) {
    throw new AgentError('artifact_invalid_kind', '产物 kind 无效', 400);
  }
  return value;
}

/**
 * 第 1 步：产物先落盘。
 * 新版本沿用同一 lineage（taskId + kind）：内容变化时旧产物标记 superseded
 * 并保留审计，新产物 version = 旧最大 version + 1。
 */
function persist({ kind, content, taskId = null, runId = null, now = Date.now() } = {}) {
  const artifactKind = assertKind(kind);
  const contentHash = sha256(normalizeContent(content));
  const boundTaskId = taskId ? String(taskId).slice(0, ID_MAX) : null;
  const id = artifactIdFor(boundTaskId, artifactKind, contentHash);

  let store;
  try {
    store = readArtifacts();
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_read_failed');
  }
  const existing = store.artifacts[id];
  if (existing) {
    // 幂等：同一产物重复落盘不新增记录、不改 refCount。
    return existing;
  }

  const lineage = Object.values(store.artifacts).filter(
    item =>
      item &&
      item.taskId === boundTaskId &&
      item.kind === artifactKind &&
      item.status === 'active'
  );
  let version = 1;
  for (const item of lineage) {
    const itemVersion = Number.isInteger(item.version) ? item.version : 1;
    version = Math.max(version, itemVersion + 1);
    item.status = 'superseded';
    item.supersededBy = id;
    item.supersededAt = nowIso(now);
    item.lastCheckedAt = nowIso(now);
  }

  const artifact = {
    id,
    kind: artifactKind,
    version,
    createdAt: nowIso(now),
    contentHash,
    refCount: 0,
    status: 'active',
    // 刚落盘即 pending-commit：只有任务状态提交成功并确认引用后才 committed。
    commit: 'pending-commit',
    taskId: boundTaskId,
    runId: runId ? String(runId).slice(0, 80) : null,
    refs: [],
    lastCheckedAt: null,
    supersededBy: null,
    supersededAt: null,
    invalidatedAt: null,
    invalidatedReason: null,
  };

  store.artifacts[id] = artifact;
  const ids = Object.keys(store.artifacts);
  if (ids.length > ARTIFACT_MAX) {
    const removable = ids
      .map(key => store.artifacts[key])
      .filter(
        item =>
          item.commit === 'orphan' &&
          Array.isArray(item.refs) &&
          item.refs.length === 0 &&
          item.status === 'active'
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const item of removable.slice(0, ids.length - ARTIFACT_MAX)) {
      delete store.artifacts[item.id];
    }
  }

  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  for (const item of lineage) {
    appendAudit('artifact.superseded', item, {
      now,
      reason: `superseded_by:${id}`,
    });
  }
  appendAudit('artifact.persisted', artifact, { now });
  return artifact;
}

function wrapStoreError(error, code) {
  if (error && error.code && String(error.code).startsWith('artifact_')) return error;
  return new AgentError(code, '产物存储读写失败', 500, {
    cause: error && error.code ? String(error.code) : 'unknown',
  });
}

function schemaIssue(artifact) {
  if (!artifact || typeof artifact !== 'object') return 'not_object';
  if (!artifact.id) return 'missing_id';
  if (!artifact.kind) return 'missing_kind';
  if (!HASH_RE.test(String(artifact.contentHash || ''))) return 'invalid_hash';
  if (!STATUSES.includes(artifact.status)) return 'invalid_status';
  if (!COMMIT_STATES.includes(artifact.commit)) return 'invalid_commit';
  if (!Number.isInteger(artifact.refCount) || artifact.refCount < 0) return 'invalid_ref_count';
  return null;
}

/**
 * 第 3 步的校验门禁：引用必须可读（产物存在）、schema 合格、状态可提交。
 * 空引用数组放行——没有产物要求的任务保持既有完成路径。
 */
function assertRefsCommitReady(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return;
  let store;
  try {
    store = readArtifacts();
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_read_failed');
  }
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') {
      throw new AgentError('artifact_ref_invalid', '产物引用必须是对象', 400, {
        ref: String(ref),
      });
    }
    const id = String(ref.id || '').slice(0, ID_MAX);
    if (!id) {
      throw new AgentError('artifact_ref_invalid', '产物引用缺少 id', 400);
    }
    const artifact = store.artifacts[id];
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: id });
    }
    const issue = schemaIssue(artifact);
    if (issue) {
      throw new AgentError('artifact_schema_invalid', `产物 schema 不合格：${issue}`, 409, {
        artifactId: id,
        issue,
      });
    }
    if (artifact.status !== 'active') {
      throw new AgentError('artifact_not_active', '产物已失效，不能提交为完成', 409, {
        artifactId: id,
        status: artifact.status,
      });
    }
    if (ref.kind && String(ref.kind) !== artifact.kind) {
      throw new AgentError('artifact_ref_invalid', '产物引用 kind 与存储不一致', 409, {
        artifactId: id,
      });
    }
    if (
      Number.isInteger(ref.version) &&
      Number.isInteger(artifact.version) &&
      ref.version !== artifact.version
    ) {
      throw new AgentError('artifact_version_mismatch', '产物引用版本与存储不一致', 409, {
        artifactId: id,
        expectedVersion: artifact.version,
        refVersion: ref.version,
      });
    }
  }
}

/**
 * 第 2 步的提交确认。按 taskId 去重：同一任务重复提交同一引用不会累加 refCount。
 * 状态提交成功后调用；失败时产物保持 pending-commit，由启动扫描收敛。
 */
function confirmRefs(refs, { taskId, runId = null, now = Date.now() } = {}) {
  const list = Array.isArray(refs) ? refs : [];
  if (list.length === 0) return [];
  const owner = String(taskId || '').slice(0, ID_MAX);
  if (!owner) {
    throw new AgentError('artifact_ref_invalid', '确认产物引用缺少 taskId', 400);
  }
  let store;
  try {
    store = readArtifacts();
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_read_failed');
  }

  const confirmed = [];
  const at = nowIso(now);
  for (const ref of list) {
    const id = String((ref && ref.id) || '').slice(0, ID_MAX);
    const artifact = store.artifacts[id];
    if (!artifact) {
      throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: id });
    }
    artifact.refs = Array.isArray(artifact.refs) ? artifact.refs : [];
    const already = artifact.refs.some(item => item && item.taskId === owner);
    if (!already) {
      artifact.refs.push({
        taskId: owner,
        runId: runId ? String(runId).slice(0, 80) : null,
        at,
      });
      confirmed.push(artifact);
    }
    artifact.refCount = artifact.refs.length;
    artifact.commit = 'committed';
    artifact.lastCheckedAt = at;
  }

  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  for (const artifact of confirmed) {
    appendAudit('artifact.committed', artifact, { now, taskId: owner, runId });
  }
  return confirmed;
}

/** 扫描结果：确认无引用且超过 TTL 后，从 pending-commit 转为 orphan。 */
function markOrphan(id, { reason = 'no_task_reference', now = Date.now() } = {}) {
  const store = readArtifacts();
  const artifact = store.artifacts[String(id || '').slice(0, ID_MAX)];
  if (!artifact) return null;
  artifact.commit = 'orphan';
  artifact.orphanReason = String(reason).slice(0, 120);
  artifact.lastCheckedAt = nowIso(now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit('artifact.orphaned', artifact, { now, reason });
  return artifact;
}

function markScanned(id, { now = Date.now() } = {}) {
  const store = readArtifacts();
  const artifact = store.artifacts[String(id || '').slice(0, ID_MAX)];
  if (!artifact) return null;
  artifact.lastCheckedAt = nowIso(now);
  writeArtifacts(store);
  return artifact;
}

/**
 * 硬约束：错误产物不删除，只标记 superseded / invalidated 并保留审计。
 */
function markStatus(id, status, { by = null, reason = '', now = Date.now() } = {}) {
  if (!['superseded', 'invalidated'].includes(status)) {
    throw new AgentError('artifact_status_invalid', '产物状态无效', 400);
  }
  const store = readArtifacts();
  const artifact = store.artifacts[String(id || '').slice(0, ID_MAX)];
  if (!artifact) throw new AgentError('artifact_not_found', '产物不存在', 404);
  artifact.status = status;
  if (status === 'superseded') {
    artifact.supersededBy = by ? String(by).slice(0, ID_MAX) : null;
    artifact.supersededAt = nowIso(now);
  } else {
    artifact.invalidatedAt = nowIso(now);
    artifact.invalidatedReason = String(reason || '').slice(0, 120);
  }
  artifact.lastCheckedAt = nowIso(now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit(`artifact.${status}`, artifact, { now, reason });
  return artifact;
}

/**
 * 物理清理。调用方必须先完成引用扫描（cleanupOrphans 内做），
 * 且只能用于 active + orphan + 无引用 + 超过 TTL 的产物。
 * 审计先写成功再删除，确保"清理动作可回溯"。
 */
function purge(id, { reason = 'orphan_ttl_expired', now = Date.now(), refScan = null } = {}) {
  const store = readArtifacts();
  const key = String(id || '').slice(0, ID_MAX);
  const artifact = store.artifacts[key];
  if (!artifact) return null;
  appendAudit('artifact.purged', artifact, {
    now,
    reason: refScan ? `${reason}|refscan:${refScan}` : reason,
  });
  delete store.artifacts[key];
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  return artifact;
}

function auditFailure(action, { artifactId = null, reason = '', taskId = null, now = Date.now() } = {}) {
  try {
    appendAudit(action, artifactId ? { id: artifactId } : null, { now, reason, taskId });
  } catch (_) {
    // 审计失败不能反过来推翻已提交的状态；下次扫描仍会重新尝试关联。
  }
}

function auditEntries() {
  return readAudit().entries;
}

module.exports = {
  ARTIFACTS_FILE,
  AUDIT_FILE,
  SCHEMA_VERSION,
  STATUSES,
  COMMIT_STATES,
  empty,
  persist,
  get,
  all,
  assertRefsCommitReady,
  confirmRefs,
  markOrphan,
  markScanned,
  markStatus,
  purge,
  auditFailure,
  auditEntries,
};
