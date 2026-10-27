/* 记忆生命周期状态与时间窗口规则（纯函数，不含 IO） */
const STATUS_ACTIVE = 'active';
const STATUS_PENDING = 'pending';
const STATUS_SUPERSEDED = 'superseded';
const STATUS_ARCHIVED = 'archived';

// retracted / deleted 是操作结果，不作为持久状态保存：
// - 撤回来源贡献后条目仍有贡献 → 条目继续存在；
// - 贡献被摘空或用户彻底删除 → 物理删除条目。
const STATUSES = Object.freeze([
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
]);

const TRANSITIONS = Object.freeze({
  [STATUS_PENDING]: [STATUS_ACTIVE, 'deleted'],
  [STATUS_ACTIVE]: [STATUS_SUPERSEDED, STATUS_ARCHIVED, 'deleted'],
  [STATUS_SUPERSEDED]: [STATUS_ARCHIVED, 'deleted'],
  [STATUS_ARCHIVED]: ['deleted'],
});

function isActiveStatus(item) {
  const status = item && item.status;

  return status === undefined || status === null || status === STATUS_ACTIVE;
}

function isPending(item) {
  return Boolean(item && item.status === STATUS_PENDING);
}

function parseTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const time = new Date(value).getTime();

  return Number.isFinite(time) ? time : null;
}

function isEffectiveAt(item, at = Date.now()) {
  if (!isActiveStatus(item)) return false;

  const from = parseTimestamp(item.validFrom);
  if (from !== null && from > at) return false;

  const to = parseTimestamp(item.validTo);
  if (to !== null && to <= at) return false;

  return true;
}

// 历史视图：包含当时有效、后来被取代或归档的条目；不包含 pending。
function isHistoricalAt(item, at = Date.now()) {
  const status = item && item.status;

  if (
    status !== undefined &&
    status !== null &&
    status !== STATUS_ACTIVE &&
    status !== STATUS_SUPERSEDED &&
    status !== STATUS_ARCHIVED
  ) {
    return false;
  }

  const from = parseTimestamp(item.validFrom);
  if (from !== null && from > at) return false;

  const to = parseTimestamp(item.validTo);
  if (to !== null && to <= at) return false;

  return true;
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];

  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
  STATUSES,
  TRANSITIONS,
  isActiveStatus,
  isPending,
  parseTimestamp,
  isEffectiveAt,
  isHistoricalAt,
  canTransition,
};