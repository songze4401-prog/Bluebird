/* global module, __dirname, process */
/**
 * Phase 1 前置 ④：R0/R1 fail-open 显式策略表（v1.3 §33）。
 *
 * 本模块只负责策略表的存储、七字段校验、命中判定与审计，不做工具执行。
 * 判定默认 fail-closed：未命中、字段缺失、动作/参数/主体/环境不匹配、过期、
 * 次数用尽、已撤销、策略表不可读、审计写入失败，一律返回 `allowed: false`。
 * 撤销立即生效：每次判定都重新读取策略文件，不保留跨请求缓存。
 *
 * 数值口径：
 * - 策略有效期上限 90 天（A 类：§36.2 已采纳的安全默认值，待实测校准）；
 * - 审计文件保留 500 条（B 类容量上限：未压测，仅作防膨胀的安全上限）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const POLICIES_FILE = path.join(AGENTS_DIR, 'agent-failopen-policies.json');
const AUDIT_FILE = path.join(AGENTS_DIR, 'agent-failopen-audit.json');
const SCHEMA_VERSION = 1;
const AUDIT_MAX = 500;
// A 类：fail-open 策略有效期上限 90 天（§36.2），单次有效期按 validity 更短者生效。
const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

const RISK_LEVELS = new Set(['R0', 'R1']);
const RISK_LEVEL_PATTERN = /^R[0-3]$/;
const ENVIRONMENTS = new Set(['dev', 'staging', 'prod']);
const RESERVED_SUBJECTS = new Set(['agent', 'orchestrator', 'gateway']);
const REQUIRED_AUDIT_FIELDS = Object.freeze([
  'policyId',
  'policyVersion',
  'matchedRule',
  'action',
  'paramsDigest',
  'subject',
  'taskId',
  'runId',
  'decision',
  'at',
  'traceId',
  'preAuthorizedBy',
]);

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, policyVersion: 0, policies: {} };
}

// 精确 token：禁止通配符、正则与前缀匹配（§33.2 第 1 条）。
function exactToken(value, max = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (/[*?|]/.test(trimmed)) return null;
  return trimmed;
}

function isReservedSubject(value) {
  return RESERVED_SUBJECTS.has(String(value || '').trim().toLowerCase());
}

function loadStore() {
  ensureDir();
  if (!fs.existsSync(POLICIES_FILE)) return { ok: true, store: emptyStore() };
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICIES_FILE, 'utf8'));
    if (
      !isPlainObject(parsed) ||
      parsed.version !== SCHEMA_VERSION ||
      !Number.isInteger(parsed.policyVersion) ||
      parsed.policyVersion < 0 ||
      !isPlainObject(parsed.policies) ||
      Array.isArray(parsed.policies)
    ) {
      return { ok: false, reason: 'policy_unreadable' };
    }
    return { ok: true, store: parsed };
  } catch (_) {
    return { ok: false, reason: 'policy_unreadable' };
  }
}

function saveStore(store) {
  ensureDir();
  writeFileAtomicSync(POLICIES_FILE, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(POLICIES_FILE, 0o600);
  } catch (_) {
    // Windows chmod 语义有限；策略文件仍在数据目录内。
  }
}

function readAuditRecords() {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) return null;
    return parsed.records;
  } catch (_) {
    return null;
  }
}

// 审计先行：写入失败即返回 ok:false，调用方必须据此拒绝执行（§33.1 第 5 条）。
function appendAudit(entry) {
  const record = {
    policyId: entry.policyId || null,
    policyVersion: Number.isInteger(entry.policyVersion) ? entry.policyVersion : null,
    matchedRule: entry.matchedRule || null,
    action: entry.action || null,
    paramsDigest: entry.paramsDigest || null,
    subject: entry.subject || null,
    taskId: entry.taskId || null,
    runId: entry.runId || null,
    decision: String(entry.decision || 'denied'),
    at: entry.at || nowIso(),
    traceId: entry.traceId || `trace_${crypto.randomUUID()}`,
    preAuthorizedBy: entry.preAuthorizedBy || null,
    reason: entry.reason || null,
  };
  const existing = readAuditRecords();
  if (existing === null) return { ok: false, record };
  try {
    existing.push(record);
    writeFileAtomicSync(
      AUDIT_FILE,
      JSON.stringify({ version: SCHEMA_VERSION, records: existing.slice(-AUDIT_MAX) }, null, 2)
    );
    return { ok: true, record };
  } catch (_) {
    return { ok: false, record };
  }
}

function validatePolicy(policy) {
  const problems = [];
  if (!isPlainObject(policy)) return { ok: false, problems: ['policy'] };

  const scope = policy.actionScope;
  if (!isPlainObject(scope)) {
    problems.push('actionScope');
  } else {
    for (const key of ['tool', 'operation', 'paramsDigest', 'targetScope']) {
      if (!exactToken(scope[key])) problems.push(`actionScope.${key}`);
    }
    if (scope.planVersion !== undefined && scope.planVersion !== null) {
      if (!exactToken(scope.planVersion)) problems.push('actionScope.planVersion');
    }
  }

  const subjects = policy.preAuthorizedSubjects;
  if (!Array.isArray(subjects) || subjects.length === 0 || subjects.length > 20) {
    problems.push('preAuthorizedSubjects');
  } else {
    const cleaned = subjects.map(item => exactToken(item, 80));
    if (cleaned.some(item => !item || isReservedSubject(item))) {
      problems.push('preAuthorizedSubjects');
    }
  }

  if (!RISK_LEVELS.has(policy.riskLevel)) problems.push('riskLevel');

  const validity = policy.validity;
  if (!isPlainObject(validity)) {
    problems.push('validity');
  } else {
    const notBefore = Date.parse(validity.notBefore);
    const expiresAt = Date.parse(validity.expiresAt);
    if (!Number.isFinite(notBefore)) problems.push('validity.notBefore');
    if (!Number.isFinite(expiresAt)) problems.push('validity.expiresAt');
    if (
      Number.isFinite(notBefore) &&
      Number.isFinite(expiresAt) &&
      (expiresAt <= notBefore || expiresAt - notBefore > MAX_VALIDITY_MS)
    ) {
      problems.push('validity.window');
    }
    if (!Number.isInteger(validity.maxUses) || validity.maxUses < 1 || validity.maxUses > 1000) {
      problems.push('validity.maxUses');
    }
    if (!['single', 'long-lived'].includes(validity.type)) {
      problems.push('validity.type');
    } else if (validity.type === 'single' && validity.maxUses !== 1) {
      problems.push('validity.maxUses');
    }
  }

  const env = policy.environmentScope;
  if (!isPlainObject(env)) {
    problems.push('environmentScope');
  } else {
    if (!ENVIRONMENTS.has(env.environment)) problems.push('environmentScope.environment');
    if (!Array.isArray(env.resources) || env.resources.length === 0 || env.resources.length > 20) {
      problems.push('environmentScope.resources');
    } else if (env.resources.map(item => exactToken(item, 120)).some(item => !item)) {
      problems.push('environmentScope.resources');
    }
  }

  const audit = policy.auditRecord;
  if (!isPlainObject(audit)) {
    problems.push('auditRecord');
  } else {
    if (typeof audit.schema !== 'string' || !audit.schema.trim()) {
      problems.push('auditRecord.schema');
    }
    if (
      !Array.isArray(audit.requiredFields) ||
      REQUIRED_AUDIT_FIELDS.some(field => !audit.requiredFields.includes(field))
    ) {
      problems.push('auditRecord.requiredFields');
    }
  }

  const revocation = policy.revocation;
  if (!isPlainObject(revocation)) {
    problems.push('revocation');
  } else {
    if (!Array.isArray(revocation.authority) || revocation.authority.length === 0) {
      problems.push('revocation.authority');
    }
    if (revocation.effect !== 'immediate') problems.push('revocation.effect');
    if (revocation.propagation !== 'next-request') problems.push('revocation.propagation');
  }

  return { ok: problems.length === 0, problems };
}

function currentPolicyVersion() {
  const loaded = loadStore();
  return loaded.ok ? loaded.store.policyVersion : null;
}

function listPolicies() {
  const loaded = loadStore();
  if (!loaded.ok) return { ok: false, reason: loaded.reason, policies: [] };
  return {
    ok: true,
    policyVersion: loaded.store.policyVersion,
    policies: Object.values(loaded.store.policies).map(clone),
  };
}

function listAudit({ limit = 50 } = {}) {
  const records = readAuditRecords();
  if (records === null) return [];
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return records.slice(-max).map(clone);
}

/**
 * 新增策略：七字段全部通过校验才落库，任一缺失即拒绝（§33.2）。
 * 每次变更 policyVersion + 1，并写变更审计（§33.3）。
 */
