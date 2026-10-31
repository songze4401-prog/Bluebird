/* global module, __dirname */
/**
 * Bot 独立配置（首期仅 Memory Bot）。
 *
 * 配置只保存模型引用、参数、Prompt 与工具白名单；API Key 不在这里，
 * 由 credentials.js 加密保存。读取接口永远返回脱敏值。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const { findProvider } = require('../api-configs');
const {
  MEMORY_BOT_ID,
  MEMORY_BOT_PROMPT,
  getManifest,
  listManifests,
  isKnownBot,
} = require('./manifest');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const CONFIG_FILE = path.join(AGENTS_DIR, 'agents.json');
const SCHEMA_VERSION = 1;
const MAX_PROMPT_CHARS = 8000;
const MAX_TOOLS = 12;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultBotConfig(botId) {
  const manifest = getManifest(botId);
  return {
    botId,
    enabled: true,
    modelProfile: {
      providerId: '',
      modelId: '',
      credentialId: null,
      temperature: 0.4,
      maxTokens: 1200,
      timeoutMs: 60000,
    },
    prompt: {
      systemPrompt: botId === MEMORY_BOT_ID ? MEMORY_BOT_PROMPT : '',
      version: 'v1',
    },
    toolAllowlist: manifest ? [...manifest.toolAllowlist] : [],
    permissionProfileId: manifest ? manifest.permissionProfileId : 'default',
    updatedAt: nowIso(),
  };
}

function defaultStore() {
  const bots = {};
  for (const manifest of listManifests()) {
    bots[manifest.botId] = defaultBotConfig(manifest.botId);
  }
  return { version: SCHEMA_VERSION, bots };
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function validateStoredConfig(raw) {
  if (!isPlainObject(raw) || raw.version !== SCHEMA_VERSION || !isPlainObject(raw.bots)) {
    throw new AgentError('agent_config_corrupted', 'Agent 配置文件结构无效', 500);
  }
  return raw;
}

function normalizeStoredBot(botId, raw) {
  const base = defaultBotConfig(botId);
  if (!isPlainObject(raw)) return base;
  return {
    botId,
    enabled: raw.enabled !== false,
    modelProfile: isPlainObject(raw.modelProfile)
      ? { ...base.modelProfile, ...raw.modelProfile, credentialId: raw.modelProfile.credentialId || null }
      : base.modelProfile,
    prompt: isPlainObject(raw.prompt) ? { ...base.prompt, ...raw.prompt } : base.prompt,
    toolAllowlist: Array.isArray(raw.toolAllowlist)
      ? raw.toolAllowlist.filter(name => typeof name === 'string')
      : base.toolAllowlist,
    permissionProfileId:
      typeof raw.permissionProfileId === 'string' && raw.permissionProfileId
        ? raw.permissionProfileId
        : base.permissionProfileId,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : base.updatedAt,
  };
}

function load() {
  if (cache) return cache;
  ensureDir();

  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = defaultStore();
    writeFileAtomicSync(CONFIG_FILE, JSON.stringify(initial, null, 2));
    cache = initial;
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_config_corrupted', 'Agent 配置文件无法解析', 500);
  }

  cache = validateStoredConfig(parsed);
  let changed = false;
  for (const manifest of listManifests()) {
    const normalized = normalizeStoredBot(manifest.botId, cache.bots[manifest.botId]);
    if (!cache.bots[manifest.botId] || JSON.stringify(cache.bots[manifest.botId]) !== JSON.stringify(normalized)) {
      cache.bots[manifest.botId] = normalized;
      changed = true;
    }
  }
  if (changed) save();
  return cache;
}

function save() {
  ensureDir();
  writeFileAtomicSync(CONFIG_FILE, JSON.stringify(cache, null, 2));
}

function assertBot(botId) {
  if (!isKnownBot(botId)) {
    throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  }
}

function publicConfig(botId) {
  assertBot(botId);
  const config = load().bots[botId];
  return {
    botId,
    enabled: config.enabled === true,
    modelProfile: { ...config.modelProfile },
    prompt: { ...config.prompt },
    toolAllowlist: [...config.toolAllowlist],
    permissionProfileId: config.permissionProfileId,
    updatedAt: config.updatedAt,
  };
}

function validateModelProfile(input, current) {
  if (!isPlainObject(input)) {
    throw new AgentError('invalid_config', 'modelProfile 必须是对象');
  }
  const next = { ...current };
  const providerId =
    input.providerId === undefined ? next.providerId : String(input.providerId || '').trim();
  const modelId =
    input.modelId === undefined ? next.modelId : String(input.modelId || '').trim();

  if (providerId) {
    const provider = findProvider(providerId);
    if (!provider) throw new AgentError('provider_not_found', '模型服务商不存在', 404);
    if (modelId) {
      const model = provider.models.find(item => item.id === modelId);
      if (!model) throw new AgentError('model_not_found', '模型不存在', 404);
    }
  } else if (modelId) {
    throw new AgentError('invalid_config', '未选择服务商时不能指定模型');
  }

  next.providerId = providerId;
  next.modelId = modelId;

  if (input.temperature !== undefined) {
    const value = Number(input.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw new AgentError('invalid_config', 'temperature 必须在 0 到 2 之间');
    }
    next.temperature = value;
  }
  if (input.maxTokens !== undefined) {
    const value = Number(input.maxTokens);
    if (!Number.isInteger(value) || value < 128 || value > 4000) {
      throw new AgentError('invalid_config', 'maxTokens 必须在 128 到 4000 之间');
    }
    next.maxTokens = value;
  }
  if (input.timeoutMs !== undefined) {
    const value = Number(input.timeoutMs);
    if (!Number.isInteger(value) || value < 5000 || value > 120000) {
      throw new AgentError('invalid_config', 'timeoutMs 必须在 5000 到 120000 之间');
    }
    next.timeoutMs = value;
  }

  return next;
}

function validatePrompt(input, current) {
  if (!isPlainObject(input)) throw new AgentError('invalid_config', 'prompt 必须是对象');
  const next = { ...current };
  if (input.systemPrompt !== undefined) {
    const value = String(input.systemPrompt || '').trim();
    if (!value) throw new AgentError('invalid_config', 'systemPrompt 不能为空');
    if (value.length > MAX_PROMPT_CHARS) {
      throw new AgentError('invalid_config', `systemPrompt 不能超过 ${MAX_PROMPT_CHARS} 字`);
    }
    next.systemPrompt = value;
  }
  if (input.version !== undefined) {
    const value = String(input.version || '').trim();
    if (!value || value.length > 40) {
      throw new AgentError('invalid_config', 'prompt.version 无效');
    }
    next.version = value;
  }
  return next;
}

function validateTools(input, manifest) {
  if (!Array.isArray(input)) throw new AgentError('invalid_config', 'toolAllowlist 必须是数组');
  const allowed = new Set(manifest.toolAllowlist);
  const result = [];
  for (const name of input) {
    if (
      typeof name !== 'string' ||
      !TOOL_NAME_RE.test(name) ||
      !allowed.has(name)
    ) {
      throw new AgentError('invalid_config', 'toolAllowlist 含未授权工具');
    }
    if (!result.includes(name)) result.push(name);
  }
  if (result.length > MAX_TOOLS) {
    throw new AgentError('invalid_config', 'toolAllowlist 数量超限');
  }
  return result;
}

function updateConfig(botId, patch) {
  assertBot(botId);
  if (!isPlainObject(patch)) throw new AgentError('invalid_config', '配置必须是对象');
  const manifest = getManifest(botId);
  const current = load().bots[botId];
  const next = {
    ...current,
    modelProfile: { ...current.modelProfile },
    prompt: { ...current.prompt },
    toolAllowlist: [...current.toolAllowlist],
  };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new AgentError('invalid_config', 'enabled 必须是布尔值');
    }
    next.enabled = patch.enabled;
  }
  if (patch.modelProfile !== undefined) {
    next.modelProfile = validateModelProfile(patch.modelProfile, next.modelProfile);
  }
  if (patch.prompt !== undefined) {
    next.prompt = validatePrompt(patch.prompt, next.prompt);
  }
  if (patch.toolAllowlist !== undefined) {
    next.toolAllowlist = validateTools(patch.toolAllowlist, manifest);
  }
  if (patch.permissionProfileId !== undefined) {
    throw new AgentError('invalid_config', 'permissionProfileId 由服务端管理');
  }
  if (patch.credentialId !== undefined) {
    throw new AgentError('invalid_config', 'credentialId 只能通过凭证接口管理');
  }
  if (patch.status !== undefined) {
    throw new AgentError('invalid_config', 'status 由运行时计算');
  }

  next.updatedAt = nowIso();
  cache.bots[botId] = next;
  save();
  return publicConfig(botId);
}

function setCredentialId(botId, credentialId) {
  assertBot(botId);
  const current = load().bots[botId];
  current.modelProfile.credentialId =
    typeof credentialId === 'string' && credentialId ? credentialId : null;
  current.updatedAt = nowIso();
  save();
  return publicConfig(botId);
}

function getRuntimeConfig(botId) {
  assertBot(botId);
  return clone(load().bots[botId]);
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  AGENTS_DIR,
  CONFIG_FILE,
  MAX_PROMPT_CHARS,
  defaultBotConfig,
  publicConfig,
  updateConfig,
  setCredentialId,
  getRuntimeConfig,
  reloadForTests,
};
