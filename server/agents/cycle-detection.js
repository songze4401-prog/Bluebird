/* global module */
/**
 * §17 循环检测（Agent 委派图 / Artifact 引用与 lineage 图）。
 *
 * 原文要求：新增 dependsOn 或 artifact reference 前检查是否成环；对间接引用
 * 做传递闭包检查；检测到即拒绝，并给出可读环路。另要求设置图规模与检测时间
 * 上限，避免检测本身造成 DoS（具体上限数值原文未定义，此处取保守默认值，待确认）。
 *
 * 本模块只做纯图检测，不拥有任务或产物事实；任务依赖图仍由 dependencies.js 负责。
 */
const { AgentError } = require('./errors');

const MAX_GRAPH_NODES = 2000;
const MAX_DETECT_MS = 100;
// 单个节点的出边上限沿用产物引用规模的安全默认值（避免展开爆炸）。
const MAX_EDGES_PER_NODE = 20;

function limitExceeded(kind) {
  return new AgentError('validation_failed', `循环检测超出${kind}上限，拒绝本次写入`, 400, {
    causeRef: 'cycle_check_limit_exceeded',
  });
}

function readablePath(ids) {
  return ids.join(' -> ');
}

/**
 * 沿 parentTaskId 上行，返回可读闭环（首尾为同一 taskId），无环返回 null。
 */
function findDelegationCycle(
  startTaskId,
  tasksById,
  { maxNodes = MAX_GRAPH_NODES } = {}
) {
  const tasks = tasksById && typeof tasksById === 'object' ? tasksById : {};
  const seen = new Set();
  const path = [];
  let cursor = String(startTaskId || '');
  while (cursor) {
    if (path.length >= maxNodes) throw limitExceeded('图规模');
    if (seen.has(cursor)) return [...path, cursor];
    seen.add(cursor);
    path.push(cursor);
    const task = tasks[cursor];
    if (!task || !task.parentTaskId) return null;
    cursor = String(task.parentTaskId);
  }
  return null;
}

/**
 * 对委派链做传递闭包检查：检测到环即抛 not_authorized，并给出完整路径。
 */
function assertDelegationAcyclic(startTaskId, tasksById, options = {}) {
  const cycle = findDelegationCycle(startTaskId, tasksById, options);
  if (!cycle) return null;
  throw new AgentError(
    'not_authorized',
    `委派链存在环，拒绝继续委派：${readablePath(cycle)}`,
    403,
    { causeRef: 'delegation_cycle', cycle: readablePath(cycle) }
  );
}

/**
 * Artifact 引用 / lineage 图：从 startId 沿 evidence 引用做 DFS，返回闭环或 null。
 * readArtifact(id) 返回 {content}（与 artifact-store.readContent 同形）；读不回来
 * 视作链断开（本函数只负责成环检测，不替证据链完整性下结论）。
 */
function findLineageCycle(
  startId,
  readArtifact,
  { maxNodes = MAX_GRAPH_NODES, maxMs = MAX_DETECT_MS } = {}
) {
  const startedAt = Date.now();
  const visiting = new Set();
  const done = new Set();
  const stack = [];

  const edgesOf = id => {
    try {
      const record = readArtifact(id);
      const evidence = record && record.content && record.content.evidence;
      if (!Array.isArray(evidence)) return [];
      return evidence
        .map(item => (item && item.id ? String(item.id) : ''))
        .filter(Boolean)
        .slice(0, MAX_EDGES_PER_NODE);
    } catch (_) {
      return [];
    }
  };

  const dfs = id => {
    if (Date.now() - startedAt > maxMs || done.size + visiting.size > maxNodes) {
      throw limitExceeded('图规模或检测时间');
    }
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      return [...stack.slice(index === -1 ? 0 : index), id];
    }
    if (done.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const next of edgesOf(id)) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };

  return dfs(String(startId || ''));
}

/**
 * 新增 artifact reference 前的传递闭包检查：检测到环即抛 validation_failed
 * （输入引用图不合法，属 §23 validation_failed；原文未定义具体错误码，待确认）。
 */
function assertLineageAcyclic(startId, readArtifact, options = {}) {
  const cycle = findLineageCycle(startId, readArtifact, options);
  if (!cycle) return null;
  throw new AgentError(
    'validation_failed',
    `Artifact lineage 存在环，拒绝新增引用：${readablePath(cycle)}`,
    400,
    { causeRef: 'lineage_cycle', cycle: readablePath(cycle) }
  );
}

module.exports = {
  MAX_GRAPH_NODES,
  MAX_DETECT_MS,
  MAX_EDGES_PER_NODE,
  findDelegationCycle,
  assertDelegationAcyclic,
  findLineageCycle,
  assertLineageAcyclic,
};
