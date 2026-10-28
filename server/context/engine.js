/**
 * 云岫 Bluebird — Context Runtime v3 单一调用链（engine.js）
 *
 * 读取会话与当前输入 → 选择近期原文 → 长程召回 → 抽取式摘要 →
 * 记忆检索与覆盖/冲突裁决 → 安全渲染 → 输入保护 → 输出真实请求。
 *
 * 这是唯一上下文链路：不再有 softTarget/perTypeMax/固定保底预算，
 * 也不再有“开关关闭时走另一套 20 条历史”的双路径。
 *
 * 降级边界：
 * - 记忆检索失败：记录错误，继续用历史/摘要，不影响聊天；
 * - 摘要失败：记录错误，保留近期原文与召回原文，原始消息不删除；
 * - 输入超限：显式返回 context_too_large，绝不静默截断当前任务或核心规则。
 */
const { config: defaultConfig } = require('./config');
const { selectHistory } = require('./history');
const { buildHistorySummary } = require('./summary');
const { retrieveMemory } = require('./retriever');
const { buildContext } = require('./builder');
const { fitRequest } = require('./input-guard');
const { createTrace } = require('./trace');

function verifyContext({ selection, summary, build, fit }) {
  const checks = [];

  const expiredEntered = build.memory.accepted.some(
    item =>
      item.freshness &&
      item.freshness.status === 'expired' &&
      item.type === 'realtime_data'
  );
  checks.push({ ok: !expiredEntered, rule: 'no_expired_realtime_in_context' });

  const recentIds = new Set(selection.recent.map(entry => entry.message.id).filter(Boolean));
  const duplicateRecall = selection.recalled.some(entry =>
    recentIds.has(entry.message.id)
  );
  checks.push({ ok: !duplicateRecall, rule: 'no_recent_recalled_duplicate' });

  const blockItemIds = new Set(
    (build.blocks || []).flatMap(block => block.itemIds || [])
  );
  const injectedContextValid = (fit.injectedContextIds || []).every(id =>
    blockItemIds.has(id)
  );
  checks.push({ ok: injectedContextValid, rule: 'injected_context_ids_subset_of_blocks' });

  const summaryIds = new Set(
    (summary && summary.sources ? summary.sources : []).map(source => source.messageId)
  );
  const summaryDecisions = new Set(
    (selection.decisions || [])
      .filter(item => item.stage === 'summarized')
      .map(item => item.messageId)
  );
  const summaryTraceable = [...summaryIds].every(id => summaryDecisions.has(id));
  checks.push({ ok: summaryTraceable, rule: 'summary_sources_traceable' });

  // 实际注入标识数必须等于真实请求中的非 system 消息数（历史 + 当前任务）。
  // 具体 ID 集合与 sent trace 的一致性由集成测试逐项比较。
  const nonSystemCount = fit.messages.filter(message => message.role !== 'system').length;
  checks.push({
    ok: fit.injectedMessageIds.length === nonSystemCount,
    rule: 'injected_messages_match_request_messages',
  });

  const failed = checks.filter(check => !check.ok);
  return {
    ok: failed.length === 0,
    reason: failed.length
      ? failed.map(check => check.rule).join(', ')
      : '全部验证通过',
    checks,
    windowVerified: Boolean(
      fit.measurement && fit.measurement.window && fit.measurement.window.verified
    ),
  };
}

