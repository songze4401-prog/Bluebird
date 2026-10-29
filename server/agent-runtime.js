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

const { createChatCompletion } = require('./model-adapter');
const monitoring = require('./monitoring');
const memorySearchTool = require('./tool-memory-search');
const memoryRememberTool = require('./tool-memory-remember');
const { truncateText } = require('./text-utils');

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

  tools.set(name, definition);
}

function unregisterTool(name) {
  tools.delete(String(name || ''));
}

function supportsTool(name) {
  return tools.has(String(name || ''));
}

// 转成 OpenAI Chat Completions 的 tools 入参格式。
function listToolSpecs() {
  return [...tools.values()].map(def => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));
}

// 启动即注册记忆只读检索与受控写入工具。
registerTool(memorySearchTool.definition);
registerTool(memoryRememberTool.definition);

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
async function executeToolCall(name, rawArgs, context) {
  const def = tools.get(String(name || ''));
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

  // 同请求去重：同工具 + 同规范化参数直接复用上次结果
  const dedupeKey = `${def.name}|${stableStringify(validated.args)}`;
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

  const timeoutMs =
    Number.isFinite(def.timeoutMs) && def.timeoutMs > 0
      ? def.timeoutMs
      : TOOL_TIMEOUT_DEFAULT;

  const controller = new AbortController();

  // 外部中止（客户端断连）：立即传播给 handler，尽早停止后台工作
  const externalSignal = context && context.abortSignal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), {
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
      def.handler(validated.args, {
        sessionId: context.sessionId,
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
      monitor.complete({
        ok: false,
        code: result.code,
        durationMs: Date.now() - startedAt,
        executed: true,
      });
      return result;
    }
    const result = remember({ ok: false, code: 'tool_error', error: '工具内部错误' });
    monitor.complete({
      ok: false,
      code: result.code,
      durationMs: Date.now() - startedAt,
      executed: true,
    });
    return result;
  } finally {
    if (timer) clearTimeout(timer);
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
 * 返回 { rawReply, toolSteps, rounds, completion }：
 *   rawReply    最终文本（交 completeChatTurn 清洗落盘）
 *   toolSteps   工具执行摘要数组（独立字段，禁敏感内容）
 *   rounds      实际模型调用轮数
 *   completion  末轮 completion（调用方取 model 回执）；断连未调用时为 null
 */
async function runAgentTurn({
  providerId,
  modelId,
  messages,
  sessionId,
  userText = '',
  userMessageId = null,
  temperature = 0.8,
  maxTokens = 1200,
  timeout = 90000,
  isClientGone,
  abortSignal,
  onToolEvent,
  onRequest,
}) {
  logSwitchIfChanged();

  const specs = listToolSpecs();
  // 请求内上下文：中间轮 tool_calls / tool 消息只在这里，随请求消亡，
  // 绝不写入 sessions.json（落盘由调用方只收最终消息）。
  const conversation = messages.map(message => ({ ...message }));
  const toolSteps = [];
  const cache = new Map();

  let completion = null;
  let rawReply = '';
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    // 断连：绝不发起下一轮模型调用
    if (typeof isClientGone === 'function' && isClientGone()) break;

    rounds = round;
    const isFinalRound = round === MAX_ROUNDS;
    const requestToolCount = isFinalRound ? 0 : specs.length;
    const requestToolNames = isFinalRound
      ? ''
      : specs.map(spec => spec.function.name).join(',');

    // 记录实际请求元数据：不记录 messages、工具参数或用户内容。
    console.log(
      `[agent-request] round=${round}/${MAX_ROUNDS} provider=${providerId}` +
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

    completion = await createChatCompletion({
      providerId,
      modelId,
      messages: conversation,
      temperature,
      maxTokens,
      timeout,
      monitoringRound: round,
      // 末轮强制无 tools：模型只能产出文本，从结构上终结循环
      ...(isFinalRound ? {} : { tools: specs, tool_choice: 'auto' }),
    });

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
      break;
    }

    if (isFinalRound) {
      // 末轮本就未带 tools；防御：仍返回 tool_calls 时只收文本，不进下一轮
      rawReply =
        message && typeof message.content === 'string' ? message.content : '';
      break;
    }

    // F2 修复：一次归一化。模型不给 id 时 normalizeToolCall 会生成随机 id，
    // 若在 assistant 消息与 tool 循环里各归一化一次，两边 id 对不上号
    // （次轮请求会被服务商以 400 拒绝）。这里只生成一次，两边共用。
    const normalizedCalls = toolCalls.map(normalizeToolCall);

    // 追加 assistant tool_calls 消息（仅请求内存）：后续轮次需要读到
    // 完整的调用记录，否则模型会重复发起相同调用。
    conversation.push(
      tagModelMessage(
        {
          role: 'assistant',
          content: message.content == null ? null : message.content,
          tool_calls: normalizedCalls,
        },
        `assistant-tool-call:${round}`
      )
    );

    for (const normalized of normalizedCalls) {
      const startedAt = Date.now();

      if (typeof onToolEvent === 'function') {
        onToolEvent({
          type: 'tool_start',
          name: normalized.function.name,
          callId: normalized.id,
        });
      }

      let rawArgs = null;
      try {
        rawArgs = JSON.parse(normalized.function.arguments || '{}');
      } catch (_) {
        rawArgs = null;
      }

      console.log(
        `[agent-dispatch] round=${round} name=${normalized.function.name} dispatched=true`
      );

      const result = await executeToolCall(normalized.function.name, rawArgs, {
        sessionId,
        userText,
        userMessageId,
        cache,
        abortSignal,
        round,
      });

      const summary = buildToolSummary(result);

      console.log(
        `[agent-tool] round=${round} name=${normalized.function.name}` +
          ` ok=${result.ok === true} code=${result.code || 'none'}` +
          ` deduped=${result.deduped === true} durationMs=${Date.now() - startedAt}`
      );

      if (typeof onToolEvent === 'function') {
        onToolEvent({
          type: 'tool_end',
          name: normalized.function.name,
          callId: normalized.id,
          ok: result.ok === true,
          ...(result.code ? { code: result.code } : {}),
          ...(result.deduped ? { deduped: true } : {}),
          summary,
        });
      }

      toolSteps.push({
        name: normalized.function.name,
        ok: result.ok === true,
        summary: truncateText(summary, 120),
        durationMs: Date.now() - startedAt,
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

      console.log(
        `[agent-result] round=${round} name=${normalized.function.name} forwarded=true`
      );
    }

    // 已执行完成的工具不回滚，但断连后不再消耗下一轮模型调用
    if (typeof isClientGone === 'function' && isClientGone()) break;
  }

  const reachedMaxRounds = rounds >= MAX_ROUNDS;
  const clientGone = typeof isClientGone === 'function' && isClientGone();

  monitoring.recordAgentRun({
    status: clientGone ? 'cancelled' : rawReply ? 'success' : 'failed',
    rounds,
    toolCount: toolSteps.length,
    maxRounds: MAX_ROUNDS,
    reachedMaxRounds,
    clientGone,
  });

  return { rawReply, toolSteps, rounds, completion, reachedMaxRounds };
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
  supportsTool,
  listToolSpecs,
  listToolRegistry,
  agentToolsEnabled,
  noteSwitchObservation,
  runAgentTurn,
  executeToolCall,
};
