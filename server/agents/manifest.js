/* global module */
/**
 * Bot Manifest 注册表：Memory Bot 与三个专业角色（检索/执行/审校）。
 * Manifest 只描述稳定契约，不包含启用状态、模型密钥或运行时数据；
 * 新增 Bot 只需在此追加一份 Manifest（能力、任务类型、工具白名单、Prompt），
 * 路由/运行时按能力标签匹配，不按角色名写分支。
 */
// `memory` 是历史 botId，保留为通用执行 agent 的标识以兼容既有任务/数据与测试。
// 它不再持有任何记忆工具：长期记忆由主控 Agent 独占（memory_search/memory_remember）。
const MEMORY_BOT_ID = 'memory';
const RESEARCHER_BOT_ID = 'researcher';
const EXECUTOR_BOT_ID = 'executor';
const REVIEWER_BOT_ID = 'reviewer';

const MEMORY_BOT_PROMPT = `
你是 Bluebird 的通用执行 Agent（历史标识 memory）。

职责：
- 按主控 Agent 委派的目标执行工作区文件操作与信息整理；不处理长期记忆。
- 长期记忆由主控 Agent 独占：你不得检索、写入、更新或解释用户记忆，也没有相应工具。
- knowledge_search 仅用于文档、网页、代码等非记忆来源；不得声称能直接读写记忆文件或数据库。
- 不编造工具结果或操作结论；无法执行时明确说明，不伪装成功。
- 工具执行结果与委派目标不一致时，如实报告差异。
`.trim();

const MEMORY_BOT_TOOLS = Object.freeze([
  'workspace_list',
  'workspace_read',
  'workspace_write',
  'knowledge_search',
  // 历史副作用标记载体：不暴露给模型（agents/runtime 的 allowedToolsFor 会过滤），
  // handler 对 agentId 非空仍硬闸拒绝；仅用于任务副作用判定。
  'memory_remember',
]);

