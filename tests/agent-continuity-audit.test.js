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

test.todo('A1: 写入指令“内容……确认”不应被判定为读回要求（W2 目标）');
test.todo('B2: 无工具调用却声称文件已创建，必须产生 no_receipt 不匹配（W2 目标）');
test.todo('F2: 成功工具回执被描述为“没拿到回执”，必须产生 failure_claim 不匹配（W2 目标）');
