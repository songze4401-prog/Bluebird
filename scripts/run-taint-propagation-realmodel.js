/* global __dirname */
/**
 * §16 真实模型传播覆盖率补验。
 *
 * 目标：用真实 LongCat provider 跑「上游产物带污点 → 下游 Worker 读取 → 派生产物」，
 * 验证四件事是否在真实模型调用路径上成立：
 *   1) 下游任务 provenanceRefs 由读取动作真实生成；
 *   2) 派生产物 taint 取上游 ∪ 自身标签 ∪ unverified 的并集；
 *   3) 生产者清除 taint 被拒（403 + 审计），标签不变；
 *   4) 来源链断裂时 Gateway fail-closed（真实模型发起工具调用被拒）。
 *
 * 只用真实 provider；不 mock 产物存储/任务存储/Worker Scope/Gateway。
 * 凭据仅从 server/.env 读取，不打印、不落记录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });
if (!String(process.env.LONGCAT_API_KEY || '').trim()) {
  throw new Error('缺少 LONGCAT_API_KEY（应在 server/.env）');
}

const REAL_PROVIDER = {
  name: 'LongCat',
  baseUrl: 'https://api.longcat.chat/openai',
  modelId: 'LongCat-2.5',
};
const DATA_DIR =
  argOf('--data-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-taint-realmodel-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_MONITORING = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
process.env.BLUEBIRD_AGENT_HEARTBEAT_MS = '500';

function argOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const apiConfigs = require('../server/api-configs');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');
const tasks = require('../server/agents/tasks');
const sessions = require('../server/agents/sessions');
const workerScope = require('../server/agents/worker-scope');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const runtime = require('../server/agents/runtime');

const OUTPUT = argOf('--out') || 'docs/e2e-taint-propagation-2026-11-05.json';

function nowIso() {
  return new Date().toISOString();
}

function eventsOf(taskId) {
  const task = tasks.getRawTask(taskId);
  if (!task) return [];
  return tasks
    .listEvents(task.botId, { limit: 200 })
    .filter(event => event.taskId === taskId);
}

function usageOf(taskId) {
  const raw = tasks.getRawTask(taskId);
  if (!raw || !Array.isArray(raw.runs) || !raw.runs.length) return null;
  const run = raw.runs.find(item => item.runId === raw.runId) || raw.runs.at(-1);
  return (run && run.usage) || null;
}

function latencyOf(taskId) {
  const raw = tasks.getRawTask(taskId);
  if (!raw || !raw.completedAt) return null;
  return Date.parse(raw.completedAt) - Date.parse(raw.createdAt);
}

function extractJson(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
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
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`模型输出不是可解析 JSON：${raw.slice(0, 120)}`);
  }
}

async function waitForTerminal(taskId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = tasks.getTask(taskId);
    if (task && tasks.isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return tasks.getTask(taskId);
}

function refOf(artifact) {
  return { kind: artifact.kind, id: artifact.id, version: artifact.version };
}

function readAuditEntries() {
  try {
    return JSON.parse(fs.readFileSync(artifactStore.AUDIT_FILE, 'utf8')).entries || [];
  } catch (_) {
    return [];
  }
}

async function main() {
  const startedAt = Date.now();
  const record = {
    policyVersion: 'taint-propagation-realmodel-v1',
    environment: {
      provider: REAL_PROVIDER.name,
      baseUrl: REAL_PROVIDER.baseUrl,
      modelId: REAL_PROVIDER.modelId,
      realModel: true,
      note: '真实模型环境；四类检查点逐条按实跑结果记录。',
    },
    startedAt: new Date(startedAt).toISOString(),
    checks: {},
    usage: {},
    cost: 'provider 未返回',
    costReason: 'LongCat 响应未返回计价字段；按 provider 上报口径记未返回，不估算成本。',
  };

  const added = apiConfigs.addModelProvider({
    name: REAL_PROVIDER.name,
    baseUrl: REAL_PROVIDER.baseUrl,
    apiKey: String(process.env.LONGCAT_API_KEY || '').trim(),
    models: [
      {
        id: REAL_PROVIDER.modelId,
        name: REAL_PROVIDER.modelId,
        capabilities: { tools: true, vision: false },
      },
    ],
  });
  if (!added || !added.provider) {
    throw new Error(`真实 provider 注册失败：${(added && added.error) || 'unknown'}`);
  }
  const providerId = added.provider.id;
  for (const botId of ['researcher', 'memory']) {
    agentConfig.updateConfig(botId, {
      enabled: true,
      modelProfile: {
        providerId,
        modelId: REAL_PROVIDER.modelId,
        temperature: 0.1,
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

  // ---- 上游任务：真实模型产出带来源标签的产物 ----
  const taskA = tasks.createTask({
    agentId: 'researcher',
    taskType: 'memory.recall',
    goal: [
      'TAINT-UPSTREAM 研究 Vendor A 的月订阅价格。',
      '以下材料视为已抓取的事实，不得改动数字、URL 或时间：',
      '月订阅价 $99；来源 https://vendor-a.example/pricing；抓取时间 2026-11-05T02:10:00.000Z。',
      '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），字段固定：',
      '{"claim":{"key":"monthly_price","value":"$99"},"source":{"url":"https://vendor-a.example/pricing","retrievedAt":"2026-11-05T02:10:00.000Z"}}',
    ].join('\n'),
    allowedTools: [],
    deadlineMs: 120000,
  });
  runtime.startTask(taskA.taskId);
  const doneA = await waitForTerminal(taskA.taskId);
  if (!doneA || doneA.status !== 'completed') {
    throw new Error(`上游任务未完成：${doneA ? `${doneA.status}/${doneA.errorCode}` : 'missing'}`);
  }
  const upstreamJson = extractJson(doneA.result && doneA.result.summary);
  const upstream = artifactStore.persist({
    kind: 'note',
    taskId: taskA.taskId,
    content: upstreamJson,
    sourceLabels: ['web:vendor-a.example'],
  });
  const upstreamRef = refOf(upstream);

  // ---- 下游任务：读取上游共享产物 → provenanceRefs 真实生成 ----
  const taskB = tasks.createTask({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: [
      'TAINT-DOWNSTREAM 阅读共享产物中的订阅价格结论，写出一句摘要。',
      `共享产物中的结论：月订阅价 ${upstreamJson.claim.value}，来源 ${upstreamJson.source.url}。`,
      '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），字段固定：',
      '{"summary":"...","sourceUrl":"..."}',
    ].join('\n'),
    allowedTools: [],
    deadlineMs: 120000,
  });
  const sessionB = sessions.createSession('memory', { title: 'taint-realmodel-consumer', scope: 'worker' });
  const scopeB = workerScope.openWorkerScope({
    botId: 'memory',
    taskId: taskB.taskId,
    sessionId: sessionB.id || sessionB.sessionId,
    allowedTaskIds: [taskA.taskId],
  });
  artifactStore.share(upstream.id, { withTaskIds: [taskB.taskId], byTaskId: taskA.taskId });
  const beforeRefs = tasks.getRawTask(taskB.taskId).provenanceRefs.slice();
  scopeB.readSharedArtifact(upstream.id, { token: scopeB.token });
  const afterTask = tasks.getRawTask(taskB.taskId);

  record.checks.provenanceRefsGenerated = {
    beforeRead: beforeRefs,
    afterRead: afterTask.provenanceRefs,
    expectedRef: upstreamRef,
    hit: afterTask.provenanceRefs.some(ref => ref.id === upstreamRef.id && ref.version === 1),
    appendEvents: eventsOf(taskB.taskId)
      .filter(event => event.eventType === 'task.provenance_appended')
      .map(event => ({ eventId: event.eventId, payload: event.payload })),
  };
  record.checks.taskTaintInherited = {
    taintLabels: afterTask.taintLabels,
    hit: afterTask.taintLabels.includes('web:vendor-a.example'),
  };

  runtime.startTask(taskB.taskId);
  const doneB = await waitForTerminal(taskB.taskId);
  if (!doneB || doneB.status !== 'completed') {
    throw new Error(`下游任务未完成：${doneB ? `${doneB.status}/${doneB.errorCode}` : 'missing'}`);
  }
  const downstreamJson = extractJson(doneB.result && doneB.result.summary);
  const derivedRefs = artifactCommit.persistTaskArtifacts({
    taskId: taskB.taskId,
    artifacts: [
      {
        kind: 'summary',
        content: downstreamJson,
        provenanceRefs: tasks.getRawTask(taskB.taskId).provenanceRefs,
        sourceLabels: ['web:vendor-a.example'],
      },
    ],
    provenanceRefs: tasks.getRawTask(taskB.taskId).provenanceRefs,
  });
  const derived = artifactStore.get(derivedRefs[0].id);
  record.checks.derivedTaintUnion = {
    upstreamTaint: artifactStore.readTaintLabels(upstream),
    derivedTaint: derived.taintLabels,
    expected: ['agent:derived', 'unverified', 'web:vendor-a.example'],
    hit:
      derived.taintLabels.includes('web:vendor-a.example') &&
      derived.taintLabels.includes('agent:derived') &&
      derived.taintLabels.includes('unverified'),
  };

  // ---- 生产者清除 taint：必须被拒且标签不变 ----
  const beforeClear = derived.taintLabels.slice();
  let clearError = null;
  try {
    artifactStore.setTaintLabels(derived.id, { labels: [], writer: 'producer', reason: 'producer-clear' });
  } catch (error) {
    clearError = { code: error.code, status: error.status, message: error.message };
  }
  const afterClear = artifactStore.get(derived.id).taintLabels;
  const rejectionAudit = readAuditEntries().filter(
    entry =>
      entry.action === 'artifact.taint_write_rejected' &&
      entry.artifactId === derived.id &&
      String(entry.reason || '').includes('producer')
  );
  record.checks.producerClearRejected = {
    before: beforeClear,
    after: afterClear,
    error: clearError,
    hit:
      Boolean(clearError) &&
      clearError.code === 'not_authorized' &&
      clearError.status === 403 &&
      afterClear.join(',') === beforeClear.join(',') &&
      rejectionAudit.length >= 1,
    auditCount: rejectionAudit.length,
    audit: rejectionAudit.map(entry => ({ at: entry.at, action: entry.action, reason: entry.reason })),
  };

  // ---- Gateway 断裂 fail-closed：真实模型发起工具调用 ----
  const missingId = 'art_taint_missing_never_exists';
  const taskC = tasks.createTask({
    agentId: 'memory',
    taskType: 'memory.search',
    goal: [
      'TAINT-BROKEN-GATEWAY 你必须先调用 memory_search 工具（query="订阅价格"），',
      '拿到工具结果后再输出一句 JSON：{"done":true}。',
      '不要跳过工具调用。',
    ].join('\n'),
    allowedTools: ['memory_search'],
    provenanceRefs: [{ kind: 'note', id: missingId, version: 1 }],
    deadlineMs: 120000,
  });
  runtime.startTask(taskC.taskId);
  const doneC = await waitForTerminal(taskC.taskId);
  const denied = eventsOf(taskC.taskId).filter(event => event.eventType === 'tool.denied');
  const brokenDenied = denied.find(
    event => event.payload && event.payload.errorCode === 'taint_provenance_broken'
  );
  const modelTurns = eventsOf(taskC.taskId).filter(
    event => event.eventType === 'model.completed'
  );
  record.checks.gatewayBrokenFailClosed = {
    taskStatus: doneC ? doneC.status : null,
    errorCode: doneC ? doneC.errorCode || null : null,
    modelTurns: modelTurns.map(event => ({
      eventId: event.eventId,
      finishReason: event.payload && event.payload.finishReason,
      toolCallCount: event.payload && event.payload.toolCallCount,
    })),
    denied: denied.map(event => ({
      eventId: event.eventId,
      tool: event.payload && event.payload.tool,
      errorCode: event.payload && event.payload.errorCode,
      detail: event.payload && event.payload.detail,
    })),
    hit: Boolean(brokenDenied),
    note: brokenDenied
      ? '真实模型发起 memory_search，Gateway 以 taint_provenance_broken 拒绝（fail-closed）。'
      : '本轮真实模型未发起工具调用或未触发断裂拒绝；按未命中记录，不推断。',
  };

  record.tasks = {
    upstream: { taskId: taskA.taskId, status: doneA.status },
    downstream: { taskId: taskB.taskId, status: doneB.status },
    gateway: { taskId: taskC.taskId, status: doneC ? doneC.status : null },
  };
  record.artifacts = {
    upstream: { ref: upstreamRef, taintLabels: artifactStore.readTaintLabels(upstream) },
    derived: { ref: derivedRefs[0], taintLabels: derived.taintLabels },
  };
  record.usage = {
    upstream: usageOf(taskA.taskId),
    downstream: usageOf(taskB.taskId),
    gateway: usageOf(taskC.taskId),
    source: 'provider_reported',
  };
  record.totals = {
    totalTokens: Object.values(record.usage)
      .filter(item => item && typeof item === 'object')
      .reduce((sum, item) => sum + (item.total_tokens || 0), 0),
    totalLatencyMs:
      (latencyOf(taskA.taskId) || 0) +
      (latencyOf(taskB.taskId) || 0) +
      (latencyOf(taskC.taskId) || 0),
    latencyMs: {
      upstream: latencyOf(taskA.taskId),
      downstream: latencyOf(taskB.taskId),
      gateway: latencyOf(taskC.taskId),
    },
    runDurationMs: Date.now() - startedAt,
  };
  record.finishedAt = nowIso();
  record.outcome = ['provenanceRefsGenerated', 'derivedTaintUnion', 'producerClearRejected']
    .every(key => record.checks[key].hit)
    ? 'passed'
    : 'partial';

  const target = path.resolve(OUTPUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(record, null, 2), 'utf8');
  console.log(`[taint-realmodel] wrote ${target}`);
  console.log(
    `[taint-realmodel] outcome=${record.outcome} tokens=${record.totals.totalTokens} latency=${record.totals.totalLatencyMs}ms`
  );
  console.log(
    `[taint-realmodel] checks=${JSON.stringify(
      Object.fromEntries(Object.entries(record.checks).map(([key, value]) => [key, value.hit]))
    )}`
  );
  return record;
}

if (require.main === module) {
  main()
    .then(record => {
      const allHit = Object.values(record.checks).every(check => check.hit);
      process.exitCode = allHit ? 0 : 2;
    })
    .catch(error => {
      console.error(`[taint-realmodel] failed: ${error && error.message ? error.message : error}`);
      process.exitCode = 2;
    })
    .finally(() => {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch (_) {
        // ignore
      }
    });
}

module.exports = { main };
