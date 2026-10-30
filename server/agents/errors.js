/* global module */
/**
 * Memory Bot 领域错误：所有对外错误只带受控短码与中文说明，
 * 不包含 API Key、Prompt、记忆正文或上游响应体。
 */
class AgentError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
  }
}

function agentError(code, message, status) {
  return new AgentError(code, message, status);
}

function describeAgentError(error) {
  if (error instanceof AgentError) {
    return { code: error.code, error: error.message, status: error.status };
  }
  return {
    code: 'agent_failed',
    error: 'Agent 操作失败',
    status: 500,
  };
}

module.exports = {
  AgentError,
  agentError,
  describeAgentError,
};
