/* global __dirname */
/**
 * 云岫 Bluebird — API 服务商配置持久化（api-configs.js）
 *
 * 职责：多服务商 / 多模型配置的存储与校验，**不碰网络**（连接测试在
 * model-adapter.js）。与 persona.js / presence.js 保持同一套数据目录与
 * 原子写约定。
 *
 * 密钥安全边界（重要）：
 * - 元数据（服务商 / 模型 / 默认值）落 api-configs.json，**绝不含密钥**；
 * - 密钥单独落 api-keys.json（同目录，server/data 已被 .gitignore），
 *   写入后 chmod 0600（best-effort，Windows 上权限模型有限，见报告）；
 * - 密钥只经后端读取使用，任何路由响应都只返回脱敏 keyHint；
 * - 编辑配置时 apiKey 缺省或为空串 = 保留原有密钥，绝不意外覆盖。
 *
 * 已知限制（交付报告同步说明）：api-keys.json 是**明文静态存储**，
 * 靠文件权限 + gitignore 保护，未做静态加密——加密需要主密钥，而主密钥
 * 无法硬编码（任务书禁止），安全派生方案（如部署环境 KMS / 开机口令）
 * 标记为待确认，不用"明文冒充安全实现"。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('./atomic-write');
const { logDataEvent } = require('./data-events');

// 数据目录规则与 sessions.js / presence.js / persona.js 保持一致：
// 设了 BLUEBIRD_DATA_DIR 就用它（测试隔离），否则落 server/data/。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const CONFIG_FILE = path.join(DATA_DIR, 'api-configs.json');
const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

const CONFIG_VERSION = 1;

// 内置 DeepSeek 服务商：从环境变量派生，不落盘、不可删除、不可改名。
// 升级后无感知的关键——默认服务商/模型即内置 DeepSeek，与改造前行为一致。
const BUILTIN_PROVIDER_ID = 'deepseek';
const BUILTIN_BASE_URL = 'https://api.deepseek.com';
const BUILTIN_TEXT_MODEL = 'deepseek-chat';
const BUILTIN_VISION_MODEL = 'deepseek-flash';

// 规模上限：服务商与模型数量做硬顶，防止配置文件被刷爆
const MAX_PROVIDERS = 20;
const MAX_MODELS_PER_PROVIDER = 20;
const MAX_NAME_LEN = 50;
const MAX_BASE_URL_LEN = 200;
const MAX_API_KEY_LEN = 200;
const MAX_MODEL_ID_LEN = 64;

// 模型 ID 字符集：收敛到安全子集，避免注入路径 / 查询串 / 日志混淆
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PROVIDER_TYPES = Object.freeze(['openai-compatible']);

function builtinProvider() {
  const key = process.env.DEEPSEEK_API_KEY || '';
  return {
    id: BUILTIN_PROVIDER_ID,
    name: 'DeepSeek（内置）',
    type: 'deepseek',
    baseUrl: BUILTIN_BASE_URL,
    builtin: true,
    enabled: true,
    keyConfigured: Boolean(key),
    models: [
      {
        id: BUILTIN_TEXT_MODEL,
        name: 'DeepSeek Chat',
        enabled: true,
        // 能力声明只写代码确实依赖且确实存在的：视觉能力（flash 原生多模态）。
        // 工具调用 / 上下文长度本项目未使用，一律不声明——不虚报。
        capabilities: { vision: false },
      },
      {
        id: BUILTIN_VISION_MODEL,
        name: 'DeepSeek Flash（视觉）',
        enabled: true,
        capabilities: { vision: true },
      },
    ],
  };
}

function defaultState() {
  return {
    version: CONFIG_VERSION,
    defaults: {
      providerId: BUILTIN_PROVIDER_ID,
      modelId: BUILTIN_TEXT_MODEL,
    },
    providers: [],
  };
}

// ---- 内存态与损坏保护 ----
// 与 persona.js 同策略：配置损坏时原地只读保护，拒绝写入（不覆盖用户数据），
// 修复/删除损坏文件后才恢复可写。
let state = defaultState();
let configCorrupted = false;
let keys = {};
let keysCorrupted = false;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {
    /* 由后续写操作报错 */
  }
}

function backupCorruptFile(file, tag) {
  // 与 memory.js 一致：损坏文件重命名为 .corrupt-<ts> 备份，再允许重建
  try {
    const stamp = Date.now();
    fs.renameSync(file, `${file}.corrupt-${stamp}`);
    logDataEvent('config-backup', `${tag} 文件损坏，已备份为 .corrupt-${stamp}`);
  } catch (error) {
    console.error(`api-configs: ${tag} 损坏文件备份失败:`, error.message);
  }
}

