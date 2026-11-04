/* global module */
/**
 * 仅测试用的崩溃注入钩子（P5）。
 *
 * 用途：让子进程精确停在某个中间态，父进程看到 marker 后发真 SIGKILL。
 * 没有钩子就只能靠轮询「猜」窗口，杀点随机，用例等于没测。
 *
 * 纪律：
 * - 未设置 BLUEBIRD_TEST_CRASH_HOOK 时，每个调用点只做一次字符串比较，零副作用；
 * - 命中后先同步写 marker（父进程据此确认「已经到窗口」），再阻塞事件循环；
 * - 最多阻塞 BLUEBIRD_TEST_CRASH_HOLD_MS（默认 30s），没被杀掉就返回，
 *   让用例以「父进程超时」失败，而不是把测试进程永久挂住。
 */
const fs = require('fs');
const path = require('path');

const POINT = String(process.env.BLUEBIRD_TEST_CRASH_HOOK || '');
const MARKER_DIR = String(process.env.BLUEBIRD_TEST_CRASH_MARKER_DIR || '');
const HOLD_MS = Math.max(1000, Number(process.env.BLUEBIRD_TEST_CRASH_HOLD_MS) || 30000);

function hold(point) {
  if (!POINT || POINT !== point) return;
  try {
    const dir = MARKER_DIR || process.cwd();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `crash-${process.pid}-${point}.json`),
      JSON.stringify({ pid: process.pid, point, at: new Date().toISOString() }),
      'utf8'
    );
  } catch (_) {
    // marker 写不出来也不能让进程继续跑；下面的阻塞仍然生效，父进程按超时报错。
  }
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    Atomics.wait(cell, 0, 0, 50);
  }
}

module.exports = { hold, POINT };
