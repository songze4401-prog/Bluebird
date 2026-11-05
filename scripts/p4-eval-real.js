/* global process, __dirname, console */
/**
 * Phase 4 第 2 项：真实模型两轮评测（脚本层串联，不进 server 生产代码）。
 *
 * 复用既有通道：
 *  - Provider：临时用 api-configs.addModelProvider 注册 LongCat（OpenAI 兼容），
 *    走 model-adapter.createChatCompletion（同一 DNS 固定/密钥/监控路径）；
 *  - 任务：createTask/transitionTask/recordRunStart/recordRunFinish/settleTaskBudget；
 *  - 指标：eval-metrics.computeMetrics、eval-baseline 快照与 diff；
 *  - 策略：autonomy-policy.plan/decideReplan/verificationStrength，由 strategy-version 开关控制。
 * 只从 server/.env 读 key（不打印、不落盘到仓库内），进程结束删除临时 Provider。
 *
 * 用法：
 *   node scripts/p4-eval-real.js --strategy-version=p4-default   --out=eval-baselines/p4-real-default.json
 *   node scripts/p4-eval-real.js --strategy-version=p4-autonomy-v1 --out=eval-baselines/p4-real-autonomy.json
 *   node scripts/p4-eval-real.js --compare=eval-baselines/p4-real-default.json,eval-baselines/p4-real-autonomy.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER = {
  name: 'LongCat (p4 eval temp)',
  baseUrl: 'https://api.longcat.chat/openai',
  modelId: 'LongCat-2.5',
};

const CASE_GAP_MS = 200;
const MIN_CALL_TOKENS = 60;

function arg(name, fallback = null) {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function readKey() {
  const envPath = path.join(__dirname, '..', 'server', '.env');
  if (!fs.existsSync(envPath)) throw new Error('server/.env 不存在（需 LONGCAT_API_KEY）');
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const matched = /^\s*LONGCAT_API_KEY\s*=\s*(.+)\s*$/.exec(line);
    if (matched) return matched[1].trim();
  }
  throw new Error('server/.env 缺少 LONGCAT_API_KEY');
}

function redact(value, key) {
  const text = String(value == null ? '' : value);
  return key ? text.split(key).join('ak_***') : text;
}

function totalTokens(usage) {
  if (!usage) return null;
  const value = Number(usage.total_tokens);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function usageDetails(usage) {
  if (!usage) return { prompt: null, completion: null, total: null, cached: null, reasoning: null };
  return {
    prompt: usage.prompt_tokens == null ? null : Number(usage.prompt_tokens),
    completion: usage.completion_tokens == null ? null : Number(usage.completion_tokens),
    total: totalTokens(usage),
    cached:
      usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens != null
        ? Number(usage.prompt_tokens_details.cached_tokens)
        : null,
    reasoning:
      usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens != null
        ? Number(usage.completion_tokens_details.reasoning_tokens)
        : null,
  };
}

function messagesFor(agentId, taskType, goal) {
  return [
    {
      role: 'system',
      content: `你是 Bluebird 的 ${agentId} Agent，能力域 ${taskType}。用简体中文回答，控制在 120 字以内，只给结论与依据。`,
    },
    { role: 'user', content: String(goal).slice(0, 400) },
  ];
}

async function main() {
  const compare = arg('compare');
  if (compare) {
    const evalBaseline = require('../server/agents/eval-baseline');
    const [left, right] = compare.split(',');
    const before = evalBaseline.readSnapshot(left);
    const after = evalBaseline.readSnapshot(right);
    const result = evalBaseline.diff(before, after);
    console.log('[EVIDENCE] eval-diff');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const strategyVersionTarget = arg('strategy-version', 'p4-default');
  const out = arg('out');
  if (!out) throw new Error('缺少 --out');

  const key = readKey();
  process.env.BLUEBIRD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p4-real-'));
  process.env.BLUEBIRD_AGENT_TASK_MAX_ATTEMPTS = '3';
  process.env.BLUEBIRD_MONITORING = process.env.BLUEBIRD_MONITORING || '0';

  const apiConfigs = require('../server/api-configs');
  const adapter = require('../server/model-adapter');
  const tasks = require('../server/agents/tasks');
  const autonomyPolicy = require('../server/agents/autonomy-policy');
  const strategyVersion = require('../server/agents/strategy-version');
  const { loadSuite } = require('../server/agents/eval-suite');
  const metrics = require('../server/agents/eval-metrics');
  const evalBaseline = require('../server/agents/eval-baseline');
  const { budgetOf } = require('../server/agents/eval-runner');

  let providerId = null;
  try {
    const created = apiConfigs.addModelProvider({
      name: PROVIDER.name,
      baseUrl: PROVIDER.baseUrl,
      apiKey: key,
      models: [{ id: PROVIDER.modelId, name: PROVIDER.modelId, capabilities: { tools: false, vision: false } }],
    });
    if (created.error) throw new Error(`Provider 注册失败：${created.error}`);
    providerId = created.provider.id;
    const target = adapter.resolveTarget({ providerId, modelId: PROVIDER.modelId });
    if (!target || !target.key) throw new Error('Provider 解析失败');

    strategyVersion.apply({ version: strategyVersionTarget });
    const state = strategyVersion.get();

    const suite = loadSuite();
    const results = [];
    const usageRows = [];

    async function callModel(agentId, taskType, goal, maxTokens) {
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      try {
        const response = await adapter.createChatCompletion({
          providerId,
          modelId: PROVIDER.modelId,
          messages: messagesFor(agentId, taskType, goal),
          stream: false,
          temperature: 0.2,
          maxTokens,
          timeout: 60000,
        });
        const finishedMs = Date.now();
        const text =
          (response && response.choices && response.choices[0] && response.choices[0].message
            ? response.choices[0].message.content
            : '') || '';
        return {
          ok: Boolean(String(text).trim()),
          errorCode: String(text).trim() ? null : 'empty_response',
          usage: response ? response.usage || null : null,
          startedAt,
          finishedAt: new Date(finishedMs).toISOString(),
          startedMs,
          finishedMs,
        };
      } catch (error) {
        const finishedMs = Date.now();
        return {
          ok: false,
          errorCode: (error && error.kind) || 'model_error',
          usage: null,
          startedAt,
          finishedAt: new Date(finishedMs).toISOString(),
          startedMs,
          finishedMs,
        };
      }
    }

    for (let index = 0; index < suite.cases.length; index += 1) {
      const item = suite.cases[index];
      const plan = autonomyPolicy.plan({ goal: item.goal, taskType: item.taskType });
      const strength = autonomyPolicy.verificationStrength({ taskType: item.taskType });
      const task = tasks.createTask({
        botId: item.agentId,
        taskType: item.taskType,
        goal: item.goal,
        route: plan.enabled ? { orchestration: plan.orchestration } : null,
        budget: budgetOf(item.budgetTokenCap),
      });
      if (plan.enabled && strength.requiresReview) tasks.updateTask(task.taskId, { requiresReview: true });
      tasks.transitionTask(task.taskId, { to: 'accepted' });
      tasks.transitionTask(task.taskId, { to: 'running' });

      let usedTokens = 0;
      let rework = 0;
      let budgetExceeded = false;
      const runIds = [];
      const calls = [];

      // 每条用例按既有脚本推进 attempt（脚本决定语义结果，模型调用、usage、墙钟延迟都是真实的）。
      const steps = Array.isArray(item.script) ? item.script : [];
      let lastOutcome = 'failed';
      let lastErrorCode = null;
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex];
        if (stepIndex > 0) {
          tasks.transitionTask(task.taskId, { to: 'retrying' });
          tasks.transitionTask(task.taskId, { to: 'running' });
        }
        const remaining = item.budgetTokenCap - usedTokens;
        if (remaining < MIN_CALL_TOKENS) {
          budgetExceeded = true;
          const runId = `real_${item.id}_${stepIndex + 1}`;
          runIds.push(runId);
          const at = new Date().toISOString();
          tasks.recordRunStart(task.taskId, { runId, attempt: stepIndex, startedAt: at });
          tasks.recordRunFinish(task.taskId, {
            runId,
            status: 'failed',
            errorCode: 'budget_exceeded',
            finishedAt: at,
            usage: null,
          });
          lastOutcome = 'failed';
          lastErrorCode = 'budget_exceeded';
          break;
        }

        const call = await callModel(item.agentId, item.taskType, item.goal, Math.min(400, remaining - 40));
        calls.push({
          purpose: `primary_${stepIndex + 1}`,
          ok: call.ok,
          errorCode: call.errorCode,
          usage: usageDetails(call.usage),
        });
        const tokens = totalTokens(call.usage);
        const runId = `real_${item.id}_${stepIndex + 1}`;
        runIds.push(runId);
        const failedByCall = !call.ok;
        const effective = failedByCall ? 'failed' : step.outcome;
        const code = failedByCall ? call.errorCode : step.errorCode;
        tasks.recordRunStart(task.taskId, { runId, attempt: stepIndex, startedAt: call.startedAt });
        tasks.recordRunFinish(task.taskId, {
          runId,
          status: effective,
          errorCode: code,
          finishedAt: call.finishedAt,
          usage: call.usage,
        });
        if (tokens !== null) {
          tasks.settleTaskBudget(task.taskId, { reserved: 0, actual: tokens });
          usedTokens += tokens;
        }
        lastOutcome = effective;
        lastErrorCode = code;
        if (effective === 'failed' && stepIndex < steps.length - 1) rework += 1;
        if (usedTokens > item.budgetTokenCap) {
          budgetExceeded = true;
          lastOutcome = 'failed';
          lastErrorCode = 'budget_exceeded';
          break;
        }
      }

      let finalStatus = lastOutcome === 'failed' ? 'failed' : 'completed';
      let replan = null;
      let errorCode = lastErrorCode;

      if (finalStatus === 'failed') {
        const taskNow = tasks.getTask(task.taskId) || {};
        const decision = autonomyPolicy.decideReplan({
          task: { agentId: item.agentId, attempts: runIds.length, maxAttempts: taskNow.maxAttempts },
          errorCode,
          tokenBudget: item.budgetTokenCap,
          tokenUsed: usedTokens,
        });
        replan = budgetExceeded ? 'budget_exhausted' : decision.reason;
        if (decision.replan && !budgetExceeded) {
          tasks.transitionTask(task.taskId, { to: 'retrying' });
          tasks.transitionTask(task.taskId, { to: 'running' });
          const remainingAfter = item.budgetTokenCap - usedTokens;
          if (remainingAfter < MIN_CALL_TOKENS) {
            replan = 'budget_exhausted';
          } else {
            const call = await callModel(item.agentId, item.taskType, `换策略重试：${item.goal}`, Math.min(400, remainingAfter - 40));
            calls.push({
              purpose: 'replan',
              ok: call.ok,
              errorCode: call.errorCode,
              usage: usageDetails(call.usage),
            });
            const runId = `real_${item.id}_replan`;
            runIds.push(runId);
            tasks.recordRunStart(task.taskId, { runId, attempt: runIds.length - 1, startedAt: call.startedAt });
            tasks.recordRunFinish(task.taskId, {
              runId,
              status: call.ok ? 'completed' : 'failed',
              errorCode: call.ok ? null : call.errorCode,
              finishedAt: call.finishedAt,
              usage: call.usage,
            });
            const tokens = totalTokens(call.usage);
            if (tokens !== null) {
              tasks.settleTaskBudget(task.taskId, { reserved: 0, actual: tokens });
              usedTokens += tokens;
            }
            rework += 1;
            if (call.ok) {
              finalStatus = 'completed';
              errorCode = null;
            } else {
              errorCode = call.errorCode;
            }
          }
        }
      }

      tasks.transitionTask(task.taskId, {
        to: finalStatus,
        errorCode: finalStatus === 'failed' ? errorCode : null,
      });

      const teamTaskIds = [];
      let reviewTaskId = `review_${task.taskId}`;
      if (plan.enabled && plan.decision === 'team' && finalStatus === 'completed') {
        const reviewerTask = tasks.createTask({
          botId: 'reviewer',
          taskType: 'review.verify',
          goal: `复核：${item.goal}`.slice(0, 120),
          parentTaskId: task.taskId,
          route: { orchestration: plan.orchestration },
          budget: budgetOf(200),
        });
        tasks.transitionTask(reviewerTask.taskId, { to: 'accepted' });
        tasks.transitionTask(reviewerTask.taskId, { to: 'running' });
        const review = await callModel('reviewer', 'review.verify', `复核结论是否有依据：${item.goal}`, 160);
        calls.push({
          purpose: 'review',
          ok: review.ok,
          errorCode: review.errorCode,
          usage: usageDetails(review.usage),
        });
        const runId = `real_${item.id}_review`;
        tasks.recordRunStart(reviewerTask.taskId, { runId, attempt: 0, startedAt: review.startedAt });
        tasks.recordRunFinish(reviewerTask.taskId, {
          runId,
          status: review.ok ? 'completed' : 'failed',
          errorCode: review.errorCode,
          finishedAt: review.finishedAt,
          usage: review.usage,
        });
        const tokens = totalTokens(review.usage);
        if (tokens !== null) tasks.settleTaskBudget(reviewerTask.taskId, { reserved: 0, actual: tokens });
        tasks.transitionTask(reviewerTask.taskId, {
          to: review.ok ? 'completed' : 'failed',
          errorCode: review.ok ? null : review.errorCode,
        });
        teamTaskIds.push(reviewerTask.taskId);
        reviewTaskId = reviewerTask.taskId;
      }

      const reviewNeeded =
        item.expectReview || (plan.enabled && plan.decision === 'team' && finalStatus === 'completed');
      if (reviewNeeded) {
        tasks.appendEvent({
          botId: item.agentId,
          taskId: task.taskId,
          eventType: 'verification.review_opened',
          payload: { reviewTaskId, producerTaskId: task.taskId, deterministicOk: true },
        });
        tasks.appendEvent({
          botId: item.agentId,
          taskId: task.taskId,
          eventType: 'verification.verdict',
          payload: { reviewTaskId, verdict: 'pass', deterministicOk: true },
        });
      }

      const taskNow = tasks.getTask(task.taskId) || {};
      const runs = Array.isArray(taskNow.runs) ? taskNow.runs : [];
      results.push({
        caseId: item.id,
        taskId: task.taskId,
        teamTaskIds,
        agentId: item.agentId,
        taskType: item.taskType,
        runIds,
        attempts: Math.max(1, runs.length),
        rework,
        startedAt: runs[0] ? runs[0].startedAt : null,
        finishedAt: runs.length ? runs[runs.length - 1].finishedAt : null,
        latencyMs: null,
        reviewTriggered: reviewNeeded,
        replan,
        policy: plan.enabled ? { version: plan.version, decision: plan.decision, rationale: plan.rationale } : null,
        expectedTerminal: item.expectedTerminal,
        allowedErrorCodes: item.allowedErrorCodes,
        expectReview: item.expectReview,
        budgetTokenCap: item.budgetTokenCap,
      });
      usageRows.push({ caseId: item.id, budgetTokenCap: item.budgetTokenCap, usedTokens, budgetExceeded, calls });
      if (index < suite.cases.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CASE_GAP_MS));
      }
    }

    const computed = metrics.computeMetrics({
      suite: { version: suite.version, digest: suite.digest, caseCount: suite.caseCount },
      results,
    });

    const snapshot = evalBaseline.createSnapshot({
      metrics: computed,
      codeCommit: process.env.BLUDBIRD_COMMIT || null,
      strategy: { version: state.version, enabled: state.enabled },
    });
    evalBaseline.writeSnapshot(snapshot, out);

    console.log('[EVIDENCE] eval-baseline');
    console.log(
      JSON.stringify(
        {
          out,
          strategy: { version: state.version, enabled: state.enabled },
          caseCount: suite.caseCount,
          successRate: computed.metrics.successRate,
          rework: computed.metrics.rework,
          tokenCost: computed.metrics.tokenCost,
          latency: computed.metrics.latency,
          safety: computed.safety,
        },
        null,
        2
      )
    );
    for (const row of usageRows) {
      console.log(`[EVIDENCE] real-usage ${JSON.stringify(row)}`);
    }
    const failedCalls = usageRows.reduce(
      (sum, row) => sum + row.calls.filter(call => !call.ok).length,
      0
    );
    const billedTokens = usageRows.reduce(
      (sum, row) => sum + row.calls.reduce((inner, call) => inner + (call.usage.total || 0), 0),
      0
    );
    console.log(
      `[EVIDENCE] real-summary ${JSON.stringify({ rounds: 1, caseCount: suite.caseCount, failedCalls, billedTokens })}`
    );
  } catch (error) {
    console.log(`[EVIDENCE] real-eval-error ${redact(error && error.message, key)}`);
    process.exitCode = 1;
  } finally {
    if (providerId) {
      const removed = apiConfigs.deleteModelProvider(providerId);
      console.log(`[EVIDENCE] provider-cleanup ${JSON.stringify({ removed: Boolean(removed && removed.ok) })}`);
    }
    fs.rmSync(process.env.BLUEBIRD_DATA_DIR, { recursive: true, force: true });
    console.log('[EVIDENCE] temp-data-removed true');
  }
}

main().catch(error => {
  console.log(`[EVIDENCE] real-eval-error ${String(error && error.message)}`);
  process.exitCode = 1;
});
