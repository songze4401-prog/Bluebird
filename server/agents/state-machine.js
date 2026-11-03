/* global module */
/**
 * 任务状态机（阶段 3）。
 *
 * 迁移合法性定义（不是状态事实源）：任务状态只能沿这里声明的边变化。
 * 状态事实源是 task-store 的持久化记录；事件（appendEvent）仅通知/审计，
 * 不拥有事实权威。`recovery` 是正式终态：进程中断时无法判断副作用是否
 * 已发生的任务进入该状态等待人工核对，永不自动当作成功。
 */
const { AgentError } = require('./errors');
const vocabulary = require('./status-vocabulary');

// S5：状态集合取 §24.1 十态；`retrying` 仅入词表，暂无写入者（S7 再补边）。
const STATUSES = Object.freeze([...vocabulary.STATUSES]);

const TERMINAL = new Set([...vocabulary.TERMINAL_STATUSES]);

const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['accepted', 'cancelled', 'waiting_approval']),
  accepted: Object.freeze([
    'running',
    'queued',
    'waiting_approval',
    'completed',
    'cancelled',
    'failed',
    'timed_out',
    'recovery',
  ]),
  running: Object.freeze([
    'waiting_approval',
    'queued',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'recovery',
  ]),
  waiting_approval: Object.freeze(['completed', 'failed', 'cancelled', 'recovery']),
  retrying: Object.freeze([]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  timed_out: Object.freeze([]),
  recovery: Object.freeze([]),
});

function isTerminal(status) {
  return TERMINAL.has(status);
}

function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertTransition(from, to) {
  if (!STATUSES.includes(to)) {
    throw new AgentError('invalid_task_status', '任务状态无效');
  }
  if (!canTransition(from, to)) {
    throw new AgentError(
      'invalid_transition',
      `任务状态不能从 ${from || 'unknown'} 迁移到 ${to}`,
      409
    );
  }
}

// accepted / running 是进程中断后需要恢复的中间态；waiting_approval 是人工暂停。
function isRecoverable(status) {
  return status === 'accepted' || status === 'running';
}

module.exports = {
  STATUSES,
  TERMINAL,
  TRANSITIONS,
  isTerminal,
  canTransition,
  assertTransition,
  isRecoverable,
};
