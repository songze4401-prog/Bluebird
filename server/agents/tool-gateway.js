/* global module */
/**
 * Worker 工具权限网关（阶段 2）。
 *
 * 每个工具调用先过网关，再进入 agent-runtime 的既有策略检查：
 * 1. 任务声明的 allowedTools（创建任务时已收窄到 Agent Manifest 白名单）；
 * 2. Agent Policy 的工具集合与模式；
 * 3. §16 来源链可解析性（provenanceRefs 存在、版本可读、链不破），断裂即
 *    fail-closed 拒绝（`taint_provenance_broken`）。原文未定义"何种污点禁止
 *    哪类工具"的策略，这里只做链校验，不做未定义的阻断。
 *
 * 拒绝只返回受控短码；调用方（Worker Runtime）负责写审计事件，
 * 事件里只记录工具名与短码，不记录参数或返回内容。
 */
const artifactStore = require('./artifact-store');

// committed/pending-commit 是正常产物状态（任务完成后为 committed），
// 只有 invalidated/superseded 视为链路失效。
const PROVENANCE_ALLOWED_STATUSES = ['active', 'pending-commit', 'committed'];
const PROVENANCE_MAX_DEPTH = 3;

function createToolAuthorizer({
  allowedTools = [],
  policy = null,
  provenanceRefs = [],
  resolveProvenance = null,
  provenanceMaxDepth = PROVENANCE_MAX_DEPTH,
} = {}) {
  const taskAllowed = new Set(
    Array.isArray(allowedTools) ? allowedTools.filter(name => typeof name === 'string') : []
  );
  let refs = [];
  let refsInvalid = false;
  try {
    refs = artifactStore.normalizeProvenanceRefs(provenanceRefs);
  } catch (_) {
    // 引用形状非法同样按来源链断裂处理（fail-closed，不静默忽略）。
    refsInvalid = true;
  }
  const resolver =
    typeof resolveProvenance === 'function' ? resolveProvenance : artifactStore.resolveProvenance;
  return function authorizeTool(name) {
    const toolName = String(name || '');
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
    // §16：必须在每次工具调用前重新校验，而不是只在规划时校验一次。
    if (refsInvalid) {
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
    return { ok: true };
  };
}

module.exports = {
  PROVENANCE_ALLOWED_STATUSES,
  createToolAuthorizer,
};
