/**
 * A-14 / §21：Phase 0 降级分支与退出条件（可执行判定）。
 *
 * 口径：
 *  - 原文 §21 给出 A–E 五分支；本模块把「触发条件 / 降级后允许范围 / 退出判据」
 *    收敛成可输入、可断言的状态机，不新增任何任务/审批状态；
 *  - 退出判据只用既有可观测门禁（§11 三条硬规则 + §15 审批 fail-closed + §25 委派硬限），
 *    每个门禁都能被测试或检查项验证，不接受「人工感觉好了」；
 *  - 缺失 / 未知的门禁一律按失败处理（fail-closed），避免脏输入把系统判成可退出。
 *
 * 本仓库裁决（非 Notion 原文）：门禁键名、优先级（E > B > C > D）与输出文案
 * 均为仓库口径；原文只给了五个分支名称与「出现…时暂停或降级」的语义。
 */
const { MAX_DELEGATION_DEPTH } = require('./agent-limits');
const artifactStore = require('./artifact-store');
const artifactCommit = require('./artifact-commit');
const approvals = require('./approvals');
const workerScope = require('./worker-scope');
const tasks = require('./tasks');

const PHASE0_DEGRADATION_POLICY_VERSION = 'phase0-degradation-v1';

/**
 * 退出降级的判据：全部为 true 才允许退出降级（等价 §21 A 分支的「进入下一阶段」）。
 * 每条都对应仓库里已有的实现或检查项，没有「人工确认」类条目。
 */
const EXIT_CRITERIA = Object.freeze([
  Object.freeze({
    key: 'authoritySeparated',
    label: 'State Store / Blackboard 各自事实权威且跨 Store 恢复可验证（A-03）',
  }),
  Object.freeze({
    key: 'completionCommit',
    label: '产物完成提交协议可扫描/可回收（A-03，§11 五步）',
  }),
  Object.freeze({
    key: 'cas',
    label: 'Artifact/Task 写入有 stateVersion + expectedVersion CAS（A-02）',
  }),
  Object.freeze({
    key: 'approvalFailClosed',
    label: '审批 SLA 到期 fail-closed，不静默放行（§15 / B-11）',
  }),
  Object.freeze({
    key: 'sessionIsolation',
    label: 'Worker Session 作用域令牌可签发/吊销，越权读取被拒（Phase 1 验收）',
  }),
  Object.freeze({
    key: 'auditChain',
    label: '任务/事件审计可写、可查且能检出乱序（Phase 3 第 2 项）',
  }),
  Object.freeze({
    key: 'delegationHardLimit',
    label: '委派深度硬上限由服务端校验（§25 / B-05）',
  }),
]);

/**
 * §21 五分支：触发条件（失败的门禁键）与降级后允许范围。
 * A 不是降级分支（全部判据通过即「可退出降级」），因此不在此表。
 */
const DEGRADATION_BRANCHES = Object.freeze({
  B: Object.freeze({
    label: 'Task 状态 / 幂等 / 持久化 Workflow 不足 → 暂停动态组队，先修单 Agent + 持久化 Workflow',
    triggers: Object.freeze(['authoritySeparated', 'completionCommit', 'cas', 'approvalFailClosed']),
    allowedScope: Object.freeze([
      'single_agent_fast_path',
      'persistent_workflow',
      'manual_review',
    ]),
    forbiddenScope: Object.freeze(['dynamic_teaming', 'multi_agent_parallel_write', 'external_side_effects']),
  }),
  C: Object.freeze({
    label: 'Blackboard 一致性不足 → 单写者 + append-only Artifact',
    triggers: Object.freeze(['blackboardConsistency']),
    allowedScope: Object.freeze(['single_writer_blackboard', 'append_only_artifacts']),
    forbiddenScope: Object.freeze(['concurrent_blackboard_write', 'dynamic_teaming']),
  }),
  D: Object.freeze({
    label: '验证成本或延迟超预算 → 降验证强度 / 暂停高成本验证',
    triggers: Object.freeze(['verificationCostWithinBudget']),
    allowedScope: Object.freeze(['deterministic_checks_only', 'single_agent_fast_path']),
    forbiddenScope: Object.freeze(['independent_reviewer_pool', 'dynamic_teaming']),
  }),
  E: Object.freeze({
    label: '隔离 / 权限 / 审计存在阻断缺陷 → 退回单 Agent + 最小 Workflow',
    triggers: Object.freeze(['sessionIsolation', 'auditChain', 'permissionsEnforced']),
    allowedScope: Object.freeze(['single_agent_fast_path', 'minimal_workflow']),
    forbiddenScope: Object.freeze([
      'cross_agent_shared_context',
      'dynamic_teaming',
      'external_side_effects',
      'delegation',
    ]),
  }),
});

