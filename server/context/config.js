/**
 * 云岫 Bluebird — Context Engine 统一配置加载器（config.js）
 *
 * 职责（冻结基线第 8 节）：全局唯一配置加载器，负责 schema 校验。
 * - 严格模式：未知字段一律拒绝（additionalProperties: false 语义），
 *   防止字段拼写错误导致配置静默失效；
 * - 实时类型（realtime_data）的 TTL 必填（v2.3），缺失则校验失败；
 * - 禁止 `on_expire: ignore`（等同没有 TTL，冻结基线第 3 节禁止项）；
 * - 四个业务模块（检索、裁决、组装、trace）只读本模块导出的已校验配置，
 *   不得各自修改或重新解释策略；
 * - 第一版冷加载：进程启动时加载一次（require 时即校验），不热更新。
 *
 * 本文件刻意不引入任何 JSON Schema 库依赖：项目无此类依赖，且本配置结构
 * 固定、规模小，手写校验器即可达到同样严格度（未知键、类型、枚举、必填）。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

// ---- 允许的 on_expire 取值（冻结基线 TTL 策略；ignore 被明确禁止） ----
const ALLOWED_ON_EXPIRE = new Set(['refetch', 'demote_to_pending', 'revalidate']);

// ---- schema 描述：与 config.json 一一对应，用于严格校验 ----
// 结构说明（语义见 RULES.md）：
//   ttl       各信息类型的 TTL 与过期行为（realtime_data.ttlRequired = true）
//   budget    软目标 + 硬上限、系统/任务保底、单条上限按信息类型
//   retry     自动重试策略（仅只读/幂等，最多一次）
//   circuitBreaker  按 data_source 粒度的熔断
//   routing   快速路由的结构化规则（Planner 跳过依据）
//   metrics   降级率 / 冲突率分别设阈值（v2.3 拆分）
//   verificationOrder / sourceOrder  裁决顺序（v2.3）
const SCHEMA = {
  schemaVersion: 'string',
  ttl: 'object',
  budget: 'object',
  retry: 'object',
  circuitBreaker: 'object',
  routing: 'object',
  metrics: 'object',
  verificationOrder: 'array',
  sourceOrder: 'array',
};

const TTL_TYPES = ['realtime_data', 'user_preference', 'project_fact'];

const TTL_SCHEMA = {
  ttlMs: 'number',
  on_expire: 'string',
  ttlRequired: 'boolean',
};

const BUDGET_SCHEMA = {
  softTarget: 'number',
  hardCap: 'number',
  guaranteedSystem: 'number',
  guaranteedTask: 'number',
  perTypeMax: 'object',
};

const BUDGET_TYPES = [
  'realtime_data',
  'user_preference',
  'project_fact',
  'doc',
  'web',
  'tool',
  'memory',
  'user',
];

const RETRY_SCHEMA = {
  maxRetries: 'number',
  retryableOnlyReadonly: 'boolean',
};

const CIRCUIT_SCHEMA = {
  failureThreshold: 'number',
  windowMs: 'number',
};

const ROUTING_SCHEMA = {
  plannerKeywordThreshold: 'number',
  complexKeywords: 'array',
  simpleTaskMaxLength: 'number',
};

const METRICS_SCHEMA = {
  demoteRateThreshold: 'number',
  conflictRateThreshold: 'number',
};

const ORDER_SCHEMA = {
  verificationOrder: 'array',
  sourceOrder: 'array',
};

// ---- 校验器 ----

function typeOf(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  return typeof value === expected;
}

// 校验单层 schema：对象中出现的键必须都在 schema 内（严格模式），
// 且类型匹配。missingOk=true 时允许键缺失（否则报缺失）。
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

// ---- 主校验入口：返回 { ok, config?, errors? }，绝不抛异常 ----
function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['配置必须是 JSON 对象'] };
  }

  const errors = [];

  // schemaVersion 必须是 v2.3（冻结基线唯一有效版本）
  if (raw.schemaVersion !== 'v2.3') {
    errors.push('schemaVersion 必须为 "v2.3"（唯一有效规则基线）');
  }

  errors.push(...validateShape(raw, SCHEMA, 'config'));

  // ttl 子结构：三个类型齐全、字段合法、on_expire 枚举合法、realtime TTL 必填。
  // ttlRequired 仅对 realtime_data 强制；其它类型缺省视为 false（不允许缺省
  // 时误报必填缺失）。
  for (const t of TTL_TYPES) {
    const entry = raw.ttl && raw.ttl[t];
    errors.push(
      ...validateShape(
        entry,
        TTL_SCHEMA,
        `config.ttl.${t}`,
        t !== 'realtime_data' // 非实时类型允许缺少 ttlRequired
      )
    );

    if (entry && typeof entry === 'object') {
      if (typeof entry.ttlMs !== 'number' || !Number.isFinite(entry.ttlMs) || entry.ttlMs <= 0) {
        errors.push(`config.ttl.${t}.ttlMs 必须是正数`);
      }
      if (!ALLOWED_ON_EXPIRE.has(entry.on_expire)) {
        errors.push(
          `config.ttl.${t}.on_expire 非法：${entry.on_expire}（允许 ${[...ALLOWED_ON_EXPIRE].join(' / ')}，禁止 ignore）`
        );
      }
      if (t === 'realtime_data' && entry.ttlRequired !== true) {
        errors.push('config.ttl.realtime_data.ttlRequired 必须为 true（实时类型 TTL 必填，v2.3）');
      }
    }
  }

  // budget 子结构
  const budget = raw.budget;
  errors.push(...validateShape(budget, BUDGET_SCHEMA, 'config.budget'));

  if (budget && typeof budget === 'object') {
    for (const t of BUDGET_TYPES) {
      // perTypeMax 的值是数字（单条预算上限），不是对象：直接校验正数
      const v = budget.perTypeMax && budget.perTypeMax[t];
      if (v !== undefined) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          errors.push(`config.budget.perTypeMax.${t} 必须是正数`);
        }
      } else {
        errors.push(`缺少必填字段：config.budget.perTypeMax.${t}`);
      }
    }
    const nums = ['softTarget', 'hardCap', 'guaranteedSystem', 'guaranteedTask'];
    for (const k of nums) {
      if (typeof budget[k] === 'number' && (!Number.isFinite(budget[k]) || budget[k] < 0)) {
        errors.push(`config.budget.${k} 必须是非负数字`);
      }
    }
    if (
      typeof budget.hardCap === 'number' &&
      typeof budget.softTarget === 'number' &&
      budget.hardCap < budget.softTarget
    ) {
      errors.push('config.budget.hardCap 不得小于 softTarget');
    }
    if (
      typeof budget.perTypeMax === 'object' &&
      budget.perTypeMax
    ) {
      for (const [k, v] of Object.entries(budget.perTypeMax)) {
        if (!BUDGET_TYPES.includes(k)) {
          errors.push(`未知预算类型：config.budget.perTypeMax.${k}`);
        }
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          errors.push(`config.budget.perTypeMax.${k} 必须是正数`);
        }
      }
    }
  }

  // retry / circuitBreaker / routing / metrics
  errors.push(...validateShape(raw.retry, RETRY_SCHEMA, 'config.retry'));
  if (raw.retry && typeof raw.retry.maxRetries === 'number' && raw.retry.maxRetries > 1) {
    errors.push('config.retry.maxRetries 最大为 1（冻结基线：只读/幂等最多重试一次）');
  }
  errors.push(...validateShape(raw.circuitBreaker, CIRCUIT_SCHEMA, 'config.circuitBreaker'));
  errors.push(...validateShape(raw.routing, ROUTING_SCHEMA, 'config.routing'));
  if (
    raw.routing &&
    typeof raw.routing.complexKeywords === 'object' &&
    !Array.isArray(raw.routing.complexKeywords)
  ) {
    errors.push('config.routing.complexKeywords 必须是数组');
  }
  errors.push(...validateShape(raw.metrics, METRICS_SCHEMA, 'config.metrics'));

  // 裁决顺序数组：内容合法性
  const verificationOrder = raw.verificationOrder;
  if (Array.isArray(verificationOrder)) {
    for (const v of verificationOrder) {
      if (!['delivered', 'schema_valid', 'cross_checked', 'user_confirmed'].includes(v)) {
        errors.push(`config.verificationOrder 含非法值：${v}`);
      }
    }
  }
  const sourceOrder = raw.sourceOrder;
  if (Array.isArray(sourceOrder)) {
    for (const s of sourceOrder) {
      if (!['user', 'tool', 'memory', 'doc', 'web'].includes(s)) {
        errors.push(`config.sourceOrder 含非法值：${s}`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, config: raw };
}

// ---- 单一加载器：模块加载时读取 + 校验（冷加载） ----
// 校验失败时抛错并在 stderr 打印全部错误：配置是系统的静态基线，
// 无效配置必须拒绝启动，而不是静默回退（与 single-instance 的拒绝启动风格一致）。
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

// 冷加载：require 时立即校验并缓存；模块只读它，禁止改写。
const config = loadConfigFile(CONFIG_FILE);

// 深冻结：业务模块拿到的是只读对象，防止任何模块意外修改策略。
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
