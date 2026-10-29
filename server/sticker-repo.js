'use strict';

/* global __dirname */

/**
 * 云岫 Bluebird — 表情包仓库（用户与 AI 共享）
 *
 * 设计原则：
 * - 自包含：不 import uploads.js / atomic-write.js，自带校验与落盘原语，
 *   避免与多模态模块（可能由其他 agent 平行开发）产生耦合与覆盖风险；
 * - 物理删除：删除即删文件 + 移出索引，无软删/回收站/恢复；
 *   聊天历史不依赖本仓库存活——消息里存的是元数据快照，
 *   仓库条目没了，历史消息仍在，图片接口返回 410 让前端显示占位；
 * - 语义描述默认关闭（STICKER_SEMANTIC_AUTO=1 才入库时自动生成），
 *   避免未经确认的 API 费用；可手动触发生成并记录状态与失败原因；
 * - 候选列表 V1：按当前情绪打分排序 + 数量上限，预留 scene/语义检索参数。
 *
 * 存储布局（均在数据目录下，BLUEBIRD_DATA_DIR 可覆盖，测试隔离同其他模块）：
 *   <DATA_DIR>/sticker-repo/files/<uuid>.<ext>   图片文件
 *   <DATA_DIR>/sticker-repo/sticker-repo.json   索引
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const monitoring = require('./monitoring');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const REPO_DIR = path.join(DATA_DIR, 'sticker-repo');
const FILES_DIR = path.join(REPO_DIR, 'files');
const INDEX_FILE = path.join(REPO_DIR, 'sticker-repo.json');
// 旧雏形索引（多模态初版 uploads.js 写入的存在式表情包列表）：启动时合并迁入
const LEGACY_STICKERS_FILE = path.join(DATA_DIR, 'stickers.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const REPO_VERSION = 1;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 候选列表硬上限：控制注入 prompt 的上下文开销（每行压缩到 80 字以内）
const MAX_CANDIDATES = 20;
// 语义描述自动生成开关：默认关，避免未经确认的视觉 API 费用
const SEMANTIC_AUTO = process.env.STICKER_SEMANTIC_AUTO === '1';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 魔数 → { mime, ext }。以文件内容为准，客户端声明的 MIME 仅作初筛。
const MAGIC_TABLE = [
  {
    mime: 'image/png',
    ext: 'png',
    test: buf =>
      buf.length > 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    test: buf => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    test: buf =>
      buf.length > 5 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: buf =>
      buf.length > 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50,
  },
];

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;

// 路由层统一转 4xx 用
class StickerRepoError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StickerRepoError';
    this.status = status;
  }
}

/** Buffer 版持久化写：tmp 带 pid → fsync → 原子 rename → 目录 fsync（best-effort） */
function writeBufferDurable(filePath, buf) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tmpFile = `${filePath}.tmp.${process.pid}`;
  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpFile, filePath);

  for (const flag of ['r+', 'r']) {
    let dirFd;
    try {
      dirFd = fs.openSync(path.dirname(filePath), flag);
    } catch (_) {
      continue;
    }
    try {
      fs.fsyncSync(dirFd);
    } catch (_) {
      /* 文件系统不支持目录 fsync：文件内容已钉死，可接受 */
    } finally {
      fs.closeSync(dirFd);
    }
    break;
  }
}

function emptyRepo() {
  return { version: REPO_VERSION, stickers: [] };
}

// 索引内存缓存：所有写操作经 saveRepo 落盘，保证缓存与文件一致
let repo = null;

function loadRepo() {
  if (repo) return repo;

  // 迁移只认「仓库索引文件不存在」：索引存在但为空（用户删光了）时绝不复活旧条目
  const indexExists = fs.existsSync(INDEX_FILE);

  repo = emptyRepo();

  if (indexExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.stickers)) {
        repo.stickers = parsed.stickers.filter(
          s => s && typeof s.id === 'string' && UUID_RE.test(s.id)
        );
      } else {
        repo = emptyRepo();
      }
    } catch (_) {
      /* 损坏：按空仓库处理，不覆盖任何东西 */
    }
  }

  // 旧雏形索引迁移（一次性）：只发生在仓库索引从未创建时，绝不覆盖/复活已有仓库
  if (!indexExists && fs.existsSync(LEGACY_STICKERS_FILE)) {
    migrateLegacyStickers();
  }

  return repo;
}

