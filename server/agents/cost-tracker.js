/**
 * Phase 3 第 3 项：成本追踪。
 *
 * 只读既有数据，不新建账本：
 *  - 每条真实 usage 已随 attempt 落在 task.runs[].usage（recordRunFinish 写入）；
 *  - 预算结算在 tasks.settleTaskBudget，同一份 usage.total_tokens 作为 actual 累进
 *    task.tokenUsage.used 与 tokenRuns[runId].used；
 *  - 因祖先任务会重复计入子任务用量，逐任务聚合**只用自己 attempt 上的 usage**，
 *    不读 tokenUsage.used，从根上避免父子双计；
 *  - 没有 usage 的 attempt 进 unknown 桶（tokens 为 null），绝不按 0 或字符数估算。
 */
const tasks = require('./tasks');

const GROUP_BY = Object.freeze(['task', 'run']);

function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function inWindow(at, from, to) {
  if (from !== null && at < from) return false;
  if (to !== null && at > to) return false;
  return true;
}

function isoOrNull(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

function aggregate({ from = null, to = null, groupBy = 'task' } = {}) {
  if (!GROUP_BY.includes(groupBy)) {
    throw new RangeError(`groupBy 只支持 ${GROUP_BY.join('/')}`);
  }
  const window = { from: toMillis(from), to: toMillis(to) };
  const groups = new Map();
  const knownTasks = new Set();
  const unknownTasks = new Set();
  let totalTokens = 0;
  let attempts = 0;
  let knownAttempts = 0;
  let unknownAttempts = 0;

  for (const task of tasks.listAllTasks()) {
    for (const run of Array.isArray(task.runs) ? task.runs : []) {
      if (!run || !run.finishedAt) continue;
      const at = Date.parse(run.finishedAt);
      if (!Number.isFinite(at) || !inWindow(at, window.from, window.to)) continue;
      attempts += 1;
      const key = groupBy === 'run'
        ? (task.budgetRunId || run.runId || task.taskId)
        : task.taskId;
      if (!groups.has(key)) {
        groups.set(key, { key, tokens: 0, attempts: 0, unknownAttempts: 0, tasks: new Set() });
      }
      const bucket = groups.get(key);
      bucket.attempts += 1;
      bucket.tasks.add(task.taskId);
      const usage = run.usage;
      if (!usage || !Number.isFinite(Number(usage.total_tokens))) {
        unknownAttempts += 1;
        bucket.unknownAttempts += 1;
        unknownTasks.add(task.taskId);
        continue;
      }
      knownAttempts += 1;
      totalTokens += Number(usage.total_tokens);
      bucket.tokens += Number(usage.total_tokens);
      knownTasks.add(task.taskId);
    }
  }

  const rows = Array.from(groups.values())
    .map(group => ({
      key: group.key,
      tokens: group.tokens,
      attempts: group.attempts,
      unknownAttempts: group.unknownAttempts,
      tasks: group.tasks.size,
    }))
    .sort((left, right) => right.tokens - left.tokens || String(left.key).localeCompare(String(right.key)));

  return {
    from: isoOrNull(window.from),
    to: isoOrNull(window.to),
    groupBy,
    totalTokens,
    attempts,
    knownAttempts,
    unknownAttempts,
    tasks: knownTasks.size + unknownTasks.size,
    groups: rows,
    // 未知桶：tokens 恒为 null，调用方不得当成 0。
    unknown: { attempts: unknownAttempts, tasks: Array.from(unknownTasks).sort(), tokens: null },
    complete: unknownAttempts === 0,
  };
}

function taskCost(taskId, options = {}) {
  const key = String(taskId || '');
  const task = tasks.getTask(key);
  if (!task) return null;
  const scoped = aggregate({ ...options, groupBy: 'task' });
  const group = scoped.groups.find(item => item.key === key) || null;
  return {
    taskId: key,
    botId: task.botId,
    status: task.status,
    tokens: group ? group.tokens : 0,
    attempts: group ? group.attempts : 0,
    unknownAttempts: group ? group.unknownAttempts : 0,
    known: Boolean(group) && group.unknownAttempts === 0,
  };
}

function runCost(runId, options = {}) {
  const key = String(runId || '');
  if (!key) return null;
  const scoped = aggregate({ ...options, groupBy: 'run' });
  const group = scoped.groups.find(item => item.key === key) || null;
  const ledger = tasks.getRunUsage(key);
  return {
    runId: key,
    tokens: group ? group.tokens : 0,
    attempts: group ? group.attempts : 0,
    unknownAttempts: group ? group.unknownAttempts : 0,
    budgetUsed: ledger ? ledger.used : null,
    // 与预算账对得上：逐 attempt 的真实 usage 之和 == Run 账已结算 actual。
    consistentWithBudget: Boolean(group) && group.unknownAttempts === 0 && ledger
      ? group.tokens === ledger.used
      : null,
  };
}

module.exports = { GROUP_BY, aggregate, taskCost, runCost };
