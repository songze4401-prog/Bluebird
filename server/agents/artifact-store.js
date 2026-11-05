/* global module, __dirname, Buffer */
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
const { AgentError, conflictError } = require('./errors');
const cycleDetection = require('./cycle-detection');
const taintPolicy = require('./taint-policy');
const conflictRecord = require('./conflict-record');

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
// §27：trustLevel 固定为有序枚举（升级/降级按数组下标比较）。
// 只表示证据验证状态，不代表访问权限；唯一写入者是 Verification Engine。
const TRUST_LEVELS = Object.freeze([
  'untrusted',
  'declared',
  'evidence_checked',
  'independently_verified',
]);
// 原文只写"Verification Engine"，未定义服务端标识取值；此处取固定标识便于校验（待确认）。
const TRUST_WRITER = 'verification-engine';

// §27 有序语义：按 TRUST_LEVELS 下标比较，越靠后可信度越高。
// 缺字段/历史非法值按 untrusted 处理（fail-closed，只在读取边界使用）。
function trustRank(level) {
  const index = TRUST_LEVELS.indexOf(TRUST_LEVELS.includes(level) ? level : 'untrusted');
  return index < 0 ? 0 : index;
}

function trustAtLeast(level, threshold) {
  return trustRank(level) >= trustRank(threshold);
}

const KIND_MAX = 40;
const ID_MAX = 120;
const HASH_RE = /^[0-9a-f]{64}$/;
// Phase 2 第 1 项：单次共享登记的接收方上限（同批次任务规模的一个安全默认值）。
const SHARE_TASK_MAX = 50;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

// ---- A-02 Blackboard CAS：stateVersion + expectedVersion ----
// 语义与 task-store 的 CAS 对齐：每次内容/验证状态写入都让 stateVersion 单调 +1；
// 写入方可带 expectedVersion（期望的 lineage 当前 stateVersion），不匹配即 409 conflict。
// 版本裁决沿 lineage（taskId + kind）：内容变化时旧记录 superseded 并记 supersededBy，
// 新记录继承 lineage 的最大 stateVersion + 1。旧记录缺 stateVersion 时读作 0（不误判为脏）。
function stateVersionOf(artifact) {
  return artifact && Number.isInteger(artifact.stateVersion) ? artifact.stateVersion : 0;
}

function lineageMaxStateVersion(store, taskId, kind) {
  let max = 0;
  for (const item of Object.values(store.artifacts)) {
    if (item && item.taskId === taskId && item.kind === kind) {
      max = Math.max(max, stateVersionOf(item));
    }
  }
  return max;
}

function bumpStateVersion(artifact, now) {
  artifact.stateVersion = stateVersionOf(artifact) + 1;
  artifact.stateVersionChangedAt = nowIso(now);
  return artifact;
}

function lineageKeyOf(taskId, kind) {
  return `artifact-lineage:${taskId || 'unbound'}:${kind}`;
}

/**
 * CAS 失配：先落 ConflictRecord（temporal：同一 lineage 并发写），再抛既有七字段
 * conflict 错误（复用 errors.conflictError，不新增错误码）。冲突记录写入失败不掩盖
 * 409 结论——调用方仍能按 conflict 重读重试。
 */
