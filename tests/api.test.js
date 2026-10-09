/**
 * 云岫 Bluebird — 后端 HTTP 接口 (server/index.js) 行为测试
 *
 * 独立脚本（非 node:test）：服务入口 require 时即 app.listen 且未导出实例，
 * 因此这里自建极简 runner，测完显式退出，确保进程能结束。
 * 运行：node <本文件>
 */
const path = require('path');

process.env.PORT = '3999';
process.env.BLUEBIRD_API_TOKEN = 'test-token-bluebird';
delete process.env.DEEPSEEK_API_KEY; // 故意不配 API Key，验证降级路径

const BASE = 'http://127.0.0.1:3999';
const TOKEN = 'test-token-bluebird';

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

require(path.join(__dirname, '..', 'server', 'index.js'));

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

  origLog(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    origLog('\n失败明细：');
    failures.forEach(f => origLog('  - ' + f));
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
