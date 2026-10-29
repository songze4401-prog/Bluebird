/**
 * 云岫 Bluebird — Context Runtime v3 输入保护（input-guard.js）
 *
 * 唯一职责：保证最终发往模型的请求适配真实模型能力，不负责按来源类别配额
 * 决定信息价值。计量口径：
 *
 * - 优先使用模型声明的 contextWindow（model.contextWindow）；
 * - 未声明时 windowSource = 'unknown_guard'，使用配置的保守护栏值，
 *   明确标注"不是模型真实窗口"，不编造能力；
 * - token 估算使用 cross-module 统一的 heuristic-cjk-ascii-v1（CJK 1 / ASCII 0.25 /
 *   其他 Unicode 0.5），并按 estimatorSafetyFactor 放大；误差范围在 trace 中明示；
 * - 图片不按 dataURL 字符计数，按 perImageTokens 保守计。
 *
 * 超限时确定性降级顺序（每一步都记录 dropped 原因）：
 *   1) 低优先级上下文块（记忆 → 召回 → 摘要 → 表情/情绪/人格等非关键系统块）
 *   2) 较早历史消息（保留最近 minHistoryMessages 条完整消息）
 *   3) 仍超限 → 显式失败，绝不静默截断当前任务或核心安全规则。
 */
const { config: defaultConfig } = require('./config');
const { estimateTokens, describeMessageContent } = require('./text');
const { modelMessageId, tagModelMessage } = require('./projection');

function renderSystem(blocks) {
  return blocks
    .filter(block => block && block.text)
    .map(block => block.text)
    .join('\n\n');
}

function measureMessage(message, config) {
  const { text, imageCount, hasUnsupportedBlock } = describeMessageContent(
    message && message.content
  );
  return {
    text,
    imageCount,
    hasUnsupportedBlock,
    tokens:
      estimateTokens(text) +
      imageCount * config.inputGuard.perImageTokens +
      config.inputGuard.perMessageOverheadTokens,
  };
}

function measureRequest({
  systemBlocks = [],
  historyMessages = [],
  currentMessage = null,
  toolsReserveTokens = 0,
  model = {},
  config = defaultConfig,
}) {
  const guard = config.inputGuard;
  const systemPrompt = renderSystem(systemBlocks);
  const systemTokens = estimateTokens(systemPrompt);
  const history = historyMessages.map(message => measureMessage(message, config));
  const current = currentMessage ? measureMessage(currentMessage, config) : null;

  const rawInputTokens =
    systemTokens +
    history.reduce((sum, item) => sum + item.tokens, 0) +
    (current ? current.tokens : 0);

  const estimatedInputTokens = Math.ceil(rawInputTokens * guard.estimatorSafetyFactor);
  const declaredWindow = Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? Math.floor(model.contextWindow)
    : null;
  const windowTokens = declaredWindow || guard.unknownWindowGuardTokens;
  const reserved = guard.outputReserveTokens + toolsReserveTokens + guard.safetyMarginTokens;
  const safeInputTokens = windowTokens - reserved;

  return {
    estimator: 'heuristic-cjk-ascii-v1',
    estimatorErrorRange: 'CJK≈1/字，ASCII≈0.25/字符；未校准目标模型 tokenizer，按 1.25 保守放大',
    safetyFactor: guard.estimatorSafetyFactor,
    window: {
      tokens: windowTokens,
      source: declaredWindow ? 'declared' : 'unknown_guard',
      verified: Boolean(declaredWindow),
    },
    outputReserveTokens: guard.outputReserveTokens,
    toolsReserveTokens,
    safetyMarginTokens: guard.safetyMarginTokens,
    systemTokens,
    historyTokens: history.reduce((sum, item) => sum + item.tokens, 0),
    currentTokens: current ? current.tokens : 0,
    rawInputTokens,
    estimatedInputTokens,
    reservedTokens: reserved,
    safeInputTokens,
    totalRequiredTokens: estimatedInputTokens + reserved,
    fits: estimatedInputTokens <= safeInputTokens,
    history: history.map((item, index) => ({
      index,
      tokens: item.tokens,
      imageCount: item.imageCount,
      hasUnsupportedBlock: item.hasUnsupportedBlock,
    })),
    current: current
      ? { tokens: current.tokens, imageCount: current.imageCount, hasUnsupportedBlock: current.hasUnsupportedBlock }
      : null,
  };
}

