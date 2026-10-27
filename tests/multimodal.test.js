/**
 * 云岫 Bluebird — 多模态后端测试（图片上传 / 视觉请求 / 表情包 / 附件回收）
 *
 * 独立脚本（非 node:test）：与 tests/chat-persist.test.js 同款极简 runner。
 * 隔离保证：
 *   - 数据全部落在系统临时目录（BLUEBIRD_DATA_DIR），不碰 server/data；
 *   - 注入 openai / memory.js / emotion.js 桩模块，不真正请求模型；
 *   - 端口 PORT=0 动态分配，不占用固定端口。
 *
 * 覆盖：
 *   A. 图片上传校验（MIME 白名单 / 魔数 / 大小 / kind）
 *   B. 图片读取与鉴权（bytes 一致 / 404 / 401 / 路径遍历）
 *   C. /chat 多模态（模型切换 / blocks 入参 / 落盘附件 / 表情包语法 /
 *      回复标记解析 / 历史降级）
 *   D. 附件回收（撤回 / 清理级联删图，同图复用不误删）
 *
 * 运行：node tests/multimodal.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 测试在进程内 require server/index.js，会真的起一个 HTTP 服务。
// 退出前必须关掉它（含 keep-alive 连接），否则 Windows 上 process.exit
// 会撞上 libuv 的 UV_HANDLE_CLOSING 断言，导致非零退出码。
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mm-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
const errorLines = [];

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

// ---- 测试图片素材 ----
// 真实 1x1 PNG（经典测试图，可直接肉眼验证头字节）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// 其他格式只需要通过魔数校验：用最小合法文件头构造
const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF_BUF = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00', 'binary');
const WEBP_BUF = Buffer.from(
  'RIFF' + '\x24\x00\x00\x00' + 'WEBPVP8 ' + '\x20\x00\x00\x00',
  'binary'
);

function dataUrl(buf, mime) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 超过 5MB 的"图片"：合法 PNG 头 + 填充
const HUGE_BUF = Buffer.concat([
  PNG_BUF,
  Buffer.alloc(5 * 1024 * 1024 + 1024, 0x41),
]);

// 假 PNG：文本内容但声明 image/png（魔数校验必须拦下）
const FAKE_BUF = Buffer.from('this is not a real png, just text', 'utf8');

function stubModule(file, exportsObj) {
  const target = require.resolve(path.join(SERVER, file));
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: exportsObj,
  };
}

async function main() {
  // ---- 桩模块：模型 / 记忆 / 情绪 ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  // 记录每次模型调用入参；回复内容可切换（默认带情绪标签，验证清洗逻辑）
  const modelCalls = [];
  let stubReply = '[calm] 这是回复正文。';

  require.cache[openaiTarget] = {
    id: openaiTarget,
    filename: openaiTarget,
    loaded: true,
    exports: class StubOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async args => {
              modelCalls.push(args);

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

  // 记录记忆提取入参：验证纯发图时的占位文本
  const memoryCalls = [];

  stubModule('memory.js', {
    buildMemoryContext: () => '',
    processMemory: async (client, text, sessionId) => {
      memoryCalls.push({ text, sessionId });
      return null;
    },
    clearMemories: () => {},
    recallMemoryBySourceQuote: async () => ({}),

    clearSessionMemories: async () => ({ removedEntries: 0, removedContributions: 0, remaining: 0, reason: "no-match" }),

    verifyStoreConsistency: () => ({ consistent: true, entries: 0, reason: "ok" }),

    getWriteOutcomes: () => [],
    getMemories: () => [],
    deleteMemory: () => false,
  });

  stubModule('emotion.js', {
    EMOTIONS: ['calm'],
    getEmotion: () => ({ emotion: 'calm', intensity: 0 }),
    buildEmotionContext: () => '',
    applyTimeDecay: state => state,
    applyObservation: () => ({ emotion: 'calm', intensity: 0 }),
  });

  // index.js 用 client 的存在与否决定是否调用模型：必须在 require 之前置好 key
  process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
  process.env.PORT = '0';
  process.env.BLUEBIRD_API_TOKEN = 'test-token-mm';
  process.env.DEEPSEEK_API_KEY = 'stub-key';

  const sessionsTarget = require.resolve(path.join(SERVER, 'sessions.js'));
  const indexTarget = require.resolve(path.join(SERVER, 'index.js'));
  delete require.cache[sessionsTarget];
  delete require.cache[indexTarget];

  require(sessionsTarget);
  const { server } = require(indexTarget);

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'test-token-mm';

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(BASE + '/')).ok;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (!ready) {
    check('服务启动', false, '5 秒内未就绪');
    await closeHttpServer();
    process.exit(1);
  }

  async function req(p, { method = 'GET', body, token = TOKEN } = {}) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let json = null;
    let buf = null;
    const contentType = res.headers.get('content-type') || '';
    try {
      if (contentType.includes('application/json')) {
        json = await res.json();
      } else {
        buf = Buffer.from(await res.arrayBuffer());
      }
    } catch (_) {
      /* 非 JSON */
    }

    return { status: res.status, json, buf, contentType };
  }

  // uploads 目录随数据目录走：断言文件级联删除时直接查它
  const UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');

  function findUploadFile(id) {
    if (!fs.existsSync(UPLOADS_ROOT)) return null;
    for (const month of fs.readdirSync(UPLOADS_ROOT)) {
      const dir = path.join(UPLOADS_ROOT, month);
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        continue;
      }
      const hit = entries.find(name => name.startsWith(`${id}.`));
      if (hit) return path.join(dir, hit);
    }
    return null;
  }

  // ================= A. 图片上传校验 =================
  ORIG_LOG('\nA. POST /uploads/image 上传校验');

  const okPng = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), kind: 'image', name: '猫.png' },
  });
  check(
    '合法 PNG 上传成功',
    okPng.status === 200 && okPng.json.id && okPng.json.mime === 'image/png',
    `status=${okPng.status}`
  );
  check(
    '上传返回大小与字节数一致',
    okPng.json.size === PNG_BUF.length,
    `${okPng.json.size} vs ${PNG_BUF.length}`
  );

  const okJpeg = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(JPEG_BUF, 'image/jpeg'), kind: 'image' },
  });
  check('JPEG 魔数通过', okJpeg.status === 200 && okJpeg.json.mime === 'image/jpeg');

  const okGif = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(GIF_BUF, 'image/gif'), kind: 'sticker', name: '哈哈.gif' },
  });
  check(
    'GIF 上传成功且识别为 sticker',
    okGif.status === 200 && okGif.json.mime === 'image/gif' && okGif.json.kind === 'sticker'
  );

  const okWebp = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(WEBP_BUF, 'image/webp'), kind: 'image' },
  });
  check('WebP 魔数通过', okWebp.status === 200 && okWebp.json.mime === 'image/webp');

  const fake = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(FAKE_BUF, 'image/png'), kind: 'image' },
  });
  check(
    '文本冒充 PNG 被魔数校验拒绝（400）',
    fake.status === 400 && /不是受支持的图片格式/.test(fake.json.error || ''),
    `status=${fake.status}`
  );

  const textMime = await req('/uploads/image', {
    method: 'POST',
    body: { image: 'data:text/plain;base64,aGVsbG8=', kind: 'image' },
  });
  check('非图片 MIME 被拒（400）', textMime.status === 400, `status=${textMime.status}`);

  const huge = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(HUGE_BUF, 'image/png'), kind: 'image' },
  });
  check('超大图片被拒（413）', huge.status === 413, `status=${huge.status}`);

  const badKind = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), kind: 'video' },
  });
  check('非法 kind 被拒（400）', badKind.status === 400, `status=${badKind.status}`);

  const noImage = await req('/uploads/image', {
    method: 'POST',
    body: { kind: 'image' },
  });
  check('缺少图片数据被拒（400）', noImage.status === 400, `status=${noImage.status}`);

  // sticker 入库后应出现在表情包库
  const stickers = await req('/stickers');
  check(
    'sticker 上传后出现在表情包库',
    stickers.json.stickers.some(s => s.id === okGif.json.id)
  );

  // ================= B. 图片读取与鉴权 =================
  ORIG_LOG('\nB. GET /uploads/image/:id 读取与鉴权');

  const readBack = await req(`/uploads/image/${okPng.json.id}`);
  check(
    '读回图片 bytes 一致且 Content-Type 正确',
    readBack.status === 200 &&
      readBack.buf &&
      readBack.buf.equals(PNG_BUF) &&
      readBack.contentType.includes('image/png'),
    `status=${readBack.status} type=${readBack.contentType}`
  );

  const notFound = await req('/uploads/image/00000000-0000-4000-8000-000000000000');
  check('未知 id 返回 404', notFound.status === 404, `status=${notFound.status}`);

  const noAuth = await req(`/uploads/image/${okPng.json.id}`, { token: null });
  check('无 token 读取返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  const traversal = await req('/uploads/image/..%2F..%2Fetc%2Fpasswd');
  check(
    '路径遍历 id 被拒（400/404，且不返回文件内容）',
    (traversal.status === 400 || traversal.status === 404) && !traversal.buf,
    `status=${traversal.status}`
  );

  // ================= C. /chat 多模态 =================
  ORIG_LOG('\nC. POST /chat 多模态请求');

  const created = await req('/sessions', { method: 'POST', body: { title: '多模态' } });
  const sessionId = created.json.session.id;
  check('创建测试会话', !!sessionId);

  // C1 带图请求 → 视觉模型 + blocks 入参
  modelCalls.length = 0;
  const chatWithImage = await req('/chat', {
    method: 'POST',
    body: {
      message: '看看这是啥',
      sessionId,
      attachmentIds: [okPng.json.id],
    },
  });
  check(
    '带图 /chat 成功',
    chatWithImage.status === 200 && chatWithImage.json.reply === '这是回复正文。',
    `status=${chatWithImage.status}`
  );
  check(
    '响应体带 userAttachments',
    Array.isArray(chatWithImage.json.userAttachments) &&
      chatWithImage.json.userAttachments[0] &&
      chatWithImage.json.userAttachments[0].id === okPng.json.id
  );

  const lastCall = modelCalls[modelCalls.length - 1];
  check(
    '带图请求切到视觉模型 deepseek-flash',
    lastCall && lastCall.model === 'deepseek-flash',
    `model=${lastCall && lastCall.model}`
  );

  const lastUserMsg = lastCall.messages[lastCall.messages.length - 1];
  check(
    '当前用户消息转成 content blocks 且含 image_url',
    Array.isArray(lastUserMsg.content) &&
      lastUserMsg.content.some(
        b => b.type === 'text' && b.text === '看看这是啥'
      ) &&
      lastUserMsg.content.some(
        b => b.type === 'image_url' && /^data:image\/png;base64,/.test(b.image_url.url)
      ),
    JSON.stringify(lastUserMsg).slice(0, 120)
  );

  // C2 落盘附件 + /history 可读回
  const history1 = await req(`/history?sessionId=${sessionId}`);
  const storedUser = history1.json.history.find(m => m.role === 'user');
  check(
    '用户图片消息落盘含 attachments',
    storedUser &&
      Array.isArray(storedUser.attachments) &&
      storedUser.attachments[0].id === okPng.json.id &&
      storedUser.content === '看看这是啥'
  );

  // C3 纯文本请求仍走原模型（用全新无图会话：上面会话历史已含图片）
  modelCalls.length = 0;
  const plainSession = await req('/sessions', {
    method: 'POST',
    body: { title: '纯文本' },
  });
  const chatText = await req('/chat', {
    method: 'POST',
    body: { message: '纯文本一句', sessionId: plainSession.json.session.id },
  });
  check(
    '无图会话的纯文本请求仍走 deepseek-chat',
    chatText.status === 200 &&
      modelCalls[modelCalls.length - 1].model === 'deepseek-chat',
    `model=${modelCalls[modelCalls.length - 1].model}`
  );

  // C4 历史含图片的会话，后续纯文本仍严格使用用户选择的默认模型
  // （旧实现会因历史有图而悄悄换成 deepseek-flash，导致设置里切模型失效）
  modelCalls.length = 0;
  const chatAfterImage = await req('/chat', {
    method: 'POST',
    body: { message: '刚才那张图再说说', sessionId },
  });
  check(
    '会话历史有图片时纯文本请求仍走所选模型 deepseek-chat',
    modelCalls[modelCalls.length - 1].model === 'deepseek-chat',
    `model=${modelCalls[modelCalls.length - 1].model}`
  );
  check(
    '目标模型无视觉能力时历史图片降级为文本（不发 image_url block）',
    !modelCalls[modelCalls.length - 1].messages.some(
      m => Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
    )
  );
  check(
    '降级后的历史用户消息保留原文',
    modelCalls[modelCalls.length - 1].messages.some(
      m => m.role === 'user' && m.content === '看看这是啥'
    )
  );

  // C5 纯发图（无文字）
  modelCalls.length = 0;
  const chatImageOnly = await req('/chat', {
    method: 'POST',
    body: { sessionId, attachmentIds: [okWebp.json.id] },
  });
  check(
    '纯发图（无文字）合法且落盘 content 为空串',
    chatImageOnly.status === 200,
    `status=${chatImageOnly.status}`
  );
  const imageOnlyUser = lastUserBlock(modelCalls);
  check(
    '纯发图的用户消息只有 image block，没有空 text block',
    imageOnlyUser &&
      Array.isArray(imageOnlyUser.content) &&
      imageOnlyUser.content.length === 1 &&
      imageOnlyUser.content[0].type === 'image_url'
  );

  function lastUserBlock(calls) {
    const call = calls[calls.length - 1];
    return call && call.messages[call.messages.length - 1];
  }

  // C6 表情包语境 + 输出语法
  modelCalls.length = 0;
  memoryCalls.length = 0;
  const chatSticker = await req('/chat', {
    method: 'POST',
    body: {
      message: '',
      sessionId,
      attachmentIds: [okGif.json.id],
    },
  });
  check('发送表情包（sticker）成功', chatSticker.status === 200);
  const stickerSystem = modelCalls[modelCalls.length - 1].messages[0].content;
  check(
    'sticker 请求的 system prompt 含表情包理解指引',
    /表情包是一种图像化的情绪表达/.test(stickerSystem)
  );
  check(
    'sticker 请求的 system prompt 含候选列表发送语法',
    /\[sticker:ID\]/.test(stickerSystem) && /【可发送的表情包】/.test(stickerSystem),
    stickerSystem.slice(0, 200)
  );
  check(
    '纯发图时记忆提取收到占位文本而非空串',
    memoryCalls.some(c => c.text === '（发送了1张表情包）'),
    JSON.stringify(memoryCalls)
  );

  // C7 附件数量与有效性校验
  const tooMany = await req('/chat', {
    method: 'POST',
    body: {
      message: '太多图',
      sessionId,
      attachmentIds: [okPng.json.id, okPng.json.id, okPng.json.id, okPng.json.id, okPng.json.id],
    },
  });
  check('超过 4 张附件返回 400', tooMany.status === 400, `status=${tooMany.status}`);

  const badId = await req('/chat', {
    method: 'POST',
    body: {
      message: '坏图',
      sessionId,
      attachmentIds: ['00000000-0000-4000-8000-000000000000'],
    },
  });
  check('无效附件 id 返回 400', badId.status === 400, `status=${badId.status}`);

  // C8 AI 回复发表情包（标记解析）
  stubReply = '看这个 [sticker:哈哈] 送给你';
  modelCalls.length = 0;
  const chatReplySticker = await req('/chat', {
    method: 'POST',
    body: { message: '给我发表情', sessionId },
  });
  check(
    '回复中的 [sticker:关键词] 被解析为附件',
    chatReplySticker.json.assistantAttachments.length === 1 &&
      chatReplySticker.json.assistantAttachments[0].kind === 'sticker' &&
      chatReplySticker.json.assistantAttachments[0].id === okGif.json.id,
    JSON.stringify(chatReplySticker.json.assistantAttachments)
  );
  check(
    '标记从正文剥离且不留残留（连续空白压缩为一个）',
    chatReplySticker.json.reply === '看这个 送给你',
    JSON.stringify(chatReplySticker.json.reply)
  );

  const history2 = await req(`/history?sessionId=${sessionId}`);
  const storedAssistant = history2.json.history.filter(m => m.role === 'assistant').pop();
  check(
    'AI 表情包消息落盘含 attachments',
    storedAssistant &&
      Array.isArray(storedAssistant.attachments) &&
      storedAssistant.attachments[0].kind === 'sticker'
  );

  // C9 历史里 AI 的表情包消息以协议标记回显（DeepSeek 只接受 user 消息带图）：
  // 占位即唯一合法输出格式——入参必须含 [sticker: 标记，且文件名不得随占位出现
  modelCalls.length = 0;
  await req('/chat', { method: 'POST', body: { message: '继续聊', sessionId } });
  const c9Messages = modelCalls[modelCalls.length - 1].messages;
  const degraded = c9Messages.find(
    m => m.role === 'assistant' && typeof m.content === 'string' &&
      m.content.includes('[sticker:')
  );
  check(
    '历史 AI 表情包消息降级为含 [sticker: 的文本占位',
    !!degraded,
    JSON.stringify(c9Messages.filter(m => m.role === 'assistant').map(m => m.content))
  );
  check(
    '历史占位不含表情包文件名（哈哈.gif）',
    !!degraded && !degraded.content.includes('哈哈.gif'),
    degraded ? degraded.content : '(未找到占位消息)'
  );

  // C9b 占位必须携带对应仓库 ID（模型复述即合法），且不出现 att.name
  check(
    '历史占位携带对应表情包仓库 ID 且不出现 att.name',
    !!degraded &&
      degraded.content.includes(`[sticker:${okGif.json.id}]`) &&
      !degraded.content.includes('哈哈.gif'),
    degraded ? degraded.content : '(未找到占位消息)'
  );

  // C10 AI 回复引用不存在图片 / 不匹配的表情包：静默忽略
  stubReply = '看图 [image:00000000-0000-4000-8000-000000000000] 和 [sticker:不存在的词]';
  const chatBadRefs = await req('/chat', {
    method: 'POST',
    body: { message: '引用测试', sessionId },
  });
  check(
    '无效 [image:ID] 与不匹配 [sticker:关键词] 被忽略',
    chatBadRefs.json.assistantAttachments.length === 0 &&
      !/\[image:|\[sticker:/.test(chatBadRefs.json.reply),
    JSON.stringify(chatBadRefs.json.reply)
  );

  // C11 防御：模型复述旧版占位文案「（发送了表情包：…）」→ 整句剥除，不入正文
  stubReply = '好吧 （发送了表情包：哈哈.gif）';
  const chatParrot = await req('/chat', {
    method: 'POST',
    body: { message: '复述占位', sessionId },
  });
  check(
    '模型复述的旧版占位文案被整句剥除',
    chatParrot.status === 200 && chatParrot.json.reply === '好吧',
    JSON.stringify(chatParrot.json.reply)
  );

  // 恢复正常回复
  stubReply = '[calm] 这是回复正文。';

  // ================= D. 附件回收 =================
  ORIG_LOG('\nD. 撤回 / 清理的图片级联回收');

  // D1 撤回带图消息 → 文件删除
  const beforeRecall = await req(`/history?sessionId=${sessionId}`);
  const imageMsg = beforeRecall.json.history.find(
    m => m.role === 'user' && Array.isArray(m.attachments) &&
      m.attachments.some(a => a.id === okWebp.json.id)
  );
  check('找到带 WebP 附件的用户消息（纯发图那条）', !!imageMsg);

  const recall = await req('/history/recall', {
    method: 'POST',
    body: { messageId: imageMsg.id, sessionId },
  });
  check('撤回带图消息成功', recall.status === 200, `status=${recall.status}`);
  check(
    '撤回后图片文件被级联删除（无其他引用）',
    findUploadFile(okWebp.json.id) === null
  );

  // D2 同图复用：两消息引用同一张图，撤一个不删，撤两个才删。
  // 必须用一张全新上传的图——okPng 还被 C1 的消息引用着，撤任何一条都不会删。
  const reuseUpload = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), kind: 'image' },
  });
  const reuseId = reuseUpload.json.id;

  const chatA = await req('/chat', {
    method: 'POST',
    body: { message: '第一次发', sessionId, attachmentIds: [reuseId] },
  });
  const chatB = await req('/chat', {
    method: 'POST',
    body: { message: '第二次发', sessionId, attachmentIds: [reuseId] },
  });
  check('同图复用两轮均成功', chatA.status === 200 && chatB.status === 200);

  const recallB = await req('/history/recall', {
    method: 'POST',
    body: { messageId: chatB.json.userMessageId, sessionId },
  });
  check('撤回第二条带图消息成功', recallB.status === 200);
  check(
    '仍有其他消息引用，图片文件保留',
    findUploadFile(reuseId) !== null
  );

  const recallA = await req('/history/recall', {
    method: 'POST',
    body: { messageId: chatA.json.userMessageId, sessionId },
  });
  check('撤回第一条带图消息成功', recallA.status === 200);
  check(
    '最后一条引用撤走后图片文件才删除',
    findUploadFile(reuseId) === null
  );

  // D3 手动 DELETE：被引用 409，无引用可删
  const uploadForDelete = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), kind: 'image' },
  });
  const delOk = await req(`/uploads/image/${uploadForDelete.json.id}`, {
    method: 'DELETE',
  });
  check('无引用图片可手动删除', delOk.status === 200, `status=${delOk.status}`);

  const chatForDel = await req('/chat', {
    method: 'POST',
    body: { message: '占位', sessionId },
  });
  const up2 = await req('/uploads/image', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), kind: 'image' },
  });
  const chatRef = await req('/chat', {
    method: 'POST',
    body: { message: '引用新图', sessionId, attachmentIds: [up2.json.id] },
  });
  const delBusy = await req(`/uploads/image/${up2.json.id}`, { method: 'DELETE' });
  check(
    '被聊天记录引用的图片删除返回 409',
    delBusy.status === 409,
    `status=${delBusy.status}`
  );

  // D4 清空会话 → 级联删除剩余附件
  const clear = await req('/history/clear', {
    method: 'POST',
    body: { sessionId },
  });
  check('清空会话成功', clear.status === 200);
  check(
    '清空后被引用图片文件被回收',
    findUploadFile(up2.json.id) === null
  );

  const delGone = await req(`/uploads/image/${up2.json.id}`, { method: 'DELETE' });
  check('回收后的图片再删返回 404', delGone.status === 404, `status=${delGone.status}`);

  // ---- 汇总 ----
  ORIG_LOG(
    `\n结果：${passed} 通过，${failed} 失败` +
      (failures.length ? `\n失败项：\n  - ${failures.join('\n  - ')}` : '')
  );

  // 意外错误日志也报出来（桩模块故意静默，真实错误不该被吞）
  const unexpected = errorLines.filter(
    line => !/History persist FAILED/.test(line)
  );
  if (unexpected.length) {
    ORIG_LOG(`\n服务端错误日志 ${unexpected.length} 条：`);
    unexpected.slice(0, 5).forEach(line => ORIG_LOG(`  ${line}`));
  }

  await closeHttpServer();
  process.exit(failed ? 1 : 0);
}

main().catch(async error => {
  ORIG_ERR('测试运行异常:', error);
  await closeHttpServer();
  process.exit(1);
});
