/* global module */
/**
 * Worker 上下文投影（阶段 2）。
 *
 * Worker 只拿到完成任务所需的最小上下文：任务目标、必要上下文、记忆作用域、
 * 允许的工具与预算。投影函数是纯函数，不读取主控历史、不读取其他 Worker 的
 * 会话，也不返回任何会话存储句柄——这是 Session 隔离的接口保证。
 */

const { getInstanceUserId } = require('../user-scope');

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

// ---- FM-2 交接上下文丢失（§17）----
// 必需约束或决策未传递时阻断执行，并从已验证引用重建。
// 必需约束由委派方在任务上声明（requiredContextKeys）；承载位置有两处：
// - task.context：JSON 对象字符串（键即约束/决策名）；
// - task.contextRef：已验证产物引用，正文为 JSON 对象（重建来源）。
// 纯文本 context 无法承载具名约束：声明了 requiredContextKeys 却既没有
// JSON 对象、也没有可解析引用 → 一律判缺失（fail-closed），不靠猜。
function parseContextObject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * 校验委派交接是否完整。纯函数：产物读取通过 resolveContextRef 注入，
 * 本模块不持有任何 Store 句柄。返回值区分三种结果：
 * - ok:true  rebuilt:false —— 声明的必需约束全部在 context 里，直接放行；
 * - ok:true  rebuilt:true  —— context 缺失的键已从 contextRef 已验证产物重建；
 * - ok:false                —— 仍有缺失键，调用方必须阻断执行（不得启动 Worker）。
 */
function validateHandoff({ task, resolveContextRef = null } = {}) {
  const required = Array.isArray(task && task.requiredContextKeys)
    ? task.requiredContextKeys
        .filter(key => typeof key === 'string' && key.trim())
        .map(key => key.trim())
    : [];
  if (!required.length) {
    return {
      ok: true,
      requiredKeys: [],
      missing: [],
      rebuilt: false,
      rebuiltFrom: null,
      rebuiltObject: null,
    };
  }
  const contextObject = parseContextObject(task && task.context);
  const available = new Set(contextObject ? Object.keys(contextObject) : []);
  let missing = required.filter(key => !available.has(key));
  let rebuilt = false;
  let rebuiltFrom = null;
  let rebuiltObject = null;
  if (missing.length && typeof resolveContextRef === 'function' && task.contextRef) {
    let refObject = null;
    try {
      const content = resolveContextRef(String(task.contextRef));
      const body = content && typeof content === 'object' ? content.content : content;
      refObject =
        body && typeof body === 'object' && !Array.isArray(body)
          ? body
          : parseContextObject(typeof body === 'string' ? body : null);
    } catch (_) {
      // 引用不可读等价于没有重建来源，保持缺失判定（fail-closed）。
      refObject = null;
    }
    if (refObject) {
      const refKeys = new Set(Object.keys(refObject));
      const stillMissing = missing.filter(key => !refKeys.has(key));
      if (stillMissing.length < missing.length) {
        // 重建结果必须含「context 里原有的键 + 从引用补到的键」：
        // 只回传补到的那几个键，调用方投影时会把原本就有的约束丢掉。
        rebuiltObject = { ...(contextObject || {}) };
        for (const key of required) {
          if (refKeys.has(key)) rebuiltObject[key] = refObject[key];
        }
        missing = stillMissing;
        rebuilt = missing.length === 0;
        rebuiltFrom = rebuilt ? String(task.contextRef) : null;
        if (!rebuilt) rebuiltObject = null;
      }
    }
  }
  if (missing.length) {
    return {
      ok: false,
      requiredKeys: required,
      missing,
      errorCode: 'handoff_context_missing',
      rebuilt: false,
      rebuiltFrom: null,
      rebuiltObject: null,
    };
  }
  return {
    ok: true,
    requiredKeys: required,
    missing: [],
    rebuilt,
    rebuiltFrom,
    rebuiltObject,
  };
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
    // 长期记忆是用户级：委派任务沿用父请求的可信用户身份；
    // 旧任务没有该字段时回落到实例用户（服务端身份，不读客户端传参）。
    userId: task.parentUserId || getInstanceUserId(),
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
  validateHandoff,
};
