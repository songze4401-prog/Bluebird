/* global module */
/**
 * 任务依赖（Phase 1 交付物 2「依赖管理」）。
 *
 * 本模块只做三件事，且都是纯函数/无 I/O：
 *   1. `isReady`：**唯一**的就绪判定实现。取队入口（tasks.nextQueuedTask）与
 *      runTask 前置校验都调用它，禁止在别处复制一份判断。
 *   2. `blockers`：把未就绪原因分成 缺失 / 终态失败 / 仍在等待 三类，
 *      供依赖失败收敛（settleDependencies）区分「等」与「判死」。
 *   3. `validateGraph`：批量编排落盘前的整图校验（条数上限、悬空引用、环检测）
 *      + 拓扑排序。校验通过前不写任何任务，因此环/悬空引用是整批零落盘。
 *
 * 错误码只复用既有六类语义，不新建错误码族：
 *   - `dependency_cycle`      → conflict（HTTP 409）
 *   - `dependency_not_found`  → validation_failed（HTTP 400）
 * 任务结果里的 `dependency_failed` / `dependency_cancelled` 是
 * 既有 `dependency_failed` 类的具体子因，不是新族（见台账「新增错误码清单」）。
 */
const { AgentError } = require('./errors');
const stateMachine = require('./state-machine');

const MAX_DEPENDENCIES = 8;

function dependencyIds(task) {
  return Array.isArray(task && task.dependsOn) ? task.dependsOn : [];
}

/**
 * 唯一就绪判定：所有依赖都存在且状态为 completed。
 * 空依赖视为就绪（保留单 Agent 快速路径）。
 */
function isReady(task, tasksById) {
  const deps = dependencyIds(task);
  if (!deps.length) return true;
  return deps.every(depTaskId => {
    const dep = tasksById ? tasksById[depTaskId] : null;
    return Boolean(dep && dep.status === 'completed');
  });
}

/**
 * 未就绪原因三分：
 *   missing  —— 依赖记录不存在（创建后被裁剪/数据损坏）
 *   failed   —— 依赖已到终态但未成功（含 cancelled，便于区分结果码）
 *   waiting  —— 依赖仍非终态（继续排队即可，不判死）
 */
function blockers(task, tasksById) {
  const missing = [];
  const failed = [];
  const waiting = [];
  for (const depTaskId of dependencyIds(task)) {
    const dep = tasksById ? tasksById[depTaskId] : null;
    if (!dep) {
      missing.push(depTaskId);
    } else if (dep.status === 'completed') {
      continue;
    } else if (stateMachine.isTerminal(dep.status)) {
      failed.push({ taskId: depTaskId, status: dep.status });
    } else {
      waiting.push(depTaskId);
    }
  }
  return { missing, failed, waiting };
}

function normalizeRefs(dependsOn) {
  if (!Array.isArray(dependsOn)) {
    throw new AgentError('dependency_not_found', 'dependsOn 必须是任务 id 数组', 400);
  }
  const refs = [];
  for (const value of dependsOn) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentError('dependency_not_found', 'dependsOn 只能包含非空任务 id', 400);
    }
    const ref = value.trim();
    if (refs.includes(ref)) {
      throw new AgentError('dependency_not_found', 'dependsOn 不能包含重复任务', 400);
    }
    refs.push(ref);
  }
  if (refs.length > MAX_DEPENDENCIES) {
    throw new AgentError(
      'dependency_not_found',
      `单个任务最多依赖 ${MAX_DEPENDENCIES} 个任务`,
      400
    );
  }
  return refs;
}

/**
 * 批量依赖图校验（零副作用）。
 *
 * @param {object} params
 * @param {Array<{key: string, dependsOn?: string[]}>} params.nodes
 *        dependsOn 的每一项可以是图内 key，也可以是已存在的 taskId。
 * @param {object} params.tasksById 已存在任务表（用于解析跨批次的 taskId 依赖）
 * @returns {{order: string[], refsByKey: Map<string,string[]>}}
 * @throws AgentError dependency_not_found(400) / dependency_cycle(409)
 */
