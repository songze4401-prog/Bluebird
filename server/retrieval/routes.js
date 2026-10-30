/**
 * 云岫 Bluebird — 统一检索 HTTP API（retrieval/routes.js）
 *
 * 读接口：GET /retrieval/status、/sources、/sources/:id、/consistency
 * 查询接口：POST /retrieval/search（不修改业务源数据；按需幂等刷新派生索引）
 * 管理接口：POST /retrieval/ingest、POST /retrieval/sync、POST /retrieval/vectors/backfill、
 *           DELETE /retrieval/sources/:id、POST /retrieval/rebuild（写索引，必须 Bearer 鉴权）
 *
 * 所有接口复用全局限流；错误只回受控短码，不回显文件内容、URL 参数或上游响应。
 */
const express = require('express');
const sessions = require('../sessions');
const retrieval = require('./index');

function statusCodeFor(code) {
  if (
    code === 'query_required' ||
    code === 'query_too_long' ||
    code === 'sources_empty' ||
    code === 'invalid_source' ||
    code === 'session_required' ||
    code === 'invalid_as_of' ||
    code === 'path_required' ||
    code === 'invalid_url' ||
    code === 'unsupported_protocol'
  ) {
    return 400;
  }
  if (code === 'source_not_found' || code === 'session_missing') return 404;
  if (code === 'managed_source' || code === 'chunk_limit_exceeded' || code === 'source_limit_exceeded') {
    return 409;
  }
  if (code === 'source_root_missing' || code === 'url_mismatch') return 409;
  if (code === 'refresh_url_required' || code === 'source_type_not_refreshable') return 400;
  if (code === 'retrieval_disabled') return 503;
  if (code === 'index_unavailable' || code === 'index_isolation_failed') return 503;
  if (code === 'roots_not_configured') return 503;
  if (code === 'retrieval_failed' || code === 'ingest_failed') return 500;
  return 400;
}

function sendFailure(res, result, fallbackStatus = 400) {
  const code = result.errorCode || 'retrieval_failed';
  res.status(statusCodeFor(code) || fallbackStatus).json({
    ok: false,
    error: result.error || retrieval.describeError(code),
    code,
  });
}

function createRetrievalRouter({ requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/status', (req, res) => {
    try {
      const status = retrieval.getStatus();
      res.status(status.ok === false ? 503 : 200).json(status);
    } catch (_) {
      res.status(503).json({
        ok: false,
        state: 'degraded',
        error: retrieval.describeError('index_unavailable'),
        code: 'index_unavailable',
      });
    }
  });

  router.get('/sources', (req, res) => {
    try {
      res.json(retrieval.getSources());
    } catch (_) {
      res.status(503).json({ ok: false, code: 'index_unavailable', error: retrieval.describeError('index_unavailable') });
    }
  });

  router.get('/sources/:id', (req, res) => {
    try {
      const source = retrieval.getSource(req.params.id);
      if (!source) {
        return res.status(404).json({ ok: false, code: 'source_not_found', error: retrieval.describeError('source_not_found') });
      }
      res.json({ ok: true, source });
    } catch (_) {
      res.status(503).json({ ok: false, code: 'index_unavailable', error: retrieval.describeError('index_unavailable') });
    }
  });

  router.get('/consistency', (req, res) => {
    try {
      res.json(retrieval.checkConsistency());
    } catch (_) {
      res.status(503).json({ ok: false, code: 'index_unavailable', error: retrieval.describeError('index_unavailable') });
    }
  });

  router.post('/search', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : null;

    if (sessionId && !sessions.getSession(sessionId)) {
      return res.status(404).json({
        ok: false,
        code: 'session_missing',
        error: '会话不存在',
      });
    }

    try {
      const result = await retrieval.search({
        query: body.query,
        sessionId,
        sources: body.sources,
        limit: body.limit,
        tokenBudget: body.tokenBudget,
        asOf: body.asOf,
      });
      if (!result.ok) {
        return sendFailure(res, result, result.errorCode === 'index_unavailable' ? 503 : 400);
      }
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, code: 'retrieval_failed', error: '检索执行失败' });
    }
  });

  router.post('/ingest', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!['document', 'web', 'code'].includes(type)) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_source',
        error: 'type 必须是 document/web/code',
      });
    }

    const inputPath =
      typeof body.path === 'string' && body.path.length <= 1000 ? body.path : '';
    const url = typeof body.url === 'string' && body.url.length <= 2000 ? body.url : '';
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';

    if (type === 'web' ? !url : !inputPath) {
      return res.status(400).json({
        ok: false,
        code: type === 'web' ? 'invalid_url' : 'path_required',
        error: type === 'web' ? '必须提供 url' : '必须提供 path',
      });
    }

    try {
      const result = await retrieval.ingest({
        type,
        inputPath,
        url,
        title,
      });
      if (!result.ok) return sendFailure(res, result);
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, code: 'ingest_failed', error: '索引失败' });
    }
  });

  router.post('/sync', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sourceId =
      typeof body.sourceId === 'string' && body.sourceId.trim()
        ? body.sourceId.trim()
        : '';
    const url = typeof body.url === 'string' && body.url.length <= 2000 ? body.url : '';

    try {
      const result = sourceId
        ? await retrieval.refreshSource(sourceId, { url })
        : await retrieval.refreshAllExternal();
      if (!result.ok) return sendFailure(res, result);
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, code: 'sync_failed', error: '刷新索引失败' });
    }
  });

  router.delete('/sources/:id', async (req, res) => {
    try {
      const result = await retrieval.removeSource(req.params.id);
      if (!result.ok) return sendFailure(res, result);
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, code: 'delete_failed', error: '删除索引来源失败' });
    }
  });

  // 只补齐缺失/失效向量的向量回填：不重建来源索引，不改变词法索引。
  router.post('/vectors/backfill', async (req, res) => {
    try {
      const result = await retrieval.backfillVectors();
      if (result.status === 'failed') {
        return res.status(500).json({ ok: false, ...result });
      }
      if (result.status === 'unavailable' || result.status === 'disabled') {
        return res.status(409).json({ ok: false, ...result });
      }
      res.json({ ok: true, ...result });
    } catch (_) {
      res.status(500).json({
        ok: false,
        status: 'failed',
        errorCode: 'vector_backfill_failed',
      });
    }
  });

  router.post('/rebuild', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const syncSources = body.syncSources !== false;
    const vectors = body.vectors !== false;

    try {
      const result = await retrieval.rebuild({ syncSources, vectors });
      if (result && result.ok === false) return sendFailure(res, result, 409);
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, code: 'rebuild_failed', error: '重建索引失败' });
    }
  });

  router.all('/status', (req, res) => {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET').status(405).json({ error: '只支持 GET' });
    }
  });
  router.all('/sources', (req, res) => {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET').status(405).json({ error: '只支持 GET' });
    }
  });

  return router;
}

module.exports = { createRetrievalRouter };
