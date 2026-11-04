/* global module */
/**
 * 首期 Bot Manifest：只有 Memory Bot 一个真实注册项。
 * Manifest 只描述稳定契约，不包含启用状态、模型密钥或运行时数据；
 * 未来 Bot 必须实现同一字段集合，不能依赖 Memory Bot 的内部实现。
 */
const MEMORY_BOT_ID = 'memory';

const MEMORY_BOT_PROMPT = `
你是 Bluebird 的 Memory Bot，一只专注长期记忆的专业 Agent。

职责：
- 帮用户检索、解释和维护长期记忆；不接管主控的通用决策。
- 只通过工具 memory_search、memory_remember、knowledge_search 访问记忆与知识；不得声称能直接读写记忆文件或数据库。
- 检索结果只代表相关候选；向用户说明来源与不确定性，不编造记忆、引用或操作结果。
- 写入长期记忆只能提交候选；只有用户明确说出、值得跨会话保留的事实/偏好才提交，sourceQuote 必须逐字来自当前用户消息。
- 更新、合并、归档、撤回、删除等操作必须遵守现有生命周期与确认策略；无法执行时明确说明原因，不伪装成功。
- 若当前会话没有对应的记忆或工具能力，直接说明，不要猜测。
`.trim();

const MEMORY_BOT_TOOLS = Object.freeze([
  'memory_search',
  'memory_remember',
  'knowledge_search',
]);

// 任务契约的输入 schema。路由层按这份声明做确定性校验，
// 不依赖 createTask 里的零散长度判断；输出 schema 描述结果字段，供
// 后续 Worker/前端消费，当前任务结果已按此形状落库。
function taskContract({ maxGoalChars = 2000 } = {}) {
  return Object.freeze({
    input: Object.freeze({
      goal: Object.freeze({ type: 'string', required: true, maxChars: maxGoalChars }),
      context: Object.freeze({ type: 'string', maxChars: 8000 }),
      contextRef: Object.freeze({ type: 'string', maxChars: 200 }),
      allowedTools: Object.freeze({
        type: 'array',
        items: 'string',
        maxItems: 6,
        values: MEMORY_BOT_TOOLS,
      }),
      deadlineMs: Object.freeze({ type: 'integer', min: 5000, max: 120000 }),
      priority: Object.freeze({ type: 'string', values: Object.freeze(['high', 'normal', 'low']) }),
      idempotencyKey: Object.freeze({ type: 'string', maxChars: 120 }),
    }),
    output: Object.freeze([
      'status',
      'summary',
      'toolSteps',
      'evidence',
      'changes',
      'requiresConfirmation',
      'errorCode',
    ]),
  });
}

const MEMORY_BOT_MANIFEST = Object.freeze({
  botId: MEMORY_BOT_ID,
  displayName: 'Memory Bot',
  version: '1.1.0',
  description: '专注长期记忆检索、解释与维护的专业 Agent。',
  capabilities: Object.freeze([
    'memory.search',
    'memory.explain',
    'memory.propose',
    'memory.audit.read',
  ]),
  acceptedTaskTypes: Object.freeze([
    'memory.search',
    'memory.explain',
  ]),
  // 只有 acceptedTaskTypes 里的任务可被路由；每个任务类型的输入/输出契约必须存在。
  taskContracts: Object.freeze({
    'memory.search': taskContract(),
    'memory.explain': taskContract(),
  }),
  entrypoints: Object.freeze(['direct_chat', 'delegated_task']),
  toolAllowlist: MEMORY_BOT_TOOLS,
  permissionProfileId: 'memory-bot-default',
  concurrencyLimit: 2,
  defaultTimeoutMs: 60000,
  minTimeoutMs: 5000,
  maxTimeoutMs: 120000,
  routingPriority: 100,
});

const MANIFESTS = Object.freeze({
  [MEMORY_BOT_ID]: MEMORY_BOT_MANIFEST,
});

// 测试注入点：Phase 1 交付物 2 的多候选用例需要两个以上「已注册主体」，
// 而真实注册表当前只有 memory。测试通过本函数临时追加 Manifest，
// 让 Task Store / Registry 的既有校验路径保持不变；生产代码不调用，默认恒为空。
let testManifests = Object.create(null);

function setTestManifests(manifests) {
  testManifests = Object.create(null);
  if (manifests && typeof manifests === 'object') {
    for (const [botId, item] of Object.entries(manifests)) {
      if (item && typeof item === 'object') testManifests[botId] = item;
    }
  }
}

function listManifests() {
  return [...Object.values(MANIFESTS), ...Object.values(testManifests)];
}

function getManifest(botId) {
  const id = String(botId || '');
  return MANIFESTS[id] || testManifests[id] || null;
}

function isKnownBot(botId) {
  return Boolean(getManifest(botId));
}

module.exports = {
  MEMORY_BOT_ID,
  MEMORY_BOT_MANIFEST,
  MEMORY_BOT_PROMPT,
  MANIFESTS,
  listManifests,
  getManifest,
  isKnownBot,
  setTestManifests,
};
