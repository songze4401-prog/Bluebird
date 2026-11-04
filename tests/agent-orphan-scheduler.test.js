/**
 * 孤儿清理调度回归（Phase 1 收口 B）。
 *
 * 断言口径：
 *  a) 启动跑一次 + 周期跑（默认 6 小时，A 类），用假定时器触发，不真等一小时；
 *  b) 单实例防重入：上一轮没结束就跳过本轮，不叠跑；
 *  c) 清理失败不影响主流程：不抛、记错误、下一轮照常；
 *  d) TTL 边界：差一毫秒不删，正好到期才删；
 *  e) 崩溃/停机不补跑：漏掉的周期不会被追补（只证明"不补跑"，不声称准时）。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-orphan-scheduler-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const { DEFAULT_INTERVAL_MS, createCleanupScheduler } = require('../server/agents/orphan-scheduler');

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return { id, unref() {} };
    },
    clearTimer(handle) {
      pending.delete(handle.id);
    },
    /** 触发所有已挂定时器一次（模拟"时间到"），返回触发个数。 */
    tick() {
      const batch = [...pending.entries()];
      pending.clear();
      for (const [, item] of batch) item.fn();
      return batch.length;
    },
    count() {
      return pending.size;
    },
    delay() {
      const first = [...pending.values()][0];
      return first ? first.ms : null;
    },
  };
}

function noopLogger() {
  return { warn() {} };
}

test('调度默认周期为 A 类 6 小时', () => {
  assert.strictEqual(DEFAULT_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('启动跑一次 + 周期跑一次：假定时器触发，不真等', () => {
  const timers = fakeTimers();
  let calls = 0;
  const scheduler = createCleanupScheduler({
    cleanup: () => {
      calls += 1;
      return { scanned: 0, cleaned: [], kept: [], ttlMs: 1 };
    },
    logger: noopLogger(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1000,
  });

  const started = scheduler.start({ now: 1000 });
  assert.strictEqual(started.started, true);
  assert.strictEqual(calls, 1, '启动必须立刻清一次');
  assert.strictEqual(timers.delay(), DEFAULT_INTERVAL_MS);
  assert.strictEqual(timers.count(), 1, '启动清理之后只挂一个周期');

  timers.tick();
  assert.strictEqual(calls, 2, '周期触发再清一次');
  assert.strictEqual(scheduler.stats().runs, 2);
  assert.strictEqual(scheduler.stats().lastRunAt, 1000);
  // 触发后重新挂上下一个周期（一次只挂一个，不叠加）
  assert.strictEqual(timers.count(), 1);

  // 重复 start 不会叠加定时器
  const again = scheduler.start({ now: 2000 });
  assert.strictEqual(again.alreadyStarted, true);
  assert.strictEqual(calls, 2);
  assert.strictEqual(timers.count(), 1);
  scheduler.stop();
});

test('单实例防重入：上一轮未结束时跳过本轮，不叠跑', () => {
  const timers = fakeTimers();
  let calls = 0;
  let scheduler = null;
  scheduler = createCleanupScheduler({
    cleanup: () => {
      calls += 1;
      // 清理过程中再次被触发（定时器/手工都可能）：必须被挡下
      const inner = scheduler.runOnce({ now: 5 });
      assert.strictEqual(inner.ran, false);
      assert.strictEqual(inner.reason, 'already_running');
      return { scanned: 0, cleaned: [], kept: [], ttlMs: 1 };
    },
    logger: noopLogger(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.start({ now: 5 });
  assert.strictEqual(calls, 1);
  assert.strictEqual(scheduler.stats().skipped, 1);
  assert.strictEqual(scheduler.stats().runs, 1);
  scheduler.stop();
});

test('清理失败不影响主流程：不抛、记错误、下一轮照常', () => {
  const timers = fakeTimers();
  let attempt = 0;
  const scheduler = createCleanupScheduler({
    cleanup: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('disk_unavailable');
      return { scanned: 0, cleaned: ['art_x'], kept: [], ttlMs: 1 };
    },
    logger: noopLogger(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  let outcome = null;
  assert.doesNotThrow(() => {
    outcome = scheduler.start({ now: 10 });
  });
  assert.strictEqual(outcome.first.ok, false);
  assert.strictEqual(scheduler.stats().failures, 1);
  assert.strictEqual(scheduler.stats().lastError, 'disk_unavailable');
  assert.strictEqual(timers.count(), 1, '失败后仍要挂下一轮');

  timers.tick();
  assert.strictEqual(attempt, 2);
  assert.strictEqual(scheduler.stats().failures, 1, '成功轮不增加失败计数');
  assert.strictEqual(scheduler.stats().lastError, null);
  assert.strictEqual(scheduler.stats().lastCleaned, 1);
  scheduler.stop();
});

test('崩溃/停机不补跑：挂起期间漏掉的周期不会被追补', () => {
  const timers = fakeTimers();
  let calls = 0;
  const scheduler = createCleanupScheduler({
    cleanup: () => {
      calls += 1;
      return { scanned: 0, cleaned: [], kept: [], ttlMs: 1 };
    },
    logger: noopLogger(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1000,
  });
  scheduler.start();
  // 模拟进程挂起 3 个周期：时间跳了，但没有任何回调被真正执行
  timers.tick();
  assert.strictEqual(calls, 2, '只执行启动 + 被触发的那一次，其余周期不补');
  assert.strictEqual(scheduler.stats().runs, 2);
  scheduler.stop();
});

test('TTL 边界：差一毫秒不删，正好到期才删', () => {
  const T0 = 1_700_000_000_000;
  const ttlMs = 60 * 1000;
  const artifact = artifactStore.persist({
    kind: 'message',
    content: { text: '待清理孤儿' },
    taskId: 'task_orphan_ttl',
    now: T0,
  });

  const justBefore = artifactCommit.cleanupOrphans({ now: T0 + ttlMs - 1, ttlMs });
  assert.deepStrictEqual(justBefore.cleaned, []);
  assert.ok(
    justBefore.kept.some(item => item.id === artifact.id && item.reason === 'ttl_not_expired')
  );
  assert.ok(artifactStore.get(artifact.id), '差一毫秒不得删除');

  const atTtl = artifactCommit.cleanupOrphans({ now: T0 + ttlMs, ttlMs });
  assert.deepStrictEqual(atTtl.cleaned, [artifact.id]);
  assert.strictEqual(artifactStore.get(artifact.id), null, '正好到期才删');
});
