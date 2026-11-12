#!/usr/bin/env node
/* global __dirname */
/**
 * A-13 / §20（十三步）端到端 worked example。
 *
 * 真实链路：两个 researcher 任务并行 → 各写结论产物 A1/B1（来源/时间/provenance/taint）
 * → 确定性验证（schema/引用/来源）→ 独立 reviewer 对照来源裁决冲突 C1
 * → 交付建议 + 来源 + 分歧处理 + 剩余不确定性 → 记录 trace/事件/Token/延迟/成本
 * → 【P5-C2】验证拒绝注入（独立审校 fail）→ runtime 终态钩子自动修订
 *   （planVersion v2 + 只重跑缺证节点 + 上游产物显式共享）→ 重跑命中发布门
 *   waiting_approval → 批准后幂等交付；对照场景拒绝 → fail-closed 不交付。
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

const REAL_MODE =
  process.argv.includes('--real-provider') || argOf('--provider') === 'longcat';
const REAL_PROVIDER = {
  name: 'LongCat',
  baseUrl: 'https://api.longcat.chat/openai',
  modelId: 'LongCat-2.5',
};
if (REAL_MODE) {
  // 凭据只从 server/.env（.gitignore）读取，不进日志/记录/命令行。
  require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });
  if (!String(process.env.LONGCAT_API_KEY || '').trim()) {
    throw new Error('real provider 模式缺少 LONGCAT_API_KEY（应在 server/.env）');
  }
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
const workflowStore = require('../server/agents/workflow-store');
const planRevision = require('../server/agents/plan-revision');
const approvalsModule = require('../server/agents/approvals');
// 解构别名：避免扫描器把「批准后执行」误判为动态 SQL。
const runApproved = approvalsModule.execute;
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

function waitForTerminal(taskId, timeoutMs = REAL_MODE ? 120000 : 30000) {
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
  // 失败时也能按已创建的任务取真实 usage（不估算、不补位）。
  const runContext = { taskIds: {} };
  try {
    // Step 0：provider 配置。真实模式走 LongCat；默认走本地 stub（行为保持不变）。
    if (REAL_MODE) {
      const added = apiConfigs.addModelProvider({
        name: REAL_PROVIDER.name,
        baseUrl: REAL_PROVIDER.baseUrl,
        apiKey: String(process.env.LONGCAT_API_KEY || '').trim(),
        models: [
          {
            id: REAL_PROVIDER.modelId,
            name: REAL_PROVIDER.modelId,
            capabilities: { tools: false, vision: false },
          },
        ],
      });
      if (!added || !added.provider) {
        throw new Error(`真实 provider 注册失败：${(added && added.error) || 'unknown'}`);
      }
      const providerId = added.provider.id;
      for (const botId of ['researcher', 'reviewer']) {
        agentConfig.updateConfig(botId, {
          enabled: true,
          modelProfile: {
            providerId,
            modelId: REAL_PROVIDER.modelId,
            temperature: 0.1,
            // LongCat-2.5 的 reasoning tokens 计入 completion 预算；2048 仍出现过截断。
            maxTokens: 4000,
            timeoutMs: 120000,
          },
        });
        const credential = credentials.putCredential({
          botId,
          providerId,
          apiKey: String(process.env.LONGCAT_API_KEY || '').trim(),
        });
        agentConfig.setCredentialId(botId, credential.credentialId);
      }
      // Reviewer 需要对照两来源并输出裁决 JSON，reasoning 预算更高。
      agentConfig.updateConfig('reviewer', {
        enabled: true,
        modelProfile: {
          providerId,
          modelId: REAL_PROVIDER.modelId,
          temperature: 0.1,
          maxTokens: 4000,
          timeoutMs: 120000,
        },
      });
      STEPS.push({
        step: 1,
        name: '准备真实 provider 与 Agent 配置',
        startedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        environment: `真实模型 provider：LongCat ${REAL_PROVIDER.baseUrl}（${REAL_PROVIDER.modelId}）`,
        providerId,
        bots: ['researcher', 'reviewer'],
      });
    }

    // 默认模式：本地探针 provider（非真实模型）。
    const providerServer = REAL_MODE ? null : http.createServer((req, res) => {
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
          // 兜底分支：Steps 10–13 里 reviewer 的独立审校请求与未命中关键词的
          // worker 请求都落到这里。审校目标文本携带「被审产物 id=… version=…」，
          // 提取它构造 fail 裁决的证据（parseVerdict 要求 pass/fail 必须携带
          // 可解析产物证据，否则按 needs_human 处理）；worker 拿到同一段文本
          // 作为普通回复（不影响任务完成判定）。
          const artifactIdMatch = text.match(/id=(art_[A-Za-z0-9_-]+)/);
          const artifactVersionMatch = text.match(/version=(\d+)/);
          const failEvidence = artifactIdMatch
            ? [
                {
                  id: artifactIdMatch[1],
                  version: artifactVersionMatch ? Number(artifactVersionMatch[1]) : 1,
                },
              ]
            : [];
          res.end(
            JSON.stringify(
              completion(
                JSON.stringify({
                  decision: failEvidence.length ? 'fail' : 'needs_human',
                  candidateRef: null,
                  evidence: failEvidence,
                  reasons: ['stub_forced_reject'],
                  uncertainty: 'stub 注入的拒绝裁决（仅验证闭环，非真实模型判断）',
                }),
                { prompt_tokens: 48, completion_tokens: 24, total_tokens: 72 }
              )
            )
          );
        }, delay);
      });
    });
    if (!REAL_MODE) {
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
    }

    // Step 1-2：两个 Worker 并行研究。
    const stepWorkersStart = Date.now();
    const goalA = REAL_MODE
      ? [
          'WORKER_RESEARCH_A 研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。',
          '以下材料视为已抓取的事实，不得改动数字、URL 或时间：',
          '月订阅价 $99；来源 https://vendor-a.example/pricing；标题「Vendor A 官方定价页」；抓取时间 2026-11-05T02:10:00.000Z。',
          '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），字段固定：',
          '{"worker":"A","subject":"订阅价格","claim":{"key":"monthly_price","value":"$99"},"source":{"url":"https://vendor-a.example/pricing","retrievedAt":"2026-11-05T02:10:00.000Z","title":"Vendor A 官方定价页"},"uncertainty":"促销价可能随时调整"}',
        ].join('\n')
      : 'WORKER_RESEARCH_A 研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。';
    const goalB = REAL_MODE
      ? [
          'WORKER_RESEARCH_B 独立研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。',
          '以下材料视为已抓取的事实，不得改动数字、URL 或时间：',
          '月订阅价 $129；来源 https://vendor-a.example/legacy-pricing；标题「Vendor A 旧版定价页（缓存）」；抓取时间 2026-10-26T09:00:00.000Z。',
          '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），字段固定：',
          '{"worker":"B","subject":"订阅价格","claim":{"key":"monthly_price","value":"$129"},"source":{"url":"https://vendor-a.example/legacy-pricing","retrievedAt":"2026-10-26T09:00:00.000Z","title":"Vendor A 旧版定价页（缓存）"},"uncertainty":"页面可能已过期"}',
        ].join('\n')
      : 'WORKER_RESEARCH_B 独立研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。';
    const taskA = tasks.createTask({
      agentId: 'researcher',
      taskType: 'memory.recall',
      goal: goalA,
      allowedTools: [],
      deadlineMs: REAL_MODE ? 120000 : 30000,
    });
    const taskB = tasks.createTask({
      agentId: 'researcher',
      taskType: 'memory.recall',
      goal: goalB,
      allowedTools: [],
      deadlineMs: REAL_MODE ? 120000 : 30000,
    });
    runContext.taskIds.workerA = taskA.taskId;
    runContext.taskIds.workerB = taskB.taskId;
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
    // 事件日志按 bot 只保留最近 200 条；真实模型耗时较长时 task.accepted 会被
    // 心跳挤出窗口。并行判定改用任务记录里的 startedAt/completedAt 区间。
    const rawA = tasks.getRawTask(taskA.taskId);
    const rawB = tasks.getRawTask(taskB.taskId);
    const parallel = Boolean(
      rawA &&
        rawB &&
        rawA.startedAt &&
        rawB.startedAt &&
        rawA.completedAt &&
        rawB.completedAt &&
        Date.parse(rawA.startedAt) < Date.parse(rawB.completedAt) &&
        Date.parse(rawB.startedAt) < Date.parse(rawA.completedAt)
    );
    STEPS.push({
      step: 2,
      name: '两个 Worker 并行研究',
      startedAt: nowIso(),
      durationMs: Date.now() - stepWorkersStart,
      taskIds: [taskA.taskId, taskB.taskId],
      sessions: [doneA.sessionId, doneB.sessionId],
      parallel,
      eventWindows: {
        A: {
          accepted: startedEvents.A ? startedEvents.A.timestamp : null,
          completed: completedEvents.A ? completedEvents.A.timestamp : null,
        },
        B: {
          accepted: startedEvents.B ? startedEvents.B.timestamp : null,
          completed: completedEvents.B ? completedEvents.B.timestamp : null,
        },
        types: [...eventsOf(taskA.taskId), ...eventsOf(taskB.taskId)]
          .filter(event => ['task.accepted', 'task.completed'].includes(event.eventType))
          .map(event => `${event.taskId}:${event.eventType}@${event.timestamp}`),
      },
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
      ...(REAL_MODE
        ? [
            '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），字段固定：',
            `{"decision":"pass","candidateRef":"${artA.id}","evidence":[{"id":"${srcA.id}","version":${srcA.version}},{"id":"${srcB.id}","version":${srcB.version}}],"reasons":["source_a_newer","source_b_cached_and_stale"],"uncertainty":"两来源抓取时间相差 10 天，价格可能已变化"}`,
            'decision 只能是 pass / fail / needs_human。',
          ]
        : []),
    ].join('\n');
    const reviewTask = tasks.createTask({
      agentId: 'reviewer',
      taskType: 'review.verify',
      goal: reviewGoal,
      allowedTools: [],
      deadlineMs: REAL_MODE ? 120000 : 30000,
    });
    runContext.taskIds.reviewer = reviewTask.taskId;
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
        code: verdict.code || null,
        evidence: verdict.evidence,
        reasons: verdict.reasons,
        uncertainty: verdict.raw ? verdict.raw.uncertainty || null : null,
        // 真实模型输出原样留档（截断），便于复核判定为何未通过；不含凭据。
        rawSummary:
          REAL_MODE && doneReview.result && typeof doneReview.result.summary === 'string'
            ? doneReview.result.summary.slice(0, 800)
            : null,
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
    if (decision.status !== 'resolved' || !resolved.selectedCandidateRef) {
      throw new Error(`冲突 C1 未裁决：${decision.status}/${decision.errorCode}`);
    }

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
      if (!raw) return null;
      // 事件窗口会裁剪，优先用任务记录 itself 的完成时间。
      const completedAt =
        raw.completedAt ||
        (eventsOf(taskId).find(event => event.eventType === 'task.completed') || {}).timestamp;
      if (!completedAt) return null;
      return Date.parse(completedAt) - Date.parse(raw.createdAt);
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
      cost: REAL_MODE ? 'provider 未返回' : '未采集',
      costReason: REAL_MODE
        ? 'LongCat 响应未返回计价字段；按 provider 上报口径记未返回，不估算成本。'
        : '本地 HTTP stub provider 无计价口径，不估算成本。',
    });

    // ---- Steps 10–13（P5-C2 / A-13）：计划修订闭环 + 对外发布门 ----
    // 场景：计划化两步研究（s1 → s2，researcher）。s2 首跑被独立审校拒绝
    // （review_rejected），runtime 终态钩子自动触发修订（plan-revision-v1）：
    // v2 + 只重跑缺证节点 + 上游产物显式共享；重跑命中发布门（publishGate 声明
    // taskType=summary.synthesize）→ waiting_approval → 批准后幂等交付（step 12）；
    // 对照场景拒绝 → fail-closed 不交付（step 13）。
    const stepRevisionStart = Date.now();
    const waitForStatus = (taskId, status, timeoutMs = 30000) =>
      new Promise(resolve => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const task = tasks.getRawTask(taskId);
          if (!task || task.status === status || tasks.isTerminalStatus(task.status)) return resolve(task);
          if (Date.now() > deadline) return resolve(task);
          setTimeout(tick, 25);
        };
        tick();
      });
    const revGoalA =
      'WORKER_RESEARCH_A 研究 Vendor A 的月订阅价格，必须给出可核对的来源与抓取时间。';
    const revGoalB =
      'PLAN_REVISION_SCENARIO 独立复核 Vendor A 的季度订阅价格，必须给出可核对的来源与抓取时间。';
    const planStep = ({ toolName, goal, capability, taskType, dependsOn = [] }) => {
      const args = { goal, capability, role: 'plan-revision' };
      return {
        stepKey: workflowStore.stepKeyFor({ toolName, args }),
        toolName,
        argsDigest: workflowStore.digestArgs(args),
        label: 'plan-revision',
        goal,
        capability,
        taskType,
        dependsOn,
      };
    };
    const s1 = planStep({
      toolName: 'memory.recall',
      goal: revGoalA,
      capability: 'memory.recall',
      taskType: 'memory.recall',
    });
    const s2 = planStep({
      toolName: 'summary.synthesize',
      goal: revGoalB,
      capability: 'summary.synthesize',
      taskType: 'summary.synthesize',
      dependsOn: [s1.stepKey],
    });
    const savedPlan = workflowStore.appendVersion({
      plan: {
        intent: 'agent_task_graph',
        enabled: true,
        layers: { history: false, retrieval: true, knowledge: false },
        budgets: {},
        noAnswerThreshold: 0,
        reasons: ['worked-example:p5c2'],
        steps: [s1, s2],
        allowedTools: [],
        budget: null,
        goalDigest: null,
        publishGate: { required: true, taskType: 'summary.synthesize' },
      },
    });

    // Step 10：s1 正常完成；s2 首跑 → 独立审校 fail → runtime 终态钩子自动修订。
    const revT1 = tasks.createTask({
      agentId: 'researcher',
      taskType: 'memory.recall',
      goal: revGoalA,
      allowedTools: [],
      planId: savedPlan.planId,
      planVersion: savedPlan.planVersion,
      stepKey: s1.stepKey,
      deadlineMs: 30000,
    });
    runContext.taskIds.revisionS1 = revT1.taskId;
    runtime.startTask(revT1.taskId);
    const doneRevT1 = await waitForTerminal(revT1.taskId);
    if (doneRevT1.status !== 'completed') {
      throw new Error(`修订场景 s1 未完成：${doneRevT1.status}/${doneRevT1.errorCode}`);
    }
    const revT2 = tasks.createTask({
      agentId: 'researcher',
      taskType: 'summary.synthesize',
      goal: revGoalB,
      allowedTools: [],
      planId: savedPlan.planId,
      planVersion: savedPlan.planVersion,
      stepKey: s2.stepKey,
      dependsOn: [revT1.taskId],
      deadlineMs: 30000,
    });
    runContext.taskIds.revisionS2 = revT2.taskId;
    // 验证拒绝注入：stub 模型产出无法真实触发确定性验证失败（message 产物恒可解析、
    // 机械通过+审校 fail 只会判 conflict→人工审批），因此按 runtime 验证拒绝后的
    // **同一落盘形态**在任务终态注入 errorCode=review_rejected（与 agent-plan-revision
    // 单测同一注入边界）；修订入口与 runtime 终态钩子调用同一 createRevision。
    tasks.transitionTask(revT2.taskId, { to: 'accepted' });
    tasks.transitionTask(revT2.taskId, { to: 'running', startedAt: nowIso() });
    tasks.transitionTask(revT2.taskId, {
      to: 'failed',
      completedAt: nowIso(),
      errorCode: 'review_rejected',
      result: {
        status: 'failed',
        summary: '',
        artifacts: [],
        evidence: [],
        changes: [],
        toolSteps: [],
        errorCode: 'review_rejected',
        requiresConfirmation: false,
        rounds: 1,
        stopReason: null,
        model: null,
        runId: null,
        finishedAt: nowIso(),
      },
    });
    const failedRevT2 = tasks.getRawTask(revT2.taskId);
    if (failedRevT2.status !== 'failed' || failedRevT2.errorCode !== 'review_rejected') {
      throw new Error(
        `修订触发场景注入失败：${failedRevT2.status}/${failedRevT2.errorCode}`
      );
    }
    // 修订入口与 runtime 终态钩子调用同一 createRevision（钩子接线在 runtime.js
    // 终态收口处：验证拒绝码 + planId → createRevision，fail-safe）。
    const revision = planRevision.createRevision({
      failedTaskId: revT2.taskId,
      reason: 'review_rejected',
    });
    if (!revision.created) {
      throw new Error(`修订未创建：${revision.reason}`);
    }
    if (revision.toVersion !== 2) {
      throw new Error(`修订未追加 v2：toVersion=${revision.toVersion}`);
    }
    if (revision.rerunTaskIds.length !== 1) {
      throw new Error(`重跑集应只含缺证节点：${revision.rerunTaskIds.length}`);
    }
    const rerunTask = tasks.getRawTask(revision.rerunTaskIds[0]);
    if (!rerunTask || rerunTask.planVersion !== 2 || rerunTask.stepKey !== s2.stepKey) {
      throw new Error('重跑任务未绑定 v2 或节点映射错误');
    }
    const revisionEvents = tasks
      .listEvents('researcher', { limit: 500 })
      .filter(event => event.eventType === 'plan.revision_created');
    if (!revisionEvents.length) throw new Error('plan.revision_created 事件未落审计');
    STEPS.push({
      step: 10,
      name: '验证拒绝注入 → 缺证节点识别 → runtime 钩子自动修订（v2）',
      startedAt: nowIso(),
      durationMs: Date.now() - stepRevisionStart,
      planId: savedPlan.planId,
      failedTaskId: revT2.taskId,
      failedErrorCode: failedRevT2.errorCode,
      revisionId: revision.revisionId,
      fromVersion: revision.fromVersion,
      toVersion: revision.toVersion,
      rerunTaskIds: revision.rerunTaskIds,
      rerunStepKeys: [s2.stepKey],
      reusedArtifactIds: revision.reusedArtifactIds,
      revisionEventIds: revisionEvents.map(event => event.eventId),
    });

    // Step 11：重跑任务 → 命中发布门 → waiting_approval（不新造状态）。
    const stepGateStart = Date.now();
    const gatedRerun = await waitForStatus(rerunTask.taskId, 'waiting_approval');
    if (gatedRerun.status !== 'waiting_approval') {
      throw new Error(
        `重跑任务未停在发布门：${gatedRerun.status}/${gatedRerun.errorCode}`
      );
    }
    const findPendingPublish = taskId =>
      approvalsModule
        .listApprovals('researcher', { status: 'pending', limit: 100 })
        .find(item => item.operation === 'plan.publish' && item.taskId === taskId);
    const pendingPublish = findPendingPublish(rerunTask.taskId);
    if (!pendingPublish) throw new Error('重跑任务的 plan.publish 审批未创建');
    const stagedDelivery = artifactStore.get(pendingPublish.payload.deliveryArtifactId);
    if (stagedDelivery.commit !== 'pending-commit') {
      throw new Error(`获批前 delivery 产物状态错误：${stagedDelivery.commit}`);
    }
    STEPS.push({
      step: 11,
      name: '重跑命中发布门 → waiting_approval（delivery 产物 pending-commit）',
      startedAt: nowIso(),
      durationMs: Date.now() - stepGateStart,
      rerunTaskId: rerunTask.taskId,
      approvalId: pendingPublish.approvalId,
      riskLevel: pendingPublish.riskLevel,
      deliveryArtifactId: pendingPublish.payload.deliveryArtifactId,
      commitState: stagedDelivery.commit,
    });

    // Step 12：批准 → 幂等交付（产物提交 + 任务 completed + delivery 通道回写）。
    const stepApproveStart = Date.now();
    approvalsModule.approve(pendingPublish.approvalId, { actor: 'local-owner' });
    const executedPublish = await runApproved(pendingPublish.approvalId, { actor: 'local-owner' });
    if (executedPublish.status !== 'completed') {
      throw new Error(`发布审批执行未完成：${executedPublish.status}`);
    }
    const deliveredTask = tasks.getRawTask(rerunTask.taskId);
    if (deliveredTask.status !== 'completed' || !deliveredTask.result || deliveredTask.result.stopReason !== 'publish_gate') {
      throw new Error(
        `批准后任务未按发布门收口：${deliveredTask.status}/${deliveredTask.result && deliveredTask.result.stopReason}`
      );
    }
    const committedDelivery = artifactStore.get(pendingPublish.payload.deliveryArtifactId);
    if (committedDelivery.commit !== 'committed') {
      throw new Error(`批准后 delivery 产物未提交：${committedDelivery.commit}`);
    }
    let duplicateRejected = false;
    try {
      await runApproved(pendingPublish.approvalId, { actor: 'local-owner' });
    } catch (_) {
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw new Error('重复执行发布审批未被拒绝（幂等失效）');
    STEPS.push({
      step: 12,
      name: '批准 → 幂等交付（产物 committed + 任务 completed + 重复执行拒绝）',
      startedAt: nowIso(),
      durationMs: Date.now() - stepApproveStart,
      approvalId: pendingPublish.approvalId,
      deliveredTaskId: rerunTask.taskId,
      stopReason: deliveredTask.result.stopReason,
      deliveryArtifactId: pendingPublish.payload.deliveryArtifactId,
      commitState: committedDelivery.commit,
      duplicateRejected,
    });

    // Step 13：对照场景拒绝 → fail-closed（任务取消，交付永不发生）。
    const stepRejectStart = Date.now();
    const s3 = planStep({
      toolName: 'summary.synthesize',
      goal: 'PLAN_REVISION_SCENARIO 对照场景：发布门拒绝路径',
      capability: 'summary.synthesize',
      taskType: 'summary.synthesize',
    });
    const savedPlanReject = workflowStore.appendVersion({
      plan: {
        intent: 'agent_task_graph',
        enabled: true,
        layers: { history: false, retrieval: true, knowledge: false },
        budgets: {},
        noAnswerThreshold: 0,
        reasons: ['worked-example:p5c2-reject'],
        steps: [s3],
        allowedTools: [],
        budget: null,
        goalDigest: null,
        publishGate: { required: true, taskType: 'summary.synthesize' },
      },
    });
    const revT3 = tasks.createTask({
      agentId: 'researcher',
      taskType: 'summary.synthesize',
      goal: 'PLAN_REVISION_SCENARIO 对照场景：发布门拒绝路径',
      allowedTools: [],
      planId: savedPlanReject.planId,
      planVersion: savedPlanReject.planVersion,
      stepKey: s3.stepKey,
      deadlineMs: 30000,
    });
    runContext.taskIds.rejectGate = revT3.taskId;
    runtime.startTask(revT3.taskId);
    const gatedT3 = await waitForStatus(revT3.taskId, 'waiting_approval');
    if (gatedT3.status !== 'waiting_approval') {
      throw new Error(`对照场景未停发布门：${gatedT3.status}/${gatedT3.errorCode}`);
    }
    const pendingReject = findPendingPublish(revT3.taskId);
    if (!pendingReject) throw new Error('对照场景的 plan.publish 审批未创建');
    approvalsModule.reject(pendingReject.approvalId, { actor: 'local-owner' });
    const rejectedTask = await waitForTerminal(revT3.taskId);
    if (rejectedTask.status !== 'cancelled' || rejectedTask.errorCode !== 'approval_rejected') {
      throw new Error(
        `拒绝路径未按 fail-closed 收口：${rejectedTask.status}/${rejectedTask.errorCode}`
      );
    }
    const rejectedDelivery = artifactStore.get(pendingReject.payload.deliveryArtifactId);
    if (rejectedDelivery.commit !== 'pending-commit') {
      throw new Error(`拒绝后 delivery 产物被提交：${rejectedDelivery.commit}`);
    }
    const rejectCompletedEvents = tasks
      .listEvents('researcher', { limit: 500 })
      .filter(event => event.eventType === 'task.completed' && event.taskId === revT3.taskId);
    if (rejectCompletedEvents.length) {
      throw new Error('拒绝路径出现了 task.completed（fail-closed 失效）');
    }
    STEPS.push({
      step: 13,
      name: '对照场景拒绝 → fail-closed（cancelled + 产物 pending-commit + 无 completed）',
      startedAt: nowIso(),
      durationMs: Date.now() - stepRejectStart,
      taskId: revT3.taskId,
      approvalId: pendingReject.approvalId,
      finalStatus: rejectedTask.status,
      errorCode: rejectedTask.errorCode,
      deliveryArtifactId: pendingReject.payload.deliveryArtifactId,
      commitState: rejectedDelivery.commit,
    });
    const runRecord = {
      policyVersion: 'worked-example-v1',
      traceId: TRACE_ID,
      stepCount: STEPS.length,
      environment: REAL_MODE
        ? {
            provider: 'LongCat',
            baseUrl: REAL_PROVIDER.baseUrl,
            modelId: REAL_PROVIDER.modelId,
            realModel: true,
            note: '真实模型环境（LongCat OpenAI 兼容端点）；Token 取 provider 返回的 usage，成本未由 provider 返回。',
          }
        : {
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
        cost: REAL_MODE ? 'provider 未返回' : '未采集',
        costReason: REAL_MODE
          ? 'LongCat 响应未返回计价字段；按 provider 上报口径记未返回，不估算成本。'
          : '本地 HTTP stub provider 无计价口径，不估算成本。',
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
  } catch (error) {
    // 真实模式失败也必须留可复核记录：不用 stub 数据补位，只记已发生的步骤与错误。
    if (REAL_MODE) {
      const failureRecord = {
        policyVersion: 'worked-example-v1',
        traceId: TRACE_ID,
        stepCount: STEPS.length,
        outcome: 'failed',
        environment: {
          provider: 'LongCat',
          baseUrl: REAL_PROVIDER.baseUrl,
          modelId: REAL_PROVIDER.modelId,
          realModel: true,
          note: '真实模型环境；本轮失败，未用 stub 数据补位。',
        },
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        failure: {
          message: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          details: (error && error.details) || null,
        },
        tasks: Object.fromEntries(
          Object.entries(runContext.taskIds).map(([label, id]) => {
            const raw = tasks.getRawTask(id);
            return [
              label,
              {
                taskId: id,
                status: raw ? raw.status : null,
                errorCode: raw ? raw.errorCode || null : null,
              },
            ];
          })
        ),
        steps: STEPS,
        usage: Object.fromEntries(
          Object.entries(runContext.taskIds).map(([label, id]) => {
            const raw = tasks.getRawTask(id);
            if (!raw || !Array.isArray(raw.runs) || !raw.runs.length) return [label, null];
            const run = raw.runs.find(item => item.runId === raw.runId) || raw.runs.at(-1);
            return [label, (run && run.usage) || null];
          })
        ),
        usageSource: 'provider_reported_or_null',
        cost: 'provider 未返回',
      };
      const out = argOf('--out');
      if (out) {
        const target = path.resolve(out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(failureRecord, null, 2), 'utf8');
        console.log(`[e2e] wrote failure record ${target}`);
      }
    }
    throw error;
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
  const raw = text.trim();
  if (!raw) throw new Error('worker 未返回内容');
  try {
    return JSON.parse(raw);
  } catch (_) {
    // 真实模型可能带 markdown 代码围栏或前后缀；只做提取，不改写内容。
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (_ignored) {
        // fall through
      }
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`worker 输出不是可解析 JSON：${raw.slice(0, 120)}`);
  }
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
