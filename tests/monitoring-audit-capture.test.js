/**
 * W6-1/2：受控审计回放与 claim.mismatch 规则短码。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-w6-audit-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;
process.env.BLUEBIRD_AUDIT_MODE = '1';
process.env.BLUEBIRD_AUDIT_KEY = 'a'.repeat(64);

const audit = require('../server/monitoring/audit-capture');
const claimGuard = require('../server/claim-guard');
const monitoring = require('../server/monitoring');
const monitoringSchema = require('../server/monitoring/schema');

test('W6-1: 审计模式关闭时既不落盘也不返回记录', () => {
  const previous = process.env.BLUEBIRD_AUDIT_MODE;
  process.env.BLUEBIRD_AUDIT_MODE = '0';
  try {
    assert.equal(audit.enabled(), false);
    assert.equal(audit.capture({ requestId: 'req_off', event: 'prompt', payload: { userText: 'secret' } }), false);
    assert.deepEqual(audit.read('req_off'), { enabled: false, records: [] });
  } finally {
    process.env.BLUEBIRD_AUDIT_MODE = previous;
  }
});

test('W6-1: 开启后按 requestId 加密回放 Prompt 与工具回执摘要', () => {
  assert.equal(audit.enabled(), true);
  const captured = audit.capture({
    requestId: 'req_w6_audit_001',
    event: 'prompt',
    payload: { userText: '创建 w6-audit.txt，内容 secret-value', sessionId: 's-w6' },
  });
  assert.equal(captured, true);
  audit.capture({
    requestId: 'req_w6_audit_001',
    event: 'tool_receipts',
    payload: {
      toolSteps: [{ name: 'workspace_write', ok: true, summary: '已写入 w6-audit.txt' }],
      receiptStatus: 'executed',
      replyHash: audit.hash('已创建 w6-audit.txt'),
    },
  });

  const raw = fs.readFileSync(audit.REPLAY_FILE, 'utf8');
  assert.equal(raw.includes('secret-value'), false);
  assert.equal(raw.includes('已写入 w6-audit.txt'), false);

  const replay = audit.read('req_w6_audit_001');
  assert.equal(replay.enabled, true);
  assert.deepEqual(replay.records.map(item => item.event), ['prompt', 'tool_receipts']);
  assert.equal(replay.records[0].payload.promptHash, audit.hash('创建 w6-audit.txt，内容 secret-value'));
  assert.equal(replay.records[1].payload.toolSteps[0].name, 'workspace_write');
  assert.equal(replay.records[1].payload.receiptStatus, 'executed');
  assert.deepEqual(audit.read('req_other_002').records, []);
});

test('W6-2: 无回执误报带规则短码，事件可携带 hash 字段', () => {
  const mismatch = claimGuard.detectClaimMismatch(
    '已创建 w6-audit.txt',
    [],
    { userText: '创建 w6-audit.txt' }
  );
  assert.ok(mismatch);
  assert.equal(mismatch.bType, 'no_receipt');
  assert.match(String(mismatch.rule), /^no_receipt:file\./);

  const event = monitoringSchema.normalizeEvent({
    event_name: monitoring.EVENTS.CLAIM_MISMATCH,
    component: 'agent',
    attributes: {
      reply_hash: audit.hash('已创建 w6-audit.txt'),
      receipt_hash: audit.hash('[]'),
      match_rule: mismatch.rule,
      final_disposition: 'delivery_notice',
      receipt_count: 0,
    },
  });
  assert.equal(event.ok, true);
  assert.match(event.event.attributes.reply_hash, /^[a-f0-9]{64}$/);
  assert.equal(event.event.attributes.match_rule, mismatch.rule);
  assert.equal(event.event.attributes.final_disposition, 'delivery_notice');
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
});