function validateGraph({ nodes = [], tasksById = {} } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new AgentError('dependency_not_found', '依赖图至少需要一个节点', 400);
  }
  const byKey = new Map();
  const keySet = new Set();
  for (const node of nodes) {
    const key = node && typeof node.key === 'string' ? node.key.trim() : '';
    if (!key) {
      throw new AgentError('dependency_not_found', '依赖图节点必须有非空 key', 400);
    }
    if (keySet.has(key)) {
      throw new AgentError('dependency_not_found', `依赖图节点 key 重复：${key}`, 400);
    }
    keySet.add(key);
    // 先保留原始 dependsOn，统一交给 normalizeRefs 校验类型/空值/重复/上限。
    byKey.set(key, node.dependsOn === undefined ? [] : node.dependsOn);
  }
  for (const [key, rawRefs] of byKey.entries()) {
    const refs = normalizeRefs(rawRefs);
    for (const ref of refs) {
      const knownTask = Object.prototype.hasOwnProperty.call(tasksById, ref);
      if (!knownTask && !keySet.has(ref)) {
        throw new AgentError('dependency_not_found', `依赖引用不存在：${ref}`, 400);
      }
    }
    byKey.set(key, refs);
  }

  // Kahn 拓扑排序：只统计图内边；外部 taskId 依赖不参与排序。
  const indegree = new Map();
  const edges = new Map();
  for (const key of byKey.keys()) {
    indegree.set(key, 0);
    edges.set(key, []);
  }
  for (const [key, refs] of byKey.entries()) {
    for (const ref of refs) {
      if (!byKey.has(ref)) continue;
      indegree.set(key, indegree.get(key) + 1);
      edges.get(ref).push(key);
    }
  }
  const ready = [...byKey.keys()].filter(key => indegree.get(key) === 0);
  const order = [];
  while (ready.length) {
    const key = ready.shift();
    order.push(key);
    for (const next of edges.get(key)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== byKey.size) {
    const cycleKeys = [...byKey.keys()].filter(key => !order.includes(key));
    throw new AgentError(
      'dependency_cycle',
      `依赖图存在环：${cycleKeys.join(' -> ')}`,
      409,
      { cycle: cycleKeys, retryable: false }
    );
  }
  return { order, refsByKey: byKey };
}

/**
 * A-10 / §17 死锁检测（纯函数、无 I/O）：在非终态任务之间连边
 * （A dependsOn B 且 B 仍非终态 → A 等 B），DFS 找出处在环上的任务。
 * 只返回环成员，不落盘；由调用方按既有终态语义收口（不新增状态）。
 *
 * @returns {string[]} 去重且稳定排序的 taskId 列表；无环返回 []
 */
function detectDeadlocks(tasksById = {}) {
  const graph = new Map();
  for (const task of Object.values(tasksById || {})) {
    if (!task || typeof task.taskId !== 'string') continue;
    if (stateMachine.isTerminal(task.status)) continue;
    const deps = dependencyIds(task);
    if (!deps.length) continue;
    graph.set(task.taskId, deps);
  }
  const color = new Map(); // 0/undefined=未访问，1=栈内，2=已完成
  const stack = [];
  const cycleNodes = new Set();
  const visit = taskId => {
    color.set(taskId, 1);
    stack.push(taskId);
    for (const depTaskId of graph.get(taskId) || []) {
      // 依赖不在非终态图内（已终态/不存在）说明等待对象不会回指，不构成互等。
      if (!graph.has(depTaskId)) continue;
      const depColor = color.get(depTaskId) || 0;
      if (depColor === 1) {
        const start = stack.indexOf(depTaskId);
        for (let i = start; i < stack.length; i += 1) cycleNodes.add(stack[i]);
      } else if (depColor === 0) {
        visit(depTaskId);
      }
    }
    stack.pop();
    color.set(taskId, 2);
  };
  for (const taskId of graph.keys()) {
    if ((color.get(taskId) || 0) === 0) visit(taskId);
  }
  return [...cycleNodes].sort();
}

module.exports = {
  MAX_DEPENDENCIES,
  isReady,
  blockers,
  normalizeRefs,
  validateGraph,
  detectDeadlocks,
};
