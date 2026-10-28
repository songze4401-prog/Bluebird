/**
 * 云岫 Bluebird — 流式输出（SSE）测试
 *
 * 独立脚本（非 node:test）：与 tests/persona.test.js 同款极简 runner。
 * 隔离保证：所有数据都落在系统临时目录（BLUEBIRD_DATA_DIR），
 * 不读取、修改或清空真实 server/data。
 *
 * 覆盖：
 *   - stream-strip 纯函数：整块/跨 chunk/全角/裸标签/多标签/非标签方括号/
 *     超长缓冲兜底/半截标签 flush/正文残留标签透传；stripMoodTags 与旧版规则一致；
 *   - POST /chat/stream：SSE 分帧、delta 增量、done 字段与 /chat 一致、
 *     情绪标签不泄露、落盘时机与内容、续写只落 assistant、分条保留；
 *   - 失败路径：未授权 401 / 空消息 400 / 未知会话 404（均为普通 JSON）、
 *     流中途错误 -> error 事件且不落盘；
 *   - 共存：旧 /chat 非流式接口行为不变。
 *
 * 运行：node tests/chat-stream.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 退出前关掉 HTTP 服务（含 keep-alive），避免 Windows 上 libuv 断言
const originalListen = http.Server.prototype.listen;
let httpServer = null;

http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return originalListen.apply(this, args);
};

async function closeHttpServer() {
  if (!httpServer) return;

  const server = httpServer;
  httpServer = null;

  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (_) {
    /* ignore */
  }

  await new Promise(resolve => server.close(() => resolve()));
}

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-stream-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 真实 1x1 PNG：用于验证“纯图片流式请求”会走完整的 HTTP 上传与 /chat/stream。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;

console.log = () => {};
console.error = () => {};

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

// ---- 桩模块：模型（stream:true 返回假流）/ 记忆 ----
const capturedParams = [];
const memoryCalls = [];
let stubReply = '[mood:calm] 非流式回复';
let stubChunks = [];
let stubErrorAt = -1; // >=0 时在第 N 个 chunk 处抛错

class StubStream {
  constructor(chunks, errorAt) {
    this.chunks = chunks;
    this.errorAt = errorAt;
    this.model = 'stub-model';
    this.controller = {
      aborted: false,
      abort() {
        this.aborted = true;
      },
    };
  }

  async *[Symbol.asyncIterator]() {
    for (let i = 0; i < this.chunks.length; i++) {
      if (i === this.errorAt) throw new Error('stub stream failure');
      yield {
        model: 'stub-model',
        choices: [{ delta: { content: this.chunks[i] } }],
      };
    }
  }
}

const openaiTarget = require.resolve('openai', { paths: [SERVER] });

require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async params => {
            capturedParams.push(params);

            if (params.stream) {
              return new StubStream(stubChunks, stubErrorAt);
            }

            return {
              model: 'stub-model',
              choices: [{ message: { content: stubReply } }],
            };
          },
        },
      };
    }
  },
};

{
  const memoryTarget = require.resolve(path.join(SERVER, 'memory.js'));
  require.cache[memoryTarget] = {
    id: memoryTarget,
    filename: memoryTarget,
    loaded: true,
    exports: {
      buildMemoryContext: () => '',
      processMemory: async (...args) => {
        memoryCalls.push(args);
        return null;
      },
      clearMemories: () => {},
      recallMemoryBySourceQuote: async () => ({}),

      clearSessionMemories: async () => ({ removedEntries: 0, removedContributions: 0, remaining: 0, reason: "no-match" }),

      verifyStoreConsistency: () => ({ consistent: true, entries: 0, reason: "ok" }),

      getWriteOutcomes: () => [],
      getMemories: () => [],
      deleteMemory: () => false,
    },
  };
}

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.PORT = '0';
process.env.BLUEBIRD_API_TOKEN = 'test-token-stream';
process.env.DEEPSEEK_API_KEY = 'stub-key';

const { stripMoodTags, createMoodTagStripper } = require(path.join(
  SERVER,
  'stream-strip.js'
));
const { server } = require(path.join(SERVER, 'index.js'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响测试结果 */
  }
});