function addPolicy(input = {}, { now = Date.now() } = {}) {
  const draft = isPlainObject(input) ? input : {};
  const checked = validatePolicy(draft);
  if (!checked.ok) {
    return { ok: false, reason: 'invalid_policy', problems: checked.problems };
  }

  const loaded = loadStore();
  if (!loaded.ok) return { ok: false, reason: loaded.reason, problems: [loaded.reason] };
  const store = loaded.store;
  const nextVersion = store.policyVersion + 1;
  const createdBy = exactToken(draft.createdBy, 80) || 'local-owner';
  const approvedBy = exactToken(draft.approvedBy, 80) || createdBy;
  if (isReservedSubject(createdBy) || isReservedSubject(approvedBy)) {
    return { ok: false, reason: 'invalid_policy', problems: ['preAuthorizedSubjects'] };
  }

  const policy = {
    policyId: `fp_${crypto.randomUUID()}`,
    policyVersion: nextVersion,
    status: 'active',
    uses: 0,
    createdAt: nowIso(now),
    createdBy,
    approvedBy,
    approvedAt: nowIso(now),
    actionScope: clone(draft.actionScope),
    preAuthorizedSubjects: clone(draft.preAuthorizedSubjects),
    riskLevel: draft.riskLevel,
    validity: clone(draft.validity),
    environmentScope: clone(draft.environmentScope),
    auditRecord: clone(draft.auditRecord),
    revocation: clone(draft.revocation),
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  };

  const matchedRule = `${policy.policyId}@${nextVersion}`;
  const audited = appendAudit({
    policyId: policy.policyId,
    policyVersion: nextVersion,
    matchedRule,
    action: 'policy.create',
    subject: approvedBy,
    decision: 'policy.created',
    at: nowIso(now),
    traceId: `policy_${policy.policyId}`,
    preAuthorizedBy: approvedBy,
    reason: 'created',
  });
  if (!audited.ok) {
    return { ok: false, reason: 'audit_unavailable', problems: ['audit_unavailable'] };
  }

  store.policyVersion = nextVersion;
  store.policies[policy.policyId] = policy;
  try {
    saveStore(store);
  } catch (_) {
    return { ok: false, reason: 'policy_unwritable', problems: ['policy_unwritable'] };
  }
  return { ok: true, policy: clone(policy), policyVersion: nextVersion, audit: audited.record };
}

