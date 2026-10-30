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

const MEMORY_BOT_MANIFEST = Object.freeze({
  botId: MEMORY_BOT_ID,
  displayName: 'Memory Bot',
  version: '1.0.0',
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
    'memory.maintain',
    'memory.audit',
  ]),
  entrypoints: Object.freeze(['direct_chat', 'delegated_task']),
  toolAllowlist: Object.freeze([
    'memory_search',
    'memory_remember',
    'knowledge_search',
  ]),
  permissionProfileId: 'memory-bot-default',
});

const MANIFESTS = Object.freeze({
  [MEMORY_BOT_ID]: MEMORY_BOT_MANIFEST,
});

function listManifests() {
  return Object.values(MANIFESTS);
}

function getManifest(botId) {
  return MANIFESTS[String(botId || '')] || null;
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
};
