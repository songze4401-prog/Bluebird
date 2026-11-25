'use strict';

/**
 * 模型 Token 估算校准（model-calibration.js）
 *
 * 估算器 heuristic-cjk-ascii-v1 不是目标模型的真分词器。本模块只做一件事：
 * 把「Provider 真实回传的 prompt_tokens」与「同一次请求的估算输入 Token」配对
 * 记账，按 provider+model 求中位比值，供 Context Runtime 保守放大后续估算。
 *
 * 边界（刻意不做）：
 * - 不编造模型上下文窗口，也不因为「有了校准」就放大窗口；
 * - 比值只用于放大（clamp 到 1–3），绝不把估算调低后去顶窗口；
 * - 只认真实 Provider 的 usage：stub / 缺 usage / 非正数一律不记账；
 * - 存储损坏时按「无校准」降级，不抛、不覆盖用户数据以外的文件。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');
const CALIBRATION_FILE = path.join(DATA_DIR, 'model-calibration.json');

const SCHEMA_VERSION = 1;
const MAX_SAMPLES = 20;
// 单样本超过这个倍率说明这次请求与估算口径不同（例如工具预留、缓存命中），
// 记录为丢弃但不入库，避免一次异常把整条链路的估算拉飞。
const MAX_SAMPLE_RATIO = 8;
const APPLIED_MIN = 1;
const APPLIED_MAX = 3;

let cache = null;
let cacheForDir = null;
let corrupted = false;

function keyFor(providerId, modelId) {
  return `${String(providerId || '').trim()}|${String(modelId || '').trim()}`;
}

function load() {
  if (cache && cacheForDir === DATA_DIR) return cache;
  corrupted = false;
  cacheForDir = DATA_DIR;
  cache = { version: SCHEMA_VERSION, entries: {} };
  try {
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.entries &&
      typeof parsed.entries === 'object' &&
      !Array.isArray(parsed.entries)
    ) {
      cache = { version: SCHEMA_VERSION, entries: parsed.entries };
    } else {
      corrupted = true;
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') corrupted = true;
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CALIBRATION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
    fs.renameSync(tmp, CALIBRATION_FILE);
    return true;
  } catch (_) {
    return false;
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundRatio(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}

/**
 * 记一次真实对照。返回 { recorded, ratio|null, sampleCount|null, reason|null }。
 * reason 只使用有限短码，便于监控聚合，不含请求正文。
 */
function observe({ providerId, modelId, providerKind, promptTokens, estimatedInputTokens } = {}) {
  const usable =
    providerKind === 'provider' &&
    Number.isFinite(promptTokens) &&
    promptTokens > 0 &&
    Number.isFinite(estimatedInputTokens) &&
    estimatedInputTokens > 0 &&
    String(modelId || '').trim();
  if (!usable) {
    return {
      recorded: false,
      ratio: null,
      sampleCount: null,
      reason: providerKind === 'stub' ? 'stub_usage' : 'usage_unusable',
    };
  }

  const ratio = promptTokens / estimatedInputTokens;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > MAX_SAMPLE_RATIO) {
    return { recorded: false, ratio: roundRatio(ratio), sampleCount: null, reason: 'ratio_out_of_range' };
  }

  const state = load();
  const key = keyFor(providerId, modelId);
  const entry = state.entries[key] || { modelId: String(modelId).trim(), samples: [] };
  const samples = Array.isArray(entry.samples) ? entry.samples.slice() : [];
  samples.push(roundRatio(ratio));
  while (samples.length > MAX_SAMPLES) samples.shift();

  const next = {
    ...entry,
    samples,
    ratio: roundRatio(median(samples)),
    sampleCount: samples.length,
    firstObservedAt: entry.firstObservedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.entries[key] = next;
  const saved = persist();
  return {
    recorded: saved,
    ratio: next.ratio,
    sampleCount: next.sampleCount,
    reason: saved ? null : 'persist_failed',
  };
}

/**
 * 该模型当前应施加的估算放大系数（>=1）。无样本时返回 1（不改变既有口径）。
 */
function factorFor({ providerId, modelId } = {}) {
  const view = viewFor({ providerId, modelId });
  if (!view) return APPLIED_MIN;
  return Math.min(Math.max(view.ratio, APPLIED_MIN), APPLIED_MAX);
}

/** trace / 监控用的只读视图；无数据返回 null，不编造。 */
function viewFor({ providerId, modelId } = {}) {
  const state = load();
  const entry = state.entries[keyFor(providerId, modelId)];
  if (!entry || !Array.isArray(entry.samples) || !entry.samples.length) return null;
  const ratio = Number.isFinite(entry.ratio) ? entry.ratio : median(entry.samples);
  if (!Number.isFinite(ratio)) return null;
  return {
    ratio: roundRatio(ratio),
    appliedFactor: Math.min(Math.max(ratio, APPLIED_MIN), APPLIED_MAX),
    sampleCount: entry.samples.length,
    updatedAt: entry.updatedAt || null,
    firstObservedAt: entry.firstObservedAt || null,
    source: 'provider_usage',
  };
}

function status() {
  load();
  const state = cache || { entries: {} };
  return {
    file: CALIBRATION_FILE,
    entries: Object.keys(state.entries).length,
    corrupted,
  };
}

// 仅测试用：清掉进程内缓存，让切换 BLUEBIRD_DATA_DIR 的用例读到自己的文件。
function _resetCacheForTests() {
  cache = null;
  cacheForDir = null;
  corrupted = false;
}

module.exports = {
  CALIBRATION_FILE,
  MAX_SAMPLES,
  APPLIED_MIN,
  APPLIED_MAX,
  observe,
  factorFor,
  viewFor,
  status,
  _resetCacheForTests,
};