function raiseArtifactConflict({
  taskId = null,
  kind,
  expectedVersion,
  currentVersion,
  attemptedId,
  headId = null,
  runId = null,
  now = Date.now(),
}) {
  const subjectKey = lineageKeyOf(taskId, kind);
  const candidateRefs = headId ? [String(headId), String(attemptedId)] : [String(attemptedId)];
  const evidenceRefs = [
    `expectedStateVersion:${String(expectedVersion)}`,
    `currentStateVersion:${String(currentVersion)}`,
  ];
  let conflictId = null;
  try {
    const record = conflictRecord.createRecord({
      subjectKey,
      conflictType: 'temporal',
      candidateRefs,
      evidenceRefs,
      rationale: 'artifact_cas_conflict',
      taskId: taskId || null,
      runId: runId || null,
      createdAt: nowIso(now),
    });
    conflictRecord.persist(record);
    conflictId = record.conflictId;
  } catch (_) {
    // 冲突记录不可用时仍必须返回 conflict；留痕失败不反转写入拒绝。
  }
  throw conflictError({
    taskId: taskId || '',
    expectedVersion,
    currentVersion,
    runId,
    causeRef: conflictId || attemptedId,
  });
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

/** A-02：读 lineage 当前 stateVersion（写入方据此填 expectedVersion）。 */
function lineageStateVersion({ taskId = null, kind } = {}) {
  const artifactKind = assertKind(kind);
  const boundTaskId = taskId ? String(taskId).slice(0, ID_MAX) : null;
  return lineageMaxStateVersion(readArtifacts(), boundTaskId, artifactKind);
}

/**
 * Phase 2 第 1 项：任务级共享登记。
 *
 * 产物默认仍是任务私有（只有 artifact.taskId 能读）；share() 在产物记录上追加
 * 一个 `share` 字段（唯一新增字段），表达"哪一版、共享给哪些任务、由谁登记"。
 * 版本在登记时钉住：读方只能读登记的那一版，不能自动漂到最新版。
 * 不新建共享表/共享存储，也不改 {kind,id,version} 引用 schema。
 */
function normalizeShareTargets(value, ownerTaskId) {
  if (!Array.isArray(value)) {
    throw new AgentError('artifact_share_invalid', '共享目标必须是任务 id 数组', 400);
  }
  const targets = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new AgentError('artifact_share_invalid', '共享目标只能是非空任务 id', 400);
    }
    const taskId = item.trim().slice(0, ID_MAX);
    // 拥有者天然可读，不算共享接收方。
    if (taskId === ownerTaskId || targets.includes(taskId)) continue;
    targets.push(taskId);
  }
  if (targets.length === 0) {
    throw new AgentError('artifact_share_invalid', '共享产物至少需要一个其它任务', 400);
  }
  if (targets.length > SHARE_TASK_MAX) {
    throw new AgentError(
      'artifact_share_invalid',
      `单次共享最多 ${SHARE_TASK_MAX} 个任务`,
      400
    );
  }
  return targets;
}

function share(id, { withTaskIds = [], byTaskId = null, now = Date.now() } = {}) {
  const key = String(id || '').slice(0, ID_MAX);
  if (!key) throw new AgentError('artifact_not_found', '产物引用不可读', 409);
  const store = readArtifacts();
  const artifact = store.artifacts[key];
  if (!artifact) {
    throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: key });
  }
  if (artifact.status === 'invalidated') {
    throw new AgentError('artifact_not_active', '产物已失效，不能登记共享', 409, {
      artifactId: key,
      status: artifact.status,
    });
  }
  const targets = normalizeShareTargets(withTaskIds, artifact.taskId);
  // 共享登记前必须复读正文（缺失/损坏/hash 不符一律 fail-closed），
  // 否则等于把"读不回来"的产物登记成共享结论的来源。
  readContent(key, { version: artifact.version });
  const previous = artifact.share && Array.isArray(artifact.share.taskIds)
    ? artifact.share.taskIds
    : [];
  const merged = [...previous];
  for (const taskId of targets) if (!merged.includes(taskId)) merged.push(taskId);
  artifact.share = {
    version: artifact.version,
    contentHash: artifact.contentHash,
    taskIds: merged,
    byTaskId: byTaskId ? String(byTaskId).slice(0, ID_MAX) : null,
    sharedAt: (artifact.share && artifact.share.sharedAt) || nowIso(now),
    updatedAt: nowIso(now),
  };
  bumpStateVersion(artifact, now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit('artifact.shared', artifact, {
    now,
    taskId: byTaskId,
    reason: `share_targets:${merged.length}`,
  });
  return artifact;
}

/**
 * 共享读取的判定（只返回结论与版本，不返回正文）：
 * 供 worker-scope 先审计再读取，保证"拒绝时不回显内容"。
 * 已被 superseded 的旧版仍可读——版本不可变的语义要求旧版保留；
 * 只有显式 invalidated 才拒绝。
 */
