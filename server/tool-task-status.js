/**
 * 主控查询子 Agent 任务状态（只读）。
 *
 * 委派是异步的：delegate_to_bot 返回 taskId 后，结果由 Result Delivery 自动
 * 写回当前会话。模型偶尔会想「马上看看跑得怎么样」，这里提供一个受会话
 * 约束的只读入口，避免它编造不存在的工具名或状态。
 *
 * 安全边界：只允许查询 parentSessionId === 当前会话的任务，跨会话一律按
 * task_not_found 处理，不回显任务内容。
 */
const tasks = require('./agents/tasks');

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: '参数必须是 JSON 对象' };
  }
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (!taskId) return { ok: false, error: '缺少必填参数 taskId' };
  return { ok: true, args: { taskId } };
}

const definition = Object.freeze({
  name: 'get_bot_task_status',
  description:
    '查询当前会话派发给子 Agent 的任务状态（queued / running / completed / failed / recovery 等）。' +
    '只能查询本会话通过 delegate_to_bot 创建的任务；任务结果仍会自动写回当前会话，不需要反复轮询。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      taskId: Object.freeze({
        type: 'string',
        description: 'delegate_to_bot 返回的 taskId',
      }),
    }),
    required: Object.freeze(['taskId']),
  }),
  timeoutMs: 3000,
  readOnly: true,
  risk: 'read',
  validate,
  handler(args, context) {
    const checked = validate(args);
    if (!checked.ok) {
      return { ok: false, code: 'invalid_args', error: checked.error };
    }
    const sessionId =
      context && typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
    if (!sessionId) {
      return { ok: false, code: 'session_required', error: '查询任务需要当前会话' };
    }
    const task = tasks.getTask(checked.args.taskId);
    if (!task || task.parentSessionId !== sessionId) {
      return { ok: false, code: 'task_not_found', error: '任务不存在或不属于当前会话' };
    }
    return {
      ok: true,
      taskId: task.taskId,
      botId: task.agentId || task.botId,
      taskType: task.taskType,
      status: task.status,
      errorCode: task.errorCode || null,
      updatedAt: task.updatedAt || null,
      summary: `任务 ${task.taskId} 当前状态：${task.status}`,
    };
  },
});

module.exports = { definition, validate };