function saveRepo() {
  writeBufferDurable(INDEX_FILE, Buffer.from(JSON.stringify(repo, null, 2), 'utf8'));
}

// 旧 stickers.json（uploads.js 初版）→ 仓库索引。旧文件留在 uploads/ 不删，
// 条目的 file 记录其相对数据目录的路径；找不到文件的条目也迁（元数据不丢）。
function migrateLegacyStickers() {
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_STICKERS_FILE, 'utf8'));
  } catch (_) {
    return;
  }
  if (!legacy || !Array.isArray(legacy.stickers)) return;

  for (const old of legacy.stickers) {
    if (!old || typeof old.id !== 'string' || !UUID_RE.test(old.id)) continue;

    // 在 uploads 月目录里找 <id>.<ext>
    let rel = null;
    try {
      for (const month of fs.readdirSync(UPLOADS_DIR)) {
        const dir = path.join(UPLOADS_DIR, month);
        let entries = [];
        try {
          entries = fs.readdirSync(dir);
        } catch (_) {
          continue;
        }
        const hit = entries.find(name => name.startsWith(`${old.id}.`));
        if (hit) {
          rel = path.join('uploads', month, hit);
          break;
        }
      }
    } catch (_) {
      /* uploads 目录不存在 */
    }

    repo.stickers.push({
      id: old.id,
      file: rel,
      name: typeof old.name === 'string' ? old.name : `${old.id}`,
      mime: typeof old.mime === 'string' ? old.mime : 'image/png',
      size: typeof old.size === 'number' ? old.size : 0,
      sha256: null, // 旧索引没有哈希，不参与去重
      source: 'legacy',
      note: '',
      tags: [],
      semantic: { status: 'pending' },
      addedAt: typeof old.createdAt === 'string' ? old.createdAt : new Date().toISOString(),
      addedBy: 'user',
    });
  }

  saveRepo();
}

function detectMagic(buf) {
  return MAGIC_TABLE.find(entry => entry.test(buf)) || null;
}

/** 把 dataURL 解码为 Buffer 并做全套校验（类型/内容/大小） */
function decodeAndValidate(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new StickerRepoError(400, '缺少图片数据');
  }

  const matched = DATA_URL_RE.exec(dataUrl.trim());
  if (!matched) {
    throw new StickerRepoError(
      400,
      '图片格式不支持：仅接受 JPEG / PNG / GIF / WebP 的 base64 dataURL'
    );
  }

  let buf;
  try {
    buf = Buffer.from(matched[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    throw new StickerRepoError(400, '图片 base64 解码失败');
  }

  if (!buf.length) throw new StickerRepoError(400, '图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new StickerRepoError(
      413,
      `图片超过大小上限（${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`
    );
  }

  const magic = detectMagic(buf);
  if (!magic) {
    throw new StickerRepoError(400, '文件内容不是受支持的图片格式');
  }

  return { buf, mime: magic.mime, ext: magic.ext };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags.slice(0, 10)) {
    const v = typeof t === 'string' ? t.trim().slice(0, 20) : '';
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function normalizeNote(note) {
  return typeof note === 'string' ? note.trim().slice(0, 200) : '';
}

function normalizeName(name, fallback) {
  if (typeof name === 'string' && name.trim()) {
    return path.basename(name.trim()).slice(0, 100);
  }
  return fallback;
}

/**
 * 入库（上传 / 收藏共用）。重复图片（sha256 命中未删条目）不落新文件，
 * 直接返回已有条目，existing: true。
 */
function addStickerFromBuffer({ buf, name, note, tags, source = 'upload' }) {
  const magic = detectMagic(buf);
  if (!magic) {
    throw new StickerRepoError(400, '文件内容不是受支持的图片格式');
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new StickerRepoError(413, '图片超过大小上限');
  }

  const current = loadRepo();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  const dup = current.stickers.find(s => s.sha256 && s.sha256 === sha256);
  if (dup) {
    return { existing: true, sticker: publicEntry(dup) };
  }

  const id = crypto.randomUUID();
  const fileName = `${id}.${magic.ext}`;
  writeBufferDurable(path.join(FILES_DIR, fileName), buf);

  const entry = {
    id,
    file: path.join('sticker-repo', 'files', fileName),
    name: normalizeName(name, fileName),
    mime: magic.mime,
    size: buf.length,
    sha256,
    source,
    note: normalizeNote(note),
    tags: normalizeTags(tags),
    semantic: { status: 'pending' },
    addedAt: new Date().toISOString(),
    addedBy: 'user',
  };

  current.stickers.push(entry);
  saveRepo();

  return { existing: false, sticker: publicEntry(entry) };
}

/** dataURL 上传入口 */
function addSticker({ dataUrl, name, note, tags, source = 'upload' }) {
  const { buf } = decodeAndValidate(dataUrl);
  return addStickerFromBuffer({ buf, name, note, tags, source });
}

// 对外输出不含内部路径字段（file），避免把服务端目录结构暴露给前端
function publicEntry(entry) {
  if (!entry) return null;
  const { file, ...rest } = entry;
  return rest;
}

function getSticker(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!UUID_RE.test(value)) return null;
  return loadRepo().stickers.find(s => s.id === value) || null;
}

