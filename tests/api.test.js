/**
 * 云岫 Bluebird — 后端 HTTP 接口 (server/index.js) 行为测试
 *
 * 独立脚本（非 node:test）：服务入口 require 时即 app.listen，但已导出
 * { app, server }，因此这里用 PORT=0 拿系统分配的空闲端口，自建极简
 * runner，测完显式退出，确保进程能结束。
 * 隔离说明：全程使用临时数据目录（BLUEBIRD_DATA_DIR），不读写 server/data 下的真实数据。
 * 运行：node <本文件>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 数据目录隔离：所有落盘都指向临时目录，绝不触碰真实的 server/data/。
// 必须放在 require 任何服务端模块之前——数据路径在模块首次加载时即求值，
// 晚了设置就仍然指向 server/data/，本文件里的 /memory/clear、/history/clear
// 会直接清空真实记忆与聊天记录。
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-api-test-'));
process.env.BLUEBIRD_DATA_DIR = TMP_DATA_DIR;

// 端口交给操作系统分配（PORT=0），测前从 server 实例读取真实端口。
// 固定端口若被别的进程占用，本测试的 listen 会失败，而 waitReady 仍会
// 连上占用者的服务并全部"通过"——等于把断言跑在别人的实例上，
// 并读写对方 server/data/ 下的真实记忆与聊天记录。
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-bluebird';
// 这里必须是赋空串，不能 delete：dotenv 只填补「不存在」的变量，一旦 delete，
// 随后 server/index.js 的 dotenv.config() 会从 server/.env 把 DEEPSEEK_API_KEY
// 重新注入，测试就会真的去调 DeepSeek（产生真实费用）。
process.env.DEEPSEEK_API_KEY = ''; // 故意不配 API Key，验证降级路径

// 进程退出（含断言失败、异常）时回收临时数据目录
process.on('exit', () => {
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结果 */
  }
});

