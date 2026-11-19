'use strict';

// 多模态：图片上传 / 读取 / 删除、表情包仓库 CRUD
// （健康度审计 R3b：自 index.js 迁出的路由族，工厂注入共享依赖，
//  调用点零行为变化——路径全为精确匹配，挂载顺序不敏感。）
const express = require('express');
const {
  UploadError,
  saveImage,
  getImageMeta,
  readImageBuffer,
  listStickers,
  deleteImage,
} = require('../uploads');
const {
  StickerRepoError,
  SEMANTIC_AUTO: STICKER_SEMANTIC_AUTO,
  addSticker,
  getSticker,
  listStickers: listStickerRepo,
  updateSticker,
  deleteSticker,
  countStickers,
  readStickerImage,
  generateStickerSemantic,
} = require('../sticker-repo');
const { getMemoryClient } = require('../model-adapter');
const { getAllMessages } = require('../sessions');

function createUploadsRouter(deps) {
  const {
    requireAuth,
    auditAction,
  } = deps;

  const router = express.Router();

router.post('/uploads/image', requireAuth, (req, res) => {
    try {
      const { image, kind = 'image', name } = req.body || {};
      const meta = saveImage({ dataUrl: image, kind, name });

      res.json({ ok: true, ...meta });
    } catch (error) {
      if (error instanceof UploadError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('Upload error:', error);
      res.status(500).json({ error: '图片上传失败' });
    }
});

// 图片读取：与所有接口一样走 requireAuth，API 密钥只存在于服务端。
// 文件名由服务端按魔数推导，URL 里只有 UUID，不存在路径遍历面。
router.get('/uploads/image/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const buf = readImageBuffer(id);

  if (!buf) {
    return res.status(404).json({ error: '图片不存在' });
  }

  const meta = getImageMeta(id);
  res.setHeader('Content-Type', meta ? meta.mime : 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  // 内容不可变（UUID 命名），允许前端长期缓存
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(buf);
});

// 手动删除图片：仍被聊天记录引用的拒绝删除（409），防前端误删导致历史破图。
router.delete('/uploads/image/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');

  const referenced = getAllMessages().some(
    message =>
      Array.isArray(message.attachments) &&
      message.attachments.some(item => item && item.id === id)
  );

  if (referenced) {
    return res.status(409).json({ error: '图片仍被聊天记录引用，无法删除' });
  }

  if (!deleteImage(id)) {
    return res.status(404).json({ error: '图片不存在' });
  }

  auditAction(req, 'attachment.delete', { target: 'attachment' });
  res.json({ ok: true, id });
});

// 表情包库列表：供前端选择器使用；q 为可选关键词（匹配名称）。
router.get('/stickers', requireAuth, (req, res) => {
  try {
    res.json({
      stickers: listStickers({ q: req.query.q, limit: req.query.limit }),
    });
  } catch (error) {
    console.error('Stickers error:', error);
    res.status(500).json({ error: '读取表情包库失败' });
  }
});

// ================= 表情包仓库（用户与 AI 共享） =================
// 独立资源：上传/收藏/查询/物理删除。发送走 POST /chat 的 stickerIds 字段，
// AI 主动发送走回复里的 [sticker:仓库ID]（后端校验 ID 必须真实存在）。

