/* global module, __dirname */
/**
 * Artifact Store（Phase 1 前置 ③）。
 *
 * 范围：负责 `agent-artifacts.json` 这张产物索引表的读写与生命周期字段、
 * 配套的追加式审计 `agent-artifact-audit.json`，以及产物正文文件
 * `agents/artifact-contents/<id>.json`（一产物一文件）。它不拥有任务状态权威
 * （任务状态仍只由 task-store/transitionTask 写入），也不承担 Blackboard 的
 * 内容存储职责——这里的正文只服务于"按 {id,version} 复读 + contentHash 校验"，
 * 不是可检索的内容层。
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
// 产物正文独立成文件：一个产物一个文件（id 由 (taskId,kind,contentHash) 派生，
// 内容不可变），避免每次落盘重写整张产物表带来的写放大（同 workflow-store 的选择）。
const CONTENTS_DIR = path.join(AGENTS_DIR, 'artifact-contents');

const SCHEMA_VERSION = 1;
const AUDIT_SCHEMA_VERSION = 1;
const AUDIT_MAX = 500;
const ARTIFACT_MAX = 5000;
// A 类：单个产物正文硬上限 256 KB（安全默认值，待实测校准）。
// 超限显式拒绝（artifact_content_too_large），绝不截断——截断会让 contentHash 失去意义。
const CONTENT_MAX_BYTES = 256 * 1024;
const CONTENT_SCHEMA_VERSION = 1;

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

function contentPathOf(id) {
  return path.join(CONTENTS_DIR, `${id}.json`);
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 产物正文落盘（独立文件，先于产物记录写入）。
 * 顺序理由：先写正文再写索引，最坏结果是留下一个无索引的正文文件（垃圾，
 * 不影响任何引用）；反过来会得到「索引指向读不回来的正文」，那是审计不可复现的死角。
 */
function writeContent(artifact, content, normalized) {
  const record = {
    version: CONTENT_SCHEMA_VERSION,
    id: artifact.id,
    artifactVersion: artifact.version,
    kind: artifact.kind,
    contentHash: artifact.contentHash,
    bytes: byteLength(normalized),
    content,
  };
  fs.mkdirSync(CONTENTS_DIR, { recursive: true });
  try {
    writeFileAtomicSync(contentPathOf(artifact.id), JSON.stringify(record));
  } catch (error) {
    throw wrapStoreError(error, 'artifact_content_write_failed');
  }
}

/**
 * 按 {id, version} 复读正文并校验 contentHash。
 * fail-closed：文件缺失、无法解析、hash 与索引不一致、版本不符，一律抛错，
 * 绝不返回空内容——"读不回来"必须等价于"失败"，否则消费方会把损坏当成空产物。
 */
function readContent(id, { version = null } = {}) {
  const key = String(id || '').slice(0, ID_MAX);
  if (!key) {
    throw new AgentError('artifact_content_missing', '产物 id 无效，无法复读正文', 400);
  }
  const artifact = get(key);
  if (!artifact) {
    throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: key });
  }
  if (
    Number.isInteger(version) &&
    Number.isInteger(artifact.version) &&
    version !== artifact.version
  ) {
    throw new AgentError('artifact_version_mismatch', '产物引用版本与存储不一致', 409, {
      artifactId: key,
      expectedVersion: artifact.version,
      refVersion: version,
    });
  }
  const file = contentPathOf(key);
  if (!fs.existsSync(file)) {
    throw new AgentError('artifact_content_missing', '产物正文缺失', 409, { artifactId: key });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    throw new AgentError('artifact_content_corrupted', '产物正文无法解析', 500, {
      artifactId: key,
    });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.id !== key ||
    typeof parsed.contentHash !== 'string' ||
    !('content' in parsed)
  ) {
    throw new AgentError('artifact_content_corrupted', '产物正文结构无效', 500, {
      artifactId: key,
    });
  }
  const normalized = normalizeContent(parsed.content);
  const actualHash = sha256(normalized);
  if (actualHash !== artifact.contentHash || parsed.contentHash !== artifact.contentHash) {
    throw new AgentError('artifact_content_corrupted', '产物正文与 contentHash 不一致', 409, {
      artifactId: key,
      expectedHash: artifact.contentHash,
      actualHash,
    });
  }
  return {
    id: key,
    version: artifact.version,
    kind: artifact.kind,
    status: artifact.status,
    contentHash: artifact.contentHash,
    bytes: byteLength(normalized),
    content: parsed.content,
  };
}

/** 同一 lineage（taskId + kind）的全部版本，含 superseded；升序排列（最后一个是最新）。 */
function versionsOf({ taskId = null, kind } = {}) {
  const artifactKind = assertKind(kind);
  const boundTaskId = taskId ? String(taskId).slice(0, ID_MAX) : null;
  return Object.values(readArtifacts().artifacts)
    .filter(item => item && item.taskId === boundTaskId && item.kind === artifactKind)
    .sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
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
  const normalized = normalizeContent(content);
  const bytes = byteLength(normalized);
  // 超限显式拒绝：不截断、不留半截产物记录、不写正文文件。
  if (bytes > CONTENT_MAX_BYTES) {
    throw new AgentError('artifact_content_too_large', '产物正文超过上限，拒绝落盘', 400, {
      kind: artifactKind,
      bytes,
      maxBytes: CONTENT_MAX_BYTES,
    });
  }
  const contentHash = sha256(normalized);
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
    // 正文按 id 幂等重写一次，兼作"索引在、正文丢"的自愈路径（内容由 hash 决定，写回安全）。
    writeContent(existing, content, normalized);
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

  // 正文先落盘，再写索引（见 writeContent 的顺序理由）。
  writeContent(artifact, content, normalized);
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
    // 正文必须复读通过（缺失/损坏/hash 不符一律 fail-closed）：
    // 只校验索引而不校验正文，等于允许把"审计不可复现"的产物提交为完成。
    readContent(id, { version: ref.version });
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
  // 索引删除成功后才删正文；反序会留下"正文在、索引没了"的不可引用垃圾。
  try {
    const file = contentPathOf(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {
    // 正文删除失败只留下孤儿文件，不影响任何引用语义，下次清理可重试。
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
  CONTENTS_DIR,
  CONTENT_MAX_BYTES,
  SCHEMA_VERSION,
  STATUSES,
  COMMIT_STATES,
  empty,
  persist,
  get,
  all,
  readContent,
  versionsOf,
  assertRefsCommitReady,
  confirmRefs,
  markOrphan,
  markScanned,
  markStatus,
  purge,
  auditFailure,
  auditEntries,
};
