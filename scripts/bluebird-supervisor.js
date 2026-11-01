#!/usr/bin/env node
/* global require, process, module, __dirname */
/**
 * 外部 Supervisor（阶段 4）。
 *
 * 由操作系统服务管理器（Windows 计划任务 / NSSM，systemd，容器 restart policy）
 * 拉起；它负责拉起并重启 Bluebird 主服务，不依赖服务进程内部逻辑。
 * 限额与退避：同一窗口内最多重启 N 次，超过即升级人工并退出（禁止无限重启）。
 * 所有动作写 `<DATA_DIR>/agents/watchdog/supervisor.jsonl`。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(ROOT, 'server', 'data');
const WATCHDOG_DIR = path.join(DATA_DIR, 'agents', 'watchdog');
const AUDIT_FILE = path.join(WATCHDOG_DIR, 'supervisor.jsonl');
const STARTED_AT = new Date().toISOString();
const COMMAND = process.env.BLUEBIRD_SUPERVISOR_CMD || 'node server/index.js';
const MAX_RESTARTS = Math.max(0, Number(process.env.BLUEBIRD_SUPERVISOR_MAX_RESTARTS) || 5);
const WINDOW_MS = Math.max(1000, Number(process.env.BLUEBIRD_SUPERVISOR_WINDOW_MS) || 600000);
const BACKOFF_MS = Math.max(10, Number(process.env.BLUEBIRD_SUPERVISOR_BACKOFF_MS) || 1000);
const RELEASE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch (_) {
    return 'unknown';
  }
})();

let child = null;
let stopping = false;
let starts = [];

function audit(entry) {
  try {
    fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
    fs.appendFileSync(
      AUDIT_FILE,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        release: RELEASE,
        supervisor: { pid: process.pid, startedAt: STARTED_AT },
        ...entry,
      })}\n`
    );
  } catch (_) {
    // 审计文件不可写不应阻止监督重启。
  }
}

function start(reason) {
  starts.push(Date.now());
  starts = starts.filter(ts => Date.now() - ts < WINDOW_MS);
  child = spawn(COMMAND, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  audit({
    action: 'start',
    reason,
    childPid: child.pid || null,
    restartsInWindow: starts.length - 1,
  });
  child.on('exit', (code, signal) => {
    audit({ action: 'exit', childPid: child ? child.pid : null, code, signal });
    if (stopping) {
      process.exit(0);
      return;
    }
    starts = starts.filter(ts => Date.now() - ts < WINDOW_MS);
    const restartsUsed = starts.length - 1;
    if (restartsUsed >= MAX_RESTARTS) {
      audit({
        action: 'escalate_manual',
        reason: 'restart_budget_exhausted',
        restartsUsed,
        maxRestarts: MAX_RESTARTS,
        windowMs: WINDOW_MS,
      });
      process.exit(3);
      return;
    }
    const delay = Math.min(30000, BACKOFF_MS * Math.pow(2, restartsUsed));
    audit({ action: 'restart_scheduled', delayMs: delay, restartsUsed });
    setTimeout(() => start('child_exit'), delay);
  });
}

function shutdown(signalName) {
  if (stopping) return;
  stopping = true;
  audit({ action: 'shutdown', signal: signalName, childPid: child ? child.pid : null });
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      // 子进程已退出。
    }
    setTimeout(() => process.exit(0), 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  start('initial');
}

module.exports = { start, audit, AUDIT_FILE };
