/* global module, __dirname */
/**
 * Workflow Store（Phase 1 / C1）：任务计划的血缘存储。
 *
 * 只提供存储能力：schema、不可变版本、引用（pin）、裁剪、上限拒绝。
 * C1 刻意**不接线**——router.createTask 仍写 null，启动恢复仍不解析；
 * 接线在 C2，真崩溃注入在 C3。这一步先把「版本怎么算、谁能删、超限怎么拒」钉死并测稳。
 *
 * 为什么独立文件而不是塞进 agent-tasks.json：
 * - 写放大：任务每次状态迁移与每轮 checkpoint 都会重写整份任务文件，
 *   计划若放进去会被顺带重写十几次；独立文件只在计划变更时写（1–2 次/任务）。
 * - 容量连坐：TASK_MAX=500 裁剪已投递终态任务时，会把仍在运行任务的计划一起删掉。
 * 为什么不做「一计划一文件」：恢复要目录扫描、跨版本/引用没有单文件原子性。
 *
 * 不可变版本：appendVersion 只追加，永不原地改。所谓「回退」= 追加一个内容等于旧版的
 * 新版本（版本号仍 +1），因此磁盘上不会出现「同一版本号对应两份内容」。
 *
 * 版本语义（与 11.7 对齐）：
 * - planVersion 是**内容版本**，只由本模块分配；它绝不参与 CAS、不参与幂等键、
 *   不参与 checkpoint 序号。并发口径只有 stateVersion 一个（在 tasks.js）。
 * - 解析计划时绝不比对 headVersion 判断「是否最新」；任务只认自己的 (planId, planVersion)。
 * - 调用方不能自增 planVersion，也不能把它当 expectedVersion 传给别人。
 *
 * 裁剪三重校验（任何一条不满足都不裁）：
 *  1) 被任意任务引用（含已终态、含 recovery）的版本不得裁剪；
 *  2) 裁剪前重扫引用：Store 的 refs + 调用方传入的 liveRefs（任务文件现场扫描）；
 *  3) 审计先写后删：审计落盘成功之后才从 Store 删除。
 *
 * 单写者假设：本模块是 read-modify-write，多进程并发写没有保证；
 * 与 agent-tasks.json 一样由进程启动时的单实例锁兜底。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');
const opLedger = require('./op-ledger');
const crashHook = require('./crash-hook');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const WORKFLOW_FILE = path.join(AGENTS_DIR, 'agent-workflows.json');
const AUDIT_FILE = path.join(AGENTS_DIR, 'agent-workflow-audit.json');

const SCHEMA_VERSION = 1;
const AUDIT_SCHEMA_VERSION = 1;

// A 类：硬上限，超过即拒绝落盘（任务不创建，磁盘上不留半截）。
const PLAN_MAX_BYTES = 8192;
const MAX_STEPS = 32;
const STEP_MAX_BYTES = 1024;
const PLAN_ID_MAX = 80;
const TOOL_NAME_MAX = 64;
const LABEL_MAX = 200;
const REASONS_MAX = 32;
const REASON_MAX = 200;
const ARGS_DIGEST_MAX = 100;

// B 类：软上限，先裁剪未引用条目，仍超再拒绝。
const MAX_VERSIONS_PER_PLAN = 10;
const MAX_PLANS = 2000;
const STORE_MAX_BYTES = 8 * 1024 * 1024;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const VERSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_MAX = 500;

const PLAN_KEYS = Object.freeze([
  'intent',
  'enabled',
  'layers',
  'budgets',
  'noAnswerThreshold',
  'reasons',
  'steps',
  'allowedTools',
  'budget',
  'goalDigest',
]);

const STEP_KEYS = Object.freeze(['stepKey', 'toolName', 'argsDigest', 'label']);

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, plans: {}, refs: {} };
}

function iso(ms) {
  const value = typeof ms === 'number' ? ms : Date.now();
  if (!Number.isFinite(value)) {
    throw new AgentError('plan_invalid', '计划时间戳无效', 500);
  }
  return new Date(value).toISOString();
}

function planError(code, message, status = 400) {
  return new AgentError(code, message, status);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 只接受可无损 JSON 往返的值：
 * undefined 键、函数、Symbol、bigint、NaN/Infinity、Date/类实例、循环引用一律拒绝。
 * 静默丢字段会让「落盘的计划」与「内存里的计划」不一致。
 */