function sharedAccess(id, { requesterTaskId = null, version = null } = {}) {
  const key = String(id || '').slice(0, ID_MAX);
  const artifact = key ? get(key) : null;
  if (!artifact) return { ok: false, state: 'not_found', version: null };
  const shareInfo = artifact.share;
  if (!shareInfo || !Array.isArray(shareInfo.taskIds)) {
    return { ok: false, state: 'not_shared', version: null };
  }
  const requester = String(requesterTaskId || '').slice(0, ID_MAX);
  if (!requester || !shareInfo.taskIds.includes(requester)) {
    return { ok: false, state: 'requester_not_allowed', version: null };
  }
  if (artifact.status === 'invalidated') {
    return { ok: false, state: 'invalidated', version: null };
  }
  const pinned = shareInfo.version;
  const requested = Number.isInteger(version) ? version : pinned;
  if (Number.isInteger(requested) && Number.isInteger(pinned) && requested !== pinned) {
    return { ok: false, state: 'version_mismatch', version: pinned };
  }
  return { ok: true, state: 'shared', version: pinned };
}

/** 共享读取：显式登记 + 版本钉住 + 正文 hash 校验；失败一律抛错（不返回内容）。 */
function readSharedArtifact(id, { requesterTaskId = null, version = null } = {}) {
  const access = sharedAccess(id, { requesterTaskId, version });
  if (!access.ok) {
    if (access.state === 'not_found') {
      throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: id });
    }
    if (access.state === 'version_mismatch') {
      throw new AgentError('artifact_version_mismatch', '共享产物版本不一致', 409, {
        artifactId: id,
        expectedVersion: access.version,
        refVersion: version,
      });
    }
    if (access.state === 'invalidated') {
      throw new AgentError('artifact_not_active', '共享产物已失效', 409, { artifactId: id });
    }
    throw new AgentError('artifact_not_shared', '产物未登记共享给该任务', 409, {
      artifactId: id,
    });
  }
  return readContent(id, { version: access.version });
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
// ---- §16 来源追踪与污点（provenanceRefs / taintLabels） ----
// 原文只要求 Task/Artifact 携带这两类字段、污点并集传播、唯一由可信验证/清洗组件
// 改变标签；未定义标签取值与"何种污点禁止何种工具"的策略。下列常量与取值均为
// 实现自定（待确认），本轮只做记录/传播/查询/校验，不做阻断策略。
const TAINT_POLICY_VERSION = 'taint-policy-v1';
const TAINT_UNKNOWN = 'unknown';
const TAINT_UNVERIFIED = 'unverified';
const TAINT_VERIFIED = 'verified';
const TAINT_LABEL_MAX = 20;
const TAINT_LABEL_LENGTH = 64;
const PROVENANCE_REF_MAX = 20;

function normalizeTaintLabels(value, field = 'taintLabels') {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentError('artifact_taint_invalid', `${field} 必须是标签数组`, 400, { field });
  }
  const labels = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new AgentError('artifact_taint_invalid', `${field} 只能包含非空字符串`, 400, {
        field,
      });
    }
    const label = item.trim();
    if (label.length > TAINT_LABEL_LENGTH) {
      throw new AgentError('artifact_taint_invalid', `${field} 单个标签过长`, 400, {
        field,
        maxLength: TAINT_LABEL_LENGTH,
      });
    }
    labels.add(label);
  }
  if (labels.size > TAINT_LABEL_MAX) {
    throw new AgentError('artifact_taint_invalid', `${field} 标签数量超限`, 400, {
      field,
      max: TAINT_LABEL_MAX,
    });
  }
  return [...labels].sort();
}

// 复用既有产物引用 schema {kind,id,version}；version 可省略（表示未钉版本）。
function normalizeProvenanceRefs(refs, field = 'provenanceRefs') {
  if (refs === null || refs === undefined) return [];
  if (!Array.isArray(refs)) {
    throw new AgentError('artifact_provenance_invalid', `${field} 必须是引用数组`, 400, {
      field,
    });
  }
  if (refs.length > PROVENANCE_REF_MAX) {
    throw new AgentError('artifact_provenance_invalid', `${field} 引用数量超限`, 400, {
      field,
      max: PROVENANCE_REF_MAX,
    });
  }
  const out = [];
  for (const item of refs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AgentError('artifact_provenance_invalid', `${field} 引用必须是对象`, 400, { field });
    }
    const id = String(item.id || '').trim().slice(0, ID_MAX);
    if (!id) {
      throw new AgentError('artifact_provenance_invalid', `${field} 引用缺少 id`, 400, { field });
    }
    const ref = { kind: null, id, version: null };
    if (item.kind !== null && item.kind !== undefined) {
      const kind = String(item.kind).trim();
      if (!kind || kind.length > 60) {
        throw new AgentError('artifact_provenance_invalid', `${field} 引用 kind 非法`, 400, {
          field,
        });
      }
      ref.kind = kind;
    }
    if (item.version !== null && item.version !== undefined) {
      if (!Number.isInteger(item.version) || item.version < 1) {
        throw new AgentError('artifact_provenance_invalid', `${field} 引用 version 必须是正整数`, 400, {
          field,
        });
      }
      ref.version = item.version;
    }
    out.push(ref);
  }
  return out;
}

