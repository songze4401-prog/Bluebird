/* global module, process */
/**
 * 孤儿清理调度（Phase 1 收口 B）：把 artifactCommit.cleanupOrphans 挂到生产节奏上。
 *
 * 行为契约（不夸大）：
 * - 启动跑一次，之后按固定间隔周期跑；**单实例防重入**：上一轮没结束就跳过本轮，
 *   不叠加执行（跳过计入 skipped，不当成错误）。
 * - 清理失败不让服务崩：捕获、记日志、计入 failures，下一轮照常尝试。
 * - **不补跑**：进程崩溃/停机期间漏掉的周期不会被追补，重启只多跑一次启动清理。
 * - **不声称准时**：Interval 基于 setTimeout，进程挂起、休眠、长任务都会让实际间隔
 *   大于配置值；页面/运维不能把它当定时器 SLA。
 *
 * 数值口径：周期 A 类，默认 6 小时（安全默认值，待实测校准），可用
 * BLUEBIRD_AGENT_ARTIFACT_CLEANUP_INTERVAL_MS 覆盖（0 表示关闭周期、只跑启动清理）。
 */
const artifactCommit = require('./artifact-commit');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function intervalFromEnv() {
  const raw = Number(process.env.BLUEBIRD_AGENT_ARTIFACT_CLEANUP_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_INTERVAL_MS;
  return raw;
}

function createCleanupScheduler({
  intervalMs = intervalFromEnv(),
  cleanup = options => artifactCommit.cleanupOrphans(options),
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const stats = {
    runs: 0,
    skipped: 0,
    failures: 0,
    lastRunAt: null,
    lastError: null,
    lastCleaned: null,
    running: false,
    started: false,
    intervalMs,
  };

  let timer = null;
  let inFlight = false;

  /**
   * 跑一轮。同步执行（cleanupOrphans 本身是同步的），因此额外用 inFlight 标记
   * 兜住"清理过程中再被触发"的情况（定时器回调、启动回调、手工触发都可能撞上）。
   */
  function runOnce(options = {}) {
    if (inFlight) {
      stats.skipped += 1;
      return { ran: false, reason: 'already_running' };
    }
    inFlight = true;
    stats.running = true;
    const at = now();
    try {
      const result = cleanup({ now: options.now === undefined ? at : options.now });
      stats.runs += 1;
      stats.lastRunAt = at;
      stats.lastError = null;
      stats.lastCleaned = Array.isArray(result && result.cleaned) ? result.cleaned.length : 0;
      return { ran: true, ok: true, result };
    } catch (error) {
      // 清理失败只记账，绝不冒泡到调用方（尤其不能让启动流程或定时器把服务带崩）。
      stats.runs += 1;
      stats.failures += 1;
      stats.lastRunAt = at;
      stats.lastError = (error && error.code) || (error && error.message) || 'cleanup_failed';
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[agent-artifact] 孤儿清理失败：${stats.lastError}`);
      }
      return { ran: true, ok: false, error: stats.lastError };
    } finally {
      inFlight = false;
      stats.running = false;
    }
  }

  function scheduleNext() {
    if (!(intervalMs > 0)) return;
    timer = setTimer(() => {
      timer = null;
      runOnce();
      scheduleNext();
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** 启动：先跑一次启动清理，再挂周期。重复调用不会叠加定时器。 */
  function start(options = {}) {
    if (stats.started) return { started: true, alreadyStarted: true, stats: snapshot() };
    stats.started = true;
    const first = runOnce(options);
    scheduleNext();
    return { started: true, alreadyStarted: false, first, stats: snapshot() };
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    stats.started = false;
  }

  function snapshot() {
    return { ...stats };
  }

  return { start, stop, runOnce, stats: snapshot };
}

module.exports = { DEFAULT_INTERVAL_MS, createCleanupScheduler };