/**
 * 撤销：立即生效（每次判定都读最新策略文件）。
 * 撤销权独立于编辑权（§33.3）；撤销后未完成请求不得继续（§33.2 第 7 条）。
 */
function revokePolicy(policyId, { revokedBy = null, reason = null, now = Date.now() } = {}) {
  const loaded = loadStore();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const store = loaded.store;
  const policy = store.policies[String(policyId || '')];
  if (!policy) return { ok: false, reason: 'not_found' };
  if (policy.status === 'revoked') {
    return { ok: false, reason: 'already_revoked', policyVersion: store.policyVersion };
  }

  const actor = exactToken(revokedBy, 80) || 'local-owner';
  if (isReservedSubject(actor)) return { ok: false, reason: 'invalid_revoker' };

  policy.status = 'revoked';
  policy.revokedAt = nowIso(now);
  policy.revokedBy = actor;
  policy.revokeReason = typeof reason === 'string' ? reason.slice(0, 200) : null;
  store.policyVersion += 1;

  try {
    saveStore(store);
  } catch (_) {
    return { ok: false, reason: 'policy_unwritable' };
  }

  const audited = appendAudit({
    policyId: policy.policyId,
    policyVersion: store.policyVersion,
    matchedRule: `${policy.policyId}@${policy.policyVersion}`,
    action: 'policy.revoke',
    subject: actor,
    decision: 'policy.revoked',
    at: nowIso(now),
    traceId: `policy_${policy.policyId}`,
    preAuthorizedBy: actor,
    reason: policy.revokeReason,
  });

  return {
    ok: true,
    policyId: policy.policyId,
    policyVersion: store.policyVersion,
    auditWritten: audited.ok,
  };
}