function assertJsonSafe(value, seen, where) {
  if (value === null) return;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw planError('plan_invalid', `${where} 出现 NaN/Infinity`);
    }
    return;
  }
  if (type === 'undefined') {
    throw planError('plan_invalid', `${where} 出现 undefined`);
  }
  if (type !== 'object') {
    throw planError('plan_invalid', `${where} 出现不支持的类型 ${type}`);
  }
  if (seen.has(value)) {
    throw planError('plan_invalid', `${where} 存在循环引用`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, seen, `${where}[${index}]`));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, seen, `${where}.${key}`);
    }
  } else {
    throw planError('plan_invalid', `${where} 只接受纯对象（Date/类实例请显式转换）`);
  }
  seen.delete(value);
}

/** 稳定序列化：对象键递归排序，数组保序。digest 必须与键序无关。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 计划内容摘要：`sha256:<hex>`，只校验内容一致性，不参与并发判定。 */
function digestPlan(plan) {
  return `sha256:${sha256Hex(stableStringify(plan))}`;
}

/** step 参数摘要，格式与 plan digest 一致。 */
function digestArgs(args) {
  return `sha256:${sha256Hex(opLedger.canonicalizeArgs(args))}`;
}

/**
 * stepKey 与 P2 的内容寻址同源（sha256([toolName, canonicalArgs, override||''])）。
 * 刻意不带 ordinal：位置量在重排/重试后会漂移，位置量不参与身份。
 */
function stepKeyFor({ toolName, args, override = null } = {}) {
  return opLedger.deriveStepId({ toolName, args, override });
}

function buildStep({ toolName, args, label = '', override = null } = {}) {
  const step = {
    stepKey: stepKeyFor({ toolName, args, override }),
    toolName,
    argsDigest: digestArgs(args),
    label,
  };
  assertStep(step, 0);
  return step;
}

function assertString(name, value, { max, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw planError('plan_invalid', `${name} 必须是字符串`);
  }
  if (!allowEmpty && value.length === 0) {
    throw planError('plan_invalid', `${name} 不能为空`);
  }
  if (typeof max === 'number' && value.length > max) {
    throw planError('plan_invalid', `${name} 不能超过 ${max} 字`);
  }
}

function assertPlanId(planId) {
  assertString('planId', planId, { max: PLAN_ID_MAX });
}

function assertVersion(planVersion) {
  if (!Number.isInteger(planVersion) || planVersion <= 0) {
    throw planError('plan_version_mismatch', 'planVersion 必须是正整数', 409);
  }
}

function assertStep(step, index) {
  const where = `steps[${index}]`;
  if (!isPlainObject(step)) {
    throw planError('plan_invalid', `${where} 必须是纯对象`);
  }
  // 体积先判：超大 step 无论多带了什么字段，都统一按 plan_step_too_large 拒绝。
  const bytes = Buffer.byteLength(JSON.stringify(step), 'utf8');
  if (bytes > STEP_MAX_BYTES) {
    throw planError('plan_step_too_large', `单个 step 超过 ${STEP_MAX_BYTES} 字节`);
  }
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.includes(key)) {
      throw planError('plan_invalid', `${where} 出现未知字段 ${key}`);
    }
  }
  if (typeof step.stepKey !== 'string' || !/^[0-9a-f]{64}$/.test(step.stepKey)) {
    throw planError('plan_invalid', `${where}.stepKey 必须是 sha256 十六进制串`);
  }
  assertString(`${where}.toolName`, step.toolName, { max: TOOL_NAME_MAX });
  assertString(`${where}.argsDigest`, step.argsDigest, {
    max: ARGS_DIGEST_MAX,
    allowEmpty: true,
  });
  assertString(`${where}.label`, step.label, { max: LABEL_MAX, allowEmpty: true });
}

/**
 * 结构校验 + 规范化（缺省的 steps/allowedTools/budget/goalDigest 补默认值）。
 * 未知顶层字段直接拒绝：宁可报错，也不静默丢弃调用方以为落盘了的字段。
 */
