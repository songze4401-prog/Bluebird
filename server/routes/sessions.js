'use strict';

// 会话与历史：/sessions CRUD、/history 读取 / 清理 / 撤回
// （健康度审计 R3b：自 index.js 迁出的路由族，工厂注入共享依赖，
//  调用点零行为变化——路径全为精确匹配，挂载顺序不敏感。）
const express = require('express');
const {
  HISTORY_PAGE_MAX,
  HISTORY_PAGE_DEFAULT,
  getHistoryPage,
  listSessions,
  getSessionForUser,
  checkSessionOwnership,
  createSession,
  getMessages,
  replaceMessages,
  deleteSession,
} = require('../sessions');
const { recallMemoryBySourceQuote, verifyStoreConsistency } = require('../memory');
const { resetSessionWait, forgetSession } = require('../presence');
const { KIND_STICKER } = require('../uploads');
const { getSticker } = require('../sticker-repo');
const retrieval = require('../retrieval');
const { resolveUserId } = require('../user-scope');
const { logDataEvent } = require('../data-events');

function createSessionsRouter(deps) {
  const {
    requireAuth,
    resolveSessionId,
    auditAction,
    storeUnavailable,
    clearGuardError,
    releaseOrphanAttachments,
  } = deps;

  const router = express.Router();

router.get('/sessions', requireAuth, (req, res) => {
  try {
    res.json({ sessions: listSessions(resolveUserId(req)) });
  } catch (error) {
    console.error('Sessions API Error:', error);
    res.status(500).json({ error: '读取会话列表失败' });
  }
});

// 新建会话：创建独立会话，不触碰任何已有会话与旧历史
router.post('/sessions', requireAuth, (req, res) => {
  try {
    const { title } = req.body || {};
    const session = createSession({ title, userId: resolveUserId(req) });

    if (!session) {
      return storeUnavailable(res, '新建会话失败：聊天存储当前不可写');
    }

    res.status(201).json({ session });
  } catch (error) {
    // 会话数量上限：明确拒绝，不伪装成"写入失败"，也不删有对话的会话。
    if (error && error.code === 'session_limit') {
      return res.status(409).json({
        error: '会话数量已达上限，请先删除旧会话',
        code: 'session_limit',
      });
    }
    console.error('Session create error:', error);
    res.status(500).json({ error: '新建会话失败' });
  }
});

// 单个会话元数据
router.get('/sessions/:id', requireAuth, (req, res) => {
  try {
    const session = getSessionForUser(req.params.id, resolveUserId(req));

    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }

    res.json({ session });
  } catch (error) {
    console.error('Session API Error:', error);
    res.status(500).json({ error: '读取会话失败' });
  }
});

// 删除指定会话：元信息与消息一并移除；跨会话共享的长期记忆与全局情绪不受影响。
// default 被删时会立即重建为空会话（sessions.js 的不变量），客户端可安全切回。
router.delete('/sessions/:id', requireAuth, (req, res) => {
  try {
    // 归属校验：不存在与无权都回 404，不泄露会话是否存在。
    const access = checkSessionOwnership(req.params.id, resolveUserId(req));

    if (!access.ok) {
      auditAction(req, 'session.delete', {
        target: 'session',
        result: 'denied',
        sessionId: req.params.id,
        reason: access.reason,
      });
      return res.status(404).json({ error: '会话不存在' });
    }

    // 删除前先保留该会话的附件引用；删除后全局扫描剩余消息，
    // 只回收不再被任何会话引用的文件，跨会话共享的图片不受影响。
    const deletedMessages = getMessages(req.params.id) || [];
    const result = deleteSession(req.params.id);

    if (result === null) {
      return res.status(404).json({ error: '会话不存在' });
    }

    if (result === false) {
      auditAction(req, 'session.delete', {
        target: 'session',
        result: 'failed',
        sessionId: req.params.id,
        reason: 'store_read_only',
      });
      return storeUnavailable(res, '删除失败：聊天存储当前不可写');
    }

    auditAction(req, 'session.delete', {
      target: 'session',
      sessionId: req.params.id,
    });

    // 会话已删除：移除对应的等待状态，避免 presence.json 残留孤儿条目
    try {
      forgetSession(req.params.id);
    } catch (error) {
      console.error('Presence forget error:', error);
    }

    // 附件与派生索引都按删除后的 canonical 数据重新计算；清理失败不把
    // 已成功的会话删除回滚为失败，但必须留日志，便于后续重建/人工清理。
    try {
      releaseOrphanAttachments(deletedMessages.map(message => message && message.attachments));
    } catch (error) {
      console.error('Session attachment cleanup error:', error);
    }
    try {
      const indexCleanup = retrieval.cleanupConversationIndex(req.params.id);
      if (indexCleanup && indexCleanup.ok === false) {
        console.error(
          'Session index cleanup failed:',
          indexCleanup.errorCode || indexCleanup.status
        );
      }
    } catch (error) {
      console.error('Session index cleanup error:', error);
    }

    res.json({ ok: true, sessionId: req.params.id, message: '会话已删除' });
  } catch (error) {
    console.error('Session delete error:', error);
    auditAction(req, 'session.delete', {
      target: 'session',
      result: 'failed',
      sessionId: req.params.id,
      reason: error && error.name ? error.name : 'delete_failed',
    });
    res.status(500).json({ error: '删除会话失败' });
  }
});