function actionMatches(scope, request) {
  if (scope.tool !== request.tool || scope.operation !== request.operation) return false;
  if (scope.planVersion !== null && scope.planVersion !== undefined) {
    return scope.planVersion === request.planVersion;
  }
  return true;
}

function checkMatch(policy, request, now) {
  const scope = policy.actionScope;
  if (!actionMatches(scope, request)) {
    return { ok: false, actionMatched: false, reason: 'action_mismatch' };
  }
  if (scope.paramsDigest !== request.paramsDigest) {
    return { ok: false, actionMatched: true, reason: 'params_mismatch' };
  }
  if (scope.targetScope !== request.targetScope) {
    return { ok: false, actionMatched: true, reason: 'target_mismatch' };
  }
  if (policy.riskLevel !== request.riskLevel) {
    return { ok: false, actionMatched: true, reason: 'risk_mismatch' };
  }
  if (!policy.preAuthorizedSubjects.includes(request.subject)) {
    return { ok: false, actionMatched: true, reason: 'subject_not_preauthorized' };
  }
  if (policy.environmentScope.environment !== request.environment) {
    return { ok: false, actionMatched: true, reason: 'environment_mismatch' };
  }
  if (!policy.environmentScope.resources.includes(request.resource)) {
    return { ok: false, actionMatched: true, reason: 'resource_mismatch' };
  }
  if (now < Date.parse(policy.validity.notBefore)) {
    return { ok: false, actionMatched: true, reason: 'not_before' };
  }
  if (now >= Date.parse(policy.validity.expiresAt)) {
    return { ok: false, actionMatched: true, reason: 'expired' };
  }
  if ((Number(policy.uses) || 0) >= policy.validity.maxUses) {
    return { ok: false, actionMatched: true, reason: 'uses_exhausted' };
  }
  return { ok: true };
}

function deny(reason, request, policyVersion, traceId) {
  const audited = appendAudit({
    policyId: null,
    policyVersion,
    matchedRule: null,
    action: request.action || null,
    paramsDigest: request.paramsDigest || null,
    subject: request.subject || null,
    taskId: request.taskId || null,
    runId: request.runId || null,
    decision: 'denied',
    traceId,
    reason,
  });
  return {
    allowed: false,
    reason,
    policyId: null,
    policyVersion,
    matchedRule: null,
    traceId,
    auditWritten: audited.ok,
  };
}

/**
 * 判定入口：默认 fail-closed。
 * 输入必须是已解析的服务端事实，不接受调用方“风险等级自报降级”——
 * R2/R3 在这里直接拒绝，永不 fail-open（§33.1 第 2 条）。
 */