function validatePlan(plan) {
  if (!isPlainObject(plan)) {
    throw planError('plan_invalid', 'plan 必须是纯对象');
  }
  assertJsonSafe(plan, new WeakSet(), 'plan');

  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.includes(key)) {
      throw planError('plan_invalid', `plan 出现未知字段 ${key}`);
    }
  }

  assertString('plan.intent', plan.intent, { max: TOOL_NAME_MAX });
  if (typeof plan.enabled !== 'boolean') {
    throw planError('plan_invalid', 'plan.enabled 必须是布尔值');
  }
  if (!isPlainObject(plan.layers)) {
    throw planError('plan_invalid', 'plan.layers 必须是纯对象');
  }
  if (!isPlainObject(plan.budgets)) {
    throw planError('plan_invalid', 'plan.budgets 必须是纯对象');
  }
  if (
    typeof plan.noAnswerThreshold !== 'number' ||
    !Number.isFinite(plan.noAnswerThreshold) ||
    plan.noAnswerThreshold < 0
  ) {
    throw planError('plan_invalid', 'plan.noAnswerThreshold 必须是非负数字');
  }
  if (!Array.isArray(plan.reasons)) {
    throw planError('plan_invalid', 'plan.reasons 必须是数组');
  }
  if (plan.reasons.length > REASONS_MAX) {
    throw planError('plan_invalid', `plan.reasons 不能超过 ${REASONS_MAX} 条`);
  }
  plan.reasons.forEach((reason, index) => {
    assertString(`plan.reasons[${index}]`, reason, { max: REASON_MAX });
  });

  const steps = plan.steps === undefined ? [] : plan.steps;
  if (!Array.isArray(steps)) {
    throw planError('plan_invalid', 'plan.steps 必须是数组');
  }
  if (steps.length > MAX_STEPS) {
    throw planError('plan_step_limit', `计划步骤不能超过 ${MAX_STEPS} 条`);
  }
  steps.forEach((step, index) => assertStep(step, index));

  const allowedTools = plan.allowedTools === undefined ? [] : plan.allowedTools;
  if (!Array.isArray(allowedTools)) {
    throw planError('plan_invalid', 'plan.allowedTools 必须是数组');
  }
  allowedTools.forEach((name, index) => {
    assertString(`plan.allowedTools[${index}]`, name, { max: TOOL_NAME_MAX });
  });

  const budget = plan.budget === undefined ? null : plan.budget;
  if (budget !== null && !isPlainObject(budget)) {
    throw planError('plan_invalid', 'plan.budget 必须是纯对象或 null');
  }

  const goalDigest = plan.goalDigest === undefined ? null : plan.goalDigest;
  if (goalDigest !== null) {
    assertString('plan.goalDigest', goalDigest, { max: ARGS_DIGEST_MAX, allowEmpty: true });
  }

  const normalized = {
    intent: plan.intent,
    enabled: plan.enabled,
    layers: plan.layers,
    budgets: plan.budgets,
    noAnswerThreshold: plan.noAnswerThreshold,
    reasons: plan.reasons,
    steps,
    allowedTools,
    budget,
    goalDigest,
  };

  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (bytes > PLAN_MAX_BYTES) {
    throw planError('plan_too_large', `计划快照超过 ${PLAN_MAX_BYTES} 字节`);
  }

  // 深拷贝：调用方拿到的对象与 Store 内对象不能共享引用。
  return JSON.parse(JSON.stringify(normalized));
}

