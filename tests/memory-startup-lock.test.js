/**
 * 启动顺序与锁前空文件初始化验证（只验证，不改生产代码）
 *
 * 覆盖：
 * 1) 两个真实 server/index.js 同时启动：单实例锁只放行一个；
 * 2) memory.json 缺失时两个进程同时初始化：最终仍是合法空数组，无 tmp 残留；
 * 3) 故障注入：把“检查文件不存在”与“写入 []”之间的窗口拉大，验证
 *    排他创建后 B 遇到 EEXIST 会读取 A 的记忆，不会覆盖已写入数据（修复回归）。
 *
 * 运行：node tests/memory-startup-lock.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MEMORY_MODULE = path.join(ROOT, 'server', 'memory.js');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-lock-test-'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
});

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function baseEnv(dataDir) {
  const env = {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    PORT: '0',
    BLUEBIRD_API_TOKEN: 'test-token-lock',
    DEEPSEEK_API_KEY: '',
    MEMORY_MODULE,
  };

  delete env.BLUEBIRD_ALLOW_MULTI;

  return env;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }

  return false;
}

function waitExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('子进程退出超时'));
    }, timeoutMs);

    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function readMemory(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'memory.json'), 'utf8'));
}

function inspectMemory(dataDir) {
  const code = `const memory = require(process.env.MEMORY_MODULE); process.stdout.write('READ:' + JSON.stringify(memory.getMemories({ includeSuperseded: true }).map(item => item.content)));`;
  const result = spawnSync(process.execPath, ['-e', code], {
    env: baseEnv(dataDir),
    encoding: 'utf8',
    timeout: 15000,
  });

  if (result.status !== 0) {
    throw new Error(
      `读取进程失败 status=${result.status} stderr=${(result.stderr || '').slice(-400)}`
    );
  }

  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .find(item => item.startsWith('READ:'));

  if (!line) {
    throw new Error(`未找到 READ：${(result.stdout || '').slice(-400)}`);
  }

  return JSON.parse(line.slice('READ:'.length));
}

async function naturalInitTrial(index) {
  const dataDir = path.join(TMP_ROOT, `init-${index}`);

  fs.mkdirSync(dataDir, { recursive: true });

  const code = `require(${JSON.stringify(MEMORY_MODULE)});`;
  const env = baseEnv(dataDir);
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['-e', code], { env, stdio: 'ignore' })
  );

  const exits = await Promise.all(children.map(child => waitExit(child)));

  let parsed = null;
  let parseError = null;

  try {
    parsed = readMemory(dataDir);
  } catch (error) {
    parseError = error.message;
  }

  const leftovers = fs
    .readdirSync(dataDir)
    .filter(name => name.includes('.tmp-'));

  check(
    `并发初始化第 ${index} 轮：两个进程正常退出`,
    exits.every(codeValue => codeValue === 0),
    JSON.stringify(exits)
  );
  check(
    `并发初始化第 ${index} 轮：最终文件是合法空数组`,
    Array.isArray(parsed) && parsed.length === 0,
    parseError || JSON.stringify(parsed)
  );
  check(
    `并发初始化第 ${index} 轮：没有临时文件残留`,
    leftovers.length === 0,
    leftovers.join(',')
  );
}

async function simultaneousServerTrial() {
  const dataDir = path.join(TMP_ROOT, 'simultaneous');

  fs.mkdirSync(dataDir, { recursive: true });

  const env = baseEnv(dataDir);
  const procs = [0, 1].map(() => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };

    child.stdout.on('data', chunk => {
      output.stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      output.stderr += chunk.toString();
    });

    return { child, output };
  });

  await waitFor(
    () =>
      procs.filter(item => item.child.exitCode !== null).length === 1 &&
      procs.filter(item => item.child.exitCode === null).length === 1,
    15000
  );

  const exited = procs.filter(item => item.child.exitCode !== null);
  const running = procs.filter(item => item.child.exitCode === null);

  check(
    '同时启动：恰好一个实例保持运行',
    running.length === 1,
    JSON.stringify(procs.map(item => item.child.exitCode))
  );
  check(
    '同时启动：另一个实例退出码为 1',
    exited.length === 1 && exited[0].child.exitCode === 1,
    JSON.stringify(exited.map(item => item.child.exitCode))
  );
  check(
    '同时启动：退出原因是单实例锁',
    exited.length === 1 && /启动被拒绝/.test(exited[0].output.stderr || ''),
    exited.length ? (exited[0].output.stderr || '').slice(-300) : '无退出进程'
  );
  check(
    '同时启动：memory.json 仍是合法空数组',
    (() => {
      try {
        const parsed = readMemory(dataDir);
        return Array.isArray(parsed) && parsed.length === 0;
      } catch (_) {
        return false;
      }
    })()
  );

  for (const item of running) {
    try {
      item.child.kill();
    } catch (_) {
      /* ignore */
    }
    await waitExit(item.child, 5000).catch(() => {});
  }
}

