/**
 * 云岫 Bluebird — 数据文件损坏事件可观测性验证
 *
 * 独立脚本（非 node:test），与 tests/sessions-recovery.test.js 同款极简 runner，
 * 测完显式退出。
 *
 * 隔离保证：三个模块的数据文件全部落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 绝不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   - sessions.json 损坏 -> 结构化事件（ts/模块/路径/原因/措施齐全），
 *     且原始文件字节级未被改动、不产生 .corrupt、写入被拒（原有只读保护未退化）；
 *   - sessions.json 合法 JSON 但结构不对 -> reason=invalid_shape；
 *   - sessions.json 读取失败 -> reason=read_error；
 *   - memory.json 损坏 -> 结构化事件 + 隔离重命名（原有隔离策略未退化）；
 *   - memory.json 隔离失败 -> action=isolation_failed，原文件保留、回退空库；
 *   - emotion-state.json 损坏 -> 结构化事件 + 隔离重命名；
 *   - 日志不泄露文件内容（用含敏感标记的损坏内容污染文件，断言日志里不出现该标记）。
 *
 * 运行：node tests/data-events.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-data-events-'));

// 损坏文件里埋的敏感标记：验证日志绝不会把文件内容原样带出来
// （Node 20+ 的 JSON.parse 报错会把输入片段夹进 message）。
const SENSITIVE = 'SENSITIVE_CHAT_MARKER_9f3a';

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
let errorLines = [];

// 屏蔽正常日志输出，只收集 stderr（console.error）——结构化事件正走这条路。
console.log = () => {};
console.error = (...args) => {
  errorLines.push(args.map(item => String(item)).join(' '));
};

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

function readRaw(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 清 require 缓存 + 指向临时数据目录，拿到干净的模块实例 */
function freshModule(name, dataDir) {
  const target = require.resolve(path.join(SERVER, name));
  delete require.cache[target];
  process.env.BLUEBIRD_DATA_DIR = dataDir;
  return require(target);
}

/** 把收集到的日志行里能解析成 JSON 的都挑出来（即结构化事件） */
function jsonEvents() {
  return errorLines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(item => item && typeof item === 'object');
}

function findEvent(moduleName, action, eventName = 'data_file_corruption') {
  return jsonEvents().find(
    item =>
      item.module === moduleName &&
      item.event === eventName &&
      item.action === action
  );
}

