/**
 * W0/W1 回归基线：跨轮状态 / 完成校验 / 工具回执注入。
 *
 * W2 的三个 todo 是已知缺口；W1 的三个真实用例保护执行账本的注入契约。
 * 转绿方式见每个 todo 的名字与 docs/archive/agent-audit-baseline-2026-11-27.md。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTurnReceiptNote,
  injectTurnReceipts,
} = require('../server/turn-receipts');
const { requiresReadBack } = require('../server/tool-postcondition');
const claimGuard = require('../server/claim-guard');

function withReceipts(value, fn) {
  const previous = process.env.BLUEBIRD_TURN_RECEIPTS;
  process.env.BLUEBIRD_TURN_RECEIPTS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BLUEBIRD_TURN_RECEIPTS;
    else process.env.BLUEBIRD_TURN_RECEIPTS = previous;
  }
}

const assistant = (extra = {}) => ({
  role: 'assistant',
  content: '文件已创建。',
  ...extra,
});

test('W1: 最近轮次回执注入包含 path/bytes/sha256，且不拼进 assistant 正文', () => {
  withReceipts('1', () => {
    const history = [
      {
        role: 'user',
        content: '创建 audit.txt',
      },
      assistant({
        receiptStatus: 'executed',
        toolSteps: [
          {
            name: 'workspace_write',
            ok: true,
            summary: '已创建 audit.txt',
            evidence: {
              status: 'success',
              path: 'audit.txt',
              bytes: 2,
              sha256: 'a'.repeat(64),
            },
          },
        ],
      }),
    ];

    const note = buildTurnReceiptNote(history);
    assert.match(note, /\[服务端工具回执｜最近轮次核查\]/);
    assert.match(note, /workspace_write ok=true/);
    assert.match(note, /path=audit\.txt/);
    assert.match(note, /bytes=2/);
    assert.match(note, /sha256=a{64}/);

    const injected = injectTurnReceipts(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: '下一问' }],
      history
    );
    assert.equal(injected.note, note);
    assert.deepEqual(injected.messages.map(item => item.role), ['system', 'system', 'user']);
    assert.match(injected.messages[1].content, /服务端工具回执/);
  });
});

test('W1: no_tool_calls 明确标注“无回执，不得当作已执行事实”', () => {
  withReceipts('1', () => {
    const note = buildTurnReceiptNote([
      assistant({ receiptStatus: 'no_tool_calls' }),
    ]);
    assert.match(note, /没有工具调用/);
    assert.match(note, /不得当作已执行事实/);
  });
});

test('W1: BLUEBIRD_TURN_RECEIPTS=0 时不注入任何回执', () => {
  withReceipts('0', () => {
    const history = [
      assistant({
        receiptStatus: 'executed',
        toolSteps: [{ name: 'workspace_write', ok: true, summary: '已创建 audit.txt' }],
      }),
    ];
    assert.equal(buildTurnReceiptNote(history), '');
    const injected = injectTurnReceipts([{ role: 'user', content: '下一问' }], history);
    assert.equal(injected.note, '');
    assert.deepEqual(injected.messages, [{ role: 'user', content: '下一问' }]);
  });
});

test('W2 A1: 写入指令“内容……确认”不触发读回', () => {
  assert.equal(
    requiresReadBack('请创建工作区文件 audit-a.txt，内容精确为 v1。完成后用一句话确认。'),
    false
  );
});

test('W2 A5: 明确的“读取后核对内容”仍触发读回', () => {
  assert.equal(
    requiresReadBack('请读取 audit-a.txt，核对真实内容，并说明是否一致。'),
    true
  );
});

test('W2 B2: 零工具却声称文件已创建 → no_receipt', () => {
  const mismatch = claimGuard.detectClaimMismatch(
    '步骤2也做完了，b-step2.txt 建好，内容是 two。',
    [],
    { userText: '继续执行步骤2，创建 b-step2.txt' }
  );
  assert.equal(mismatch && mismatch.aType, 'success_claim');
  assert.equal(mismatch && mismatch.bType, 'no_receipt');
  assert.equal(mismatch && mismatch.toolGroup, 'file');
});

test('W2 F2: 成功回执被说成“没拿到回执” → failure_claim', () => {
  const steps = [
    {
      name: 'workspace_write',
      ok: true,
      summary: '已追加 3 字节到 f01.txt',
      evidence: { status: 'success', bytes: 3 },
    },
  ];
  const mismatch = claimGuard.detectClaimMismatch(
    '第5步和第6步我这边没有拿到能证明成功的回执，所以不能算完成。',
    steps,
    { userText: '继续第5步：向 f01.txt 追加 +D' }
  );
  assert.equal(mismatch && mismatch.aType, 'failure_claim');
  assert.equal(mismatch && mismatch.bType, 'tool_success');
  assert.equal(mismatch && mismatch.toolGroup, 'file');
});

test('W2: 成功声明 + 成功回执不误报', () => {
  const mismatch = claimGuard.detectClaimMismatch(
    '文件已创建好了。',
    [{ name: 'workspace_write', ok: true, summary: '已创建文件', evidence: { status: 'success', bytes: 2 } }],
    { userText: '创建文件' }
  );
  assert.equal(mismatch, null);
});

test('W2: 成功声明 + 失败回执 → success_claim/tool_failure', () => {
  const mismatch = claimGuard.detectClaimMismatch(
    '文件已创建好了。',
    [{ name: 'workspace_write', ok: false, summary: '写入失败', evidence: { status: 'failed' } }],
    { userText: '创建文件' }
  );
  assert.equal(mismatch && mismatch.aType, 'success_claim');
  assert.equal(mismatch && mismatch.bType, 'tool_failure');
});

test('W2: 有其它工具回执但缺目标操作回执 → no_receipt', () => {
  const mismatch = claimGuard.detectClaimMismatch(
    '文件已创建好了。',
    [{ name: 'memory_search', ok: true, summary: '找到 1 条记忆', evidence: { status: 'success' } }],
    { userText: '创建文件' }
  );
  assert.equal(mismatch && mismatch.aType, 'success_claim');
  assert.equal(mismatch && mismatch.bType, 'no_receipt');
  assert.equal(mismatch && mismatch.toolGroup, 'file');
});

test('W2: 零工具假成功经 reconcile 后返回服务端完成校验，不落假声明', async () => {
  const result = await claimGuard.reconcileClaim({
    reply: 'b-step2.txt 已经创建好了。',
    toolSteps: [],
    userText: '创建 b-step2.txt',
    enabled: true,
  });
  assert.match(result.reply, /【服务端完成校验】/);
  assert.match(result.reply, /没有任何工具回执/);
  assert.equal(result.retrySucceeded, false);
});
