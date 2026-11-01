#!/usr/bin/env node
/* global require, process, module, __dirname */
/**
 * 进程外 Watchdog（阶段 4）。
 *
 * 由操作系统服务管理器或外部 Supervisor 周期拉起；不在业务进程内运行。
 * 只读取数据目录、执行确定性动作：告警、暂停/恢复接单、服务停机时恢复任务、
 * 按配置重启服务、升级人工；所有动作写审计 JSONL，并受白名单、次数上限、
 * 冷却时间与熔断约束。禁止执行模型生成的命令——重启命令只来自部署配置。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeFileAtomicSync } = require('../server/atomic-write');
const taskStore = require('../server/agents/task-store');
const watchdogPolicy = require('../server/agents/watchdog-policy');
const intakeControl = require('../server/agents/intake-control');

const STARTED_AT = new Date().toISOString();
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'server', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const WATCHDOG_DIR = path.join(AGENTS_DIR, 'watchdog');
const AUDIT_FILE = path.join(WATCHDOG_DIR, 'watchdog.jsonl');
const ESCALATION_FILE = path.join(WATCHDOG_DIR, 'escalations.jsonl');
const STATE_FILE = path.join(WATCHDOG_DIR, 'state.json');
const LOCK_FILE = path.join(DATA_DIR, '.bluebird.lock');
const RELEASE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch (_) {
    return 'unknown';
  }
})();

function ensureDir() {
  fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readService() {
  try {
    const lock = readJson(LOCK_FILE);
    if (!lock) return { alive: false, lockPresent: false, pid: null, startedAt: null };
    return {
      alive: processAlive(Number(lock.pid)),
      lockPresent: true,
      pid: Number(lock.pid) || null,
      startedAt: typeof lock.startedAt === 'string' ? lock.startedAt : null,
    };
  } catch (_) {
    return { alive: false, lockPresent: true, pid: null, startedAt: null };
  }
}

function readStore() {
  try {
    const result = taskStore.read();
    const tasks = Object.values(result.store.tasks);
    return {
      store: { ok: true, schemaVersion: result.store.version },
      tasks,
      delivery: {
        failed: tasks.filter(
          task => task.deliveryStatus === 'failed' && task.parentSessionId
        ).length,
      },
    };
  } catch (error) {
    return {
      store: { ok: false, errorCode: (error && error.code) || 'store_unreadable' },
      tasks: [],
      delivery: { failed: 0 },
    };
  }
}

function readDisk() {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    return { ok: true, freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch (_) {
    return { ok: false, freeBytes: 0 };
  }
}

function collectSnapshot({ now = Date.now() } = {}) {
  const store = readStore();
  return {
    now,
    service: readService(),
    store: store.store,
    tasks: store.tasks,
    delivery: store.delivery,
    disk: readDisk(),
  };
}

function appendAudit(file, entry) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function loadState() {
  try {
    return readJson(STATE_FILE) || { actions: {} };
  } catch (_) {
    return { actions: {} };
  }
}

function saveState(state) {
  ensureDir();
  writeFileAtomicSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function auditBase() {
  return {
    ts: new Date().toISOString(),
    release: RELEASE,
    watchdog: { pid: process.pid, startedAt: STARTED_AT },
  };
}

function recoverInterrupted() {
  // 仅在服务确认停机时调用，避免与服务进程同时写任务 Store。
  const tasks = require('../server/agents/tasks');
  const resultDelivery = require('../server/agents/result-delivery');
  const recovered = tasks.recoverInterrupted({ ownerId: null });
  let delivery = null;
  try {
    delivery = resultDelivery.recoverPending();
  } catch (_) {
    delivery = { delivered: 0, failed: 0, errorCode: 'delivery_recovery_failed' };
  }
  return {
    recovered: recovered.recovered,
    uncertain: recovered.uncertain,
    leftRunning: recovered.leftRunning,
    taskIds: recovered.taskIds,
    uncertainTaskIds: recovered.uncertainTaskIds,
    delivery,
  };
}

function restartService() {
  const command = process.env.BLUEBIRD_WATCHDOG_RESTART_CMD;
  if (!command) return { ok: false, errorCode: 'restart_command_missing' };
  try {
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      [process.platform === 'win32' ? '/c' : '-c', command],
      { timeout: 60000, stdio: 'ignore', env: process.env }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, errorCode: (error && error.code) || 'restart_failed' };
  }
}

function runOnce(options = {}) {
  const now = options.now || Date.now();
  const policy = options.policy || watchdogPolicy.DEFAULT_POLICY;
  const snapshot = options.snapshot || collectSnapshot({ now });
  const state = options.state || loadState();
  const paused = intakeControl.getState().paused;
  const findings = watchdogPolicy.evaluate(snapshot, policy);
  const actions = watchdogPolicy.planActions(findings, state, {
    now,
    policy,
    serviceAlive: snapshot.service.alive,
    restartConfigured: Boolean(process.env.BLUEBIRD_WATCHDOG_RESTART_CMD),
    paused,
  });

  const executed = [];
  let nextState = state;
  for (const action of actions) {
    const entry = {
      ...auditBase(),
      action: action.action,
      reason: action.reason,
      code: action.code || null,
      taskIds: action.taskIds || [],
      runIds: action.runIds || [],
      result: 'planned',
      breaker: watchdogPolicy.breakerStatus(state, action.action, now, policy),
    };
    if (options.dryRun) {
      executed.push(entry);
      continue;
    }
    try {
      if (action.action === 'alert') {
        entry.result = 'alerted';
        appendAudit(AUDIT_FILE, entry);
        const alertCmd = process.env.BLUEBIRD_ALERT_CMD;
        if (alertCmd) {
          try {
            execFileSync(
              process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
              [process.platform === 'win32' ? '/c' : '-c', alertCmd],
              {
                timeout: 15000,
                stdio: 'ignore',
                env: { ...process.env, BLUEBIRD_ALERT_PAYLOAD: JSON.stringify(entry) },
              }
            );
          } catch (_) {
            entry.alertCommand = 'failed';
          }
        }
        nextState = watchdogPolicy.recordAction(nextState, 'alert', now);
      } else if (action.action === 'pause_intake') {
        intakeControl.pause({ reason: action.reason, at: new Date(now).toISOString() });
        entry.result = 'paused';
        appendAudit(AUDIT_FILE, entry);
        nextState = watchdogPolicy.recordAction(nextState, 'pause_intake', now);
      } else if (action.action === 'resume_intake') {
        intakeControl.resume();
        entry.result = 'resumed';
        appendAudit(AUDIT_FILE, entry);
        nextState = watchdogPolicy.recordAction(nextState, 'resume_intake', now);
      } else if (action.action === 'recover_interrupted') {
        entry.result = recoverInterrupted();
        appendAudit(AUDIT_FILE, entry);
        nextState = watchdogPolicy.recordAction(nextState, 'recover_interrupted', now);
      } else if (action.action === 'restart_service') {
        entry.result = restartService();
        appendAudit(AUDIT_FILE, entry);
        nextState = watchdogPolicy.recordAction(nextState, 'restart_service', now);
      } else if (action.action === 'escalate_manual') {
        entry.result = 'manual_required';
        appendAudit(AUDIT_FILE, entry);
        appendAudit(ESCALATION_FILE, entry);
      }
    } catch (error) {
      entry.result = { ok: false, errorCode: (error && error.code) || 'action_failed' };
      appendAudit(AUDIT_FILE, entry);
    }
    executed.push(entry);
  }
  if (!options.dryRun) saveState(nextState);
  return { findings, actions, executed, state: nextState };
}

if (require.main === module) {
  const summary = runOnce({ dryRun: process.argv.includes('--dry-run') });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const escalated = summary.executed.some(item => item.action === 'escalate_manual');
  process.exit(escalated ? 2 : 0);
}

module.exports = {
  AUDIT_FILE,
  ESCALATION_FILE,
  STATE_FILE,
  collectSnapshot,
  runOnce,
  readService,
};