function isIsoTs(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

async function main() {
  // ---- A. sessions.json 损坏：只读保护 + 结构化事件 ----
  ORIG_LOG('\nA. sessions.json 损坏 -> 只读保护 + 结构化损坏事件');
  const dirA = newDir('a');
  const corruptA = `{"version":1,"sessions":[{"id":"x","content":"${SENSITIVE}`;
  fs.writeFileSync(path.join(dirA, 'sessions.json'), corruptA, 'utf8');

  errorLines = [];
  const a = freshModule('sessions.js', dirA);
  const listA = a.listSessions();

  check(
    'A 损坏时仍给出只读回退视图（1 个默认会话）',
    listA.length === 1 && listA[0].id === a.DEFAULT_SESSION_ID,
    JSON.stringify(listA)
  );
  check('A 新建会话被拒绝', a.createSession({ title: 'x' }) === null);
  check(
    'A 原始损坏文件字节级未被改动',
    readRaw(path.join(dirA, 'sessions.json')) === corruptA
  );
  check(
    'A 未产生 .corrupt 旁挂文件（sessions 为原地保护）',
    !fs.readdirSync(dirA).some(name => name.includes('.corrupt-'))
  );

  const evA = findEvent('sessions', 'read_only_protection');
  check('A 记录了结构化损坏事件', !!evA);
  check(
    'A 事件字段齐全（模块/路径/类型/原因/措施/时间戳）',
    !!evA &&
      evA.event === 'data_file_corruption' &&
      evA.module === 'sessions' &&
      evA.file === path.join(dirA, 'sessions.json') &&
      evA.reason === 'json_parse_error' &&
      evA.errorName === 'SyntaxError' &&
      evA.action === 'read_only_protection' &&
      isIsoTs(evA.ts),
    JSON.stringify(evA)
  );
  check(
    'A 日志不泄露聊天内容（敏感标记未出现）',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // ---- B. sessions.json 合法 JSON 但结构不对 ----
  ORIG_LOG('\nB. sessions.json 合法 JSON 但结构不对 -> invalid_shape');
  const dirB = newDir('b');
  fs.writeFileSync(path.join(dirB, 'sessions.json'), '[]', 'utf8');

  errorLines = [];
  const b = freshModule('sessions.js', dirB);
  check('B 结构不对同样进入只读保护', b.createSession({ title: 'z' }) === null);
  check(
    'B 文件未被空库覆盖',
    readRaw(path.join(dirB, 'sessions.json')) === '[]'
  );
  const evB = findEvent('sessions', 'read_only_protection');
  check(
    'B 事件 reason=invalid_shape',
    !!evB && evB.reason === 'invalid_shape',
    JSON.stringify(evB)
  );

  // ---- C. sessions.json 读取失败（路径被目录占位）----
  ORIG_LOG('\nC. sessions.json 读取失败 -> read_error');
  const dirC = newDir('c');
  fs.mkdirSync(path.join(dirC, 'sessions.json'));

  errorLines = [];
  const c = freshModule('sessions.js', dirC);
  c.listSessions();
  const evC = findEvent('sessions', 'read_only_protection');
  check(
    'C 事件 reason=read_error 且带错误码',
    !!evC && evC.reason === 'read_error' && typeof evC.errorCode === 'string' && evC.errorCode,
    JSON.stringify(evC)
  );

  // ---- D. memory.json 损坏：隔离重命名 + 结构化事件 ----
  ORIG_LOG('\nD. memory.json 损坏 -> 隔离重命名 + 结构化损坏事件');
  const dirD = newDir('d');
  fs.writeFileSync(
    path.join(dirD, 'memory.json'),
    `[{"content":"${SENSITIVE}"`,
    'utf8'
  );

  errorLines = [];
  const memory = freshModule('memory.js', dirD); // 模块加载即 loadMemories()

  check('D 回退为空记忆库', memory.getMemories().length === 0);
  const filesD = fs.readdirSync(dirD);
  check(
    'D 生成了 .corrupt 隔离文件',
    filesD.some(name => name.startsWith('memory.json.corrupt-')),
    filesD.join(', ')
  );
  check('D 原 memory.json 已移离原路径', !filesD.includes('memory.json'));

  const evD = findEvent('memory', 'isolated_file');
  check(
    'D 事件字段齐全（模块/路径/原因/措施/隔离路径/时间戳）',
    !!evD &&
      evD.module === 'memory' &&
      evD.file === path.join(dirD, 'memory.json') &&
      evD.reason === 'json_parse_error' &&
      evD.errorName === 'SyntaxError' &&
      evD.action === 'isolated_file' &&
      typeof evD.isolatedPath === 'string' &&
      fs.existsSync(evD.isolatedPath) &&
      isIsoTs(evD.ts),
    JSON.stringify(evD)
  );
  check(
    'D 日志不泄露记忆正文（敏感标记未出现）',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // ---- E. memory.json 隔离失败：原文件保留 + 结构化事件标记失败 ----
  ORIG_LOG('\nE. memory.json 隔离失败 -> isolation_failed，原文件保留');
  const dirE = newDir('e');
  fs.writeFileSync(path.join(dirE, 'memory.json'), '{ 坏掉的 JSON', 'utf8');

  // 强制 renameSync 抛错，模拟隔离失败（磁盘满/权限/占用等）。
  // 注：Node 内置 fs 的部分函数是惰性 getter，直接赋值不生效，必须 defineProperty。
  const renameDesc = Object.getOwnPropertyDescriptor(fs, 'renameSync');
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    writable: true,
    value: () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  errorLines = [];
  let memoryFail;
  try {
    memoryFail = freshModule('memory.js', dirE);
  } finally {
    if (renameDesc) Object.defineProperty(fs, 'renameSync', renameDesc);
  }

  check('E 仍回退为空记忆库', memoryFail.getMemories().length === 0);
  check(
    'E 原损坏文件被保留（未被隔离，也未被删除）',
    fs.existsSync(path.join(dirE, 'memory.json'))
  );
  check(
    'E 未产生 .corrupt 文件',
    !fs.readdirSync(dirE).some(name => name.startsWith('memory.json.corrupt-'))
  );
  const evE = findEvent('memory', 'isolation_failed');
  check(
    'E 事件 action=isolation_failed，原因仍可定位',
    !!evE && evE.reason === 'json_parse_error',
    JSON.stringify(evE)
  );

  // ---- F. emotion-state.json 损坏：隔离重命名 + 结构化事件 ----
  ORIG_LOG('\nF. emotion-state.json 损坏 -> 隔离重命名 + 结构化损坏事件');
  const dirF = newDir('f');
  fs.writeFileSync(
    path.join(dirF, 'emotion-state.json'),
    `{"emotion":"${SENSITIVE}`,
    'utf8'
  );

  errorLines = [];
  const emotion = freshModule('emotion.js', dirF); // 模块加载即 loadEmotion()

  const stF = emotion.getEmotion();
  check(
    'F 回退默认 calm(0)',
    stF.emotion === 'calm' && stF.intensity === 0,
    JSON.stringify(stF)
  );
  const filesF = fs.readdirSync(dirF);
  check(
    'F 生成了 .corrupt 隔离文件',
    filesF.some(name => name.startsWith('emotion-state.json.corrupt-')),
    filesF.join(', ')
  );

  const evF = findEvent('emotion', 'isolated_file');
  check(
    'F 事件字段齐全（模块/路径/原因/措施/隔离路径/时间戳）',
    !!evF &&
      evF.module === 'emotion' &&
      evF.file === path.join(dirF, 'emotion-state.json') &&
      evF.reason === 'json_parse_error' &&
      evF.errorName === 'SyntaxError' &&
      evF.action === 'isolated_file' &&
      typeof evF.isolatedPath === 'string' &&
      isIsoTs(evF.ts),
    JSON.stringify(evF)
  );
  check(
    'F 日志不泄露文件内容（敏感标记未出现）',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // ---- G. chat-history.json 损坏：跳过迁移 + 结构化事件，不泄露聊天内容 ----
  ORIG_LOG('\nG. chat-history.json 损坏 -> 跳过迁移 + 结构化事件');
  const dirG = newDir('g');
  fs.writeFileSync(
    path.join(dirG, 'chat-history.json'),
    `[{"role":"user","content":"${SENSITIVE}"`,
    'utf8'
  );

  errorLines = [];
  const g = freshModule('sessions.js', dirG);
  const listG = g.listSessions(); // 无 sessions.json -> 触发 importLegacyHistory

  check(
    'G 仍给出默认会话（未因 legacy 损坏而崩）',
    listG.length === 1 && listG[0].id === g.DEFAULT_SESSION_ID,
    JSON.stringify(listG)
  );
  check(
    'G 未从损坏的 legacy 迁移出任何消息',
    g.getMessages(g.DEFAULT_SESSION_ID).length === 0
  );

  const evG = findEvent('sessions', 'legacy_import_skipped');
  check(
    'G 记录了 legacy 损坏事件（模块/路径/类型/原因/措施/时间戳）',
    !!evG &&
      evG.event === 'data_file_corruption' &&
      evG.module === 'sessions' &&
      evG.file === path.join(dirG, 'chat-history.json') &&
      evG.reason === 'json_parse_error' &&
      evG.errorName === 'SyntaxError' &&
      evG.action === 'legacy_import_skipped' &&
      isIsoTs(evG.ts),
    JSON.stringify(evG)
  );
  check(
    'G 日志不泄露聊天内容（敏感标记未出现）',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // ---- H. 孤儿消息：结构化告警 + 原人工告警保留 ----
  ORIG_LOG('\nH. 孤儿消息 -> 结构化告警（原人工告警保留）');
  const iso = '2026-01-01T00:00:00.000Z';
  const dirH = newDir('h');
  fs.writeFileSync(
    path.join(dirH, 'sessions.json'),
    JSON.stringify(
      {
        version: 1,
        sessions: [{ id: 'alive', title: 'A', createdAt: iso, updatedAt: iso }],
        messages: {
          alive: [{ id: 'm1', role: 'user', content: 'hi', createdAt: iso }],
          ghost: [{ id: 'g1', role: 'user', content: 'x', createdAt: iso }],
        },
      },
      null,
      2
    ),
    'utf8'
  );

  errorLines = [];
  const h = freshModule('sessions.js', dirH);
  h.listSessions();

  const evH = findEvent(
    'sessions',
    'pruned_on_next_write',
    'orphan_messages_detected'
  );
  check(
    'H 记录孤儿消息结构化事件（含 count / 级别 warn）',
    !!evH &&
      evH.count === 1 &&
      evH.level === 'warn' &&
      evH.file === path.join(dirH, 'sessions.json'),
    JSON.stringify(evH)
  );
  check(
    'H 原人工告警仍在（含孤儿 key 名）',
    errorLines.some(
      line => line.includes('orphan messages') && line.includes('ghost')
    )
  );

  // ---- I. sessions.json 落盘失败：结构化事件 + 写入被拒 ----
  ORIG_LOG('\nI. sessions.json 落盘失败 -> 结构化事件');
  const dirI = newDir('i');
  fs.writeFileSync(
    path.join(dirI, 'sessions.json'),
    JSON.stringify(
      {
        version: 1,
        sessions: [
          { id: 'default', title: '默认会话', createdAt: iso, updatedAt: iso },
        ],
        messages: { default: [] },
      },
      null,
      2
    ),
    'utf8'
  );

  errorLines = [];
  const i = freshModule('sessions.js', dirI);
  i.listSessions();

  const renameDescI = Object.getOwnPropertyDescriptor(fs, 'renameSync');
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    writable: true,
    value: () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  errorLines = [];
  let appendI;
  try {
    appendI = i.appendMessages('default', [{ role: 'user', content: 'x' }]);
  } finally {
    if (renameDescI) Object.defineProperty(fs, 'renameSync', renameDescI);
  }

  check('I 落盘失败时写入返回失败', appendI === null);
  const evI = findEvent('sessions', 'write_failed', 'store_write_failed');
  check(
    'I 记录落盘失败结构化事件',
    !!evI &&
      evI.errorCode === 'EPERM' &&
      evI.event === 'store_write_failed' &&
      evI.file === path.join(dirI, 'sessions.json') &&
      isIsoTs(evI.ts),
    JSON.stringify(evI)
  );

  // ---- J. memory.json 落盘失败 -> 写入队列错误事件 ----
  ORIG_LOG('\nJ. memory.json 落盘失败 -> 队列错误结构化事件');
  const dirJ = newDir('j');
  const memRenameDesc = Object.getOwnPropertyDescriptor(fs.promises, 'rename');
  Object.defineProperty(fs.promises, 'rename', {
    configurable: true,
    writable: true,
    value: async () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  errorLines = [];
  const memoryJ = freshModule('memory.js', dirJ);
  try {
    await memoryJ.clearMemories();
  } catch (_) {
    // 队列写入失败会向外抛；这里只关心它已被记录
  } finally {
    if (memRenameDesc) {
      Object.defineProperty(fs.promises, 'rename', memRenameDesc);
    }
  }

  const evJ = findEvent('memory', 'write_failed', 'write_queue_error');
  check(
    'J 记录 memory 写入队列错误事件',
    !!evJ &&
      evJ.errorCode === 'EPERM' &&
      evJ.file === path.join(dirJ, 'memory.json'),
    JSON.stringify(evJ)
  );

  // ---- K. emotion-state.json 落盘失败 -> 写入队列错误事件 ----
  ORIG_LOG('\nK. emotion-state.json 落盘失败 -> 队列错误结构化事件');
  const dirK = newDir('k');
  const emoRenameDesc = Object.getOwnPropertyDescriptor(fs.promises, 'rename');
  Object.defineProperty(fs.promises, 'rename', {
    configurable: true,
    writable: true,
    value: async () => {
      const forced = new Error('forced rename failure');
      forced.code = 'EPERM';
      throw forced;
    },
  });

  errorLines = [];
  const emotionK = freshModule('emotion.js', dirK);
  try {
    // applyObservation 内部 commit() 不 await，落盘在写队列里异步执行
    emotionK.applyObservation('happy');
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    if (emoRenameDesc) {
      Object.defineProperty(fs.promises, 'rename', emoRenameDesc);
    }
  }

  const evK = findEvent('emotion', 'write_failed', 'write_queue_error');
  check(
    'K 记录 emotion 写入队列错误事件',
    !!evK &&
      evK.errorCode === 'EPERM' &&
      evK.file === path.join(dirK, 'emotion-state.json'),
    JSON.stringify(evK)
  );

  // ---- 汇总 ----
  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  ORIG_LOG('');
  if (failed) {
    ORIG_LOG('失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }
  ORIG_LOG(`data-events: ${passed} passed, ${failed} failed`);
  ORIG_LOG(`（临时目录：${TMP_ROOT}）`);

  process.exit(failed ? 1 : 0);
}

main();
