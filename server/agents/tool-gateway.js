/* global module */
/**
 * Worker 工具权限网关（阶段 2）。
 *
 * 每个工具调用先过网关，再进入 agent-runtime 的既有策略检查：
 * 1. 任务声明的 allowedTools（创建任务时已收窄到 Agent Manifest 白名单）；
 * 2. Agent Policy 的工具集合与模式；
 * 3. §16 来源链可解析性（provenanceRefs 存在、版本可读、链不破），断裂即
 *    fail-closed 拒绝（`taint_provenance_broken`）；
 * 4. §16 污点 → 工具阻断策略（`taint_tool_denied`，版本化规则见 taint-policy.js）。
 *
 * 本网关只做 **AND**：任何一步拒绝即拒绝，绝不因污点/trustLevel 放行原本
 * 不允许的工具（只能收窄，不能扩大）。
 *
 * 拒绝只返回受控短码；调用方（Worker Runtime）负责写审计事件，
 * 事件里只记录工具名、短码、policyVersion 与 ruleId，不记录参数或返回内容。
 *
 * B-02 重试归属：网关每次调用只做一次判定并返回结果/错误，**不做任何重试**；
 * 重试、退避与恢复唯一由 Workflow Engine（runtime.js.decideFailureDisposition）
 * 决定。同一错误重复调用网关不会产生额外执行或重试副作用。
 */
const artifactStore = require('./artifact-store');
const taintPolicy = require('./taint-policy');

// committed/pending-commit 是正常产物状态（任务完成后为 committed），
// 只有 invalidated/superseded 视为链路失效。
const PROVENANCE_ALLOWED_STATUSES = ['active', 'pending-commit', 'committed'];
const PROVENANCE_MAX_DEPTH = 3;

function createToolAuthorizer({
  allowedTools = [],
  policy = null,
  provenanceRefs = [],
  taintLabels = [],
  getTaintState = null,
  toolMeta = {},
  resolveProvenance = null,
  provenanceMaxDepth = PROVENANCE_MAX_DEPTH,
  onDecision = null,
} = {}) {
  const taskAllowed = new Set(
    Array.isArray(allowedTools) ? allowedTools.filter(name => typeof name === 'string') : []
  );
  const fallbackRefs = Array.isArray(provenanceRefs) ? provenanceRefs.slice() : [];
  const fallbackTaint = Array.isArray(taintLabels) ? taintLabels.slice() : [];
  const resolver =
    typeof resolveProvenance === 'function' ? resolveProvenance : artifactStore.resolveProvenance;

  function currentState() {
    if (typeof getTaintState === 'function') {
      try {
        const live = getTaintState() || {};
        return {
          provenanceRefs: Array.isArray(live.provenanceRefs)
            ? live.provenanceRefs
            : fallbackRefs,
          taintLabels: Array.isArray(live.taintLabels) ? live.taintLabels : fallbackTaint,
        };
      } catch (_) {
        // 读取任务态失败：按最保守处理（来源链与污点都按未知）。
        return { provenanceRefs: fallbackRefs, taintLabels: ['unknown'] };
      }
    }
    return { provenanceRefs: fallbackRefs, taintLabels: fallbackTaint };
  }

  function notify(decision, details) {
    if (typeof onDecision !== 'function') return;
    try {
      onDecision({ tool: decision, ...details });
    } catch (_) {
      // 审计回调失败不改变判定结论。
    }
  }

  return function authorizeTool(name) {
    const toolName = String(name || '');
    // 1) 原有授权：不在任务 allowedTools / Agent Policy 内一律拒绝。
    if (!taskAllowed.has(toolName)) {
      return { ok: false, code: 'task_tool_denied' };
    }
    if (policy && policy.mode === 'answer_only') {
      return { ok: false, code: 'policy_tool_denied' };
    }
    const policyTools = policy && policy.tools ? policy.tools.allowedTools : null;
    if (Array.isArray(policyTools) && !policyTools.includes(toolName)) {
      return { ok: false, code: 'policy_tool_denied' };
    }

    // 2) §16：每次调用都重新读取任务来源链，不能只在规划时校验一次；
    //    跨 Agent 读取可能在运行中追加引用。
    const state = currentState();
    let refs = [];
    try {
      refs = artifactStore.normalizeProvenanceRefs(state.provenanceRefs);
    } catch (_) {
      return { ok: false, code: 'taint_provenance_broken', detail: 'invalid_ref' };
    }
    for (const ref of refs) {
      try {
        resolver(ref.id, {
          version: ref.version,
          maxDepth: provenanceMaxDepth,
          allowStatuses: PROVENANCE_ALLOWED_STATUSES,
        });
      } catch (error) {
        return {
          ok: false,
          code: 'taint_provenance_broken',
          detail: (error && error.code) || 'chain_broken',
        };
      }
    }

    // 3) §16：污点 → 工具阻断策略（纯判定，未命中规则 fail-closed）。
    //    工具未知元数据时按"非只读"处理，避免把未知工具误放行。
    const meta = toolMeta && toolMeta[toolName] ? toolMeta[toolName] : {};
    const verdict = taintPolicy.evaluate({
      taintLabels: state.taintLabels,
      tool: {
        name: toolName,
        readOnly: meta.readOnly === true,
        risk: meta.risk || 'unknown',
      },
    });
    notify(toolName, {
      decision: verdict.allowed ? 'allow' : 'deny',
      ruleId: verdict.ruleId,
      policyVersion: verdict.policyVersion,
      taintClass: verdict.taintClass,
    });
    if (!verdict.allowed) {
      return {
        ok: false,
        code: 'taint_tool_denied',
        detail: verdict.ruleId,
        ruleId: verdict.ruleId,
        policyVersion: verdict.policyVersion,
      };
    }
    return {
      ok: true,
      ruleId: verdict.ruleId,
      policyVersion: verdict.policyVersion,
    };
  };
}

module.exports = {
  PROVENANCE_ALLOWED_STATUSES,
  createToolAuthorizer,
};
