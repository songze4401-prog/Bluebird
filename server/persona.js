/* global __dirname */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');
const { logDataEvent } = require('./data-events');
const { registerCorruptionHandler, handleCorruption } = require('./corruption');

// 人格面板配置：与聊天历史 / 记忆 / 情绪 / 在线状态完全分文件存放。
// 数据目录规则与 sessions.js / presence.js 保持一致（测试用临时目录隔离）。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const PERSONA_FILE = path.join(DATA_DIR, 'persona.json');

const PERSONA_VERSION = 1;

// 默认值对齐 Blue 当前表现：恢复默认 ≈ 行为不变。
// messageMode: single 强制单条（与旧行为一致）/ auto 自然分条 / frequent 倾向多条。
// customPrompt: 用户在控制面板自行撰写的人格提示词；空串 = 不注入自定义块。
const DEFAULTS = Object.freeze({
  colloquial: 70,
  warmth: 70,
  initiative: 50,
  length: 50,
  messageMode: 'auto',
  customPrompt: '',
});

const MESSAGE_MODES = Object.freeze(['single', 'auto', 'frequent']);

const SLIDER_KEYS = Object.freeze([
  'colloquial',
  'warmth',
  'initiative',
  'length',
]);

// 自定义人格提示词上限（码点）：中文 4000 字足够写满一套人格设定，
// 同时保证落盘文件与注入的 system prompt 都有确定的规模上界。
const CUSTOM_PROMPT_MAX_CHARS = 4000;

function clampInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(100, Math.max(0, Math.round(n)));
}

// 自定义提示词只做"可读性归一"，不改写语义：
// 统一换行、去掉会破坏 JSON/终端的控制字符、按码点截断到上限。
// 提示词注入防护不在这里做，由渲染层 neutralizeContextText 负责
// （存原文才能让用户在面板里看到自己写的内容）。
function sanitizeCustomPrompt(value) {
  if (typeof value !== 'string') return '';

  const text = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- 显式清洗 C0 控制字符，保留 \t \n
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  return [...text].slice(0, CUSTOM_PROMPT_MAX_CHARS).join('');
}

// 宽松归一：读盘与旧配置迁移用。字段缺失/类型不符一律回退默认值，
// 保证人手改过或旧版本写下的 persona.json 都能安全读入。
function normalizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const config = {};

  for (const key of SLIDER_KEYS) {
    config[key] = clampInt(src[key], DEFAULTS[key]);
  }

  config.messageMode = MESSAGE_MODES.includes(src.messageMode)
    ? src.messageMode
    : DEFAULTS.messageMode;

  config.customPrompt = sanitizeCustomPrompt(src.customPrompt);

  return config;
}

// 严格校验：只用于写入口（PUT /persona）。
// 规则：缺省字段回退默认值（面板整份提交，部分字段提交也合法）；
// 字段一旦出现就必须类型正确、取值合法，否则整份拒绝，绝不静默改写用户文本。
function validateConfig(input) {
  if (input === undefined || input === null) return { ok: true, config: {} };

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['config 必须是对象'] };
  }

  const errors = [];

  for (const key of SLIDER_KEYS) {
    const value = input[key];

    if (value === undefined || value === null) continue;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} 必须是 0-100 之间的数字`);
    }
  }

  if (
    input.messageMode !== undefined &&
    input.messageMode !== null &&
    !MESSAGE_MODES.includes(input.messageMode)
  ) {
    errors.push(`messageMode 只能是 ${MESSAGE_MODES.join(' / ')}`);
  }

  const custom = input.customPrompt;

  if (custom !== undefined && custom !== null && typeof custom !== 'string') {
    errors.push('customPrompt 必须是字符串');
  } else if (typeof custom === 'string' && [...custom].length > CUSTOM_PROMPT_MAX_CHARS) {
    errors.push(
      `customPrompt 超过 ${CUSTOM_PROMPT_MAX_CHARS} 字上限（当前 ${[...custom].length} 字）`
    );
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, config: normalizeConfig(input) };
}

// 损坏处理契约：persona.json 是用户配置，采用与会话存储相同的原地只读保护——
// 损坏时保留原文件、拒绝覆盖，运行期回退默认值，避免用户配置被静默抹掉。
let corrupted = false;

registerCorruptionHandler('persona', {
  detect(data) {
    if (data.error) {
      return { corrupt: true, reason: 'read_error', error: data.error };
    }

    try {
      return { corrupt: false, parsed: JSON.parse(data.text) };
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }
  },

  recover() {
    return { action: 'kept_in_place_readonly', file: PERSONA_FILE };
  },
});

let cache = null;

function load() {
  if (cache) return cache;

  let text = null;
  let error = null;

  try {
    text = fs.readFileSync(PERSONA_FILE, 'utf8');
  } catch (readError) {
    if (readError && readError.code !== 'ENOENT') error = readError;
  }

  if (text === null && !error) {
    // 文件不存在：首次运行，直接用默认值（不落盘，等用户保存时再写）
    cache = { config: { ...DEFAULTS } };
    return cache;
  }

  const outcome = handleCorruption(
    'persona',
    { text, error },
    { file: PERSONA_FILE }
  );

  corrupted = outcome.corrupt;
  cache = { config: normalizeConfig(outcome.parsed && outcome.parsed.config) };
  return cache;
}

function getConfig() {
  return { ...load().config };
}

// 保存结果三态：invalid（未落盘，旧配置原样保留）/ corrupted（原地只读保护）
// / write_failed（磁盘写入失败）/ ok。API 据此区分 400 / 409 / 500。
function saveConfig(input) {
  load();

  const checked = validateConfig(input);

  if (!checked.ok) {
    return {
      ok: false,
      code: 'invalid_config',
      // error 直接带上具体原因：面板把它原样显示给用户，用户才改得对
      error: `人格配置校验失败：${checked.errors.join('；')}`,
      errors: checked.errors,
    };
  }

  if (corrupted) {
    return {
      ok: false,
      code: 'persona_file_corrupted',
      error: '人格配置文件已损坏，已原地保护，拒绝写入',
    };
  }

  const config = checked.config;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomicSync(
      PERSONA_FILE,
      JSON.stringify({ version: PERSONA_VERSION, config }, null, 2)
    );
  } catch (writeError) {
    // logDataEvent 只记录受控字段（name/code），不会把配置内容写进日志
    logDataEvent({
      module: 'persona',
      file: PERSONA_FILE,
      event: 'persona_write_failed',
      action: 'write_failed',
      error: writeError,
    });
    return {
      ok: false,
      code: 'persona_write_failed',
      error: '人格配置保存失败',
    };
  }

  cache = { config };
  return { ok: true, config: { ...config } };
}

function resetConfig() {
  return saveConfig({ ...DEFAULTS });
}

module.exports = {
  DEFAULTS,
  MESSAGE_MODES,
  CUSTOM_PROMPT_MAX_CHARS,
  getConfig,
  saveConfig,
  resetConfig,
  normalizeConfig,
  validateConfig,
};
