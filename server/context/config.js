/**
 * 云岫 Bluebird — Context Runtime v3 统一配置加载器（config.js）
 *
 * 职责：
 * - 全局唯一配置加载器；严格模式拒绝未知字段，防止拼写错误静默失效；
 * - 冷加载：进程启动时校验一次，业务模块只读；
 * - 配置只描述真实存在的策略：历史选择、记忆检索、输入保护、TTL、熔断。
 *   旧 v2.3 的 softTarget / perTypeMax / 固定保底配额已随预算体系删除。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const ALLOWED_ON_EXPIRE = new Set(['refetch', 'demote_to_pending', 'revalidate']);
const TTL_TYPES = ['realtime_data', 'user_preference', 'project_fact'];

const SCHEMA = {
  schemaVersion: 'string',
  ttl: 'object',
  history: 'object',
  retrieval: 'object',
  inputGuard: 'object',
  retry: 'object',
  circuitBreaker: 'object',
};

const TTL_SCHEMA = {
  ttlMs: 'number',
  on_expire: 'string',
  ttlRequired: 'boolean',
};

const HISTORY_SCHEMA = {
  recentBudgetTokens: 'number',
  minRecentMessages: 'number',
  longRangeMaxItems: 'number',
  longRangeBudgetTokens: 'number',
  longRangeThreshold: 'number',
  backReferenceBoost: 'number',
  summaryBudgetTokens: 'number',
  summaryMaxItemsPerSection: 'number',
};

const RETRIEVAL_SCHEMA = {
  memoryMaxItems: 'number',
  memoryPerItemMax: 'number',
  memoryTotalMax: 'number',
  coverageSkipThreshold: 'number',
  coveragePartialThreshold: 'number',
  pairwiseDedupeThreshold: 'number',
};

const INPUT_GUARD_SCHEMA = {
  outputReserveTokens: 'number',
  safetyMarginTokens: 'number',
  estimatorSafetyFactor: 'number',
  unknownWindowGuardTokens: 'number',
  perImageTokens: 'number',
  perMessageOverheadTokens: 'number',
  minHistoryMessages: 'number',
  toolsRoundReserveTokens: 'number',
};

const RETRY_SCHEMA = {
  maxRetries: 'number',
};

const CIRCUIT_SCHEMA = {
  failureThreshold: 'number',
  windowMs: 'number',
};

function typeOf(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  return typeof value === expected;
}

function validateShape(actual, schema, where, missingOk = false) {
  const errors = [];

  if (!typeOf(actual, 'object')) {
    return [`${where} 必须是对象`];
  }

  for (const key of Object.keys(actual)) {
    if (!(key in schema)) {
      errors.push(`未知字段：${where}.${key}（严格模式拒绝）`);
    }
  }

  for (const [key, expected] of Object.entries(schema)) {
    if (actual[key] === undefined) {
      if (!missingOk) errors.push(`缺少必填字段：${where}.${key}`);
      continue;
    }
    if (!typeOf(actual[key], expected)) {
      errors.push(`字段类型错误：${where}.${key} 期望 ${expected}`);
    }
  }

  return errors;
}

function requirePositiveNumbers(obj, keys, where) {
  const errors = [];
  for (const key of keys) {
    const value = obj && obj[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(`${where}.${key} 必须是正数`);
    }
  }
  return errors;
}

function requireNonNegativeNumbers(obj, keys, where) {
  const errors = [];
  for (const key of keys) {
    const value = obj && obj[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`${where}.${key} 必须是非负数`);
    }
  }
  return errors;
}

function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['配置必须是 JSON 对象'] };
  }

  const errors = [];

  if (raw.schemaVersion !== 'v3.0') {
    errors.push('schemaVersion 必须为 "v3.0"（唯一有效规则基线）');
  }

  errors.push(...validateShape(raw, SCHEMA, 'config'));

  for (const t of TTL_TYPES) {
    const entry = raw.ttl && raw.ttl[t];
    errors.push(
      ...validateShape(entry, TTL_SCHEMA, `config.ttl.${t}`, t !== 'realtime_data')
    );

    if (entry && typeof entry === 'object') {
      if (typeof entry.ttlMs !== 'number' || !Number.isFinite(entry.ttlMs) || entry.ttlMs <= 0) {
        errors.push(`config.ttl.${t}.ttlMs 必须是正数`);
      }
      if (!ALLOWED_ON_EXPIRE.has(entry.on_expire)) {
        errors.push(
          `config.ttl.${t}.on_expire 非法：${entry.on_expire}（允许 ${[...ALLOWED_ON_EXPIRE].join(' / ')}）`
        );
      }
      if (t === 'realtime_data' && entry.ttlRequired !== true) {
        errors.push('config.ttl.realtime_data.ttlRequired 必须为 true（实时类型 TTL 必填）');
      }
    }
  }

  errors.push(...validateShape(raw.history, HISTORY_SCHEMA, 'config.history'));
  errors.push(
    ...requirePositiveNumbers(
      raw.history,
      ['recentBudgetTokens', 'longRangeMaxItems', 'longRangeBudgetTokens', 'summaryBudgetTokens', 'summaryMaxItemsPerSection'],
      'config.history'
    )
  );
  errors.push(
    ...requireNonNegativeNumbers(
      raw.history,
      ['minRecentMessages', 'longRangeThreshold', 'backReferenceBoost'],
      'config.history'
    )
  );
  if (raw.history && typeof raw.history === 'object') {
    if (raw.history.longRangeThreshold > 1) {
      errors.push('config.history.longRangeThreshold 必须在 0~1 之间');
    }
    if (raw.history.backReferenceBoost > 1) {
      errors.push('config.history.backReferenceBoost 必须在 0~1 之间');
    }
  }

  errors.push(...validateShape(raw.retrieval, RETRIEVAL_SCHEMA, 'config.retrieval'));
  errors.push(
    ...requirePositiveNumbers(
      raw.retrieval,
      ['memoryMaxItems', 'memoryPerItemMax', 'memoryTotalMax'],
      'config.retrieval'
    )
  );
  if (raw.retrieval && typeof raw.retrieval === 'object') {
    for (const key of ['coverageSkipThreshold', 'coveragePartialThreshold', 'pairwiseDedupeThreshold']) {
      const value = raw.retrieval[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        errors.push(`config.retrieval.${key} 必须在 0~1 之间`);
      }
    }
    if (
      typeof raw.retrieval.coveragePartialThreshold === 'number' &&
      typeof raw.retrieval.coverageSkipThreshold === 'number' &&
      raw.retrieval.coveragePartialThreshold > raw.retrieval.coverageSkipThreshold
    ) {
      errors.push('config.retrieval.coveragePartialThreshold 不得大于 coverageSkipThreshold');
    }
  }

  errors.push(...validateShape(raw.inputGuard, INPUT_GUARD_SCHEMA, 'config.inputGuard'));
  errors.push(
    ...requireNonNegativeNumbers(
      raw.inputGuard,
      ['outputReserveTokens', 'safetyMarginTokens', 'perMessageOverheadTokens', 'minHistoryMessages', 'toolsRoundReserveTokens'],
      'config.inputGuard'
    )
  );
  errors.push(
    ...requirePositiveNumbers(
      raw.inputGuard,
      ['estimatorSafetyFactor', 'unknownWindowGuardTokens', 'perImageTokens'],
      'config.inputGuard'
    )
  );
  if (raw.inputGuard && typeof raw.inputGuard === 'object') {
    if (raw.inputGuard.estimatorSafetyFactor < 1) {
      errors.push('config.inputGuard.estimatorSafetyFactor 必须 >= 1（保守放大）');
    }
    if (
      typeof raw.inputGuard.outputReserveTokens === 'number' &&
      typeof raw.inputGuard.unknownWindowGuardTokens === 'number' &&
      raw.inputGuard.outputReserveTokens >= raw.inputGuard.unknownWindowGuardTokens
    ) {
      errors.push('config.inputGuard.outputReserveTokens 必须小于 unknownWindowGuardTokens');
    }
  }

  errors.push(...validateShape(raw.retry, RETRY_SCHEMA, 'config.retry'));
  if (raw.retry && typeof raw.retry.maxRetries === 'number' && raw.retry.maxRetries > 1) {
    errors.push('config.retry.maxRetries 最大为 1（只读/幂等最多重试一次）');
  }

  errors.push(...validateShape(raw.circuitBreaker, CIRCUIT_SCHEMA, 'config.circuitBreaker'));
  errors.push(
    ...requirePositiveNumbers(
      raw.circuitBreaker,
      ['failureThreshold', 'windowMs'],
      'config.circuitBreaker'
    )
  );

  if (errors.length) return { ok: false, errors };

  return { ok: true, config: raw };
}

function loadConfigFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = `[context] 无法读取配置文件 ${filePath}：${error.message}`;
    console.error(message);
    throw new Error(message);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = `[context] 配置文件不是合法 JSON（${filePath}）：${error.message}`;
    console.error(message);
    throw new Error(message);
  }

  const result = validateConfig(raw);

  if (!result.ok) {
    const message = `[context] 配置校验失败（${filePath}）：\n${result.errors.join('\n')}`;
    console.error(message);
    throw new Error(message);
  }

  return result.config;
}

const config = loadConfigFile(CONFIG_FILE);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}

deepFreeze(config);

module.exports = {
  config,
  validateConfig,
  loadConfigFile,
  CONFIG_FILE,
};