function loadConfigs() {
  state = defaultState();
  configCorrupted = false;

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (_) {
    return; // 不存在：全默认（首次启动 / 全新部署）
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    configCorrupted = true;
    logDataEvent('config-corrupt', 'api-configs.json 解析失败，已只读保护');
    return;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
    configCorrupted = true;
    logDataEvent('config-corrupt', 'api-configs.json 结构非法，已只读保护');
    return;
  }

  // 只保留结构完整的条目；内置 id 保留给内置服务商，冲突的自定义条目丢弃
  const providers = parsed.providers
    .filter(p => p && typeof p.id === 'string' && p.id && p.id !== BUILTIN_PROVIDER_ID)
    .map(normalizeStoredProvider)
    .filter(Boolean)
    .slice(0, MAX_PROVIDERS);

  const defaults =
    parsed.defaults && typeof parsed.defaults === 'object'
      ? parsed.defaults
      : {};

  state = {
    version: CONFIG_VERSION,
    defaults: {
      providerId:
        typeof defaults.providerId === 'string' && defaults.providerId
          ? defaults.providerId
          : BUILTIN_PROVIDER_ID,
      modelId:
        typeof defaults.modelId === 'string' && defaults.modelId
          ? defaults.modelId
          : BUILTIN_TEXT_MODEL,
    },
    providers,
  };

  // 默认值引用的服务商/模型已不存在：回退到内置默认（不自动改用户文件，
  // 下次成功写入时自然修正；此处保证运行期始终有可用默认）
  const defProvider = findProvider(state.defaults.providerId);
  if (!defProvider || !defProvider.models.some(m => m.id === state.defaults.modelId && m.enabled)) {
    state.defaults = {
      providerId: BUILTIN_PROVIDER_ID,
      modelId: BUILTIN_TEXT_MODEL,
    };
  }
}

function loadKeys() {
  keys = {};
  keysCorrupted = false;

  let raw;
  try {
    raw = fs.readFileSync(KEYS_FILE, 'utf8');
  } catch (_) {
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value) keys[id] = value;
      }
    }
  } catch (_) {
    // 密钥文件损坏：备份后按空处理（对应服务商变为"未配置密钥"，
    // 用户重新填写即可；绝不静默丢弃元数据）
    keysCorrupted = true;
    backupCorruptFile(KEYS_FILE, 'api-keys.json');
    logDataEvent('config-corrupt', 'api-keys.json 解析失败，已备份并置空');
  }
}

loadConfigs();
loadKeys();

function saveConfigs() {
  if (configCorrupted) return false;
  ensureDataDir();
  writeFileAtomicSync(
    CONFIG_FILE,
    JSON.stringify({ version: state.version, defaults: state.defaults, providers: state.providers }, null, 2)
  );
  return true;
}

function saveKeys() {
  ensureDataDir();
  writeFileAtomicSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  // 尽力收紧权限（POSIX 生效；Windows NTFS 上 chmod 基本是 no-op，
  // 防护主要靠 server/data 的 gitignore 与部署目录权限——报告已标注）
  try {
    fs.chmodSync(KEYS_FILE, 0o600);
  } catch (_) {
    /* 平台不支持：忽略 */
  }
}

// ---- 校验与归一化 ----

function normalizeStoredProvider(p) {
  if (
    typeof p.name !== 'string' ||
    typeof p.baseUrl !== 'string' ||
    !Array.isArray(p.models)
  ) {
    return null;
  }

  return {
    id: p.id,
    name: p.name.slice(0, MAX_NAME_LEN),
    type: PROVIDER_TYPES.includes(p.type) ? p.type : 'openai-compatible',
    baseUrl: p.baseUrl.slice(0, MAX_BASE_URL_LEN),
    enabled: p.enabled !== false,
    models: p.models
      .map(normalizeModel)
      .filter(Boolean)
      .slice(0, MAX_MODELS_PER_PROVIDER),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
  };
}

function normalizeModel(m) {
  if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) return null;

  const caps = m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {};

  return {
    id: m.id.slice(0, MAX_MODEL_ID_LEN),
    name: typeof m.name === 'string' ? m.name.slice(0, MAX_NAME_LEN) : m.id,
    enabled: m.enabled !== false,
    // 只接受布尔能力；缺省 = 未知 = 不支持（调用方按不支持处理，不虚报）
    capabilities: { vision: caps.vision === true },
  };
}

