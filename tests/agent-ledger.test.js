/**
 * W4 长任务 step ledger：编号解析、回执绑定、注入与交付清单。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-w4-'));
process.env.BLUEBIRD_DATA_DIR = dataDir;
process.env.BLUEBIRD_TASK_LEDGER = '1';

const ledger = require('../server/agent-ledger');

test('W4: 解析“第N步/步骤N”并忽略重复提及', () => {
  const steps = ledger.parseSteps(
    '步骤1：创建 a.txt，内容 one。步骤2：创建 b.txt，内容 two。现在只执行步骤1。'
  );
  assert.deepEqual(steps.map(step => step.index), [1, 2]);
  assert.match(steps[0].text, /创建 a\.txt/);
  assert.match(steps[1].text, /创建 b\.txt/);
});

test('W4: 没有编号步骤时不建账', () => {
  assert.equal(ledger.ensureLedger('s-none', '帮我读一下文件内容'), null);
  assert.equal(ledger.buildLedgerContextBlock('s-none'), '');
});

test('W4: 回执按步骤编号与工具语义绑定，失败步骤保留错误码', () => {
  const userText = '第4步：读取 f01.txt。第5步：向 f01.txt 追加 +D。第6步：列出工作区根目录。';
  ledger.ensureLedger('s-bind', userText);
  const result = ledger.bindReceipts(
    's-bind',
    [
      { name: 'workspace_list', ok: true, evidence: { count: 9 } },
      { name: 'workspace_write', ok: true, evidence: { path: 'f01.txt', bytes: 4, sha256: 'a'.repeat(64) } },
      { name: 'workspace_read', ok: false, code: 'workspace_not_found', evidence: { path: 'f01.txt' } },
    ],
    userText
  );
  const byIndex = new Map(result.steps.map(step => [step.index, step]));
  assert.equal(byIndex.get(4).status, 'failed');
  assert.equal(byIndex.get(4).errorCode, 'workspace_not_found');
  assert.equal(byIndex.get(5).status, 'completed');
  assert.equal(byIndex.get(5).receipts[0].path, 'f01.txt');
  assert.equal(byIndex.get(6).status, 'completed');
  assert.equal(byIndex.get(6).receipts[0].count, 9);
});

test('W4: 注入块列出未完成与失败，并禁止声称全部完成', () => {
  ledger.ensureLedger('s-block', '第1步：创建 a.txt。第2步：创建 b.txt。第3步：读取 c.txt。');
  ledger.bindReceipts(
    's-block',
    [{ name: 'workspace_write', ok: true, evidence: { path: 'a.txt', bytes: 1 } }],
    '第1步：创建 a.txt。'
  );
  const block = ledger.buildLedgerContextBlock('s-block');
  assert.match(block, /未完成 2/);
  assert.match(block, /未完成：步骤2/);
  assert.match(block, /禁止声称全部完成/);
});

test('W4: 连续两轮无进度触发停滞标记', () => {
  const text = '第1步：创建 a.txt。第2步：创建 b.txt。';
  ledger.ensureLedger('s-stall', text);
  ledger.bindReceipts('s-stall', [], text);
  const after = ledger.bindReceipts('s-stall', [], text);
  assert.equal(after.stalled, true);
  assert.match(ledger.buildLedgerContextBlock('s-stall'), /停滞/);
});

test('W4: 交付清单列出完成/未完成/失败与证据', () => {
  const text = '第1步：创建 a.txt。第2步：创建 b.txt。第3步：汇总三个文件。';
  ledger.ensureLedger('s-deliver', text);
  ledger.bindReceipts(
    's-deliver',
    [
      { name: 'workspace_write', ok: true, evidence: { path: 'a.txt', bytes: 1 } },
      { name: 'workspace_write', ok: true, evidence: { path: 'b.txt', bytes: 1 } },
    ],
    '第1步：创建 a.txt。第2步：创建 b.txt。'
  );
  const summary = ledger.buildDeliverySummary('s-deliver');
  assert.match(summary, /【长任务交付清单】/);
  assert.match(summary, /完成（3）/);
  assert.match(summary, /a\.txt/);
  assert.match(summary, /全部步骤均有服务端回执/);
});

test('W4: 最终汇总轮强制补齐未完成步骤的工具', () => {
  const text = '第13步：向 f12.txt 追加 +M。第14步：列出工作区根目录。第15步：汇总整个任务。';
  ledger.ensureLedger('s-force', text);
  assert.deepEqual(ledger.forcedToolsForPending('s-force', '汇总整个任务'), ['workspace_write']);
  assert.deepEqual(ledger.forcedToolsForPending('s-force', '继续下一步'), []);
});

test('W4: BLUEBIRD_TASK_LEDGER=0 时完全不建账', () => {
  const previous = process.env.BLUEBIRD_TASK_LEDGER;
  process.env.BLUEBIRD_TASK_LEDGER = '0';
  try {
    assert.equal(ledger.ensureLedger('s-off', '第1步：创建 a.txt'), null);
    assert.equal(ledger.buildLedgerContextBlock('s-off'), '');
    assert.equal(ledger.buildDeliverySummary('s-off'), null);
  } finally {
    process.env.BLUEBIRD_TASK_LEDGER = previous;
  }
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
});
