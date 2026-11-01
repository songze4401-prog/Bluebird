/* global module, __dirname */
/**
 * Task Store 接口（阶段 3）。
 *
 * 业务层只依赖这里声明的读写接口，不直接碰文件名或 JSON 结构：
 *   read()  → { store, migrated, fromVersion }
 *   write(store)
 *   migrate(raw)
 *
 * 当前实现是单机原子文件（writeFileAtomicSync），并由进程启动时的单实例锁
 * 保证只有一个写者。未来替换 SQLite/PostgreSQL 时保持同一接口即可。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TASKS_FILE = path.join(AGENTS_DIR, 'agent-tasks.json');

// v1：任务基础字段；v2：阶段 2/3 的 run/checkpoint/lease/重试元数据。
const SCHEMA_VERSION = 2;
const SUPPORTED_VERSIONS = Object.freeze([1, 2]);

function empty() {
  return { version: SCHEMA_VERSION, tasks: {} };
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
  add('contractVersion', 1);
  add('priority', 'normal');
  add('contextRef', null);
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
