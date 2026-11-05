/**
 * Phase 1 交付物第 1 项（Planner 侧）：确定性规划器回归。
 *
 * 能证明什么：
 * - 高层目标 → 规则拆解为有序步骤（含能力/任务类型/依赖），并只写入既有
 *   workflow-store（planId/planVersion 不可变版本）；
 * - 计划 → 任务批量创建复用 orchestrator.createTaskGraph，任务冻结同一
 *   (planId, planVersion)，dependsOn 解析为真实 taskId；
 * - 拆不出来时显式失败，零计划、零任务；
 * - 同一目标两次调用走「取出」语义（同 planId/planVersion/digest），显式
 *   追加时旧版本不变（不出现一号两内容）。
 *
 * 不能证明什么：**真实模型下的拆解质量未验证**（本轮只用规则/模板，不接模型）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-planner-'));
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.DEEPSEEK_API_KEY = '';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

const plannerModule = require('../server/agents/planner');
const workflowStore = require('../server/agents/workflow-store');
const tasks = require('../server/agents/tasks');
const manifest = require('../server/agents/manifest');
const routerModule = require('../server/agents/router');
const routingModule = require('../server/agents/routing-config');
const orchestratorModule = require('../server/agents/orchestrator');

// 真实 Router + 真实 Task/Workflow Store；只把 Agent 快照换成「无模型依赖」的
// memory Manifest，避免用例因本机未配置模型凭据而在准入阶段被拒。
function testAgent() {
  const m = manifest.MEMORY_BOT_MANIFEST;
  return {
    botId: m.botId,
    status: 'enabled',
    statusReason: null,
    capabilities: [...m.capabilities],
    acceptedTaskTypes: [...m.acceptedTaskTypes],
    taskContracts: JSON.parse(JSON.stringify(m.taskContracts)),
    toolAllowlist: [...m.toolAllowlist],
    concurrencyLimit: m.concurrencyLimit,
    routingPriority: m.routingPriority,
    defaultTimeoutMs: m.defaultTimeoutMs,
  };
}

function makePlanner() {
  const agents = [testAgent()];
  const fakeSessions = {
    createSession: () => ({ id: 'bs_planner_1' }),
    getSession: () => null,
    attachOwner: () => {},
  };
  const router = routerModule.createRouter({
    getAgents: () => agents,
    getConfig: () => ({
      config: JSON.parse(JSON.stringify(routingModule.DEFAULT_ROUTING)),
      digest: 'policy-digest-planner',
    }),
    sessions: fakeSessions,
    startTask: () => {},
    load: () => ({ queuedTotal: 0, runningByAgent: {} }),
    now: () => 1700000000000,
  });
  const orchestrator = orchestratorModule.createOrchestrator({
    router,
    getAgents: () => agents,
  });
  return plannerModule.createPlanner({ orchestrator });
}

const planner = makePlanner();

function planCount() {
  return Object.keys(workflowStore.read().plans).length;
}

test('a. 目标 → 计划落盘：有序步骤 + 能力要求 + 依赖，返回 planId/planVersion', () => {
  const result = planner.plan({ goal: '检索我上次说的偏好，并总结一下' });
  assert.equal(result.created, true);
  assert.match(result.planId, /^plan_pg_[0-9a-f]{32}$/);
  assert.equal(result.planVersion, 1);
  assert.equal(result.template, 'search_then_summarize');

  const frozen = workflowStore.getVersion(result.planId, result.planVersion);
  assert.equal(frozen.plan.steps.length, 2);
  const [search, summarize] = frozen.plan.steps;
  assert.equal(search.capability, 'memory.search');
  assert.equal(search.taskType, 'memory.search');
  assert.deepEqual(search.dependsOn, []);
  assert.equal(summarize.capability, 'memory.explain');
  assert.equal(summarize.taskType, 'memory.explain');
  assert.deepEqual(summarize.dependsOn, [search.stepKey]);
  assert.ok(summarize.stepKey !== search.stepKey);

  console.log('[Planner-a 计划落盘]', JSON.stringify({
    planId: result.planId,
    planVersion: result.planVersion,
    digest: result.digest,
    created: result.created,
    steps: frozen.plan.steps.map(step => ({
      stepKey: step.stepKey,
      label: step.label,
      goal: step.goal,
      capability: step.capability,
      taskType: step.taskType,
      dependsOn: step.dependsOn,
    })),
  }));
});

test('b. 计划 → 任务批量创建：共用同一计划版本，dependsOn 为真实 taskId', () => {
  const before = planCount();
  const result = planner.planAndCreate({
    goal: '检索并总结我去年的旅行偏好',
    agentId: 'memory',
  });
  assert.equal(result.planVersion, 1);
  assert.equal(result.order.length, 2);

  const upstream = tasks.getRawTask(result.tasks[result.order[0]].taskId);
  const downstream = tasks.getRawTask(result.tasks[result.order[1]].taskId);
  assert.equal(upstream.status, 'queued');
  assert.equal(downstream.status, 'queued');
  assert.deepEqual(upstream.dependsOn, []);
  assert.deepEqual(downstream.dependsOn, [upstream.taskId]);
  assert.equal(upstream.planId, result.planId);
  assert.equal(downstream.planId, result.planId);
  assert.equal(upstream.planVersion, result.planVersion);
  assert.equal(downstream.planVersion, result.planVersion);
  // pinned workflowPlan 复用已有版本：不因「每个任务各 append 一份单步计划」新增血缘。
  assert.equal(planCount(), before + 1, '整批任务只应新增 1 个计划血缘');

  console.log('[Planner-b 批量任务]', JSON.stringify({
    planId: result.planId,
    planVersion: result.planVersion,
    order: result.order,
    tasks: [
      {
        taskId: upstream.taskId,
        dependsOn: upstream.dependsOn,
        planId: upstream.planId,
        planVersion: upstream.planVersion,
        status: upstream.status,
      },
      {
        taskId: downstream.taskId,
        dependsOn: downstream.dependsOn,
        planId: downstream.planId,
        planVersion: downstream.planVersion,
        status: downstream.status,
      },
    ],
  }));
});

test('c. 拆不出来 → 显式失败（capability_not_found），零计划、零任务', () => {
  const plansBefore = planCount();
  const tasksBefore = tasks.allTasks().length;
  const error = (() => {
    try {
      planner.planAndCreate({ goal: '帮我写一首关于秋天的诗', agentId: 'memory' });
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(error, '必须显式失败，不许瞎编步骤');
  assert.equal(error.code, 'capability_not_found');
  assert.equal(error.status, 400);
  assert.equal(planCount(), plansBefore, '拆解失败不得写计划');
  assert.equal(tasks.allTasks().length, tasksBefore, '拆解失败不得建任务');

  console.log('[Planner-c 显式失败]', JSON.stringify({
    code: error.code,
    status: error.status,
    plansBefore,
    plansAfter: planCount(),
    tasksBefore,
    tasksAfter: tasks.allTasks().length,
  }));
});

test('d. 同一目标两次调用 → 取出同一版本；显式追加则旧版本内容不变', () => {
  const goal = '检索并总结我对咖啡的偏好';
  const first = planner.plan({ goal });
  const second = planner.plan({ goal });
  assert.equal(second.created, false);
  assert.equal(second.planId, first.planId);
  assert.equal(second.planVersion, first.planVersion);
  assert.equal(second.digest, first.digest);
  const headAfterSecond = workflowStore.getVersion(first.planId, first.planVersion);
  assert.equal(headAfterSecond.digest, first.digest, '同一 planId+版本不得内容漂移');

  const appended = planner.plan({ goal: '检索并总结我对茶的偏好', planId: first.planId });
  assert.equal(appended.created, true);
  assert.equal(appended.planId, first.planId);
  assert.equal(appended.planVersion, 2);
  const v1 = workflowStore.getVersion(first.planId, 1);
  const v2 = workflowStore.getVersion(first.planId, 2);
  assert.equal(v1.digest, first.digest, '追加不得改写历史版本');
  assert.notEqual(v2.digest, v1.digest);

  console.log('[Planner-d 版本语义]', JSON.stringify({
    planId: first.planId,
    firstCall: { created: first.created, planVersion: first.planVersion, digest: first.digest },
    secondCall: { created: second.created, planVersion: second.planVersion, digest: second.digest },
    appended: { created: appended.created, planVersion: appended.planVersion, digest: appended.digest },
    v1Digest: v1.digest,
    v2Digest: v2.digest,
  }));
});
