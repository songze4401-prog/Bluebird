/* global module */
/**
 * Bot Registry：发现、状态与可运行性检查。
 * Registry 只聚合 Manifest / Config / Credential / Session，不承载业务逻辑。
 */
const { getManifest, listManifests } = require('./manifest');
const { publicConfig, getRuntimeConfig } = require('./config');
const { listCredentials } = require('./credentials');
const { listSessions } = require('./sessions');
const { listEvents } = require('./tasks');
const { findProvider } = require('../api-configs');
const { AgentError } = require('./errors');

function credentialFor(config, credentials) {
  if (!config.modelProfile.credentialId) return null;
  return (
    credentials.find(item => item.credentialId === config.modelProfile.credentialId) ||
    null
  );
}

function evaluateStatus(config, credential) {
  if (config.enabled !== true) {
    return { status: 'disabled', reason: 'disabled' };
  }
  if (!config.modelProfile.providerId || !config.modelProfile.modelId) {
    return { status: 'degraded', reason: 'model_not_configured' };
  }
  const provider = findProvider(config.modelProfile.providerId);
  if (!provider) return { status: 'degraded', reason: 'provider_not_found' };
  if (provider.enabled === false) return { status: 'degraded', reason: 'provider_disabled' };
  const model = provider.models.find(item => item.id === config.modelProfile.modelId);
  if (!model) return { status: 'degraded', reason: 'model_not_found' };
  if (model.enabled === false) return { status: 'degraded', reason: 'model_disabled' };
  if (!credential) return { status: 'degraded', reason: 'credential_not_configured' };
  return { status: 'enabled', reason: null };
}

function buildAgent(botId) {
  const manifest = getManifest(botId);
  if (!manifest) throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  const config = publicConfig(botId);
  let credentials = [];
  let credentialError = null;
  try {
    credentials = listCredentials(botId);
  } catch (error) {
    credentialError = error && error.code ? error.code : 'credential_store_error';
  }
  const credential = credentialFor(config, credentials);
  const evaluated = credentialError
    ? { status: 'degraded', reason: credentialError }
    : evaluateStatus(config, credential);
  const events = listEvents(botId, { limit: 1 });
  const sessions = listSessions(botId);

  return {
    botId: manifest.botId,
    displayName: manifest.displayName,
    version: manifest.version,
    description: manifest.description,
    capabilities: [...manifest.capabilities],
    acceptedTaskTypes: [...manifest.acceptedTaskTypes],
    entrypoints: [...manifest.entrypoints],
    permissionProfileId: config.permissionProfileId,
    toolAllowlist: [...config.toolAllowlist],
    status: evaluated.status,
    statusReason: evaluated.reason,
    enabled: config.enabled,
    model: {
      providerId: config.modelProfile.providerId,
      modelId: config.modelProfile.modelId,
      temperature: config.modelProfile.temperature,
      maxTokens: config.modelProfile.maxTokens,
      timeoutMs: config.modelProfile.timeoutMs,
    },
    credential,
    sessionsCount: sessions.length,
    lastActivityAt: events[0] ? events[0].timestamp : null,
    updatedAt: config.updatedAt,
  };
}

function listAgents() {
  return listManifests().map(manifest => buildAgent(manifest.botId));
}

function getAgent(botId) {
  return buildAgent(botId);
}

function assertRunnable(botId) {
  const agent = buildAgent(botId);
  if (agent.status === 'disabled') {
    throw new AgentError('bot_disabled', 'Memory Bot 已停用', 409);
  }
  if (agent.status !== 'enabled') {
    throw new AgentError(
      'bot_not_ready',
      `Memory Bot 尚未就绪（${agent.statusReason || 'configuration_incomplete'}）`,
      409
    );
  }
  const config = getRuntimeConfig(botId);
  const provider = findProvider(config.modelProfile.providerId);
  const model = provider.models.find(item => item.id === config.modelProfile.modelId);
  return { agent, config, provider, model };
}

module.exports = {
  listAgents,
  getAgent,
  assertRunnable,
  evaluateStatus,
};
