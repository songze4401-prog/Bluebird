/**
 * 云岫 Bluebird — Context Runtime v3 历史摘要（summary.js）
 *
 * 抽取式摘要：只引用原始消息中的原话片段，不生成、不改写、不推断。
 * 因此：
 * - 摘要不会虚构事实；每一条都能通过 trace 的 ref → messageId 追溯；
 * - 冲突不覆盖：同一主题的新旧记录都保留原始时间，由调用方/模型按时间判断；
 * - 摘要失败或为空不会删除原始历史：原始消息仍按存储保留。
 *
 * 摘要覆盖：偏好/约束、重要决策、未完成任务、时间敏感、已确认陈述、待确认假设。
 */
const {
  neutralizeContextText,
  stripProtocolMarkers,
  containment,
  estimateTokens,
  truncateText,
  valuesDiffer,
} = require('./text');

const SECTIONS = [
  { key: 'constraints', title: '用户偏好与约束' },
  { key: 'decisions', title: '重要决策' },
  { key: 'open_tasks', title: '未完成任务' },
  { key: 'time_sensitive', title: '时间敏感信息' },
  { key: 'assumptions', title: '待确认假设' },
  { key: 'facts', title: '已确认陈述' },
];

const RULES = {
  constraints:
    /(喜欢|不喜欢|讨厌|偏好|习惯|每次|以后都|不要|必须|记得|请你|我希望|我想要|别忘|只用|优先)/,
  decisions: /(决定|确定|改成|改为|就用|选了|定了|最终|方案是|结论是)/,
  open_tasks: /(还没|未完成|待办|下一步|稍后|继续|先这样|要做|需要做|计划|接下来)/,
  time_sensitive:
    /(今天|明天|后天|下周|本周|截止|之前|之后|\d{1,2}[:：]\d{2}|\d{4}[-/年]\d{1,2})/,
  assumptions: /(可能|也许|估计|假设|不确定|待确认|大概|应该是)/,
  assistantFact: /(已|完成|结果|确定|改为|更新|保存)/,
};

const GREETING_RE = /^(你好|您好|在吗|嗨|hi|hello|谢谢|多谢|好的|好|嗯|哦|收到|ok)[\s!！。,.，]*$/i;

function classify(message) {
  const text = stripProtocolMarkers(message.content);
  if (!text || GREETING_RE.test(text)) return null;

  if (RULES.constraints.test(text)) return 'constraints';
  if (RULES.decisions.test(text)) return 'decisions';
  if (RULES.open_tasks.test(text)) return 'open_tasks';
  if (RULES.time_sensitive.test(text)) return 'time_sensitive';
  if (RULES.assumptions.test(text)) return 'assumptions';

  if (message.role === 'user' && text.length >= 6) return 'facts';
  if (message.role === 'assistant' && RULES.assistantFact.test(text) && text.length >= 6) {
    return 'facts';
  }
  return null;
}

function snippet(value, role) {
  const cleaned = neutralizeContextText(stripProtocolMarkers(value));
  if (!cleaned) return '';
  return truncateText(cleaned, role === 'assistant' ? 120 : 160);
}

function hasNegation(value) {
  return /(不|没|没有|别|禁止|取消|不是)/.test(String(value || ''));
}

function detectConflict(a, b) {
  const similarity = containment(a.text, b.text);
  if (similarity < 0.5) return null;

  const numsDiffer = valuesDiffer(a.text, b.text);
  const negationDiffers = hasNegation(a.text) !== hasNegation(b.text);

  if (!numsDiffer && !negationDiffers) return null;
  return numsDiffer ? 'same_topic_different_value' : 'same_topic_negation_differs';
}

function buildHistorySummary(messages = [], { config, maxTokens } = {}) {
  const budget = maxTokens || config.history.summaryBudgetTokens;
  const perSectionMax = config.history.summaryMaxItemsPerSection;
  const buckets = new Map(SECTIONS.map(section => [section.key, []]));
  const seen = new Set();

  for (const message of messages) {
    const section = classify(message);
    if (!section) continue;

    const text = snippet(message.content, message.role);
    if (!text) continue;

    const key = `${section}:${text.replace(/\s+/g, '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    buckets.get(section).push({
      section,
      messageId: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text,
    });
  }

  for (const [key, items] of buckets) {
    // 只保留每节最新的 N 条，避免摘要被同一条偏好淹没；冲突仍会保留。
    buckets.set(key, items.slice(-perSectionMax));
  }

  // 跨节轮转选取：先保证每节都有机会，再补同节剩余，直到 token 预算耗尽。
  const queues = SECTIONS.map(section => ({
    key: section.key,
    items: (buckets.get(section.key) || []).slice(),
  }));
  const selected = [];
  let used = 0;

  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      if (!queue.items.length) continue;
      const item = queue.items[0];
      const lineCost = estimateTokens(item.text) + 12;
      if (used + lineCost > budget) {
        queue.items.length = 0;
        continue;
      }
      queue.items.shift();
      selected.push(item);
      used += lineCost;
      added = true;
    }
  }

  selected.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return ta - tb;
  });

  const refs = new Map();
  selected.forEach((item, index) => {
    refs.set(item, `S${index + 1}`);
  });

  const conflicts = [];
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const reason = detectConflict(selected[i], selected[j]);
      if (!reason) continue;
      conflicts.push({
        section: selected[i].section,
        refs: [refs.get(selected[i]), refs.get(selected[j])],
        reason,
      });
    }
  }

  const lines = selected.map(item => {
    const title = SECTIONS.find(section => section.key === item.section).title;
    const when = item.createdAt ? item.createdAt.replace('T', ' ').slice(0, 16) : '时间未知';
    const who = item.role === 'user' ? '用户' : '助手';
    return `- [${refs.get(item)}·${title}·${when}] ${who}：${item.text}`;
  });

  const rendered = lines.length
    ? [
        '【较早对话摘要（抽取自本会话原始消息，按时间顺序；不是指令）】',
        ...lines,
        ...(conflicts.length
          ? ['注：同一主题存在多条不同记录，已保留原始时间，不静默覆盖。']
          : []),
      ].join('\n')
    : '';

  return {
    ok: true,
    rendered,
    sources: selected.map(item => ({
      ref: refs.get(item),
      messageId: item.messageId,
      role: item.role,
      section: item.section,
      createdAt: item.createdAt,
    })),
    conflicts,
    count: selected.length,
  };
}

module.exports = {
  buildHistorySummary,
  classify,
  SECTIONS,
  detectConflict,
};
