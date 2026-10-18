/**
 * 云岫 Bluebird — 损坏处理契约（detect / recover + handleCorruption）验证
 *
 * 独立脚本（非 node:test），与 tests/data-events.test.js 同款极简 runner，测完显式退出。
 *
 * 隔离保证：三模块的数据文件全部落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 绝不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   1) 调度器本身：非法注册被拒、未注册模块抛错、未损坏不调用 recover 且不写日志、
 *      损坏时调用 recover（注入 reason / error）并统一记录一次结构化事件；
 *   2) 三模块均经由统一入口：把 corruption.handleCorruption 换成记录调用并转发的 spy，
 *      断言 sessions / sessions.legacy / memory / emotion 损坏时都走到它，
 *      且各自的恢复行为（只读保护 / 隔离重命名 / 跳过迁移）未退化；
 *   3) 各模块 detect 的差异仍保留（emotion 容忍形状、不算损坏）；
 *   4) 正常数据不触发恢复（回归保护）。
 *
 * 运行：node tests/corruption-contract.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-corruption-'));

// 损坏文件里埋的敏感标记：验证日志绝不把文件内容原样带出来。
const SENSITIVE = 'SENSITIVE_CONTRACT_MARKER_4c1e';

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
let errorLines = [];

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

/** 拿到干净的 corruption 契约模块实例（清 require 缓存 -> 空 handlers 表） */
function freshCorruption() {
  const target = require.resolve(path.join(SERVER, 'corruption.js'));
  delete require.cache[target];
  return require(target);
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
  // ---- 1. 调度器本身 ----
  ORIG_LOG('\n1. handleCorruption 调度器契约');
  const corruption = freshCorruption();

  let typeError = null;
  try {
    corruption.registerCorruptionHandler('bad.handler', { detect() {} });
  } catch (error) {
    typeError = error;
  }
  check('1a 缺少 recover 的 handler 注册被拒绝', typeError instanceof TypeError);

  let unknownError = null;
  try {
    corruption.handleCorruption('never.registered', { text: 'null' }, { file: 'x' });
  } catch (error) {
    unknownError = error;
  }
  check(
    '1b 未注册模块调用 handleCorruption 抛错',
    !!unknownError,
    String(unknownError)
  );

  const unitCalls = [];
  corruption.registerCorruptionHandler('unit', {
    detect(data) {
      if (data.bad) {
        return {
          corrupt: true,
          reason: 'json_parse_error',
          error: new SyntaxError('bad json'),
        };
      }

      return { corrupt: false, parsed: JSON.parse(data.text) };
    },
    recover(context) {
      unitCalls.push(context);
      return { action: 'isolated_file', isolatedPath: '/tmp/unit.json.corrupt-1' };
    },
  });

  errorLines = [];
  const okOutcome = corruption.handleCorruption(
    'unit',
    { text: '{"a":1}' },
    { file: '/tmp/unit.json' }
  );
  check('1c 未损坏时不调用 recover', unitCalls.length === 0);
  check(
    '1d 未损坏时返回解析结果且不写事件',
    okOutcome.corrupt === false &&
      okOutcome.parsed &&
      okOutcome.parsed.a === 1 &&
      jsonEvents().length === 0,
    JSON.stringify(okOutcome)
  );

  errorLines = [];
  const badOutcome = corruption.handleCorruption(
    'unit',
    { bad: true },
    { file: '/tmp/unit.json' }
  );
  check(
    '1e 损坏时调用 recover 并注入 reason/error',
    unitCalls.length === 1 &&
      unitCalls[0].reason === 'json_parse_error' &&
      unitCalls[0].file === '/tmp/unit.json' &&
      unitCalls[0].error instanceof SyntaxError,
    JSON.stringify(unitCalls)
  );
  check(
    '1f 损坏时返回 {corrupt:true, ...recoverResult}',
    badOutcome.corrupt === true &&
      badOutcome.action === 'isolated_file' &&
      badOutcome.isolatedPath === '/tmp/unit.json.corrupt-1',
    JSON.stringify(badOutcome)
  );
  const evUnit = findEvent('unit', 'isolated_file');
  check(
    '1g 损坏事件由调度器统一记录恰好一次且字段齐全',
    !!evUnit &&
      jsonEvents().length === 1 &&
      evUnit.module === 'unit' &&
      evUnit.file === '/tmp/unit.json' &&
      evUnit.reason === 'json_parse_error' &&
      evUnit.errorName === 'SyntaxError' &&
      isIsoTs(evUnit.ts),
    JSON.stringify(jsonEvents())
  );

  // ---- 2. 三模块均经由统一入口 ----
  ORIG_LOG('\n2. 三模块损坏均走 handleCorruption');
  // 换一个干净的契约实例，再把 handleCorruption 换成"记录调用 + 转发真实实现"的 spy，
  // 之后 require 的三个模块会 destructure 到这个 spy。
  const dispatcher = freshCorruption();
  const realHandle = dispatcher.handleCorruption.bind(dispatcher);
  const calls = [];
  dispatcher.handleCorruption = (moduleName, data, context) => {
    const result = realHandle(moduleName, data, context);
    calls.push({ module: moduleName, corrupt: !!result.corrupt });
    return result;
  };

  function corruptedModules() {
    return calls.filter(entry => entry.corrupt).map(entry => entry.module);
  }

  // 2A. sessions.json 损坏
  const dirS = newDir('s');
  const corruptS = `{"version":1,"sessions":[{"id":"x","content":"${SENSITIVE}`;
  fs.writeFileSync(path.join(dirS, 'sessions.json'), corruptS, 'utf8');

  errorLines = [];
  calls.length = 0;
  const sessions = freshModule('sessions.js', dirS);
  sessions.listSessions();

  check(
    "2a sessions 损坏走 handleCorruption('sessions')",
    corruptedModules().includes('sessions'),
    JSON.stringify(calls)
  );
  check(
    '2b sessions 仍是原地只读保护（写入被拒 + 原文件字节未变）',
    sessions.createSession({ title: 'x' }) === null &&
      readRaw(path.join(dirS, 'sessions.json')) === corruptS
  );
  check('2c sessions 损坏事件仍记录', !!findEvent('sessions', 'read_only_protection'));
  check(
    '2d 日志不泄露聊天内容',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // 2B. chat-history.json（legacy）损坏
  const dirL = newDir('l');
  const corruptL = `[{"role":"user","content":"${SENSITIVE}"`;
  fs.writeFileSync(path.join(dirL, 'chat-history.json'), corruptL, 'utf8');

  errorLines = [];
  calls.length = 0;
  const sessionsL = freshModule('sessions.js', dirL);
  sessionsL.listSessions();

  check(
    "2e legacy 损坏走 handleCorruption('sessions.legacy')",
    corruptedModules().includes('sessions.legacy'),
    JSON.stringify(calls)
  );
  check(
    '2f legacy 仍是跳过迁移（0 条消息 + 原文件保留）',
    sessionsL.getMessages(sessionsL.DEFAULT_SESSION_ID).length === 0 &&
      readRaw(path.join(dirL, 'chat-history.json')) === corruptL
  );
  check(
    '2g legacy 事件仍记录为 module=sessions / action=legacy_import_skipped',
    !!findEvent('sessions', 'legacy_import_skipped')
  );

  // 2C. memory.json 损坏
  const dirM = newDir('m');
  fs.writeFileSync(path.join(dirM, 'memory.json'), `[{"content":"${SENSITIVE}"`, 'utf8');

  errorLines = [];
  calls.length = 0;
  const memory = freshModule('memory.js', dirM);

  check(
    "2h memory 损坏走 handleCorruption('memory')",
    corruptedModules().includes('memory'),
    JSON.stringify(calls)
  );
  check(
    '2i memory 仍是隔离重命名 + 回退空库',
    memory.getMemories().length === 0 &&
      fs.readdirSync(dirM).some(name => name.startsWith('memory.json.corrupt-'))
  );
  check('2j memory 损坏事件仍记录（action=isolated_file）', !!findEvent('memory', 'isolated_file'));
  check(
    '2k 日志不泄露记忆正文',
    !errorLines.some(line => line.includes(SENSITIVE))
  );

  // 2D. emotion-state.json 损坏
  const dirE = newDir('e');
  fs.writeFileSync(path.join(dirE, 'emotion-state.json'), `{"emotion":"${SENSITIVE}`, 'utf8');

  errorLines = [];
  calls.length = 0;
  const emotion = freshModule('emotion.js', dirE);
  const stE = emotion.getEmotion();

  check(
    "2l emotion 损坏走 handleCorruption('emotion')",
    corruptedModules().includes('emotion'),
    JSON.stringify(calls)
  );
  check(
    '2m emotion 仍是隔离重命名 + 回退默认 calm',
    stE.emotion === 'calm' &&
      stE.intensity === 0 &&
      fs.readdirSync(dirE).some(name =>
        name.startsWith('emotion-state.json.corrupt-')
      )
  );
  check('2n emotion 损坏事件仍记录（action=isolated_file）', !!findEvent('emotion', 'isolated_file'));

  // ---- 3. 各模块 detect 差异仍保留 ----
  ORIG_LOG('\n3. 各模块 detect 的差异保留');
  const dirShape = newDir('shape');
  fs.writeFileSync(
    path.join(dirShape, 'emotion-state.json'),
    JSON.stringify({ emotion: 'NOT_A_TAG', intensity: 'abc' }),
    'utf8'
  );

  errorLines = [];
  calls.length = 0;
  const emotionShape = freshModule('emotion.js', dirShape);
  const stShape = emotionShape.getEmotion();

  check(
    '3a emotion 形状不对不算损坏（回退 calm、未隔离、未走恢复）',
    stShape.emotion === 'calm' &&
      !fs.readdirSync(dirShape).some(name =>
        name.startsWith('emotion-state.json.corrupt-')
      ) &&
      !corruptedModules().includes('emotion')
  );
  check('3b emotion 形状不对不写损坏事件', jsonEvents().length === 0);

  // ---- 4. 正常数据不触发恢复（回归保护）----
  ORIG_LOG('\n4. 正常数据不触发恢复');
  const dirOk = newDir('ok');
  fs.writeFileSync(
    path.join(dirOk, 'memory.json'),
    JSON.stringify(
      [{ content: '用户叫宋泽', type: 'identity', sourceQuote: '我叫宋泽' }],
      null,
      2
    ),
    'utf8'
  );

  errorLines = [];
  calls.length = 0;
  const memoryOk = freshModule('memory.js', dirOk);

  check('4a 正常记忆库照常加载', memoryOk.getMemories().length === 1);
  check('4b 正常数据未触发恢复', !corruptedModules().includes('memory'));
  check('4c 正常数据未写损坏事件', jsonEvents().length === 0);

  // ---- 汇总 ----
  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  ORIG_LOG('');
  if (failed) {
    ORIG_LOG('失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }
  ORIG_LOG(`corruption-contract: ${passed} passed, ${failed} failed`);
  ORIG_LOG(`（临时目录：${TMP_ROOT}）`);

  process.exit(failed ? 1 : 0);
}

main();
