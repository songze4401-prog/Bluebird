/* global require, process, __dirname */
/**
 * §16 污点 → 工具阻断策略（版本化）。
 *
 * 原文只写「污染内容不得解锁特权工具、扩大 allowedTools、修改审批要求或触发更高权限动作」，
 * 没有给出标签取值、等级与工具映射。本文件的规则表是**本仓库裁决的安全默认值**，
 * 不是 Notion 原文标准；每次判定都会带上命中的 `policyVersion` 与 `ruleId`，便于事后追溯。
 *
 * 设计口径：
 * - 策略只做 **AND**（收窄）：调用方必须先通过原有的 allowedTools / 来源链检查；
 * - 未命中任何规则 → 拒绝（fail-closed）；
 * - 规则可版本化替换；旧产物保留其落盘时的 `taintPolicyVersion`，不回写。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../atomic-write');

const DEFAULT_POLICY_VERSION = 'taint-policy-v1';
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.resolve(__dirname, '../../.data');
const POLICY_FILE = String(
  process.env.BLUEBIRD_TAINT_POLICY_FILE || path.join(DATA_DIR, 'agent-taint-policies.json')
).trim();

const TRUSTED_LABELS = Object.freeze(['verified']);
const UNTRUSTED_LABELS = Object.freeze(['unknown', 'unverified']);
const UNTRUSTED_PREFIXES = Object.freeze(['external:']);

const DEFAULT_RULES = Object.freeze([
  {
    id: 'no-taint-allow',
    when: { taint: 'empty' },
    effect: 'allow',
  },
  {
    id: 'verified-allow',
    when: { taint: 'trusted' },
    effect: 'allow',
  },
  {
    id: 'untrusted-read-only-allow',
    when: { taint: 'untrusted', readOnly: true },
    effect: 'allow',
  },
  {
    id: 'untrusted-side-effect-deny',
    when: { taint: 'untrusted', readOnly: false },
    effect: 'deny',
  },
]);

function ensureDir() {
  fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
}

function defaultStore() {
  return {
    policyVersion: 1,
    policyLabel: DEFAULT_POLICY_VERSION,
    rules: DEFAULT_RULES.map(rule => ({ ...rule, when: { ...rule.when } })),
    history: [
      {
        policyVersion: 1,
        policyLabel: DEFAULT_POLICY_VERSION,
        effectiveFrom: '2026-11-05T00:00:00.000Z',
        retiredAt: null,
        ruleIds: DEFAULT_RULES.map(rule => rule.id),
        note: '本仓库裁决的默认安全值，非 Notion 原文标准',
      },
    ],
  };
}

function readStore() {
  let raw;
  try {
    raw = fs.readFileSync(POLICY_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultStore();
    return defaultStore();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
      return defaultStore();
    }
    return parsed;
  } catch (_) {
    return defaultStore();
  }
}

function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const out = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') return null;
    if (typeof rule.id !== 'string' || !rule.id.trim()) return null;
    if (rule.effect !== 'allow' && rule.effect !== 'deny') return null;
    const when = rule.when && typeof rule.when === 'object' ? rule.when : {};
    if (when.taint && !['empty', 'trusted', 'untrusted', 'any'].includes(when.taint)) {
      return null;
    }
    if (when.readOnly !== undefined && when.readOnly !== null && typeof when.readOnly !== 'boolean') {
      return null;
    }
    out.push({
      id: rule.id.trim().slice(0, 80),
      effect: rule.effect,
      when: {
        ...(when.taint ? { taint: when.taint } : {}),
        ...(when.readOnly !== undefined && when.readOnly !== null
          ? { readOnly: when.readOnly }
          : {}),
      },
    });
  }
  return out;
}

function currentPolicyVersion() {
  return readStore().policyLabel || DEFAULT_POLICY_VERSION;
}

function listVersions() {
  const store = readStore();
  return Array.isArray(store.history) ? store.history.map(entry => ({ ...entry })) : [];
}

function currentRules() {
  const store = readStore();
  return (store.rules || []).map(rule => ({ ...rule, when: { ...(rule.when || {}) } }));
}

/**
 * 产出一个新版本记录：旧版本写 `retiredAt`（失效记录），新版本带完整规则快照。
 * 只有规则集变化才产生新版本；这是本仓库的版本记录机制（与 failopen 策略一致）。
 */
