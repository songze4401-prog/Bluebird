/* global module */
/**
 * 轮 3（Orchestrator 立项书）：编排执行引擎（orchestration-engine-v1）。
 *
 * 职责（控制面；实际执行全部复用既有 Runtime）：
 *  ① orchestrateDAG：读编译产物图（plan_pc_ head）→ 拓扑序逐节点 router.dispatch
 *     （agentId 用计划里服务端解析出的执行者；dependsOn 解析为上游真实 taskId；
 *     幂等键 orch:<planId>:v<version>:<stepKey>，重入返回既有任务）。跨 Agent 依赖
 *     边由 dag-v1 在 tasks.js 放行——**仅限 planId 前缀 plan_pc_ 的图**，散装任务的
 *     同 Agent 约束原样保留；环检测/委派深度/预算/父子授权交集全部不变。
 *  ② onPlanTaskSettled：runtime 终态收口钩子（fail-safe，异步 fire-and-forget）。
 *     - completed：把本任务产物显式 artifactStore.share 给直接下游 + 把引用追加进
 *       下游 context（下游只会在上游 completed 后被调度，时序上共享登记先于读取）；
 *     - 任何节点终态后尝试归约。
 *  ③ maybeReducePlan：全部节点终态才归约：
 *     - 审校门（orchestration 记录里 max riskLevel ≥ R2）：聚合结论落 conclusion
 *       产物（evidence = 节点产物引用，挂最后终态节点）→ verification-loop.openReview
 *       独立审校 → pass 才交付；fail/needs_human → 状态 blocked_review，不交付。
 *     - 发布门：计划声明 publishGate.required → 等全部命中节点的 plan.publish 审批
 *       completed 才交付；未齐 → awaiting_publish（审批执行完成会回 re-check）。
 *     - 交付：resultDelivery.deliverPlanOutcome（幂等 bot-result-<planId>）+
 *       orchestration.completed / orchestration.partial（失败节点列缺口）。
 *
 * 存储：<DATA_DIR>/agents/agent-orchestrations.json（原子写）。
 * 循环依赖隔离：router / verification-loop 一律函数内 lazy require（runtime →
 * 本模块 → router → runtime 的环必须在这里打断）。
 */
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const workflowStore = require('./workflow-store');
const artifactStore = require('./artifact-store');
const riskPolicy = require('./risk-policy');
const planCompiler = require('./plan-compiler');

// v2（2026-11-13，Owner 委托裁决）：审校门处置——fail（审校明确拒绝）→ 照旧
// blocked 不交付；needs_human / 超时 → 标注交付（附「未经独立审校确认」警示与
// 审校引用）。理由：编排副作用在节点执行时已发生，扣住答案不能撤销副作用只会
// 隐藏信息；与 FM-6「交付并披露缺口」口径一致。v1 的 needs_human/超时一律
// blocked 在真实模型下会把用户答案频繁扣住（真实 reviewer 明显偏保守）。
const ORCHESTRATION_POLICY_VERSION = 'orchestration-engine-v2';
const ORCHESTRATIONS_FILE = 'agent-orchestrations.json';
const ROOT_SUMMARY_MAX = 8000;
const CONTEXT_APPEND_MAX = 8000;
const REVIEW_WAIT_MS = Math.max(
  1000,
  Number(process.env.BLUEBIRD_AGENT_REVIEW_WAIT_MS) || 30000
);

function storePath() {
  return path.join(path.dirname(tasks.TASKS_FILE), ORCHESTRATIONS_FILE);
}

