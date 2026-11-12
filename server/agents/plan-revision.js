/* global module */
/**
 * P5-C2：计划修订闭环（plan-revision-v1）。
 *
 * 验证拒绝导致的终态失败、且任务带计划血缘时，把「需要修订的节点集合」落成
 * 新计划版本并只重跑缺证节点：
 *   1. 收集同计划全部任务；failed（含被 settleDependencies 判死的 dependency_failed
 *      下游，未启动、零副作用）为重跑集；
 *   2. `workflow-store.migratePlanVersion` 追加 v2（同一内容）：completed 且产物可复用
 *      → reused；failed 终态 → unchanged（保留原版本供追溯）；fencing 同步换代次；
 *   3. 按失败节点的 stepKey 重建定义：同批重跑的依赖用 stepKey，已完成上游用真实
 *      taskId（dependencies.validateGraph 原生支持 key|taskId 双引用），只建缺证节点；
 *   4. 上游产物显式 `artifactStore.share` 给重跑任务——这是编排侧的授权动作，
 *      不放宽 worker-scope 的默认拒绝语义；
 *   5. 修订记录落 `<DATA_DIR>/agents/agent-plan-revisions.json`（原子写）。
 *
 * 守卫（全部先于任何落盘）：
 *   - 每计划最多 MAX_REVISIONS_PER_PLAN=2 次（超限记 plan.revision_storm_denied）；
 *   - 同计划存在未终态的重跑任务 → 不重复修订（revision_in_flight）；
 *   - 图上还有非终态任务 → 不修订（plan_not_settled）；
 *   - 只修订 head 版本（plan_head_mismatch）；失败任务缺 stepKey → 不修订
 *     （step_key_missing，旧任务无节点映射，修订会变成盲跑）。
 *
 * 调用方（runtime 终态收口）负责 fail-safe：本模块抛错不改变任务终态，
 * 只由调用方记 plan.revision_skipped 事件。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const workflowStore = require('./workflow-store');

const REVISION_POLICY_VERSION = 'plan-revision-v1';
const MAX_REVISIONS_PER_PLAN = 2;
const REVISIONS_FILE = 'agent-plan-revisions.json';
const CONTEXT_MAX = 8000;

function storePath() {
  return path.join(path.dirname(tasks.TASKS_FILE), REVISIONS_FILE);
}

function emptyStore() {
  return { version: 1, revisions: {}, updatedAt: null };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.revisions !== 'object') {
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
    tasks.appendEvent({ botId: botId || 'system', eventType, payload, ...context });
  } catch (_) {
    /* 事件失败不改变修订结论 */
  }
}

function revisionsOf(state, planId) {
  return Object.values(state.revisions).filter(item => item && item.planId === planId);
}

/** 开放修订：任一重跑任务尚未终态。重跑全部收口后才允许下一次修订。 */
function openRevisionOf(state, planId) {
  const rawTasks = tasks.rawTasksById();
  for (const revision of revisionsOf(state, planId)) {
    for (const taskId of revision.rerunTaskIds || []) {
      const task = rawTasks[taskId];
      if (task && !tasks.isTerminalStatus(task.status)) return revision;
    }
  }
  return null;
}

function artifactsOf(task) {
  return task && task.result && Array.isArray(task.result.artifacts)
    ? task.result.artifacts.filter(ref => ref && ref.id)
    : [];
}

/**
 * 修订入口。结构性错误抛 AgentError（调用方 fail-safe）；
 * 守卫类不满足返回 `{created:false, reason}`（事件由本模块记）。
 */
