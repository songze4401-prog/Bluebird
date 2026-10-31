/* global module */
/**
 * Memory Bot HTTP API。
 * 路径按现有项目风格使用 /agents 与 /agent-tasks（不是 /api 前缀）；
 * 所有接口复用 Bearer 鉴权与全局限流，响应不含 API Key 明文。
 */
const express = require('express');
const registry = require('./registry');
const config = require('./config');
const credentials = require('./credentials');
const sessions = require('./sessions');
const tasks = require('./tasks');
const runtime = require('./runtime');
const resultDelivery = require('./result-delivery');
const mainSessions = require('../sessions');
const approvals = require('./approvals');
const permissions = require('./permissions');
const { describeAgentError } = require('./errors');

function sendError(res, error) {
  const info = describeAgentError(error);
  res.status(info.status).json({ error: info.error, code: info.code });
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function createAgentRouter({ requireAuth, auditAction = null } = {}) {
  const router = express.Router();
  // 路由挂在根路径以便同时提供 /agents 与 /agent-tasks；只对这两个前缀鉴权，
  // 不能把全站其他请求（如公开的 /）卷进 Agent 鉴权中间件。
  router.use((req, res, next) => {
    const pathName = req.path;
    const isAgentPath =
      pathName === '/agents' ||
      pathName.startsWith('/agents/') ||
      pathName === '/agent-tasks' ||
      pathName.startsWith('/agent-tasks/') ||
      pathName === '/agent-approvals' ||
      pathName.startsWith('/agent-approvals/') ||
      pathName === '/agent-results' ||
      pathName.startsWith('/agent-results/');
    if (!isAgentPath) return next();
    return requireAuth(req, res, next);
  });

  function audit(req, action, options = {}) {
    if (typeof auditAction === 'function') {
      try {
        auditAction(req, action, options);
      } catch (_) {
        /* 审计失败不影响主业务 */
      }
    }
  }

  // 主控结果 SSE：任务完成/失败结果由 Result Delivery 推送到当前会话。
  // 建连时先发最近结果 snapshot，客户端按消息 id 去重，覆盖断线重连。
  router.get('/agent-results/stream', (req, res) => {
    const sessionId =
      typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId || !mainSessions.getSession(sessionId)) {
      res.status(404).json({ error: '会话不存在', code: 'session_missing' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const send = payload => {
      if (closed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      send({
        type: 'snapshot',
        sessionId,
        results: resultDelivery.snapshotForSession(sessionId),
      });
    } catch (_) {
      send({ type: 'snapshot', sessionId, results: [] });
    }

    const unsubscribe = resultDelivery.subscribe(event => {
      if (event && event.sessionId === sessionId) send(event);
    });
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      res.write(': ping\n\n');
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  router.get(
    '/agents',
    route(async (req, res) => {
      res.json({ agents: registry.listAgents() });
    })
  );

  router.get(
    '/agents/:botId',
    route(async (req, res) => {
      res.json({ agent: registry.getAgent(req.params.botId) });
    })
  );

  router.get(
    '/agents/:botId/config',
    route(async (req, res) => {
      res.json({
        config: config.publicConfig(req.params.botId),
        agent: registry.getAgent(req.params.botId),
      });
    })
  );

  router.put(
    '/agents/:botId/config',
    route(async (req, res) => {
      const botId = req.params.botId;
      const updated = config.updateConfig(botId, req.body || {});
      audit(req, 'agent.config.update', {
        target: 'agent_config',
        reason: 'configuration_changed',
      });
      res.json({ config: updated, agent: registry.getAgent(botId) });
    })
  );

  router.post(
    '/agents/:botId/credentials',
    route(async (req, res) => {
      const botId = req.params.botId;
      const body = req.body || {};
      const credential = credentials.putCredential({
        botId,
        providerId: body.providerId,
        apiKey: body.apiKey,
      });
      config.setCredentialId(botId, credential.credentialId);
      audit(req, 'agent.credential.create', {
        target: 'agent_credential',
        reason: 'credential_replaced',
      });
      res.status(201).json({
        credential,
        agent: registry.getAgent(botId),
      });
    })
  );

  router.post(
    '/agents/:botId/credentials/verify',
    route(async (req, res) => {
      const botId = req.params.botId;
      const agent = registry.getAgent(botId);
      const credentialId =
        (req.body && req.body.credentialId) ||
        (agent.credential && agent.credential.credentialId);
      if (!credentialId) {
        return res.status(409).json({
          error: 'Memory Bot 未配置 API Key',
          code: 'credential_not_configured',
        });
      }
      const result = await credentials.verifyCredential(credentialId, botId);
      audit(req, 'agent.credential.verify', {
        target: 'agent_credential',
        result: result.ok ? 'success' : 'failed',
        reason: result.code || null,
      });
      res.json({ ...result, agent: registry.getAgent(botId) });
    })
  );

  router.delete(
    '/agents/:botId/credentials/:credentialId',
    route(async (req, res) => {
      const botId = req.params.botId;
      const runtimeConfig = config.getRuntimeConfig(botId);
      const currentCredentialId = runtimeConfig.modelProfile.credentialId;
      const result = credentials.deleteCredential(req.params.credentialId, botId);
      if (!result.deleted) {
        return res.status(404).json({ error: '凭证不存在', code: 'credential_not_found' });
      }
      if (currentCredentialId === result.credentialId) {
        config.setCredentialId(botId, null);
      }
      audit(req, 'agent.credential.delete', {
        target: 'agent_credential',
        reason: 'credential_deleted',
      });
      res.json({ ok: true, credentialId: result.credentialId, agent: registry.getAgent(botId) });
    })
  );

  router.post(
    '/agents/:botId/sessions',
    route(async (req, res) => {
      const session = sessions.createSession(req.params.botId, {
        title: req.body && req.body.title,
      });
      res.status(201).json({ session });
    })
  );

  router.get(
    '/agents/:botId/sessions',
    route(async (req, res) => {
      res.json({ sessions: sessions.listSessions(req.params.botId) });
    })
  );

  router.get(
    '/agents/:botId/sessions/:sessionId',
    route(async (req, res) => {
      const botId = req.params.botId;
      const session = sessions.getSession(botId, req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Bot 会话不存在', code: 'agent_session_not_found' });
      }
      res.json({
        session,
        messages: sessions.getMessages(botId, req.params.sessionId),
      });
    })
  );

  router.delete(
    '/agents/:botId/sessions/:sessionId',
    route(async (req, res) => {
      const removed = sessions.deleteSession(req.params.botId, req.params.sessionId);
      if (!removed) {
        return res.status(404).json({ error: 'Bot 会话不存在', code: 'agent_session_not_found' });
      }
      res.json({ ok: true });
    })
  );

  router.post(
    '/agents/:botId/chat/stream',
    async (req, res) => {
      const botId = req.params.botId;
      const body = req.body || {};
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const send = (type, payload) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
      };
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      send('meta', { botId, sessionId: body.sessionId || null, stream: 'token' });

      let deltaCount = 0;
      try {
        const result = await runtime.chat(botId, {
          sessionId: body.sessionId,
          message: body.message,
          signal: controller.signal,
          stream: true,
          onDelta: delta => {
            deltaCount += 1;
            send('delta', { delta });
          },
          onToolEvent: event => send(event.type, event),
        });
        if (!deltaCount && result.message.content) {
          send('delta', { delta: result.message.content });
        }
        send('done', result);
      } catch (error) {
        const info = describeAgentError(error);
        send('error', {
          code: info.code,
          error: info.error,
          status: info.status,
        });
      } finally {
        if (!res.writableEnded) res.end();
      }
    }
  );

  router.post(
    '/agents/:botId/chat',
    route(async (req, res) => {
      const body = req.body || {};
      const result = await runtime.chat(req.params.botId, {
        sessionId: body.sessionId,
        message: body.message,
      });
      res.json(result);
    })
  );

  router.get(
    '/agents/:botId/events',
    route(async (req, res) => {
      const events = tasks.listEvents(req.params.botId, {
        limit: req.query.limit,
      });
      res.json({ events });
    })
  );

  router.get(
    '/agents/:botId/permissions',
    route(async (req, res) => {
      res.json({ permission: permissions.getPermissionProfile(req.params.botId) });
    })
  );

  router.post(
    '/agents/:botId/approvals',
    route(async (req, res) => {
      const body = req.body || {};
      const approval = approvals.createApproval({
        botId: req.params.botId,
        operation: body.operation,
        payload: body.payload,
        taskId: body.taskId,
        sessionId: body.sessionId,
        requestedBy: body.requestedBy,
      });
      audit(req, 'agent.approval.request', {
        target: 'agent_approval',
        sessionId: approval.sessionId,
        reason: approval.operation,
      });
      res.status(201).json({ approval });
    })
  );

  router.get(
    '/agents/:botId/approvals',
    route(async (req, res) => {
      res.json({
        approvals: approvals.listApprovals(req.params.botId, {
          limit: req.query.limit,
          status: typeof req.query.status === 'string' ? req.query.status : null,
        }),
      });
    })
  );

  router.get(
    '/agent-approvals/:approvalId',
    route(async (req, res) => {
      const approval = approvals.getApproval(req.params.approvalId);
      if (!approval) {
        return res.status(404).json({ error: '审批不存在', code: 'approval_not_found' });
      }
      res.json({ approval });
    })
  );

  router.post(
    '/agent-approvals/:approvalId/approve',
    route(async (req, res) => {
      const approval = approvals.approve(req.params.approvalId, {
        reason: req.body && req.body.reason,
      });
      audit(req, 'agent.approval.approve', {
        target: 'agent_approval',
        sessionId: approval.sessionId,
        reason: approval.operation,
      });
      res.json({ approval });
    })
  );

  router.post(
    '/agent-approvals/:approvalId/reject',
    route(async (req, res) => {
      const approval = approvals.reject(req.params.approvalId, {
        reason: req.body && req.body.reason,
      });
      audit(req, 'agent.approval.reject', {
        target: 'agent_approval',
        result: 'denied',
        sessionId: approval.sessionId,
        reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 120) : 'rejected',
      });
      res.json({ approval });
    })
  );

  router.post(
    '/agent-approvals/:approvalId/execute',
    route(async (req, res) => {
      const approval = await approvals.execute(req.params.approvalId);
      audit(req, 'agent.approval.execute', {
        target: 'agent_approval',
        result: approval.status === 'completed' ? 'success' : 'failed',
        sessionId: approval.sessionId,
        reason: approval.errorCode || approval.operation,
      });
      res.json({ approval });
    })
  );

  router.post(
    '/agent-tasks',
    route(async (req, res) => {
      const body = req.body || {};
      const botId = body.botId || 'memory';
      if (body.sessionId && !sessions.getSession(botId, body.sessionId)) {
        return res.status(404).json({
          error: 'Bot 会话不存在',
          code: 'agent_session_not_found',
        });
      }
      const task = tasks.createTask({
        botId,
        taskType: body.taskType,
        goal: body.goal,
        context: body.context,
        sessionId: body.sessionId,
        allowedTools: body.allowedTools,
        deadlineMs: body.deadlineMs,
        parentSessionId: body.parentSessionId,
        parentMessageId: body.parentMessageId,
      });
      audit(req, 'agent.task.create', {
        target: 'agent_task',
        sessionId: task.sessionId,
        reason: task.taskType,
      });
      runtime.startTask(task.taskId);
      res.status(202).json({ task: tasks.getTask(task.taskId) });
    })
  );

  router.get(
    '/agent-tasks',
    route(async (req, res) => {
      const botId = typeof req.query.botId === 'string' ? req.query.botId : 'memory';
      res.json({
        tasks: tasks.listTasks(botId, {
          limit: req.query.limit,
          parentSessionId:
            typeof req.query.parentSessionId === 'string'
              ? req.query.parentSessionId
              : null,
        }),
      });
    })
  );

  router.get(
    '/agent-tasks/:taskId',
    route(async (req, res) => {
      const task = tasks.getTask(req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: '任务不存在', code: 'task_not_found' });
      }
      res.json({ task });
    })
  );

  router.post(
    '/agent-tasks/:taskId/cancel',
    route(async (req, res) => {
      const task = runtime.cancelTask(req.params.taskId);
      audit(req, 'agent.task.cancel', {
        target: 'agent_task',
        result: 'success',
        sessionId: task.sessionId,
      });
      res.json({ task });
    })
  );

  return router;
}

module.exports = { createAgentRouter };