function emptyStore() {
  return { version: 1, orchestrations: {}, updatedAt: null };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.orchestrations !== 'object') {
      throw new Error('store shape');
    }
    return parsed;
  } catch (_) {
    return emptyStore();
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temp = `${storePath()}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, storePath());
  return state;
}

function reloadForTests() {
  try {
    fs.rmSync(storePath(), { force: true });
  } catch (_) {
    /* 夹具清理失败不改变判定 */
  }
}

function recordEvent(botId, eventType, payload, context = {}) {
  try {
    tasks.appendEvent({ botId: botId || 'memory', eventType, payload, ...context });
  } catch (_) {
    /* 事件失败不改变编排结论 */
  }
}

function riskRankOf(level) {
  try {
    return riskPolicy.levelRank(level);
  } catch (_) {
    return 0;
  }
}

function assessNodeRisk(taskType) {
  const { HIGH_RISK_TASK_TYPES } = require('./autonomy-policy');
  return riskPolicy.assessRisk({
    taskType,
    toolRisks: [],
    highRiskTaskType:
      HIGH_RISK_TASK_TYPES && typeof HIGH_RISK_TASK_TYPES.has === 'function'
        ? HIGH_RISK_TASK_TYPES.has(taskType)
        : false,
  });
}

function artifactsOf(task) {
  return task && task.result && Array.isArray(task.result.artifacts)
    ? task.result.artifacts.filter(ref => ref && ref.id)
    : [];
}

/**
 * ① 编排入口。definitions 可选：调用方持有编译产物时传入（轮 4 主聊天路径），
 * 否则用计划 head 的 steps（节点 context 为空——编译期的 node.context 是
 * definitions 层的可选糖，计划 steps 不携带）。
 */
function orchestrateDAG({ planId, definitions = null, parentSessionId = null, parentUserText = '', parentUserId = null } = {}) {
  const { AgentError } = require('./errors');
  if (typeof planId !== 'string' || !planId.startsWith('plan_pc_')) {
    throw new AgentError('orchestration_plan_invalid', '编排只接受编译器产物图（plan_pc_ 前缀）', 400);
  }
  const compiled = planCompiler.getCompiledPlan(planId);
  if (!compiled) {
    throw new AgentError('plan_missing', '编排计划不存在', 404);
  }
  const state = load();
  const existing = state.orchestrations[planId];
  if (existing && existing.status === 'running') {
    // 幂等重入：同计划重复 orchestrateDAG 返回既有编排与任务，不重复建任务。
    const nodes = Object.values(existing.nodes || {}).map(node => tasks.getRawTask(node.taskId)).filter(Boolean);
    const allPresent = nodes.length === Object.keys(existing.nodes || {}).length;
    if (allPresent) {
      return { orchestration: publicOrchestration(existing), idempotent: true };
    }
  }

  const plan = compiled.plan;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) {
    throw new AgentError('orchestration_plan_invalid', '编排计划没有可执行节点', 400);
  }
  const provided = Array.isArray(definitions) && definitions.length === steps.length ? definitions : null;
  if (definitions && !provided) {
    throw new AgentError('orchestration_plan_invalid', 'definitions 与计划节点数不一致', 400);
  }

  // 拓扑序（批内 stepKey 空间；上游 taskId 在创建后回填）。
  const depsModule = require('./dependencies');
  const { order } = depsModule.validateGraph({
    nodes: steps.map(step => ({ key: step.stepKey, dependsOn: step.dependsOn })),
    tasksById: {},
  });

  const router = require('./router'); // lazy：router → runtime → 本模块 的环在这里打断
  const nodes = {};
  const taskIdByStep = new Map();
  for (const stepKey of order) {
    const step = steps.find(item => item.stepKey === stepKey);
    const definition = provided ? provided.find(item => item.stepKey === stepKey) : null;
    const upstreamTaskIds = (Array.isArray(step.dependsOn) ? step.dependsOn : [])
      .map(ref => taskIdByStep.get(ref))
      .filter(Boolean);
    const upstreamGoals = upstreamTaskIds
      .map(taskId => {
        const upstream = tasks.getRawTask(taskId);
        return upstream ? `${upstream.taskType}:${upstream.goal.slice(0, 120)}` : taskId;
      });
    const contextParts = [
      JSON.stringify({
        orchestration: planId,
        orchestrationVersion: compiled.planVersion,
        ...(definition && definition.context ? { intent: definition.context } : {}),
        upstreamGoals,
      }),
    ];
    const dispatched = router.dispatch({
      agentId: step.agentId,
      taskType: step.taskType,
      capability: step.capability || step.taskType,
      goal: step.goal,
      context: contextParts.join('\n').slice(0, 8000),
      dependsOn: upstreamTaskIds,
      allowedTools: null,
      // 冻结到编译产物版本：节点绑定 plan_pc_ 血缘（修订/发布门/编排收口都按
      // planId 识别），并带 stepKey 供节点映射；不传则 dispatch 会另建单步计划。
      workflowPlan: { planId, planVersion: compiled.planVersion },
      stepKey,
      idempotencyKey: `orch:${planId}:v${compiled.planVersion}:${stepKey}`,
      ...(parentSessionId ? { parentSessionId } : {}),
      parentUserText: typeof parentUserText === 'string' ? parentUserText : '',
      ...(parentUserId ? { parentUserId } : {}),
    });
    const task = dispatched.task;
    taskIdByStep.set(stepKey, task.taskId);
    nodes[stepKey] = {
      taskId: task.taskId,
      agentId: step.agentId || task.agentId,
      taskType: step.taskType,
      goal: step.goal,
      riskLevel: assessNodeRisk(step.taskType).level,
      idempotent: dispatched.idempotent === true,
    };
  }

  const now = new Date().toISOString();
  const record = {
    planId,
    planVersion: compiled.planVersion,
    policyVersion: ORCHESTRATION_POLICY_VERSION,
    status: 'running',
    nodes,
    parentSessionId: parentSessionId || null,
    parentUserText: typeof parentUserText === 'string' ? parentUserText.slice(0, 2000) : '',
    parentUserId: parentUserId || null,
    createdAt: now,
    reducedAt: null,
    deliveryMessageId: null,
    reviewRef: null,
    pendingReason: null,
  };
  state.orchestrations[planId] = record;
  save(state);
  const firstAgent = nodes[order[0]] ? nodes[order[0]].agentId : 'memory';
  recordEvent(
    firstAgent,
    'orchestration.created',
    { planId, planVersion: compiled.planVersion, nodeCount: order.length, mode: 'dag' },
    {}
  );
  return { orchestration: publicOrchestration(record), idempotent: false };
}

function publicOrchestration(record) {
  return {
    planId: record.planId,
    planVersion: record.planVersion,
    policyVersion: record.policyVersion,
    status: record.status,
    nodes: JSON.parse(JSON.stringify(record.nodes || {})),
    parentSessionId: record.parentSessionId || null,
    createdAt: record.createdAt,
    reducedAt: record.reducedAt || null,
    deliveryMessageId: record.deliveryMessageId || null,
    reviewRef: record.reviewRef || null,
    reviewOutcome: record.reviewOutcome || null,
    pendingReason: record.pendingReason || null,
  };
}

function getOrchestration(planId) {
  if (typeof planId !== 'string' || !planId.startsWith('plan_pc_')) return null;
  const record = load().orchestrations[planId];
  return record ? publicOrchestration(record) : null;
}

const inFlight = new Set();

/** ② runtime 终态收口钩子（异步 fire-and-forget，调用方 fail-safe）。 */
async function onPlanTaskSettled({ taskId, status } = {}) {
  const task = typeof taskId === 'string' ? tasks.getRawTask(taskId) : null;
  if (!task || !task.planId || !String(task.planId).startsWith('plan_pc_')) return;
  const state = load();
  const record = state.orchestrations[task.planId];
  if (!record) return;
  const stepEntry = Object.entries(record.nodes || {}).find(([, node]) => node.taskId === taskId);
  if (!stepEntry) return;
  const [stepKey, nodeEntry] = stepEntry;

  if (status === 'completed') {
    const plan = safePlanHead(task.planId);
    const downstream = plan
      ? plan.steps.filter(step =>
          Array.isArray(step.dependsOn) && step.dependsOn.includes(stepKey)
        )
      : [];
    for (const ref of artifactsOf(task)) {
      for (const downStep of downstream) {
        const downNode = (record.nodes || {})[downStep.stepKey];
        if (!downNode) continue;
        try {
          artifactStore.share(ref.id, {
            withTaskIds: [downNode.taskId],
            byTaskId: taskId,
          });
          const downstreamTask = tasks.getRawTask(downNode.taskId);
          if (downstreamTask && !tasks.isTerminalStatus(downstreamTask.status)) {
            const refLine = `上游产物引用：${ref.kind}:${ref.id}:${ref.version}（来自 ${task.taskType}）`;
            const merged = downstreamTask.context
              ? `${downstreamTask.context}\n${refLine}`
              : refLine;
            tasks.updateTask(downNode.taskId, { context: merged.slice(0, CONTEXT_APPEND_MAX) });
          }
          recordEvent(
            task.agentId,
            'orchestration.artifact_shared',
            { planId: task.planId, artifactId: ref.id, toTaskId: downNode.taskId },
            { taskId }
          );
        } catch (error) {
          // 共享失败不阻断编排；下游读取时按默认拒绝语义 fail-closed。
          console.warn(
            `[orchestration] artifact share failed artifact=${ref.id} code=${
              (error && error.code) || 'share_failed'
            }`
          );
        }
      }
    }
  }
  await maybeReducePlan(task.planId);
}

function safePlanHead(planId) {
  try {
    const state = workflowStore.read();
    const lineage = state.plans[planId];
    if (!lineage) return null;
    return workflowStore.getVersion(planId, lineage.headVersion).plan;
  } catch (_) {
    return null;
  }
}

function approvalsFor(botIds) {
  const approvals = require('./approvals');
  const seen = new Map();
  for (const botId of botIds) {
    for (const item of approvals.listApprovals(botId, { limit: 200 })) {
      if (item.operation === 'plan.publish' && item.payload && item.payload.planId) {
        seen.set(item.approvalId, item);
      }
    }
  }
  return [...seen.values()];
}

/** ③ 归约：全部节点终态才结算。单飞防重入。 */
async function maybeReducePlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith('plan_pc_') || inFlight.has(planId)) {
    return { reduced: false, reason: inFlight.has(planId) ? 'in_flight' : 'not_orchestration' };
  }
  inFlight.add(planId);
  try {
    const state = load();
    const record = state.orchestrations[planId];
    if (!record || record.status !== 'running') {
      return { reduced: false, reason: 'not_running' };
    }
    const nodes = Object.values(record.nodes || {});
    const rawNodes = nodes.map(node => tasks.getRawTask(node.taskId));
    if (rawNodes.some(item => !item || !tasks.isTerminalStatus(item.status))) {
      return { reduced: false, reason: 'nodes_pending' };
    }

    const completed = [];
    const failed = [];
    rawNodes.forEach((task, index) => {
      const entry = nodes[index];
      if (task.status === 'completed') completed.push({ entry, task });
      else failed.push({ entry, task });
    });

    const summaryLines = [];
    const artifactRefs = [];
    const seenArtifact = new Set();
    for (const { entry, task } of completed) {
      const summary = task.result && typeof task.result.summary === 'string' ? task.result.summary : '';
      summaryLines.push(`[${entry.taskType}] ${summary.slice(0, 600) || '（无摘要）'}`);
      for (const ref of artifactsOf(task)) {
        if (!seenArtifact.has(ref.id)) {
          seenArtifact.add(ref.id);
          artifactRefs.push(ref);
        }
      }
    }
    for (const { entry, task } of failed) {
      summaryLines.push(
        `[${entry.taskType}] 失败（${task.errorCode || 'unknown'}${task.result && task.result.neverStarted ? '，未启动' : ''}）`
      );
    }
    const rootStatus = failed.length === 0 ? 'completed' : 'partial';
    let summary = summaryLines.join('\n').slice(0, ROOT_SUMMARY_MAX);

    // 审校门（v2）：任一节点 R2+ 且确有产物可送审 → 独立审校；fail → 阻断，
    // needs_human / 超时 → 标注交付（披露缺口，不扣住用户答案）。
    const maxRank = nodes.reduce((max, node) => Math.max(max, riskRankOf(node.riskLevel)), 0);
    if (maxRank >= 2 && completed.length) {
      const lastSettled = completed[completed.length - 1].task;
      const gate = await runReviewGate({ planId, record, lastSettledTask: lastSettled, artifactRefs, summaryLines });
      if (!gate.pass) {
        return { reduced: false, reason: 'blocked_review', reviewTaskId: gate.reviewTaskId };
      }
      if (gate.annotate) {
        record.reviewOutcome = gate.reviewNote;
        saveCurrent({ planId, patch: { reviewOutcome: gate.reviewNote } });
        const annotation = `\n\n⚠️ 独立审校未能给出结论（${gate.reviewNote}）：以上内容未经独立验证，请自行判断；审校任务：${gate.reviewTaskId || '无'}。`;
        summary = summary.slice(0, Math.max(0, ROOT_SUMMARY_MAX - annotation.length)) + annotation;
      }
    }

    // 发布门：计划声明 publishGate.required → 等全部命中节点的 plan.publish 审批完成。
    const plan = safePlanHead(planId);
    if (plan && plan.publishGate && plan.publishGate.required === true) {
      const gateTaskTypes = plan.publishGate.taskType
        ? [String(plan.publishGate.taskType)]
        : plan.steps.map(step => step.taskType);
      const gatedNodes = nodes.filter(node => gateTaskTypes.includes(node.taskType));
      const gatedTaskIds = new Set(gatedNodes.map(node => node.taskId));
      const botIds = [...new Set(nodes.map(node => node.agentId))];
      const publishApprovals = approvalsFor(botIds).filter(
        item => gatedTaskIds.has(item.taskId) && item.payload && item.payload.planId === planId
      );
      // 每个命中节点都必须有一条已完成（批准后交付收口）的 plan.publish 审批。
      const allApproved = gatedNodes.every(node =>
        publishApprovals.some(
          item => item.taskId === node.taskId && item.status === 'completed'
        )
      );
      if (!allApproved) {
        record.status = 'awaiting_publish';
        record.pendingReason = `publish_gate:${publishApprovals.filter(item => item.status === 'completed').length}/${gatedNodes.length}`;
        save(state);
        recordEvent(
          gatedNodes[0] ? gatedNodes[0].agentId : 'memory',
          'orchestration.awaiting_publish',
          { planId, failedCount: 0, pendingReason: record.pendingReason },
          {}
        );
        return { reduced: false, reason: 'awaiting_publish' };
      }
    }

    await deliverRoot({ planId, record, rootStatus, summary, artifactRefs, failedCount: failed.length });
    return { reduced: true, status: rootStatus };
  } finally {
    inFlight.delete(planId);
  }
}

/** 审校门：聚合结论落 conclusion 产物（evidence=节点产物）→ openReview → 等终态。 */
async function runReviewGate({ planId, record, lastSettledTask, artifactRefs, summaryLines }) {
  const verificationLoop = require('./verification-loop'); // lazy：环隔离
  if (!artifactRefs.length) {
    // 没有可送审产物（全部节点无产物）：跳过审校门并在记录里说明（不静默放行）。
    record.pendingReason = 'review_gate_skipped:no_artifacts';
    return { pass: true, reviewTaskId: null, skipped: true };
  }
  const conclusion = artifactStore.persist({
    kind: 'conclusion',
    taskId: lastSettledTask.taskId,
    content: {
      subject: `编排聚合 ${planId}`,
      aggregation: summaryLines.join('\n').slice(0, 4000),
      evidence: artifactRefs,
    },
    provenanceRefs: artifactRefs,
    sourceLabels: ['agent:derived'],
  });
  const conclusionRef = { kind: conclusion.kind, id: conclusion.id, version: conclusion.version };
  const opened = verificationLoop.openReview({
    producerTaskId: lastSettledTask.taskId,
    artifactRef: conclusionRef,
  });
  const reviewTaskId = opened && opened.reviewTaskId;
  record.reviewRef = reviewTaskId;
  const deadline = Date.now() + REVIEW_WAIT_MS;
  while (Date.now() < deadline) {
    const reviewTask = reviewTaskId ? tasks.getRawTask(reviewTaskId) : null;
    if (reviewTask && tasks.isTerminalStatus(reviewTask.status)) {
      const verdict = verificationLoop.parseVerdict(reviewTask);
      if (verdict.decision === 'pass' && verdict.valid) {
        return { pass: true, annotate: false, reviewNote: null, reviewTaskId, verdict };
      }
      if (verdict.decision === 'fail') {
        // fail = 独立审校明确拒绝：v2 里唯一继续阻断交付的处置。
        saveCurrent({ planId, patch: { status: 'blocked_review', pendingReason: 'review_fail', reviewRef: reviewTaskId } });
        recordEvent(
          lastSettledTask.agentId,
          'orchestration.partial',
          { planId, failedCount: 0, pendingReason: 'review_fail', toTaskId: reviewTaskId },
          {}
        );
        return { pass: false, annotate: false, reviewNote: 'review_fail', reviewTaskId, verdict };
      }
      // needs_human：审校无法给出结论。副作用已在节点执行时发生——按 FM-6
      // 「交付并披露缺口」口径标注交付，不由审校扣住用户答案。
      return { pass: true, annotate: true, reviewNote: 'review_needs_human', reviewTaskId, verdict };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // 审校超时：与 needs_human 同处置（标注交付），不再阻断。
  return { pass: true, annotate: true, reviewNote: 'review_timeout', reviewTaskId, verdict: null };
}

function saveCurrent({ planId, patch }) {
  const state = load();
  const record = state.orchestrations[planId];
  if (!record) return;
  Object.assign(record, patch);
  save(state);
}

async function deliverRoot({ planId, record, rootStatus, summary, artifactRefs, failedCount }) {
  const resultDelivery = require('./result-delivery');
  const eventStatus = rootStatus === 'completed' ? 'orchestration.completed' : 'orchestration.partial';
  const botId = Object.values(record.nodes)[0] ? Object.values(record.nodes)[0].agentId : 'memory';
  const result = {
    status: rootStatus,
    summary,
    artifacts: artifactRefs,
    failedCount,
  };
  const delivery = resultDelivery.deliverPlanOutcome({
    planId,
    botId,
    parentSessionId: record.parentSessionId,
    status: rootStatus,
    result,
    errorCode: failedCount ? 'orchestration_partial' : null,
  });
  saveCurrent({
    planId,
    patch: {
      status: rootStatus,
      reducedAt: new Date().toISOString(),
      deliveryMessageId: delivery.messageId || null,
      pendingReason: null,
    },
  });
  recordEvent(
    botId,
    eventStatus,
    {
      planId,
      planVersion: record.planVersion,
      nodeCount: Object.keys(record.nodes || {}).length,
      failedCount,
    },
    {}
  );
}

module.exports = {
  orchestrateDAG,
  onPlanTaskSettled,
  maybeReducePlan,
  getOrchestration,
  reloadForTests,
  ORCHESTRATION_POLICY_VERSION,
};