// 读完整 SSE 响应体并解析事件
async function readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();

  const events = [];

  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch (_) {
          /* 忽略无法解析的行 */
        }
      }
    }
  }

  return { text, events };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  return predicate();
}

async function main() {
  ORIG_LOG('\nA. stream-strip 纯函数');

  {
    const r = stripMoodTags('[mood:happy] 你好呀');
    check('全量：规范标签剥离并认领', r.reply === '你好呀' && r.mood === 'happy');
  }
  {
    const r = stripMoodTags('[calm] 在的');
    check('全量：裸标签剥离并认领', r.reply === '在的' && r.mood === 'calm');
  }
  {
    const r = stripMoodTags('[mood:weird] 你好');
    check(
      '全量：未知情绪词只剥不认领',
      r.reply === '你好' && r.mood === 'calm'
    );
  }
  {
    const r = stripMoodTags('前半[mood:happy] 后半');
    check('全量：正文残留标签清除', r.reply === '前半 后半');
  }
  {
    const r = stripMoodTags('[mood:calm]');
    check(
      '全量：整条只有标签回退原文',
      r.reply === '[mood:calm]' && r.mood === 'calm'
    );
  }

  {
    const s = createMoodTagStripper();
    const out = s.push('[mood:happy] 你好') + s.flush();
    check('增量：整块标签剥掉', out === ' 你好');
  }
  {
    const s = createMoodTagStripper();
    const a = s.push('[mo');
    const b = s.push('od:calm] 在');
    check(
      '增量：标签跨 chunk 不泄露',
      a === '' && b === ' 在' && s.flush() === ''
    );
  }
  {
    const s = createMoodTagStripper();
    check(
      '增量：无标签立即放行',
      s.push('直接正文') === '直接正文' && s.flush() === ''
    );
  }
  {
    const s = createMoodTagStripper();
    const a = s.push('［mood');
    const b = s.push('：happy］来了');
    check('增量：全角标签跨 chunk', a === '' && b === '来了');
  }
  {
    const s = createMoodTagStripper();
    check(
      '增量：多标签连发都剥掉',
      s.push('[mood:happy] [mood:sad] 正文') === ' 正文'
    );
  }
  {
    const s = createMoodTagStripper();
    check(
      '增量：非标签方括号整块放行',
      s.push('[今天] 天气不错') === '[今天] 天气不错'
    );
  }
  {
    const s = createMoodTagStripper();
    const a = s.push('[今');
    const b = s.push('天] 好');
    check(
      '增量：非标签方括号分段也不吞',
      a === '' && b === '[今天] 好'
    );
  }
  {
    const s = createMoodTagStripper();
    const long = '[' + 'x'.repeat(100);
    check('增量：超长未闭合缓冲兜底放行', s.push(long) === long);
  }
  {
    const s = createMoodTagStripper();
    const a = s.push('[mo');
    check(
      '增量：半截标签 flush 原样释放',
      a === '' && s.flush() === '[mo'
    );
  }
  {
    const s = createMoodTagStripper();
    const a = s.push('你');
    const b = s.push('[mood:happy]');
    check(
      '增量：正文开始后标签透传（由收尾全量清洗兜底）',
      a === '你' && b === '[mood:happy]'
    );
  }

  ORIG_LOG('\nB. /chat/stream 接口');

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-stream';
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const JSON_AUTH = { 'Content-Type': 'application/json', ...AUTH };

  let ready = false;

  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  check('服务启动', ready);
  if (!ready) return await finish();

  const postStream = body =>
    fetch(BASE + '/chat/stream', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify(body),
    });

  // ---- 校验类错误：普通 JSON，不是 SSE ----
  const unauth = await fetch(BASE + '/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });
  check(
    '未授权 401 且为 JSON',
    unauth.status === 401 &&
      (unauth.headers.get('content-type') || '').includes('application/json')
  );

  const emptyMsg = await postStream({ message: '   ' });
  check('空消息 400 JSON', emptyMsg.status === 400);

  const unknownSession = await postStream({
    message: 'hi',
    sessionId: 'no-such-session',
  });
  check('未知会话 404 JSON', unknownSession.status === 404);

  // ---- 正常流式全流程 ----
  stubChunks = ['[mood:happy] 你', '好呀，', '今天想', '聊点什么？'];
  stubErrorAt = -1;

  const res1 = await postStream({ message: '在吗' });
  const sse1 = await readSSE(res1);

  check(
    '响应是 SSE',
    res1.status === 200 &&
      (res1.headers.get('content-type') || '').includes('text/event-stream')
  );

  const deltas1 = sse1.events.filter(e => e.type === 'delta');
  const done1 = sse1.events.find(e => e.type === 'done');

  check('收到多个 delta（增量推送）', deltas1.length >= 2, `=${deltas1.length}`);
  check(
    'delta 不含情绪标签',
    !deltas1.some(d => typeof d.content === 'string' && d.content.includes('[mood'))
  );

  const joined1 = deltas1.map(d => d.content).join('');
  check(
    'done 存在且字段齐全',
    !!done1 &&
      typeof done1.reply === 'string' &&
      Array.isArray(done1.replies) &&
      done1.persisted === true &&
      done1.sessionId === 'default' &&
      typeof done1.userMessageId === 'string' &&
      typeof done1.assistantMessageId === 'string' &&
      typeof done1.createdAt === 'string' &&
      typeof done1.mood === 'string'
  );
  check(
    'delta 拼接与权威 reply 一致（去首尾空白）',
    !!done1 && joined1.trim() === done1.reply
  );

  // 流式调用确实带了 stream:true，且 systemPrompt 完整注入
  const streamParam = capturedParams[capturedParams.length - 1];
  check(
    '模型以 stream:true 调用且 systemPrompt 完整',
    streamParam.stream === true &&
      typeof streamParam.messages[0].content === 'string' &&
      streamParam.messages[0].content.includes('Bluebird')
  );

  // ---- 落盘验证 ----
  const history1 = await (
    await fetch(BASE + '/history?limit=200', { headers: AUTH })
  ).json();

  const userMsg1 = history1.history.find(
    m => m.role === 'user' && m.content === '在吗'
  );
  const aiMsg1 = history1.history.find(
    m => m.role === 'assistant' && done1 && m.id === done1.assistantMessageId
  );

  check(
    '落盘：用户消息与回复都在，id 与 done 一致',
    !!userMsg1 &&
      !!aiMsg1 &&
      userMsg1.id === done1.userMessageId &&
      aiMsg1.content === done1.replies[0].content
  );

  // ---- 正文残留标签：delta 透传，done 校正 ----
  stubChunks = ['[mood:calm] 前半', '[mood:happy] 后半'];
  const res2 = await postStream({ message: '继续聊' });
  const sse2 = await readSSE(res2);
  const deltas2 = sse2.events.filter(e => e.type === 'delta');
  const done2 = sse2.events.find(e => e.type === 'done');

  check(
    '正文残留标签：done 权威文本已清除',
    !!done2 && done2.reply === '前半 后半' && !done2.reply.includes('mood')
  );
  check(
    '正文残留标签：delta 阶段如实透传（由 done 校正）',
    deltas2.map(d => d.content).join('').includes('[mood:happy]')
  );

  // ---- 分条保留（默认 persona 为 auto）----
  stubChunks = ['[mood:calm] 第一段。\n\n第', '二段。\n\n第三段。'];
  const res3 = await postStream({ message: '分条测试' });
  const sse3 = await readSSE(res3);
  const done3 = sse3.events.find(e => e.type === 'done');

  check(
    '分条：done.replies 拆成 3 条',
    !!done3 &&
      done3.replies.length === 3 &&
      done3.replies[0].content === '第一段。' &&
      done3.replies[2].content === '第三段。',
    done3 ? `=${done3.replies.length}` : 'no done'
  );

  // ---- 续写模式：只落 assistant ----
  const beforeCont = (
    await (await fetch(BASE + '/history?limit=200', { headers: AUTH })).json()
  ).history.length;

  stubChunks = ['[mood:calm] 接着上', '次继续说'];
  const res4 = await postStream({ mode: 'continue' });
  const sse4 = await readSSE(res4);
  const done4 = sse4.events.find(e => e.type === 'done');

  const afterCont = (
    await (await fetch(BASE + '/history?limit=200', { headers: AUTH })).json()
  ).history;

  check(
    '续写：userMessageId 为 null 且只落 assistant',
    !!done4 &&
      done4.userMessageId === null &&
      afterCont.length === beforeCont + done4.replies.length &&
      afterCont
        .slice(beforeCont)
        .every(m => m.role === 'assistant')
  );

  // ---- 流中途错误：error 事件，不落盘 ----
  const beforeErr = afterCont.length;

  stubChunks = ['[mood:calm] 说', '到一半'];
  stubErrorAt = 1;
  const res5 = await postStream({ message: '会失败的消息' });
  const sse5 = await readSSE(res5);
  stubErrorAt = -1;

  const errEvent = sse5.events.find(e => e.type === 'error');
  const doneEvent5 = sse5.events.find(e => e.type === 'done');

  const afterErr = (
    await (await fetch(BASE + '/history?limit=200', { headers: AUTH })).json()
  ).history.length;

  check(
    '流中途错误：收到 error 事件且无 done',
    !!errEvent && typeof errEvent.error === 'string' && !doneEvent5
  );
  check('流中途错误：不落盘（无幽灵消息）', afterErr === beforeErr);

  // ---- 共存：旧 /chat 非流式行为不变 ----
  stubReply = '[mood:calm] 非流式回复';
  const res6 = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ message: '旧接口' }),
  });
  const body6 = await res6.json();

  check(
    '旧 /chat 仍返回一次性 JSON',
    res6.status === 200 &&
      !(res6.headers.get('content-type') || '').includes('event-stream') &&
      body6.reply === '非流式回复' &&
      body6.persisted === true &&
      Array.isArray(body6.replies)
  );

  // ---- 纯图片流式请求：异步记忆提取必须拿到附件占位文本 ----
  ORIG_LOG('\nG. 纯图片流式请求的记忆提取');

  const uploadRes = await fetch(BASE + '/uploads/image', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      image: `data:image/png;base64,${PNG_B64}`,
      kind: 'image',
      name: 'pixel.png',
    }),
  });
  const upload = await uploadRes.json();

  check(
    '纯图片测试：上传成功',
    uploadRes.status === 200 && typeof upload.id === 'string',
    JSON.stringify(upload)
  );

  if (upload.id) {
    const beforeImageMemoryCalls = memoryCalls.length;
    stubChunks = ['[mood:calm] 收到图片'];
    stubErrorAt = -1;

    const resImage = await postStream({
      message: '',
      attachmentIds: [upload.id],
    });
    const sseImage = await readSSE(resImage);
    const doneImage = sseImage.events.find(e => e.type === 'done');

    check(
      '纯图片测试：/chat/stream 正常完成',
      resImage.status === 200 && !!doneImage && doneImage.persisted === true
    );

    const imageCall = await waitFor(() =>
      memoryCalls
        .slice(beforeImageMemoryCalls)
        .some(args => args[1] === '（发送了1张图片）' && args[2] === 'default')
    );

    check(
      '纯图片测试：记忆提取收到附件占位文本',
      imageCall,
      JSON.stringify(
        memoryCalls
          .slice(beforeImageMemoryCalls)
          .map(args => ({ text: args[1], sessionId: args[2] }))
      )
    );
  }

  await finish();
}

async function finish() {
  await closeHttpServer();

  ORIG_LOG('');
  ORIG_LOG(`通过 ${passed} 项，失败 ${failed} 项`);

  if (failed > 0) {
    ORIG_LOG('\n失败项：');
    for (const item of failures) ORIG_LOG(`  - ${item}`);
  }

  console.log = ORIG_LOG;
  console.error = ORIG_ERR;

  // 不调用 process.exit：等句柄自然排空，避免 Windows 上 libuv 断言
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  ORIG_ERR('chat-stream test crashed:', error);
  process.exitCode = 1;
});