async function realLockTrial() {
  const dataDir = path.join(TMP_ROOT, 'lock');

  fs.mkdirSync(dataDir, { recursive: true });

  const env = baseEnv(dataDir);
  const first = spawn(process.execPath, [SERVER_ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  first.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  first.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const ready = await waitFor(
    () => stdout.includes('Bluebird API running'),
    15000
  );

  check(
    '首个实例启动并监听',
    ready,
    (stderr || stdout).slice(-400)
  );

  const memoryPath = path.join(dataDir, 'memory.json');
  const lockPath = path.join(dataDir, '.bluebird.lock');

  check('锁前已创建 memory.json', fs.existsSync(memoryPath));
  check(
    'memory.json 是合法空数组',
    (() => {
      try {
        const parsed = readMemory(dataDir);
        return Array.isArray(parsed) && parsed.length === 0;
      } catch (_) {
        return false;
      }
    })()
  );
  check('锁文件已建立', fs.existsSync(lockPath));

  const second = spawnSync(process.execPath, [SERVER_ENTRY], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });

  check(
    '第二个实例被单实例锁拒绝（退出码 1）',
    second.status === 1,
    `status=${second.status}`
  );
  check(
    '拒绝原因可见',
    /启动被拒绝/.test(second.stderr || ''),
    (second.stderr || '').slice(-300)
  );
  check(
    '第二个实例没有覆盖 memory.json',
    (() => {
      try {
        const parsed = readMemory(dataDir);
        return Array.isArray(parsed) && parsed.length === 0;
      } catch (_) {
        return false;
      }
    })()
  );

  try {
    first.kill();
  } catch (_) {
    /* ignore */
  }

  await waitExit(first, 5000).catch(() => {});
}

function fileStateTrial() {
  const emptyDir = path.join(TMP_ROOT, 'state-empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const emptyPath = path.join(emptyDir, 'memory.json');
  fs.writeFileSync(emptyPath, '[]\n', 'utf8');
  const emptyBefore = fs.readFileSync(emptyPath, 'utf8');
  const emptyView = inspectMemory(emptyDir);

  check('合法空文件：读取为空库', Array.isArray(emptyView) && emptyView.length === 0, JSON.stringify(emptyView));
  check(
    '合法空文件：启动不重写文件',
    fs.readFileSync(emptyPath, 'utf8') === emptyBefore,
    '文件内容被改写'
  );

  const nonEmptyDir = path.join(TMP_ROOT, 'state-nonempty');
  fs.mkdirSync(nonEmptyDir, { recursive: true });
  const nonEmptyPath = path.join(nonEmptyDir, 'memory.json');
  const seeded = [
    {
      content: '已有非空记忆',
      type: 'fact',
      keywords: ['已有'],
      confidence: 0.95,
      sourceQuote: '已有非空记忆',
      sessionId: 's-state',
      createdAt: '2026-10-20T08:00:00.000Z',
    },
  ];
  fs.writeFileSync(nonEmptyPath, JSON.stringify(seeded, null, 2), 'utf8');
  const nonEmptyBefore = fs.readFileSync(nonEmptyPath, 'utf8');
  const nonEmptyView = inspectMemory(nonEmptyDir);

  check(
    '已有非空文件：正常读取',
    Array.isArray(nonEmptyView) && nonEmptyView.includes('已有非空记忆'),
    JSON.stringify(nonEmptyView)
  );
  check(
    '已有非空文件：启动不重写文件',
    fs.readFileSync(nonEmptyPath, 'utf8') === nonEmptyBefore,
    '文件内容被改写'
  );

  const zeroDir = path.join(TMP_ROOT, 'state-zero');
  fs.mkdirSync(zeroDir, { recursive: true });
  const zeroPath = path.join(zeroDir, 'memory.json');
  fs.writeFileSync(zeroPath, '', 'utf8');
  const zeroView = inspectMemory(zeroDir);
  const zeroCorrupt = fs
    .readdirSync(zeroDir)
    .filter(name => name.startsWith('memory.json.corrupt-'));

  check('零字节文件：读取为空库', Array.isArray(zeroView) && zeroView.length === 0, JSON.stringify(zeroView));
  check('零字节文件：保持损坏隔离语义', zeroCorrupt.length > 0, zeroCorrupt.join(','));
}

async function faultInjectionTrial() {
  const dataDir = path.join(TMP_ROOT, 'inject');

  fs.mkdirSync(dataDir, { recursive: true });

  const env = baseEnv(dataDir);
  const runnerA = path.join(TMP_ROOT, 'inject-a.js');
  const runnerB = path.join(TMP_ROOT, 'inject-b.js');

  fs.writeFileSync(
    runnerA,
    `
const fs = require('fs');
const path = require('path');
const memory = require(process.env.MEMORY_MODULE);
const client = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              content: '我的偏好是蓝色',
              type: 'preference',
              keywords: ['偏好', '蓝色'],
              confidence: 0.95,
              sourceQuote: '我的偏好是蓝色',
            }),
          },
        }],
      }),
    },
  },
};

(async () => {
  await memory.processMemory(client, '请记住：我的偏好是蓝色', 's-lock-race');
  const disk = fs.readFileSync(path.join(process.env.BLUEBIRD_DATA_DIR, 'memory.json'), 'utf8');
  fs.writeFileSync(path.join(process.env.BLUEBIRD_DATA_DIR, 'A_SNAPSHOT.json'), disk);
  fs.writeFileSync(path.join(process.env.BLUEBIRD_DATA_DIR, 'A_DONE'), '1');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`.trim(),
    'utf8'
  );

  fs.writeFileSync(
    runnerB,
    `
const fs = require('fs');
const path = require('path');
const dir = process.env.BLUEBIRD_DATA_DIR;
const memoryPath = path.join(dir, 'memory.json');
const origExists = fs.existsSync;
const origMkdir = fs.mkdirSync;

fs.existsSync = function (target) {
  if (path.resolve(String(target)) === path.resolve(memoryPath)) {
    fs.writeFileSync(path.join(dir, 'B_CHECKED'), '1');
    return false;
  }

  return origExists.apply(fs, arguments);
};

fs.mkdirSync = function (target, options) {
  if (path.resolve(String(target)) === path.resolve(dir)) {
    const started = Date.now();

    while (
      !origExists.call(fs, path.join(dir, 'A_DONE')) &&
      Date.now() - started < 15000
    ) {
      // 把“检查不存在”和“写 []”之间的窗口拉大，等待 A 完成写入。
    }
  }

  return origMkdir.apply(fs, arguments);
};

const memory = require(process.env.MEMORY_MODULE);
const view = memory.getMemories({ includeSuperseded: true }).map(item => item.content);
fs.writeFileSync(path.join(dir, 'B_VIEW.json'), JSON.stringify(view));
fs.writeFileSync(path.join(dir, 'B_DONE'), '1');
`.trim(),
    'utf8'
  );

  const childB = spawn(process.execPath, [runnerB], {
    env,
    stdio: 'ignore',
  });

  const checked = await waitFor(
    () => fs.existsSync(path.join(dataDir, 'B_CHECKED')),
    10000
  );

  check('故障注入：B 已观察到 memory.json 不存在', checked);

  const childA = spawn(process.execPath, [runnerA], {
    env,
    stdio: 'ignore',
  });

  const wrote = await waitFor(
    () => fs.existsSync(path.join(dataDir, 'A_DONE')),
    15000
  );

  check('故障注入：A 已写入一条真实记忆', wrote);

  await waitExit(childA, 15000).catch(() => {});
  await waitExit(childB, 15000).catch(() => {});

  let snapshot = null;
  let final = null;

  try {
    snapshot = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'A_SNAPSHOT.json'), 'utf8')
    );
  } catch (_) {
    /* 见下方断言 */
  }

  try {
    final = readMemory(dataDir);
  } catch (_) {
    /* 见下方断言 */
  }

  check(
    '故障注入：A 的快照里确有记忆',
    Array.isArray(snapshot) &&
      snapshot.some(item => item.content === '我的偏好是蓝色'),
    JSON.stringify(snapshot)
  );
  let bView = null;

  try {
    bView = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'B_VIEW.json'), 'utf8')
    );
  } catch (_) {
    /* 见下方断言 */
  }

  check(
    '故障注入回归：B 通过 EEXIST 读取了 A 的记忆',
    Array.isArray(bView) && bView.includes('我的偏好是蓝色'),
    JSON.stringify(bView)
  );
  check(
    '故障注入回归：B 不得覆盖 A 的记忆',
    Array.isArray(final) &&
      final.some(item => item.content === '我的偏好是蓝色'),
    JSON.stringify(final)
  );
}

(async () => {
  console.log('\n1) memory.json 缺失时并发初始化');
  for (let index = 1; index <= 3; index += 1) {
    await naturalInitTrial(index);
  }

  console.log('\n2) 两个真实服务同时启动');
  await simultaneousServerTrial();

  console.log('\n3) 第二个服务在首个就绪后启动');
  await realLockTrial();

  console.log('\n4) 故障注入：锁前检查与写入之间的窗口');
  await faultInjectionTrial();

  console.log('\n5) 合法空文件 / 非空文件 / 零字节文件');
  fileStateTrial();

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);

  if (failures.length) {
    console.log('失败明细：');
    failures.forEach(item => console.log(`  - ${item}`));
    process.exit(1);
  }

  process.exit(0);
})().catch(error => {
  console.error('测试运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