// 添加表情包（上传 dataURL，或由 collect 内部以 Buffer 形式复用本函数逻辑）
router.post('/sticker-repo', requireAuth, (req, res) => {
  try {
    const { image, name, note, tags } = req.body || {};
    const { existing, sticker } = addSticker({
      dataUrl: image,
      name,
      note,
      tags,
      source: 'upload',
    });

    // 自动语义生成默认关闭（STICKER_SEMANTIC_AUTO=1 才启用）：
    // 避免未经确认的视觉 API 费用。开启时异步生成，不阻塞响应。
    // 视觉任务固定走内置 DeepSeek 客户端（与改造前一致）。
    if (!existing && STICKER_SEMANTIC_AUTO) {
      const semanticClient = getMemoryClient();
      if (semanticClient) {
        setImmediate(() => {
          generateStickerSemantic(semanticClient, sticker.id).catch(error => {
            console.error('Sticker semantic error:', sticker.id, error.message);
          });
        });
      }
    }

    res.json({ ok: true, existing, sticker });
  } catch (error) {
    if (error instanceof StickerRepoError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Sticker repo add error:', error);
    res.status(500).json({ error: '表情包添加失败' });
  }
});

// 收藏聊天中收到的图片：从 uploads 临时附件复制进仓库（原附件不动，
// 撤回消息时的孤儿清理逻辑不受影响）。
router.post('/sticker-repo/collect', requireAuth, (req, res) => {
  try {
    const { attachmentId, note, tags } = req.body || {};
    const id = String(attachmentId || '');

    const buf = readImageBuffer(id);
    if (!buf) {
      return res.status(404).json({ error: '聊天图片不存在或已失效' });
    }

    const meta = getImageMeta(id);
    const { existing, sticker } = addSticker({
      dataUrl: `data:${meta.mime};base64,${buf.toString('base64')}`,
      name: meta.name,
      note,
      tags,
      source: 'chat',
    });

    if (!existing && STICKER_SEMANTIC_AUTO) {
      const semanticClient = getMemoryClient();
      if (semanticClient) {
        setImmediate(() => {
          generateStickerSemantic(semanticClient, sticker.id).catch(error => {
            console.error('Sticker semantic error:', sticker.id, error.message);
          });
        });
      }
    }

    res.json({ ok: true, existing, sticker });
  } catch (error) {
    if (error instanceof StickerRepoError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Sticker collect error:', error);
    res.status(500).json({ error: '收藏失败' });
  }
});

// 列表查询：q 全文（名称/备注/标签/语义），mood/tag 精确筛选
router.get('/sticker-repo', requireAuth, (req, res) => {
  try {
    res.json({
      stickers: listStickerRepo({
        q: req.query.q,
        mood: req.query.mood,
        tag: req.query.tag,
        limit: req.query.limit,
      }),
      total: countStickers(),
    });
  } catch (error) {
    console.error('Sticker repo list error:', error);
    res.status(500).json({ error: '读取表情包仓库失败' });
  }
});

// 元数据
router.get('/sticker-repo/:id', requireAuth, (req, res) => {
  const entry = getSticker(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: '表情包不存在' });
  }
  const { file, ...rest } = entry;
  res.json({ sticker: rest });
});

// 图片读取。物理删除后记录与文件俱失，统一 410：前端据此显示占位，
// 不把"已删除"和"不存在"混为一谈（404）——对聊天历史来说都是失效。
router.get('/sticker-repo/:id/image', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const entry = getSticker(id);

  if (!entry) {
    return res.status(410).json({ error: 'sticker_deleted' });
  }

  const buf = readStickerImage(id);
  if (!buf) {
    return res.status(410).json({ error: 'sticker_deleted' });
  }

  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(buf);
});

// 修改备注 / 标签
router.patch('/sticker-repo/:id', requireAuth, (req, res) => {
  try {
    const updated = updateSticker(req.params.id, {
      note: req.body && req.body.note,
      tags: req.body && req.body.tags,
    });
    if (!updated) {
      return res.status(404).json({ error: '表情包不存在' });
    }
    res.json({ ok: true, sticker: updated });
  } catch (error) {
    console.error('Sticker repo update error:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 物理删除：文件 + 索引记录一并移除。聊天历史里的消息快照不动，
// 历史引用此 ID 时图片接口返回 410，前端显示占位。
router.delete('/sticker-repo/:id', requireAuth, (req, res) => {
  try {
    if (!deleteSticker(req.params.id)) {
      return res.status(404).json({ error: '表情包不存在' });
    }
    auditAction(req, 'sticker.delete', { target: 'sticker' });
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    console.error('Sticker repo delete error:', error);
    res.status(500).json({ error: '删除失败' });
  }
});

// 语义描述手动生成（默认不自动：见 POST /sticker-repo）。
// 每次调用消耗 1 次视觉 API（图片 ≤1024 token + 少量文本）。
// 结果与失败原因都写入索引，可重复调用重试。
router.post('/sticker-repo/:id/semantic', requireAuth, async (req, res) => {
  try {
    if (!getSticker(req.params.id)) {
      return res.status(404).json({ error: '表情包不存在' });
    }
    // 语义描述走内置 DeepSeek 视觉能力（与改造前一致：辅助任务固定内置）
    const semanticClient = getMemoryClient();
    if (!semanticClient) {
      return res.status(500).json({
        error: '服务端未配置 DEEPSEEK_API_KEY，无法生成语义描述',
      });
    }

    const semantic = await generateStickerSemantic(semanticClient, req.params.id);
    res.json({ ok: true, id: req.params.id, semantic });
  } catch (error) {
    console.error('Sticker semantic error:', error);
    res.status(500).json({ error: '语义描述生成失败' });
  }
});

// ============ 多服务商 / 多模型管理 ============
// 配置持久化与密钥存储在 api-configs.js；SSRF 防护 / 连接测试 / 错误归一化
// 在 model-adapter.js。所有路由沿用 requireAuth；响应一律脱敏——
// 只返回 keyConfigured + keyHint，绝不下发完整 API Key。

// 服务商与模型配置列表（含内置 DeepSeek、当前默认值）

  return router;
}

module.exports = { createUploadsRouter };
