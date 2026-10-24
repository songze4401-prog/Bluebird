/**
 * 云岫 Bluebird — 表情包仓库与 AI 收发测试
 *
 * 独立脚本（非 node:test）：与 tests/multimodal.test.js 同款极简 runner。
 * 隔离保证：
 *   - 数据全部落在系统临时目录（BLUEBIRD_DATA_DIR），不碰 server/data；
 *   - 注入 openai / memory.js / emotion.js 桩模块，不真正请求模型；
 *   - 端口 PORT=0 动态分配，不占用固定端口。
 *
 * 注意：服务端限流 60 次/分钟（按 IP+token），本文件请求数必须控制在 60 以内，
 * 因此弱断言（404 幂等等）从略，重点覆盖核心语义与安全路径。
 *
 * 覆盖：
 *   A. POST /sticker-repo 上传校验（四格式魔数 / 假 MIME / 超大 / 空数据 / 落盘）
 *   B. 重复图片检测（同 sha256 不落新文件）
 *   C. 收藏聊天附件（collect / 404 / 原附件不动）
 *   D. 列表与筛选（q / 元数据 / 图片读取 / 鉴权）
 *   E. PATCH 备注与标签
 *   F. 物理删除（文件+索引俱毁 / 再读 404 / 图片 410 占位）
 *   G. /chat 发送（stickerIds / 无效 ID / 数量上限）
 *   H. 历史接口 expired 标注（删除后占位 / 聊天记录不破坏）
 *   I. AI 收发（候选列表注入+20 条上限 / ID 精确 / 编造忽略 / 关键词兜底 / 单条上限）
 *   J. 语义描述（手动成功 / 失败记录可重试 / mood 筛选贯通）
 *   K. 重启保留（磁盘索引读回 / legacy 不复活）
 *
 * 运行：node tests/sticker-repo.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 退出前必须关掉 HTTP 服务（含 keep-alive 连接），否则 Windows 上
// process.exit 会撞 libuv 的 UV_HANDLE_CLOSING 断言导致非零退出码。
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-sticker-'));
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

const HUGE_BUF = Buffer.concat([
  PNG_BUF,
  Buffer.alloc(5 * 1024 * 1024 + 1024, 0x41),
]);
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

// ---- 预置旧雏形数据（I/K 组迁移用）：uploads 月目录 + stickers.json ----
const LEGACY_ID = '11111111-2222-4333-8444-555555555555';
fs.mkdirSync(path.join(DATA_DIR, 'uploads', '2026-01'), { recursive: true });
fs.writeFileSync(
  path.join(DATA_DIR, 'uploads', '2026-01', `${LEGACY_ID}.png`),
  PNG_BUF
);
fs.writeFileSync(
  path.join(DATA_DIR, 'stickers.json'),
  JSON.stringify({
    version: 1,
    stickers: [
      {
        id: LEGACY_ID,
        name: '旧表情.png',
        mime: 'image/png',
        size: PNG_BUF.length,
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'sticker',
      },
    ],
  })
);

async function main() {
  // ---- 桩模块：模型 / 记忆 / 情绪 ----
  const openaiTarget = require.resolve('openai', { paths: [SERVER] });

  const modelCalls = [];
  let stubReply = '[calm] 好的。';
  // 语义分析调用可控：ok 返回 JSON，fail 抛错（验证失败原因记录）
  let semanticMode = 'ok';

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
              const sys =
                args.messages && args.messages[0] && args.messages[0].content;

              if (typeof sys === 'string' && sys.includes('语义分析器')) {
                if (semanticMode === 'fail') {
                  throw new Error('stub semantic failure');
                }
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          mood: '开心',
                          scene: '朋友调侃',
                          meaning: '开心大笑',
                          tags: ['搞笑', '开心'],
                        }),
                      },
                    },
                  ],
                };
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

  const memoryCalls = [];

  stubModule('memory.js', {
    buildMemoryContext: () => '',
    processMemory: async (client, text, sessionId) => {
      memoryCalls.push({ text, sessionId });
      return null;
    },
    clearMemories: () => {},
    recallMemoryBySourceQuote: async () => {},
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

  process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
  process.env.PORT = '0';
  process.env.BLUEBIRD_API_TOKEN = 'test-token-sticker';
  process.env.DEEPSEEK_API_KEY = 'stub-key';
  delete process.env.STICKER_SEMANTIC_AUTO; // 默认关闭自动语义

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
  const TOKEN = 'test-token-sticker';

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

    return { status: res.status, json, buf, contentType, headers: res.headers };
  }

  const REPO_DIR = path.join(DATA_DIR, 'sticker-repo');
  const FILES_DIR = path.join(REPO_DIR, 'files');
  const INDEX_FILE = path.join(REPO_DIR, 'sticker-repo.json');

  function stickerFilePath(id, ext) {
    return path.join(FILES_DIR, `${id}.${ext}`);
  }

  // uploads 目录随数据目录走：断言"原附件不动"时直接查文件系统（不发请求）
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

  // ================= A. POST /sticker-repo 上传校验 =================
  ORIG_LOG('\nA. POST /sticker-repo 上传校验');

  const addPng = await req('/sticker-repo', {
    method: 'POST',
    body: {
      image: dataUrl(PNG_BUF, 'image/png'),
      name: '猫猫.png',
      note: '可爱猫猫',
      tags: ['动物', '猫'],
    },
  });
  check(
    '合法 PNG 入库成功',
    addPng.status === 200 &&
      addPng.json.ok === true &&
      addPng.json.existing === false &&
      addPng.json.sticker.id &&
      addPng.json.sticker.mime === 'image/png',
    `status=${addPng.status}`
  );
  check(
    '入库元数据完整（size/sha256/来源/标签）',
    addPng.json.sticker.size === PNG_BUF.length &&
      /^[0-9a-f]{64}$/.test(addPng.json.sticker.sha256) &&
      addPng.json.sticker.source === 'upload' &&
      Array.isArray(addPng.json.sticker.tags) &&
      addPng.json.sticker.tags.join(',') === '动物,猫',
    JSON.stringify(addPng.json.sticker)
  );
  check(
    '对外响应不暴露服务端文件路径（无 file 字段）',
    addPng.json.sticker.file === undefined
  );
  check(
    '图片文件落盘在 sticker-repo/files/ 下',
    fs.existsSync(stickerFilePath(addPng.json.sticker.id, 'png')) &&
      fs
        .readFileSync(stickerFilePath(addPng.json.sticker.id, 'png'))
        .equals(PNG_BUF)
  );
  check('索引文件 sticker-repo.json 已创建', fs.existsSync(INDEX_FILE));

  const addJpeg = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(JPEG_BUF, 'image/jpeg') },
  });
  check(
    'JPEG 魔数通过',
    addJpeg.status === 200 && addJpeg.json.sticker.mime === 'image/jpeg'
  );

  const addGif = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(GIF_BUF, 'image/gif'), name: '哈哈.gif' },
  });
  check(
    'GIF 魔数通过',
    addGif.status === 200 && addGif.json.sticker.mime === 'image/gif'
  );

  const addWebp = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(WEBP_BUF, 'image/webp') },
  });
  check(
    'WebP 魔数通过',
    addWebp.status === 200 && addWebp.json.sticker.mime === 'image/webp'
  );

  const fake = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(FAKE_BUF, 'image/png') },
  });
  check(
    '文本冒充 PNG 被魔数校验拒绝（400）',
    fake.status === 400 && /不是受支持的图片格式/.test(fake.json.error || ''),
    `status=${fake.status}`
  );

  const textMime = await req('/sticker-repo', {
    method: 'POST',
    body: { image: 'data:text/plain;base64,aGVsbG8=' },
  });
  check('非图片 MIME 被拒（400）', textMime.status === 400, `status=${textMime.status}`);

  const huge = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(HUGE_BUF, 'image/png') },
  });
  check('超大图片被拒（413）', huge.status === 413, `status=${huge.status}`);

  const noImage = await req('/sticker-repo', { method: 'POST', body: {} });
  check('缺少图片数据被拒（400）', noImage.status === 400, `status=${noImage.status}`);

  // ================= B. 重复检测 =================
  ORIG_LOG('\nB. 重复图片检测');

  const dup = await req('/sticker-repo', {
    method: 'POST',
    body: { image: dataUrl(PNG_BUF, 'image/png'), name: '重复.png' },
  });
  check(
    '同一张图再次上传返回 existing:true 且 id 相同',
    dup.status === 200 &&
      dup.json.existing === true &&
      dup.json.sticker.id === addPng.json.sticker.id,
    JSON.stringify(dup.json).slice(0, 120)
  );
  check(
    '重复上传不产生新文件（files 目录只有一个 png）',
    fs.readdirSync(FILES_DIR).filter(n => n.endsWith('.png')).length === 1,
    fs.readdirSync(FILES_DIR).join(',')
  );

  // ================= C. 收藏聊天附件 =================
  ORIG_LOG('\nC. POST /sticker-repo/collect 收藏聊天图片');

  // 用一张仓库里没有的图（PNG + 特征字节），避免与 A 组入库图撞 sha256
  const COLLECT_BUF = Buffer.concat([PNG_BUF, Buffer.from('collect', 'utf8')]);
  const up = await req('/uploads/image', {
    method: 'POST',
    body: {
      image: dataUrl(COLLECT_BUF, 'image/png'),
      kind: 'image',
      name: '聊天图.png',
    },
  });
  check('准备工作：上传聊天图片', up.status === 200 && !!up.json.id);

  const collect = await req('/sticker-repo/collect', {
    method: 'POST',
    body: { attachmentId: up.json.id, note: '从聊天收藏', tags: ['聊天'] },
  });
  check(
    '收藏聊天图片成功且来源标记为 chat',
    collect.status === 200 &&
      collect.json.existing === false &&
      collect.json.sticker.source === 'chat' &&
      collect.json.sticker.note === '从聊天收藏',
    `status=${collect.status}`
  );

  const collectMissing = await req('/sticker-repo/collect', {
    method: 'POST',
    body: { attachmentId: '00000000-0000-4000-8000-000000000000' },
  });
  check(
    '收藏不存在的附件返回 404',
    collectMissing.status === 404,
    `status=${collectMissing.status}`
  );

  // 原 uploads 附件不动（撤回消息的孤儿清理逻辑不受影响）：文件系统断言
  check(
    '收藏后原聊天图片文件仍在 uploads 目录（原附件不动）',
    findUploadFile(up.json.id) !== null,
    String(findUploadFile(up.json.id))
  );

  // ================= D. 列表与筛选 =================
  ORIG_LOG('\nD. GET /sticker-repo 列表与筛选');

  const listAll = await req('/sticker-repo');
  check(
    '列表返回全部条目（含迁移的 legacy）',
    listAll.status === 200 &&
      listAll.json.total === listAll.json.stickers.length &&
      listAll.json.total >= 5,
    `total=${listAll.json.total}`
  );
  check(
    'legacy 条目已迁移进仓库（source=legacy）',
    listAll.json.stickers.some(
      s => s.id === LEGACY_ID && s.source === 'legacy' && s.name === '旧表情.png'
    ),
    JSON.stringify(listAll.json.stickers.map(s => s.id))
  );

  const listQ = await req('/sticker-repo?q=' + encodeURIComponent('猫猫'));
  check(
    'q 关键词命中名称',
    listQ.json.stickers.length === 1 &&
      listQ.json.stickers[0].id === addPng.json.sticker.id,
    JSON.stringify(listQ.json.stickers.map(s => s.name))
  );

  // 元数据读取（不含内部路径）
  const meta = await req(`/sticker-repo/${addPng.json.sticker.id}`);
  check(
    'GET /sticker-repo/:id 返回元数据且无 file 字段',
    meta.status === 200 &&
      meta.json.sticker.id === addPng.json.sticker.id &&
      meta.json.sticker.file === undefined,
    `status=${meta.status}`
  );

  // 图片读取（legacy 迁移条目的文件在 uploads 月目录里）
  const legacyImage = await req(`/sticker-repo/${LEGACY_ID}/image`);
  check(
    'GET /sticker-repo/:id/image 读取成功（bytes/类型/缓存头）',
    legacyImage.status === 200 &&
      legacyImage.buf.equals(PNG_BUF) &&
      legacyImage.contentType.includes('image/png') &&
      legacyImage.headers.get('cache-control').includes('immutable'),
    `status=${legacyImage.status}`
  );

  const imageNoAuth = await req(`/sticker-repo/${LEGACY_ID}/image`, { token: null });
  check(
    '无 token 读图返回 401',
    imageNoAuth.status === 401,
    `status=${imageNoAuth.status}`
  );

  // ================= E. PATCH =================
  ORIG_LOG('\nE. PATCH /sticker-repo/:id');

  const patch = await req(`/sticker-repo/${addGif.json.sticker.id}`, {
    method: 'PATCH',
    body: { note: '改过的备注', tags: ['新标签'] },
  });
  check(
    'PATCH 备注与标签成功',
    patch.status === 200 &&
      patch.json.sticker.note === '改过的备注' &&
      patch.json.sticker.tags.join(',') === '新标签',
    JSON.stringify(patch.json)
  );

  // ================= F. 物理删除与 410 =================
  ORIG_LOG('\nF. DELETE /sticker-repo/:id 物理删除');

  const toDelete = addJpeg.json.sticker.id;
  const del = await req(`/sticker-repo/${toDelete}`, { method: 'DELETE' });
  check('删除成功', del.status === 200 && del.json.ok === true, `status=${del.status}`);
  check('删除后图片文件消失', !fs.existsSync(stickerFilePath(toDelete, 'jpg')));
  check(
    '删除后索引不再包含该条目',
    JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).stickers.every(
      s => s.id !== toDelete
    )
  );
  check(
    '删除后元数据接口返回 404',
    (await req(`/sticker-repo/${toDelete}`)).status === 404
  );
  const imageAfterDelete = await req(`/sticker-repo/${toDelete}/image`);
  check(
    '删除后图片接口返回 410 sticker_deleted（占位语义）',
    imageAfterDelete.status === 410 &&
      imageAfterDelete.json.error === 'sticker_deleted',
    `status=${imageAfterDelete.status}`
  );

  // ================= G. /chat 发送表情包 =================
  ORIG_LOG('\nG. POST /chat stickerIds 发送');

  const created = await req('/sessions', { method: 'POST', body: { title: '表情包' } });
  const sessionId = created.json.session.id;
  check('创建测试会话', !!sessionId);

  const chatSticker = await req('/chat', {
    method: 'POST',
    body: { message: '看这个表情', sessionId, stickerIds: [addPng.json.sticker.id] },
  });
  check(
    'stickerIds 发送成功',
    chatSticker.status === 200 &&
      chatSticker.json.userAttachments[0].kind === 'sticker' &&
      chatSticker.json.userAttachments[0].id === addPng.json.sticker.id,
    `status=${chatSticker.status}`
  );

  const chatBadSticker = await req('/chat', {
    method: 'POST',
    body: {
      message: '坏 ID',
      sessionId,
      stickerIds: ['00000000-0000-4000-8000-000000000000'],
    },
  });
  check(
    '无效 stickerId 返回 400',
    chatBadSticker.status === 400 && /表情包不存在/.test(chatBadSticker.json.error || ''),
    `status=${chatBadSticker.status}`
  );

  const chatTooMany = await req('/chat', {
    method: 'POST',
    body: {
      message: '超量',
      sessionId,
      stickerIds: [
        addPng.json.sticker.id,
        addGif.json.sticker.id,
        addWebp.json.sticker.id,
        collect.json.sticker.id,
        LEGACY_ID,
      ],
    },
  });
  check(
    'stickerIds 超过单条上限返回 400',
    chatTooMany.status === 400,
    `status=${chatTooMany.status}`
  );

  // ================= H. 历史接口 expired 标注 =================
  ORIG_LOG('\nH. GET /history 表情包失效标注');

  const history1 = await req(`/history?sessionId=${sessionId}`);
  const stickerMsg = history1.json.history.find(
    m =>
      m.role === 'user' &&
      Array.isArray(m.attachments) &&
      m.attachments.some(a => a.kind === 'sticker')
  );
  check(
    '表情包消息落盘含 sticker 附件',
    !!stickerMsg,
    JSON.stringify(history1.json.history.map(m => m.role))
  );
  check(
    '未删除的表情包附件 expired 为 false',
    stickerMsg.attachments[0].expired === false,
    JSON.stringify(stickerMsg.attachments)
  );

  // 物理删除后：历史消息仍在，但附件标注 expired
  await req(`/sticker-repo/${addPng.json.sticker.id}`, { method: 'DELETE' });

  const history2 = await req(`/history?sessionId=${sessionId}`);
  const expiredMsg = history2.json.history.find(
    m =>
      m.role === 'user' &&
      Array.isArray(m.attachments) &&
      m.attachments.some(a => a.id === addPng.json.sticker.id)
  );
  check(
    '删除后历史消息仍然保留（聊天记录不破坏）',
    !!expiredMsg && expiredMsg.content === '看这个表情',
    JSON.stringify(expiredMsg && expiredMsg.content)
  );
  check(
    '删除后附件标注 expired:true（前端占位信号）',
    expiredMsg.attachments[0].expired === true,
    JSON.stringify(expiredMsg.attachments)
  );

  // ================= I. AI 收发 =================
  ORIG_LOG('\nI. AI 主动发送表情包（候选列表 / ID 校验）');

  // 纯文本会话（无图历史）：验证候选列表注入不改变模型选择，
  // 同时用 17 张批量图把仓库撑到 21 条，验证 20 条上限（一次请求验两件事）
  const plainSession = await req('/sessions', {
    method: 'POST',
    body: { title: '纯文本' },
  });

  for (let i = 0; i < 17; i++) {
    const variant = Buffer.concat([PNG_BUF, Buffer.from([i])]);
    await req('/sticker-repo', {
      method: 'POST',
      body: { image: dataUrl(variant, 'image/png'), name: `批量${i}.png` },
    });
  }

  modelCalls.length = 0;
  stubReply = '[calm] 好的。';
  await req('/chat', {
    method: 'POST',
    body: { message: '你好', sessionId: plainSession.json.session.id },
  });
  const plainSystem = modelCalls[modelCalls.length - 1].messages[0].content;
  check(
    '仓库非空时纯文本请求也注入候选列表',
    /\[sticker:ID\]/.test(plainSystem) && /【可发送的表情包】/.test(plainSystem),
    plainSystem.slice(0, 120)
  );
  check(
    '纯文本请求仍走 deepseek-chat（注入不改变模型选择）',
    modelCalls[modelCalls.length - 1].model === 'deepseek-chat',
    modelCalls[modelCalls.length - 1].model
  );
  const candidateBlock = plainSystem.slice(
    plainSystem.indexOf('【可发送的表情包】')
  );
  check(
    '候选列表受 20 条上限约束（仓库 21 条）',
    candidateBlock.split('\n').length - 1 === 20,
    `lines=${candidateBlock.split('\n').length - 1}`
  );

  // AI 回复引用仓库 ID → 解析为附件、正文剥离
  const gifId = addGif.json.sticker.id;
  stubReply = `[calm] 送你一个 [sticker:${gifId}] 收好`;
  const chatAiSticker = await req('/chat', {
    method: 'POST',
    body: { message: '来个表情', sessionId },
  });
  check(
    'AI 回复中的 [sticker:仓库ID] 解析为附件',
    chatAiSticker.status === 200 &&
      chatAiSticker.json.assistantAttachments &&
      chatAiSticker.json.assistantAttachments[0].kind === 'sticker' &&
      chatAiSticker.json.assistantAttachments[0].id === gifId,
    JSON.stringify(chatAiSticker.json.assistantAttachments)
  );
  check(
    'AI 回复正文已剥离标记（无残留括号）',
    chatAiSticker.json.reply === '送你一个 收好',
    JSON.stringify(chatAiSticker.json.reply)
  );

  // 编造 ID → 忽略，正文不留残留
  stubReply =
    '[calm] 看这个 [sticker:99999999-9999-4999-8999-999999999999] 不存在';
  const chatFake = await req('/chat', {
    method: 'POST',
    body: { message: '再试试', sessionId },
  });
  check(
    '编造的仓库 ID 被忽略且正文无残留',
    chatFake.json.reply === '看这个 不存在' &&
      (!chatFake.json.assistantAttachments ||
        chatFake.json.assistantAttachments.length === 0),
    JSON.stringify(chatFake.json.reply)
  );

  // 关键词兜底（旧语法兼容）
  stubReply = '[calm] 接着 [sticker:旧表情.png] 来了';
  const chatKeyword = await req('/chat', {
    method: 'POST',
    body: { message: '关键词呢', sessionId },
  });
  check(
    '关键词兜底命中 legacy 条目',
    chatKeyword.json.assistantAttachments &&
      chatKeyword.json.assistantAttachments[0].id === LEGACY_ID,
    JSON.stringify(chatKeyword.json.assistantAttachments)
  );

  // 每条回复最多一个表情包
  stubReply = `[calm] 一发 [sticker:${gifId}] 二发 [sticker:${gifId}]`;
  const chatTwo = await req('/chat', {
    method: 'POST',
    body: { message: '两个行吗', sessionId },
  });
  check(
    '每条回复最多解析一个表情包',
    chatTwo.json.assistantAttachments.length === 1,
    JSON.stringify(chatTwo.json.assistantAttachments)
  );

  // ================= J. 语义描述 =================
  ORIG_LOG('\nJ. 语义描述（手动触发 / 失败记录 / 默认不自动）');

  // J0 默认不自动：上传时未产生语义分析调用
  const semanticCallsBefore = modelCalls.filter(
    c =>
      typeof c.messages[0].content === 'string' &&
      c.messages[0].content.includes('语义分析器')
  ).length;
  check(
    '默认关闭：上传不触发语义 API 调用',
    semanticCallsBefore === 0,
    `calls=${semanticCallsBefore}`
  );

  // J1 手动触发成功
  const semOk = await req(`/sticker-repo/${gifId}/semantic`, { method: 'POST' });
  check(
    '手动触发生成成功（status=done + mood）',
    semOk.status === 200 &&
      semOk.json.semantic.status === 'done' &&
      semOk.json.semantic.mood === '开心',
    JSON.stringify(semOk.json.semantic)
  );

  // J2 失败记录 + 可重试
  semanticMode = 'fail';
  const semFail = await req(`/sticker-repo/${gifId}/semantic`, { method: 'POST' });
  check(
    'API 失败时记录 status=failed 与错误原因',
    semFail.status === 200 &&
      semFail.json.semantic.status === 'failed' &&
      /stub semantic failure/.test(semFail.json.semantic.error || ''),
    JSON.stringify(semFail.json.semantic)
  );

  semanticMode = 'ok';
  const semRetry = await req(`/sticker-repo/${gifId}/semantic`, { method: 'POST' });
  check(
    '失败后可重试成功',
    semRetry.json.semantic.status === 'done' && semRetry.json.semantic.mood === '开心',
    JSON.stringify(semRetry.json.semantic)
  );

  // 语义 mood 生成后可按 mood 筛选（语义 → 筛选贯通）
  const listMoodAfter = await req('/sticker-repo?mood=' + encodeURIComponent('开心'));
  check(
    '语义 mood 生成后 mood 筛选命中',
    listMoodAfter.json.stickers.some(s => s.id === gifId),
    JSON.stringify(listMoodAfter.json.stickers.map(s => s.id))
  );

  // ================= K. 重启保留 =================
  ORIG_LOG('\nK. 重启保留与 legacy 不复活');

  // 通过模块重载模拟进程重启：内存缓存清空，数据从磁盘读回
  const stickerRepoTarget = require.resolve(path.join(SERVER, 'sticker-repo.js'));
  const fresh = (() => {
    delete require.cache[stickerRepoTarget];
    return require(stickerRepoTarget);
  })();

  check(
    '重启后条目从磁盘索引读回（元数据/文件俱在）',
    !!fresh.getSticker(gifId) &&
      fresh.getSticker(gifId).semantic.status === 'done' &&
      fresh.readStickerImage(gifId).equals(GIF_BUF)
  );
  check(
    '重启后 legacy 条目不重复迁移（仍只有一条）',
    fresh.listStickers().filter(s => s.source === 'legacy').length === 1,
    JSON.stringify(fresh.listStickers().filter(s => s.source === 'legacy'))
  );

  // 删光仓库后重启：legacy 不得复活
  await req(`/sticker-repo/${gifId}`, { method: 'DELETE' });
  const afterDelete = (() => {
    delete require.cache[stickerRepoTarget];
    return require(stickerRepoTarget);
  })();
  check(
    '删除后重启不复活（getSticker 为 null）',
    afterDelete.getSticker(gifId) === null
  );

  // 守卫负向验证：索引被篡改成仓库外路径时，物理删除不得越界。
  // 篡改值 'decoy.json' 相对数据目录解析后仍落在 DATA_DIR 内（但不在
  // sticker-repo/files/ 下）——这正是新旧守卫的分水岭：只校验"在数据
  // 目录内"的旧实现会误删它，校验"必须在 files 目录且 basename 以条目
  // ID 开头"的新实现不会。若路径收紧被删掉，下面断言必须失败。
  const victim = path.join(DATA_DIR, 'decoy.json');
  fs.writeFileSync(victim, 'do-not-delete');
  const TAMPERED_ID = '22222222-3333-4444-8555-666666666666';
  const tamperedIndex = {
    version: 1,
    stickers: [
      ...JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).stickers,
      { id: TAMPERED_ID, file: 'decoy.json', name: '恶意条目' },
    ],
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(tamperedIndex));
  const guarded = (() => {
    delete require.cache[stickerRepoTarget];
    return require(stickerRepoTarget);
  })();

  const removed = guarded.deleteSticker(TAMPERED_ID);
  check(
    '路径越界守卫：删除不碰仓库外文件（victim 仍在）',
    removed === true && fs.existsSync(victim),
    `removed=${removed} victimExists=${fs.existsSync(victim)}`
  );
  check(
    '路径越界守卫：恶意条目仍被移出索引（删不掉文件不影响记录清理）',
    guarded.getSticker(TAMPERED_ID) === null
  );
  fs.unlinkSync(victim);

  // ---- 汇总 ----
  ORIG_LOG(
    `\n结果：${passed} 通过，${failed} 失败` +
      (failures.length ? `\n失败项：\n  - ${failures.join('\n  - ')}` : '')
  );

  const unexpected = errorLines.filter(line => !/History persist FAILED/.test(line));
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