function validateProviderInput(input, { requireKey }) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    return { errors: ['请求体必须是对象'] };
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('name 不能为空');
  else if (name.length > MAX_NAME_LEN) errors.push(`name 长度不能超过 ${MAX_NAME_LEN}`);

  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (!baseUrl) errors.push('baseUrl 不能为空');
  else if (baseUrl.length > MAX_BASE_URL_LEN)
    errors.push(`baseUrl 长度不能超过 ${MAX_BASE_URL_LEN}`);

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (requireKey && !apiKey) errors.push('apiKey 不能为空');
  if (apiKey.length > MAX_API_KEY_LEN)
    errors.push(`apiKey 长度不能超过 ${MAX_API_KEY_LEN}`);

  const models = Array.isArray(input.models) ? input.models : [];
  if (!models.length) errors.push('至少需要一个模型');
  else if (models.length > MAX_MODELS_PER_PROVIDER)
    errors.push(`单个服务商最多 ${MAX_MODELS_PER_PROVIDER} 个模型`);
  else {
    const seen = new Set();
    for (const m of models) {
      if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) {
        errors.push(`模型 id 非法：${JSON.stringify(m && m.id)}（允许字母数字 . _ : -）`);
        continue;
      }
      if (seen.has(m.id)) {
        errors.push(`模型 id 重复：${m.id}`);
        continue;
      }
      seen.add(m.id);
    }
  }

  return { errors, value: { name, baseUrl, apiKey, models } };
}

// ---- 对外只读视图（脱敏） ----

function keyHint(key) {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function publicProvider(provider) {
  if (!provider) return null;

  const key = provider.builtin
    ? process.env.DEEPSEEK_API_KEY || ''
    : keys[provider.id] || '';

  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    builtin: Boolean(provider.builtin),
    enabled: provider.enabled !== false,
    keyConfigured: Boolean(key),
    keyHint: keyHint(key),
    models: provider.models.map(m => ({ ...m, capabilities: { ...m.capabilities } })),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function findProvider(id) {
  if (id === BUILTIN_PROVIDER_ID) return builtinProvider();
  return state.providers.find(p => p.id === id) || null;
}

/**
 * 服务商列表（含内置）。永远不含完整密钥。
 */
function listModelProviders() {
  return [builtinProvider(), ...state.providers].map(publicProvider);
}

function getModelProvider(id) {
  return publicProvider(findProvider(String(id || '')));
}

function getDefaults() {
  return { ...state.defaults };
}

function isConfigCorrupted() {
  return configCorrupted;
}

// ---- 内部：仅适配层可用，绝不进路由响应 ----

function getProviderKey(id) {
  if (id === BUILTIN_PROVIDER_ID) return process.env.DEEPSEEK_API_KEY || '';
  return keys[id] || '';
}

// ---- 变更操作 ----

function addModelProvider(input) {
  if (configCorrupted) return { error: 'config_corrupted' };
  if (state.providers.length >= MAX_PROVIDERS) {
    return { error: `服务商数量已达上限（${MAX_PROVIDERS}）` };
  }

  const { errors, value } = validateProviderInput(input, { requireKey: true });
  if (errors.length) return { error: errors.join('；') };

  const now = new Date().toISOString();
  const provider = {
    id: crypto.randomUUID(),
    name: value.name,
    type: 'openai-compatible',
    baseUrl: value.baseUrl,
    enabled: true,
    models: value.models.map(m => normalizeModel(m)),
    createdAt: now,
    updatedAt: now,
  };

  state.providers.push(provider);
  keys[provider.id] = value.apiKey;
  saveConfigs();
  saveKeys();

  return { provider: publicProvider(provider) };
}

function updateModelProvider(id, patch) {
  if (configCorrupted) return { error: 'config_corrupted' };

  const target = String(id || '');
  if (target === BUILTIN_PROVIDER_ID) {
    return { error: '内置 DeepSeek 服务商不可编辑' };
  }

  const provider = state.providers.find(p => p.id === target);
  if (!provider) return { error: 'not_found' };

  const body = patch && typeof patch === 'object' ? patch : {};

  // 局部更新：只校验出现的字段。apiKey 缺省或空串 = 保留原密钥。
  const next = { ...provider };

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { error: 'name 不能为空' };
    if (name.length > MAX_NAME_LEN) return { error: `name 长度不能超过 ${MAX_NAME_LEN}` };
    next.name = name;
  }

  if (body.baseUrl !== undefined) {
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!baseUrl) return { error: 'baseUrl 不能为空' };
    if (baseUrl.length > MAX_BASE_URL_LEN)
      return { error: `baseUrl 长度不能超过 ${MAX_BASE_URL_LEN}` };
    next.baseUrl = baseUrl;
  }

  if (body.models !== undefined) {
    const models = Array.isArray(body.models) ? body.models : [];
    if (!models.length) return { error: '至少需要一个模型' };
    if (models.length > MAX_MODELS_PER_PROVIDER)
      return { error: `单个服务商最多 ${MAX_MODELS_PER_PROVIDER} 个模型` };

    const seen = new Set();
    for (const m of models) {
      if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) {
        return { error: `模型 id 非法：${JSON.stringify(m && m.id)}` };
      }
      if (seen.has(m.id)) return { error: `模型 id 重复：${m.id}` };
      seen.add(m.id);
    }
    next.models = models.map(normalizeModel);
  }

  // 默认服务商被禁用 / 默认模型被摘掉：拒绝，避免默认指向不可用目标
  const willBeDefault =
    state.defaults.providerId === provider.id &&
    (next.enabled === false ||
      (body.models !== undefined &&
        !next.models.some(m => m.id === state.defaults.modelId && m.enabled)));

  if (willBeDefault) {
    return { error: '不能禁用当前默认服务商或移除其默认模型，请先切换默认模型' };
  }

  if (body.enabled !== undefined) next.enabled = body.enabled === true;

  next.updatedAt = new Date().toISOString();

  // 先落密钥（若提供），再落元数据：任一步失败都不会出现"元数据新、密钥旧"的错位
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    if (body.apiKey.trim().length > MAX_API_KEY_LEN) {
      return { error: `apiKey 长度不能超过 ${MAX_API_KEY_LEN}` };
    }
    keys[provider.id] = body.apiKey.trim();
    saveKeys();
  }

  Object.assign(provider, next);
  saveConfigs();

  return { provider: publicProvider(provider) };
}