function createRevision({ failedTaskId, reason = '', runId = null, now = Date.now() } = {}) {
  const source = typeof failedTaskId === 'string' ? tasks.getRawTask(failedTaskId) : null;
  if (!source || !source.planId || !source.planVersion) {
    return { created: false, reason: 'no_plan' };
  }
  if (source.status !== 'failed') {
    return { created: false, reason: 'source_not_failed' };
  }
  const planId = source.planId;
  const state = load();

  if (revisionsOf(state, planId).length >= MAX_REVISIONS_PER_PLAN) {
    recordEvent(
      source.agentId,
      'plan.revision_storm_denied',
      { planId, skipReason: 'revision_limit' },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: 'revision_limit' };
  }
  const open = openRevisionOf(state, planId);
  if (open) {
    recordEvent(
      source.agentId,
      'plan.revision_skipped',
      { planId, skipReason: 'revision_in_flight', revisionId: open.revisionId },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: 'revision_in_flight' };
  }

  const planTasks = Object.values(tasks.rawTasksById()).filter(
    item => item && item.planId === planId
  );
  const notSettled = planTasks.find(item => !tasks.isTerminalStatus(item.status));
  if (notSettled) {
    recordEvent(
      source.agentId,
      'plan.revision_skipped',
      { planId, skipReason: 'plan_not_settled' },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: 'plan_not_settled' };
  }
  // 重跑集只圈「当前 head 版本」的失败任务：旧版本上的失败已被上一轮修订的
  // 重跑取代（unchanged 保留仅为追溯），圈进来会造成同 stepKey 双代重跑。
  const failedTasks = planTasks.filter(
    item => item.status === 'failed' && item.planVersion === source.planVersion
  );
  if (!failedTasks.length) {
    recordEvent(
      source.agentId,
      'plan.revision_skipped',
      { planId, skipReason: 'no_failed_nodes' },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: 'no_failed_nodes' };
  }

  const bound = workflowStore.getVersion(planId, source.planVersion);
  if (bound.headVersion !== source.planVersion) {
    recordEvent(
      source.agentId,
      'plan.revision_skipped',
      { planId, skipReason: 'plan_head_mismatch' },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: 'plan_head_mismatch' };
  }
  const headPlan = bound.plan;
  const steps = Array.isArray(headPlan.steps) ? headPlan.steps : [];

  const missingStepKey = failedTasks.find(item => !item.stepKey);
  const missingStep = failedTasks.find(
    item => !steps.find(step => step.stepKey === item.stepKey)
  );
  if (missingStepKey || missingStep) {
    recordEvent(
      source.agentId,
      'plan.revision_skipped',
      { planId, skipReason: missingStepKey ? 'step_key_missing' : 'step_not_in_plan' },
      { taskId: failedTaskId, runId: runId || null }
    );
    return { created: false, reason: missingStepKey ? 'step_key_missing' : 'step_not_in_plan' };
  }

  // 产物快照：completed 节点的产物交复用裁决（taint/maxAge/provenance 由
  // workflow-store 的 artifactReuseDecision 判，本模块不自行裁决）。
  const artifactIds = new Set();
  for (const item of planTasks) {
    for (const ref of artifactsOf(item)) artifactIds.add(ref.id);
  }
  const artifactStore = require('./artifact-store');
  const artifactRecords = artifactStore.all().filter(item => artifactIds.has(item.id));

  // v2：同一内容追加版本。completed+可复用 → reused；failed 终态 → unchanged；
  // fencing 换代次（旧 Worker 令牌失效，§10）。
  const migration = workflowStore.migratePlanVersion({
    plan: headPlan,
    planId,
    tasks: planTasks.map(item => ({
      taskId: item.taskId,
      status: item.status,
      planVersion: item.planVersion,
      stepKey: item.stepKey,
      result: { artifacts: artifactsOf(item) },
    })),
    artifacts: artifactRecords,
    now,
  });
  const toVersion = migration.saved.planVersion;

  // 重跑定义：只建缺证节点。依赖解析——同批重跑用 stepKey（批内解析），
  // 已完成上游用真实 taskId（tasksById 解析，且天然满足 isReady）。
  const rerunStepKeys = new Set(failedTasks.map(item => item.stepKey));
  const completedByStep = new Map();
  for (const item of planTasks) {
    if (item.status === 'completed' && item.stepKey) completedByStep.set(item.stepKey, item);
  }
  const definitions = [];
  const reuseByStep = new Map();
  for (const failedTask of failedTasks) {
    const step = steps.find(item => item.stepKey === failedTask.stepKey);
    const stepDeps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    const dependsOn = [];
    const reusedRefs = [];
    for (const ref of stepDeps) {
      if (rerunStepKeys.has(ref)) {
        dependsOn.push(ref);
        continue;
      }
      const upstream = completedByStep.get(ref);
      if (!upstream) continue; // 上游既不在重跑集也非已完成：不猜，留空（缺证据靠验证拦）
      dependsOn.push(upstream.taskId);
      for (const artifactRef of artifactsOf(upstream)) {
        reusedRefs.push({ upstreamTaskId: upstream.taskId, ref: artifactRef });
      }
    }
    definitions.push({
      key: step.stepKey,
      stepKey: step.stepKey,
      goal: step.goal,
      capability: step.capability,
      taskType: step.taskType,
      dependsOn,
      workflowPlan: { planId, planVersion: toVersion },
      context: JSON.stringify({
        revisionOf: planId,
        revisionVersion: toVersion,
        revisesTaskId: failedTask.taskId,
        revisionReason: String(reason || '').slice(0, 120),
        reusedArtifactRefs: reusedRefs.map(item => item.ref),
      }).slice(0, CONTEXT_MAX),
    });
    reuseByStep.set(step.stepKey, reusedRefs);
  }

  const orchestrator = require('./orchestrator');
  const graph = orchestrator.createTaskGraph({ definitions }, { source: 'plan_revision' });
  const rerunTasks = graph.tasks || {};

  // 上游产物显式共享给重跑任务。share 前置在本同步块内完成——dispatch 的
  // startTask 走 setImmediate，Worker 真正读产物时共享登记已落盘。
  for (const [stepKey, reusedRefs] of reuseByStep) {
    const rerunTask = rerunTasks[stepKey];
    if (!rerunTask) continue;
    for (const item of reusedRefs) {
      try {
        artifactStore.share(item.ref.id, {
          withTaskIds: [rerunTask.taskId],
          byTaskId: item.upstreamTaskId,
          now,
        });
      } catch (error) {
        // 共享失败不阻断修订；Worker 读取时按默认拒绝语义 fail-closed。
        console.warn(
          `[plan-revision] artifact share failed artifact=${item.ref.id} code=${
            (error && error.code) || 'share_failed'
          }`
        );
      }
    }
  }

  const rerunTaskIds = Object.values(rerunTasks).map(item => item.taskId);
  const reusedArtifactIds = [
    ...new Set(
      [...reuseByStep.values()].flatMap(items => items.map(item => item.ref.id))
    ),
  ];
  const revisionId = `rev_${crypto.randomUUID()}`;
  state.revisions[revisionId] = {
    revisionId,
    planId,
    fromVersion: source.planVersion,
    toVersion,
    policyVersion: REVISION_POLICY_VERSION,
    reason: String(reason || '').slice(0, 200) || null,
    sourceTaskId: failedTaskId,
    runId: runId || null,
    failedTaskIds: failedTasks.map(item => item.taskId),
    rerunTaskIds,
    reusedArtifactIds,
    status: 'created',
    createdAt: new Date(now).toISOString(),
  };
  save(state);

  recordEvent(
    source.agentId,
    'plan.revision_created',
    {
      planId,
      fromVersion: source.planVersion,
      toVersion,
      rerunCount: rerunTaskIds.length,
      revisionId,
    },
    { taskId: failedTaskId, runId: runId || null }
  );
  return {
    created: true,
    revisionId,
    planId,
    fromVersion: source.planVersion,
    toVersion,
    rerunTaskIds,
    reusedArtifactIds,
  };
}

function listRevisions({ planId = null } = {}) {
  const state = load();
  const items = Object.values(state.revisions);
  return planId ? items.filter(item => item.planId === planId) : items;
}

function getRevision(revisionId) {
  if (typeof revisionId !== 'string') return null;
  return load().revisions[revisionId] || null;
}

module.exports = {
  createRevision,
  listRevisions,
  getRevision,
  reloadForTests,
  MAX_REVISIONS_PER_PLAN,
  REVISION_POLICY_VERSION,
};
