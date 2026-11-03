/* global require, process, __dirname */
/**
 * 阶段 4 Watchdog 回归。
 *
 * 覆盖：健康分类、动作计划（白名单/冷却/熔断）、暂停与恢复接单、
 * 服务停机时的受控恢复、存储/磁盘不可恢复时升级人工、审计字段、
 * dry-run 无副作用，以及外部 Supervisor 在服务被杀后重新拉起。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-watchdog-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';
delete process.env.BLUEBIRD_WATCHDOG_RESTART_CMD;
delete process.env.BLUEBIRD_ALERT_CMD;

const policy = require('../server/agents/watchdog-policy');
const intake = require('../server/agents/intake-control');
const tasks = require('../server/agents/tasks');
const taskStore = require('../server/agents/task-store');
const watchdog = require('../scripts/bluebird-watchdog');
const router = require('../server/agents/router');

const AGENTS_DIR = path.join(TMP, 'agents');

function reset() {
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, '.bluebird.lock'), { force: true });
  tasks.reloadForTests();
}

function policyWith(thresholds = {}, actions = {}) {
  return {
    ...policy.DEFAULT_POLICY,
    thresholds: { ...policy.DEFAULT_POLICY.thresholds, ...thresholds },
    actions: { ...policy.DEFAULT_POLICY.actions, ...actions },
    breaker: { ...policy.DEFAULT_POLICY.breaker },
  };
}

function staleTask(overrides = {}) {
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '卡死任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    ...overrides,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.updateTask(task.taskId, { heartbeatAt: '2026-10-01T00:00:00.000Z' });
  tasks.acquireLease(task.taskId, { ownerId: 'dead-worker', now: Date.now() - 120000, ttlMs: 1000 });
  return tasks.getTask(task.taskId);
}

function snapshot(overrides = {}) {
  return {
    now: Date.parse('2026-11-01T00:00:00.000Z'),
    service: { alive: true, lockPresent: true, pid: 1, startedAt: null },
    store: { ok: true },
    tasks: [],
    delivery: { failed: 0 },
    disk: { ok: true, freeBytes: 1024 * 1024 * 1024 },
    ...overrides,
  };
}

function auditLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ---- A. 健康分类 ----

test('健康：全部正常时没有 findings', () => {
  assert.deepEqual(policy.evaluate(snapshot()), []);
});

test('健康：租约过期被识别为 critical', () => {
  const findings = policy.evaluate(
    snapshot({
      tasks: [
        {
          taskId: 'task_1',
          status: 'running',
          heartbeatAt: '2026-10-31T23:59:50.000Z',
          lease: { expiresAt: '2026-10-31T23:59:00.000Z' },
        },
      ],
    })
  );
  assert.equal(findings[0].code, 'lease_expired');
  assert.equal(findings[0].severity, 'critical');
});

test('健康：心跳超时被识别为 critical', () => {
  const findings = policy.evaluate(
    snapshot({
      tasks: [
        {
          taskId: 'task_2',
          status: 'running',
          heartbeatAt: '2026-10-31T23:00:00.000Z',
        },
      ],
    }),
    policyWith({ heartbeatStaleMs: 1000 })
  );
  assert.equal(findings[0].code, 'heartbeat_stale');
  assert.equal(findings[0].taskId, 'task_2');
});

test('健康：队列积压与最老排队时间', () => {
  const tasksList = Array.from({ length: 3 }, (_, index) => ({
    taskId: `task_q${index}`,
    status: 'queued',
    createdAt: '2026-10-31T20:00:00.000Z',
  }));
  const findings = policy.evaluate(
    snapshot({ tasks: tasksList }),
    policyWith({ queueBacklog: 2, oldestQueuedMs: 1000 })
  );
  assert.ok(findings.some(item => item.code === 'queue_backlog'));
  assert.ok(findings.some(item => item.code === 'queue_oldest_stale'));
});

test('健康：存储不可读与磁盘不足都是 critical', () => {
  const findings = policy.evaluate(
    snapshot({ store: { ok: false, errorCode: 'agent_tasks_corrupted' }, disk: { ok: false } })
  );
  assert.ok(findings.some(item => item.code === 'store_unreadable'));
  assert.ok(findings.some(item => item.code === 'disk_low'));
});

test('健康：服务停机区分无锁与残留锁', () => {
  const findings = policy.evaluate(
    snapshot({ service: { alive: false, lockPresent: false, pid: null } })
  );
  assert.equal(findings.find(item => item.code === 'service_down').reason, 'no_lock');
  const stale = policy.evaluate(
    snapshot({ service: { alive: false, lockPresent: true, pid: 999999 } })
  );
  assert.equal(stale.find(item => item.code === 'service_down').reason, 'stale_lock');
});

test('健康：投递失败是 warn，不单独暂停接单', () => {
  const findings = policy.evaluate(snapshot({ delivery: { failed: 2 } }));
  assert.equal(findings[0].code, 'delivery_failed');
  assert.equal(findings[0].severity, 'warn');
  const actions = policy.planActions(findings, {}, { now: 1, paused: false });
  assert.ok(!actions.some(item => item.action === 'pause_intake'));
});

// ---- B. 动作计划：白名单、冷却、熔断 ----

test('动作：critical 会触发告警与暂停接单', () => {
  const findings = [{ code: 'queue_backlog', severity: 'critical', reason: '60' }];
  const actions = policy.planActions(findings, {}, { now: 1000, paused: false });
  assert.ok(actions.some(item => item.action === 'alert'));
  assert.ok(actions.some(item => item.action === 'pause_intake'));
});

test('动作：健康且已暂停时恢复接单', () => {
  const actions = policy.planActions([], {}, { now: 1000, paused: true });
  assert.ok(actions.some(item => item.action === 'resume_intake'));
});

test('动作：服务停机且允许时执行恢复', () => {
  const findings = [{ code: 'service_down', severity: 'critical', reason: 'no_lock' }];
  const actions = policy.planActions(findings, {}, {
    now: 1000,
    paused: false,
    serviceAlive: false,
  });
  assert.ok(actions.some(item => item.action === 'recover_interrupted'));
});

test('动作：服务存活时不做跨进程恢复', () => {
  const findings = [{ code: 'heartbeat_stale', severity: 'critical', reason: 'x' }];
  const actions = policy.planActions(findings, {}, {
    now: 1000,
    paused: false,
    serviceAlive: true,
  });
  assert.ok(!actions.some(item => item.action === 'recover_interrupted'));
});

test('动作：重启只在配置命令且动作开启时出现', () => {
  const findings = [{ code: 'service_down', severity: 'critical', reason: 'no_lock' }];
  const enabled = policyWith({}, { restart_service: true });
  const withCmd = policy.planActions(findings, {}, {
    now: 1000,
    policy: enabled,
    serviceAlive: false,
    restartConfigured: true,
  });
  assert.ok(withCmd.some(item => item.action === 'restart_service'));
  const withoutCmd = policy.planActions(findings, {}, {
    now: 1000,
    policy: enabled,
    serviceAlive: false,
    restartConfigured: false,
  });
  assert.ok(!withoutCmd.some(item => item.action === 'restart_service'));
  assert.ok(withoutCmd.some(item => item.action === 'escalate_manual'));
});

test('动作：冷却期内不重复执行', () => {
  const findings = [{ code: 'queue_backlog', severity: 'critical', reason: '60' }];
  const state = { actions: { pause_intake: { times: [1000] } } };
  const actions = policy.planActions(findings, state, {
    now: 1500,
    paused: false,
  });
  assert.ok(!actions.some(item => item.action === 'pause_intake'));
  assert.ok(actions.some(item => item.action === 'alert'));
});

test('动作：达到次数上限后熔断并升级人工', () => {
  const findings = [{ code: 'queue_backlog', severity: 'critical', reason: '60' }];
  const state = { actions: { pause_intake: { times: [1000, 2000, 3000] } } };
  const actions = policy.planActions(findings, state, {
    now: 4000,
    paused: false,
  });
  assert.ok(
    actions.some(
      item => item.action === 'escalate_manual' && item.reason === 'breaker_open:pause_intake'
    )
  );
  assert.ok(!actions.some(item => item.action === 'pause_intake'));
});

test('动作：存储/磁盘不可恢复时直接升级人工，不做恢复', () => {
  const findings = [
    { code: 'store_unreadable', severity: 'critical', reason: 'agent_tasks_corrupted' },
  ];
  const actions = policy.planActions(findings, {}, {
    now: 1000,
    paused: false,
    serviceAlive: false,
  });
  assert.ok(actions.some(item => item.action === 'escalate_manual'));
  assert.ok(!actions.some(item => item.action === 'recover_interrupted'));
});

test('熔断状态：窗口外的旧尝试不再计数', () => {
  const state = { actions: { alert: { times: [1, 2, 3] } } };
  const status = policy.breakerStatus(state, 'alert', 3 + 600001);
  assert.equal(status.attempts, 0);
  assert.equal(status.open, false);
});

// ---- C. Watchdog 实跑：恢复、暂停、升级、审计 ----

test('Watchdog：服务停机 + 租约过期 → 受控恢复只读任务并写审计', () => {
  reset();
  const task = staleTask();
  const result = watchdog.runOnce({ now: Date.now() });
  assert.ok(result.executed.some(item => item.action === 'recover_interrupted'));
  const recovered = tasks.getTask(task.taskId);
  assert.equal(recovered.status, 'queued');
  assert.notEqual(recovered.status, 'completed');
  const lines = auditLines(watchdog.AUDIT_FILE);
  const recovery = lines.find(item => item.action === 'recover_interrupted');
  assert.ok(recovery);
  assert.ok(recovery.ts);
  assert.ok(recovery.release);
  assert.equal(recovery.watchdog.pid, process.pid);
  assert.ok(recovery.result.recovered >= 1);
});

test('Watchdog：服务停机 + 写任务 → uncertain，不伪装成功', () => {
  reset();
  const task = staleTask({ allowedTools: ['memory_remember'] });
  watchdog.runOnce({ now: Date.now() });
  const recovered = tasks.getTask(task.taskId);
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.requiresReview, true);
  const lines = auditLines(watchdog.AUDIT_FILE);
  const recovery = lines.filter(item => item.action === 'recover_interrupted').at(-1);
  assert.ok(recovery.result.uncertain >= 1);
});

test('Watchdog：服务存活时只告警与暂停接单，不写任务状态', () => {
  reset();
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    path.join(TMP, '.bluebird.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  const task = staleTask();
  watchdog.runOnce({ now: Date.now() });
  assert.equal(tasks.getTask(task.taskId).status, 'running');
  assert.equal(intake.getState().paused, true);
  assert.ok(
    auditLines(watchdog.AUDIT_FILE).some(item => item.action === 'alert')
  );
  fs.rmSync(path.join(TMP, '.bluebird.lock'), { force: true });
});

test('Watchdog：暂停接单后 Router 明确拒绝，恢复后不再以该原因拒绝', () => {
  reset();
  fs.rmSync(path.join(TMP, '.bluebird.lock'), { force: true });
  intake.pause({ reason: 'queue_backlog' });
  assert.throws(
    () =>
      router.dispatch({
        agentId: 'memory',
        taskType: 'memory.search',
        goal: '暂停期间的新任务',
      }),
    error => error && error.code === 'agent_intake_paused' && error.status === 503
  );
  intake.resume();
  try {
    router.dispatch({ agentId: 'memory', taskType: 'memory.search', goal: '恢复后任务' });
  } catch (error) {
    assert.notEqual(error.code, 'agent_intake_paused');
  }
});

test('Watchdog：队列积压触发暂停，恢复后自动解除', () => {
  reset();
  fs.writeFileSync(
    path.join(TMP, '.bluebird.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  for (let i = 0; i < 3; i += 1) {
    tasks.createTask({
      botId: 'memory',
      taskType: 'memory.search',
      goal: `排队任务${i}`,
      allowedTools: ['memory_search'],
      deadlineMs: 20000,
    });
  }
  const configured = policyWith({ queueBacklog: 2 });
  const pauseRun = watchdog.runOnce({ now: Date.now(), policy: configured });
  assert.ok(pauseRun.actions.some(item => item.action === 'pause_intake'));
  assert.equal(intake.getState().paused, true);

  reset();
  fs.writeFileSync(
    path.join(TMP, '.bluebird.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  intake.pause({ reason: 'carry_over' });
  const resumeRun = watchdog.runOnce({ now: Date.now(), policy: configured });
  assert.ok(resumeRun.actions.some(item => item.action === 'resume_intake'));
  assert.equal(intake.getState().paused, false);
  fs.rmSync(path.join(TMP, '.bluebird.lock'), { force: true });
});

test('Watchdog：存储损坏升级人工，不触碰任务文件', () => {
  reset();
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const file = path.join(AGENTS_DIR, 'agent-tasks.json');
  fs.writeFileSync(file, '{broken');
  const before = fs.readFileSync(file, 'utf8');
  const result = watchdog.runOnce({ now: Date.now() });
  assert.ok(result.executed.some(item => item.action === 'escalate_manual'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(auditLines(watchdog.ESCALATION_FILE).length >= 1);
});

test('Watchdog：投递失败产生告警审计', () => {
  reset();
  const parent = { id: 's_parent' };
  const task = tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '投递失败任务',
    allowedTools: ['memory_search'],
    deadlineMs: 20000,
    parentSessionId: parent.id,
  });
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'failed' });
  tasks.updateTask(task.taskId, { deliveryStatus: 'failed', deliveryErrorCode: 'parent_session_missing' });
  watchdog.runOnce({ now: Date.now() });
  const alert = auditLines(watchdog.AUDIT_FILE).find(item => item.action === 'alert');
  assert.ok(alert);
  assert.match(alert.reason, /delivery_failed/);
});

test('Watchdog：dry-run 只计划动作，不写暂停文件也不恢复任务', () => {
  reset();
  const task = staleTask();
  const result = watchdog.runOnce({ now: Date.now(), dryRun: true });
  assert.ok(result.actions.length > 0);
  assert.equal(intake.getState().paused, false);
  assert.equal(tasks.getTask(task.taskId).status, 'running');
  assert.equal(auditLines(watchdog.AUDIT_FILE).length, 0);
});

test('Watchdog：重复运行不会重复恢复同一任务', () => {
  reset();
  const task = staleTask();
  watchdog.runOnce({ now: Date.now() });
  assert.equal(tasks.getTask(task.taskId).status, 'queued');
  watchdog.runOnce({ now: Date.now() + 30000 });
  const lines = auditLines(watchdog.AUDIT_FILE).filter(
    item => item.action === 'recover_interrupted'
  );
  assert.equal(lines.length, 1);
});

// ---- D. 外部 Supervisor ----

function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve(true);
      } catch (_) {
        // 继续等待
      }
      if (Date.now() > deadline) return reject(new Error('wait_timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('Supervisor：服务进程被杀后重新拉起，超过次数上限升级并退出', async () => {
  reset();
  const svcFile = path.join(TMP, 'svc.js');
  const pidFile = path.join(TMP, 'svc.pid');
  fs.writeFileSync(
    svcFile,
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`
  );
  const supervisor = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'bluebird-supervisor.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BLUEBIRD_DATA_DIR: TMP,
      BLUEBIRD_SUPERVISOR_CMD: `"${process.execPath}" "${svcFile}"`,
      BLUEBIRD_SUPERVISOR_MAX_RESTARTS: '1',
      BLUEBIRD_SUPERVISOR_BACKOFF_MS: '20',
    },
    stdio: 'ignore',
  });
  try {
    await waitFor(() => fs.existsSync(pidFile));
    const firstPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(firstPid > 0);
    process.kill(firstPid, 'SIGTERM');
    await waitFor(
      () =>
        fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')) !== firstPid
    );
    const secondPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.notEqual(secondPid, firstPid);
    process.kill(secondPid, 'SIGTERM');
    await new Promise(resolve => {
      supervisor.on('exit', code => {
        assert.equal(code, 3);
        resolve();
      });
      setTimeout(() => {
        try {
          supervisor.kill('SIGKILL');
        } catch (_) {}
        resolve();
      }, 8000);
    });
    const lines = auditLines(path.join(AGENTS_DIR, 'watchdog', 'supervisor.jsonl'));
    assert.ok(lines.some(item => item.action === 'restart_scheduled'));
    assert.ok(lines.some(item => item.action === 'escalate_manual'));
  } finally {
    try {
      supervisor.kill('SIGKILL');
    } catch (_) {
      // 已退出
    }
  }
});