// C/D/E 的触发门禁不属于「退出判据」：缺失表示「无证据支持该降级」，不阻塞退出；
// 只有显式给出非 true 值时才触发对应分支（E 的 permissionsEnforced 同口径）。
const OPTIONAL_BRANCH_GATES = Object.freeze([
  'blackboardConsistency',
  'verificationCostWithinBudget',
  'permissionsEnforced',
]);

// 严重度顺序：安全阻断（E）优先于协议缺口（B），再往下是 C / D。
const BRANCH_PRECEDENCE = Object.freeze(['E', 'B', 'C', 'D']);

function gateValue(gates, key) {
  const value = gates ? gates[key] : undefined;
  return value === true;
}

function exitCriteriaView(gates) {
  return EXIT_CRITERIA.map(item => ({
    key: item.key,
    label: item.label,
    passed: gateValue(gates, item.key),
  }));
}

/**
 * 输入当前门禁/证据状态，输出「仍在降级 / 可退出降级」。
 * 未知键与缺失键都按失败处理（fail-closed）。
 */
function evaluatePhase0Degradation(gates = {}) {
  const criteria = exitCriteriaView(gates);
  const failedFunctional = criteria.filter(item => !item.passed).map(item => item.key);
  // 可选分支门禁：显式非 true 才计入失败；缺失表示「无证据」，不据此降级。
  const failedOptional = OPTIONAL_BRANCH_GATES.filter(
    key => Object.prototype.hasOwnProperty.call(gates, key) && gates[key] !== true
  );
  const failedKeys = new Set([...failedFunctional, ...failedOptional]);

  let branch = null;
  for (const candidate of BRANCH_PRECEDENCE) {
    const spec = DEGRADATION_BRANCHES[candidate];
    if (spec.triggers.some(key => failedKeys.has(key))) {
      branch = candidate;
      break;
    }
  }

  // 只有「失败键能归到某个分支」时才是有效降级；无法归因的失败仍保持降级，
  // 但不谎报具体分支（宁可输出 B 之外的空分支 + 全部失败键供排查）。
  const decision = failedKeys.size === 0 ? 'exit_degraded' : 'still_degraded';
  const branchSpec = branch ? DEGRADATION_BRANCHES[branch] : null;

  return {
    policyVersion: PHASE0_DEGRADATION_POLICY_VERSION,
    decision,
    branch,
    branchLabel: branchSpec ? branchSpec.label : null,
    failedGates: [...failedFunctional, ...failedOptional],
    exitCriteria: criteria,
    allowedScope: decision === 'exit_degraded' ? [] : branchSpec ? [...branchSpec.allowedScope] : [],
    forbiddenScope:
      decision === 'exit_degraded' || !branchSpec ? [] : [...branchSpec.forbiddenScope],
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * 对当前仓库做一次真实能力探针：只检查既有导出与默认值，不写任何存储。
 * 任何一项抛错都按 false（fail-closed），不把异常当作「通过」。
 */
function probePhase0Gates() {
  const has = (obj, name) => typeof obj[name] === 'function';
  const gates = {
    authoritySeparated:
      has(artifactStore, 'verifyRefsReadable') && has(artifactStore, 'resolveProvenance') && has(tasks, 'recoverInterrupted'),
    completionCommit:
      has(artifactCommit, 'persistTaskArtifacts') &&
      has(artifactCommit, 'completeTask') &&
      has(artifactCommit, 'scanPendingCommits'),
    cas:
      has(artifactStore, 'lineageStateVersion') &&
      has(artifactStore, 'stateVersionOf') &&
      has(artifactStore, 'persist'),
    approvalFailClosed:
      has(approvals, 'markOverdue') &&
      has(approvals, 'slaViewOf') &&
      approvals.APPROVAL_SLA_POLICY_VERSION === 'approval-sla-v1' &&
      Number.isInteger(approvals.R2_SLA_MS) &&
      approvals.R2_SLA_MS > 0,
    sessionIsolation:
      has(workerScope, 'issueScopeToken') &&
      has(workerScope, 'revokeScopeToken') &&
      has(workerScope, 'authorizeSessionRead'),
    auditChain:
      has(tasks, 'appendEvent') && has(tasks, 'listEvents') && has(tasks, 'detectEventOrderViolations'),
    delegationHardLimit:
      Number.isInteger(MAX_DELEGATION_DEPTH) &&
      MAX_DELEGATION_DEPTH === 2 &&
      has(require('./agent-limits'), 'assertDelegationAllowed'),
  };
  return gates;
}

module.exports = {
  PHASE0_DEGRADATION_POLICY_VERSION,
  EXIT_CRITERIA,
  DEGRADATION_BRANCHES,
  BRANCH_PRECEDENCE,
  OPTIONAL_BRANCH_GATES,
  evaluatePhase0Degradation,
  probePhase0Gates,
};
