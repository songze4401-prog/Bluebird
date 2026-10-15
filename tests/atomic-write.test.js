/**
 * 云岫 Bluebird — 原子写盘（atomic-write）验证
 *
 * 独立脚本（非 node:test），与 tests/sessions-recovery.test.js 同款极简 runner。
 *
 * 隔离保证：一切读写都在 os.tmpdir() 下新建的临时目录里进行，
 * 绝不触碰真实 server/data。
 *
 * 覆盖：
 *   - 同步 / 异步原子写：成功后目标文件内容完整、可解析；
 *   - 覆盖已有文件：旧内容被完整替换；
 *   - 写入中途失败（rename 抛错）：目标文件保持旧内容字节不变，
 *     自己创建的临时文件被清理干净；
 *   - 进程在 rename 之前被 SIGKILL（真实的崩溃模拟，走子进程）：
 *     重新读取目标文件必须是"旧数据"，既不是空文件也不是截断文件。
 *
 * 运行：node tests/atomic-write.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server');
const HELPER = path.join(SERVER, 'atomic-write.js');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-atomic-'));

const { writeFileAtomic, writeFileAtomicSync } = require(HELPER);

const ORIG_LOG = console.log;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    ORIG_LOG(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    ORIG_LOG(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function newDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempLeftovers(dir) {
  return fs
    .readdirSync(dir)
    .filter(name => name.includes('.tmp-'));
}

const OLD = JSON.stringify({ v: 'old', items: [1, 2, 3] });
const NEW = JSON.stringify({ v: 'new', items: [4, 5, 6, 7] });

// 子进程脚本：先写稳 OLD，再在"原子写 NEW"的 rename 之前把自己 SIGKILL 掉，
// 精确模拟"数据已写入临时文件、但还没 rename 就被杀"的崩溃时刻。
const CHILD_SCRIPT = `
const fs = require('fs');
const helper = require(process.env.AT_HELPER);
const target = process.env.AT_TARGET;

helper.writeFileAtomicSync(target, process.env.AT_OLD);

Object.defineProperty(fs.promises, 'rename', {
  configurable: true,
  writable: true,
  value: () => {
    process.kill(process.pid, 'SIGKILL');
  },
});

helper.writeFileAtomic(target, process.env.AT_NEW);
`;

async function main() {
  // ---- A. 同步原子写（新建） ----
  ORIG_LOG('\nA. writeFileAtomicSync 新建文件');
  const dirA = newDir('a');
  const targetA = path.join(dirA, 'sync.json');
  writeFileAtomicSync(targetA, NEW);
  check('A 文件已创建且内容完整可解析', fs.existsSync(targetA) && JSON.parse(fs.readFileSync(targetA, 'utf8')).v === 'new');
  check('A 无残留临时文件', tempLeftovers(dirA).length === 0, tempLeftovers(dirA).join(', '));

  // ---- B. 异步原子写（新建） ----
  ORIG_LOG('\nB. writeFileAtomic 新建文件');
  const dirB = newDir('b');
  const targetB = path.join(dirB, 'async.json');
  await writeFileAtomic(targetB, NEW);
  check('B 文件已创建且内容完整可解析', JSON.parse(fs.readFileSync(targetB, 'utf8')).v === 'new');
  check('B 无残留临时文件', tempLeftovers(dirB).length === 0, tempLeftovers(dirB).join(', '));

  // ---- C. 覆盖已有文件 ----
  ORIG_LOG('\nC. 覆盖已有文件（旧 -> 新）');
  const dirC = newDir('c');
  const targetC = path.join(dirC, 'over.json');
  fs.writeFileSync(targetC, OLD, 'utf8');
  await writeFileAtomic(targetC, NEW);
  const readC = fs.readFileSync(targetC, 'utf8');
  check('C 旧内容被完整替换为新内容', readC === NEW, readC);
  check('C 无残留临时文件', tempLeftovers(dirC).length === 0, tempLeftovers(dirC).join(', '));

  // ---- D. 异步：rename 失败 -> 目标保持旧内容 + 清理临时文件 ----
  ORIG_LOG('\nD. 异步 rename 失败 -> 目标不变 + 清理临时文件');
  const dirD = newDir('d');
  const targetD = path.join(dirD, 'fail.json');
  fs.writeFileSync(targetD, OLD, 'utf8');

  const asyncRenameDesc = Object.getOwnPropertyDescriptor(fs.promises, 'rename');
  Object.defineProperty(fs.promises, 'rename', {
    configurable: true,
    writable: true,
    value: async () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  let asyncErr = null;
  try {
    await writeFileAtomic(targetD, NEW);
  } catch (error) {
    asyncErr = error;
  } finally {
    if (asyncRenameDesc) {
      Object.defineProperty(fs.promises, 'rename', asyncRenameDesc);
    }
  }

  check('D 失败被抛出（不静默）', !!asyncErr && asyncErr.code === 'EPERM');
  check('D 目标文件仍是旧内容（未被截断/清空）', fs.readFileSync(targetD, 'utf8') === OLD);
  check('D 临时文件已被清理', tempLeftovers(dirD).length === 0, tempLeftovers(dirD).join(', '));

  // ---- E. 同步：rename 失败 -> 目标保持旧内容 + 清理临时文件 ----
  ORIG_LOG('\nE. 同步 rename 失败 -> 目标不变 + 清理临时文件');
  const dirE = newDir('e');
  const targetE = path.join(dirE, 'fail-sync.json');
  fs.writeFileSync(targetE, OLD, 'utf8');

  const syncRenameDesc = Object.getOwnPropertyDescriptor(fs, 'renameSync');
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    writable: true,
    value: () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  let syncErr = null;
  try {
    writeFileAtomicSync(targetE, NEW);
  } catch (error) {
    syncErr = error;
  } finally {
    if (syncRenameDesc) {
      Object.defineProperty(fs, 'renameSync', syncRenameDesc);
    }
  }

  check('E 失败被抛出（不静默）', !!syncErr && syncErr.code === 'EPERM');
  check('E 目标文件仍是旧内容（未被截断/清空）', fs.readFileSync(targetE, 'utf8') === OLD);
  check('E 临时文件已被清理', tempLeftovers(dirE).length === 0, tempLeftovers(dirE).join(', '));

  // ---- F. 真实崩溃模拟：子进程在 rename 前被 SIGKILL ----
  ORIG_LOG('\nF. 子进程在 rename 前被 SIGKILL -> 重新读取得到旧数据');
  const dirF = newDir('f');
  const targetF = path.join(dirF, 'crash.json');

  const child = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    env: {
      ...process.env,
      AT_HELPER: HELPER,
      AT_TARGET: targetF,
      AT_OLD: OLD,
      AT_NEW: NEW,
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  const killed = child.signal === 'SIGKILL' || child.status !== 0;
  check(
    'F 子进程确实被中断（未正常完成写入）',
    killed,
    `status=${child.status} signal=${child.signal}`
  );

  const afterCrash = fs.existsSync(targetF) ? fs.readFileSync(targetF, 'utf8') : '';
  check('F 重新读取得到旧数据（不是新数据）', afterCrash === OLD, afterCrash);
  check('F 目标文件非空、非截断、可解析', afterCrash.length > 0 && JSON.parse(afterCrash).v === 'old');
  check(
    'F 崩溃留下的临时文件命名符合约定（.tmp-<pid>-<ts>-<rand>）',
    tempLeftovers(dirF).every(name => /\.tmp-\d+-\d+-[0-9a-f]+$/.test(name)),
    tempLeftovers(dirF).join(', ')
  );

  // ---- 汇总 ----
  ORIG_LOG('');
  if (failed) {
    ORIG_LOG('失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }
  ORIG_LOG(`atomic-write: ${passed} passed, ${failed} failed`);
  ORIG_LOG(`（临时目录：${TMP_ROOT}）`);

  process.exit(failed ? 1 : 0);
}

main();
