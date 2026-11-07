/* global module */
/**
 * Phase 4 第 1 项：策略版本与灰度的最小机制。
 *
 * 只做三件事：版本标识（version）、一个开关（enabled）、回滚（rollback）。
 * 状态与任务库同目录，复用既有数据目录；不建路由、不建灰度发布系统。
 */
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');

const DEFAULT_STATE = { version: 'p4-default', enabled: true, previousVersion: null };
const HISTORY_MAX = 10;

function statePath() {
  return path.join(path.dirname(tasks.TASKS_FILE), 'strategy-version.json');
}

function normalize(state) {
  const version = String((state && state.version) || '').trim();
  const previous = state && state.previousVersion ? String(state.previousVersion) : null;
  const gray = state && state.gray && Number.isFinite(Number(state.gray.ratio))
    ? { ratio: Math.max(0, Math.min(1, Number(state.gray.ratio))), updatedAt: state.gray.updatedAt || null }
    : null;
  return {
    version: version || DEFAULT_STATE.version,
    enabled: state && state.enabled === false ? false : true,
    previousVersion: previous,
    // P5-G：灰度比例（0..1）。null 表示未在灰度中（全量语义）。
    gray,
    updatedAt: (state && state.updatedAt) || null,
    history: Array.isArray(state && state.history) ? state.history.slice(-HISTORY_MAX) : [],
  };
}

function get() {
  const file = statePath();
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return normalize(DEFAULT_STATE);
  }
}

function save(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return normalize(state);
}

function assertVersion(version) {
  const clean = String(version || '').trim();
  if (!clean || clean.length > 64) {
    throw new Error('策略版本标识必须是 1 到 64 字的非空字符串');
  }
  return clean;
}

function apply({ version, enabled = true, now = new Date().toISOString() } = {}) {
  const current = get();
  const next = assertVersion(version);
  const state = {
    version: next,
    enabled: enabled !== false,
    previousVersion: current.version,
    // 换版本即清灰度：新版本的灰度比例由发布方重新声明，不继承旧桶。
    gray: null,
    updatedAt: now,
    history: [
      ...current.history,
      { from: current.version, to: next, enabled: enabled !== false, at: now },
    ].slice(-HISTORY_MAX),
  };
  return save(state);
}

function setEnabled(enabled, { now = new Date().toISOString() } = {}) {
  const current = get();
  const state = { ...current, enabled: enabled === true, updatedAt: now };
  return save(state);
}

// P5-G：灰度比例落版本状态；回滚/换版本时由 apply 清空灰度（新版本重新定比例）。
function setGray({ ratio, now = new Date().toISOString() } = {}) {
  const current = get();
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('gray ratio 必须在 (0, 1] 区间');
  }
  return save({ ...current, gray: { ratio: value, updatedAt: now }, updatedAt: now });
}

/**
 * P5-G：按实体判灰度。状态关着 → 永远 false；没有灰度配置 → 全量语义；
 * 有灰度 → 确定性哈希落桶（分桶函数由调用方 improvement-loop 提供，避免循环依赖）。
 * 未提供分桶函数时按保守处理：不在桶内（宁可不启用，不越权灰度）。
 */
function isEnabledFor(entityId, { isInBucket = null } = {}) {
  const state = get();
  if (!state.enabled) return false;
  if (!state.gray) return true;
  const ratio = state.gray.ratio;
  if (ratio >= 1) return true;
  if (typeof isInBucket === 'function') return isInBucket(entityId, ratio) === true;
  return false;
}

function rollback({ now = new Date().toISOString() } = {}) {
  const current = get();
  if (!current.previousVersion) {
    throw new Error('没有可回滚的策略版本');
  }
  return apply({ version: current.previousVersion, enabled: true, now });
}

module.exports = { DEFAULT_STATE, statePath, get, apply, setEnabled, setGray, isEnabledFor, rollback };