function listStickers({ q = '', mood = '', tag = '', limit = 60 } = {}) {
  let list = loadRepo().stickers.slice();

  const keyword = String(q || '').trim();
  if (keyword) {
    list = list.filter(s => matchesKeyword(s, keyword));
  }
  const moodKw = String(mood || '').trim();
  if (moodKw) {
    list = list.filter(
      s => stickerMood(s) === moodKw || (s.tags || []).includes(moodKw)
    );
  }
  const tagKw = String(tag || '').trim();
  if (tagKw) {
    list = list.filter(s => (s.tags || []).some(t => t.includes(tagKw)));
  }

  const max = Math.min(Math.max(Number(limit) || 60, 1), 200);
  // 新添加的在前
  return list
    .slice()
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
    .slice(0, max)
    .map(publicEntry);
}

function stickerMood(entry) {
  return entry.semantic && entry.semantic.status === 'done' && entry.semantic.mood
    ? String(entry.semantic.mood)
    : '';
}

function matchesKeyword(s, keyword) {
  if ((s.name || '').includes(keyword)) return true;
  if ((s.note || '').includes(keyword)) return true;
  if ((s.tags || []).some(t => t.includes(keyword))) return true;
  const sem = s.semantic;
  if (sem && sem.status === 'done') {
    if ((sem.mood || '').includes(keyword)) return true;
    if ((sem.scene || '').includes(keyword)) return true;
    if ((sem.meaning || '').includes(keyword)) return true;
    if ((sem.tags || []).some(t => t.includes(keyword))) return true;
  }
  return false;
}

/**
 * 兼容旧语法的关键词匹配：名称/备注/标签/语义里找第一个包含关键词的。
 * V1 候选列表改为 ID 精确匹配后，这条只服务于模型输出关键词的兜底。
 */
function findStickerByKeyword(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;

  const list = loadRepo().stickers;
  // 名称精确包含优先，再退到语义/标签
  return (
    list.find(s => (s.name || '').includes(kw)) ||
    list.find(s => matchesKeyword(s, kw)) ||
    null
  );
}

function updateSticker(id, { note, tags } = {}) {
  const entry = getSticker(id);
  if (!entry) return null;

  if (note !== undefined) entry.note = normalizeNote(note);
  if (tags !== undefined) entry.tags = normalizeTags(tags);
  saveRepo();

  return publicEntry(entry);
}

/**
 * 物理删除：删文件 + 移出索引。
 * 路径双重校验：条目必须存在，且文件必须正好位于仓库 files 目录下、
 * basename 以该条目 ID 开头——即使索引被外部篡改也删不到仓库外的任何文件。
 */
