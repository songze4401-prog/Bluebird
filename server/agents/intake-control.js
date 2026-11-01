/* global module, __dirname */
/**
 * 接单开关（阶段 4）。
 *
 * 由进程外 Watchdog 写入 `<DATA_DIR>/agents/intake-pause.json`；
 * Router 每次派发前读取。只暂停"接收新任务"，不中止已在运行的任务。
 * 文件不存在或无法解析时按"未暂停"处理——恢复接单不需要人工清障，
 * 但损坏会由 Watchdog 的健康检查单独告警。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PAUSE_FILE = path.join(DATA_DIR, 'agents', 'intake-pause.json');

function getState() {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return { paused: false, reason: null, at: null };
    const parsed = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    return {
      paused: parsed && parsed.paused === true,
      reason: parsed && typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : null,
      at: parsed && typeof parsed.at === 'string' ? parsed.at : null,
    };
  } catch (_) {
    return { paused: false, reason: null, at: null };
  }
}

function pause({ reason = 'watchdog_pause', at = new Date().toISOString(), by = 'watchdog' } = {}) {
  fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
  writeFileAtomicSync(
    PAUSE_FILE,
    JSON.stringify({ paused: true, reason, at, by }, null, 2)
  );
  return getState();
}

function resume() {
  try {
    fs.rmSync(PAUSE_FILE, { force: true });
  } catch (_) {
    // 取消失败时 Router 仍会拒绝接单，由下一次 Watchdog 运行重试。
  }
  return getState();
}

module.exports = { PAUSE_FILE, getState, pause, resume };
