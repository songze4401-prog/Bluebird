/**
 * 云岫 Bluebird — Agent 编排模块（agent-runtime.js）
 *
 * 职责（任务书）：工具注册、参数校验、执行、结果回传、调用轮数限制、
 * 超时、去重和错误处理。**不做**聊天编排（那在 index.js 的路由里）、
 * **不做**落盘与回复清洗（那在 completeChatTurn 里）。
 *
 * 执行安全硬约束：
 * - 轮数硬上限：一次 Agent 流程最多 MAX_ROUNDS 次模型调用，末轮强制
 *   不带 tools 收尾——模型再想调用工具也没有机会，从结构上杜绝无限循环；
 * - 工具超时硬边界：Promise.race + AbortController。超时即 abort 通知
 *   handler 停止后台工作并立即返回 timeout 结果，不是"停止等待"而已；
 *   handler 迟到的 resolve/reject 被显式吞掉，不会变成 unhandled rejection；
 * - 去重：同一请求内，同一工具 + 同一组规范化参数直接复用上次结果；
 * - 错误隔离：未知工具 / 参数非法 / 工具异常 / 超时全部转为结构化
 *   { ok:false, code } 结果回传给模型，由模型决定下一步，绝不崩溃聊天；
 * - 断连：每一轮模型调用前检查 isClientGone，断开后绝不发起下一轮。
 *
 * 中间轮消息（assistant tool_calls + tool 结果）只存在于请求内存，
 * 由调用方自行决定是否落盘——index.js 的约定是：绝不落盘。
 *
 * 紧急关闭开关：BLUEBIRD_AGENT_TOOLS=1 开启，其它任意值（含未设置）
 * 均为关闭，**默认关闭**。每请求经 agentToolsEnabled() 重新读取，
 * 进程内修改环境变量即时生效；状态变化打 warn 日志。
 */
const crypto = require('crypto');
const { tagModelMessage } = require('./context/projection');

const crashHook = require('./agents/crash-hook');
const failOpenPolicy = require('./agents/failopen-policy');
const { createChatCompletion } = require('./model-adapter');
const monitoring = require('./monitoring');
const memorySearchTool = require('./tool-memory-search');
const memoryRememberTool = require('./tool-memory-remember');
const knowledgeSearchTool = require('./tool-knowledge-search');
const delegateToBotTool = require('./tool-dispatch-bot');
const { truncateText } = require('./text-utils');
const { buildPolicyInstruction } = require('./agent-policy');
const { detectExplicitDelegation } = require('./delegation-intent');

const FORCED_DELEGATION_INSTRUCTION = `
【服务端已执行子 agent 委派】
本轮用户明确要求把任务交给 Memory Bot / 子 agent 处理。系统已经在本次请求中实际调用 delegate_to_bot，工具结果在上一条 tool 消息里。
你必须只依据该工具结果回复：
- ok=true 时，简短说明任务已提交、会异步执行，结果稍后回到当前会话或任务页；不要声称任务已经完成，不要编造进度、队列或失败信息。
- ok=false 时，如实说明提交失败的原因，不得改口说已经派发成功。
- 不要再调用 delegate_to_bot。
`.trim();

const FORCED_DELEGATION_DENIED_INSTRUCTION = `
【本次无法调用子 agent】
用户明确要求把任务交给 Memory Bot / 子 agent，但当前 Agent 策略不允许调用 delegate_to_bot，系统无法派发任务。
你必须如实说明当前无法派发及原因；绝不能说已经派发、已经在队列里或正在处理。
`.trim();

// ---- 可调参数（环境变量，加载时读取；开关除外——开关每请求重读） ----
// 逐个显式读取（不用动态 process.env[name]：既让 lint 的
// expo/no-dynamic-env-var 满意，也让每个开关在代码里可 grep）。

function clampIntEnv(raw, fallback, min, max, name) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(
      `[agent] ${name} 取值非法（${raw}），已回退默认 ${fallback}（允许 ${min}-${max}）`
    );
    return fallback;
  }
  return n;
}

// 一次 Agent 流程的模型调用硬上限。末轮强制无 tools 收尾，
// 因此小于 2 时工具永远不会被执行——加载时钳到 >= 2。
const MAX_ROUNDS = Math.max(
  2,
  clampIntEnv(process.env.BLUEBIRD_AGENT_MAX_ROUNDS, 3, 2, 5, 'BLUEBIRD_AGENT_MAX_ROUNDS')
);
// 未在工具定义里声明 timeoutMs 时的兜底超时。
const TOOL_TIMEOUT_DEFAULT = clampIntEnv(
  process.env.BLUEBIRD_AGENT_TOOL_TIMEOUT_MS,
  5000,
  500,
  30000,
  'BLUEBIRD_AGENT_TOOL_TIMEOUT_MS'
);
// 回传给模型的工具结果体硬上限（防御工具自身返回巨型内容）。
const TOOL_RESULT_MAX = 4000;
const TOOL_RISKS = new Set(['read', 'reversible_write', 'high_risk']);

// ---- 紧急关闭开关 ----

function agentToolsEnabled() {
  return process.env.BLUEBIRD_AGENT_TOOLS === '1';
}

let lastSwitchState = agentToolsEnabled();

if (lastSwitchState) {
  console.log(
    '[agent] BLUEBIRD_AGENT_TOOLS=1：Agent 工具调用已启用（每请求重新判断，进程内改环境变量即时生效）'
  );
}