function evaluate(request = {}, { now = Date.now() } = {}) {
  const traceId = exactToken(request.traceId, 120) || `trace_${crypto.randomUUID()}`;
  const normalized = {
    tool: exactToken(request.tool),
    operation: exactToken(request.operation),
    paramsDigest: exactToken(request.paramsDigest),
    targetScope: exactToken(request.targetScope),
    planVersion:
      request.planVersion === undefined || request.planVersion === null
        ? null
        : exactToken(request.planVersion),
    subject: exactToken(request.subject, 80),
    environment: exactToken(request.environment, 40),
    resource: exactToken(request.resource, 120),
    riskLevel: exactToken(request.riskLevel, 8),
    taskId: request.taskId ? String(request.taskId).slice(0, 120) : null,
    runId: request.runId ? String(request.runId).slice(0, 120) : null,
    traceId,
  };
  normalized.action = `${normalized.tool || ''}:${normalized.operation || ''}`;

  if (!normalized.riskLevel || !RISK_LEVEL_PATTERN.test(normalized.riskLevel)) {
    return deny('invalid_request', normalized, currentPolicyVersion(), traceId);
  }
  // R2/R3 永不 fail-open；白名单配置成 R2/R3 也无法命中。
  if (!RISK_LEVELS.has(normalized.riskLevel)) {
    return deny('risk_not_allowed', normalized, currentPolicyVersion(), traceId);
  }
  if (
    !normalized.tool ||
    !normalized.operation ||
    !normalized.paramsDigest ||
    !normalized.targetScope ||
    !normalized.subject ||
    !normalized.environment ||
    !normalized.resource
  ) {
    return deny('invalid_request', normalized, currentPolicyVersion(), traceId);
  }

  const loaded = loadStore();
  if (!loaded.ok) return deny(loaded.reason, normalized, null, traceId);
  const store = loaded.store;

  let matched = null;
  let reason = 'no_policy';
  let revokedSeen = false;
  for (const policy of Object.values(store.policies)) {
    const schema = validatePolicy(policy);
    if (!schema.ok) {
      reason = 'invalid_policy';
      continue;
    }
    if (policy.status === 'revoked') {
      if (actionMatches(policy.actionScope, normalized)) revokedSeen = true;
      continue;
    }
    if (policy.status !== 'active') continue;
    const checked = checkMatch(policy, normalized, now);
    if (checked.ok) {
      matched = policy;
      break;
    }
    if (checked.actionMatched && reason === 'no_policy') reason = checked.reason;
  }

  if (!matched) {
    return deny(revokedSeen ? 'revoked' : reason, normalized, store.policyVersion, traceId);
  }

  matched.uses = (Number(matched.uses) || 0) + 1;
  try {
    saveStore(store);
  } catch (_) {
    return deny('policy_unwritable', normalized, store.policyVersion, traceId);
  }

  const matchedRule = `${matched.policyId}@${matched.policyVersion}`;
  const audited = appendAudit({
    policyId: matched.policyId,
    policyVersion: store.policyVersion,
    matchedRule,
    action: normalized.action,
    paramsDigest: normalized.paramsDigest,
    subject: normalized.subject,
    taskId: normalized.taskId,
    runId: normalized.runId,
    decision: 'allowed',
    traceId,
    preAuthorizedBy: matched.approvedBy,
    reason: 'allowed',
  });
  if (!audited.ok) {
    // 审计写入失败不得执行：本次判定改为拒绝（§33.1 第 5 条）。
    return {
      allowed: false,
      reason: 'audit_unavailable',
      policyId: matched.policyId,
      policyVersion: store.policyVersion,
      matchedRule,
      traceId,
      auditWritten: false,
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    policyId: matched.policyId,
    policyVersion: store.policyVersion,
    matchedRule,
    traceId,
    auditWritten: true,
  };
}

module.exports = {
  POLICIES_FILE,
  AUDIT_FILE,
  MAX_VALIDITY_MS,
  REQUIRED_AUDIT_FIELDS,
  currentPolicyVersion,
  getPolicyVersion: currentPolicyVersion,
  addPolicy,
  revokePolicy,
  evaluate,
  validatePolicy,
  listPolicies,
  listAudit,
};
