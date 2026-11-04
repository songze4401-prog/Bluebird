/**
 * Phase 1 / C3：Workflow Store 半截状态收敛（真 SIGKILL + 一条构造态）。
 *
 * c5 是**真崩溃**：子进程在 `plan.after-save`（计划已 fsync、任务尚未创建）被父进程
 * SIGKILL；父进程看到 marker 才杀，杀点由代码里的 crashHook.hold 固定，不靠轮询猜。
 *
 * c6 是**构造态**，不是真崩溃：手工制造「任务引用了不存在的计划」，验证启动解析
 * 会把它 fail-closed 到 recovery。真实流程里这一状态不可能出现（写序用例已守住），
 * 这里是为了证明「万一出现也不会静默续跑」。
 *
 * 本文件禁止静默 skip：注入点没命中、子进程没被杀、重启没收敛都直接失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'helpers', 'crash-child.js');

process.env.BLUEBIRD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-c3-parent-'));
const tasksModule = require('../server/agents/tasks');
const approvalsModule = require('../server/agents/approvals');
const ledgerModule = require('../server/agents/op-ledger');
const artifactModule = require('../server/agents/artifact-store');
const workflowModule = require('../server/agents/workflow-store');
const runtime = require('../server/agents/runtime');

const NAMES = {
  tasks: path.basename(tasksModule.TASKS_FILE),
  approvals: path.basename(approvalsModule.APPROVALS_FILE),
  ledger: path.basename(ledgerModule.LEDGER_FILE),
  artifacts: path.basename(artifactModule.ARTIFACTS_FILE),
  workflow: path.basename(workflowModule.WORKFLOW_FILE),
};

const KILL_TIMEOUT_MS = 25000;
const CHILD_TIMEOUT_MS = 45000;

function childEnv(dataDir, markerDir, scenario, hookName) {
  return {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    BLUEBIRD_CRASH_SCENARIO: scenario,
    BLUEBIRD_TEST_CRASH_HOOK: hookName,
    BLUEBIRD_TEST_CRASH_MARKER_DIR: markerDir,
    BLUEBIRD_TEST_CRASH_HOLD_MS: String(KILL_TIMEOUT_MS - 5000),
    DEEPSEEK_API_KEY: '',
    MEMORY_ENABLED: 'true',
    BLUEBIRD_AGENT_TOOLS: '',
    BLUEBIRD_MONITORING: '0',
    BLUEBIRD_ALLOW_PRIVATE_BASE_URL: '1',
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForMarker(markerDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
    if (files.length > 0) return path.join(markerDir, files[0]);
    sleepSync(50);
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function collect(root, predicate, out = []) {
  if (!root || typeof root !== 'object') return out;
  if (!Array.isArray(root) && predicate(root)) out.push(root);
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object') collect(value, predicate, out);
  }
  return out;
}

function diskSnapshot(dataDir) {
  const file = name => path.join(dataDir, 'agents', name);
  const task = collect(readJson(file(NAMES.tasks)), item =>
    typeof item.taskId === 'string' && typeof item.status === 'string'
  )[0] || null;
  const workflows = readJson(file(NAMES.workflow)) || {};
  const lineages = Object.values(workflows.plans || {});
  return {
    task: task
      ? {
          status: task.status,
          planId: task.planId || null,
          planVersion: Number.isInteger(task.planVersion) ? task.planVersion : null,
        }
      : null,
    plans: lineages.length,
    versions: lineages.reduce((sum, lineage) => sum + Object.keys(lineage.versions || {}).length, 0),
    refs: Object.keys(workflows.refs || {}).length,
    digests: lineages.flatMap(lineage =>
      Object.values(lineage.versions || {}).map(entry => entry.digest)
    ),
  };
}

async function inject(scenario, hookName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-c3-'));
  const markerDir = path.join(dataDir, 'markers');
  fs.mkdirSync(markerDir);

  const child = spawn(process.execPath, [CHILD], {
    env: childEnv(dataDir, markerDir, scenario, hookName),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));

  const marker = waitForMarker(markerDir, KILL_TIMEOUT_MS);
  if (!marker) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`注入点未命中（${scenario}/${hookName}）：stdout=${stdout} stderr=${stderr}`);
  }

  const atKill = diskSnapshot(dataDir);
  child.kill('SIGKILL');
  const exit = await exited;
  assert.ok(
    exit.signal === 'SIGKILL' || exit.code !== 0,
    `子进程必须是被信号杀掉的，实际 ${JSON.stringify(exit)}`
  );

  return { dataDir, atKill, stdout, stderr, exit };
}

function restart(dataDir, scenario) {
  const result = spawnSync(process.execPath, [CHILD], {
    env: childEnv(dataDir, path.join(dataDir, 'markers-2'), scenario, ''),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    cwd: ROOT,
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`重启进程超时（${scenario}）`);
  }
  const line = (result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find(item => item.startsWith('CRASH_CHILD_JSON '));
  if (!line) {
    throw new Error(`重启进程没有输出观察 JSON：stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return JSON.parse(line.slice('CRASH_CHILD_JSON '.length));
}

test('c5. 计划已落盘、任务未创建 → 真 SIGKILL 后只剩孤儿计划，无悬空引用', { timeout: 90000 }, async () => {
  const shot = await inject('plan-after-save', 'plan.after-save');

  assert.strictEqual(shot.atKill.task, null, '杀点必须在任务创建之前');
  assert.strictEqual(shot.atKill.plans, 1, '计划必须已经落盘');
  assert.strictEqual(shot.atKill.versions, 1);
  assert.strictEqual(shot.atKill.refs, 0, '此刻还没有任何任务引用');
  assert.strictEqual(shot.atKill.digests.length, 1);

  const after = restart(shot.dataDir, 'plan-after-save-restart');

  assert.strictEqual(after.tasks.length, 0, '崩溃后不得凭空出现任务');
  assert.strictEqual(after.plans.ok, true, '计划 Store 必须可读');
  assert.strictEqual(after.plans.plans.length, 1, '已 fsync 的计划不会丢');
  assert.strictEqual(after.plans.plans[0].versions.length, 1);
  assert.deepStrictEqual(after.plans.plans[0].digests, shot.atKill.digests);
  assert.strictEqual(after.plans.refs, 0);
  assert.strictEqual(after.queuePlans.checked, 0, '没有绑定任务，解析计数为 0');
  assert.strictEqual(after.queuePlans.storeCorrupted, false);
  assert.strictEqual(after.queueRecovery.recovered, 0);

  console.log(
    `[c3-c5] atKill task=none plans=${shot.atKill.plans} versions=${shot.atKill.versions} refs=${shot.atKill.refs} | ` +
      `after tasks=${after.tasks.length} plans=${after.plans.plans.length} refs=${after.plans.refs} ` +
      `checked=${after.queuePlans.checked} storeCorrupted=${after.queuePlans.storeCorrupted}`
  );
});

test('c6. 构造态（非真崩溃）：任务引用了不存在的计划 → 启动解析 fail-closed', { timeout: 60000 }, () => {
  // ---------- 构造态，不是真崩溃 ----------
  // 真实写序不允许出现这一状态（见 tests/agent-workflow-binding.test.js 用例 1/3）；
  // 这里手工制造它，证明「万一出现」也不会被当成「无计划」继续跑。
  const legacy = tasksModule.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '构造态：引用不存在的计划',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: 'plan_never_saved',
    planVersion: 1,
  });
  const healthyPlan = workflowModule.createPlan({
    plan: {
      intent: 'general',
      enabled: true,
      layers: { history: true, summary: true, memory: true, knowledge: true },
      budgets: { history: { recentBudgetTokens: 3200 } },
      noAnswerThreshold: 0.04,
      reasons: ['constructed_state'],
    },
  });
  const healthy = tasksModule.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: '构造态对照：计划存在',
    allowedTools: ['memory_search'],
    deadlineMs: 30000,
    planId: healthyPlan.planId,
    planVersion: 1,
  });

  const summary = runtime.convergeWorkflowPlans({ now: 1900000000000 });

  const after = tasksModule.getRawTask(legacy.taskId);
  assert.strictEqual(after.status, 'recovery');
  assert.strictEqual(after.errorCode, 'plan_missing');
  assert.strictEqual(after.requiresReview, true);

  const control = tasksModule.getRawTask(healthy.taskId);
  assert.strictEqual(control.status, 'queued', '有计划的对照任务不得被误伤');
  assert.strictEqual(workflowModule.getRef(healthy.taskId).planVersion, 1);

  assert.strictEqual(summary.failed, 1);
  assert.deepStrictEqual(summary.errorCodes, { plan_missing: 1 });

  console.log(
    `[c3-c6] constructed=true dangling=${after.status}/${after.errorCode} control=${control.status} ` +
      `refs=${workflowModule.listRefs().length}`
  );
});
