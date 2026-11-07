/**
 * P5-G / §2.6 + §5 Phase 4 第 3 项：受控自我改进闭环回归。
 *
 * 口径：
 *  a) 禁止自改清单是服务端校验：权限策略/密钥/预算硬上限/审批规则/审计机制/
 *     生产发布权限不能成为提案目标，创建与发布两侧都拒；
 *  b) 失败模式评估 → 自动起草：只聚合真实事件里的 failureMode，达到阈值才起草，
 *     无显著信号返回 null（不为「有提案」而凭空起草）；
 *  c) 评测：production vs candidate 双跑评测集，delta 与安全计数入档，状态推进；
 *  d) 人工批准是必经节点：只有 local-owner 能批/否；未批准不得发布；
 *  e) 灰度分桶确定性：同一实体同一比例永远同桶；比例落 strategy 状态，
 *     isEnabledFor 按桶判定，换版本清灰度；
 *  f) 自动回滚：安全计数器退化或成功率跌破基线 → 回滚策略版本 + 提案转 rolled_back。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-improvement-loop-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const improvements = require('../server/agents/improvement-loop');
const express = require('express');
const http = require('http');
const strategyVersion = require('../server/agents/strategy-version');
const autonomyPolicy = require('../server/agents/autonomy-policy');
const tasks = require('../server/agents/tasks');
const { AgentError } = require('../server/agents/errors');

const AGENTS_DIR = path.join(TMP, 'agents');

function resetStore() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  tasks.reloadForTests();
  improvements.reloadForTests();
  // 恢复默认策略状态（version 回 p4-default，关闭灰度），避免用例间串味。
  strategyVersion.apply({ version: 'p4-default', enabled: true });
}

function seedFailureEvents(mode, count) {
  const task = tasks.createTask({ botId: 'memory', taskType: 'memory.search', goal: `P5G ${mode}` });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  for (let index = 0; index < count; index += 1) {
    tasks.appendEvent({
      botId: 'memory',
      taskId: task.taskId,
      eventType: 'task.recovered',
      payload: { status: 'retrying', errorCode: `${mode}_test`, failureMode: mode, mode: 'retry' },
    });
  }
  return task;
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('a. P5-G 禁止自改清单：六类合法目标可提案，权限/密钥/预算/审批/审计/发布权限一律 403', () => {
  resetStore();
  for (const module of Object.keys(improvements.FORBIDDEN_TARGETS)) {
    assert.throws(
      () =>
        improvements.createProposal({
          category: 'routing_threshold',
          target: { module, configKey: 'anything' },
          reason: '试图自改禁止目标',
        }),
      error => {
        assert.equal(error.code, 'improvement_forbidden_target');
        assert.equal(error.status, 403);
        return true;
      },
      `${module} 必须被拒绝`
    );
  }
  // 六类合法目标可创建（draft），类外拒绝。
  const legal = improvements.createProposal({
    category: 'agent_selection',
    target: { module: 'autonomy-policy', configKey: 'agent_selection' },
    reason: '测试合法提案',
  });
  assert.equal(legal.status, 'draft');
  assert.equal(legal.policyVersion, 'improvement-loop-v1');
  assert.throws(
    () =>
      improvements.createProposal({
        category: 'self_modify_policy',
        target: { module: 'autonomy-policy' },
        reason: '类外类别',
      }),
    error => error.code === 'improvement_category_invalid'
  );
  // 创建时不写目标也拒绝。
  assert.throws(
    () => improvements.createProposal({ category: 'eval_suite', reason: '缺 target' }),
    error => error.code === 'improvement_target_missing'
  );
});

test('b. P5-G 失败模式评估：真实事件聚合起草；无显著信号返回 null', () => {
  resetStore();
  // role_drift ×2 达阈值 → 起草 prompt_template 类提案，证据引用真实事件 id。
  seedFailureEvents('role_drift', 2);
  const draft = improvements.draftFromFailureModes({ events: tasks.listEvents('memory', { limit: 100 }) });
  assert.ok(draft, '达到阈值必须起草');
  assert.equal(draft.category, 'prompt_template');
  assert.ok(draft.reason.includes('role_drift'));
  assert.ok(draft.evidenceRefs.length >= 2);
  assert.equal(draft.status, 'draft');

  // 只有 1 次的失败模式不起草；空事件返回 null。
  resetStore();
  seedFailureEvents('approval_stall', 1);
  const none = improvements.draftFromFailureModes({ events: tasks.listEvents('memory', { limit: 100 }) });
  assert.equal(none, null, '未达阈值不凭空起草');
  assert.equal(improvements.draftFromFailureModes({ events: [] }), null);
});

test('c. P5-G 评测：production vs candidate 双跑入档，delta 与安全计数留痕', () => {
  resetStore();
  const proposal = improvements.createProposal({
    category: 'routing_threshold',
    target: { module: 'autonomy-policy', configKey: 'replan' },
    reason: '测试候选对照',
  });
  const evaluated = improvements.evaluateProposal({ proposalId: proposal.proposalId });
  assert.equal(evaluated.status, 'evaluated');
  assert.ok(evaluated.evaluation, '评测结果必须入档');
  assert.equal(evaluated.evaluation.before.metrics.successRate.caseCount > 0, true);
  assert.equal(
    evaluated.evaluation.after.metrics.successRate.caseCount,
    evaluated.evaluation.before.metrics.successRate.caseCount
  );
  assert.equal(typeof evaluated.evaluation.delta.successRate, 'number');
  assert.ok(Array.isArray(evaluated.evaluation.safetyRegression));
  // 状态机：draft 不能直接发布。
  const draft = improvements.createProposal({
    category: 'eval_suite',
    target: { module: 'autonomy-policy' },
    reason: '未评测提案',
  });
  assert.throws(
    () => improvements.releaseProposal({ proposalId: draft.proposalId, grayRatio: 1 }),
    error => error.code === 'improvement_invalid_transition'
  );
});

test('d. P5-G 人工批准：只有 local-owner 能批；批准是发布的必经节点', () => {
  resetStore();
  const proposal = improvements.createProposal({
    category: 'agent_selection',
    target: { module: 'autonomy-policy', configKey: 'agent_selection' },
    reason: '批准门槛测试',
  });
  const evaluated = improvements.evaluateProposal({ proposalId: proposal.proposalId });
  // Agent / 其他主体不能批。
  assert.throws(
    () => improvements.approveProposal({ proposalId: evaluated.proposalId, actor: 'agent' }),
    error => error.code === 'improvement_approval_forbidden'
  );
  const approved = improvements.approveProposal({
    proposalId: evaluated.proposalId,
    actor: 'local-owner',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'local-owner');
  // 批准后才能发布。
  const released = improvements.releaseProposal({ proposalId: approved.proposalId, grayRatio: 1 });
  assert.equal(released.status, 'released');
  assert.equal(released.release.strategyVersion, `improvement:${released.proposalId}`);
  // 已发布不能再发布。
  assert.throws(
    () => improvements.releaseProposal({ proposalId: released.proposalId, grayRatio: 1 }),
    error => error.code === 'improvement_invalid_transition'
  );
});

test('e. P5-G 灰度：分桶确定性、比例落 strategy 状态、isEnabledFor 按桶判定', () => {
  resetStore();
  // 确定性：同 id 同比例永远同桶。
  const probe = 'task_probe_entity';
  const once = improvements.isInBucket(probe, 0.5);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(improvements.isInBucket(probe, 0.5), once, '分桶必须确定性');
  }
  assert.equal(improvements.isInBucket(probe, 1), true, 'ratio=1 全量');
  assert.equal(improvements.isInBucket(probe, 0), false, 'ratio=0 不放量');

  // 发布 ratio=0.5 的提案 → strategy 状态带 gray。
  const proposal = improvements.createProposal({
    category: 'routing_threshold',
    target: { module: 'autonomy-policy', configKey: 'gray' },
    reason: '灰度测试',
  });
  improvements.evaluateProposal({ proposalId: proposal.proposalId });
  improvements.approveProposal({ proposalId: proposal.proposalId, actor: 'local-owner' });
  const released = improvements.releaseProposal({ proposalId: proposal.proposalId, grayRatio: 0.5 });
  assert.equal(released.release.grayRatio, 0.5);
  const state = strategyVersion.get();
  assert.ok(state.gray && state.gray.ratio === 0.5);

  // 灰度中：分桶按 isInBucket 判定（经 autonomy-policy 透传）。
  const inBucket = improvements.isInBucket('entity-in', 0.5);
  assert.equal(autonomyPolicy.isEnabledFor('entity-in'), inBucket);
  // 换版本清灰度；p4-default 是 Phase 4 默认关闭姿态 → 对任何实体都 false。
  strategyVersion.apply({ version: 'p4-default', enabled: true });
  assert.equal(strategyVersion.get().gray, null);
  assert.equal(autonomyPolicy.isEnabledFor('entity-in'), false, '默认策略版本对实体关闭');
  // 激活版本位 + 无灰度配置 = 全量语义。
  strategyVersion.apply({ version: autonomyPolicy.ACTIVE_VERSION, enabled: true });
  assert.equal(autonomyPolicy.isEnabledFor('entity-in'), true, '激活版本且无灰度 → 全量');
  assert.equal(autonomyPolicy.isEnabledFor('entity-out'), true);

  // 灰度 ratio 非法直接拒绝。
  assert.throws(
    () => improvements.releaseProposal({
      proposalId: improvements.approveProposal({
        proposalId: improvements.evaluateProposal({
          proposalId: improvements.createProposal({
            category: 'workflow_config',
            target: { module: 'autonomy-policy' },
            reason: '非法比例测试',
          }).proposalId,
        }).proposalId,
        actor: 'local-owner',
      }).proposalId,
      grayRatio: 1.5,
    }),
    error => error.code === 'improvement_gray_ratio_invalid'
  );
});

test('f. P5-G 自动回滚：安全计数器退化或成功率跌破基线 → 回滚策略版本', () => {
  resetStore();
  const proposal = improvements.createProposal({
    category: 'routing_threshold',
    target: { module: 'autonomy-policy', configKey: 'rollback' },
    reason: '自动回滚测试',
  });
  const evaluated = improvements.evaluateProposal({ proposalId: proposal.proposalId });
  improvements.approveProposal({ proposalId: proposal.proposalId, actor: 'local-owner' });
  improvements.releaseProposal({ proposalId: proposal.proposalId, grayRatio: 1 });
  const before = evaluated.evaluation.before;

  // 1) 无回归：不回滚。
  const clean = improvements.checkAutoRollback({ proposalId: proposal.proposalId });
  assert.equal(clean.rolledBack, false);

  // 2) 安全计数器退化（fail-closed 命中上升）→ 自动回滚 + 提案转 rolled_back。
  const regressed = improvements.checkAutoRollback({
    proposalId: proposal.proposalId,
    report: {
      metrics: evaluated.evaluation.after.metrics,
      safety: { ...evaluated.evaluation.after.safety, failClosedHits: (before.safety.failClosedHits || 0) + 1 },
    },
  });
  assert.equal(regressed.rolledBack, true);
  assert.ok(regressed.regressedCounters.includes('failClosedHits'));
  assert.equal(improvements.getProposal(proposal.proposalId).status, 'rolled_back');
  assert.ok(improvements.getProposal(proposal.proposalId).rollback.reasons.length >= 1);

  // 3) 成功率跌破基线同样触发（新提案）。
  const p2 = improvements.createProposal({
    category: 'decomposition_strategy',
    target: { module: 'autonomy-policy' },
    reason: '成功率回滚测试',
  });
  const e2 = improvements.evaluateProposal({ proposalId: p2.proposalId });
  improvements.approveProposal({ proposalId: p2.proposalId, actor: 'local-owner' });
  improvements.releaseProposal({ proposalId: p2.proposalId, grayRatio: 1 });
  const worse = improvements.checkAutoRollback({
    proposalId: p2.proposalId,
    report: {
      metrics: { ...e2.evaluation.after.metrics, successRate: { ...e2.evaluation.after.metrics.successRate, value: e2.evaluation.before.metrics.successRate.value - 0.1 } },
      safety: e2.evaluation.after.safety,
    },
  });
  assert.equal(worse.rolledBack, true);
  assert.ok(worse.reasons.some(reason => reason.includes('成功率')));

  // 4) 策略版本确实被回滚（previousVersion 指回发布前）。
  const state = strategyVersion.get();
  assert.equal(state.version, 'p4-default');
});

test('h. P5-G 禁止清单归一：单复数/版本后缀/路径/别名变体全部命中，合法模块不误伤', () => {
  resetStore();
  const variants = [
    'permission',
    'permissions.v2',
    'permissions-v2',
    'agent-limits.budget',
    'budget',
    'server/agents/permissions.js',
    'approvals.js',
    'credentials-v2',
    'audit/X',
    'Approvals-Next',
    'approval-policy',
    'production-release',
  ];
  for (const target of variants) {
    assert.throws(
      () =>
        improvements.createProposal({
          category: 'routing_threshold',
          target: { module: target },
          reason: '变体绕过尝试',
        }),
      error => error.code === 'improvement_forbidden_target',
      `${target} 必须命中禁止清单`
    );
  }
  // 合法模块（含带版本后缀的合法目标）不受影响；落库存归一名 + 原始输入留审计。
  const legal = improvements.createProposal({
    category: 'eval_suite',
    target: { module: 'Autonomy-Policy.v2', configKey: 'x' },
    reason: '合法目标带版本后缀',
  });
  assert.equal(legal.target.module, 'autonomy-policy');
  // 归一化函数的词边界：auditor-notes 不因 audit 命中。
  assert.equal(improvements.isForbiddenTargetModule('auditor-notes'), false);
});

test('i. P5-G 回归检查缺省路径：重新跑评测对照发布前基线，而不是拿发布数字自比', () => {
  resetStore();
  const proposal = improvements.createProposal({
    category: 'routing_threshold',
    target: { module: 'autonomy-policy', configKey: 'rollback' },
    reason: '缺省重跑测试',
  });
  const evaluated = improvements.evaluateProposal({ proposalId: proposal.proposalId });
  improvements.approveProposal({ proposalId: proposal.proposalId, actor: 'local-owner' });
  improvements.releaseProposal({ proposalId: proposal.proposalId, grayRatio: 1 });
  const result = improvements.checkAutoRollback({ proposalId: proposal.proposalId });
  assert.equal(result.reportSource, 'fresh_evaluation', '缺省必须重跑评测');
  assert.equal(result.rolledBack, false, 'stub 下重跑数字与基线一致，不触发回滚');
});

test('j. P5-G 调度器：起草带去重守卫；released 提案自动进回归检查；可停用', () => {
  resetStore();
  seedFailureEvents('role_drift', 3);
  let fired = 0;
  const scheduler = improvements.createImprovementScheduler({
    intervalMs: 3600000,
    setTimer: (fn, ms) => {
      fired += 1;
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  const first = scheduler.runOnce();
  assert.ok(first.drafts && first.drafts.drafted, '首轮起草');
  const second = scheduler.runOnce();
  assert.equal(second.drafts.drafted, null, '已有开放提案，去重守卫生效');
  assert.equal(second.drafts.skipped, 'open_proposal_exists');
  assert.equal(improvements.listProposals({ status: 'draft' }).length, 1, '不制造提案垃圾');

  // released 提案自动进回归检查（缺省重跑路径）。
  const proposal = improvements.createProposal({
    category: 'routing_threshold',
    target: { module: 'autonomy-policy', configKey: 'sched' },
    reason: '调度器回归检查测试',
  });
  improvements.evaluateProposal({ proposalId: proposal.proposalId });
  improvements.approveProposal({ proposalId: proposal.proposalId, actor: 'local-owner' });
  improvements.releaseProposal({ proposalId: proposal.proposalId, grayRatio: 1 });
  const third = scheduler.runOnce();
  const check = third.rollbackChecks.find(item => item.proposalId === proposal.proposalId);
  assert.ok(check, 'released 提案必须被检查');
  assert.equal(check.reportSource, 'fresh_evaluation');

  // intervalMs<=0 显式停用：start 不挂定时器。
  const disabled = improvements.createImprovementScheduler({ intervalMs: 0 });
  const started = disabled.start();
  assert.equal(started.disabled, true);
  assert.equal(fired, 0, '测试注入的 setTimer 不应被调用');
});

test('k. P5-G HTTP 入口：创建/列表/评测/批准/发布/回归检查全链可达，禁止目标 403', async () => {
  resetStore();
  const { createAgentRouter } = require('../server/agents/routes');
  const app = express();
  app.use(express.json());
  app.use(createAgentRouter({ requireAuth: (req, res, next) => next() }));
  const server = await new Promise(resolve => {
    const item = app.listen(0, '127.0.0.1', () => resolve(item));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  try {
    // 禁止目标 → 403。
    const forbidden = await call('POST', '/agent-improvements', {
      category: 'routing_threshold',
      target: { module: 'permissions.v2' },
      reason: 'HTTP 变体绕过',
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.code, 'improvement_forbidden_target');

    // 全链：创建 → 评测 → 批准 → 发布（灰度）→ 回归检查。
    const created = await call('POST', '/agent-improvements', {
      category: 'agent_selection',
      target: { module: 'autonomy-policy', configKey: 'http' },
      reason: 'HTTP 全链测试',
    });
    assert.equal(created.status, 201);
    const id = created.json.proposal.proposalId;
    const evaluated = await call('POST', `/agent-improvements/${id}/evaluate`, {});
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.json.proposal.status, 'evaluated');
    const approved = await call('POST', `/agent-improvements/${id}/approve`, {});
    assert.equal(approved.json.proposal.status, 'approved');
    const released = await call('POST', `/agent-improvements/${id}/release`, { grayRatio: 0.5 });
    assert.equal(released.json.proposal.status, 'released');
    assert.equal(released.json.proposal.release.grayRatio, 0.5);
    const checked = await call('POST', `/agent-improvements/${id}/rollback-check`, {});
    assert.equal(checked.status, 200);
    assert.equal(checked.json.reportSource, 'fresh_evaluation');

    // 列表与详情。
    const list = await call('GET', '/agent-improvements?status=released');
    assert.equal(list.json.improvements.length, 1);
    const detail = await call('GET', `/agent-improvements/${id}`);
    assert.equal(detail.json.proposal.proposalId, id);
    const missing = await call('GET', '/agent-improvements/imp_missing');
    assert.equal(missing.status, 404);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('g. P5-G 提案存储与读取面：listProposals 按状态过滤，get 未知 id 返回 null', () => {
  resetStore();
  const proposal = improvements.createProposal({
    category: 'eval_suite',
    target: { module: 'autonomy-policy' },
    reason: '存储读取面测试',
  });
  assert.equal(improvements.getProposal('imp_missing'), null);
  assert.equal(improvements.getProposal(proposal.proposalId).category, 'eval_suite');
  assert.equal(improvements.listProposals({ status: 'draft' }).length, 1);
  assert.equal(improvements.listProposals({ status: 'released' }).length, 0);
});
