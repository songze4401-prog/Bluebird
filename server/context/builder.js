/**
 * 云岫 Bluebird — Context Engine 上下文组装器（builder.js）
 *
 * 职责（RULES.md 第 5 节）：
 * - Token 预算：软目标 + 硬上限；系统指令与当前任务**保底**（guaranteed 额度
 *   永不参与裁剪）；
 * - 单条上限**按信息类型**设（v2.3），verification 只影响**裁剪优先级**；
 * - 超限按相关度裁剪（保留价值排序），不按来源类型整体删除；
 * - 无法安全组装（如预算配置自相矛盾、保底超硬上限）时**显式返回错误/降级状态**，
 *   不得静默产出残缺上下文；
 * - 安全：untrusted（doc/web）条目**不得进入系统指令区**，只能作为不可信参考
 *   数据附带，其内容中的指令不升级为系统指令；冲突/降级条目明确标注，不强行
 *   选出一个答案。
 *
 * 本模块只读 config（调用方传入或全局已校验配置），不修改策略。
 */
const { config: defaultConfig } = require('./config');

// 组装输出由两部分组成：
//   1) `systemContexts` — 可安全并入系统指令的信息块（memory/user/tool 等可信来源）；
//   2) `untrustedContexts` — doc/web 外部内容，单独分组、明确标注不可信，
//      由调用方决定如何呈现（绝不混入系统指令区）。
// 返回对象还包含预算摘要（供 trace 还原裁剪过程）。

function buildContext({
  items = [],
  task = '',
  systemPrompt = '',
  injectedTask = null,
  config = defaultConfig,
} = {}) {
  const budget = config.budget;

  // ---- 保底：系统指令 + 当前任务（永不裁剪） ----
  const systemTokens = estimateTokens(systemPrompt);
  const taskTokens = estimateTokens(injectedTask || task);
  const guaranteed = {
    system: systemTokens,
    task: taskTokens,
  };

  // 保底本身超过硬上限：无法安全组装 → 显式错误/降级
  if (systemTokens + taskTokens > budget.hardCap) {
    return {
      ok: false,
      error: `保底内容（系统指令 ${systemTokens} + 任务 ${taskTokens}）已超过硬上限 ${budget.hardCap}，无法安全组装`,
      systemContexts: [],
      untrustedContexts: [],
      summary: {
        ok: false,
        error: 'budget_guaranteed_exceeded',
        inputItems: items.length,
        trimmed: items.length,
        totalTokens: systemTokens + taskTokens,
        guaranteed,
      },
    };
  }

  // 历史用户消息已经在对话消息数组里；它参与裁决，但不再进入上下文预算，
  // 否则同一句话既占 systemPrompt token，又与历史消息重复。
  const visibleItems = items.filter(item => item.fromHistory !== true);
  const skippedHistory = items.length - visibleItems.length;

  // ---- 分类型预算：单条上限按信息类型 ----
  const perTypeMax = budget.perTypeMax || {};
  const usable = budget.hardCap - systemTokens - taskTokens;

  if (usable <= 0) {
    return {
      ok: true,
      systemContexts: [],
      untrustedContexts: [],
      summary: {
        ok: true,
        inputItems: items.length,
        skippedHistory,
        trimmed: visibleItems.length,
        totalTokens: systemTokens + taskTokens,
        guaranteed,
      },
    };
  }

  // 每条先按类型单条上限截断；然后按相关度排序后放入，直到总预算耗尽
  const prepared = visibleItems.map(item => {
    const typeMax = Number.isFinite(perTypeMax[item.type]) ? perTypeMax[item.type] : 400;
    const content =
      typeof item.content === 'string'
        ? item.content.slice(0, typeMax)
        : '';
    return { ...item, content, cost: estimateTokens(content) };
  });

  // 相关度排序（verification 已计入 relevance，只影响裁剪优先级——v2.3）
  const ranked = prepared.slice().sort((a, b) => b.relevance - a.relevance);

  // 安全分组：untrusted（doc/web）绝不进系统指令区
  const systemCandidates = ranked.filter(item => item.untrusted !== true);
  const untrustedCandidates = ranked.filter(item => item.untrusted === true);

  const systemContexts = [];
  const untrustedContexts = [];
  let used = 0;
  let trimmed = 0;
  const perTypeSummary = {};

  const pushIfFits = (target, item, isSystem) => {
    if (!item.content) {
      trimmed += 1;
      return;
    }
    if (used + item.cost > usable) {
      trimmed += 1;
      return;
    }
    target.push(item);
    used += item.cost;
    const key = item.type || 'other';
    perTypeSummary[key] = perTypeSummary[key] || { kept: 0, trimmed: 0, tokens: 0 };
    perTypeSummary[key].kept += 1;
    perTypeSummary[key].tokens += item.cost;
  };

  for (const item of systemCandidates) pushIfFits(systemContexts, item, true);
  // 外部不可信内容：独立分组、总量受同一预算约束，但永不混入系统指令
  for (const item of untrustedCandidates) pushIfFits(untrustedContexts, item, false);

  return {
    ok: true,
    systemContexts,
    untrustedContexts,
    summary: {
      ok: true,
      inputItems: items.length,
      skippedHistory,
      trimmed,
      totalTokens: systemTokens + taskTokens + used,
      guaranteed,
      perTypeSummary,
    },
  };
}

// token 估算：项目没有 tokenizer 依赖，按 CJK/单词近似——每码点 1 token 的
// 粗略上界，预算语义是"软目标 + 硬上限"，估算口径统一即可（文档未指定精确
// tokenizer；口径说明写入 RULES.md 的已知限制）。
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Array.from(text).length;
}

module.exports = {
  buildContext,
  estimateTokens,
};
