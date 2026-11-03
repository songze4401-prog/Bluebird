/* global module */
/**
 * 任务状态词表（单一导出，协议收敛 S2）。
 *
 * 权威定义：v1.2 §24.1 的十态固定集合。这里只定义"有哪些状态词"和旧值别名，
 * 不定义迁移边（合法边由 state-machine.js 声明），也不定义终态以外的语义。
 *
 * 过渡期约束（S2 零行为变化）：retrying / recovery 尚未接入写入路径，旧值
 * uncertain 仍会被写入，因此 TERMINAL_STATUSES 只列已启用的四个终态，
 * uncertain 通过 LEGACY_ALIASES 保留，待 S5 改名后再启用 recovery。
 */
const STATUSES = Object.freeze([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'retrying',
  'recovery',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

// 旧数据/旧客户端仍会写 uncertain；读边界一次性映射到 recovery（S5 落地）。
const LEGACY_ALIASES = Object.freeze({ uncertain: 'recovery' });
const LEGACY_STATUSES = Object.freeze(Object.keys(LEGACY_ALIASES));

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  LEGACY_ALIASES,
  LEGACY_STATUSES,
};