function deepCopy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function validateStore(raw) {
  if (!isPlainObject(raw)) {
    throw planError('plan_store_corrupted', '计划存储结构无效', 500);
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw planError('plan_store_corrupted', '计划存储 schemaVersion 不支持', 500);
  }
  if (!isPlainObject(raw.plans)) {
    throw planError('plan_store_corrupted', '计划存储 plans 结构无效', 500);
  }
  const refs = raw.refs === undefined ? {} : raw.refs;
  if (!isPlainObject(refs)) {
    throw planError('plan_store_corrupted', '计划存储 refs 结构无效', 500);
  }

  for (const [planId, lineage] of Object.entries(raw.plans)) {
    if (typeof planId !== 'string' || planId.length === 0 || planId.length > PLAN_ID_MAX) {
      throw planError('plan_store_corrupted', '计划存储包含非法 planId', 500);
    }
    if (!isPlainObject(lineage)) {
      throw planError('plan_store_corrupted', `计划 ${planId} 结构无效`, 500);
    }
    if (lineage.planId !== planId) {
      throw planError('plan_store_corrupted', `计划 ${planId} 的 planId 不一致`, 500);
    }
    if (!Number.isInteger(lineage.headVersion) || lineage.headVersion <= 0) {
      throw planError('plan_store_corrupted', `计划 ${planId} 的 headVersion 无效`, 500);
    }
    if (typeof lineage.createdAt !== 'string' || typeof lineage.updatedAt !== 'string') {
      throw planError('plan_store_corrupted', `计划 ${planId} 缺少时间戳`, 500);
    }
    if (!isPlainObject(lineage.versions)) {
      throw planError('plan_store_corrupted', `计划 ${planId} 的 versions 无效`, 500);
    }
    for (const [key, entry] of Object.entries(lineage.versions)) {
      const version = Number(key);
      if (!Number.isInteger(version) || version <= 0) {
        throw planError('plan_store_corrupted', `计划 ${planId} 的版本号 ${key} 无效`, 500);
      }
      if (!isPlainObject(entry)) {
        throw planError('plan_store_corrupted', `计划 ${planId} v${key} 结构无效`, 500);
      }
      if (entry.version !== version) {
        throw planError('plan_store_corrupted', `计划 ${planId} v${key} 的版本号不一致`, 500);
      }
      if (typeof entry.digest !== 'string' || !entry.digest.startsWith('sha256:')) {
        throw planError('plan_store_corrupted', `计划 ${planId} v${key} 的 digest 无效`, 500);
      }
      if (!isPlainObject(entry.plan)) {
        throw planError('plan_store_corrupted', `计划 ${planId} v${key} 的 plan 无效`, 500);
      }
    }
  }

  for (const [taskId, ref] of Object.entries(refs)) {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw planError('plan_store_corrupted', '计划存储包含非法 taskId 引用', 500);
    }
    if (!isPlainObject(ref)) {
      throw planError('plan_store_corrupted', `引用 ${taskId} 结构无效`, 500);
    }
    if (typeof ref.planId !== 'string' || ref.planId.length === 0) {
      throw planError('plan_store_corrupted', `引用 ${taskId} 的 planId 无效`, 500);
    }
    if (!Number.isInteger(ref.planVersion) || ref.planVersion <= 0) {
      throw planError('plan_store_corrupted', `引用 ${taskId} 的 planVersion 无效`, 500);
    }
    if (typeof ref.pinnedAt !== 'string') {
      throw planError('plan_store_corrupted', `引用 ${taskId} 的 pinnedAt 无效`, 500);
    }
  }

  raw.refs = refs;
  return raw;
}

function read() {
  ensureDir();
  if (!fs.existsSync(WORKFLOW_FILE)) return emptyStore();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
  } catch (_) {
    throw planError('plan_store_corrupted', '计划存储无法解析', 500);
  }

  return validateStore(parsed);
}

function write(store) {
  ensureDir();
  writeFileAtomicSync(WORKFLOW_FILE, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(WORKFLOW_FILE, 0o600);
  } catch (_) {
    // Windows chmod 语义有限；计划不含记忆正文。
  }
}

