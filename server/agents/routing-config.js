/* global module, __dirname */
/**
 * Router 路由配置（一期控制面）。
 *
 * 只保存可解释的阈值与预算：Fast/Slow 分流规则、两条路径的执行预算、
 * 任务截止时间范围与全局队列深度上限。文件由服务端读取并严格校验；
 * 校验失败直接报错，不用“默认值”掩盖被改坏的配置。
 * 删除该文件即回到默认路由；默认值与既有 Memory Bot 行为一致。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { listManifests } = require('./manifest');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const ROUTING_FILE = path.join(AGENTS_DIR, 'agent-routing.json');
const SCHEMA_VERSION = 1;
const MAX_ROUTING_BYTES = 8 * 1024;

const DEFAULT_ROUTING = Object.freeze({
  version: SCHEMA_VERSION,
  fast: Object.freeze({ maxGoalChars: 800, maxContextChars: 2000 }),
  slowTaskTypes: Object.freeze([]),
  profiles: Object.freeze({
    fast: Object.freeze({
      maxRounds: 3,
      maxToolCalls: 6,
      maxReadOnlyRetries: 1,
      generatePlan: false,
    }),
    slow: Object.freeze({
      maxRounds: 4,
      maxToolCalls: 6,
      maxReadOnlyRetries: 1,
      generatePlan: true,
    }),
  }),
  limits: Object.freeze({
    minDeadlineMs: 5000,
    maxDeadlineMs: 120000,
    maxQueueDepth: 100,
  }),
});

let cache = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function knownTaskTypes() {
  const set = new Set();
  for (const manifest of listManifests()) {
    for (const taskType of manifest.acceptedTaskTypes) set.add(taskType);
  }
  return set;
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter(key => !allowed.has(key));
}

function validateProfile(raw, label) {
  if (!isPlainObject(raw)) return `${label} 必须是对象`;
  const keys = new Set(['maxRounds', 'maxToolCalls', 'maxReadOnlyRetries', 'generatePlan']);
  const unknown = unknownKeys(raw, keys);
  if (unknown.length) return `${label} 含未知字段：${unknown.join(',')}`;
  if (!Number.isInteger(raw.maxRounds) || raw.maxRounds < 2 || raw.maxRounds > 5) {
    return `${label}.maxRounds 必须在 2 到 5 之间`;
  }
  if (!Number.isInteger(raw.maxToolCalls) || raw.maxToolCalls < 1 || raw.maxToolCalls > 12) {
    return `${label}.maxToolCalls 必须在 1 到 12 之间`;
  }
  if (
    !Number.isInteger(raw.maxReadOnlyRetries) ||
    raw.maxReadOnlyRetries < 0 ||
    raw.maxReadOnlyRetries > 1
  ) {
    return `${label}.maxReadOnlyRetries 必须在 0 到 1 之间`;
  }
  if (typeof raw.generatePlan !== 'boolean') {
    return `${label}.generatePlan 必须是布尔值`;
  }
  return null;
}

function validateRoutingConfig(raw) {
  if (!isPlainObject(raw)) return '路由配置必须是对象';
  const top = new Set(['version', 'fast', 'slowTaskTypes', 'profiles', 'limits']);
  const unknown = unknownKeys(raw, top);
  if (unknown.length) return `未知字段：${unknown.join(',')}`;
  if (raw.version !== SCHEMA_VERSION) return `不支持的版本：${raw.version}`;

  if (!isPlainObject(raw.fast)) return 'fast 必须是对象';
  const fastKeys = new Set(['maxGoalChars', 'maxContextChars']);
  const unknownFast = unknownKeys(raw.fast, fastKeys);
  if (unknownFast.length) return `fast 含未知字段：${unknownFast.join(',')}`;
  if (
    !Number.isInteger(raw.fast.maxGoalChars) ||
    raw.fast.maxGoalChars < 1 ||
    raw.fast.maxGoalChars > 8000
  ) {
    return 'fast.maxGoalChars 必须在 1 到 8000 之间';
  }
  if (
    !Number.isInteger(raw.fast.maxContextChars) ||
    raw.fast.maxContextChars < 0 ||
    raw.fast.maxContextChars > 8000
  ) {
    return 'fast.maxContextChars 必须在 0 到 8000 之间';
  }

  if (!Array.isArray(raw.slowTaskTypes)) return 'slowTaskTypes 必须是数组';
  const known = knownTaskTypes();
  const seen = new Set();
  for (const taskType of raw.slowTaskTypes) {
    if (typeof taskType !== 'string' || !known.has(taskType)) {
      return `slowTaskTypes 含未知任务类型：${taskType}`;
    }
    if (seen.has(taskType)) return `slowTaskTypes 重复：${taskType}`;
    seen.add(taskType);
  }

  if (!isPlainObject(raw.profiles)) return 'profiles 必须是对象';
  const profileKeys = new Set(['fast', 'slow']);
  const unknownProfiles = unknownKeys(raw.profiles, profileKeys);
  if (unknownProfiles.length) return `profiles 含未知字段：${unknownProfiles.join(',')}`;
  const fastError = validateProfile(raw.profiles.fast, 'profiles.fast');
  if (fastError) return fastError;
  const slowError = validateProfile(raw.profiles.slow, 'profiles.slow');
  if (slowError) return slowError;

  if (!isPlainObject(raw.limits)) return 'limits 必须是对象';
  const limitKeys = new Set(['minDeadlineMs', 'maxDeadlineMs', 'maxQueueDepth']);
  const unknownLimits = unknownKeys(raw.limits, limitKeys);
  if (unknownLimits.length) return `limits 含未知字段：${unknownLimits.join(',')}`;
  if (
    !Number.isInteger(raw.limits.minDeadlineMs) ||
    raw.limits.minDeadlineMs < 5000 ||
    raw.limits.minDeadlineMs > 120000
  ) {
    return 'limits.minDeadlineMs 必须在 5000 到 120000 之间';
  }
  if (
    !Number.isInteger(raw.limits.maxDeadlineMs) ||
    raw.limits.maxDeadlineMs < 5000 ||
    raw.limits.maxDeadlineMs > 120000
  ) {
    return 'limits.maxDeadlineMs 必须在 5000 到 120000 之间';
  }
  if (raw.limits.maxDeadlineMs < raw.limits.minDeadlineMs) {
    return 'limits.maxDeadlineMs 不能小于 minDeadlineMs';
  }
  if (
    !Number.isInteger(raw.limits.maxQueueDepth) ||
    raw.limits.maxQueueDepth < 1 ||
    raw.limits.maxQueueDepth > 500
  ) {
    return 'limits.maxQueueDepth 必须在 1 到 500 之间';
  }
  return null;
}

function digestOf(config) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex')
    .slice(0, 16);
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();

  if (!fs.existsSync(ROUTING_FILE)) {
    const initial = clone(DEFAULT_ROUTING);
    writeFileAtomicSync(ROUTING_FILE, JSON.stringify(initial, null, 2));
    cache = initial;
    return cache;
  }

  let parsed;
  try {
    const stat = fs.statSync(ROUTING_FILE);
    if (stat.size > MAX_ROUTING_BYTES) {
      throw new AgentError('agent_routing_corrupted', '路由配置文件过大', 500);
    }
    parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('agent_routing_corrupted', '路由配置文件无法解析', 500);
  }
  const problem = validateRoutingConfig(parsed);
  if (problem) {
    throw new AgentError('agent_routing_corrupted', `路由配置无效：${problem}`, 500);
  }
  cache = parsed;
  return cache;
}

function getRoutingConfig() {
  const config = load();
  return { config: clone(config), digest: digestOf(config) };
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  ROUTING_FILE,
  DEFAULT_ROUTING,
  validateRoutingConfig,
  getRoutingConfig,
  digestOf,
  reloadForTests,
};
