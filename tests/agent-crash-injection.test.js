/**
 * Phase 1 / P5：真崩溃注入（SIGKILL，不是状态模拟）。
 *
 * 每个用例分两段：
 *   1) 子进程执行到指定窗口 → 钩子把进程固定在窗口内并写 marker；
 *   2) 父进程看到 marker 后读磁盘快照、发 SIGKILL、再起一个进程按启动恢复流程收敛。
 *
 * 为什么能保证「每次都杀在同一个窗口」：注入点由代码里的 crashHook.hold('…')
 * 决定，marker 在阻塞之前同步落盘；父进程只在 marker 出现后才杀。不存在轮询猜状态。
 *
 * 本用例禁止静默 skip：注入点没命中、子进程没被杀、重启没收敛都直接失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'helpers', 'crash-child.js');

// 只为拿文件名（TASKS_FILE 等都带数据目录前缀，实际按 basename 映射到各场景目录）。
process.env.BLUEBIRD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5-parent-'));
const tasksModule = require('../server/agents/tasks');
const approvalsModule = require('../server/agents/approvals');
const ledgerModule = require('../server/agents/op-ledger');
const artifactModule = require('../server/agents/artifact-store');

const NAMES = {
  tasks: path.basename(tasksModule.TASKS_FILE),
  approvals: path.basename(approvalsModule.APPROVALS_FILE),
  ledger: path.basename(ledgerModule.LEDGER_FILE),
  artifacts: path.basename(artifactModule.ARTIFACTS_FILE),
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
  // 四个存储都在 <dataDir>/agents/ 下（各模块用 AGENTS_DIR 前缀）。
  const file = name => path.join(dataDir, 'agents', name);
  const task = collect(readJson(file(NAMES.tasks)), item =>
    typeof item.taskId === 'string' && typeof item.status === 'string'
  )[0] || null;
  const approval = collect(readJson(file(NAMES.approvals)), item =>
    typeof item.approvalId === 'string'
  )[0] || null;
  const ops = collect(readJson(file(NAMES.ledger)), item =>
    typeof item.opKey === 'string' && typeof item.status === 'string'
  );
  const artifacts = collect(readJson(file(NAMES.artifacts)), item =>
    typeof item.id === 'string' && typeof item.commit === 'string'
  );
  return {
    task: task ? { status: task.status, errorCode: task.errorCode || null } : null,
    approval: approval ? { status: approval.status, opKey: approval.opKey || null } : null,
    ledger: ops.map(row => ({ status: row.status, attempt: row.attempt, errorCode: row.errorCode || null })),
    artifacts: artifacts.map(item => ({ id: item.id, commit: item.commit })),
  };
}

async function inject(scenario, hookName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p5-'));
  const markerDir = path.join(dataDir, 'markers');
  fs.mkdirSync(markerDir);

  const child = spawn(process.execPath, [CHILD], {
    env: childEnv(dataDir, markerDir, scenario, hookName),
    stdio: ['ignore', 'pipe', 'pipe'],
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
  });
  const line = (result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find(item => item.startsWith('CRASH_CHILD_JSON '));
  if (!line) {
    throw new Error(`重启进程没有输出观察 JSON：stdout=${result.stdout} stderr=${result.stderr}`);
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`重启进程超时（${scenario}）`);
  }
  return JSON.parse(line.slice('CRASH_CHILD_JSON '.length));
}

test('c1. 工具已执行、结果未落账本 → 重启后 recovery、handler 不重跑、账本 unknown', { timeout: 90000 }, async () => {
  const shot = await inject('tool-after-handler', 'tool.after-handler');
  assert.equal(shot.atKill.task.status, 'running');
  assert.equal(shot.atKill.ledger.length, 1);
  assert.equal(shot.atKill.ledger[0].status, 'started');

  const after = restart(shot.dataDir, 'tool-after-handler-restart');

  assert.equal(after.task.status, 'recovery');
  assert.equal(after.task.errorCode, 'recovery_uncertain_side_effects');
  assert.equal(after.ledger.length, 1, 'handler 没有被重跑，账本仍只有一行');
  assert.equal(after.ledger[0].status, 'unknown');
  assert.equal(after.ledger[0].attempt, 1);
  assert.equal(after.sealedOps, 1);

  console.log(
    `[p5-c1] atKill task=${shot.atKill.task.status} ledger=${shot.atKill.ledger[0].status} | ` +
      `after task=${after.task.status}/${after.task.errorCode} ledger=${after.ledger[0].status} ` +
      `rows=${after.ledger.length} sealed=${after.sealedOps} handlerRerun=false`
  );
});

test('c2. 产物已写、任务状态未提交 → 重启后产物 pending、任务不假装完成', { timeout: 90000 }, async () => {
  const shot = await inject('artifact-after-persist', 'artifact.after-persist');
  assert.equal(shot.atKill.approval.status, 'completed');
  assert.equal(shot.atKill.ledger.length, 1);
  assert.equal(shot.atKill.ledger[0].status, 'succeeded');
  assert.equal(shot.atKill.artifacts.length, 1);
  assert.equal(shot.atKill.artifacts[0].commit, 'pending-commit');

  const after = restart(shot.dataDir, 'artifact-after-persist-restart');

  assert.equal(after.approval.status, 'completed');
  assert.equal(after.task.status, 'recovery', '任务不能因为产物已写就报 completed');
  assert.equal(after.artifacts.length, 1, '产物没有丢失');
  assert.equal(after.artifacts[0].commit, 'pending-commit', '产物没被误确认成 committed');
  assert.ok(after.artifactScan);
  assert.equal(after.artifactScan.scanned, 1);
  assert.equal(after.artifactScan.reconciled, 0, '没有任务引用，不能幂等关联');
  assert.equal(after.artifactScan.pending + after.artifactScan.orphaned, 1);

  console.log(
    `[p5-c2] atKill approval=${shot.atKill.approval.status} task=${shot.atKill.task.status} ` +
      `artifact=${shot.atKill.artifacts[0].commit} ledger=${shot.atKill.ledger[0].status} | ` +
      `after approval=${after.approval.status} task=${after.task.status} artifact=${after.artifacts[0].commit} ` +
      `scan(scanned=${after.artifactScan.scanned},reconciled=${after.artifactScan.reconciled},` +
      `orphaned=${after.artifactScan.orphaned},pending=${after.artifactScan.pending})`
  );
});

test('c3. 审批记录已落盘、任务未进 waiting_approval → 重启对齐，不悬空', { timeout: 90000 }, async () => {
  const shot = await inject('approval-after-record-save', 'approval.after-record-save');
  assert.equal(shot.atKill.approval.status, 'pending');
  assert.equal(shot.atKill.task.status, 'running');
  assert.equal(shot.atKill.ledger.length, 0, '还没执行，账本应为空');

  const after = restart(shot.dataDir, 'approval-after-record-save-restart');

  assert.equal(after.approvalRecovery.reconciled, 1);
  assert.equal(after.approvalRecovery.dangling, 0);
  assert.equal(after.task.status, 'waiting_approval', '任务被推回等待态，不是永久悬空');
  assert.equal(after.approval.status, 'pending');

  console.log(
    `[p5-c3] atKill approval=${shot.atKill.approval.status} task=${shot.atKill.task.status} | ` +
      `after reconciled=${after.approvalRecovery.reconciled} dangling=${after.approvalRecovery.dangling} ` +
      `task=${after.task.status} approval=${after.approval.status}`
  );
});

test('c4. 正常执行中途崩溃（无副作用工具）→ 重启后有确定去向，不悬空', { timeout: 90000 }, async () => {
  const shot = await inject('task-after-running', 'task.after-running');
  assert.equal(shot.atKill.task.status, 'running');
  assert.equal(shot.atKill.ledger.length, 0, '只读工具不写账本');

  const after = restart(shot.dataDir, 'task-after-running-restart');

  assert.ok(after.task);
  assert.ok(
    ['running', 'accepted', 'queued', 'waiting_approval'].includes(after.task.status) === false,
    `任务必须离开中间态，实际 ${after.task.status}`
  );
  assert.ok(
    after.terminal || after.task.status === 'retrying',
    `任务必须有确定去向（终态或 retrying），实际 ${after.task.status}`
  );
  if (after.task.status === 'retrying') {
    assert.ok(after.task.retryAt, 'retrying 必须带 retryAt，不能停在没有下一步的状态');
  }

  console.log(
    `[p5-c4] atKill task=${shot.atKill.task.status} ledgerRows=${shot.atKill.ledger.length} | ` +
      `after task=${after.task.status} terminal=${after.terminal} retryAt=${after.task.retryAt} ` +
      `attempts=${after.task.attempts} errorCode=${after.task.errorCode}`
  );
});
