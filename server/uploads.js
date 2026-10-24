'use strict';

/* global __dirname */

/**
 * 云岫 Bluebird — 多模态图片模块（上传 / 校验 / 存储 / 读取）
 *
 * 职责：
 * - 接收前端 base64 dataURL 图片，校验后落到数据目录；
 * - 表情包（kind=sticker）同时登记进 stickers.json 索引，供 AI 回复引用；
 * - 读取时按内容魔数判定类型，不信任客户端声明的 MIME 与文件名。
 *
 * 安全策略：
 * - 文件名用 UUID，服务端重新推导扩展名（魔数 → ext），杜绝路径遍历；
 * - 类型白名单 + 文件头魔数双重校验，文本改后缀冒充图片直接拒绝；
 * - 大小上限 MAX_IMAGE_BYTES，超限拒绝；
 * - 落盘沿用 atomic-write 的同款策略（tmp 带 pid → fsync → rename），
 *   但本模块写的是二进制：writeFileDurable 固定 utf8 会破坏图片字节，
 *   因此这里用 Buffer 版私有实现，不改动 JSON 模块共用的 atomic-write.js。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 与 memory/emotion/sessions 保持一致的目录解析：测试用 BLUEBIRD_DATA_DIR
// 隔离，未设置时落在 server/data/。
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

const UPLOAD_ROOT = path.join(DATA_DIR, 'uploads');
const STICKERS_FILE = path.join(DATA_DIR, 'stickers.json');
const STICKERS_VERSION = 1;

// 单张图片上限 5MB：base64 后约 6.7MB，/uploads/image 路由的 json limit
// 相应放到 8MB。表情包通常远小于此。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const KIND_IMAGE = 'image';
const KIND_STICKER = 'sticker';
const ALLOWED_KINDS = [KIND_IMAGE, KIND_STICKER];

// 魔数 → { mime, ext }。以文件内容为准，客户端声明仅作初筛。
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

// 路由层统一转 400/413 用
class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

/** dataURL 初筛：只放行白名单 MIME 的 base64 dataURL */
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;

function monthDir(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(UPLOAD_ROOT, `${y}-${m}`);
}

/** Buffer 版持久化写：与 atomic-write.js 同策略，但不强制 utf8 */
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

  // 目录 fsync best-effort：Windows 需 'r+'，POSIX 需 'r'，都不支持就放弃
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
      /* 文件系统不支持目录 fsync，内容本身已钉死，可接受 */
    } finally {
      fs.closeSync(dirFd);
    }
    break;
  }
}

function imageFilePath(id) {
  // id 只允许 UUID 形态：从输入侧就堵死路径遍历，不做"清洗"
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }

  // 按月分目录，同 id 在全库唯一；逐月找，找不到即不存在
  let months = [];
  try {
    months = fs.readdirSync(UPLOAD_ROOT);
  } catch (_) {
    return null; // uploads 根目录不存在：还没有任何上传
  }

  for (const month of months) {
    const dir = path.join(UPLOAD_ROOT, month);
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

function loadStickers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STICKERS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.stickers)) {
      return {
        version: STICKERS_VERSION,
        stickers: parsed.stickers.filter(
          s => s && typeof s.id === 'string' && typeof s.mime === 'string'
        ),
      };
    }
  } catch (_) {
    /* 不存在或损坏：按空索引处理，文件本身仍在，可人工恢复 */
  }
  return { version: STICKERS_VERSION, stickers: [] };
}

function saveStickers(store) {
  writeBufferDurable(
    STICKERS_FILE,
    Buffer.from(JSON.stringify(store, null, 2), 'utf8')
  );
}

/**
 * 保存一张图片。
 *
 * @param {object} input
 * @param {string} input.dataUrl  data:image/...;base64,....
 * @param {string} input.kind     'image' | 'sticker'
 * @param {string} [input.name]   原始文件名（仅作展示备注，不参与存储路径）
 * @returns {{id, kind, mime, size, name, createdAt}}
 */