function deleteSticker(id) {
  const current = loadRepo();
  const entry = current.stickers.find(s => s.id === id);
  if (!entry) return false;

  if (entry.file) {
    const resolved = path.resolve(DATA_DIR, entry.file);
    const basename = path.basename(resolved);

    if (
      path.dirname(resolved) === path.resolve(FILES_DIR) &&
      basename.startsWith(`${entry.id}.`) &&
      fs.existsSync(resolved)
    ) {
      try {
        fs.unlinkSync(resolved);
      } catch (error) {
        console.error('Sticker file delete error:', entry.id, error.message);
        // 文件删不掉（占用/权限）时仍然移出索引：消息快照 + 410 语义不受影响
      }
    }
  }

  current.stickers = current.stickers.filter(s => s.id !== id);
  saveRepo();
  return true;
}

function countStickers() {
  return loadRepo().stickers.length;
}

// 文件解析 + 数据目录内校验（防索引被外部篡改后的路径穿越）
function resolveStickerFile(entry) {
  if (!entry || !entry.file) return null;
  const resolved = path.resolve(DATA_DIR, entry.file);
  if (!resolved.startsWith(DATA_DIR + path.sep)) return null;
  return resolved;
}

function readStickerImage(id) {
  const entry = getSticker(id);
  if (!entry) return null;
  const filePath = resolveStickerFile(entry);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
}

function readStickerDataUrl(id) {
  const buf = readStickerImage(id);
  if (!buf) return null;
  const entry = getSticker(id);
  return `data:${entry.mime};base64,${buf.toString('base64')}`;
}

/**
 * AI 候选列表 V1：按当前情绪打分（语义 mood / 标签 / 名称命中加权），
 * 同分按添加时间倒序；数量受 MAX_CANDIDATES 限制。
 *
 * scene / context 参数为后续语义检索预留，V1 不使用；
 * 后续可在此替换为向量/语义相似度排序，函数签名保持不变。
 */
function buildStickerCandidates({
  emotion = '',
  scene = '',
  limit = MAX_CANDIDATES,
} = {}) {
  const list = loadRepo().stickers;
  const mood = String(emotion || '').trim();
  const sceneKw = String(scene || '').trim();
  const max = Math.min(Math.max(Number(limit) || MAX_CANDIDATES, 1), MAX_CANDIDATES);

  const scored = list.map(entry => {
    let score = 0;
    const sem = entry.semantic && entry.semantic.status === 'done' ? entry.semantic : null;
    const tags = (sem && sem.tags) || entry.tags || [];

    if (mood) {
      if (sem && sem.mood === mood) score += 100;
      if (tags.some(t => t === mood)) score += 60;
      if ((entry.name || '').includes(mood)) score += 20;
      if ((entry.note || '').includes(mood)) score += 10;
    }
    if (sceneKw && sem && (sem.scene || '').includes(sceneKw)) score += 50;

    return { entry, score };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.addedAt < b.entry.addedAt ? 1 : -1)
  );

  return scored.slice(0, max).map(item => item.entry);
}

/**
 * 把候选条目压缩成一行注入 prompt：控制单条长度，仓库大时上下文不爆炸。
 */
function formatCandidateLine(entry) {
  const sem = entry.semantic && entry.semantic.status === 'done' ? entry.semantic : null;
  const parts = [`[${entry.id}]`];

  if (sem && sem.mood) parts.push(`情绪:${String(sem.mood).slice(0, 10)}`);
  // 语义描述是"什么时候该发这张"的核心依据：有就注入，没有就退化为备注/文件名。
  // C-5：每张图尽量配一句使用场景描述，纯文本模型据此即可判断贴不贴切。
  if (sem && sem.scene) parts.push(`场景:${String(sem.scene).slice(0, 12)}`);
  if (sem && sem.meaning) parts.push(`含义:${String(sem.meaning).slice(0, 16)}`);
  const tags = (sem && sem.tags) || entry.tags || [];
  if (tags.length) parts.push(`标签:${tags.slice(0, 3).join(',')}`.slice(0, 40));
  if (entry.note) parts.push(`备注:${entry.note.slice(0, 20)}`);
  else if (entry.name) parts.push(String(entry.name).slice(0, 20));

  // 上限放宽到 120：容纳场景/含义后仍保持每行简短，20 条候选也不会撑爆上下文。
  return parts.join(' ').slice(0, 120);
}

