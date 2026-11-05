/* global require, process, __dirname */
/**
 * A-14 / §21：Phase 0 降级分支与退出条件的可执行判定。
 *
 * 口径：退出判据必须由测试/检查项验证；缺失门禁 fail-closed；
 * 分支归因按 E > B > C > D 的严重度顺序，不新增状态。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const mod = require('../server/agents/phase0-degradation');

function allPass(overrides = {}) {
  const base = {};
  for (const item of mod.EXIT_CRITERIA) base[item.key] = true;
  return { ...base, ...overrides };
}

test('A-14 判据清单：七项退出判据齐全且都可执行', () => {
  assert.strictEqual(mod.EXIT_CRITERIA.length, 7);
  for (const item of mod.EXIT_CRITERIA) {
    assert.ok(item.key && item.label, '每条判据必须有键与说明');
  }
  // §21 五分支中 A 不是降级分支，B/C/D/E 必须有触发条件与允许范围。
  for (const branch of ['B', 'C', 'D', 'E']) {
    const spec = mod.DEGRADATION_BRANCHES[branch];
    assert.ok(spec, `${branch} 分支必须存在`);
    assert.ok(spec.triggers.length > 0, `${branch} 必须有触发条件`);
    assert.ok(spec.allowedScope.length > 0, `${branch} 必须有降级后允许范围`);
    assert.ok(spec.forbiddenScope.length > 0, `${branch} 必须有禁止范围`);
  }
});

test('A-14 全部判据通过 → 可退出降级且允许范围恢复完整', () => {
  const result = mod.evaluatePhase0Degradation(allPass());
  assert.strictEqual(result.decision, 'exit_degraded');
  assert.strictEqual(result.branch, null);
  assert.deepStrictEqual(result.failedGates, []);
  assert.deepStrictEqual(result.allowedScope, []);
  assert.deepStrictEqual(result.forbiddenScope, []);
  assert.strictEqual(result.policyVersion, mod.PHASE0_DEGRADATION_POLICY_VERSION);
  assert.ok(result.exitCriteria.every(item => item.passed));
});

test('A-14 CAS 缺失 → 判定仍在降级，落 B 分支并暂停动态组队', () => {
  const result = mod.evaluatePhase0Degradation(allPass({ cas: false }));
  assert.strictEqual(result.decision, 'still_degraded');
  assert.strictEqual(result.branch, 'B');
  assert.deepStrictEqual(result.failedGates, ['cas']);
  assert.ok(result.allowedScope.includes('single_agent_fast_path'));
  assert.ok(result.forbiddenScope.includes('dynamic_teaming'));
  assert.ok(result.forbiddenScope.includes('multi_agent_parallel_write'));
});

test('A-14 完成提交 / 权威分离 / 审批 fail-closed 缺失均落 B 分支', () => {
  for (const key of ['completionCommit', 'authoritySeparated', 'approvalFailClosed']) {
    const result = mod.evaluatePhase0Degradation(allPass({ [key]: false }));
    assert.strictEqual(result.decision, 'still_degraded', `${key} 必须仍在降级`);
    assert.strictEqual(result.branch, 'B', `${key} 必须归到 B`);
    assert.deepStrictEqual(result.failedGates, [key]);
  }
});

test('A-14 隔离或审计阻断 → 落 E 分支并退回单 Agent + 最小 Workflow', () => {
  for (const key of ['sessionIsolation', 'auditChain']) {
    const result = mod.evaluatePhase0Degradation(allPass({ [key]: false }));
    assert.strictEqual(result.decision, 'still_degraded');
    assert.strictEqual(result.branch, 'E');
    assert.ok(result.allowedScope.includes('minimal_workflow'));
    assert.ok(result.forbiddenScope.includes('cross_agent_shared_context'));
    assert.ok(result.forbiddenScope.includes('external_side_effects'));
  }
});

test('A-14 分支优先级：E 优先于 B，B 优先于 C/D', () => {
  const eWins = mod.evaluatePhase0Degradation(allPass({ sessionIsolation: false, cas: false }));
  assert.strictEqual(eWins.branch, 'E');
  const bWins = mod.evaluatePhase0Degradation(
    allPass({ cas: false, blackboardConsistency: false, verificationCostWithinBudget: false })
  );
  assert.strictEqual(bWins.branch, 'B');
  const cWins = mod.evaluatePhase0Degradation(
    allPass({ blackboardConsistency: false, verificationCostWithinBudget: false })
  );
  assert.strictEqual(cWins.branch, 'C');
});

test('A-14 缺失或未知门禁 fail-closed，不误判为可退出', () => {
  const missing = mod.evaluatePhase0Degradation({});
  assert.strictEqual(missing.decision, 'still_degraded');
  assert.strictEqual(missing.failedGates.length, mod.EXIT_CRITERIA.length);
  const unknownValues = mod.evaluatePhase0Degradation({
    ...allPass(),
    cas: 'unknown',
    approvalFailClosed: 1,
  });
  assert.strictEqual(unknownValues.decision, 'still_degraded');
  assert.deepStrictEqual(unknownValues.failedGates.sort(), ['approvalFailClosed', 'cas']);
});

test('A-14 真实探针：当前仓库七项门禁全部可观测', () => {
  const gates = mod.probePhase0Gates();
  for (const item of mod.EXIT_CRITERIA) {
    assert.strictEqual(gates[item.key], true, `${item.key} 必须能在仓库中观测到`);
  }
  const result = mod.evaluatePhase0Degradation(gates);
  assert.strictEqual(result.decision, 'exit_degraded');
});

test('A-14 检查脚本可重跑：--json 输出 exit_degraded 且退出码 0', () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-phase0-degradation.js');
  const stdout = execFileSync(process.execPath, [script, '--json'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  const result = JSON.parse(stdout);
  assert.strictEqual(result.decision, 'exit_degraded');
  assert.strictEqual(result.policyVersion, mod.PHASE0_DEGRADATION_POLICY_VERSION);
});
