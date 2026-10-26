#!/usr/bin/env node
/* eslint-env node */
/**
 * Bluebird 备份告警 notifier —— BLUEBIRD_ALERT_CMD 的真实实现。
 *
 * 由 scripts/bluebird-backup-check-alert.js 在检测到备份异常时调用：
 *   BLUEBIRD_ALERT_CMD="<node 绝对路径> <本脚本绝对路径>"
 * 看门狗通过环境变量 BLUEBIRD_ALERT_PAYLOAD 传入告警 JSON（record，不含密钥）。
 *
 * 两个投递通道：
 *   1. 本地持久日志：<outRoot>/_state/notify.log（追加，脱敏）
 *   2. Windows 应用事件日志：eventcreate /T ERROR /ID 500 /L APPLICATION /SO BluebirdBackup
 *
 * 退出码：仅当两个通道都成功时为 0；否则非 0。
 * 语义：看门狗据此把「notifier 未成功」如实记为 exitCode!=0，
 *       绝不会把「已尝试但失败」误记为成功。
 *
 * 零第三方依赖（仅 node 内置 + 系统 eventcreate.exe）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EVENT_ID = 500;
const EVENT_SOURCE = 'BluebirdBackup';

function sanitize(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w .:/@+=,()\-]/g, '?')
    .slice(0, max)
    .trim();
}

function readPayload() {
  const raw = process.env.BLUEBIRD_ALERT_PAYLOAD || '';
  if (!raw) return { ok: false, payload: null };
  try {
    return { ok: true, payload: JSON.parse(raw) };
  } catch (_) {
    return { ok: false, payload: null };
  }
}

function appendNotifyLog(outRoot, line) {
  if (!outRoot) return true; // 无 outRoot 时该通道不适用
  try {
    const dir = path.join(outRoot, '_state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'notify.log'), `${JSON.stringify(line)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function writeEventLog(message) {
  // 默认使用系统 eventcreate；BLUEBIRD_EVENTCREATE_BIN 仅供测试注入（生产不设）
  const eventcreate =
    process.env.BLUEBIRD_EVENTCREATE_BIN ||
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'eventcreate.exe');
  const res = spawnSync(
    eventcreate,
    ['/T', 'ERROR', '/ID', String(EVENT_ID), '/L', 'APPLICATION', '/SO', EVENT_SOURCE, '/D', message],
    { encoding: 'utf8', windowsHide: true }
  );
  if (res.error) return { ok: false, error: res.error.code || 'spawn_error' };
  return { ok: res.status === 0, status: res.status };
}

function main() {
  const { ok, payload } = readPayload();
  const kind = ok ? sanitize(payload.kind, 60) : 'unknown';
  const reason = ok ? sanitize(payload.reason, 80) : 'missing_or_invalid_payload';
  const exitCode = ok && payload.exitCode != null ? payload.exitCode : null;
  const ts = ok && payload.ts ? sanitize(payload.ts, 40) : new Date().toISOString();
  const outRoot = ok && payload.outRoot ? String(payload.outRoot) : '';

  const notifiedAt = new Date().toISOString();
  const message = sanitize(
    `Bluebird backup alert: kind=${kind} reason=${reason} exit=${exitCode} at=${ts}`
  );

  const logOk = appendNotifyLog(outRoot, {
    ts,
    kind,
    reason,
    exitCode,
    notifiedAt,
    channel: 'notify.log',
  });

  const ev = writeEventLog(message);

  const success = logOk && ev.ok;
  // 仅输出脱敏状态，绝不打印原始 payload
  process.stdout.write(
    `${JSON.stringify({
      notifier: 'bluebird-alert-notify',
      success,
      logOk,
      eventLogOk: ev.ok,
      eventLogStatus: ev.status == null ? null : ev.status,
      kind,
      reason,
      exitCode,
      notifiedAt,
    })}\n`
  );

  return success ? 0 : 1;
}

module.exports = { main, sanitize };

if (require.main === module) {
  process.exitCode = main();
}
