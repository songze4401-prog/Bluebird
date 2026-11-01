/* global module */
/**
 * Worker 上下文投影（阶段 2）。
 *
 * Worker 只拿到完成任务所需的最小上下文：任务目标、必要上下文、记忆作用域、
 * 允许的工具与预算。投影函数是纯函数，不读取主控历史、不读取其他 Worker 的
 * 会话，也不返回任何会话存储句柄——这是 Session 隔离的接口保证。
 */

const INSTRUCTION_MAX = 9000;

function buildTaskInstruction(task) {
  const lines = [
    '【主控委派任务】',
    `任务类型：${task.taskType}`,
    `目标：${task.goal}`,
  ];
  if (task.context) lines.push(`必要上下文：${task.context}`);
  if (task.contextRef) lines.push(`上下文引用：${task.contextRef}`);
  lines.push(
    `允许的记忆工具：${task.allowedTools.length ? task.allowedTools.join('、') : '无'}`,
    '请完成该任务，并用简洁中文给出结果摘要、依据的记忆/知识 ID、发生的变更与仍需确认的事项。',
    '不要编造未通过工具验证的记忆或变更；不能执行的操作要明确说明。'
  );
  return lines.join('\n').slice(0, INSTRUCTION_MAX);
}

function projectWorkerContext({ task, systemPrompt }) {
  if (!task || typeof task !== 'object') {
    throw new TypeError('projectWorkerContext 需要任务对象');
  }
  const allowedTools = Array.isArray(task.allowedTools) ? [...task.allowedTools] : [];
  return {
    source: {
      kind: 'task_contract',
      taskId: task.taskId,
      contractVersion: task.contractVersion || 1,
    },
    // 只有 system prompt + 一条任务指令；不复制主控会话历史。
    messages: [
      { role: 'system', content: typeof systemPrompt === 'string' ? systemPrompt : '' },
      { role: 'user', content: buildTaskInstruction({ ...task, allowedTools }) },
    ],
    memoryScopeSessionId: task.parentSessionId || task.workerSessionId || null,
    userText: task.parentUserText || task.goal,
    contextRef: task.contextRef || null,
    authorization: {
      allowedTools,
      path: task.route ? task.route.path : null,
      budget: task.budget
        ? {
            maxRounds: task.budget.maxRounds,
            maxToolCalls: task.budget.maxToolCalls,
            maxReadOnlyRetries: task.budget.maxReadOnlyRetries,
          }
        : null,
    },
  };
}

module.exports = {
  buildTaskInstruction,
  projectWorkerContext,
};