function createVersion({ rules, note = null, now = Date.now() } = {}) {
  const cleanRules = normalizeRules(rules);
  if (!cleanRules) {
    return { ok: false, error: 'invalid_rules' };
  }
  const store = readStore();
  const nextVersion = Number(store.policyVersion || 1) + 1;
  const stamp = new Date(now).toISOString();
  const history = Array.isArray(store.history) ? store.history.slice() : [];
  for (const entry of history) {
    if (!entry.retiredAt) entry.retiredAt = stamp;
  }
  history.push({
    policyVersion: nextVersion,
    policyLabel: `taint-policy-v${nextVersion}`,
    effectiveFrom: stamp,
    retiredAt: null,
    ruleIds: cleanRules.map(rule => rule.id),
    note: note ? String(note).slice(0, 200) : null,
  });
  const nextStore = {
    policyVersion: nextVersion,
    policyLabel: `taint-policy-v${nextVersion}`,
    rules: cleanRules,
    history,
  };
  ensureDir();
  writeFileAtomicSync(POLICY_FILE, JSON.stringify(nextStore, null, 2));
  try {
    fs.chmodSync(POLICY_FILE, 0o600);
  } catch (_) {
    // 权限收紧失败不影响策略语义
  }
  return { ok: true, policyVersion: nextStore.policyLabel, policyVersionNumber: nextVersion };
}

function isUntrusted(label) {
  return UNTRUSTED_LABELS.includes(label) || UNTRUSTED_PREFIXES.some(prefix => label.startsWith(prefix));
}

function isTrusted(label) {
  return (
    TRUSTED_LABELS.includes(label) ||
    label.startsWith('agent:') ||
    label.startsWith('internal:') ||
    // `tool:*` 是"由哪个内部工具产出"的身份标签（如 tool:memory_search），
    // 与内容是否可信无关；外部工具内容用 `external:tool` 表达。
    // 若不把身份标签归为可信侧，一次成功的只读工具调用会让自己后续的
    // 只读重试变成 unclassified 而被 fail-closed 拒绝。
    label.startsWith('tool:')
  );
}

function classify(labels) {
  if (labels.length === 0) return 'empty';
  if (labels.some(isUntrusted)) return 'untrusted';
  if (labels.every(isTrusted)) return 'trusted';
  return 'unclassified';
}

function ruleMatches(rule, context) {
  const when = rule.when || {};
  if (when.taint && when.taint !== 'any' && when.taint !== context.taintClass) return false;
  if (when.readOnly === true && context.tool.readOnly !== true) return false;
  if (when.readOnly === false && context.tool.readOnly !== false) return false;
  return true;
}

/**
 * 纯判定：不写盘、不修改入参。
 *
 * @returns {{ allowed:boolean, ruleId:string, policyVersion:string, taintClass:string, reason:string }}
 */
function evaluate({ taintLabels = [], tool = {}, now = Date.now() } = {}) {
  const labels = Array.isArray(taintLabels)
    ? taintLabels.filter(label => typeof label === 'string' && label.trim()).map(label => label.trim())
    : [];
  const rules = currentRules();
  const version = currentPolicyVersion();
  const toolInfo = {
    name: typeof tool.name === 'string' ? tool.name : '',
    readOnly: tool.readOnly === true,
    readOnlyKnown: typeof tool.readOnly === 'boolean',
    risk: tool.risk || 'unknown',
  };
  const taintClass = classify(labels);
  const context = { labels, taintClass, tool: toolInfo };

  for (const rule of rules) {
    if (!ruleMatches(rule, context)) continue;
    const allowed = rule.effect === 'allow';
    return {
      allowed,
      ruleId: rule.id,
      policyVersion: version,
      taintClass,
      reason: allowed ? 'allowed_by_rule' : 'denied_by_rule',
      evaluatedAt: now,
    };
  }
  return {
    allowed: false,
    ruleId: 'unclassified-fail-closed',
    policyVersion: version,
    taintClass,
    reason: 'no_rule_matched_fail_closed',
    evaluatedAt: now,
  };
}

module.exports = {
  DEFAULT_POLICY_VERSION,
  POLICY_FILE,
  DEFAULT_RULES,
  currentPolicyVersion,
  currentRules,
  listVersions,
  createVersion,
  evaluate,
  classify,
};