// 读边界：缺字段的旧记录不得默认成"干净"，读作 unknown；
// 显式空集合表示"该对象没有任何上游污点"（新任务未读取任何内容），是合法状态。
function readTaintLabels(target) {
  const artifact = typeof target === 'string' ? get(target) : target;
  if (!artifact || !Array.isArray(artifact.taintLabels)) {
    return [TAINT_UNKNOWN];
  }
  return artifact.taintLabels
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim());
}

function currentTaintPolicyVersion() {
  try {
    return taintPolicy.currentPolicyVersion();
  } catch (_) {
    return TAINT_POLICY_VERSION;
  }
}

function readProvenanceRefs(target) {
  const artifact = typeof target === 'string' ? get(target) : target;
  if (!artifact || !Array.isArray(artifact.provenanceRefs)) return [];
  return artifact.provenanceRefs.map(item => ({ ...item }));
}

// 传播：上游引用可解析则取其标签；不可解析时按 unknown 处理（未知最保守）。
function inheritedTaintOf(refs) {
  const labels = new Set();
  for (const ref of refs) {
    let artifact = null;
    try {
      artifact = get(ref.id);
    } catch (_) {
      artifact = null;
    }
    if (
      !artifact ||
      (ref.kind && ref.kind !== artifact.kind) ||
      (Number.isInteger(ref.version) &&
        Number.isInteger(artifact.version) &&
        ref.version !== artifact.version)
    ) {
      labels.add(TAINT_UNKNOWN);
      continue;
    }
    for (const label of readTaintLabels(artifact)) labels.add(label);
  }
  return [...labels].sort();
}

function auditTaintRejection(artifactId, { writer, reason, now }) {
  try {
    appendAudit('artifact.taint_write_rejected', artifactId ? { id: artifactId } : null, {
      now,
      reason: `${String(reason || 'rejected')}|writer:${String(writer || '') || 'null'}`,
    });
  } catch (_) {
    // 审计失败不改变拒绝结论。
  }
}

/**
 * §16：只有 Verification Engine / 验证路径能改变 taintLabels（与 trustLevel 的唯一
 * 写入者一致）。生产者或其他路径的写入（含"清除标签"）一律拒绝并留痕。
 * 原文未定义标签取值与降级规则；本轮只实现"可记录 + 可校验"，不阻断工具。
 */
function setTaintLabels(id, { labels, writer, reason = null, now = Date.now() } = {}) {
  const key = String(id || '').slice(0, ID_MAX);
  if (String(writer || '') !== TRUST_WRITER) {
    auditTaintRejection(key, { writer, reason: 'not_authorized', now });
    throw new AgentError('not_authorized', 'taintLabels 只能由 Verification Engine 写入', 403, {
      artifactId: key || null,
      writer: writer ? String(writer).slice(0, 60) : null,
    });
  }
  let next;
  try {
    next = normalizeTaintLabels(labels);
  } catch (error) {
    auditTaintRejection(key, { writer, reason: 'invalid_labels', now });
    throw error;
  }
  const artifact = get(key);
  if (!artifact) {
    auditTaintRejection(key, { writer, reason: 'not_found', now });
    throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: key });
  }
  const previous = readTaintLabels(artifact).join(',');
  const store = readArtifacts();
  const record = store.artifacts[key];
  record.taintLabels = next;
  record.taintPolicyVersion = TAINT_POLICY_VERSION;
  record.taintChangedAt = nowIso(now);
  record.taintChangedBy = TRUST_WRITER;
  record.lastCheckedAt = nowIso(now);
  bumpStateVersion(record, now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit('artifact.taint_changed', record, {
    now,
    reason: `${previous}->${next.join(',')}${reason ? `|${String(reason).slice(0, 120)}` : ''}`,
  });
  return record;
}