// 任务契约的输入 schema。路由层按这份声明做确定性校验，
// 不依赖 createTask 里的零散长度判断；输出 schema 描述结果字段，供
// 后续 Worker/前端消费，当前任务结果已按此形状落库。
function taskContract({ maxGoalChars = 2000, tools = MEMORY_BOT_TOOLS } = {}) {
  return Object.freeze({
    input: Object.freeze({
      goal: Object.freeze({ type: 'string', required: true, maxChars: maxGoalChars }),
      context: Object.freeze({ type: 'string', maxChars: 8000 }),
      contextRef: Object.freeze({ type: 'string', maxChars: 200 }),
      allowedTools: Object.freeze({
        type: 'array',
        items: 'string',
        maxItems: 6,
        values: tools,
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
  displayName: 'Action Bot',
  version: '2.0.0',
  description: '通用执行 Agent（历史标识 memory）：工作区文件操作与信息整理；长期记忆由主控独占。',
  // 历史 taskType 别名（memory.search/explain/...）保留为内部标识兼容层，
  // 不代表该 Agent 持有记忆能力：工具白名单已移除 memory_*，记忆归主控独占。
  capabilities: Object.freeze([
    'action.execute',
    'workspace.file',
    'summary.synthesize',
    'memory.search',
    'memory.explain',
    'memory.write',
    'memory.audit.read',
  ]),
  acceptedTaskTypes: Object.freeze([
    'action.execute',
    'workspace.file',
    'summary.synthesize',
    'memory.search',
    'memory.explain',
    'memory.write',
    'memory.audit.read',
  ]),
  // 只有 acceptedTaskTypes 里的任务可被路由；每个任务类型的输入/输出契约必须存在。
  taskContracts: Object.freeze({
    'action.execute': taskContract(),
    'workspace.file': taskContract(),
    'summary.synthesize': taskContract(),
    'memory.search': taskContract(),
    'memory.explain': taskContract(),
    'memory.write': taskContract(),
    'memory.audit.read': taskContract(),
  }),
  entrypoints: Object.freeze(['direct_chat', 'delegated_task']),
  toolAllowlist: MEMORY_BOT_TOOLS,
  permissionProfileId: 'memory-bot-default',
  concurrencyLimit: 2,
  defaultTimeoutMs: 60000,
  minTimeoutMs: 5000,
  maxTimeoutMs: 120000,
  routingPriority: 100,
  systemPrompt: MEMORY_BOT_PROMPT,
});

const RESEARCHER_BOT_PROMPT = `
你是 Bluebird 的 Research Bot，负责检索与知识综合的专业 Agent。

职责：
- 先检索再下结论：只通过 knowledge_search、web_search、web_fetch 获取证据，不凭记忆臆造事实。
- 输出带来源的结论；检索不到或证据不足时明确说明缺口，不编造引用。
- 只做只读检索与综合，不做写入、更新、删除等变更操作；需要变更时说明应由执行角色处理。
- 不处理长期记忆；用户记忆由主控 Agent 独占。
`.trim();

const EXECUTOR_BOT_PROMPT = `
你是 Bluebird 的 Action Bot，负责执行与写入的专业 Agent。

职责：
- 只执行主控明确委派、且符合既有确认策略的工作区文件操作。
- 写入前核对目标路径与内容；高风险写入遵守确认策略，不伪装成功。
- 不处理长期记忆；用户记忆由主控 Agent 独占。
`.trim();

const REVIEWER_BOT_PROMPT = `
你是 Bluebird 的 Review Bot，负责审校与验证的专业 Agent。

职责：
- 独立核对结论与证据是否一致：只通过 knowledge_search、web_search、web_fetch 取证。
- 逐条指出证据缺口、矛盾或越界结论；不修改原始结论，只给出审校意见。
- 无法验证时明确标为“未验证”，不以推测替代证据。
- 不处理长期记忆；用户记忆由主控 Agent 独占。
`.trim();

// 子 Agent 不向模型暴露任何记忆工具；memory_remember 只在执行型 Agent 的
// manifest 白名单里充当副作用判定载体，由 allowedToolsFor 从模型可见工具中过滤。
const RESEARCHER_TOOLS = Object.freeze(['knowledge_search', 'web_search', 'web_fetch']);
const EXECUTOR_TOOLS = Object.freeze(['workspace_list', 'workspace_read', 'workspace_write', 'knowledge_search', 'memory_remember']);
const REVIEWER_TOOLS = Object.freeze(['knowledge_search', 'web_search', 'web_fetch']);

function roleManifest({
  botId,
  displayName,
  description,
  prompt,
  capabilities,
  acceptedTaskTypes,
  tools,
  permissionProfileId,
  routingPriority,
}) {
  const contracts = {};
  for (const taskType of acceptedTaskTypes) {
    contracts[taskType] = taskContract({ tools });
  }
  return Object.freeze({
    botId,
    displayName,
    version: '1.0.0',
    description,
    capabilities: Object.freeze(capabilities),
    acceptedTaskTypes: Object.freeze(acceptedTaskTypes),
    taskContracts: Object.freeze(contracts),
    entrypoints: Object.freeze(['direct_chat', 'delegated_task']),
    toolAllowlist: tools,
    permissionProfileId,
    concurrencyLimit: 2,
    defaultTimeoutMs: 60000,
    minTimeoutMs: 5000,
    maxTimeoutMs: 120000,
    routingPriority,
    systemPrompt: prompt,
  });
}

const RESEARCHER_BOT_MANIFEST = roleManifest({
  botId: RESEARCHER_BOT_ID,
  displayName: 'Research Bot',
  description: '负责检索与知识综合的专业 Agent：先取证，再给出带来源的结论。',
  prompt: RESEARCHER_BOT_PROMPT,
  capabilities: ['research.analyze', 'knowledge.search', 'summary.synthesize', 'memory.recall'],
  acceptedTaskTypes: ['research.analyze', 'knowledge.search', 'summary.synthesize', 'memory.recall'],
  tools: RESEARCHER_TOOLS,
  permissionProfileId: 'research-default',
  routingPriority: 90,
});

const EXECUTOR_BOT_MANIFEST = roleManifest({
  botId: EXECUTOR_BOT_ID,
  displayName: 'Action Bot',
  description: '负责执行与写入的专业 Agent：只在证据充分且符合策略时提交变更。',
  prompt: EXECUTOR_BOT_PROMPT,
  // memory.write 为历史 taskType 别名（内部标识），不代表持有记忆工具。
  capabilities: ['action.execute', 'workspace.file', 'memory.write'],
  acceptedTaskTypes: ['action.execute', 'workspace.file', 'memory.write'],
  tools: EXECUTOR_TOOLS,
  permissionProfileId: 'action-default',
  routingPriority: 110,
});

const REVIEWER_BOT_MANIFEST = roleManifest({
  botId: REVIEWER_BOT_ID,
  displayName: 'Review Bot',
  description: '负责审校与验证的专业 Agent：核对结论与证据，标出缺口与矛盾。',
  prompt: REVIEWER_BOT_PROMPT,
  capabilities: ['review.verify', 'evidence.check'],
  acceptedTaskTypes: ['review.verify', 'evidence.check', 'memory.explain', 'memory.audit.read'],
  tools: REVIEWER_TOOLS,
  permissionProfileId: 'review-default',
  routingPriority: 120,
});

const MANIFESTS = Object.freeze({
  [MEMORY_BOT_ID]: MEMORY_BOT_MANIFEST,
  [RESEARCHER_BOT_ID]: RESEARCHER_BOT_MANIFEST,
  [EXECUTOR_BOT_ID]: EXECUTOR_BOT_MANIFEST,
  [REVIEWER_BOT_ID]: REVIEWER_BOT_MANIFEST,
});

// 测试注入点：容量/多候选等边界用例需要额外主体；真实路由证据改用已注册的
// researcher / executor / reviewer，不再依赖本注入。生产代码不调用，默认恒为空。
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
  RESEARCHER_BOT_ID,
  EXECUTOR_BOT_ID,
  REVIEWER_BOT_ID,
  MEMORY_BOT_MANIFEST,
  RESEARCHER_BOT_MANIFEST,
  EXECUTOR_BOT_MANIFEST,
  REVIEWER_BOT_MANIFEST,
  MEMORY_BOT_PROMPT,
  MANIFESTS,
  listManifests,
  getManifest,
  isKnownBot,
  setTestManifests,
};
