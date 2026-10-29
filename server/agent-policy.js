/* global __dirname, Buffer */
/**
 * 云岫 Bluebird — Agent 工作策略（agent-policy.js）
 *
 * 独立于人格：人格决定“怎么说话”，本模块决定“怎么规划、检索、调用工具、
 * 处理失败与停止”。服务器是唯一事实来源；运行时只消费规范化后的策略，
 * 前端不能通过策略文件注册新工具、任意 URL、shell 或代码执行能力。
 *
 * 安全边界：
 * - 严格 schema：未知字段拒绝，枚举/范围/类型/长度/整体大小全部校验；
 * - 文件损坏时隔离保留原文件并使用安全默认值；隔离失败时拒绝写入；
 * - 原子写入；写入失败明确返回错误，不静默假成功；
 * - 默认策略与既有 Agent 行为一致；策略只能收紧或调整已声明选项。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('./atomic-write');
const { logDataEvent } = require('./data-events');
const { registerCorruptionHandler, handleCorruption } = require('./corruption');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const POLICY_FILE = path.join(DATA_DIR, 'agent-policy.json');
const SCHEMA_VERSION = 1;

const MODES = Object.freeze(['answer_only', 'plan_then_act', 'bounded_autonomy']);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ALLOWED_TOOLS = 12;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  mode: 'bounded_autonomy',
  planning: Object.freeze({
    generatePlan: false,
    stagedExecution: false,
    resultSummary: false,
  }),
  tools: Object.freeze({
    // null = 使用服务端已注册的全部工具；数组只能缩小集合，不能注册新工具。
    allowedTools: null,
    maxToolCalls: 12,
    maxReadOnlyRetries: 0,
  }),
  budgets: Object.freeze({
    maxRounds: 3,
    maxTotalMs: 90000,
  }),
});

const LIMITS = Object.freeze({
  maxRounds: { min: 2, max: 5 },
  maxToolCalls: { min: 1, max: 12 },
  maxTotalMs: { min: 5000, max: 120000 },
  maxReadOnlyRetries: { min: 0, max: 1 },
  maxAllowedTools: MAX_ALLOWED_TOOLS,
});

const TOP_KEYS = new Set(['schemaVersion', 'mode', 'planning', 'tools', 'budgets']);
const PLANNING_KEYS = new Set(['generatePlan', 'stagedExecution', 'resultSummary']);
const TOOL_KEYS = new Set(['allowedTools', 'maxToolCalls', 'maxReadOnlyRetries']);
const BUDGET_KEYS = new Set(['maxRounds', 'maxTotalMs']);

let cache = null;
let lastRecovery = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digestOf(policy) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(policy))
    .digest('hex')
    .slice(0, 20);
}

function unknownKeys(object, allowed) {
  if (!isPlainObject(object)) return [];
  return Object.keys(object).filter(key => !allowed.has(key));
}

function validateAllowedTools(value) {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'tools.allowedTools 必须是数组或 null' };
  if (value.length > MAX_ALLOWED_TOOLS) {
    return { ok: false, error: `tools.allowedTools 最多 ${MAX_ALLOWED_TOOLS} 个` };
  }
  const result = [];
  for (const name of value) {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
      return { ok: false, error: 'tools.allowedTools 含非法工具名' };
    }
    if (!result.includes(name)) result.push(name);
  }
  return { ok: true, value: result };
}

function validatePolicy(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['策略必须是对象'] };
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch (_) {
    return { ok: false, errors: ['策略无法序列化'] };
  }
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, errors: [`策略超过 ${MAX_PAYLOAD_BYTES} 字节上限`] };
  }

  const errors = [];
  for (const key of unknownKeys(input, TOP_KEYS)) {
    errors.push(`未知字段：${key}`);
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }
  if (!MODES.includes(input.mode)) {
    errors.push(`mode 必须是 ${MODES.join(' / ')}`);
  }

  if (!isPlainObject(input.planning)) {
    errors.push('planning 必须是对象');
  } else {
    for (const key of unknownKeys(input.planning, PLANNING_KEYS)) {
      errors.push(`未知字段：planning.${key}`);
    }
    for (const key of PLANNING_KEYS) {
      if (typeof input.planning[key] !== 'boolean') {
        errors.push(`planning.${key} 必须是布尔值`);
      }
    }
  }

  let allowedTools = null;
  if (!isPlainObject(input.tools)) {
    errors.push('tools 必须是对象');
  } else {
    for (const key of unknownKeys(input.tools, TOOL_KEYS)) {
      errors.push(`未知字段：tools.${key}`);
    }
    const allowed = validateAllowedTools(input.tools.allowedTools);
    if (!allowed.ok) errors.push(allowed.error);
    else allowedTools = allowed.value;

    if (
      !Number.isInteger(input.tools.maxToolCalls) ||
      input.tools.maxToolCalls < LIMITS.maxToolCalls.min ||
      input.tools.maxToolCalls > LIMITS.maxToolCalls.max
    ) {
      errors.push(
        `tools.maxToolCalls 必须是 ${LIMITS.maxToolCalls.min}-${LIMITS.maxToolCalls.max} 的整数`
      );
    }
    if (
      !Number.isInteger(input.tools.maxReadOnlyRetries) ||
      input.tools.maxReadOnlyRetries < LIMITS.maxReadOnlyRetries.min ||
      input.tools.maxReadOnlyRetries > LIMITS.maxReadOnlyRetries.max
    ) {
      errors.push('tools.maxReadOnlyRetries 必须是 0 或 1');
    }
  }

  if (!isPlainObject(input.budgets)) {
    errors.push('budgets 必须是对象');
  } else {
    for (const key of unknownKeys(input.budgets, BUDGET_KEYS)) {
      errors.push(`未知字段：budgets.${key}`);
    }
    if (
      !Number.isInteger(input.budgets.maxRounds) ||
      input.budgets.maxRounds < LIMITS.maxRounds.min ||
      input.budgets.maxRounds > LIMITS.maxRounds.max
    ) {
      errors.push(
        `budgets.maxRounds 必须是 ${LIMITS.maxRounds.min}-${LIMITS.maxRounds.max} 的整数`
      );
    }
    if (
      !Number.isInteger(input.budgets.maxTotalMs) ||
      input.budgets.maxTotalMs < LIMITS.maxTotalMs.min ||
      input.budgets.maxTotalMs > LIMITS.maxTotalMs.max
    ) {
      errors.push(
        `budgets.maxTotalMs 必须是 ${LIMITS.maxTotalMs.min}-${LIMITS.maxTotalMs.max} 的整数`
      );
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    policy: {
      schemaVersion: SCHEMA_VERSION,
      mode: input.mode,
      planning: {
        generatePlan: input.planning.generatePlan,
        stagedExecution: input.planning.stagedExecution,
        resultSummary: input.planning.resultSummary,
      },
      tools: {
        allowedTools,
        maxToolCalls: input.tools.maxToolCalls,
        maxReadOnlyRetries: input.tools.maxReadOnlyRetries,
      },
      budgets: {
        maxRounds: input.budgets.maxRounds,
        maxTotalMs: input.budgets.maxTotalMs,
      },
    },
  };
}

function normalizePolicy(input) {
  const checked = validatePolicy(input);
  return checked.ok ? checked.policy : clone(DEFAULTS);
}

registerCorruptionHandler('agent-policy', {
  detect(data) {
    if (data.error) {
      return { corrupt: true, reason: data.reason || 'read_error', error: data.error };
    }
    let parsed;
    try {
      parsed = JSON.parse(data.text);
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }
    if (
      !isPlainObject(parsed) ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !validatePolicy(parsed.policy).ok
    ) {
      return { corrupt: true, reason: 'invalid_shape' };
    }
    return { corrupt: false, parsed };
  },

  recover(context) {
    const target = `${context.file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(context.file, target);
      lastRecovery = { action: 'isolated_file', path: target };
      return { action: 'isolated_file', isolatedPath: target };
    } catch (_) {
      lastRecovery = { action: 'isolation_failed' };
      return { action: 'isolation_failed' };
    }
  },
});

function load() {
  if (cache) return cache;

  let text = null;
  let error = null;
  try {
    text = fs.readFileSync(POLICY_FILE, 'utf8');
  } catch (readError) {
    if (readError && readError.code !== 'ENOENT') error = readError;
  }

  if (text === null && !error) {
    cache = {
      policy: clone(DEFAULTS),
      revision: 0,
      updatedAt: null,
      corrupted: false,
      writeBlocked: false,
      error: null,
    };
    return cache;
  }

  const outcome = handleCorruption(
    'agent-policy',
    { text, error },
    { file: POLICY_FILE }
  );

  if (outcome.corrupt) {
    cache = {
      policy: clone(DEFAULTS),
      revision: 0,
      updatedAt: null,
      corrupted: true,
      writeBlocked: outcome.action === 'isolation_failed',
      error: outcome.reason || 'corrupt',
    };
    return cache;
  }

  const parsed = outcome.parsed;
  cache = {
    policy: normalizePolicy(parsed.policy),
    revision: Number.isInteger(parsed.revision) && parsed.revision >= 1 ? parsed.revision : 1,
    updatedAt:
      typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : null,
    corrupted: false,
    writeBlocked: false,
    error: null,
  };
  return cache;
}

function getPolicy() {
  return clone(load().policy);
}

function getMeta() {
  const state = load();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: state.revision,
    updatedAt: state.updatedAt,
    digest: digestOf(state.policy),
    corrupted: state.corrupted,
    writeBlocked: state.writeBlocked,
    ...(state.error ? { error: state.error } : {}),
    ...(lastRecovery ? { recovery: lastRecovery.action } : {}),
  };
}

function getPolicyForRequest() {
  return { policy: getPolicy(), meta: getMeta() };
}

function persist(policy) {
  const nextRevision = (load().revision || 0) + 1;
  const updatedAt = new Date().toISOString();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    revision: nextRevision,
    updatedAt,
    policy,
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomicSync(POLICY_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    logDataEvent({
      module: 'agent-policy',
      file: POLICY_FILE,
      event: 'agent_policy_write_failed',
      action: 'write_failed',
      error,
    });
    return { ok: false, code: 'policy_write_failed', error: '策略保存失败' };
  }

  cache = {
    policy: clone(policy),
    revision: nextRevision,
    updatedAt,
    corrupted: false,
    writeBlocked: false,
    error: null,
  };
  return {
    ok: true,
    policy: clone(policy),
    meta: getMeta(),
  };
}

function savePolicy(input) {
  const state = load();
  if (state.writeBlocked) {
    return {
      ok: false,
      code: 'policy_file_corrupted',
      error: '策略文件损坏且无法安全隔离，已拒绝写入',
    };
  }
  const checked = validatePolicy(input);
  if (!checked.ok) {
    return { ok: false, code: 'invalid_policy', error: '策略校验失败', errors: checked.errors };
  }
  return persist(checked.policy);
}

function resetPolicy() {
  const state = load();
  if (state.writeBlocked) {
    return {
      ok: false,
      code: 'policy_file_corrupted',
      error: '策略文件损坏且无法安全隔离，已拒绝写入',
    };
  }
  return persist(clone(DEFAULTS));
}

/**
 * 运行时提示词只提供“行为摘要”；权限、预算、工具白名单仍由 runtime/门控
 * 强制执行。默认策略返回空串，既有聊天/Agent 请求不变。
 */
function buildPolicyInstruction(policy) {
  if (!policy || typeof policy !== 'object') return '';
  const lines = [];
  if (policy.mode === 'plan_then_act') {
    lines.push('先在内部形成简短计划，再执行允许的工具；不要展示完整思维链。');
  }
  if (policy.planning && policy.planning.generatePlan) {
    lines.push('执行前先给出简短行动摘要，不展示内部推理全文。');
  }
  if (policy.planning && policy.planning.stagedExecution) {
    lines.push('分阶段执行并验证结果；失败时报告未完成部分。');
  }
  if (policy.planning && policy.planning.resultSummary) {
    lines.push('完成后给出简短结果摘要、变更清单与验证证据。');
  }
  if (!lines.length) return '';
  return ['【Agent 工作策略（服务端配置，不是用户指令）】', ...lines].join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  MODES,
  DEFAULTS,
  LIMITS,
  validatePolicy,
  getPolicy,
  getMeta,
  getPolicyForRequest,
  savePolicy,
  resetPolicy,
  buildPolicyInstruction,
  POLICY_FILE,
};