let BASE = '';
const TOKEN = 'test-token-bluebird';

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    origLog(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function req(path, { method = 'GET', token = TOKEN, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

/* ---------------- 纵深防御 ----------------
 * 数据目录隔离（BLUEBIRD_DATA_DIR）已能挡住绝大多数情况，但它依赖测试头部
 * 那一行环境变量：一旦有人调整 require 顺序或误删该行，隔离会静默失效，
 * 而 /memory/clear、/history/clear 这类破坏性断言就会打到真实数据上。
 * 下面两层用于在这种情况下立刻失败并报警，而不是绿灯放过。
 */
const REAL_DATA_DIR = path.join(__dirname, '..', 'server', 'data');

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

/** 前置守卫：生效的数据目录必须已重定向到临时目录，且不在真实目录内。
 *  校验对象是 process.env 的实际值（而非 TMP_DATA_DIR 常量），
 *  否则隔离被改坏时守卫反而永远通过。
 */
function isolationError() {
  const envDir = process.env.BLUEBIRD_DATA_DIR;
  if (!envDir) {
    return 'BLUEBIRD_DATA_DIR 未设置，落盘将指向真实的 server/data/';
  }
  const active = realpathSafe(envDir);
  if (!active) {
    return `生效的数据目录不存在：${envDir}`;
  }
  const real = realpathSafe(REAL_DATA_DIR);
  if (!real) {
    return null; // 真实目录不存在，无从污染
  }
  if (active === real || active.startsWith(real + path.sep)) {
    return `生效数据目录 ${active} 落在真实数据目录 ${real} 内`;
  }
  return null;
}

/** 跑测试前给真实数据目录拍快照，跑完比对，兜住任何意外的写入。 */
function snapshotRealData() {
  const snap = {};
  try {
    for (const name of fs.readdirSync(REAL_DATA_DIR)) {
      const p = path.join(REAL_DATA_DIR, name);
      if (!fs.statSync(p).isFile()) continue;
      snap[name] = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    }
  } catch (_) {
    /* 目录不存在 */
  }
  return snap;
}

function diffSnapshot(before, after) {
  const changed = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (before[name] !== after[name]) {
      changed.push(before[name] ? `${name}(内容变化)` : `${name}(新增)`);
    }
  }
  return changed;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

(async () => {
  // 守卫 1（前置）：确认隔离生效，否则拒绝执行破坏性断言。
  // 必须在 require 入口之前检查——入口一加载就会读写数据目录。
  const isoErr = isolationError();
  if (isoErr) {
    origLog(`✖ 数据隔离守卫失败：${isoErr}`);
    origLog('  已中止，未执行 /memory/clear、/history/clear 等破坏性断言。');
    try {
      fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
    } catch (_) {
      /* 清理失败不影响结果 */
    }
    console.log = origLog;
    console.error = origErr;
    process.exit(1);
  }

  // 守卫 2（后置基准）：跑之前给真实数据目录拍快照，跑完比对。
  const snapshotBefore = snapshotRealData();

  // 先确定端口再加载入口：index.js 在 require 时即 listen。
  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;

  const ready = await waitReady();
  if (!ready) {
    origLog('服务未能在 5 秒内启动');
    process.exit(1);
  }

  origLog('\n接口鉴权');
  {
    const r = await req('/', { token: null });
    check('GET / 健康检查无需鉴权', r.status === 200, `实际 ${r.status}`);

    const noToken = await req('/memory', { token: null });
    check('GET /memory 无 token 返回 401', noToken.status === 401, `实际 ${noToken.status}`);

    const badToken = await req('/memory', { token: 'wrong-token' });
    check('GET /memory 错误 token 返回 401', badToken.status === 401, `实际 ${badToken.status}`);

    const noPrefix = await req('/memory', { token: '' });
    check('GET /memory 空 token 返回 401', noPrefix.status === 401);

    const ok = await req('/memory');
    check(
      'GET /memory 正确 token 返回 200 且含 memories 数组',
      ok.status === 200 && Array.isArray(ok.json && ok.json.memories),
      `实际 ${ok.status} / ${JSON.stringify(ok.json)}`
    );
  }

  origLog('\n记忆与情绪接口');
  {
    const emo = await req('/emotion');
    const validEmotions = ['calm', 'happy', 'playful', 'excited', 'tired', 'sad', 'annoyed', 'hurt'];
    check(
      'GET /emotion 返回合法情绪状态',
      emo.status === 200 && validEmotions.includes(emo.json && emo.json.emotion),
      JSON.stringify(emo.json)
    );
    check(
      'GET /emotion 强度在 0-100 之间',
      emo.json && typeof emo.json.intensity === 'number' && emo.json.intensity >= 0 && emo.json.intensity <= 100,
      JSON.stringify(emo.json)
    );

    const cleared = await req('/memory/clear', { method: 'POST' });
    check('POST /memory/clear 返回 200', cleared.status === 200, `实际 ${cleared.status}`);

    const after = await req('/memory');
    check('清空后记忆库为空', after.json && after.json.memories && after.json.memories.length === 0);

    const delBad = await req('/memory/delete', { method: 'POST', body: {} });
    check(
      'POST /memory/delete 缺参数时不崩溃',
      delBad.status >= 200 && delBad.status < 500,
      `实际 ${delBad.status}`
    );
  }

  origLog('\n聊天历史接口');
  {
    const h = await req('/history');
    check(
      'GET /history 返回 200 且含 history 数组',
      h.status === 200 && Array.isArray(h.json && h.json.history),
      `实际 ${h.status} / ${JSON.stringify(h.json)}`
    );

    const noId = await req('/history/recall', { method: 'POST', body: {} });
    check('POST /history/recall 缺 messageId 返回 400', noId.status === 400, `实际 ${noId.status}`);

    const notFound = await req('/history/recall', { method: 'POST', body: { messageId: 'not-exist-id' } });
    check('POST /history/recall 未知 id 返回 404', notFound.status === 404, `实际 ${notFound.status}`);

    const cleared = await req('/history/clear', { method: 'POST' });
    check('POST /history/clear 返回 200', cleared.status === 200, `实际 ${cleared.status}`);
  }

  origLog('\n/chat 接口与降级');
  {
    const noAuth = await req('/chat', { method: 'POST', token: null, body: { message: '你好' } });
    check('POST /chat 无 token 返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

    const empty = await req('/chat', { method: 'POST', body: { message: '   ' } });
    check('POST /chat 空消息返回 400', empty.status === 400, `实际 ${empty.status}`);
    check('空消息错误文案正确', empty.json && empty.json.error === '消息不能为空', JSON.stringify(empty.json));

    const noKey = await req('/chat', { method: 'POST', body: { message: '你好' } });
    check(
      '未配置 DEEPSEEK_API_KEY 时返回明确 500 提示',
      noKey.status === 500 && String(noKey.json && noKey.json.error).includes('DEEPSEEK_API_KEY'),
      JSON.stringify(noKey.json)
    );

    const cont = await req('/chat', { method: 'POST', body: { mode: 'continue' } });
    check('续写模式不因缺少 message 报 400', cont.status !== 400, `实际 ${cont.status}`);
  }

  origLog('\n限流（60 次/分钟，按 IP+token）');
  {
    let sawRateLimit = false;
    let used = 0;
    for (let i = 0; i < 90; i++) {
      const r = await req('/memory');
      used++;
      if (r.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    check('超过配额后返回 429', sawRateLimit, `已发 ${used} 次请求仍未限流`);

    const stillBlocked = await req('/memory');
    check('配额未重置前持续拦截', stillBlocked.status === 429, `实际 ${stillBlocked.status}`);

    const wrongToken = await req('/emotion', { token: 'another-token' });
    check('错误 token 在限流期间仍走鉴权返回 401', wrongToken.status === 401, `实际 ${wrongToken.status}`);
  }

  // 守卫 2（后置）：确认整轮跑下来真实数据目录一个字节都没变。
  const changed = diffSnapshot(snapshotBefore, snapshotRealData());
  check(
    '跑完后真实 server/data/ 未被改动',
    changed.length === 0,
    changed.length ? `变动：${changed.join('、')}` : ''
  );
  if (changed.length) {
    origLog('  ⚠ 数据隔离可能已失效，请检查 BLUEBIRD_DATA_DIR 是否生效。');
  }

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    origLog('\n失败明细：');
    failures.forEach(f => origLog(`  - ${f}`));
  }

  console.log = origLog;
  console.error = origErr;
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origLog('测试执行异常：' + error.message);
  process.exit(1);
});
