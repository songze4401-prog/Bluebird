/* global module */
/**
 * Worker 工具权限网关（阶段 2）。
 *
 * 每个工具调用先过网关，再进入 agent-runtime 的既有策略检查：
 * 1. 任务声明的 allowedTools（创建任务时已收窄到 Agent Manifest 白名单）；
 * 2. Agent Policy 的工具集合与模式。
 * 拒绝只返回受控短码；调用方（Worker Runtime）负责写审计事件，
 * 事件里只记录工具名与短码，不记录参数或返回内容。
 */

function createToolAuthorizer({ allowedTools = [], policy = null } = {}) {
  const taskAllowed = new Set(
    Array.isArray(allowedTools) ? allowedTools.filter(name => typeof name === 'string') : []
  );
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
    return { ok: true };
  };
}

module.exports = {
  createToolAuthorizer,
};
