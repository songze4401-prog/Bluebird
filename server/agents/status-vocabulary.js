/* global module */
/**
 * 任务状态词表（单一导出，协议收敛 S2 / S5）。
 *
 * 权威定义：v1.2 §24.1 的十态固定集合。这里只定义"有哪些状态词"和旧值别名，
 * 不定义迁移边（合法边由 state-machine.js 声明），也不定义终态以外的语义。
 *
 * S5 起 `recovery` 是正式终态（旧值 `uncertain` 只在读边界一次性映射），
 * `retrying` 仅入词表，写入逻辑留待 S7。
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
  'recovery',
]);

// 旧数据/旧客户端仍会写 uncertain；读边界一次性映射到 recovery，不回写文件。
const LEGACY_ALIASES = Object.freeze({ uncertain: 'recovery' });

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  LEGACY_ALIASES,
};
