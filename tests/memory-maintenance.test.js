/* global __dirname */
/**
 * 记忆维护服务与人工审批闭环测试。
 * 复用真实 memory.js 状态/落盘规则；不调用外部模型。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-memory-maintenance-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';

const memory = require('../server/memory');
const service = require('../server/memory-service');
const approvals = require('../server/agents/approvals');
const permissions = require('../server/agents/permissions');
const tasks = require('../server/agents/tasks');

function now() {
  return new Date().toISOString();
}

function entry(id, content, type, keywords, contributions) {
  const t = now();
  return {
    id,
    content,
    type,
    keywords,
    confidence: 0.95,
    status: 'active',
    validFrom: t,
    validTo: null,
    createdAt: t,
    updatedAt: t,
    contributions,
  };
}

function seed() {
  const t = now();
  const items = [
    entry('mem-a', '用户喜欢拿铁咖啡', 'preference', ['咖啡', '拿铁'], [
      { sessionId: 'session-a', sourceQuote: '我喜欢拿铁', createdAt: t, sourceType: 'user' },
    ]),
    entry('mem-b', '用户喜欢美式咖啡', 'preference', ['咖啡', '美式'], [
      { sessionId: 'session-a', sourceQuote: '我喜欢美式', createdAt: t, sourceType: 'user' },
    ]),
    entry('mem-c', '用户住在上海', 'fact', ['上海'], [
      { sessionId: 'session-a', sourceQuote: '我住在上海', createdAt: t, sourceType: 'user' },
      { sessionId: 'session-b', sourceQuote: '我也住在上海', createdAt: t, sourceType: 'user' },
    ]),
    entry('mem-d', '用户生日是 5 月 1 日', 'fact', ['生日'], [
      { sessionId: 'session-a', sourceQuote: '我生日是 5 月 1 日', createdAt: t, sourceType: 'user' },
    ]),
    entry('mem-e', '用户喜欢跑步', 'preference', ['跑步'], [
      { sessionId: 'session-a', sourceQuote: '我喜欢跑步', createdAt: t, sourceType: 'user' },
      { sessionId: 'session-b', sourceQuote: '我也喜欢跑步', createdAt: t, sourceType: 'user' },
    ]),
  ];
  fs.writeFileSync(path.join(TMP, 'memory.json'), JSON.stringify(items, null, 2));
  memory.loadMemories();
}

test.before(() => {
  seed();
});

test('维护服务：update/merge/supersede 复用既有条目与贡献、保留历史', async () => {
  const updated = await memory.updateMemory({
    id: 'mem-a',
    content: '用户喜欢燕麦拿铁咖啡',
    confidence: 0.97,
    keywords: ['咖啡', '燕麦拿铁'],
  });
  assert.equal(updated.updated, 1);
  const afterUpdate = memory.getMemories({ includeSuperseded: true, includeArchived: true });
  const a = afterUpdate.find(item => item.id === 'mem-a');
  assert.equal(a.content, '用户喜欢燕麦拿铁咖啡');
  assert.equal(a.lastDecision.action, 'update');

  const merged = await memory.mergeMemories({
    targetId: 'mem-a',
    sourceIds: ['mem-b'],
    content: '用户喜欢燕麦拿铁和美式咖啡',
  });
  assert.equal(merged.updated, 1);
  assert.equal(merged.merged, 1);
  const afterMerge = memory.getMemories({ includeSuperseded: true, includeArchived: true });
  const target = afterMerge.find(item => item.id === 'mem-a');
  const source = afterMerge.find(item => item.id === 'mem-b');
  assert.equal(target.content, '用户喜欢燕麦拿铁和美式咖啡');
  assert.ok(target.contributions.length >= 2);
  assert.equal(source.status, 'superseded');
  assert.equal(source.supersededBy, 'mem-a');
  assert.equal(target.status, 'active');

  const superseded = await memory.supersedeMemory({
    id: 'mem-d',
    replacement: {
      content: '用户生日是 5 月 2 日',
      type: 'fact',
      keywords: ['生日'],
    },
  });
  assert.equal(superseded.updated, 1);
  const afterSupersede = memory.getMemories({ includeSuperseded: true, includeArchived: true });
  const old = afterSupersede.find(item => item.id === 'mem-d');
  const replacement = afterSupersede.find(item => item.id === superseded.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, superseded.id);
  assert.equal(replacement.status, 'active');
  assert.deepEqual(replacement.contributions, old.contributions);
});

test('维护服务：archive/withdraw/delete 的边界与持久化', async () => {
  const archived = await memory.archiveMemory('mem-c');
  assert.equal(archived.updated, 1);
  assert.equal(memory.getMemories().some(item => item.id === 'mem-c'), false);

  const partial = await memory.withdrawMemory({ id: 'mem-e', sessionId: 'session-a' });
  assert.equal(partial.withdrawn, 1);
  assert.equal(partial.archived, false);
  assert.equal(partial.removedContributions, 1);
  const eAfterPartial = memory
    .getMemories({ includeArchived: true, includeSuperseded: true })
    .find(item => item.id === 'mem-e');
  assert.equal(eAfterPartial.contributions.length, 1);
  assert.equal(eAfterPartial.status, 'active');

  const full = await memory.withdrawMemory({ id: 'mem-e', sessionId: 'session-b' });
  assert.equal(full.withdrawn, 1);
  assert.equal(full.archived, true);
  const eAfterFull = memory
    .getMemories({ includeArchived: true })
    .find(item => item.id === 'mem-e');
  assert.equal(eAfterFull.status, 'archived');

  const deleted = await memory.deleteMemory({ id: 'mem-b' });
  assert.equal(deleted.removed, 1);

  memory.loadMemories();
  const reloaded = memory.getMemories({ includeArchived: true, includeSuperseded: true });
  assert.equal(reloaded.some(item => item.id === 'mem-b'), false);
  assert.equal(reloaded.find(item => item.id === 'mem-e').status, 'archived');
});

test('维护服务门面：参数白名单与稳定结果摘要', async () => {
  const rejected = service.validate('update', { id: 'mem-a', unknown: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unknown_field');

  const invalidMerge = service.validate('merge', { targetId: 'mem-a', sourceIds: [] });
  assert.equal(invalidMerge.ok, false);

  const checked = service.validate('update', { id: 'mem-a', content: '新的内容' });
  assert.equal(checked.ok, true);

  const result = await service.execute('update', { id: 'mem-a', content: '用户喜欢手冲咖啡' });
  assert.equal(result.reason, 'ok');
  const summary = service.summarize('update', result);
  assert.equal(summary.ok, true);
  assert.equal(summary.id, 'mem-a');
  assert.equal(JSON.stringify(summary).includes('手冲咖啡'), false);
});

test('审批闭环：未经批准不能执行，批准后可执行且审计事件不含正文', async () => {
  const profile = permissions.getPermissionProfile('memory');
  assert.equal(profile.mode, 'single_user');
  assert.ok(profile.approvalRequired.includes('delete'));
  assert.equal(
    permissions.checkOperation({ botId: 'memory', operation: 'delete', approved: false }).code,
    'approval_required'
  );

  const approval = approvals.createApproval({
    botId: 'memory',
    operation: 'update',
    payload: { id: 'mem-a', content: '用户喜欢冷萃咖啡' },
  });
  assert.equal(approval.status, 'pending');
  assert.equal(approvals.getApproval(approval.approvalId).status, 'pending');

  await assert.rejects(
    () => approvals.execute(approval.approvalId),
    error => error && error.code === 'approval_not_approved'
  );

  const approved = approvals.approve(approval.approvalId);
  assert.equal(approved.status, 'approved');
  const executed = await approvals.execute(approval.approvalId);
  assert.equal(executed.status, 'completed');
  assert.equal(executed.result.ok, true);
  const current = memory.getMemories().find(item => item.id === 'mem-a');
  assert.equal(current.content, '用户喜欢冷萃咖啡');

  const rejected = approvals.createApproval({
    botId: 'memory',
    operation: 'delete',
    payload: { id: 'mem-a' },
  });
  const rejectedResult = approvals.reject(rejected.approvalId, { reason: '保留这条记忆' });
  assert.equal(rejectedResult.status, 'rejected');
  await assert.rejects(
    () => approvals.execute(rejected.approvalId),
    error => error && error.code === 'approval_not_approved'
  );

  const events = tasks.listEvents('memory', { limit: 50 });
  assert.ok(events.some(event => event.eventType === 'approval.requested'));
  assert.ok(events.some(event => event.eventType === 'approval.resolved'));
  assert.ok(!JSON.stringify(events).includes('冷萃咖啡'));
  assert.ok(!JSON.stringify(events).includes('保留这条记忆'));
});

test('审批权限：未知操作与跨 Bot 关联拒绝', () => {
  assert.throws(
    () =>
      approvals.createApproval({
        botId: 'memory',
        operation: 'shell_exec',
        payload: { id: 'mem-a' },
      }),
    error => error && error.code === 'invalid_approval'
  );
  assert.throws(
    () =>
      approvals.createApproval({
        botId: 'memory',
        operation: 'delete',
        payload: { id: 'mem-a' },
        taskId: 'task_missing',
      }),
    error => error && error.code === 'task_not_found'
  );
  assert.throws(
    () => permissions.getPermissionProfile('unknown'),
    error => error && error.code === 'agent_not_found'
  );
});
