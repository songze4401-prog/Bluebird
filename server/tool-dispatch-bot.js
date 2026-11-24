/**
 * 主控 → Memory Bot 的受控派发工具。
 *
 * 工具只负责创建并排队一个已有的 agent task；执行仍由 Memory Bot Runtime
 * 完成，结果写入 Task Store 并投递回主控当前会话。它不是第二套执行器，
 * 也不允许主控直接调用记忆维护接口。
 */
const { getManifest, isKnownBot } = require('./agents/manifest');
// Phase 1 交付物 1：创建/排队统一走唯一编排入口（内部复用 Router，不另起一套）。
const orchestrator = require('./agents/orchestrator');
const mainSessions = require('./sessions');
const { textLength } = require('./text-utils');

const GOAL_MAX = 2000;
const CONTEXT_MAX = 8000;
const ALLOWED_TOOLS_MAX = 6;
// 路由错误码 → 工具错误码。旧调用方依赖 bot_not_ready 等既有短码，
// 适配器负责翻译，不把控制面内部错误码暴露给模型。
const TOOL_ERROR_CODES = Object.freeze({
  agent_not_available: 'bot_not_ready',
  agent_not_found: 'bot_not_ready',
  capability_not_found: 'invalid_task_type',
  tool_not_allowed: 'invalid_args',
  invalid_task: 'invalid_args',
  agent_queue_full: 'agent_queue_full',
});

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: '参数必须是 JSON 对象' };
  }
  const botId = typeof args.botId === 'string' ? args.botId.trim() : '';
  if (!botId) {
    return { ok: false, error: '缺少必填参数 botId' };
  }
  if (!isKnownBot(botId)) {
    return { ok: false, error: `未知的 Agent：${botId}` };
  }
  const manifest = getManifest(botId);
  if (!manifest.acceptedTaskTypes.includes(args.taskType)) {
    return { ok: false, error: `taskType 不在 ${botId} 受理范围` };
  }
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal) return { ok: false, error: '缺少必填参数 goal' };
  if (textLength(goal) > GOAL_MAX) {
    return { ok: false, error: `goal 超过 ${GOAL_MAX} 字上限` };
  }
  const context =
    typeof args.context === 'string' ? args.context.trim() : '';
  if (textLength(context) > CONTEXT_MAX) {
    return { ok: false, error: `context 超过 ${CONTEXT_MAX} 字上限` };
  }
  let allowedTools = null;
  if (args.allowedTools !== undefined) {
    if (!Array.isArray(args.allowedTools) || !args.allowedTools.length) {
      return { ok: false, error: 'allowedTools 必须是非空数组' };
    }
    if (args.allowedTools.length > ALLOWED_TOOLS_MAX) {
      return { ok: false, error: 'allowedTools 数量超限' };
    }
    const allowed = new Set(manifest.toolAllowlist);
    for (const name of args.allowedTools) {
      if (typeof name !== 'string' || !allowed.has(name)) {
        return { ok: false, error: 'allowedTools 超出 Memory Bot 能力范围' };
      }
    }
    allowedTools = [...new Set(args.allowedTools)];
  }
  return {
    ok: true,
    args: {
      botId,
      taskType: args.taskType,
      goal,
      ...(context ? { context } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    },
  };
}

const definition = Object.freeze({
  name: 'delegate_to_bot',
  description:
    '把一个明确的任务派发给已注册的小 Agent（researcher / executor / memory / reviewer）。' +
    '必须先选定 botId 与该 Agent 支持的 taskType；不会在当前轮同步返回执行结果，' +
    '任务完成后结果会写入当前会话，用户也可以在任务页查看。' +
    '长期记忆的查询与写入由主控 Agent 自己用 memory_search / memory_remember 完成，不要用此工具处理记忆。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      botId: Object.freeze({
        type: 'string',
        description: '目标 Agent 的 botId：researcher / executor / memory / reviewer',
      }),
      taskType: Object.freeze({
        type: 'string',
        description: '任务类型；必须是目标 Agent acceptedTaskTypes 之一（validate 动态校验）',
      }),
      goal: Object.freeze({
        type: 'string',
        description: '要目标 Agent 完成的目标',
        maxLength: GOAL_MAX,
      }),
      context: Object.freeze({
        type: 'string',
        description: '主控认为任务所需的最小上下文；不要把整段对话复制进来',
        maxLength: CONTEXT_MAX,
      }),
      allowedTools: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string' }),
        maxItems: ALLOWED_TOOLS_MAX,
        description: '可选：进一步收窄本任务可用的工具（须在目标 Agent 白名单内）',
      }),
    }),
    required: Object.freeze(['botId', 'taskType', 'goal']),
  }),
  timeoutMs: 5000,
  readOnly: false,
  risk: 'reversible_write',
  validate,
  async handler(args, context) {
    const checked = validate(args);
    if (!checked.ok) {
      return { ok: false, code: 'invalid_args', error: checked.error };
    }
    const mainSessionId =
      context && typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
    if (!mainSessionId || !mainSessions.getSession(mainSessionId)) {
      return {
        ok: false,
        code: 'session_required',
        error: '派发任务需要当前主控会话',
      };
    }

    // 兼容适配器：工具 schema 与成功返回形状保持不变，创建/排队统一走编排入口。
    try {
      const { task, idempotent } = orchestrator.orchestrate(
        {
          agentId: args.botId,
          capability: args.taskType,
          taskType: args.taskType,
          goal: args.goal,
          context: args.context || '',
          allowedTools: args.allowedTools || null,
          // 父会话同时是委派任务的记忆 scope；Bot session 只承载执行轨迹。
          parentSessionId: mainSessionId,
          parentMessageId: context.userMessageId || null,
          parentUserText: context.userText || '',
          // 记忆归属用户由运行时注入的可信身份决定（Worker 按用户级读记忆）。
          parentUserId: context.userId || null,
        },
        { source: 'delegate_to_bot' }
      );

      return {
        ok: true,
        taskId: task.taskId,
        botId: task.botId,
        taskType: task.taskType,
        status: task.status,
        sessionId: task.sessionId,
        parentSessionId: mainSessionId,
        routeId: task.route ? task.route.routeId : null,
        path: task.route ? task.route.path : null,
        idempotent: idempotent === true,
        resultPending: true,
        summary: '已提交给 Memory Bot，状态与结果可从任务页或当前会话接收。',
      };
    } catch (error) {
      if (error && typeof error.code === 'string' && TOOL_ERROR_CODES[error.code]) {
        return {
          ok: false,
          code: TOOL_ERROR_CODES[error.code],
          error: error.message || '派发任务失败',
        };
      }
      throw error;
    }
  },
});

module.exports = { definition, validate };
