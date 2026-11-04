/* global module, __dirname */
/**
 * Task Store 接口（阶段 3）。
 *
 * 本文件是 `agent-tasks.json` 这张任务表的唯一事实源，范围只覆盖这一个文件：
 *   read()  → { store, migrated, fromVersion }
 *   write(store)
 *   migrate(raw)
 *
 * 业务层只依赖这里声明的读写接口，不直接碰文件名或 JSON 结构；但这只是约定
 * 边界——read() 返回可变对象，业务层仍会直接改字段，落盘必须走 saveTasks → write()。
 * 事件/outbox（agent-events.json、agent-event-outbox.json）与 Session、Approval
 * 各自有独立 store，不归本文件管辖；事件仅通知/审计，不拥有事实权威。
 * 当前实现是单机原子文件（writeFileAtomicSync），并由进程启动时的单实例锁
 * 保证只有一个写者。未来替换 SQLite/PostgreSQL 时保持同一接口即可。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');
const { CONTRACT_VERSION } = require('./contract');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TASKS_FILE = path.join(AGENTS_DIR, 'agent-tasks.json');

// v1：任务基础字段；v2：阶段 2/3 的 run/checkpoint/lease/重试元数据。
const SCHEMA_VERSION = 2;
const SUPPORTED_VERSIONS = Object.freeze([1, 2]);

function empty() {
  return { version: SCHEMA_VERSION, tasks: {}, tokenRuns: {} };
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function setIfMissing(task, key, value) {
  if (task[key] === undefined) {
    task[key] = value;
    return true;
  }
  return false;
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return false;
  let changed = false;
  const add = (key, value) => {
    if (setIfMissing(task, key, value)) changed = true;
  };
  add('agentId', task.botId || null);
  add('workerSessionId', task.sessionId || null);
  add('contractVersion', CONTRACT_VERSION);
  add('priority', 'normal');
  add('contextRef', null);
  // S8：计划版本指针的只读默认视图。故意不参与 migrated 判定——仅因新增
  // 两个可空键就改写旧文件会破坏“旧数据原文件字节不变”的读边界；
  // 首次真实写入（任何业务变更落盘）时再自然带出。
  if (task.planId === undefined) task.planId = null;
  if (task.planVersion === undefined) task.planVersion = null;
  // ② CAS：任务记录的单调递增版本，由存储层在每次真实写入时分配。
  // 与 S8 同一读边界策略——默认值不参与 migrated 判定，旧文件不被重写；
  // 首次业务写入时自然带出。它不是 checkpointVersion（后者是检查点序号）。
  if (task.stateVersion === undefined) task.stateVersion = 0;
  add('idempotencyKey', null);
  add('route', null);
  add('budget', null);
  add('runId', null);
  add('runStartedAt', null);
  add('heartbeatAt', null);
  add('checkpoint', null);
  // 阶段 3：租约、重试与运行历史。
  add('lease', null);
  add('retryAt', null);
  add('lastErrorCode', null);
  add('checkpointVersion', 0);
  add('runs', []);
  add('requiresReview', false);
  // B-06：Token 原子计量的默认视图。与 stateVersion 同一读边界策略——只补默认值，
  // 不参与 migrated 判定，旧任务原文件字节不变；首次真实写入时自然带出。
  if (task.tokenUsage === undefined) task.tokenUsage = { reserved: 0, used: 0 };
  if (task.parentTaskId === undefined) task.parentTaskId = null;
  if (task.budgetRunId === undefined) task.budgetRunId = null;
  return changed;
}

function migrate(raw) {
  if (!raw) {
    return { store: empty(), migrated: false, fromVersion: null };
  }
  if (
    !SUPPORTED_VERSIONS.includes(raw.version) ||
    !raw.tasks ||
    typeof raw.tasks !== 'object' ||
    Array.isArray(raw.tasks)
  ) {
    throw new AgentError('agent_tasks_corrupted', 'Bot 任务存储结构无效', 500);
  }
  const fromVersion = raw.version;
  let changed = false;
  if (raw.version !== SCHEMA_VERSION) {
    raw.version = SCHEMA_VERSION;
    changed = true;
  }
  // B-06：Run 级 token 预算账本与任务同文件、同单写者。缺省时不参与 migrated 判定，
  // 只有真实预算写入才落盘；结构非法则按损坏处理，避免静默丢账。
  if (raw.tokenRuns === undefined) {
    raw.tokenRuns = {};
  } else if (typeof raw.tokenRuns !== 'object' || Array.isArray(raw.tokenRuns)) {
    throw new AgentError('agent_tasks_corrupted', 'Bot 任务存储结构无效', 500);
  }
  for (const task of Object.values(raw.tasks)) {
    if (normalizeTask(task)) changed = true;
  }
  return { store: raw, migrated: changed, fromVersion };
}

function read() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) {
    return { store: empty(), migrated: false, fromVersion: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_tasks_corrupted', 'Bot 任务数据文件无法解析', 500);
  }
  return migrate(parsed);
}

function write(store) {
  ensureDir();
  writeFileAtomicSync(TASKS_FILE, JSON.stringify(store, null, 2));
}

module.exports = {
  TASKS_FILE,
  SCHEMA_VERSION,
  empty,
  migrate,
  read,
  write,
  normalizeTask,
};