async function runContextRuntime({
  task = '',
  sessionId = null,
  projectedMessages = [],
  renderMessage,
  renderFinalMessage,
  systemBlocks = [],
  currentMessage = null,
  model = {},
  toolsReserveTokens = 0,
  injected = {},
  config = defaultConfig,
  now = Date.now(),
} = {}) {
  const trace = createTrace({ task, sessionId });
  const guard = config.inputGuard;

  const selection = selectHistory({
    messages: projectedMessages,
    query: task,
    render: renderMessage,
    config,
    perImageTokens: guard.perImageTokens,
    overheadTokens: guard.perMessageOverheadTokens,
  });

  // 选择阶段用占位图片估算；只对真正进入近期窗口的消息读取真实图片。
  if (typeof renderFinalMessage === 'function') {
    selection.recent = selection.recent.map(entry => {
      let modelMessage = entry.modelMessage;
      try {
        modelMessage = renderFinalMessage(entry.message) || entry.modelMessage;
      } catch (_) {
        modelMessage = entry.modelMessage;
      }
      return { ...entry, modelMessage };
    });
  }

  let summary;
  try {
    summary = buildHistorySummary(selection.summaryInput, { config });
  } catch (error) {
    summary = {
      ok: false,
      rendered: '',
      sources: [],
      conflicts: [],
      count: 0,
      error: error && error.message ? error.message : '摘要生成失败',
    };
  }
  trace.recordHistory(selection, summary);

  let retrieval;
  try {
    retrieval = await retrieveMemory({ task, sessionId, injected, config, now });
  } catch (error) {
    retrieval = {
      status: 'retrieval_error',
      count: 0,
      items: [],
      error: error && error.message ? error.message : '记忆检索异常',
    };
  }

  const build = buildContext({
    recent: selection.recent,
    recalled: selection.recalled,
    summary,
    memoryItems: retrieval.items || [],
    config,
  });

  trace.recordRetrieval(retrieval, build.memory);

  const fit = fitRequest({
    systemBlocks,
    contextBlocks: build.blocks,
    historyMessages: selection.recent.map(entry => entry.modelMessage),
    currentMessage,
    toolsReserveTokens,
    model,
    config,
  });

  trace.recordStages({
    candidate: (selection.tokens.totalMessages || 0) + (retrieval.count || 0),
    selected:
      selection.recent.length +
      selection.recalled.length +
      (summary.sources ? summary.sources.length : 0) +
      (retrieval.count || 0),
    accepted:
      selection.recent.length +
      selection.recalled.length +
      (summary.sources ? summary.sources.length : 0) +
      build.memory.accepted.length +
      (currentMessage ? 1 : 0),
  });
  trace.recordBuild(build, fit);

  if (!fit.ok) {
    const verification = {
      ok: false,
      reason: fit.errorCode || 'context_too_large',
      checks: [{ ok: false, rule: fit.errorCode || 'context_too_large' }],
      windowVerified: false,
    };
    trace.recordVerification(verification);
    return {
      ok: false,
      errorCode: fit.errorCode,
      error: fit.error,
      systemPrompt: fit.systemPrompt,
      messages: [],
      historyMessages: fit.historyMessages,
      measurement: fit.measurement,
      dropped: fit.dropped,
      contextIds: [],
      summary,
      memory: build.memory,
      trace: trace.toJSON(),
      traceApi: trace,
    };
  }

  const verification = verifyContext({
    selection,
    summary,
    build,
    fit,
  });
  trace.recordVerification(verification);

  // 摘要错误是非致命降级；验证只覆盖进入上下文的实际内容。
  const summaryWarning = summary.ok === false ? summary.error : null;

  return {
    ok: verification.ok,
    error: verification.ok ? null : `上下文验证失败：${verification.reason}`,
    errorCode: verification.ok ? null : 'context_verification_failed',
    systemPrompt: fit.systemPrompt,
    messages: fit.messages,
    historyMessages: fit.historyMessages,
    measurement: fit.measurement,
    dropped: fit.dropped,
    contextIds: fit.injectedContextIds,
    injectedMessageIds: fit.injectedMessageIds,
    summary: {
      count: summary.count || 0,
      sources: summary.sources || [],
      conflicts: summary.conflicts || [],
      warning: summaryWarning,
    },
    memory: build.memory,
    verification,
    trace: trace.toJSON(),
    traceApi: trace,
  };
}

module.exports = {
  runContextRuntime,
  verifyContext,
};