function fitRequest({
  systemBlocks = [],
  contextBlocks = [],
  historyMessages = [],
  currentMessage = null,
  toolsReserveTokens = 0,
  model = {},
  config = defaultConfig,
} = {}) {
  const guard = config.inputGuard;
  let baseBlocks = systemBlocks.slice();
  let extraBlocks = contextBlocks.slice();
  let history = historyMessages.slice();
  const dropped = [];

  const evaluate = () => {
    const blocks = [...baseBlocks, ...extraBlocks].filter(block => block && block.text);
    const systemPrompt = renderSystem(blocks);
    const measurement = measureRequest({
      systemBlocks: blocks,
      historyMessages: history,
      currentMessage,
      toolsReserveTokens,
      model,
      config,
    });
    return { blocks, systemPrompt, measurement };
  };

  let state = evaluate();

  const dropLowest = (collection) => {
    if (!collection.length) return false;
    let index = 0;
    for (let i = 1; i < collection.length; i += 1) {
      if ((collection[i].priority || 0) < (collection[index].priority || 0)) index = i;
    }
    const [removed] = collection.splice(index, 1);
    dropped.push({
      id: removed.id,
      kind: removed.kind || 'block',
      stage: 'injected',
      reason: 'input_guard_trim',
      priority: removed.priority || 0,
    });
    return true;
  };

  // 先裁上下文块，再裁非关键系统块；核心系统块永远不裁。
  while (!state.measurement.fits) {
    if (dropLowest(extraBlocks)) {
      state = evaluate();
      continue;
    }
    const optionalBase = baseBlocks.filter(block => block.critical === false);
    if (optionalBase.length) {
      dropLowest(baseBlocks.filter(block => block.critical === false));
      // dropLowest 作用在临时数组上：按 id 从真实数组移除
      const removedId = dropped[dropped.length - 1].id;
      baseBlocks = baseBlocks.filter(block => block.id !== removedId || block.critical !== false);
      state = evaluate();
      continue;
    }
    break;
  }

  // 仍超限：从最旧历史开始丢弃，保留最近 minHistoryMessages 条完整消息。
  while (!state.measurement.fits && history.length > guard.minHistoryMessages) {
    const removed = history.shift();
    dropped.push({
      id: modelMessageId(removed),
      kind: 'history',
      stage: 'injected',
      reason: 'input_guard_trim_oldest_history',
    });
    state = evaluate();
  }

  if (!state.measurement.fits) {
    return {
      ok: false,
      errorCode: 'context_too_large',
      error:
        `输入超过安全上限：估算输入 ${state.measurement.estimatedInputTokens} + ` +
        `预留 ${state.measurement.reservedTokens} > 窗口 ${state.measurement.window.tokens}` +
        `（windowSource=${state.measurement.window.source}）`,
      systemPrompt: state.systemPrompt,
      messages: [],
      historyMessages: history,
      measurement: state.measurement,
      dropped,
      injectedMessageIds: [],
      injectedContextIds: [],
      keptBaseBlockIds: baseBlocks.map(block => block.id),
    };
  }

  const injectedContextIds = extraBlocks
    .filter(block => block && block.text)
    .flatMap(block => block.itemIds || []);

  history.forEach((message, index) => {
    if (!modelMessageId(message)) {
      tagModelMessage(message, `history:${index}`);
    }
  });
  if (currentMessage && !modelMessageId(currentMessage)) {
    tagModelMessage(currentMessage, 'current-user');
  }

  const injectedMessageIds = [
    ...history.map(message => modelMessageId(message)).filter(Boolean),
    ...(currentMessage ? [modelMessageId(currentMessage)] : []),
  ];

  const messages = [
    { role: 'system', content: state.systemPrompt },
    ...history,
    ...(currentMessage ? [currentMessage] : []),
  ];

  return {
    ok: true,
    errorCode: null,
    error: null,
    systemPrompt: state.systemPrompt,
    messages,
    historyMessages: history,
    measurement: state.measurement,
    dropped,
    injectedMessageIds,
    injectedContextIds,
    keptBaseBlockIds: baseBlocks.map(block => block.id),
  };
}

module.exports = {
  fitRequest,
  measureRequest,
  renderSystem,
};