// 按会话读取消息：未传 sessionId 时读「默认会话」（兼容旧客户端）
router.get('/history', requireAuth, (req, res) => {
  try {
    const sessionId = resolveSessionId(req, 'query');

    if (!getSessionForUser(sessionId, resolveUserId(req))) {
      return res.status(404).json({ error: '会话不存在' });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || HISTORY_PAGE_DEFAULT, 1),
      HISTORY_PAGE_MAX
    );
    const before =
      typeof req.query.before === 'string' && req.query.before.trim()
        ? req.query.before.trim()
        : null;

    // 表情包附件失效标注：仓库已物理删除时给前端明确的占位信号。
    // page 返回副本，标注不会写回 sessions.json。
    const page = getHistoryPage(sessionId, { limit, before });
    if (!page) {
      return res.status(404).json({ error: '会话不存在' });
    }
    if (page.invalidCursor) {
      return res.status(400).json({ error: 'before 游标不存在' });
    }
    const history = page.items;
    for (const item of history) {
      if (!Array.isArray(item.attachments)) continue;
      for (const att of item.attachments) {
        if (att && att.kind === KIND_STICKER) {
          att.expired = !getSticker(att.id);
        }
      }
    }

    res.json({
      sessionId,
      history,
      // 新增字段是向后兼容的：旧客户端忽略即可；新客户端据此向上翻页。
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    console.error('History API Error:', error);
    res.status(500).json({ error: '读取聊天记录失败' });
  }
});

// 清空指定会话的消息，互不影响其他会话
router.post('/history/clear', requireAuth, (req, res) => {
  const guard = clearGuardError(req);

  if (guard) {
    auditAction(req, 'history.clear', {
      target: 'history',
      result: 'denied',
      sessionId: resolveSessionId(req, 'body'),
      reason: 'confirm_required',
    });
    return res.status(403).json({ error: guard, requireConfirm: true });
  }

  try {
    const sessionId = resolveSessionId(req, 'body');

    if (!getSessionForUser(sessionId, resolveUserId(req))) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 先取旧消息：清理后它们就没了，但附件回收需要知道删过哪些图
    const stale = getMessages(sessionId) || [];

    if (!replaceMessages(sessionId, [])) {
      return storeUnavailable(res, '清理失败：聊天存储当前不可写');
    }

    // 消息已清空：回收本会话图片附件中不再被其他消息引用的文件
    releaseOrphanAttachments(stale.map(item => item && item.attachments));

    // 历史清空后，会话内「Blue 等待回复」的计时也应归零
    try {
      resetSessionWait(sessionId);
    } catch (error) {
      console.error('Presence reset error:', error);
    }

    auditAction(req, 'history.clear', { target: 'history', sessionId });
    res.json({ ok: true, sessionId, message: '聊天记录已清理' });
  } catch (error) {
    console.error('History clear error:', error);
    auditAction(req, 'history.clear', {
      target: 'history',
      result: 'failed',
      sessionId: resolveSessionId(req, 'body'),
      reason: error && error.name ? error.name : 'clear_failed',
    });
    res.status(500).json({ error: '清理聊天记录失败' });
  }
});

router.post('/history/recall', requireAuth, async (req, res) => {
  try {
    const { messageId } = req.body;
    const sessionId = resolveSessionId(req, 'body');

    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ error: '缺少 messageId' });
    }

    if (!getSessionForUser(sessionId, resolveUserId(req))) {
      return res.status(404).json({ error: '会话不存在' });
    }

    // 撤回严格限定在当前会话内，跨会话不可见、不可撤回
    const history = getMessages(sessionId) || [];
    const index = history.findIndex(
      item => item && item.id === messageId && item.role === 'user'
    );

    if (index < 0) {
      return res.status(404).json({
        error: '消息不存在或不可撤回',
      });
    }

    const removed = [history[index]];

    // 配对删除：撤回该用户消息之后、下一条用户消息之前的所有 assistant 回复，
    // 避免留下"用户消息删了、AI 回复还在"的孤儿回复。
    for (let i = index + 1; i < history.length; i++) {
      const m = history[i];
      if (!m || m.role !== 'assistant') break;
      removed.push(m);
    }

    const removedIds = new Set(removed.map(item => item.id));
    const saved = replaceMessages(
      sessionId,
      history.filter(m => m && !removedIds.has(m.id))
    );

    // 落盘失败就不动记忆：消息没删成，记忆也不该删
    if (!saved) {
      return storeUnavailable(res, '撤回失败：聊天存储当前不可写');
    }

    // 回收被删消息的图片附件（确认无其他消息引用后删文件）
    releaseOrphanAttachments(removed.map(item => item.attachments));

    // 撤回可能移除了最后一条 Blue 消息，等待计时一并归零，避免残留
    try {
      resetSessionWait(sessionId);
    } catch (error) {
      console.error('Presence reset error:', error);
    }

    // 撤回由这条用户消息产生的长期记忆（sourceQuote 匹配，只摘本会话的贡献）。
    // 必须 await 并自检落盘：消息删了但记忆没删成时，响应不能写成成功，
    // 否则客户端以为两边都干净，事实仍留在记忆里。
    const removedMessageIds = removed.map(m => m.id);

    let memoryRecall;
    try {
      const counts = await recallMemoryBySourceQuote(
        removed[0].content,
        removed[0].createdAt,
        sessionId,
        removed[0].id
      );

      const consistency = verifyStoreConsistency();

      memoryRecall = { ...counts, ...consistency };
    } catch (error) {
      logDataEvent({
        module: 'memory',
        event: 'memory_recall_failed',
        level: 'error',
        error,
        action: 'recall',
        extra: { sessionId, removedMessageIds },
      });

      // 消息已经删干净了：如实告诉调用方「消息成功、记忆失败」的半完成状态，
      // 让它按 removedIds 收敛本地列表，而不是把这条消息继续显示出来。
      auditAction(req, 'history.recall', {
        target: 'history',
        result: 'partial_success',
        sessionId,
        reason: 'memory_recall_failed',
      });
      return res.status(503).json({
        error: '聊天记录已撤回，但长期记忆撤回失败，请重试或到记忆库手动删除',
        partial: true,
        messagesRecalled: true,
        sessionId,
        removedCount: removed.length,
        removedIds: removedMessageIds,
        memory: { status: 'failed' },
      });
    }

    // 落盘与内存不一致（磁盘写成功但内容对不上）同样不能算成功。
    if (memoryRecall.consistent === false) {
      logDataEvent({
        module: 'memory',
        event: 'memory_recall_inconsistent',
        level: 'error',
        action: 'recall',
        extra: { sessionId, reason: memoryRecall.reason },
      });

      auditAction(req, 'history.recall', {
        target: 'history',
        result: 'partial_success',
        sessionId,
        reason: 'memory_recall_inconsistent',
      });
      return res.status(503).json({
        error: '聊天记录已撤回，但长期记忆的落盘校验未通过，请重试',
        partial: true,
        messagesRecalled: true,
        sessionId,
        removedCount: removed.length,
        removedIds: removedMessageIds,
        memory: memoryRecall,
      });
    }

    auditAction(req, 'history.recall', {
      target: 'history',
      sessionId,
    });
    res.json({
      ok: true,
      sessionId,
      removedCount: removed.length,
        removedIds: removedMessageIds,
      memory: memoryRecall,
    });
  } catch (error) {
    console.error('History recall error:', error);
    res.status(500).json({ error: '撤回失败' });
  }
});


// 图片上传：body 由顶部路径级 parser（8mb）解析，这里直接取用。

  return router;
}

module.exports = { createSessionsRouter };