function saveImage({ dataUrl, kind, name }) {
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new UploadError(400, `不支持的图片类型 kind：${kind}`);
  }

  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new UploadError(400, '缺少图片数据');
  }

  const matched = DATA_URL_RE.exec(dataUrl.trim());
  if (!matched) {
    throw new UploadError(
      400,
      '图片格式不支持：仅接受 JPEG / PNG / GIF / WebP 的 base64 dataURL'
    );
  }

  let buf;
  try {
    buf = Buffer.from(matched[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    throw new UploadError(400, '图片 base64 解码失败');
  }

  if (!buf.length) {
    throw new UploadError(400, '图片内容为空');
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new UploadError(
      413,
      `图片超过大小上限（${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`
    );
  }

  // 以内容为准：声明的 MIME 只用于初筛，真实类型由魔数判定
  const magic = MAGIC_TABLE.find(entry => entry.test(buf));
  if (!magic) {
    throw new UploadError(400, '文件内容不是受支持的图片格式');
  }

  const id = crypto.randomUUID();
  const filePath = path.join(monthDir(), `${id}.${magic.ext}`);
  writeBufferDurable(filePath, buf);

  const displayName =
    typeof name === 'string' && name.trim()
      ? path.basename(name.trim()).slice(0, 100)
      : `${id}.${magic.ext}`;

  const meta = {
    id,
    kind,
    mime: magic.mime,
    size: buf.length,
    name: displayName,
    createdAt: new Date().toISOString(),
  };

  if (kind === KIND_STICKER) {
    const store = loadStickers();
    store.stickers.push(meta);
    // 索引无上限保护：表情包由用户上传，量级小；超上限时淘汰最旧的一半
    if (store.stickers.length > 500) {
      store.stickers = store.stickers.slice(-250);
    }
    saveStickers(store);
  }

  return meta;
}

function getImageMeta(id) {
  const filePath = imageFilePath(id);
  if (!filePath) return null;

  const ext = path.extname(filePath).slice(1);
  const magic = MAGIC_TABLE.find(entry => entry.ext === ext);
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (_) {
    return null;
  }

  // 索引（stickers.json）里有更完整的元数据就复用，补齐 kind/name
  const store = loadStickers();
  const indexed = store.stickers.find(s => s.id === id);

  return {
    id,
    kind: indexed ? KIND_STICKER : KIND_IMAGE,
    mime: magic ? magic.mime : 'application/octet-stream',
    size,
    name: indexed ? indexed.name : path.basename(filePath),
    createdAt: indexed ? indexed.createdAt : undefined,
  };
}

function readImageBuffer(id) {
  const filePath = imageFilePath(id);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
}

/** 供视觉模型使用：读盘并转回 base64 dataURL */
function readImageDataUrl(id) {
  const buf = readImageBuffer(id);
  if (!buf) return null;
  const meta = getImageMeta(id);
  const mime = meta ? meta.mime : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function listStickers({ q = '', limit = 60 } = {}) {
  const keyword = String(q || '').trim();
  let list = loadStickers().stickers;

  if (keyword) {
    list = list.filter(s =>
      (s.name || '').includes(keyword) || s.id.includes(keyword)
    );
  }

  const max = Math.min(Math.max(Number(limit) || 60, 1), 200);
  return list.slice(-max).reverse();
}

/**
 * 删除图片文件与索引记录。调用方负责先确认没有消息再引用它
 * （引用检查在 index.js 的撤回 / 清理流程里做）。
 */
function deleteImage(id) {
  const filePath = imageFilePath(id);
  if (!filePath) return false;

  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    return false;
  }

  const store = loadStickers();
  if (store.stickers.some(s => s.id === id)) {
    store.stickers = store.stickers.filter(s => s.id !== id);
    saveStickers(store);
  }
  return true;
}

module.exports = {
  UploadError,
  MAX_IMAGE_BYTES,
  KIND_IMAGE,
  KIND_STICKER,
  saveImage,
  getImageMeta,
  readImageBuffer,
  readImageDataUrl,
  listStickers,
  deleteImage,
};
