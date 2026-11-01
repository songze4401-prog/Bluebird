/* global module */
/**
 * Watchdog 确定性策略（阶段 4）。
 *
 * 只做两件事：把健康快照归类成 findings，再按白名单、次数上限、冷却时间
 * 与熔断生成动作。这里不执行任何命令、不写文件；执行与审计在
 * scripts/bluebird-watchdog.js。禁止模型生成的动作进入本模块。
 */

const DEFAULT_POLICY = Object.freeze({
  thresholds: Object.freeze({
    heartbeatStaleMs: 30000,
    leaseStaleMs: 45000,
    queueBacklog: 50,
    oldestQueuedMs: 10 * 60 * 1000,
    diskFreeBytes: 200 * 1024 * 1024,
  }),
  actions: Object.freeze({
    alert: true,
    pause_intake: true,
    resume_intake: true,
    recover_interrupted: true,
    restart_service: false,
  }),
  breaker: Object.freeze({ windowMs: 10 * 60 * 1000, maxAttempts: 3, cooldownMs: 60000 }),
});

const PAUSE_CODES = new Set([
  'service_down',
  'queue_backlog',
  'queue_oldest_stale',
  'store_unreadable',
  'disk_low',
  'heartbeat_stale',
  'lease_expired',
]);
const NON_RECOVERABLE_CODES = new Set(['store_unreadable', 'disk_low']);

function ageMs(value, now) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - parsed);
}

function evaluate(snapshot = {}, policy = DEFAULT_POLICY) {
  const now = snapshot.now || Date.now();
  const findings = [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  let queued = 0;
  let oldestQueuedAt = null;
  for (const task of tasks) {
    if (task.status === 'queued') {
      queued += 1;
      if (!oldestQueuedAt || String(task.createdAt) < oldestQueuedAt) {
        oldestQueuedAt = task.createdAt || null;
      }
      continue;
    }
    if (task.status !== 'accepted' && task.status !== 'running') continue;
    if (task.lease && Date.parse(task.lease.expiresAt) < now) {
      findings.push({
        code: 'lease_expired',
        severity: 'critical',
        reason: task.lease.ownerId || 'lease_expired',
        taskId: task.taskId,
        runId: task.runId || null,
      });
      continue;
    }
    const last = task.heartbeatAt || task.runStartedAt || task.updatedAt || task.createdAt;
    if (ageMs(last, now) > policy.thresholds.heartbeatStaleMs) {
      findings.push({
        code: 'heartbeat_stale',
        severity: 'critical',
        reason: 'heartbeat_stale',
        taskId: task.taskId,
        runId: task.runId || null,
      });
    }
  }
  if (queued > policy.thresholds.queueBacklog) {
    findings.push({ code: 'queue_backlog', severity: 'critical', reason: `${queued}` });
  }
  if (oldestQueuedAt && ageMs(oldestQueuedAt, now) > policy.thresholds.oldestQueuedMs) {
    findings.push({ code: 'queue_oldest_stale', severity: 'critical', reason: oldestQueuedAt });
  }
  if (snapshot.store && snapshot.store.ok === false) {
    findings.push({
      code: 'store_unreadable',
      severity: 'critical',
      reason: snapshot.store.errorCode || 'store_unreadable',
    });
  }
  if (snapshot.disk && snapshot.disk.ok === false) {
    findings.push({ code: 'disk_low', severity: 'critical', reason: 'disk_low' });
  }
  if (snapshot.service && snapshot.service.alive === false) {
    findings.push({
      code: 'service_down',
      severity: 'critical',
      reason: snapshot.service.lockPresent ? 'stale_lock' : 'no_lock',
    });
  }
  if (snapshot.delivery && Number(snapshot.delivery.failed) > 0) {
    findings.push({
      code: 'delivery_failed',
      severity: 'warn',
      reason: `${snapshot.delivery.failed}`,
    });
  }
  return findings;
}

function breakerStatus(state, action, now, policy = DEFAULT_POLICY) {
  const entry = (state && state.actions && state.actions[action]) || { times: [] };
  const times = Array.isArray(entry.times)
    ? entry.times.filter(ts => now - ts < policy.breaker.windowMs)
    : [];
  const last = times.length ? Math.max(...times) : 0;
  const cooldownActive = last > 0 && now - last < policy.breaker.cooldownMs;
  const open = times.length >= policy.breaker.maxAttempts;
  return { attempts: times.length, cooldownActive, open };
}

function recordAction(state, action, now) {
  const next = { actions: { ...(state && state.actions ? state.actions : {}) } };
  const entry = next.actions[action] || { times: [] };
  next.actions[action] = { times: [...entry.times, now] };
  return next;
}

function planActions(findings, state = {}, options = {}) {
  const now = options.now || Date.now();
  const policy = options.policy || DEFAULT_POLICY;
  const restartConfigured = options.restartConfigured === true;
  const serviceAlive = options.serviceAlive !== false;
  const paused = options.paused === true;
  const actions = [];
  const critical = findings.filter(item => item.severity === 'critical');
  const pauseWorthy = findings.filter(item => PAUSE_CODES.has(item.code));
  const blocked = findings.filter(item => NON_RECOVERABLE_CODES.has(item.code));
  const taskIds = [...new Set(critical.map(item => item.taskId).filter(Boolean))];
  const runIds = [...new Set(critical.map(item => item.runId).filter(Boolean))];

  const pushWithBreaker = (action, reason, extra = {}) => {
    if (!policy.actions[action]) return;
    const status = breakerStatus(state, action, now, policy);
    if (status.open) {
      actions.push({
        action: 'escalate_manual',
        reason: `breaker_open:${action}`,
        code: reason,
        ...extra,
      });
      return;
    }
    if (status.cooldownActive) return;
    actions.push({ action, reason, ...extra });
  };

  if (policy.actions.alert && findings.length) {
    pushWithBreaker('alert', findings.map(item => item.code).join(','), {
      taskIds,
      runIds,
    });
  }
  if (policy.actions.pause_intake && pauseWorthy.length && !paused) {
    pushWithBreaker('pause_intake', pauseWorthy[0].code);
  }
  if (policy.actions.resume_intake && paused && !pauseWorthy.length) {
    pushWithBreaker('resume_intake', 'healthy');
  }
  if (blocked.length) {
    actions.push({
      action: 'escalate_manual',
      reason: blocked[0].code,
      code: blocked[0].code,
    });
    return actions;
  }
  if (policy.actions.recover_interrupted && !serviceAlive) {
    pushWithBreaker('recover_interrupted', 'service_down', { taskIds, runIds });
  }
  if (policy.actions.restart_service && !serviceAlive && restartConfigured) {
    pushWithBreaker('restart_service', 'service_down');
  }
  if (!serviceAlive && !restartConfigured) {
    actions.push({ action: 'escalate_manual', reason: 'no_restart_command' });
  }
  return actions;
}

module.exports = {
  DEFAULT_POLICY,
  PAUSE_CODES,
  NON_RECOVERABLE_CODES,
  evaluate,
  planActions,
  breakerStatus,
  recordAction,
};