function logSwitchIfChanged() {
  const now = agentToolsEnabled();
  if (now !== lastSwitchState) {
    console.warn(
      `[agent] 开关状态变化：${lastSwitchState ? '开' : '关'} -> ${now ? '开' : '关'}（即时生效，无需重启）`
    );
    lastSwitchState = now;
  }
}

// 每个聊天请求都调用一次（与是否走 Agent 路径无关）：
// 关闭期间的开关变化也要能被发现，否则 lastSwitchState 会staleness。
function noteSwitchObservation() {
  logSwitchIfChanged();
}

// ---- 工具注册表（服务端白名单） ----

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const tools = new Map();

function registerTool(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('[agent] 工具定义必须是对象');
  }

  const {
    name,
    description,
    parameters,
    validate,
    handler,
    timeoutMs,
    readOnly,
    risk,
    failOpenEligible,
  } = definition;

  if (!TOOL_NAME_RE.test(name || '')) {
    throw new TypeError(`[agent] 非法工具名：${name}`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError(`[agent] 工具缺少 description：${name}`);
  }
  if (!parameters || typeof parameters !== 'object') {
    throw new TypeError(`[agent] 工具缺少 parameters：${name}`);
  }
  if (typeof validate !== 'function') {
    throw new TypeError(`[agent] 工具缺少 validate()：${name}`);
  }
  if (typeof handler !== 'function') {
    throw new TypeError(`[agent] 工具缺少 handler()：${name}`);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`[agent] 工具 timeoutMs 非法：${name}`);
  }
  if (readOnly !== undefined && typeof readOnly !== 'boolean') {
    throw new TypeError(`[agent] 工具 readOnly 必须是布尔值：${name}`);
  }

  const resolvedRisk =
    risk === undefined ? (readOnly === true ? 'read' : 'reversible_write') : risk;
  if (!TOOL_RISKS.has(resolvedRisk)) {
    throw new TypeError(`[agent] 工具 risk 非法：${name}`);
  }

  if (failOpenEligible !== undefined && typeof failOpenEligible !== 'boolean') {
    throw new TypeError(`[agent] 工具 failOpenEligible 必须是布尔值：${name}`);
  }

  // failOpenEligible：该工具是否作为"预授权动作"参与 allowlist 判定（§33）。
  // 默认 false：未登记的工具保持既有语义，不会被 allowlist 判定接管。
  tools.set(name, {
    ...definition,
    risk: resolvedRisk,
    failOpenEligible: failOpenEligible === true,
  });
}

function unregisterTool(name) {
  tools.delete(String(name || ''));
}

function policyAllowsTool(policy, name) {
  if (!policy) return true;
  if (policy.mode === 'answer_only') return false;
  const allowed = policy.tools && policy.tools.allowedTools;
  return allowed === null || allowed === undefined || allowed.includes(name);
}

// 转成 OpenAI Chat Completions 的 tools 入参格式。
// 传入策略时只暴露服务端已注册且被策略允许的工具；不能靠策略注册新工具。
function listToolSpecs(policy = null) {
  return [...tools.values()]
    .filter(def => policyAllowsTool(policy, def.name))
    .map(def => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
}

function listToolMetadata() {
  return [...tools.values()].map(def => ({
    name: def.name,
    description: def.description,
    readOnly: def.readOnly === true,
    risk: def.risk,
    timeoutMs: def.timeoutMs || TOOL_TIMEOUT_DEFAULT,
  }));
}

// 启动即注册记忆只读检索与受控写入工具。
registerTool(memorySearchTool.definition);
registerTool(memoryRememberTool.definition);
registerTool(knowledgeSearchTool.definition);
registerTool(delegateToBotTool.definition);

// ---- 工具执行 ----

class ToolTimeoutError extends Error {}

// 稳定序列化：键排序，保证"同一组参数"在不同键序下得到同一去重键。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function buildToolSummary(result) {
  if (typeof result.summary === 'string' && result.summary) {
    return result.summary;
  }
  return result.ok ? '执行成功' : result.error || '执行失败';
}

