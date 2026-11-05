#!/usr/bin/env node
/**
 * A-13 / §20（按 Owner 口径九步）端到端 worked example。
 *
 * 真实链路：两个 researcher 任务并行 → 各写结论产物 A1/B1（来源/时间/provenance/taint）
 * → 确定性验证（schema/引用/来源）→ 独立 reviewer 对照来源裁决冲突 C1
 * → 交付建议 + 来源 + 分歧处理 + 剩余不确定性 → 记录 trace/事件/Token/延迟/成本。
 *
 * 环境限制（必须如实标注）：
 *  - 模型使用本地 OpenAI 兼容 HTTP stub（非真实模型），只验证链路与数据形态；
 *  - Token 取 provider 返回的真实 usage；成本因本地 stub 无计价，记「未采集」。
 *
 * 用法：
 *   node scripts/run-worked-example.js --out docs/e2e-worked-example-run-2026-11-05.json
 *   node scripts/run-worked-example.js --json        # 输出到 stdout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

function argOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const DATA_DIR = argOf('--data-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-e2e-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = '2';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '40';

const tasks = require('../server/agents/tasks');
const runtime = require('../server/agents/runtime');
const artifactStore = require('../server/agents/artifact-store');
const verificationLoop = require('../server/agents/verification-loop');
const conflictRecord = require('../server/agents/conflict-record');
const apiConfigs = require('../server/api-configs');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');

const STEPS = [];
const TRACE_ID = `trace_${crypto.randomUUID()}`;

function nowIso() {
  return new Date().toISOString();
}

function completion(content, usage) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'worked-example-local-stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

function lastUserText(messages) {
  return String((messages.at(-1) || {}).content || '');
}

function waitForTerminal(taskId, timeoutMs = 30000) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const task = tasks.getTask(taskId);
      if (task && tasks.isTerminalStatus(task.status)) return resolve(task);
      if (Date.now() > deadline) return resolve(task);
      setTimeout(tick, 25);
    };
    tick();
  });
}

function eventsOf(taskId) {
  const task = tasks.getRawTask(taskId);
  if (!task) return [];
  return tasks
    .listEvents(task.botId, { limit: 500 })
    .filter(event => event.taskId === taskId);
}

function eventSummary(taskId) {
  return eventsOf(taskId).map(event => ({
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    status: event.payload && event.payload.status ? event.payload.status : null,
  }));
}

async function main() {
  let server;
  const startedAt = Date.now();
  // 本地 provider 侧的真实 usage 快照（runtime 透传缺失时以此为准，不估算）。
  const providerUsage = { workerA: null, workerB: null, reviewer: null };
  try {
    // Step 0：本地探针 provider（非真实模型）。
    const providerServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'worked-example-local-stub' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const text = lastUserText(parsed.messages || []);
        const delay = 120;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (text.includes('WORKER_RESEARCH_A')) {
            providerUsage.workerA = { prompt_tokens: 180, completion_tokens: 64, total_tokens: 244 };
            res.end(
              JSON.stringify(
                completion(
                  JSON.stringify({
                    worker: 'A',
                    subject: '订阅价格',
                    claim: { key: 'monthly_price', value: '$99' },
                    source: {
                      url: 'https://vendor-a.example/pricing',
                      retrievedAt: '2026-11-05T02:10:00.000Z',
                      title: 'Vendor A 官方定价页',
                    },
                    uncertainty: '促销价可能随时调整',
                  }),
                  { prompt_tokens: 180, completion_tokens: 64, total_tokens: 244 }
                )
              )
            );
            return;
          }
          if (text.includes('WORKER_RESEARCH_B')) {
            providerUsage.workerB = { prompt_tokens: 176, completion_tokens: 66, total_tokens: 242 };
            res.end(
              JSON.stringify(
                completion(
                  JSON.stringify({
                    worker: 'B',
                    subject: '订阅价格',
                    claim: { key: 'monthly_price', value: '$129' },
                    source: {
                      url: 'https://vendor-a.example/legacy-pricing',
                      retrievedAt: '2026-10-26T09:00:00.000Z',
                      title: 'Vendor A 旧版定价页（缓存）',
                    },
                    uncertainty: '页面可能已过期',
                  }),
                  { prompt_tokens: 176, completion_tokens: 66, total_tokens: 242 }
                )
              )
            );
            return;
          }
          if (text.includes('INDEPENDENT_CONFLICT_REVIEW')) {
            providerUsage.reviewer = { prompt_tokens: 320, completion_tokens: 88, total_tokens: 408 };
            const aId = text.match(/candidate_A=([^\s]+)/);
            const bId = text.match(/candidate_B=([^\s]+)/);
            res.end(
              JSON.stringify(
                completion(
                  JSON.stringify({
                    decision: 'pass',
                    candidateRef: aId ? aId[1] : null,
                    evidence: [
                      ...(aId ? [{ id: aId[1], version: 1 }] : []),
                      ...(bId ? [{ id: bId[1], version: 1 }] : []),
                    ],
                    reasons: ['source_a_newer', 'source_b_cached_and_stale'],
                    uncertainty: '两来源抓取时间相差 10 天，价格可能已变化',
                  }),
                  { prompt_tokens: 320, completion_tokens: 88, total_tokens: 408 }
                )
              )
            );
            return;
          }
          res.end(
            JSON.stringify(
              completion('unexpected_request', {
                prompt_tokens: 10,
                completion_tokens: 4,
                total_tokens: 14,
              })
            )
          );
        }, delay);
      });
    });
    await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
    server = providerServer;
    const providerBase = `http://127.0.0.1:${providerServer.address().port}/v1`;
    const added = apiConfigs.addModelProvider({
      name: 'Worked Example Local Stub',
      baseUrl: providerBase,
      apiKey: 'local-not-used',
      models: [
        {
          id: 'worked-example-local-stub',
          name: 'Worked Example Local Stub',
          capabilities: { tools: false, vision: false },
        },
      ],
    });
    const providerId = added.provider.id;
    for (const botId of ['researcher', 'reviewer']) {
      agentConfig.updateConfig(botId, {
        enabled: true,
        modelProfile: {
          providerId,
          modelId: 'worked-example-local-stub',
          temperature: 0.1,
          maxTokens: 512,
          timeoutMs: 20000,
        },
      });
      const credential = credentials.putCredential({
        botId,
        providerId,
        apiKey: 'local-stub-key',
      });
      agentConfig.setCredentialId(botId, credential.credentialId);
    }
    STEPS.push({
      step: 1,
      name: '准备本地 provider 与 Agent 配置',
      startedAt: nowIso(),
      durationMs: Date.now() - startedAt,
      environment: 'local-http-stub（非真实模型）',
      providerId,
      bots: ['researcher', 'reviewer'],
    });

    // Step 1-2：两个 Worker 并行研究。
    const stepWorkersStart = Date.now();
    const taskA = tasks.createTask({
      agentId: 'researcher',
      taskType: 'memory.recall',
      goal: 'WORKER_RESEARCH_A 研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。',
      allowedTools: [],
      deadlineMs: 30000,
    });
    const taskB = tasks.createTask({
      agentId: 'researcher',
      taskType: 'memory.recall',
      goal: 'WORKER_RESEARCH_B 独立研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。',
      allowedTools: [],
      deadlineMs: 30000,
    });
    runtime.startTask(taskA.taskId);
    runtime.startTask(taskB.taskId);
    const [doneA, doneB] = await Promise.all([
      waitForTerminal(taskA.taskId),
      waitForTerminal(taskB.taskId),
    ]);
    if (doneA.status !== 'completed' || doneB.status !== 'completed') {
      throw new Error(`worker 未完成：A=${doneA.status}/${doneA.errorCode} B=${doneB.status}/${doneB.errorCode}`);
    }
    const startedEvents = {
      A: eventsOf(taskA.taskId).find(event => event.eventType === 'task.accepted'),
      B: eventsOf(taskB.taskId).find(event => event.eventType === 'task.accepted'),
    };
    const completedEvents = {
      A: eventsOf(taskA.taskId).find(event => event.eventType === 'task.completed'),
      B: eventsOf(taskB.taskId).find(event => event.eventType === 'task.completed'),
    };
    const parallel =
      startedEvents.A &&
      startedEvents.B &&
      completedEvents.A &&
      completedEvents.B &&
      Date.parse(startedEvents.A.timestamp) < Date.parse(completedEvents.B.timestamp) &&
      Date.parse(startedEvents.B.timestamp) < Date.parse(completedEvents.A.timestamp);
    STEPS.push({
      step: 2,
      name: '两个 Worker 并行研究',
      startedAt: nowIso(),
      durationMs: Date.now() - stepWorkersStart,
      taskIds: [taskA.taskId, taskB.taskId],
      sessions: [doneA.sessionId, doneB.sessionId],
      parallel,
      outputs: {
        A: parseWorkerJson(doneA),
        B: parseWorkerJson(doneB),
      },
      eventIds: [...eventsOf(taskA.taskId), ...eventsOf(taskB.taskId)]
        .filter(event => ['task.accepted', 'task.completed'].includes(event.eventType))
        .map(event => event.eventId),
    });

    // Step 3：各写 A1/B1（来源、时间、provenance、taint）。
    const stepArtifactStart = Date.now();
    const sourceA = parseWorkerJson(doneA).source;
    const sourceB = parseWorkerJson(doneB).source;
    const srcA = artifactStore.persist({
      kind: 'source',
      taskId: taskA.taskId,
      content: { ...sourceA, fetchedBy: 'worker_A' },
      sourceLabels: ['web:vendor-a.example'],
    });
    const srcB = artifactStore.persist({
      kind: 'source',
      taskId: taskB.taskId,
      content: { ...sourceB, fetchedBy: 'worker_B' },
      sourceLabels: ['web:vendor-a.example'],
    });
    const artA = artifactStore.persist({
      kind: 'conclusion',
      taskId: taskA.taskId,
      content: {
        subject: '订阅价格',
        claims: [parseWorkerJson(doneA).claim],
        evidence: [{ kind: 'source', id: srcA.id, version: srcA.version }],
        sources: [sourceA],
        retrievedAt: sourceA.retrievedAt,
        uncertainty: parseWorkerJson(doneA).uncertainty,
      },
      provenanceRefs: [{ kind: 'source', id: srcA.id, version: srcA.version }],
      sourceLabels: ['web:vendor-a.example'],
    });
    const artB = artifactStore.persist({
      kind: 'conclusion',
      taskId: taskB.taskId,
      content: {
        subject: '订阅价格',
        claims: [parseWorkerJson(doneB).claim],
        evidence: [{ kind: 'source', id: srcB.id, version: srcB.version }],
        sources: [sourceB],
        retrievedAt: sourceB.retrievedAt,
        uncertainty: parseWorkerJson(doneB).uncertainty,
      },
      provenanceRefs: [{ kind: 'source', id: srcB.id, version: srcB.version }],
      sourceLabels: ['web:vendor-a.example'],
    });
    const artifactView = artifact => ({
      kind: artifact.kind,
      id: artifact.id,
      version: artifact.version,
      taskId: artifact.taskId,
      provenanceRefs: artifactStore.readProvenanceRefs(artifact),
      taintLabels: artifactStore.readTaintLabels(artifact),
      taintPolicyVersion: artifact.taintPolicyVersion,
      createdAt: artifact.createdAt,
      contentHash: artifact.contentHash,
    });
    STEPS.push({
      step: 3,
      name: '各写 A1/B1（来源/时间/provenance/taint）',
      startedAt: nowIso(),
      durationMs: Date.now() - stepArtifactStart,
      artifacts: {
        S1: artifactView(srcA),
        S2: artifactView(srcB),
        A1: artifactView(artA),
        B1: artifactView(artB),
      },
    });

    // Step 4：确定性验证（schema / 引用 / 来源链）。
    const stepVerifyStart = Date.now();
    const verifyA = verificationLoop.verifyDeterministic({
      taskId: taskA.taskId,
      result: { ...doneA.result, artifacts: [...(doneA.result.artifacts || []), { kind: artA.kind, id: artA.id, version: artA.version }] },
    });
    const verifyB = verificationLoop.verifyDeterministic({
      taskId: taskB.taskId,
      result: { ...doneB.result, artifacts: [...(doneB.result.artifacts || []), { kind: artB.kind, id: artB.id, version: artB.version }] },
    });
    const checkGroup = (report, names) =>
      report.checks.filter(check => names.includes(check.name));
    const schemaNames = ['result_shape', 'required_fields', 'artifact_refs', 'content_readable', 'hash_match'];
    const refNames = ['refs_resolvable', 'version_consistent'];
    const sourceNames = ['evidence_resolvable', 'provenance_intact'];
    const verifyView = (report, names) => ({
      ok: checkGroup(report, names).every(check => check.ok),
      checks: checkGroup(report, names),
    });
    STEPS.push({
      step: 4,
      name: '验证：schema 检查',
      startedAt: nowIso(),
      durationMs: Date.now() - stepVerifyStart,
      result: { A1: verifyView(verifyA, schemaNames), B1: verifyView(verifyB, schemaNames) },
    });
    STEPS.push({
      step: 5,
      name: '验证：引用检查',
      startedAt: nowIso(),
      durationMs: 0,
      result: { A1: verifyView(verifyA, refNames), B1: verifyView(verifyB, refNames) },
    });
    STEPS.push({
      step: 6,
      name: '验证：来源检查',
      startedAt: nowIso(),
      durationMs: 0,
      result: { A1: verifyView(verifyA, sourceNames), B1: verifyView(verifyB, sourceNames) },
    });
    if (!verifyA.ok || !verifyB.ok) {
      throw new Error(`确定性验证失败：A1=${verifyA.errorCode} B1=${verifyB.errorCode}`);
    }

    // Step 7：独立 Reviewer 对照来源裁决冲突 C1。
    const stepReviewStart = Date.now();
    const reviewGoal = [
      'INDEPENDENT_CONFLICT_REVIEW 对照来源裁决两组结论的冲突。',
      `candidate_A=${artA.id}`,
      `candidate_B=${artB.id}`,
      `source_A=${srcA.id} url=${sourceA.url} retrievedAt=${sourceA.retrievedAt}`,
      `source_B=${srcB.id} url=${sourceB.url} retrievedAt=${sourceB.retrievedAt}`,
      'A1：月订阅价 $99；B1：月订阅价 $129。请按来源时间与可信度选择候选，并给出证据与剩余不确定性。',
    ].join('\n');
    const reviewTask = tasks.createTask({
      agentId: 'reviewer',
      taskType: 'review.verify',
      goal: reviewGoal,
      allowedTools: [],
      deadlineMs: 30000,
    });
    runtime.startTask(reviewTask.taskId);
    const doneReview = await waitForTerminal(reviewTask.taskId);
    if (doneReview.status !== 'completed') {
      throw new Error(`reviewer 未完成：${doneReview.status}/${doneReview.errorCode}`);
    }
    const verdict = verificationLoop.parseVerdict(doneReview);
    const independent = verificationLoop.isIndependentReviewEvidence({
      reviewerTaskId: reviewTask.taskId,
      producerTaskId: taskA.taskId,
      reviewerBotId: doneReview.botId,
    });
    const record = conflictRecord.createRecord({
      subjectKey: 'subscription_monthly_price',
      conflictType: 'factual',
      candidateRefs: [artA.id, artB.id],
      evidenceRefs: [srcA.id, srcB.id],
      taskId: taskA.taskId,
    });
    conflictRecord.persist(record);
    const decision = verificationLoop.arbitrateConflict({
      conflictRecord: record,
      conflictType: 'factual',
      arbiter: 'reviewer',
      evidence: [
        {
          source: 'reviewer',
          independent,
          ok: verdict.decision === 'pass',
          candidateRef: verdict.raw && verdict.raw.candidateRef ? verdict.raw.candidateRef : null,
        },
      ],
    });
    const resolved = verificationLoop.recordArbitration({
      conflictRecord: record,
      decision,
      producerTask: tasks.getRawTask(taskA.taskId),
      runId: doneA.runId || null,
    });
    if (decision.status !== 'resolved' || !resolved.selectedCandidateRef) {
      throw new Error(`冲突 C1 未裁决：${decision.status}/${decision.errorCode}`);
    }
    STEPS.push({
      step: 7,
      name: 'Reviewer 对照来源裁决冲突 C1',
      startedAt: nowIso(),
      durationMs: Date.now() - stepReviewStart,
      reviewTaskId: reviewTask.taskId,
      reviewerIndependent: independent,
      verdict: {
        decision: verdict.decision,
        valid: verdict.valid,
        evidence: verdict.evidence,
        reasons: verdict.reasons,
        uncertainty: verdict.raw ? verdict.raw.uncertainty || null : null,
      },
      conflict: {
        conflictId: resolved.conflictId,
        conflictType: resolved.conflictType,
        candidateRefs: resolved.candidateRefs,
        evidenceRefs: resolved.evidenceRefs,
        resolutionStatus: resolved.resolutionStatus,
        resolutionMethod: resolved.resolutionMethod,
        selectedCandidateRef: resolved.selectedCandidateRef,
        rationale: resolved.rationale,
        policyVersion: resolved.policyVersion,
        arbitrationPolicyVersion: decision.policyVersion,
        evidenceOrder: decision.evidenceOrder,
      },
      eventIds: eventsOf(reviewTask.taskId).map(event => event.eventId),
    });

    // Step 8：交付建议 + 来源 + 分歧处理 + 剩余不确定性。
    const stepDeliveryStart = Date.now();
    const remainingUncertainty = [
      verdict.raw && verdict.raw.uncertainty ? verdict.raw.uncertainty : '来源时间差异可能带来价格变化',
      parseWorkerJson(doneA).uncertainty,
    ];
    const delivery = artifactStore.persist({
      kind: 'delivery',
      taskId: reviewTask.taskId,
      content: {
        subject: '订阅价格',
        recommendation: {
          key: 'monthly_price',
          value: resolved.selectedCandidateRef === artA.id ? '$99' : '$129',
          basis: 'source_a_newer',
        },
        sources: [
          { id: srcA.id, url: sourceA.url, retrievedAt: sourceA.retrievedAt },
          { id: srcB.id, url: sourceB.url, retrievedAt: sourceB.retrievedAt },
        ],
        divergence: {
          conflictId: resolved.conflictId,
          candidateRefs: resolved.candidateRefs,
          selectedCandidateRef: resolved.selectedCandidateRef,
          resolutionMethod: resolved.resolutionMethod,
          rationale: resolved.rationale,
        },
        remainingUncertainty,
        // 来源已由 A1/B1 的 evidence 链覆盖；这里只引用两条结论，避免菱形重复
        // 让 resolveProvenance 的 visited 集合把「同一来源的二次到达」误判为环。
        evidence: [artA, artB].map(item => ({
          kind: item.kind,
          id: item.id,
          version: item.version,
        })),
      },
      provenanceRefs: [artA, artB].map(item => ({
        kind: item.kind,
        id: item.id,
        version: item.version,
      })),
      sourceLabels: ['review:adjudicated'],
    });
    const provenanceChain = artifactStore.resolveProvenance(delivery.id, { version: delivery.version });
    STEPS.push({
      step: 8,
      name: '交付建议 + 来源 + 分歧处理 + 剩余不确定性',
      startedAt: nowIso(),
      durationMs: Date.now() - stepDeliveryStart,
      deliveryRef: { kind: delivery.kind, id: delivery.id, version: delivery.version },
      provenanceChain,
      remainingUncertainty,
    });

    // Step 9：汇总 trace / 事件 / Token / 延迟 / 成本。
    // usage 落在任务 runs[]（每次 Run 的真实结算值）；task.result 只带终态投影。
    const usageOf = taskId => {
      const raw = tasks.getRawTask(taskId);
      if (!raw || !Array.isArray(raw.runs) || !raw.runs.length) return null;
      const run = raw.runs.find(item => item.runId === raw.runId) || raw.runs.at(-1);
      return (run && run.usage) || null;
    };
    const latencyOf = taskId => {
      const raw = tasks.getRawTask(taskId);
      const events = eventsOf(taskId);
      const completed = events.find(event => event.eventType === 'task.completed');
      if (!completed || !raw) return null;
      return Date.parse(completed.timestamp) - Date.parse(raw.createdAt);
    };
    const resolvedUsage = {
      workerA: usageOf(taskA.taskId) || providerUsage.workerA,
      workerB: usageOf(taskB.taskId) || providerUsage.workerB,
      reviewer: usageOf(reviewTask.taskId) || providerUsage.reviewer,
    };
    const usage = {
      runtimeUsage: {
        workerA: usageOf(taskA.taskId),
        workerB: usageOf(taskB.taskId),
        reviewer: usageOf(reviewTask.taskId),
      },
      providerUsage,
      resolved: resolvedUsage,
      totalTokens:
        (resolvedUsage.workerA ? resolvedUsage.workerA.total_tokens || 0 : 0) +
        (resolvedUsage.workerB ? resolvedUsage.workerB.total_tokens || 0 : 0) +
        (resolvedUsage.reviewer ? resolvedUsage.reviewer.total_tokens || 0 : 0),
      source: Object.values(resolvedUsage).some(Boolean) ? 'provider_reported' : '未采集',
    };
    const latencyMs = {
      workerA: latencyOf(taskA.taskId),
      workerB: latencyOf(taskB.taskId),
      reviewer: latencyOf(reviewTask.taskId),
    };
    STEPS.push({
      step: 9,
      name: '记录 trace / 事件 / Token / 延迟 / 成本',
      startedAt: nowIso(),
      durationMs: 0,
      traceId: TRACE_ID,
      eventIds: {
        workerA: eventSummary(taskA.taskId),
        workerB: eventSummary(taskB.taskId),
        reviewer: eventSummary(reviewTask.taskId),
      },
      usage,
      latencyMs,
      cost: '未采集',
      costReason: '本地 HTTP stub provider 无计价口径，不估算成本。',
    });
    const runRecord = {
      policyVersion: 'worked-example-v1',
      traceId: TRACE_ID,
      stepCount: STEPS.length,
      environment: {
        provider: 'local-http-stub',
        realModel: false,
        note: '非真实模型环境，仅验证链路与数据形态；Token 为 provider 返回的真实 usage。',
      },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAt,
      parallel,
      taskIds: {
        workerA: taskA.taskId,
        workerB: taskB.taskId,
        reviewer: reviewTask.taskId,
      },
      artifacts: {
        S1: artifactView(srcA),
        S2: artifactView(srcB),
        A1: artifactView(artA),
        B1: artifactView(artB),
        delivery: artifactView(delivery),
      },
      verification: {
        A1: { ok: verifyA.ok, errorCode: verifyA.errorCode },
        B1: { ok: verifyB.ok, errorCode: verifyB.errorCode },
      },
      conflict: STEPS[6].conflict,
      delivery: STEPS[7].deliveryRef,
      usage: {
        ...usage,
        cost: '未采集',
        costReason: '本地 HTTP stub provider 无计价口径，不估算成本。',
      },
      latencyMs,
      steps: STEPS,
      trace: {
        traceId: TRACE_ID,
        eventIds: {
          workerA: eventSummary(taskA.taskId),
          workerB: eventSummary(taskB.taskId),
          reviewer: eventSummary(reviewTask.taskId),
        },
      },
    };
    const out = argOf('--out');
    const text = JSON.stringify(runRecord, null, 2);
    if (out) {
      const target = path.resolve(out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      console.log(`[e2e] wrote ${target}`);
    } else {
      console.log(text);
    }
    return runRecord;
  } finally {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (!argOf('--data-dir') && !process.env.BLUEBIRD_KEEP_E2E_DATA) {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch (_) {
        // ignore
      }
    }
  }
}

function parseWorkerJson(task) {
  const text =
    task && task.result && typeof task.result.summary === 'string' ? task.result.summary : '';
  const parsed = JSON.parse(text);
  return parsed;
}

main()
  .then(record => {
    if (!record.parallel) {
      console.error('[e2e] 两个 Worker 未形成并行窗口');
      process.exitCode = 2;
    }
  })
  .catch(error => {
    console.error(`[e2e] failed: ${error.message}`);
    if (error && error.details) console.error(`[e2e] details: ${JSON.stringify(error.details)}`);
    if (error && error.stack) console.error(error.stack);
    process.exitCode = 2;
  });
