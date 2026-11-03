/**
 * 云岫 Bluebird — P3 上下文调度器（纯函数）
 *
 * 每轮先判断意图，再决定加载哪些层、每层预算与无答案阈值；不调用模型。
 * 目标不是“把所有记忆/知识都塞进去”，而是让检索量、token 成本与当前任务
 * 匹配；无法判断时退回 general（保持既有全量行为）。
 */
const INTENTS = Object.freeze({
  CHITCHAT: 'chitchat',
  MEMORY_QUERY: 'memory_query',
  FACT_QUERY: 'fact_query',
  PROJECT_WORK: 'project_work',
  PLANNING: 'planning',
  EXECUTION: 'execution',
  REVIEW: 'review',
  GENERAL: 'general',
});

const MEMORY_QUERY_RE =
  /(记得|说过|提过|回忆|我叫什么|我是谁|我的(名字|偏好|生日|目标|喜欢|讨厌|计划)|我喜欢.*(什么|哪)|我.*(喜欢|偏好).*(什么|哪)|查一下.*记忆|记忆.*(什么|哪))/;
const GREETING_RE =
  /^(你好|您好|hi|hello|hey|嗨|在吗|谢谢|多谢|晚安|早安|早上好|晚上好|辛苦了|没事|好的|嗯+|哦+|哈哈|再见|拜拜)[！!。.\s，,~～]*$/i;
const PLANNING_RE = /(计划|规划|路线|步骤|安排|下一步|优先级|怎么做|如何做|实施方案)/;
const REVIEW_RE = /(复盘|回顾|总结|审计|检查|评估|对比|风险|问题清单)/;
const EXECUTION_RE =
  /(执行|实现|修复|修一下|跑一下|运行|提交|部署|构建|测试一下|改一下|处理)/;
const PROJECT_RE =
  /(项目|代码|仓库|架构|接口|bug|模块|重构|迁移|上线|部署|测试|方案)/;
const FACT_IDENTITY_RE = /(是什么|什么是|多少|哪个|哪些|谁)/;
const FACT_QUERY_RE =
  /(是什么|什么是|为什么|怎么|如何|多少|哪个|哪些|哪里|谁|查询|查一下|资料|知识|介绍|解释|区别|吗[？?]?\s*$)/;

function classifyIntent(task) {
  const text = String(task || '').trim();

  if (!text) return INTENTS.GENERAL;
  if (MEMORY_QUERY_RE.test(text)) return INTENTS.MEMORY_QUERY;
  if (GREETING_RE.test(text)) return INTENTS.CHITCHAT;
  if (PLANNING_RE.test(text)) return INTENTS.PLANNING;
  if (REVIEW_RE.test(text)) return INTENTS.REVIEW;
  if (EXECUTION_RE.test(text)) return INTENTS.EXECUTION;
  if (FACT_IDENTITY_RE.test(text)) return INTENTS.FACT_QUERY;
  if (PROJECT_RE.test(text)) return INTENTS.PROJECT_WORK;
  if (FACT_QUERY_RE.test(text)) return INTENTS.FACT_QUERY;

  return INTENTS.GENERAL;
}

function getEnabled(env = process.env) {
  const raw = String(env.BLUEBIRD_CONTEXT_ORCHESTRATOR || '1')
    .trim()
    .toLowerCase();

  return !['0', 'false', 'off', 'no'].includes(raw);
}

function layers(overrides = {}) {
  return {
    history: true,
    summary: true,
    memory: true,
    knowledge: true,
    memoryTypes: null,
    memoryCategories: null,
    episodicOnly: false,
    knowledgeSources: null,
    ...overrides,
  };
}

