#!/usr/bin/env node
/* global __dirname, process */
/**
 * C-05（Orchestrator 立项书轮 5）：真实模型编排验收。
 *
 * 用 DeepSeek 内置 provider（api.deepseek.com，钥匙只从环境变量注入，不落盘）
 * 跑三轮主聊天：
 *   ① 复杂请求（期望模型产出 bluebird-plan 计划块 → 服务端编译 → 跨 Agent DAG
 *      → 根归约 → deliverPlanOutcome 回写父会话）；
 *   ② 直答对照（同样带编排开关，期望无计划块、直答路径零编排痕迹）；
 *   ③ 第二个复杂样本（带依赖的两步）。
 *
 * 采集口径（立项书：只留档不设门槛）：计划块产出率、编译通过率、编排终态、
 * 逐节点 usage/latency、根结果摘要。运行记录落 JSON（--out 只接受 docs/ 目录
 * 内的白名单文件名），失败也留记录（不用桩数据补位）。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=<key> node scripts/run-orchestration-acceptance.js --out docs/orchestration-acceptance-<date>.json
 * 钥匙严禁写入任何文件；本脚本只从 process.env.DEEPSEEK_API_KEY 读取。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function argOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const DATA_DIR = argOf('--data-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-c05-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_API_TOKEN = `c05-${crypto.randomUUID().slice(0, 8)}`;
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_AGENT_TASK_CONCURRENCY = '3';
process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '2';
process.env.BLUEBIRD_AGENT_REVIEW_WAIT_MS = '60000';
process.env.BLUEBIRD_MONITORING = '0';
process.env.PORT = '0';

if (!String(process.env.DEEPSEEK_API_KEY || '').trim()) {
  throw new Error('缺少 DEEPSEEK_API_KEY（应在进程环境注入，不落盘）');
}

const tasks = require('../server/agents/tasks');
const agentConfig = require('../server/agents/config');
const credentials = require('../server/agents/credentials');
const orchestrationEngine = require('../server/agents/orchestration-engine');
const { server } = require('../server/index.js');

const TOKEN = process.env.BLUEBIRD_API_TOKEN;
let BASE = null;

function nowIso() {
  return new Date().toISOString();
}

function authHeader() {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

// 自托管 fetch 必须带超时 + 一次重试：进程内 fetch 对自身端口可能无限挂起
// （真实运行中踩到过——服务端 3ms 可响应而脚本 fetch 永不返回）。
async function timedFetch(url, options = {}, timeoutMs = 30000) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('unreachable');
}

function post(path, body) {
  return timedFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify(body),
  }).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
}

function put(path, body) {
  return timedFetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: authHeader(),
    body: JSON.stringify({ policy: body }),
  }).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
}

async function waitFor(predicate, timeoutMs = 120000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

function usageOf(taskId) {
  const raw = tasks.getRawTask(taskId);
  if (!raw || !Array.isArray(raw.runs) || !raw.runs.length) return null;
  const run = raw.runs.find(item => item.runId === raw.runId) || raw.runs.at(-1);
  return (run && run.usage) || null;
}

function latencyOf(taskId) {
  const raw = tasks.getRawTask(taskId);
  if (!raw || !raw.completedAt || !raw.startedAt) return null;
  return Date.parse(raw.completedAt) - Date.parse(raw.startedAt);
}

/** 单轮验收：一条消息 → 回复/编排终态/逐节点采集。 */
async function runCase({ label, message, expectPlan }) {
  const startedAt = Date.now();
  const chat = await post('/chat', { message });
  if (chat.status !== 200) {
    return { label, error: `chat ${chat.status}`, detail: JSON.stringify(chat.json).slice(0, 300) };
  }
  const result = chat.json;
  const orchestration = result.orchestration || null;
  const record = {
    label,
    message,
    expectPlan,
    replyPreview: String(result.reply || '').slice(0, 400),
    replyHasPlanBlock: String(result.reply || '').includes('bluebird-plan'),
    orchestration: orchestration
      ? {
          planId: orchestration.planId,
          planVersion: orchestration.planVersion,
          nodeCount: orchestration.nodeCount,
          status: orchestration.status,
        }
      : null,
    chatLatencyMs: Date.now() - startedAt,
    usage: null,
    nodes: null,
    delivery: null,
  };

  if (!orchestration) return record;

  // 等编排终态（真实模型上限放宽到 5 分钟）。
  const finalRecord = await waitFor(() => {
    const current = orchestrationEngine.getOrchestration(orchestration.planId);
    return current && current.status !== 'running' ? current : null;
  }, 300000, 500);
  record.orchestration.finalStatus = finalRecord ? finalRecord.status : 'timeout';
  record.orchestration.pendingReason = finalRecord ? finalRecord.pendingReason || null : null;

  const planRead = require('../server/agents/plan-compiler').getCompiledPlan(orchestration.planId);
  record.compile = planRead
    ? { planVersion: planRead.planVersion, nodeCount: planRead.plan.steps.length }
    : null;

  const nodes = finalRecord ? Object.values(finalRecord.nodes) : [];
  record.nodes = nodes.map(node => {
    const task = tasks.getRawTask(node.taskId);
    return {
      taskType: node.taskType,
      agentId: node.agentId,
      status: task ? task.status : null,
      errorCode: task ? task.errorCode || null : null,
      usage: usageOf(node.taskId),
      latencyMs: latencyOf(node.taskId),
    };
  });
  const parentSessionId = finalRecord ? finalRecord.parentSessionId : null;
  if (parentSessionId) {
    const messages = require('../server/sessions').getMessages(parentSessionId);
    const rootMessage = messages.find(
      message => message.id === `bot-result-${orchestration.planId}`
    );
    record.delivery = rootMessage
      ? { messageId: rootMessage.id, contentPreview: String(rootMessage.content).slice(0, 500) }
      : null;
  }
  const totalTokens = record.nodes.reduce(
    (sum, node) => sum + (node.usage && node.usage.total_tokens ? node.usage.total_tokens : 0),
    0
  );
  record.usage = {
    perNode: record.nodes.map(node => node.usage),
    totalTokens: totalTokens || null,
    source: totalTokens ? 'provider_reported' : '未采集',
  };
  return record;
}

