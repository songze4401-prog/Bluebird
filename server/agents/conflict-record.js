/* global module, __dirname, process */
/**
 * §28 ConflictRecord：冲突记录的可序列化对象 + 持久化 + 审计。
 *
 * 原文依据（Notion v1.2 §28）字段：
 * conflictId / subjectKey / candidateRefs / conflictType / evidenceRefs /
 * resolutionStatus / resolutionMethod / selectedCandidateRef / rationale /
 * decidedBy / decidedAt / policyVersion。
 * conflictType：factual / preference / policy / temporal / identity；
 * resolutionStatus：open / resolved / unresolved / escalated；
 * resolutionMethod：rule / review / human。
 *
 * 原文未定义的部分一律标"待确认"，不做猜测性扩展：
 * - candidateRefs / evidenceRefs 的元素形态未定义，本实现用字符串引用；
 * - policyVersion 取值未定义，本实现用固定规则版本常量。
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
const RECORDS_FILE = path.join(AGENTS_DIR, 'agent-conflict-records.json');
const SCHEMA_VERSION = 1;
const CONFLICT_TYPES = ['factual', 'preference', 'policy', 'temporal', 'identity'];
const RESOLUTION_STATUSES = ['open', 'resolved', 'unresolved', 'escalated'];
const RESOLUTION_METHODS = ['rule', 'review', 'human'];
// 原文要求记录"使用的冲突裁决规则版本"，但未定义取值；先用稳定常量，待确认。
const DEFAULT_POLICY_VERSION = 'conflict-rules-v1';

function fingerprintOf(input) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        input.subjectKey,
        input.conflictType,
        input.candidateRefs,
        input.evidenceRefs,
      ])
    )
    .digest('hex')
    .slice(0, 32);
}

function contractError(code, status, message, details = {}) {
  return new AgentError(code, message, status, {
    errorCode: code,
    retryable: true,
    errorFingerprint: fingerprintOf(details),
    failedAt: new Date().toISOString(),
    taskId: details.taskId || null,
    runId: details.runId || null,
    causeRef: details.causeRef || '',
  });
}

function load() {
  if (!fs.existsSync(RECORDS_FILE)) {
    return { version: SCHEMA_VERSION, records: {}, audit: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    return {
      version: SCHEMA_VERSION,
      records:
        parsed && parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      audit: parsed && Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (error) {
    // 读取失败 fail-closed：不把损坏的存储当成"没有冲突"。
    throw contractError('internal_error', 500, `冲突记录不可读：${error.message}`, {
      causeRef: 'conflict_record_unreadable',
    });
  }
}

function save(store) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  writeFileAtomicSync(RECORDS_FILE, JSON.stringify(store, null, 2));
}

function createRecord(input = {}) {
  const subjectKey = String(input.subjectKey || '').trim();
  if (!subjectKey) throw new AgentError('validation_failed', 'subjectKey 不能为空', 400);
  const conflictType = String(input.conflictType || '');
  if (!CONFLICT_TYPES.includes(conflictType)) {
    throw new AgentError('validation_failed', `conflictType 非法：${conflictType}`, 400);
  }
  const resolutionStatus = String(input.resolutionStatus || 'open');
  if (!RESOLUTION_STATUSES.includes(resolutionStatus)) {
    throw new AgentError('validation_failed', `resolutionStatus 非法：${resolutionStatus}`, 400);
  }
  const resolutionMethod =
    input.resolutionMethod === null || input.resolutionMethod === undefined
      ? null
      : String(input.resolutionMethod);
  if (resolutionMethod !== null && !RESOLUTION_METHODS.includes(resolutionMethod)) {
    throw new AgentError('validation_failed', `resolutionMethod 非法：${resolutionMethod}`, 400);
  }
  const candidateRefs = Array.isArray(input.candidateRefs)
    ? input.candidateRefs.map(String)
    : [];
  const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String) : [];
  const selectedCandidateRef =
    input.selectedCandidateRef === null || input.selectedCandidateRef === undefined
      ? null
      : String(input.selectedCandidateRef);
  const decidedBy =
    input.decidedBy === null || input.decidedBy === undefined ? null : String(input.decidedBy);
  const decidedAt =
    input.decidedAt === null || input.decidedAt === undefined ? null : String(input.decidedAt);

  // 已裁决必须齐备；未裁决必须为空，避免"看起来已解决但无裁决主体"的脏记录。
  if (resolutionStatus === 'resolved') {
    if (!resolutionMethod || !selectedCandidateRef || !decidedBy || !decidedAt) {
      throw new AgentError('validation_failed', 'resolved 记录必须包含裁决方法/候选/主体/时间', 400);
    }
    if (!candidateRefs.includes(selectedCandidateRef)) {
      throw new AgentError('validation_failed', 'selectedCandidateRef 不在 candidateRefs 内', 400);
    }
  } else if (selectedCandidateRef || decidedBy || decidedAt) {
    throw new AgentError('validation_failed', '未裁决记录不得携带裁决结果', 400);
  }

  const fingerprint = fingerprintOf({ subjectKey, conflictType, candidateRefs, evidenceRefs });
  return {
    conflictId: input.conflictId ? String(input.conflictId) : `conflict_${fingerprint}`,
    subjectKey,
    candidateRefs,
    conflictType,
    evidenceRefs,
    resolutionStatus,
    resolutionMethod,
    selectedCandidateRef,
    rationale: String(input.rationale || ''),
    decidedBy,
    decidedAt,
    policyVersion: String(input.policyVersion || DEFAULT_POLICY_VERSION),
    taskId: input.taskId ? String(input.taskId) : null,
    runId: input.runId ? String(input.runId) : null,
    createdAt: input.createdAt ? String(input.createdAt) : new Date().toISOString(),
  };
}

function persist(record) {
  const store = load();
  if (store.records[record.conflictId]) {
    return store.records[record.conflictId];
  }
  store.records[record.conflictId] = record;
  store.audit.push({
    action: 'conflict.recorded',
    conflictId: record.conflictId,
    conflictType: record.conflictType,
    resolutionStatus: record.resolutionStatus,
    at: new Date().toISOString(),
  });
  save(store);
  return record;
}

function getRecord(conflictId) {
  const store = load();
  const record = store.records[String(conflictId)];
  if (!record) throw new AgentError('conflict_not_found', '冲突记录不存在', 404);
  return record;
}

function listRecords() {
  return Object.values(load().records);
}

function readAudit() {
  return load().audit.slice();
}

function resolveRecord(conflictId, decision = {}) {
  const store = load();
  const record = store.records[String(conflictId)];
  if (!record) throw new AgentError('conflict_not_found', '冲突记录不存在', 404);
  if (record.resolutionStatus !== 'open') {
    throw new AgentError('validation_failed', '只有 open 状态的冲突记录可以裁决', 400);
  }
  const next = createRecord({
    ...record,
    resolutionStatus: decision.resolutionStatus,
    resolutionMethod: decision.resolutionMethod,
    selectedCandidateRef: decision.selectedCandidateRef,
    rationale: decision.rationale === undefined ? record.rationale : decision.rationale,
    decidedBy: decision.decidedBy,
    decidedAt:
      decision.resolutionStatus === 'resolved'
        ? decision.decidedAt || new Date().toISOString()
        : null,
  });
  next.conflictId = record.conflictId;
  store.records[record.conflictId] = next;
  store.audit.push({
    action: 'conflict.resolved',
    conflictId: record.conflictId,
    resolutionStatus: next.resolutionStatus,
    resolutionMethod: next.resolutionMethod,
    at: new Date().toISOString(),
  });
  save(store);
  return next;
}

function resetForTests() {
  if (fs.existsSync(RECORDS_FILE)) fs.rmSync(RECORDS_FILE);
}

module.exports = {
  CONFLICT_TYPES,
  RESOLUTION_STATUSES,
  RESOLUTION_METHODS,
  DEFAULT_POLICY_VERSION,
  RECORDS_FILE,
  createRecord,
  persist,
  getRecord,
  listRecords,
  readAudit,
  resolveRecord,
  resetForTests,
};