function planForIntent(intent) {
  switch (intent) {
    case INTENTS.CHITCHAT:
      return {
        intent,
        layers: layers({
          summary: false,
          memory: false,
          knowledge: false,
          memoryTypes: [],
          knowledgeSources: [],
        }),
        budgets: {
          history: {
            recentBudgetTokens: 2400,
            longRangeMaxItems: 0,
            summaryBudgetTokens: 0,
          },
          retrieval: {},
          knowledge: {},
        },
        noAnswerThreshold: 1,
        reasons: ['small_talk', 'memory_disabled', 'knowledge_disabled'],
      };
    case INTENTS.MEMORY_QUERY:
      return {
        intent,
        layers: layers({ knowledge: false, knowledgeSources: [] }),
        budgets: {
          history: {
            recentBudgetTokens: 3200,
            longRangeMaxItems: 6,
            summaryBudgetTokens: 800,
          },
          retrieval: {
            memoryMaxItems: 8,
            memoryPerItemMax: 300,
            memoryTotalMax: 1600,
          },
          knowledge: {},
        },
        noAnswerThreshold: 0.04,
        reasons: ['user_memory_lookup', 'knowledge_disabled', 'memory_budget_8'],
      };
    case INTENTS.FACT_QUERY:
      return {
        intent,
        layers: layers({
          knowledgeSources: ['document', 'web'],
        }),
        budgets: {
          history: { recentBudgetTokens: 3200 },
          retrieval: { memoryMaxItems: 8, memoryTotalMax: 1600 },
          knowledge: { limit: 4, tokenBudget: 900, timeoutMs: 900 },
        },
        noAnswerThreshold: 0.08,
        reasons: ['fact_lookup', 'document_web_knowledge', 'threshold_0.08'],
      };
    case INTENTS.PROJECT_WORK:
    case INTENTS.EXECUTION:
      return {
        intent,
        layers: layers({
          memoryTypes: ['fact', 'goal', 'identity', 'preference'],
          knowledgeSources: ['document', 'code'],
        }),
        budgets: {
          history: { recentBudgetTokens: 3200 },
          retrieval: { memoryMaxItems: 8, memoryTotalMax: 1600 },
          knowledge: { limit: 4, tokenBudget: 900, timeoutMs: 900 },
        },
        noAnswerThreshold: 0.08,
        reasons: [
          intent === INTENTS.EXECUTION ? 'execution_task' : 'project_work',
          'project_semantic_layers',
          'document_code_knowledge',
        ],
      };
    case INTENTS.PLANNING:
      return {
        intent,
        layers: layers({
          memoryTypes: ['fact', 'goal', 'identity', 'preference'],
          knowledgeSources: ['document', 'web'],
        }),
        budgets: {
          history: { recentBudgetTokens: 3200, summaryBudgetTokens: 1000 },
          retrieval: { memoryMaxItems: 8, memoryTotalMax: 1600 },
          knowledge: { limit: 3, tokenBudget: 800, timeoutMs: 900 },
        },
        noAnswerThreshold: 0.08,
        reasons: ['planning', 'project_semantic_layers', 'document_web_knowledge'],
      };
    case INTENTS.REVIEW:
      return {
        intent,
        layers: layers({
          memoryTypes: ['fact', 'goal'],
          episodicOnly: true,
          knowledgeSources: ['document', 'web'],
        }),
        budgets: {
          history: { recentBudgetTokens: 3200, summaryBudgetTokens: 1000 },
          retrieval: { memoryMaxItems: 8, memoryTotalMax: 1600 },
          knowledge: { limit: 3, tokenBudget: 800, timeoutMs: 900 },
        },
        noAnswerThreshold: 0.08,
        reasons: ['review', 'episodic_project_layers', 'document_web_knowledge'],
      };
    default:
      return {
        intent: INTENTS.GENERAL,
        layers: layers(),
        budgets: { history: {}, retrieval: {}, knowledge: {} },
        noAnswerThreshold: 0.04,
        reasons: ['general_default'],
      };
  }
}

function planContext({ task = '', env = process.env } = {}) {
  const enabled = getEnabled(env);

  if (!enabled) {
    return {
      ...planForIntent(INTENTS.GENERAL),
      enabled: false,
      reasons: ['orchestrator_disabled', 'general_default'],
    };
  }

  return {
    ...planForIntent(classifyIntent(task)),
    enabled: true,
  };
}

function applyPlanToConfig(config, plan) {
  const history =
    plan && plan.budgets && plan.budgets.history
      ? { ...config.history, ...plan.budgets.history }
      : config.history;
  const retrieval =
    plan && plan.budgets && plan.budgets.retrieval
      ? { ...config.retrieval, ...plan.budgets.retrieval }
      : config.retrieval;

  return { ...config, history, retrieval };
}

module.exports = {
  INTENTS,
  classifyIntent,
  getEnabled,
  planForIntent,
  planContext,
  applyPlanToConfig,
};
