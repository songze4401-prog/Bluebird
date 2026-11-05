/* global module, __dirname, process */
/**
 * §25 三个硬限：委派深度 / 重规划 / Run 重试。
 *
 * 原文依据（Notion v1.2 §25）：
 * - "委派深度最多 2 层（Root → Worker → Sub-worker；Sub-worker 只能请求支持，
 *   不能创建新的可写 Worker，不得再向下委派）。"
 * - "单 Task 重规划最多 2 次。"
 * - "Run 重试最多 3 次（不计首次执行）；达到上限后按失败结果终止或进入 recovery。"
 * - "以上计数必须持久化，重启后不得重置；重试不能重置计数。"
 *
 * 本实现把重规划计数统一收敛到 Run 维度（§26 "每 Run 最多 2 次重规划"），
 * Task 维度只记录、不单独放行，防止通过新建 Task 绕过上限。
 *
 * 计数落在独立的 agent-run-limits.json，读取即事实来源；模块不缓存计数，
 * 因此进程重启、模块重载都不会把计数清零。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');
const cycleDetection = require('./cycle-detection');

const MAX_DELEGATION_DEPTH = 2;
const MAX_REPLANS_PER_RUN = 2;
const MAX_RUN_RETRIES = 3;

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const LIMITS_FILE = path.join(AGENTS_DIR, 'agent-run-limits.json');
const SCHEMA_VERSION = 1;

function fingerprintOf(code, taskId, runId, causeRef) {
  return crypto
    .createHash('sha256')
    .update([code, taskId || '', runId || '', causeRef || ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}

// §23 七字段契约的本地最小构造；第 5 项会把同类构造收敛到 errors.js。
function limitError(code, status, message, { taskId = null, runId = null, causeRef = '' } = {}) {
  const details = {
    errorCode: code,
    retryable: false,
    errorFingerprint: fingerprintOf(code, taskId, runId, causeRef),
    failedAt: new Date().toISOString(),
    taskId,
    runId,
    causeRef,
  };
  return new AgentError(code, message, status, details);
}

function load() {
  if (!fs.existsSync(LIMITS_FILE)) {
    return { version: SCHEMA_VERSION, runs: {}, tasks: {}, updatedAt: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
  } catch (error) {
    throw limitError('internal_error', 500, `硬限计数不可读：${error.message}`, {
      causeRef: 'limits_store_unreadable',
    });
  }
  const runs = parsed && parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {};
  const taskCounts =
    parsed && parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {};
  return { version: SCHEMA_VERSION, runs, tasks: taskCounts, updatedAt: parsed && parsed.updatedAt };
}

function save(store) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  writeFileAtomicSync(LIMITS_FILE, JSON.stringify(store, null, 2));
}

function runKeyOf(runId, taskId) {
  if (runId) return String(runId);
  if (taskId) return `task:${taskId}`;
  return '';
}

function readRun(runId) {
  const store = load();
  const entry = store.runs[String(runId)] || { replans: 0, retries: 0 };
  return { runId: String(runId), replans: entry.replans || 0, retries: entry.retries || 0 };
}

/**
 * 委派链深度：根任务为 0。沿 parentTaskId 上行，遇到环立即拒绝（§17 委派环）。
 * tasksById 由调用方传入，模块自身不依赖 tasks，避免循环 require。
 */
function delegationDepth(taskId, tasksById) {
  // §17：委派环由独立检测器给出可读路径；检测到即拒绝（不继续上行）。
  const cycle = cycleDetection.findDelegationCycle(taskId, tasksById);
  if (cycle) {
    throw limitError(
      'not_authorized',
      403,
      `委派链存在环，拒绝继续委派：${cycle.join(' -> ')}`,
      { taskId, causeRef: 'delegation_cycle' }
    );
  }
  let depth = 0;
  let cursor = taskId;
  while (cursor) {
    const task = tasksById[cursor];
    if (!task || !task.parentTaskId) break;
    depth += 1;
    cursor = task.parentTaskId;
  }
  return depth;
}

function assertDelegationAllowed(parentTaskId, tasksById) {
  if (!parentTaskId) return 0;
  const parentDepth = delegationDepth(parentTaskId, tasksById);
  const childDepth = parentDepth + 1;
  if (childDepth > MAX_DELEGATION_DEPTH) {
    throw limitError('not_authorized', 403, `委派深度超过 ${MAX_DELEGATION_DEPTH} 层`, {
      taskId: parentTaskId,
      causeRef: 'delegation_depth_exceeded',
    });
  }
  return childDepth;
}

/** 记录一次重规划；Run 维度达到上限（2 次）后第 3 次直接拒绝。 */
function recordReplan({ runId = null, taskId = null } = {}) {
  const key = runKeyOf(runId, taskId);
  if (!key) {
    throw limitError('validation_failed', 400, '重规划计数缺少 Run 或 Task 归属', {
      taskId,
      causeRef: 'replan_scope_missing',
    });
  }
  const store = load();
  const entry = store.runs[key] || { replans: 0, retries: 0 };
  if (entry.replans >= MAX_REPLANS_PER_RUN) {
    throw limitError('validation_failed', 400, `Run 重规划次数已达上限 ${MAX_REPLANS_PER_RUN}`, {
      taskId,
      runId: runId || key,
      causeRef: 'replan_limit_exceeded',
    });
  }
  entry.replans += 1;
  store.runs[key] = entry;
  if (taskId) {
    const taskEntry = store.tasks[taskId] || { replans: 0 };
    taskEntry.replans += 1;
    store.tasks[taskId] = taskEntry;
  }
  save(store);
  return {
    runId: runId || key,
    replans: entry.replans,
    taskReplans: taskId ? store.tasks[taskId].replans : 0,
  };
}

/** 记录一次 Run 重试；第 4 次（不计首次执行）直接拒绝。 */
function recordRunRetry({ runId = null, taskId = null } = {}) {
  const key = runKeyOf(runId, taskId);
  if (!key) {
    throw limitError('validation_failed', 400, 'Run 重试计数缺少 Run 或 Task 归属', {
      taskId,
      causeRef: 'run_retry_scope_missing',
    });
  }
  const store = load();
  const entry = store.runs[key] || { replans: 0, retries: 0 };
  if (entry.retries >= MAX_RUN_RETRIES) {
    throw limitError('validation_failed', 400, `Run 重试次数已达上限 ${MAX_RUN_RETRIES}`, {
      taskId,
      runId: runId || key,
      causeRef: 'run_retry_limit_exceeded',
    });
  }
  entry.retries += 1;
  store.runs[key] = entry;
  save(store);
  return { runId: runId || key, retries: entry.retries };
}

function resetForTests() {
  if (fs.existsSync(LIMITS_FILE)) fs.rmSync(LIMITS_FILE);
}

module.exports = {
  MAX_DELEGATION_DEPTH,
  MAX_REPLANS_PER_RUN,
  MAX_RUN_RETRIES,
  LIMITS_FILE,
  delegationDepth,
  assertDelegationAllowed,
  recordReplan,
  recordRunRetry,
  readRun,
  resetForTests,
};
