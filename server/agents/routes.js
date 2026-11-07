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
const workerScope = require('./worker-scope');
const runtime = require('./runtime');
const agentRouter = require('./router');
const resultDelivery = require('./result-delivery');
const mainSessions = require('../sessions');
const approvals = require('./approvals');
const permissions = require('./permissions');
const improvements = require('./improvement-loop');
const { resolveUserId } = require('../user-scope');
const { describeAgentError } = require('./errors');

function sendError(res, error) {
  const { status, ...body } = describeAgentError(error);
  // 既有键 code/error 保持不变；② CAS 的 conflict 会额外带出七个契约字段。
  res.status(status).json(body);
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
      pathName === '/agent-improvements' ||
      pathName.startsWith('/agent-improvements/') ||
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
      const runtimeConfig = config.getRuntimeConfig(botId);
      const result = await credentials.verifyCredential(
        credentialId,
        botId,
        runtimeConfig.modelProfile.providerId
      );
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
      // 这是 direct 用户的对话列表。worker 会话是任务内部轨迹：详情端点对
      // 已归属会话只认服务端签发的作用域令牌（direct 调用方拿不到 → 401），
      // 若列出来，用户选中就只会得到「读取会话失败」。
      const list = sessions
        .listSessions(req.params.botId)
        .filter(item => item.scope !== 'worker' && !item.owner);
      res.json({ sessions: list });
    })
  );

  router.get(
    '/agents/:botId/sessions/:sessionId',
    route(async (req, res) => {
      const botId = req.params.botId;
      // Worker 会话读作用域：direct 会话保持既有行为；worker 会话只认服务端签发的
      // 作用域令牌（x-worker-scope-token），不接受调用方自报的 requesterTaskId /
      // grantedBy。非法令牌 401、越界 409，均写审计且不回显对方内容。
      const session = workerScope.authorizeSessionRead({
        botId,
        sessionId: req.params.sessionId,
        token: req.get('x-worker-scope-token') || null,
      });
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
          // 直接对话也是用户级记忆读：身份只来自服务端，不读 body.userId。
          userId: resolveUserId(req),
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
        const { status, ...rest } = describeAgentError(error);
        send('error', { ...rest, status });
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
        // 与流式入口一致：Bot 直接对话按服务端可信用户身份读长期记忆。
        userId: resolveUserId(req),
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

  // ---- P5-G / §2.6：受控自我改进闭环的生产入口（HTTP）----
  // 链路：POST 创建提案（起草）→ POST evaluate（离线评测）→ POST approve（仅
  // local-owner，鉴权层保证）→ POST release（灰度比例）→ POST rollback-check。
  // 全部经 Bearer 鉴权（上方中间件按前缀拦截）；审计走既有 auditAction。
  router.get(
    '/agent-improvements',
    route(async (req, res) => {
      res.json({
        improvements: improvements.listProposals({
          status: typeof req.query.status === 'string' ? req.query.status : null,
          limit: req.query.limit,
        }),
      });
    })
  );

  router.get(
    '/agent-improvements/:proposalId',
    route(async (req, res) => {
      const proposal = improvements.getProposal(req.params.proposalId);
      if (!proposal) {
        return res.status(404).json({ error: '提案不存在', code: 'improvement_not_found' });
      }
      res.json({ proposal });
    })
  );

  router.post(
    '/agent-improvements',
    route(async (req, res) => {
      const body = req.body || {};
      const proposal = improvements.createProposal({
        category: body.category,
        target: body.target,
        reason: body.reason,
        evidenceRefs: body.evidenceRefs,
        proposedChange: body.proposedChange,
        botId: body.botId,
      });
      audit(req, 'agent.improvement.propose', {
        target: 'agent_improvement',
        reason: proposal.category,
      });
      res.status(201).json({ proposal });
    })
  );

  router.post(
    '/agent-improvements/draft-from-failures',
    route(async (req, res) => {
      const summary = improvements.draftFromRecentFailures({
        eventsLimit: Number(req.body && req.body.eventsLimit) || undefined,
        botIds: req.body && Array.isArray(req.body.botIds) ? req.body.botIds : undefined,
      });
      audit(req, 'agent.improvement.draft', { target: 'agent_improvement' });
      res.json(summary);
    })
  );

  router.post(
    '/agent-improvements/:proposalId/evaluate',
    route(async (req, res) => {
      const body = req.body || {};
      const proposal = improvements.evaluateProposal({
        proposalId: req.params.proposalId,
        suitePaths: Array.isArray(body.suitePaths) ? body.suitePaths : null,
        baseTime: body.baseTime,
      });
      audit(req, 'agent.improvement.evaluate', { target: 'agent_improvement', reason: proposal.category });
      res.json({ proposal });
    })
  );

  router.post(
    '/agent-improvements/:proposalId/approve',
    route(async (req, res) => {
      // 单用户实例：鉴权通过的调用方即 local-owner（与审批路由同一模型）。
      const proposal = improvements.approveProposal({
        proposalId: req.params.proposalId,
        actor: permissions.SINGLE_USER_ACTOR,
      });
      audit(req, 'agent.improvement.approve', { target: 'agent_improvement', reason: proposal.category });
      res.json({ proposal });
    })
  );

  router.post(
    '/agent-improvements/:proposalId/reject',
    route(async (req, res) => {
      const proposal = improvements.rejectProposal({
        proposalId: req.params.proposalId,
        actor: permissions.SINGLE_USER_ACTOR,
        reason: req.body && req.body.reason,
      });
      audit(req, 'agent.improvement.reject', {
        target: 'agent_improvement',
        result: 'denied',
        reason: proposal.category,
      });
      res.json({ proposal });
    })
  );

  router.post(
    '/agent-improvements/:proposalId/release',
    route(async (req, res) => {
      const proposal = improvements.releaseProposal({
        proposalId: req.params.proposalId,
        grayRatio: req.body && req.body.grayRatio,
      });
      audit(req, 'agent.improvement.release', { target: 'agent_improvement', reason: proposal.category });
      res.json({ proposal });
    })
  );

  router.post(
    '/agent-improvements/:proposalId/rollback-check',
    route(async (req, res) => {
      const result = improvements.checkAutoRollback({ proposalId: req.params.proposalId });
      audit(req, 'agent.improvement.rollback_check', {
        target: 'agent_improvement',
        result: result.rolledBack ? 'rolled_back' : 'checked',
      });
      res.json(result);
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
      const agentId = body.agentId || body.botId || 'memory';
      if (body.sessionId && !sessions.getSession(agentId, body.sessionId)) {
        return res.status(404).json({
          error: 'Bot 会话不存在',
          code: 'agent_session_not_found',
        });
      }
      // 直接建任务的 API 与 delegate_to_bot 走同一条 Router 决策链，
      // 不再各自校验能力/工具/预算。
      const { task } = agentRouter.dispatch(
        {
          agentId,
          taskType: body.taskType,
          goal: body.goal,
          context: body.context,
          contextRef: body.contextRef,
          allowedTools: body.allowedTools,
          deadlineMs: body.deadlineMs,
          priority: body.priority,
          idempotencyKey: body.idempotencyKey,
          workerSessionId: body.sessionId,
          parentSessionId: body.parentSessionId,
          parentMessageId: body.parentMessageId,
          parentUserText: body.parentUserText,
          dependsOn: body.dependsOn,
        },
        { source: 'api' }
      );
      audit(req, 'agent.task.create', {
        target: 'agent_task',
        sessionId: task.sessionId,
        reason: task.taskType,
      });
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