function parseModelJson(text) {
  try {
    const cleaned = String(text || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!cleaned) return null;
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    }
  } catch (_) {
    return null;
  }
}

/**
 * 语义描述生成（手动触发，或 STICKER_SEMANTIC_AUTO=1 时入库后自动）：
 * 调 deepseek-flash 视觉模型分析图片，结果写进索引并记录状态。
 * 失败不删条目：semantic.status='failed' + error 原文，可重试。
 *
 * 费用：每次调用 = 1 次视觉请求（图片 ≤1024 token + 少量文本）。
 */
async function generateStickerSemantic(client, id) {
  const entry = getSticker(id);
  if (!entry) return null;

  if (!client) {
    entry.semantic = {
      status: 'failed',
      error: '服务端未配置 DEEPSEEK_API_KEY',
      generatedAt: new Date().toISOString(),
    };
    saveRepo();
    return entry.semantic;
  }

  const dataUrl = readStickerDataUrl(id);
  if (!dataUrl) {
    entry.semantic = {
      status: 'failed',
      error: '图片文件读取失败',
      generatedAt: new Date().toISOString(),
    };
    saveRepo();
    return entry.semantic;
  }

  entry.semantic = {
    ...entry.semantic,
    status: 'pending',
    generatedAt: new Date().toISOString(),
  };
  saveRepo();

  try {
    console.log(
      `[AI call] sticker-semantic id=${id} at=${new Date().toISOString()}`
    );

    const auxiliary = monitoring.beginAuxiliaryModel({
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      kind: 'sticker_semantic',
    });

    let completion;
    try {
      completion = await client.chat.completions.create(
        {
          model: 'deepseek-flash',
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: `你是一个表情包语义分析器。用户会给你一张表情包图片，请分析它。
返回严格 JSON（不要 markdown 代码块标记），格式：
{
  "mood": "一个中文情绪词，从这些里选最接近的：开心、无语、安慰、调侃、得意、撒娇、难过、生气、平静、震惊",
  "scene": "适用场景，10字以内",
  "meaning": "这张表情包想表达什么，20字以内",
  "tags": ["2-4个中文关键词"]
}
只返回 JSON 对象，不要任何其他文字。`,
          },
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: dataUrl } }],
          },
        ],
      },
        { timeout: 60000 }
      );

      auxiliary.complete({
        status: 'success',
        usage: completion && completion.usage ? completion.usage : null,
      });
    } catch (error) {
      auxiliary.complete({
        status: error && error.kind === 'timeout' ? 'timeout' : 'failed',
        errorCode:
          error && (error.kind || error.code)
            ? error.kind || error.code
            : 'model_error',
      });
      throw error;
    }

    const parsed = parseModelJson(
      completion.choices && completion.choices[0] && completion.choices[0].message
        ? completion.choices[0].message.content
        : ''
    );

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('模型返回内容无法解析为 JSON');
    }

    entry.semantic = {
      status: 'done',
      mood: String(parsed.mood || '').slice(0, 20),
      scene: String(parsed.scene || '').slice(0, 20),
      meaning: String(parsed.meaning || '').slice(0, 50),
      tags: normalizeTags(parsed.tags),
      generatedAt: new Date().toISOString(),
    };
    saveRepo();
    return entry.semantic;
  } catch (error) {
    entry.semantic = {
      status: 'failed',
      error: String(error && error.message ? error.message : error).slice(0, 200),
      generatedAt: new Date().toISOString(),
    };
    saveRepo();
    return entry.semantic;
  }
}

module.exports = {
  StickerRepoError,
  SEMANTIC_AUTO,
  MAX_CANDIDATES,
  addSticker,
  addStickerFromBuffer,
  getSticker,
  listStickers,
  updateSticker,
  deleteSticker,
  countStickers,
  readStickerImage,
  readStickerDataUrl,
  findStickerByKeyword,
  buildStickerCandidates,
  formatCandidateLine,
  generateStickerSemantic,
};
