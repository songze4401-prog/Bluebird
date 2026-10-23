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
const DEFAULTS = Object.freeze({
  colloquial: 70,
  warmth: 70,
  initiative: 50,
  length: 50,
  messageMode: 'auto',
});

const MESSAGE_MODES = Object.freeze(['single', 'auto', 'frequent']);

const SLIDER_KEYS = Object.freeze([
  'colloquial',
  'warmth',
  'initiative',
  'length',
]);

function clampInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(100, Math.max(0, Math.round(n)));
}

// 归一化外部输入为合法配置：滑块夹取 0-100 整数，模式非法时回退默认。
function normalizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const config = {};

  for (const key of SLIDER_KEYS) {
    config[key] = clampInt(src[key], DEFAULTS[key]);
  }

  config.messageMode = MESSAGE_MODES.includes(src.messageMode)
    ? src.messageMode
    : DEFAULTS.messageMode;

  return config;
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

// 保存成功返回归一化后的配置；文件已损坏时拒绝写入（原地保护），返回 null
function saveConfig(input) {
  load();

  if (corrupted) return null;

  const config = normalizeConfig(input);

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
    return null;
  }

  cache = { config };
  return { ...config };
}

function resetConfig() {
  return saveConfig({ ...DEFAULTS });
}

module.exports = {
  DEFAULTS,
  MESSAGE_MODES,
  getConfig,
  saveConfig,
  resetConfig,
  normalizeConfig,
};
