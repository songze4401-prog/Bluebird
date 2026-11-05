/* global require, process */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-conflict-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;

const conflicts = require('../server/agents/conflict-record');

function baseInput(extra = {}) {
  return {
    subjectKey: 'task_1:artifact_1',
    candidateRefs: ['artifact_a', 'artifact_b'],
    conflictType: 'factual',
    evidenceRefs: ['deterministic:hash_mismatch', 'review:pass'],
    resolutionStatus: 'open',
    rationale: '机械校验与独立审校结论相反',
    taskId: 'task_1',
    runId: 'run_1',
    ...extra,
  };
}

test('§28 冲突记录落库可复读（JSON 持久化）', () => {
  const record = conflicts.persist(conflicts.createRecord(baseInput()));
  const onDisk = JSON.parse(fs.readFileSync(conflicts.RECORDS_FILE, 'utf8'));
  assert.ok(onDisk.records[record.conflictId]);
  assert.deepEqual(conflicts.getRecord(record.conflictId), record);
  for (const key of [
    'conflictId',
    'subjectKey',
    'candidateRefs',
    'conflictType',
    'evidenceRefs',
    'resolutionStatus',
    'resolutionMethod',
    'selectedCandidateRef',
    'rationale',
    'decidedBy',
    'decidedAt',
    'policyVersion',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(record, key), `缺少字段 ${key}`);
  }
});

test('§28 审计可查：记录与裁决各留一条', () => {
  const record = conflicts.persist(conflicts.createRecord(baseInput({ subjectKey: 'task_2:artifact_2' })));
  const resolved = conflicts.resolveRecord(record.conflictId, {
    resolutionStatus: 'resolved',
    resolutionMethod: 'rule',
    selectedCandidateRef: 'artifact_a',
    decidedBy: 'conflict-resolver',
    rationale: '规则优先选择先提交且哈希可复算的候选',
  });
  const audit = conflicts.readAudit();
  assert.ok(
    audit.some(item => item.action === 'conflict.recorded' && item.conflictId === record.conflictId)
  );
  assert.ok(
    audit.some(item => item.action === 'conflict.resolved' && item.conflictId === record.conflictId)
  );
  assert.equal(resolved.resolutionStatus, 'resolved');
  assert.equal(resolved.selectedCandidateRef, 'artifact_a');
});

test('§28 裁决结果与记录一致；未裁决记录不得携带裁决结果', () => {
  const record = conflicts.persist(conflicts.createRecord(baseInput({ subjectKey: 'task_3:artifact_3' })));
  assert.throws(
    () => conflicts.createRecord(baseInput({ selectedCandidateRef: 'artifact_a' })),
    error => error.code === 'validation_failed'
  );
  assert.throws(
    () =>
      conflicts.resolveRecord(record.conflictId, {
        resolutionStatus: 'resolved',
        resolutionMethod: 'review',
        selectedCandidateRef: 'artifact_c',
        decidedBy: 'reviewer',
      }),
    error => error.code === 'validation_failed'
  );
  const resolved = conflicts.resolveRecord(record.conflictId, {
    resolutionStatus: 'escalated',
    decidedBy: null,
    decidedAt: null,
  });
  assert.equal(resolved.resolutionStatus, 'escalated');
  assert.equal(resolved.selectedCandidateRef, null);
  assert.equal(conflicts.getRecord(record.conflictId).resolutionStatus, 'escalated');
});

test('§28 读取失败 fail-closed：损坏存储不被当作无冲突', () => {
  fs.mkdirSync(path.dirname(conflicts.RECORDS_FILE), { recursive: true });
  fs.writeFileSync(conflicts.RECORDS_FILE, '{ not-json', 'utf8');
  assert.throws(
    () => conflicts.getRecord('conflict_x'),
    error => {
      assert.equal(error.code, 'internal_error');
      assert.equal(error.status, 500);
      assert.equal(error.details.causeRef, 'conflict_record_unreadable');
      return true;
    }
  );
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