function readAudit() {
  if (!fs.existsSync(AUDIT_FILE)) {
    return { schemaVersion: AUDIT_SCHEMA_VERSION, entries: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    if (isPlainObject(parsed) && Array.isArray(parsed.entries)) return parsed;
  } catch (_) {
    // 审计文件损坏不阻塞计划存储；下一次裁剪会重建（丢失的历史只影响追溯）。
  }
  return { schemaVersion: AUDIT_SCHEMA_VERSION, entries: [] };
}

function writeAudit(entries) {
  if (entries.length === 0) return;
  ensureDir();
  const store = readAudit();
  store.schemaVersion = AUDIT_SCHEMA_VERSION;
  store.entries = [...store.entries, ...entries].slice(-AUDIT_MAX);
  writeFileAtomicSync(AUDIT_FILE, JSON.stringify(store, null, 2));
}

/** Store 内引用 + 调用方现场扫描的引用（任务文件）合并成 pin 集合。 */
function pinnedSet(store, liveRefs) {
  const pinned = new Set();
  for (const ref of Object.values(store.refs)) {
    pinned.add(`${ref.planId}|${ref.planVersion}`);
  }
  for (const ref of liveRefs || []) {
    if (!ref || typeof ref.planId !== 'string') continue;
    const version = Number(ref.planVersion);
    if (!Number.isInteger(version) || version <= 0) continue;
    pinned.add(`${ref.planId}|${version}`);
  }
  return pinned;
}

function isPinned(pinned, planId, version) {
  return pinned.has(`${planId}|${version}`);
}

function parseAt(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 纯函数：算出要删什么，不改 store、不写盘。
 * 顺序：先按单计划版本上限淘汰最旧的未引用版本，再清孤儿血缘（24h），
 * 再按计划总数淘汰最旧的孤儿，最后清解除引用超过 7 天的版本。
 */
function planPrune(store, { liveRefs = [], now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (!Number.isFinite(nowMs)) {
    throw planError('plan_invalid', '裁剪时间戳无效', 500);
  }
  const pinned = pinnedSet(store, liveRefs);
  const decisions = [];

  // 1) 单计划版本数上限：只删「未引用 + 最旧」。
  for (const [planId, lineage] of Object.entries(store.plans)) {
    const versions = Object.values(lineage.versions).sort((a, b) => a.version - b.version);
    const over = versions.length - MAX_VERSIONS_PER_PLAN;
    if (over <= 0) continue;
    let removed = 0;
    for (const entry of versions) {
      if (removed >= over) break;
      if (isPinned(pinned, planId, entry.version)) continue;
      decisions.push({
        action: 'prune_version',
        planId,
        planVersion: entry.version,
        reason: 'version_cap',
      });
      removed += 1;
    }
  }

  // 2) 孤儿血缘：任何版本都没有引用，且超过 24h。
  const referencedPlanIds = new Set();
  for (const key of pinned) {
    referencedPlanIds.add(key.split('|')[0]);
  }
  for (const [planId, lineage] of Object.entries(store.plans)) {
    if (referencedPlanIds.has(planId)) continue;
    if (nowMs - parseAt(lineage.updatedAt) <= ORPHAN_TTL_MS) continue;
    // 整个血缘删除；逐版本记审计，便于追溯。
    for (const entry of Object.values(lineage.versions)) {
      decisions.push({
        action: 'prune_plan',
        planId,
        planVersion: entry.version,
        reason: 'orphan_ttl',
      });
    }
  }

  // 3) 解除引用超过 7 天的版本（血缘仍被引用时也清旧版）。
  for (const [planId, lineage] of Object.entries(store.plans)) {
    for (const entry of Object.values(lineage.versions)) {
      if (isPinned(pinned, planId, entry.version)) continue;
      if (nowMs - parseAt(entry.createdAt) <= VERSION_TTL_MS) continue;
      if (decisions.some(d => d.planId === planId && d.planVersion === entry.version)) continue;
      decisions.push({
        action: 'prune_version',
        planId,
        planVersion: entry.version,
        reason: 'unreferenced_ttl',
      });
    }
  }

  // 4) 计划总数上限：只能淘汰「整条孤儿」。
  const removedPlans = new Set(decisions.filter(d => d.action === 'prune_plan').map(d => d.planId));
  let remainingPlans = Object.keys(store.plans).filter(id => !removedPlans.has(id)).length;
  let overCap = 0;
  if (remainingPlans > MAX_PLANS) {
    const orphans = Object.values(store.plans)
      .filter(lineage => !referencedPlanIds.has(lineage.planId))
      .filter(lineage => !removedPlans.has(lineage.planId))
      .sort((a, b) => parseAt(a.updatedAt) - parseAt(b.updatedAt));
    for (const lineage of orphans) {
      if (remainingPlans <= MAX_PLANS) break;
      for (const entry of Object.values(lineage.versions)) {
        decisions.push({
          action: 'prune_plan',
          planId: lineage.planId,
          planVersion: entry.version,
          reason: 'plan_cap',
        });
      }
      remainingPlans -= 1;
    }
    overCap = Math.max(0, remainingPlans - MAX_PLANS);
  }

  return { decisions, pinned: pinned.size, remainingPlans, overCap };
}

/** 审计先写后删；auditOnly 只写审计、不删（用于演示「审计已提交、删除未执行」的崩溃窗口）。 */
function applyDecisions(store, decisions, { auditOnly = false, now } = {}) {
  if (decisions.length > 0) {
    const at = iso(now);
    writeAudit(
      decisions.map(item => ({
        at,
        action: item.action,
        planId: item.planId,
        planVersion: item.planVersion,
        reason: item.reason,
      }))
    );
  }
  if (auditOnly) return;

  const planRemovals = new Set();
  for (const item of decisions) {
    if (item.action === 'prune_plan') {
      planRemovals.add(item.planId);
      continue;
    }
    const lineage = store.plans[item.planId];
    if (!lineage) continue;
    delete lineage.versions[String(item.planVersion)];
  }
  for (const planId of planRemovals) {
    delete store.plans[planId];
  }
}

function storeBytes(store) {
  return Buffer.byteLength(JSON.stringify(store), 'utf8');
}

/**
 * 追加一个不可变版本。
 * - planId 为空 → 新建血缘（`plan_<uuid>`），版本 1；
 * - planId 已存在 → headVersion+1，旧版本原样保留；
 * - 校验/上限任一失败 → 抛错且不写盘（磁盘上不会留下半截计划）。
 * liveRefs 仅在 Store 触顶需要裁剪时使用：由调用方从任务文件现场扫描传入。
 */
function appendVersion({ plan, planId = null, liveRefs = [], now } = {}) {
  const normalized = validatePlan(plan);
  const digest = digestPlan(normalized);
  const store = read();

  let resolvedPlanId = planId;
  if (resolvedPlanId === null || resolvedPlanId === undefined) {
    resolvedPlanId = `plan_${crypto.randomUUID()}`;
  } else {
    assertPlanId(resolvedPlanId);
  }
  assertPlanId(resolvedPlanId);

  const at = iso(now);
  const existing = store.plans[resolvedPlanId];
  if (!existing && planId !== null && planId !== undefined) {
    // 指定血缘必须已存在：拼错 planId 时新建血缘会让「重规划」变成静默新建。
    throw planError('plan_missing', '计划血缘不存在', 404);
  }

  const version = existing ? existing.headVersion + 1 : 1;
  if (!Number.isSafeInteger(version)) {
    throw planError('plan_invalid', 'planVersion 溢出', 500);
  }

  const lineage = existing || {
    planId: resolvedPlanId,
    headVersion: 0,
    createdAt: at,
    updatedAt: at,
    versions: {},
  };
  lineage.headVersion = version;
  lineage.updatedAt = at;
  lineage.versions[String(version)] = {
    version,
    digest,
    createdAt: at,
    plan: normalized,
  };
  store.plans[resolvedPlanId] = lineage;

  // B 类软上限：追加后立刻按「未引用 + 最旧」裁剪（刚追加的版本最新，不会被自己挤掉）。
  // 审计先写；随后才做体积判断与落盘。若落盘前就抛 plan_store_full，审计会多记一条
  // 「已计划裁剪但未执行」——宁可多记，也不删了不记。下一次裁剪会真正执行。
  const summary = planPrune(store, { liveRefs, now });
  if (summary.decisions.length > 0) {
    applyDecisions(store, summary.decisions, { now });
  }
  if (storeBytes(store) > STORE_MAX_BYTES) {
    throw planError('plan_store_full', '计划存储已达体积上限', 500);
  }

  write(store);

  // P5 式崩溃注入点：计划已 fsync 落盘、任务还没创建。父进程看到 marker 后 SIGKILL。
  // 未设置 BLUEBIRD_TEST_CRASH_HOOK 时只是一次字符串比较，零副作用。
  crashHook.hold('plan.after-save');

  return {
    planId: resolvedPlanId,
    planVersion: version,
    digest,
    headVersion: version,
  };
}

/** 新建血缘的语义化别名（不接受 planId）。 */
function createPlan({ plan, liveRefs = [], now } = {}) {
  return appendVersion({ plan, planId: null, liveRefs, now });
}

function requireLineage(store, planId, planVersion) {
  assertPlanId(planId);
  assertVersion(planVersion);
  const lineage = store.plans[planId];
  if (!lineage) {
    throw planError('plan_missing', '计划血缘不存在', 404);
  }
  if (planVersion > lineage.headVersion) {
    throw planError('plan_version_mismatch', '计划版本不存在', 409);
  }
  const entry = lineage.versions[String(planVersion)];
  if (!entry) {
    throw planError('plan_version_mismatch', '计划版本不存在', 409);
  }
  return { lineage, entry };
}

/**
 * 按 (planId, planVersion) 取回某个冻结版本。
 * 三种失败各自可区分：缺失 / 版本不符 / 内容损坏。
 * 返回深拷贝：调用方改返回值不会污染 Store。
 */
function getVersion(planId, planVersion) {
  const store = read();
  const { lineage, entry } = requireLineage(store, planId, planVersion);

  let normalized;
  try {
    normalized = validatePlan(entry.plan);
  } catch (_) {
    throw planError('plan_corrupt', '计划内容无法通过校验', 500);
  }
  if (digestPlan(normalized) !== entry.digest) {
    throw planError('plan_corrupt', '计划内容与摘要不一致', 500);
  }

  return {
    planId,
    planVersion: entry.version,
    digest: entry.digest,
    headVersion: lineage.headVersion,
    plan: deepCopy(entry.plan),
  };
}

function planExists(planId) {
  if (typeof planId !== 'string' || planId.length === 0) return false;
  return Boolean(read().plans[planId]);
}

/** 任务引用的反向记录：既用于 pin，也用于孤儿识别。 */
function pinRef({ taskId, planId, planVersion, now } = {}) {
  assertString('taskId', taskId, { max: 120 });
  const store = read();
  requireLineage(store, planId, planVersion);

  store.refs[taskId] = {
    planId,
    planVersion,
    pinnedAt: iso(now),
  };
  write(store);
  return deepCopy(store.refs[taskId]);
}

function unpinRef(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) return false;
  const store = read();
  if (!store.refs[taskId]) return false;
  delete store.refs[taskId];
  write(store);
  return true;
}

function getRef(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const ref = read().refs[taskId];
  return ref ? deepCopy(ref) : null;
}

function listRefs() {
  const store = read();
  return Object.entries(store.refs).map(([taskId, ref]) => ({ taskId, ...deepCopy(ref) }));
}

/**
 * 裁剪（B 类）。任何被 Store refs 或 liveRefs 引用的版本都不动，与任务状态无关：
 * 已终态、recovery 的任务仍然占 pin，因为人工追溯还要读那份计划。
 */
function prune({ liveRefs = [], now, auditOnly = false } = {}) {
  const store = read();
  const before = {
    plans: Object.keys(store.plans).length,
    versions: Object.values(store.plans).reduce(
      (sum, lineage) => sum + Object.keys(lineage.versions).length,
      0
    ),
  };

  const summary = planPrune(store, { liveRefs, now });
  applyDecisions(store, summary.decisions, { auditOnly, now });
  if (!auditOnly && summary.decisions.length > 0) write(store);

  const after = {
    plans: Object.keys(store.plans).length,
    versions: Object.values(store.plans).reduce(
      (sum, lineage) => sum + Object.keys(lineage.versions).length,
      0
    ),
  };

  return {
    // 计数只按实际变化算：auditOnly 时什么都没删，必须报 0。
    removedVersions: Math.max(0, before.versions - after.versions),
    removedPlans: Math.max(0, before.plans - after.plans),
    pinned: summary.pinned,
    overCap: summary.overCap,
    before,
    after,
  };
}

module.exports = {
  WORKFLOW_FILE,
  AUDIT_FILE,
  SCHEMA_VERSION,
  PLAN_MAX_BYTES,
  MAX_STEPS,
  STEP_MAX_BYTES,
  PLAN_ID_MAX,
  MAX_VERSIONS_PER_PLAN,
  MAX_PLANS,
  STORE_MAX_BYTES,
  ORPHAN_TTL_MS,
  VERSION_TTL_MS,
  emptyStore,
  validatePlan,
  digestPlan,
  digestArgs,
  stepKeyFor,
  buildStep,
  read,
  write,
  getVersion,
  planExists,
  createPlan,
  appendVersion,
  pinRef,
  unpinRef,
  getRef,
  listRefs,
  prune,
};