async function main() {
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;

  // 四 bot 启用并指向 DeepSeek 内置 provider（凭据条目是登记册 enabled 的硬门槛）。
  const { listManifests } = require('../server/agents/manifest');
  for (const manifest of listManifests()) {
    agentConfig.updateConfig(manifest.botId, {
      enabled: true,
      modelProfile: {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        temperature: 0.4,
        maxTokens: 1200,
        timeoutMs: 60000,
      },
    });
    const credential = credentials.putCredential({
      botId: manifest.botId,
      providerId: 'deepseek',
      apiKey: String(process.env.DEEPSEEK_API_KEY).trim(),
    });
    agentConfig.setCredentialId(manifest.botId, credential.credentialId);
  }

  // 编排开关开启（先取默认策略，再开编排开关；PUT 契约 = {policy}）。
  const current = await timedFetch(`${BASE}/agent-policy`, { headers: authHeader() }).then(r => r.json());
  const base = current.policy || current;
  // PUT /agent-policy 的契约是 {policy: <策略对象>}；POST 不存在（会 404）。
  const policy = await put('/agent-policy', {
    schemaVersion: 1,
    mode: base.mode || 'bounded_autonomy',
    planning: base.planning,
    tools: base.tools,
    budgets: base.budgets,
    orchestration: { enabled: true, maxNodes: 8 },
  });
  if (policy.status !== 200) {
    throw new Error(`开启编排开关失败：${JSON.stringify(policy.json)}`);
  }

  const steps = [];
  const runId = `c05_${crypto.randomUUID().slice(0, 8)}`;

  // ① 复杂请求：三件事可并行，期望计划块。
  steps.push(
    await runCase({
      label: 'complex_plan_expected',
      message:
        'acceptance-c05 请并行处理三件事：1）把「验收开始时间」记入记忆；2）检索我关于本机使用偏好的记忆；3）基于检索结果给出一份简短汇总。这是典型的多步骤任务，请按编排协议处理。',
      expectPlan: true,
    })
  );

  // ② 直答对照：简单问题，期望零编排痕迹。
  steps.push(
    await runCase({
      label: 'direct_answer_control',
      message: 'acceptance-c05 直答对照：用一句话回答 1 加 1 等于几。',
      expectPlan: false,
    })
  );

  // ③ 第二个复杂样本（带依赖的两步）。
  steps.push(
    await runCase({
      label: 'complex_plan_sample2',
      message:
        'acceptance-c05 第二个编排样本：先检索「验收」相关的记忆，再基于检索结果给出一份简短汇总。两步有先后依赖，请按编排协议处理。',
      expectPlan: true,
    })
  );

  const planCases = steps.filter(step => step.expectPlan);
  // 口径（2026-11-13 修正）：计划块「产出」以 compiled 为证——成功派发时服务端
  // 已剥块，最终回复里不含块是正确行为，在剥块后的 reply 上找块只会恒为 0。
  const planBlocks = planCases.filter(
    step => step.orchestration || step.replyHasPlanBlock
  ).length;
  const compiled = planCases.filter(step => step.orchestration).length;
  const completedOrchestrations = planCases.filter(
    step =>
      step.orchestration &&
      (step.orchestration.finalStatus === 'completed' ||
        step.orchestration.finalStatus === 'partial')
  ).length;
  const directCases = steps.filter(step => !step.expectPlan);
  const directClean = directCases.every(
    step => !step.orchestration && !step.replyHasPlanBlock
  );

  const record = {
    policyVersion: 'orchestration-acceptance-v1',
    runId,
    environment: {
      provider: 'deepseek（内置 provider，api.deepseek.com）',
      model: 'deepseek-chat',
      realModel: true,
      note: '钥匙经环境变量注入，不落盘；本脚本只从 process.env.DEEPSEEK_API_KEY 读取。',
    },
    startedAt: nowIso(),
    finishedAt: nowIso(),
    steps,
    metrics: {
      planCases: planCases.length,
      planBlockProduced: planBlocks,
      planBlockRate: planCases.length ? planBlocks / planCases.length : null,
      compiled,
      compiledRate: planCases.length ? compiled / planCases.length : null,
      orchestrationTerminal: completedOrchestrations,
      directClean,
      totalTokens:
        steps.reduce(
          (sum, step) =>
            sum + (step.usage && step.usage.totalTokens ? step.usage.totalTokens : 0),
          0
        ) || null,
    },
  };
  record.finishedAt = nowIso();

  const out = argOf('--out');
  const text = JSON.stringify(record, null, 2);
  if (out) {
    // 安全口径：只接受 docs/ 目录内的白名单文件名（basename），拒绝路径穿越。
    const docsRoot = path.resolve(__dirname, '..', 'docs');
    const base = path.basename(String(out));
    if (!/^orchestration-acceptance-[A-Za-z0-9._-]+\.json$/.test(base)) {
      throw new Error('--out 必须是 docs/ 下的 orchestration-acceptance-*.json 文件名');
    }
    const target = path.join(docsRoot, base);
    if (!target.startsWith(docsRoot + path.sep)) {
      throw new Error('--out 目标越界');
    }
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    console.log(`[c05] wrote ${target}`);
  } else {
    console.log(text);
  }
  console.log(
    `[c05] planBlock ${planBlocks}/${planCases.length} | compiled ${compiled}/${planCases.length} | terminal ${completedOrchestrations} | directClean ${directClean}`
  );
  return record;
}

if (require.main === module) {
  main()
    .then(() => {
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch (_) {
        // ignore
      }
      server.close(() => process.exit(0));
    })
    .catch(error => {
      console.error(`[c05] failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