// 把 OpenAI 兼容流式响应收束成与一次性 completion 相同的结构；
// 文本增量实时交给 onDelta，工具调用参数只在本地累积，不发送给客户端。
async function consumeCompletionStream(stream, onDelta) {
  let content = '';
  const calls = new Map();
  let finishReason = null;

  for await (const chunk of stream) {
    const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (typeof onDelta === 'function') {
        try {
          onDelta(delta.content);
        } catch (_) {
          // 客户端写失败不应破坏模型流；调用方用 abortSignal 终止。
        }
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const current = calls.get(index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.id && !current.id) current.id = part.id;
        if (part.function) {
          if (typeof part.function.name === 'string' && part.function.name) {
            if (!current.function.name) current.function.name = part.function.name;
            else if (current.function.name !== part.function.name) {
              current.function.name += part.function.name;
            }
          }
          if (typeof part.function.arguments === 'string') {
            current.function.arguments += part.function.arguments;
          }
        }
        calls.set(index, current);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call], order) => ({
      id: call.id || `stream_call_${index}_${order}`,
      type: 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments || '{}',
      },
    }))
    .filter(call => call.function.name);

  return {
    choices: [
      {
        index: 0,
        finish_reason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: null,
  };
}

/**
 * 执行单个工具调用。rawArgs 为模型给的原始 arguments（已 JSON.parse，
 * parse 失败时传 null）。返回结构化结果，绝不抛出。
 *
 * context: { sessionId, userText, userMessageId, cache, abortSignal? }
 *   userText/userMessageId 供受控记忆写入工具校验来源；
 *   abortSignal 为外部中止信号（客户端断连）：尽力早停；
 *   超时（timeoutMs）仍是硬边界，两者都通过同一个 AbortController
 *   通知 handler——handler 必须在可等待点检查 signal。
 */
// ---- fail-open 执行闸门（收口 C） ----
// 风险等级由服务端工具定义推导，不接受调用方自报降级。
const FAIL_OPEN_RISK = { read: 'R0', reversible_write: 'R1', high_risk: 'R3' };
const FAIL_OPEN_SCOPE_FIELDS = [
  'taskId',
  'planId',
  'planVersion',
  'targetScope',
  'subject',
  'environment',
  'resource',
];

function failOpenDigestOf(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * 判定一次"预授权动作"是否放行。
 * - 作用域字段缺失（含老任务没有 planId/planVersion）→ fail-closed，不当作"无计划可继续"。
 * - R2/R3 一律不放行，allowlist 命中也不放行——它们必须走审批，不因命中白名单被绕过。
 * - 判定本身写审计（含 policyVersion）；审计写失败时 evaluate 返回 allowed=false。
 */
function evaluateFailOpenScope(def, scope, paramsDigest) {
  const riskLevel = FAIL_OPEN_RISK[def.risk] || 'R3';
  const missing = FAIL_OPEN_SCOPE_FIELDS.filter(
    key => scope[key] === null || scope[key] === undefined || scope[key] === ''
  );
  if (missing.length) {
    return {
      active: true,
      ok: false,
      code: 'failopen_scope_incomplete',
      reason: 'scope_incomplete',
      missing,
      policyVersion: failOpenPolicy.currentPolicyVersion(),
    };
  }
  const verdict = failOpenPolicy.evaluate({
    tool: def.name,
    operation: String(scope.operation || 'execute'),
    paramsDigest,
    targetScope: scope.targetScope,
    // 计划版本是任务记录里冻结的版本，不是调用方现算的版本。
    planVersion: String(scope.planVersion),
    subject: scope.subject,
    environment: scope.environment,
    resource: scope.resource,
    riskLevel,
    taskId: scope.taskId,
    runId: scope.runId || null,
    traceId: scope.traceId || null,
  });
  if (verdict.allowed === true) {
    return {
      active: true,
      ok: true,
      policyId: verdict.policyId,
      policyVersion: verdict.policyVersion,
      matchedRule: verdict.matchedRule,
      traceId: verdict.traceId,
    };
  }
  return {
    active: true,
    ok: false,
    code: riskLevel === 'R2' || riskLevel === 'R3' ? 'approval_required' : 'failopen_denied',
    reason: verdict.reason,
    policyVersion: verdict.policyVersion,
    traceId: verdict.traceId,
  };
}

async function executeToolCall(name, rawArgs, context) {
  const def = tools.get(String(name || ''));
  const policy = context && context.policy ? context.policy : null;
  const toolName = String(name || '');
  const round = context && Number.isInteger(context.round) ? context.round : 1;
  const monitor = monitoring.beginToolCall({
    toolName,
    round,
    readOnly: def ? def.readOnly === true : null,
    registered: Boolean(def),
  });
  const startedAt = Date.now();

  if (!def) {
    monitor.complete({
      ok: false,
      code: 'unknown_tool',
      durationMs: 0,
      executed: false,
    });
    return { ok: false, code: 'unknown_tool', error: `未注册的工具：${name}` };
  }

  // Worker 工具权限网关：任务声明的工具集合由 Worker Runtime 注入，
  // 拒绝时回调审计钩子；参数与返回内容不进入审计。
  const authorizer =
    context && typeof context.authorizer === 'function' ? context.authorizer : null;
  if (authorizer) {
    const verdict = authorizer(def.name);
    if (!verdict || verdict.ok !== true) {
      const code = (verdict && verdict.code) || 'tool_not_allowed';
      monitor.complete({
        ok: false,
        code,
        durationMs: Date.now() - startedAt,
        executed: false,
      });
      if (typeof context.onToolDenied === 'function') {
        try {
          context.onToolDenied({ name: def.name, code });
        } catch (_) {
          // 审计失败不能改变拒绝结果。
        }
      }
      return { ok: false, code, error: '当前任务不允许调用该工具' };
    }
  }

  if (policy && !policyAllowsTool(policy, def.name)) {
    monitor.complete({
      ok: false,
      code: 'policy_tool_denied',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return {
      ok: false,
      code: 'policy_tool_denied',
      error: '当前 Agent 策略不允许该工具',
    };
  }
  // 预授权动作的 allowlist 判定接在真实执行路径上：只有在工具登记为
  // failOpenEligible 且调用方给出冻结作用域时接管，其余工具保持既有语义。
  // R2/R3 分支先判：命中白名单也不执行，仍落回审批（confirmation/approval）。
  const failOpenScope =
    def.failOpenEligible === true && context && context.failOpen ? context.failOpen : null;
  if (failOpenScope && def.risk === 'high_risk') {
    const gate = evaluateFailOpenScope(def, failOpenScope, failOpenDigestOf(rawArgs ?? null));
    monitor.complete({
      ok: false,
      code: gate.code || 'approval_required',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return {
      ok: false,
      code: gate.code || 'approval_required',
      error: '该动作风险等级不允许 fail-open，必须走审批',
      failOpenReason: gate.reason || null,
      policyVersion: gate.policyVersion ?? null,
    };
  }
  if (def.risk === 'high_risk') {
    monitor.complete({
      ok: false,
      code: 'confirmation_required',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return {
      ok: false,
      code: 'confirmation_required',
      error: '高风险工具需要后端确认，当前没有已授权的确认流程',
    };
  }

  // 显式区分只读工具与有副作用的写入工具：写入工具必须在运行层拿到
  // 当前会话与用户原话，不能只依赖模型参数或 handler 内部兜底。
  if (def.readOnly === false && (!context || !context.sessionId || !context.userText)) {
    monitor.complete({
      ok: false,
      code: 'unauthorized_write',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return {
      ok: false,
      code: 'unauthorized_write',
      error: '写入工具缺少当前会话或用户原话，已拒绝执行',
    };
  }

  if (rawArgs === null || rawArgs === undefined) {
    monitor.complete({
      ok: false,
      code: 'invalid_params',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return { ok: false, code: 'invalid_params', error: '工具参数不是合法 JSON' };
  }

  const validated = def.validate(rawArgs);
  if (!validated.ok) {
    monitor.complete({
      ok: false,
      code: 'invalid_params',
      durationMs: Date.now() - startedAt,
      executed: false,
    });
    return { ok: false, code: 'invalid_params', error: validated.error };
  }

  // R0/R1 预授权动作：未命中 allowlist 一律拒绝执行（handler 不被调用），
  // 命中则继续执行——判定本身已写审计，含 policyVersion。
  if (failOpenScope) {
    const gate = evaluateFailOpenScope(def, failOpenScope, failOpenDigestOf(validated.args));
    if (gate.ok !== true) {
      monitor.complete({
        ok: false,
        code: gate.code,
        durationMs: Date.now() - startedAt,
        executed: false,
      });
      if (typeof context.onToolDenied === 'function') {
        try {
          context.onToolDenied({ name: def.name, code: gate.code, reason: gate.reason || null });
        } catch (_) {
          // 审计失败不能改变拒绝结果。
        }
      }
      return {
        ok: false,
        code: gate.code,
        error: 'fail-open 判定未放行，已拒绝执行',
        failOpenReason: gate.reason || null,
        policyVersion: gate.policyVersion ?? null,
      };
    }
  }

  // P2：副作用工具的幂等闸门。只有任务执行器（有 taskId）会注入 context.sideEffect，
  // 且只对 readOnly === false 的工具生效；无副作用工具不会多出账本行。
  const sideEffect = context.sideEffect && def.readOnly === false ? context.sideEffect : null;
  // 逃生阀：显式 dedupeKeyOverride 只参与幂等键，不进入工具参数与业务语义。
  const split = sideEffect
    ? sideEffect.splitOverride(validated.args)
    : { args: validated.args, override: null };
  const toolArgs = split.args;
  let ledgerOpKey = null;

  // 同请求去重：同工具 + 同规范化参数直接复用上次结果；
  // 带显式覆盖时按覆盖值区分，允许同一请求内真正执行两次相同参数。
  const dedupeKey = `${def.name}|${stableStringify(toolArgs)}${
    split.override ? `|#${split.override}` : ''
  }`;
  if (context.cache.has(dedupeKey)) {
    const cached = { ...context.cache.get(dedupeKey), deduped: true };
    const serializedCached = JSON.stringify(cached);
    monitor.complete({
      ok: cached.ok === true,
      code: cached.code || null,
      durationMs: Date.now() - startedAt,
      deduped: true,
      executed: false,
      resultBytes: serializedCached ? serializedCached.length : 0,
      truncated: serializedCached ? serializedCached.length > TOOL_RESULT_MAX : false,
    });
    return cached;
  }

  if (sideEffect) {
    const verdict = sideEffect.before({
      toolName: def.name,
      args: toolArgs,
      override: split.override,
    });

    if (verdict.mode === 'reuse') {
      const reused = {
        ...(verdict.result && typeof verdict.result === 'object' ? verdict.result : {}),
        ok: true,
        reused: true,
        opKey: verdict.opKey,
        resultDigest: verdict.resultDigest || null,
      };
      if (verdict.resultOmitted === true) reused.resultOmitted = true;
      context.cache.set(dedupeKey, reused);
      monitor.complete({
        ok: true,
        code: null,
        durationMs: Date.now() - startedAt,
        deduped: true,
        executed: false,
        resultBytes: JSON.stringify(reused).length,
      });
      return reused;
    }

    if (verdict.mode === 'blocked') {
      const blocked = {
        ok: false,
        code: verdict.code,
        error:
          verdict.code === 'side_effect_unknown'
            ? '该副作用可能已执行，已转入 recovery 等待人工核对'
            : '幂等账本不可用，副作用已阻止执行',
      };
      monitor.complete({
        ok: false,
        code: blocked.code,
        durationMs: Date.now() - startedAt,
        executed: false,
      });
      return blocked;
    }

    ledgerOpKey = verdict.opKey;
  }

  const timeoutMs =
    Number.isFinite(def.timeoutMs) && def.timeoutMs > 0
      ? def.timeoutMs
      : TOOL_TIMEOUT_DEFAULT;

  const controller = new AbortController();

  // 外部中止（客户端断连）：立即传播给 handler，尽早停止后台工作。
  // 监听器必须在本次工具调用结束时摘掉：once:true 只在信号真的触发时移除，
  // 而一次请求会连续调用十几次工具，监听器会在外部信号上不断累积
  // （Node 超过 10 个监听器就告警）。
  const externalSignal = context && context.abortSignal;
  let externalAbortHandler = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, {
        once: true,
      });
    }
  }

  let timer = null;
  let timedOut = false;

  // handler 的结果 / rejection 一律先在本层归一化：
  // ① 超时前抛错 → 转结构化 tool_error，不让异常冒泡到轮次编排；
  // ② 超时后迟到的 rejection → 静默丢弃，且不打"工具执行异常"告警（避免虚假告警）。
  //    注：本结构下 Promise.race 已为两个 promise 都挂上 rejection 处理，
  //    迟到 rejection 本身不会变成 unhandled rejection（已实测验证）；
  //    这里的作用是语义清晰 + 告警静默，不是"防崩进程"。
  const handlerPromise = Promise.resolve()
    .then(() =>
      def.handler(toolArgs, {
        sessionId: context.sessionId,
        memoryScopeSessionId: context.memoryScopeSessionId || context.sessionId,
        userId: context.userId || null,
        userText: context.userText,
        userMessageId: context.userMessageId,
        signal: controller.signal,
      })
    )
    .catch(error => {
      // 超时之前的真实异常按工具错误处理；超时后的迟到异常静默吞掉
      if (timedOut) return undefined;
      console.error('[agent] 工具执行异常:', def.name, error && error.message);
      return { ok: false, code: 'tool_error', error: '工具内部错误' };
    });

  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // 硬边界：通知 handler 停止后台工作，而不是仅停止等待
      controller.abort();
      reject(new ToolTimeoutError());
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  // 失败/超时结果也写缓存：任务书去重规范要求"同请求内同工具同参数直接
  // 复用上次结果"（不区分成败）。缓存的是**失败结果**（ok:false），
  // 绝不把超时的不完整结果当成成功缓存；重试需求通过换参数满足。
  const remember = result => {
    context.cache.set(dedupeKey, result);
    return result;
  };

  try {
    const result = remember(await Promise.race([handlerPromise, timeoutPromise]));
    // P5 注入点：handler 已返回、结果尚未落账本 / 未写任务结果。
    crashHook.hold('tool.after-handler');
    // P2：真正执行完才补终态；执行前 begin 已落盘，崩溃时留下 started 会被判 recovery。
    if (sideEffect && ledgerOpKey) {
      sideEffect.after({
        opKey: ledgerOpKey,
        status: result.ok === true ? 'succeeded' : 'failed',
        result,
        errorCode: result.code || null,
      });
    }
    const serialized = JSON.stringify(result);
    monitor.complete({
      ok: result.ok === true,
      code: result.code || null,
      durationMs: Date.now() - startedAt,
      deduped: result.deduped === true,
      executed: true,
      resultBytes: serialized ? serialized.length : 0,
      truncated: serialized ? serialized.length > TOOL_RESULT_MAX : false,
    });
    return result;
  } catch (error) {
    if (timedOut || error instanceof ToolTimeoutError) {
      const result = remember({
        ok: false,
        code: 'tool_timeout',
        error: `工具执行超时（>${timeoutMs}ms），已中止`,
      });
      // 超时后 handler 可能仍在后台完成副作用：不能写 failed，只能写 unknown。
      if (sideEffect && ledgerOpKey) {
        sideEffect.after({
          opKey: ledgerOpKey,
          status: 'unknown',
          errorCode: result.code,
        });
      }
      monitor.complete({
        ok: false,
        code: result.code,
        durationMs: Date.now() - startedAt,
        executed: true,
      });
      return result;
    }
    const result = remember({ ok: false, code: 'tool_error', error: '工具内部错误' });
    if (sideEffect && ledgerOpKey) {
      sideEffect.after({ opKey: ledgerOpKey, status: 'failed', errorCode: result.code });
    }
    monitor.complete({
      ok: false,
      code: result.code,
      durationMs: Date.now() - startedAt,
      executed: true,
    });
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (externalAbortHandler && externalSignal) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
}

// 模型 tool_calls 条目归一化：补齐缺失 id（tool 消息必须与之对应），
// 统一 arguments 为字符串。
function normalizeToolCall(call) {
  const id =
    typeof call.id === 'string' && call.id
      ? call.id
      : `call_${crypto.randomUUID()}`;

  return {
    id,
    type: 'function',
    function: {
      name: String((call.function && call.function.name) || ''),
      arguments:
        typeof call.function === 'object' &&
        call.function &&
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : '{}',
    },
  };
}

/**
 * 驱动一次 Agent 回合。
 *
 * 入参：
 *   providerId / modelId   模型目标（调用方已解析）
 *   messages               基础消息（system + 历史 + 当前用户消息）
 *   temperature / maxTokens / timeout   与普通聊天一致
 *   sessionId              工具 scope 用（记忆检索按会话隔离）
 *   isClientGone           断连探针；每一轮模型调用前检查
 *   onToolEvent            工具生命周期事件回调（SSE 用）
 *
 * 返回 { rawReply, toolSteps, rounds, completion, delegationEnforced }：
 *   rawReply    最终文本（交 completeChatTurn 清洗落盘）
 *   toolSteps   工具执行摘要数组（独立字段，禁敏感内容）
 *   rounds      实际模型调用轮数
 *   completion  末轮 completion（调用方取 model 回执）；断连未调用时为 null
 *   delegationEnforced  本次是否由运行时强制实际调用了 delegate_to_bot
 */
async function runAgentTurn({
  providerId,
  modelId,
  messages,
  sessionId,
  userId = null,
  userText = '',
  userMessageId = null,
  // 记忆作用域与对话作用域分开：委派任务用父主控会话作为记忆 scope，
  // 但工具轨迹、任务日志仍属于 Bot 自己的 session。
  memoryScopeSessionId = null,
  temperature = 0.8,
  maxTokens = 1200,
  timeout = 90000,
  policy = null,
  isClientGone,
  abortSignal,
  onToolEvent,
  onRequest,
  onToolResult,
  toolAuthorizer = null,
  onToolDenied = null,
  // 收口 C：任务执行器注入的"预授权作用域"（含任务冻结的 planVersion）。
  // 只对登记为 failOpenEligible 的工具生效；不传时行为完全不变。
  failOpen = null,
  // P2：任务执行器的副作用幂等闸门；主控直聊不传，行为完全不变。
  sideEffect = null,
  credentialKey = null,
  stream = false,
  onDelta = null,
  // 主控聊天入口开启：用户明确点名 Memory Bot / 子 agent 时，
  // 不走"等模型自觉调用"，由运行时先真实调用 delegate_to_bot。
  enforceExplicitDelegation = false,
}) {
  logSwitchIfChanged();

  const activePolicy = policy && typeof policy === 'object' ? policy : null;
  const specs = listToolSpecs(activePolicy);
  // 请求内上下文：中间轮 tool_calls / tool 消息只在这里，随请求消亡，
  // 绝不写入 sessions.json（落盘由调用方只收最终消息）。
  const conversation = messages.map(message => ({ ...message }));
  const instruction = buildPolicyInstruction(activePolicy);
  const toolSteps = [];
  const cache = new Map();

  const configuredRounds =
    activePolicy && activePolicy.budgets ? activePolicy.budgets.maxRounds : null;
  const maxRounds = Number.isInteger(configuredRounds)
    ? Math.min(MAX_ROUNDS, Math.max(2, configuredRounds))
    : MAX_ROUNDS;
  const maxToolCalls =
    activePolicy && activePolicy.tools && Number.isInteger(activePolicy.tools.maxToolCalls)
      ? activePolicy.tools.maxToolCalls
      : 12;
  const maxTotalMs =
    activePolicy && activePolicy.budgets && Number.isInteger(activePolicy.budgets.maxTotalMs)
      ? activePolicy.budgets.maxTotalMs
      : 90000;
  const maxReadOnlyRetries =
    activePolicy && activePolicy.tools && Number.isInteger(activePolicy.tools.maxReadOnlyRetries)
      ? activePolicy.tools.maxReadOnlyRetries
      : 0;
  const startedAt = Date.now();

  let completion = null;
  let rawReply = '';
  let rounds = 0;
  let stopReason = null;
  let toolCallCount = 0;
  let readOnlyRetries = 0;
  let consecutiveFailures = 0;
  // B-06：累计本次 Run 的供应商真实 usage（每轮一次）。供应商没回 usage 时保持 null，
  // 绝不用字符数估算冒充 token 计量；累计值交给 Task 预算的 settle。
  let usageTotals = null;
  const addUsage = usage => {
    if (!usage || typeof usage !== 'object') return;
    const prompt = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    const completionTokens = Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : 0;
    const total = Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : prompt + completionTokens;
    if (!total) return;
    if (!usageTotals) {
      usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    usageTotals.prompt_tokens += prompt;
    usageTotals.completion_tokens += completionTokens;
    usageTotals.total_tokens += total;
  };

  // 执行并记录一次工具调用：循环与「强制委派」共用同一路径，
  // 保证超时、只读重试、去重、事件、toolSteps 与监控口径完全一致。
  const performToolCall = async (normalized, round) => {
    const startedAtTool = Date.now();
    const toolName = normalized.function.name;

    if (typeof onToolEvent === 'function') {
      onToolEvent({
        type: 'tool_start',
        name: toolName,
        callId: normalized.id,
      });
    }

    let rawArgs = null;
    try {
      rawArgs = JSON.parse(normalized.function.arguments || '{}');
    } catch (_) {
      rawArgs = null;
    }

    console.log(`[agent-dispatch] round=${round} name=${toolName} dispatched=true`);

    const toolContext = {
      sessionId,
      memoryScopeSessionId: memoryScopeSessionId || sessionId,
      userId,
      userText,
      userMessageId,
      cache,
      abortSignal,
      policy: activePolicy,
      authorizer: toolAuthorizer,
      onToolDenied,
      round,
      sideEffect,
      failOpen,
    };
    let result = await executeToolCall(toolName, rawArgs, toolContext);
    toolCallCount += 1;

    const toolDef = tools.get(toolName);
    if (
      !result.ok &&
      toolDef &&
      toolDef.readOnly === true &&
      readOnlyRetries < maxReadOnlyRetries &&
      (result.code === 'tool_timeout' || result.code === 'tool_error')
    ) {
      readOnlyRetries += 1;
      result = await executeToolCall(toolName, rawArgs, {
        ...toolContext,
        cache: new Map(),
      });
    }

    if (result.ok) consecutiveFailures = 0;
    else consecutiveFailures += 1;

    const summary = buildToolSummary(result);

    console.log(
      `[agent-tool] round=${round} name=${toolName}` +
        ` ok=${result.ok === true} code=${result.code || 'none'}` +
        ` deduped=${result.deduped === true} durationMs=${Date.now() - startedAtTool}`
    );

    if (typeof onToolEvent === 'function') {
      onToolEvent({
        type: 'tool_end',
        name: toolName,
        callId: normalized.id,
        ok: result.ok === true,
        ...(result.code ? { code: result.code } : {}),
        ...(result.deduped ? { deduped: true } : {}),
        summary,
      });
    }

    if (typeof onToolResult === 'function') {
      try {
        onToolResult({
          name: toolName,
          callId: normalized.id,
          ok: result.ok === true,
          durationMs: Date.now() - startedAtTool,
          result,
        });
      } catch (_) {
        /* 证据回调失败不影响工具结果转发 */
      }
    }

    toolSteps.push({
      name: toolName,
      ok: result.ok === true,
      summary: truncateText(summary, 120),
      durationMs: Date.now() - startedAtTool,
    });

    conversation.push(
      tagModelMessage(
        {
          role: 'tool',
          tool_call_id: normalized.id,
          content: truncateText(JSON.stringify(result), TOOL_RESULT_MAX),
        },
        `tool:${normalized.id}`
      )
    );

    monitoring.recordToolResultReturned({
      toolName: normalized.function.name,
      round,
      forwarded: true,
    });

    console.log(`[agent-result] round=${round} name=${toolName} forwarded=true`);

    return result;
  };

  // 显式子 agent 请求：先由运行时真实调用 delegate_to_bot，再让模型
  // 依据工具结果回复。模型是否"愿意"调用工具不再决定任务是否真的派出。
  // 只在调用方显式开启（主控聊天）时生效；策略关闭或不允许该工具时不派发。
  let forcedDelegationDispatched = false;
  let forcedDelegationNotice = '';

  if (
    enforceExplicitDelegation &&
    !(typeof isClientGone === 'function' && isClientGone()) &&
    Date.now() - startedAt <= maxTotalMs
  ) {
    const intent = detectExplicitDelegation(userText);

    if (intent) {
      if (
        tools.has('delegate_to_bot') &&
        policyAllowsTool(activePolicy, 'delegate_to_bot')
      ) {
        const forcedCall = normalizeToolCall({
          id: `call_forced_delegate_${crypto.randomUUID()}`,
          type: 'function',
          function: {
            name: 'delegate_to_bot',
            arguments: JSON.stringify({
              botId: 'memory',
              taskType: intent.taskType,
              goal: intent.goal,
              ...(intent.context ? { context: intent.context } : {}),
            }),
          },
        });

        conversation.push(
          tagModelMessage(
            {
              role: 'assistant',
              content: null,
              tool_calls: [forcedCall],
            },
            'assistant-tool-call:forced-delegation'
          )
        );

        const result = await performToolCall(forcedCall, 1);
        forcedDelegationDispatched = true;
        forcedDelegationNotice = FORCED_DELEGATION_INSTRUCTION;

        console.log(
          `[agent-delegate] enforced=true taskType=${intent.taskType}` +
            ` ok=${result.ok === true} code=${result.code || 'none'}`
        );
      } else {
        forcedDelegationNotice = FORCED_DELEGATION_DENIED_INSTRUCTION;
        console.log('[agent-delegate] enforced=false reason=policy_tool_denied');
      }
    }
  }

  const systemInstructions = [instruction, forcedDelegationNotice]
    .filter(Boolean)
    .join('\n\n');

  if (systemInstructions) {
    const insertAt = conversation[0] && conversation[0].role === 'system' ? 1 : 0;
    conversation.splice(insertAt, 0, {
      role: 'system',
      content: systemInstructions,
    });
  }

  // 已由运行时派发后不再把 delegate_to_bot 暴露给模型，避免同一任务被重复提交。
  const requestSpecs = forcedDelegationDispatched
    ? specs.filter(spec => spec.function.name !== 'delegate_to_bot')
    : specs;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (typeof isClientGone === 'function' && isClientGone()) {
      stopReason = 'client_gone';
      break;
    }
    if (Date.now() - startedAt > maxTotalMs) {
      stopReason = 'total_time_budget';
      break;
    }

    const toolBudgetReached = toolCallCount >= maxToolCalls;
    const isFinalRound = round === maxRounds || toolBudgetReached;

    rounds = round;
    const requestToolCount = isFinalRound ? 0 : requestSpecs.length;
    const requestToolNames = isFinalRound
      ? ''
      : requestSpecs.map(spec => spec.function.name).join(',');

    // 记录实际请求元数据：不记录 messages、工具参数或用户内容。
    console.log(
      `[agent-request] round=${round}/${maxRounds} provider=${providerId}` +
        ` model=${modelId} toolCount=${requestToolCount}` +
        ` toolNames=${requestToolNames || 'none'}`
    );

    // 在真正调用提供方之前，把实际要发送的消息交给调用方记录 sent 证据。
    if (typeof onRequest === 'function') {
      try {
        onRequest({
          round,
          messages: conversation,
          toolsCount: requestToolCount,
        });
      } catch (_) {
        /* trace 回调失败不影响聊天 */
      }
    }

    const remainingMs = Math.max(1000, maxTotalMs - (Date.now() - startedAt));
    const completionRequest = {
      providerId,
      modelId,
      messages: conversation,
      temperature,
      maxTokens,
      timeout: Math.min(timeout, remainingMs),
      monitoringRound: round,
      credentialKey,
      signal: abortSignal,
      stream,
      // 末轮/预算耗尽轮强制无 tools：模型只能产出文本，从结构上终结循环。
      // requestSpecs 为空时也不下发空数组，避免部分服务商拒绝 tools: []。
      ...(!isFinalRound && requestToolCount
        ? { tools: requestSpecs, tool_choice: 'auto' }
        : {}),
    };
    completion = await createChatCompletion(completionRequest);
    if (stream) {
      completion = await consumeCompletionStream(completion, onDelta);
    }
    addUsage(completion && completion.usage);

    const message =
      completion &&
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message;

    const toolCalls =
      message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const finishReason =
      completion &&
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].finish_reason
        ? completion.choices[0].finish_reason
        : null;

    // 只记录 finish_reason 与工具调用数量；不记录模型正文或参数。
    console.log(
      `[agent-response] round=${round} provider=${providerId} model=${modelId}` +
        ` finishReason=${finishReason || 'null'} toolCalls=${toolCalls.length}`
    );

    monitoring.recordAgentRound({
      round,
      finishReason,
      toolCalls: toolCalls.length,
    });

    // F3 修复：message 可能为 undefined（服务商返回空 choices / 缺 message
    // 等畸形响应）。与普通路径的 completion.choices?.[0]?.message?.content
    // 保持一致的可选链降级——收不到内容时按"无有效内容"可控结束，
    // 不向路由层抛 TypeError。
    if (!toolCalls.length) {
      rawReply =
        message && typeof message.content === 'string' ? message.content : '';
      if (toolBudgetReached) stopReason = 'tool_call_budget';
      break;
    }

    if (isFinalRound) {
      // 末轮本就未带 tools；防御：仍返回 tool_calls 时只收文本，不进下一轮
      rawReply =
        message && typeof message.content === 'string' ? message.content : '';
      if (toolBudgetReached) stopReason = 'tool_call_budget';
      break;
    }

    // F2 修复：一次归一化。模型不给 id 时 normalizeToolCall 会生成随机 id，
    // 若在 assistant 消息与 tool 循环里各归一化一次，两边 id 对不上号
    // （次轮请求会被服务商以 400 拒绝）。这里只生成一次，两边共用。
    const normalizedCalls = toolCalls.map(normalizeToolCall);
    // 预算只允许执行剩余数量的调用；未执行的调用不能写进 assistant 消息，
    // 否则下一轮会缺少对应的 tool 结果，部分服务商会直接以 400 拒绝。
    const remainingToolCalls = Math.max(0, maxToolCalls - toolCallCount);
    const executableCalls = normalizedCalls.slice(0, remainingToolCalls);
    const budgetTruncated = executableCalls.length < normalizedCalls.length;

    // 追加 assistant tool_calls 消息（仅请求内存）：后续轮次需要读到
    // 完整的调用记录，否则模型会重复发起相同调用。
    conversation.push(
      tagModelMessage(
        {
          role: 'assistant',
          content: message.content == null ? null : message.content,
          tool_calls: executableCalls,
        },
        `assistant-tool-call:${round}`
      )
    );

    let batchStopReason = null;

    for (const normalized of executableCalls) {
      if (typeof isClientGone === 'function' && isClientGone()) {
        batchStopReason = 'client_gone';
        break;
      }
      if (Date.now() - startedAt > maxTotalMs) {
        batchStopReason = 'total_time_budget';
        break;
      }
      if (toolCallCount >= maxToolCalls) {
        batchStopReason = 'tool_call_budget';
        break;
      }

      await performToolCall(normalized, round);

      if (consecutiveFailures >= 2) {
        batchStopReason = 'repeated_tool_failure';
        break;
      }
    }

    if (budgetTruncated && !batchStopReason) {
      batchStopReason = 'tool_call_budget';
    }

    if (batchStopReason) {
      stopReason = batchStopReason;
      // 预算耗尽不是终点：保留一次无工具收尾轮，让模型基于已取回的工具结果
      // 生成最终答复。其它停止原因（断连、总时长、连续工具失败）仍立即结束。
      if (batchStopReason === 'tool_call_budget' && round < maxRounds) {
        continue;
      }
      break;
    }

    // 已执行完成的工具不回滚，但断连后不再消耗下一轮模型调用
    if (typeof isClientGone === 'function' && isClientGone()) {
      stopReason = 'client_gone';
      break;
    }
  }

  // 轮次上限按本次 policy 的 maxRounds 判定：循环用的就是它。拿全局
  // MAX_ROUNDS 比较，会把「按策略收敛后跑满」报成「没到轮次上限」，
  // 监控口径与真实行为对不上。
  const reachedMaxRounds = rounds >= maxRounds;
  const clientGone = typeof isClientGone === 'function' && isClientGone();

  monitoring.recordAgentRun({
    status: clientGone ? 'cancelled' : rawReply ? 'success' : 'failed',
    rounds,
    toolCount: toolSteps.length,
    maxRounds,
    reachedMaxRounds,
    clientGone,
  });

  return {
    rawReply,
    toolSteps,
    rounds,
    maxRounds,
    completion,
    stopReason,
    toolCallCount,
    readOnlyRetries,
    reachedMaxRounds,
    delegationEnforced: forcedDelegationDispatched,
    usage: usageTotals,
  };
}

function listToolRegistry() {
  return [...tools.values()].map(def => ({
    name: def.name,
    description: def.description,
    read_only: def.readOnly === true,
    side_effect: def.readOnly === false,
    timeout_ms:
      Number.isFinite(def.timeoutMs) && def.timeoutMs > 0
        ? def.timeoutMs
        : TOOL_TIMEOUT_DEFAULT,
    registered: true,
  }));
}

module.exports = {
  MAX_ROUNDS,
  TOOL_TIMEOUT_DEFAULT,
  TOOL_RESULT_MAX,
  registerTool,
  unregisterTool,
  listToolSpecs,
  listToolMetadata,
  listToolRegistry,
  agentToolsEnabled,
  noteSwitchObservation,
  runAgentTurn,
  executeToolCall,
};