/**
 * 验证路径把"未验证"标记转为已验证：移除 unverified、加入 verified。
 * unknown 保留（未知来源不能仅凭验证洗白，待确认）。
 */
function markTaintVerified(id, { writer, reason = 'verification_passed', now = Date.now() } = {}) {
  const key = String(id || '').slice(0, ID_MAX);
  const artifact = get(key);
  if (!artifact) {
    auditTaintRejection(key, { writer, reason: 'not_found', now });
    throw new AgentError('artifact_not_found', '产物引用不可读', 409, { artifactId: key });
  }
  const next = readTaintLabels(artifact)
    .filter(label => label !== TAINT_UNVERIFIED)
    .concat(TAINT_VERIFIED)
    .sort();
  return setTaintLabels(key, { labels: next, writer, reason, now });
}

function persist({
  kind,
  content,
  taskId = null,
  runId = null,
  provenanceRefs = [],
  sourceLabels = [],
  expectedVersion = null,
  now = Date.now(),
} = {}) {
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

  // §16：来源引用 + 污点并集（上游 ∪ 生产者自身来源标签 ∪ 未验证标记）。
  // 生产者只能追加标签，不能清除：交集结果始终保留上游标签。
  const cleanRefs = normalizeProvenanceRefs(provenanceRefs);
  const ownLabels = normalizeTaintLabels(sourceLabels, 'sourceLabels');
  const inheritedLabels = inheritedTaintOf(cleanRefs);
  const taintLabels = [...new Set([...inheritedLabels, ...ownLabels, TAINT_UNVERIFIED])].sort();

  // §17：新增 artifact reference 前做传递闭包检查；检测到 lineage 环即拒绝，
  // 且在任何落盘（正文/索引）之前抛错，不留半截记录。
  if (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    Array.isArray(content.evidence) &&
    content.evidence.length > 0
  ) {
    for (const item of content.evidence) {
      const refId = item && item.id ? String(item.id).slice(0, ID_MAX) : '';
      if (!refId) continue;
      cycleDetection.assertLineageAcyclic(refId, ref =>
        readContent(ref)
      );
    }
  }

  let store;
  try {
    store = readArtifacts();
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_read_failed');
  }

  // A-02：expectedVersion = 调用方读到的 lineage 当前 stateVersion。
  // 校验先于任何写入（含幂等正文重写），保证过期写入不产生任何副作用。
  const currentStateVersion = lineageMaxStateVersion(store, boundTaskId, artifactKind);
  if (expectedVersion !== null && expectedVersion !== undefined) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new AgentError('artifact_expected_version_invalid', 'expectedVersion 非法', 400, {
        expectedVersion,
      });
    }
    if (expectedVersion !== currentStateVersion) {
      const head = Object.values(store.artifacts)
        .filter(item => item && item.taskId === boundTaskId && item.kind === artifactKind)
        .sort((a, b) => stateVersionOf(b) - stateVersionOf(a))[0];
      raiseArtifactConflict({
        taskId: boundTaskId,
        kind: artifactKind,
        expectedVersion,
        currentVersion: currentStateVersion,
        attemptedId: id,
        headId: head ? head.id : null,
        runId,
        now,
      });
    }
  }

  const existing = store.artifacts[id];
  if (existing) {
    // 幂等：同一产物重复落盘不新增记录、不改 refCount、不提升 stateVersion。
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
    // 注意：superseded 是生命周期裁决，不单独抬 lineage 计数；
    // 本条写入的 stateVersion = currentStateVersion + 1，lineage 头部唯一。
  }

  const artifact = {
    id,
    kind: artifactKind,
    version,
    // A-02：lineage 级单调版本；旧记录缺字段时按 0 兜底。
    stateVersion: currentStateVersion + 1,
    stateVersionChangedAt: nowIso(now),
    createdAt: nowIso(now),
    contentHash,
    refCount: 0,
    status: 'active',
    // 刚落盘即 pending-commit：只有任务状态提交成功并确认引用后才 committed。
    commit: 'pending-commit',
    taskId: boundTaskId,
    runId: runId ? String(runId).slice(0, 80) : null,
    refs: [],
    // §27：新 Artifact 默认 untrusted；内容/来源/版本变化时由新记录重新从 untrusted 开始。
    trustLevel: 'untrusted',
    trust: null,
    // §16：来源引用与污点标签。旧记录缺字段时读作 unknown（见 readTaintLabels）。
    provenanceRefs: cleanRefs,
    taintLabels,
    taintPolicyVersion: currentTaintPolicyVersion(),
    taintChangedAt: null,
    taintChangedBy: null,
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
    bumpStateVersion(artifact, now);
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
  bumpStateVersion(artifact, now);
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
  bumpStateVersion(artifact, now);
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
  bumpStateVersion(artifact, now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit(`artifact.${status}`, artifact, { now, reason });
  return artifact;
}

/**
 * §27：trustLevel 的唯一写入口。
 * 唯一写入者是 Verification Engine——Producer/Orchestrator/Gateway 一律拒绝；
 * trustLevel 不代表访问权限，授权仍由 Policy Engine 独立判断。
 * 记录同时保存验证策略版本、验证器、时间、证据与适用范围（字段名原文未定义，待确认）。
 */
// 越权/非法写入被拒也要留痕：审计不可用时不得掩盖原拒绝（仍抛原错误）。
function auditTrustRejection(artifactId, { writer, level, reason, now }) {
  try {
    appendAudit('artifact.trust_level_write_rejected', artifactId ? { id: artifactId } : null, {
      now,
      reason: `${String(reason || 'rejected')}|writer:${String(writer || '') || 'null'}|level:${
        String(level || '') || 'null'
      }`,
    });
  } catch (_) {
    // 审计失败不改变拒绝结论。
  }
}

function setTrustLevel(
  id,
  {
    level,
    writer,
    policyVersion = null,
    evidenceRefs = [],
    scope = null,
    reason = null,
    now = Date.now(),
  } = {}
) {
  const key = String(id || '').slice(0, ID_MAX);
  if (String(writer || '') !== TRUST_WRITER) {
    auditTrustRejection(key, { writer, level, reason: 'not_authorized', now });
    throw new AgentError('not_authorized', 'trustLevel 只能由 Verification Engine 写入', 403, {
      artifactId: key || null,
      writer: writer ? String(writer).slice(0, 60) : null,
    });
  }
  const next = String(level || '');
  if (!TRUST_LEVELS.includes(next)) {
    auditTrustRejection(key, { writer, level, reason: 'invalid_level', now });
    throw new AgentError('artifact_trust_level_invalid', 'trustLevel 取值非法', 400, {
      artifactId: key || null,
      level: next || null,
      allowed: TRUST_LEVELS.slice(),
    });
  }
  const store = readArtifacts();
  const artifact = store.artifacts[key];
  if (!artifact) throw new AgentError('artifact_not_found', '产物不存在', 404, { artifactId: key });
  const previous = TRUST_LEVELS.includes(artifact.trustLevel) ? artifact.trustLevel : 'untrusted';
  artifact.trustLevel = next;
  artifact.trust = {
    policyVersion: policyVersion === null ? null : String(policyVersion).slice(0, 60),
    verifier: TRUST_WRITER,
    verifiedAt: nowIso(now),
    evidenceRefs: Array.isArray(evidenceRefs)
      ? evidenceRefs.map(item => String(item).slice(0, ID_MAX)).slice(0, 20)
      : [],
    scope: scope === null ? null : String(scope).slice(0, 120),
    // 变更原因（尤其降级原因）随记录保存；字段名原文未定义（待确认）。
    reason: reason === null ? null : String(reason).slice(0, 200),
  };
  artifact.lastCheckedAt = nowIso(now);
  bumpStateVersion(artifact, now);
  try {
    writeArtifacts(store);
  } catch (error) {
    throw wrapStoreError(error, 'artifact_store_write_failed');
  }
  appendAudit('artifact.trust_level_changed', artifact, {
    now,
    reason: `${previous}->${next}${reason ? `|${String(reason).slice(0, 120)}` : ''}`,
  });
  return artifact;
}

/**
 * 读边界兼容旧数据：缺字段（或历史非法值）按 §27 默认值 untrusted 返回，
 * 不因为老记录没有 trustLevel 而报错；降级方向回退是安全的（fail-closed）。
 */
function readTrustLevel(id) {
  const key = String(id || '').slice(0, ID_MAX);
  if (!key) throw new AgentError('artifact_not_found', '产物不存在', 404, { artifactId: null });
  const artifact = get(key);
  if (!artifact) throw new AgentError('artifact_not_found', '产物不存在', 404, { artifactId: key });
  return TRUST_LEVELS.includes(artifact.trustLevel) ? artifact.trustLevel : 'untrusted';
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

// Phase 2 第 2 项：来源追踪。沿产物正文里的 evidence 引用逐环复读；
// 链上任一环缺失、版本不符、invalidated 或非 active（含 superseded）即失败，
// 用固定错误码 artifact_chain_broken 表达，details.reason 区分原因。
const PROVENANCE_MAX_DEPTH = 3;
const PROVENANCE_MAX_REFS = 20;

function chainBroken(reason, artifactId) {
  return new AgentError('artifact_chain_broken', '证据链不可追溯', 409, {
    reason,
    artifactId: artifactId || null,
  });
}

function resolveProvenance(
  id,
  { version = null, maxDepth = PROVENANCE_MAX_DEPTH, allowStatuses = ['active'] } = {}
) {
  const statuses = Array.isArray(allowStatuses) && allowStatuses.length > 0 ? allowStatuses : ['active'];
  const chain = [];
  const visited = new Set();
  const walk = (refId, refVersion, depth) => {
    const key = String(refId || '').slice(0, ID_MAX);
    if (!key) throw chainBroken('missing', null);
    const artifact = get(key);
    if (!artifact) throw chainBroken('missing', key);
    if (
      Number.isInteger(refVersion) &&
      Number.isInteger(artifact.version) &&
      refVersion !== artifact.version
    ) {
      throw chainBroken('version_mismatch', key);
    }
    if (artifact.status === 'invalidated') throw chainBroken('invalidated', key);
    if (!statuses.includes(artifact.status)) throw chainBroken('stale', key);
    if (depth > maxDepth) throw chainBroken('depth_exceeded', key);
    const marker = `${key}@${artifact.version}`;
    if (visited.has(marker)) throw chainBroken('cycle', key);
    visited.add(marker);
    const read = readContent(key, { version: artifact.version });
    chain.push({ kind: read.kind, id: key, version: artifact.version });
    const evidence = read.content && read.content.evidence;
    if (Array.isArray(evidence) && evidence.length > 0) {
      if (evidence.length > PROVENANCE_MAX_REFS) throw chainBroken('refs_exceeded', key);
      for (const item of evidence) {
        walk(
          item && item.id,
          item && Number.isInteger(item.version) ? item.version : null,
          depth + 1
        );
      }
    }
  };
  walk(id, Number.isInteger(version) ? version : null, 0);
  return chain;
}

module.exports = {
  ARTIFACTS_FILE,
  AUDIT_FILE,
  CONTENTS_DIR,
  CONTENT_MAX_BYTES,
  SCHEMA_VERSION,
  STATUSES,
  COMMIT_STATES,
  TRUST_LEVELS,
  TRUST_WRITER,
  trustRank,
  trustAtLeast,
  stateVersionOf,
  lineageStateVersion,
  TAINT_POLICY_VERSION,
  TAINT_UNKNOWN,
  TAINT_UNVERIFIED,
  TAINT_VERIFIED,
  currentTaintPolicyVersion,
  normalizeTaintLabels,
  normalizeProvenanceRefs,
  readTaintLabels,
  readProvenanceRefs,
  inheritedTaintOf,
  setTaintLabels,
  markTaintVerified,
  empty,
  persist,
  get,
  all,
  readContent,
  versionsOf,
  setTrustLevel,
  readTrustLevel,
  share,
  sharedAccess,
  readSharedArtifact,
  resolveProvenance,
  assertRefsCommitReady,
  confirmRefs,
  markOrphan,
  markScanned,
  markStatus,
  purge,
  auditFailure,
  auditEntries,
};
