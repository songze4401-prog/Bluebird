/* 记忆生命周期状态与时间窗口规则（纯函数，不含 IO） */
const STATUS_ACTIVE = 'active';
const STATUS_PENDING = 'pending';
const STATUS_CONTESTED = 'contested';
const STATUS_SUPERSEDED = 'superseded';
const STATUS_ARCHIVED = 'archived';

// retracted / deleted 是操作结果，不作为持久状态保存：
// - 撤回来源贡献后条目仍有贡献 → 条目继续存在；
// - 贡献被摘空或用户彻底删除 → 物理删除条目。
const STATUSES = Object.freeze([
  STATUS_ACTIVE,
  STATUS_PENDING,
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
]);

const TRANSITIONS = Object.freeze({
  [STATUS_PENDING]: [STATUS_ACTIVE, STATUS_CONTESTED, STATUS_ARCHIVED, 'deleted'],
  [STATUS_ACTIVE]: [STATUS_SUPERSEDED, STATUS_CONTESTED, STATUS_ARCHIVED, 'deleted'],
  [STATUS_CONTESTED]: [STATUS_ACTIVE, STATUS_SUPERSEDED, STATUS_ARCHIVED, 'deleted'],
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

// 不可见原因分类（P2 可观测性）：只用于解释「为什么这条记忆没进候选池」。
// 与 isEffectiveAt 严格互补——isEffectiveAt 为 true 时本函数返回 null。
// 撤回 / 删除是操作结果而非持久状态（见文件头注释），条目已被物理删除，
// 检索层看不到它们，因此这里不存在 'withdrawn' 分支。
const INEFFECTIVE_REASONS = Object.freeze({
  PENDING: 'pending',
  CONTESTED: 'contested',
  SUPERSEDED: 'superseded',
  ARCHIVED: 'archived',
  WITHDRAWN: 'withdrawn',
  NOT_YET_VALID: 'not_yet_valid',
  EXPIRED: 'expired',
  UNKNOWN_STATUS: 'unknown_status',
});

function classifyIneffective(item, at = Date.now()) {
  if (!item) return INEFFECTIVE_REASONS.UNKNOWN_STATUS;

  const status = item.status;

  if (status === STATUS_PENDING) return INEFFECTIVE_REASONS.PENDING;
  if (status === STATUS_CONTESTED) return INEFFECTIVE_REASONS.CONTESTED;
  if (status === STATUS_SUPERSEDED) return INEFFECTIVE_REASONS.SUPERSEDED;
  if (status === STATUS_ARCHIVED) {
    return item.withdrawnAt
      ? INEFFECTIVE_REASONS.WITHDRAWN
      : INEFFECTIVE_REASONS.ARCHIVED;
  }

  if (!isActiveStatus(item)) return INEFFECTIVE_REASONS.UNKNOWN_STATUS;

  const from = parseTimestamp(item.validFrom);
  if (from !== null && from > at) return INEFFECTIVE_REASONS.NOT_YET_VALID;

  const to = parseTimestamp(item.validTo);
  if (to !== null && to <= at) return INEFFECTIVE_REASONS.EXPIRED;

  return null;
}

// 历史视图：包含当时有效、后来被取代或归档的条目；不包含 pending。
function isHistoricalAt(item, at = Date.now()) {
  const status = item && item.status;

  if (
    status !== undefined &&
    status !== null &&
    status !== STATUS_ACTIVE &&
    status !== STATUS_CONTESTED &&
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
  STATUS_CONTESTED,
  STATUS_SUPERSEDED,
  STATUS_ARCHIVED,
  STATUSES,
  TRANSITIONS,
  isActiveStatus,
  isPending,
  parseTimestamp,
  isEffectiveAt,
  classifyIneffective,
  INEFFECTIVE_REASONS,
  isHistoricalAt,
  canTransition,
};