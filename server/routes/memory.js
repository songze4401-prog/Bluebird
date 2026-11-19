'use strict';

// 记忆治理：读取 / 待确认 / 确认驳回 / 归档 / 删除 / 按会话清理 / 写入台账 / workspace 确认往返 / 画像与反馈
// （健康度审计 R3b：自 index.js 迁出的路由族，工厂注入共享依赖，
//  调用点零行为变化——路径全为精确匹配，挂载顺序不敏感。）
const express = require('express');
const {
  clearMemories,
  clearSessionMemories,
  confirmPending,
  rejectPending,
  archiveMemory,
  deleteMemory,
  getMemoriesForUser,
  getPendingMemoriesForUser,
  getWriteOutcomes,
  verifyStoreConsistency,
} = require('../memory');
const { buildProfile, applyProfileFeedback } = require('../profile');
const { logDataEvent } = require('../data-events');
const monitoring = require('../monitoring');
const toolWorkspace = require('../tool-workspace');
const workspacePending = require('../workspace-pending');

function createMemoryRouter(deps) {
  const {
    requireAuth,
    resolveUserId,
    auditAction,
    clearGuardError,
  } = deps;

  const router = express.Router();

router.post('/memory/clear', requireAuth, async (req, res) => {
  const guard = clearGuardError(req);

  if (guard) {
    auditAction(req, 'memory.clear', {
      target: 'memory',
      result: 'denied',
      reason: 'confirm_required',
    });
    return res.status(403).json({ error: guard, requireConfirm: true });
  }

  try {
    // 只清空"本人"名下的记忆：多用户下不能借这个接口清掉别人的库。
    const result = await clearMemories(resolveUserId(req));

    const consistency = verifyStoreConsistency();

    if (consistency.consistent === false) {
      logDataEvent({
        module: 'memory',
        event: 'memory_clear_inconsistent',
        level: 'error',
        action: 'clear',
        extra: { reason: consistency.reason },
      });

      auditAction(req, 'memory.clear', {
        target: 'memory',
        result: 'partial_success',
        reason: 'consistency_failed',
      });
      return res.status(503).json({
        error: '记忆已清空，但落盘校验未通过，请重试',
        partial: true,
        reason: consistency.reason,
      });
    }

    res.json({
      ok: true,
      message: '长期记忆已清理',
      removedEntries: result.removedEntries,
    });
  } catch (error) {
    console.error('Memory clear error:', error);
    res.status(500).json({ error: '清理长期记忆失败' });
  }
});

// 按会话清理长期记忆：只摘掉登记在该会话名下的贡献，
// 同一事实若还被别的会话说过的，条目留着（不会跨会话连坐删除）。
// 与 /history/clear（清聊天记录）是两回事：这里动的是长期记忆库。
router.post('/memory/clear-session', requireAuth, async (req, res) => {
  const guard = clearGuardError(req);

  if (guard) {
    auditAction(req, 'memory.clear_session', {
      target: 'memory',
      result: 'denied',
      sessionId:
        typeof (req.body || {}).sessionId === 'string'
          ? req.body.sessionId.trim()
          : null,
      reason: 'confirm_required',
    });
    return res.status(403).json({ error: guard, requireConfirm: true });
  }

  const sessionId = typeof (req.body || {}).sessionId === 'string'
    ? req.body.sessionId.trim()
    : '';

  if (!sessionId) {
    return res.status(400).json({ error: '缺少 sessionId' });
  }

  // 不要求会话仍然存在：长期记忆比会话活得久，删了会话仍应能清理它沉淀的记忆。
  // 真正的边界是「只摘本人名下的贡献」——由 clearSessionMemories 的 userId 过滤保证。
  try {
    const result = await clearSessionMemories(sessionId, resolveUserId(req));

    if (result.reason === 'invalid') {
      return res.status(400).json({ error: 'sessionId 无效' });
    }

    if (result.reason === 'no-match') {
      return res.json({
        ok: true,
        sessionId,
        removedEntries: 0,
        removedContributions: 0,
        remaining: result.remaining,
        message: '该会话没有登记在记忆库中的贡献',
      });
    }

    const consistency = verifyStoreConsistency();

    if (consistency.consistent === false) {
      logDataEvent({
        module: 'memory',
        event: 'memory_clear_session_inconsistent',
        level: 'error',
        action: 'clear_session',
        extra: { sessionId, reason: consistency.reason },
      });

      auditAction(req, 'memory.clear_session', {
        target: 'memory',
        result: 'partial_success',
        sessionId,
        reason: 'consistency_failed',
      });
      return res.status(503).json({
        error: '会话记忆已清理，但落盘校验未通过，请重试',
        partial: true,
        sessionId,
        reason: consistency.reason,
      });
    }

    auditAction(req, 'memory.clear_session', {
      target: 'memory',
      sessionId,
    });
    res.json({
      ok: true,
      sessionId,
      removedEntries: result.removedEntries,
      removedContributions: result.removedContributions,
      remaining: result.remaining,
    });
  } catch (error) {
    auditAction(req, 'memory.clear_session', {
      target: 'memory',
      result: 'failed',
      sessionId,
      reason: error && error.name ? error.name : 'clear_failed',
    });
    logDataEvent({
      module: 'memory',
      event: 'memory_clear_session_failed',
      level: 'error',
      error,
      action: 'clear_session',
      extra: { sessionId },
    });
    res.status(500).json({ error: '清理该会话的长期记忆失败' });
  }
});

// 记忆库：读取当前全部长期记忆（只读，不重置内存数组）。
// scope=all 是只读审计视图：复用 getMemories 已有的 include* 选项，
// 返回 pending / archived / superseded，不改变默认 /memory 的“当前有效”语义。
//
// 归属过滤（P0 阻断项）：只返回 resolveUserId(req) 名下的记忆。
// 单用户部署下等价于全库；多用户下不会把别人的记忆列出来。
router.get('/memory', requireAuth, (req, res) => {
  try {
    const rawScope = req.query.scope;

    if (rawScope !== undefined && rawScope !== 'all') {
      return res.status(400).json({ error: 'scope 只支持 all' });
    }

    const includeAll = rawScope === 'all';
    const userId = resolveUserId(req);

    res.json({
      memories: getMemoriesForUser(
        userId,
        includeAll
          ? {
              includeSuperseded: true,
              includeArchived: true,
              includePending: true,
              includeContested: true,
            }
          : {}
      ),
      scope: includeAll ? 'all' : 'active',
    });
  } catch (error) {
    console.error('Memory API Error:', error);
    res.status(500).json({ error: '读取长期记忆失败' });
  }
});

// 待确认候选：不进入普通检索/注入，需用户明确确认后才转为 active。
router.get('/memory/pending', requireAuth, (req, res) => {
  try {
    res.json({ memories: getPendingMemoriesForUser(resolveUserId(req)) });
  } catch (error) {
    console.error('Memory pending error:', error);
    res.status(500).json({ error: '读取待确认记忆失败' });
  }
});

async function lifecycleWriteResponse(req, res, action, okStatus, failStatus) {
  const id = typeof (req.body || {}).id === 'string' ? req.body.id.trim() : '';

  if (!id) return res.status(400).json({ error: '缺少 id' });

  try {
    const result = await action(id, resolveUserId(req));

    if (result.reason === 'not-found') {
      return res.status(404).json({ error: '记忆不存在', reason: result.reason });
    }

    // 归属不符：明确回 403，不回 404——避免把"无权"伪装成"不存在"后
    // 前端反复重试，也让越权尝试在审计里可识别。
    if (result.reason === 'forbidden') {
      return res.status(403).json({ error: '无权操作该记忆', reason: result.reason });
    }

    if (result.reason === 'not-pending' || result.reason === 'invalid-state') {
      return res.status(failStatus).json({
        error: '当前状态不允许该操作',
        reason: result.reason,
      });
    }

    const consistency = verifyStoreConsistency();

    if (consistency.consistent === false) {
      logDataEvent({
        module: 'memory',
        event: 'memory_lifecycle_inconsistent',
        level: 'error',
        action: okStatus,
        extra: { id, reason: consistency.reason },
      });

      return res.status(503).json({
        error: '操作已执行，但落盘校验未通过，请重试',
        partial: true,
        reason: consistency.reason,
      });
    }

    return res.json({ ok: true, id, ...result });
  } catch (error) {
    logDataEvent({
      module: 'memory',
      event: 'memory_lifecycle_failed',
      level: 'error',
      error,
      action: okStatus,
      extra: { id },
    });
    return res.status(500).json({ error: '记忆状态操作失败' });
  }
}

router.post('/memory/confirm', requireAuth, async (req, res) =>
  lifecycleWriteResponse(req, res, confirmPending, 'confirm', 409)
);

router.post('/memory/reject', requireAuth, async (req, res) =>
  lifecycleWriteResponse(req, res, rejectPending, 'reject', 409)
);

// ---- 工作区写入确认（任务书接法 a：主聊轻量确认往返，2026-11-19）----
// pending 记录由 /chat 里的 workspace_write 工具调用创建（带 sessionId+userId
// 归属），这两条路由是用户在聊天里「确认写入 / 取消」的执行端点。错误形状
// 沿用 memory confirm 的 lifecycleWriteResponse 口径：404 / 403（明确不伪装
// 成不存在）/ 409；写入在确认时重查沙箱与配额，未过则 409 带原短码。
router.post('/workspace/pending/:id/confirm', requireAuth, async (req, res) => {
  const sessionId =
    req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
  if (!sessionId) {
    return res.status(400).json({ error: '缺少 sessionId', code: 'bad_request' });
  }
  const outcome = workspacePending.consumePendingWrite(req.params.id, {
    sessionId,
    userId: resolveUserId(req),
  });
  if (outcome.status === 'not_found') {
    return res.status(404).json({
      error: '待确认写入不存在或已被处理',
      code: 'workspace_pending_not_found',
      reason: 'not_found',
    });
  }
  if (outcome.status === 'expired') {
    return res.status(409).json({
      error: '待确认写入已过期，请重新发起',
      code: 'workspace_pending_expired',
      reason: 'expired',
    });
  }
  if (outcome.status === 'forbidden') {
    return res.status(403).json({
      error: '无权确认该写入',
      code: 'workspace_pending_forbidden',
      reason: 'forbidden',
    });
  }
  const result = await toolWorkspace.executeConfirmedWrite({
    path: outcome.record.path,
    mode: outcome.record.mode,
    content: outcome.record.content,
  });
  if (!result.ok) {
    // pending 已被消费：本次确认不可重试，文案明确「请重新发起」（oracle 低-4）。
    return res.status(409).json({
      ok: false,
      error: `${result.error}；pending 已消费，请重新发起写入`,
      code: result.code,
      reason: result.code,
    });
  }
  return res.json({
    ok: true,
    id: outcome.record.id,
    path: result.path,
    mode: result.mode,
    bytes: result.bytes,
    backup: result.backup || null,
    summary: result.summary,
  });
});

router.post('/workspace/pending/:id/reject', requireAuth, (req, res) => {
  const sessionId =
    req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
  if (!sessionId) {
    return res.status(400).json({ error: '缺少 sessionId', code: 'bad_request' });
  }
  const outcome = workspacePending.cancelPendingWrite(req.params.id, {
    sessionId,
    userId: resolveUserId(req),
  });
  if (outcome.status === 'not_found') {
    return res.status(404).json({
      error: '待确认写入不存在或已被处理',
      code: 'workspace_pending_not_found',
      reason: 'not_found',
    });
  }
  if (outcome.status === 'expired') {
    return res.status(409).json({
      error: '待确认写入已过期',
      code: 'workspace_pending_expired',
      reason: 'expired',
    });
  }
  if (outcome.status === 'forbidden') {
    return res.status(403).json({
      error: '无权取消该写入',
      code: 'workspace_pending_forbidden',
      reason: 'forbidden',
    });
  }
  try {
    monitoring.recordWorkspaceOp({
      tool: 'workspace_write',
      path: String(outcome.record.path || '').slice(0, 200),
      mode: outcome.record.mode || null,
      bytes: Number.isFinite(outcome.record.bytes) ? outcome.record.bytes : null,
      status: 'cancelled',
      code: 'workspace_write_rejected',
      confirmed: false,
    });
  } catch (_) {
    /* 监控失败不影响取消结果 */
  }
  return res.json({ ok: true, id: outcome.record.id, cancelled: true, summary: '已取消该写入' });
});

router.post('/memory/archive', requireAuth, async (req, res) =>
  lifecycleWriteResponse(req, res, archiveMemory, 'archive', 409)
);

// 最近若干次「尝试写长期记忆」的结论（含被哪道闸门拒）。
// 只含短码、会话 id 与条目 id，不含任何记忆正文或用户原话。
router.get('/memory/write-attempts', requireAuth, (req, res) => {
  try {
    res.json({ attempts: getWriteOutcomes() });
  } catch (error) {
    console.error('Memory attempts error:', error);
    res.status(500).json({ error: '读取记忆写入记录失败' });
  }
});

// ---- P5 可追溯画像与反馈 ----
// 画像每次从 memory.json 派生，不落第二份画像文件；来源贡献随条目返回。
router.get('/profile', requireAuth, (req, res) => {
  try {
    const raw = req.query.includeInactive;
    if (raw !== undefined && !['1', '0', 'true', 'false'].includes(String(raw))) {
      return res.status(400).json({
        error: 'includeInactive 只支持 1/0/true/false',
        code: 'invalid_include_inactive',
      });
    }

    const profile = buildProfile({
      userId: resolveUserId(req),
      includeInactive: raw === '1' || raw === 'true',
    });

    res.set('Cache-Control', 'no-store');
    res.json({ profile });
  } catch (error) {
    console.error('Profile API Error:', error);
    res.status(500).json({ error: '读取画像失败', code: 'profile_read_failed' });
  }
});

// 确认 / 否认 / 纠正。反馈写操作与自动抽取共用 memory.js 的写队列与原子落盘；
// 审计只记录动作、结果与短码，不记录记忆正文或用户更正内容。
router.post('/profile/feedback', requireAuth, async (req, res) => {
  try {
    const outcome = await applyProfileFeedback({
      ...(req.body || {}),
      userId: resolveUserId(req),
    });

    if (!outcome.ok) {
      auditAction(req, 'profile.feedback', {
        target: 'memory',
        result: 'denied',
        reason: outcome.reason,
      });
      return res.status(outcome.status || 400).json({
        error: outcome.error || '画像反馈失败',
        code: outcome.reason,
        ...(outcome.feedbackId ? { feedbackId: outcome.feedbackId } : {}),
      });
    }

    auditAction(req, 'profile.feedback', {
      target: 'memory',
      result: 'success',
      reason: outcome.action,
    });
    return res.json({
      ok: true,
      action: outcome.action,
      feedbackId: outcome.feedbackId,
      result: outcome.result,
      profile: outcome.profile,
    });
  } catch (error) {
    auditAction(req, 'profile.feedback', {
      target: 'memory',
      result: 'failed',
      reason: error && error.name ? error.name : 'feedback_failed',
    });
    console.error('Profile feedback error:', error);
    return res.status(500).json({ error: '画像反馈失败', code: 'feedback_failed' });
  }
});

// 情绪系统：读取当前持久化的真实情绪状态（App 启动时同步顶部 Emoji 用）
router.post('/memory/delete', requireAuth, async (req, res) => {
  try {
    const { id, createdAt, content } = req.body || {};

    const hasId = typeof id === 'string' && id.trim();
    const hasLegacy =
      typeof createdAt === 'string' && typeof content === 'string';

    if (!hasId && !hasLegacy) {
      return res
        .status(400)
        .json({ error: '缺少 id，或缺少 createdAt + content' });
    }

    const result = await deleteMemory({
      ...(hasId ? { id } : { createdAt, content }),
      userId: resolveUserId(req),
    });

    // 归属不符：403，且不透露该条是否真实存在。
    if (result.reason === 'forbidden') {
      auditAction(req, 'memory.delete', {
        target: 'memory',
        result: 'denied',
        reason: 'forbidden',
      });
      return res.status(403).json({ error: '无权操作该记忆', reason: 'forbidden' });
    }

    const consistency = verifyStoreConsistency();

    // 删除成功但磁盘与内存对不上：不能回 ok，否则前端把这条划掉、下次启动又冒出来
    if (result.removed && consistency.consistent === false) {
      logDataEvent({
        module: 'memory',
        event: 'memory_delete_inconsistent',
        level: 'error',
        action: 'delete',
        extra: { reason: consistency.reason },
      });

      auditAction(req, 'memory.delete', {
        target: 'memory',
        result: 'partial_success',
        reason: 'consistency_failed',
      });
      return res.status(503).json({
        error: '记忆已删除，但落盘校验未通过，请重试',
        partial: true,
        reason: consistency.reason,
      });
    }

    if (!result.removed) {
      return res.status(404).json({ error: '记忆不存在' });
    }

    auditAction(req, 'memory.delete', { target: 'memory' });
    res.json({ ok: true, removed: result.removed, id: result.id });
  } catch (error) {
    console.error('Memory delete error:', error);
    auditAction(req, 'memory.delete', {
      target: 'memory',
      result: 'failed',
      reason: error && error.name ? error.name : 'delete_failed',
    });
    res.status(500).json({ error: '删除记忆失败' });
  }
});


  return router;
}

module.exports = { createMemoryRouter };