function deleteModelProvider(id) {
  if (configCorrupted) return { error: 'config_corrupted' };

  const target = String(id || '');
  if (target === BUILTIN_PROVIDER_ID) {
    return { error: '内置 DeepSeek 服务商不可删除' };
  }

  const index = state.providers.findIndex(p => p.id === target);
  if (index === -1) return { error: 'not_found' };

  if (state.defaults.providerId === target) {
    return { error: '不能删除当前默认服务商，请先切换默认模型' };
  }

  state.providers.splice(index, 1);
  delete keys[target];
  saveConfigs();
  saveKeys();

  return { ok: true };
}

function setDefaultModel(input) {
  if (configCorrupted) return { error: 'config_corrupted' };

  const providerId = input && typeof input.providerId === 'string' ? input.providerId : '';
  const modelId = input && typeof input.modelId === 'string' ? input.modelId : '';

  const provider = findProvider(providerId);
  if (!provider) return { error: '服务商不存在' };
  if (provider.enabled === false) return { error: '服务商已禁用' };

  const model = provider.models.find(m => m.id === modelId);
  if (!model) return { error: '模型不存在' };
  if (model.enabled === false) return { error: '模型已禁用' };

  state.defaults = { providerId: provider.id, modelId: model.id };
  saveConfigs();

  return { defaults: getDefaults() };
}

function setProviderEnabled(id, enabled) {
  if (configCorrupted) return { error: 'config_corrupted' };

  const target = String(id || '');
  if (target === BUILTIN_PROVIDER_ID) {
    return { error: '内置 DeepSeek 服务商不可禁用（保证零配置可运行）' };
  }

  const provider = state.providers.find(p => p.id === target);
  if (!provider) return { error: 'not_found' };

  if (enabled === false && state.defaults.providerId === target) {
    return { error: '不能禁用当前默认服务商，请先切换默认模型' };
  }

  provider.enabled = enabled === true;
  provider.updatedAt = new Date().toISOString();
  saveConfigs();

  return { provider: publicProvider(provider) };
}

module.exports = {
  BUILTIN_PROVIDER_ID,
  BUILTIN_BASE_URL,
  BUILTIN_TEXT_MODEL,
  BUILTIN_VISION_MODEL,
  CONFIG_FILE,
  KEYS_FILE,
  builtinProvider,
  listModelProviders,
  getModelProvider,
  findProvider,
  getDefaults,
  isConfigCorrupted,
  getProviderKey,
  addModelProvider,
  updateModelProvider,
  deleteModelProvider,
  setDefaultModel,
  setProviderEnabled,
  keyHint,
};
