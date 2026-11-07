/* global module, __dirname */
/**
 * Fencing / generation token（§10 + §20 第 349 步，缺口编号 FM-4）。
 *
 * 要挡的场景：计划迁移或租约易主之后，**旧 Worker 还在跑**。它手里的授权是旧代次的，
 * 但进程没死、工具还能调、产物还能写。租约（lease）只在续租与落结果时校验，
 * 挡不住一次已经开始的工具调用；幂等账本（op-ledger）只回答"这次操作做没做过"，
 * 不回答"你现在还有没有资格做"。本模块补的就是这个资格判定。
 *
 * 口径（三条不变量）：
 *  1. 代次单调：签发一律 counter+1，落盘后才返回；重启读回同一份计数器，绝不回退。
 *     计数器小于任一已签发代次 = 文件被改坏，按 fencing_unavailable 拒绝，不"修复"成 0。
 *  2. 资格按任务判定，不按平面计划版本判定：§10 规定 running/waiting_approval/recovery
 *     的任务保持原 planVersion（continued），它们**不该**因为计划出了新版本就被拦。
 *     只有该任务被重新签发（migrated / 新一轮运行）或显式撤销时，旧令牌才失效。
 *  3. fail-closed：令牌缺失、对不上、存储读不出来，一律拒绝副作用，绝不放行。
 *
 * 令牌只由运行层在**开始执行时**铸造并留在内存里；判定侧每次都重新读盘比对。
 * 刻意不让 Worker 从盘上"再读一次当前令牌"——那等于让旧 Worker 自己领新资格，fencing 失效。
 *
 * 单写者假设与 op-ledger / agent-tasks.json 相同：read-modify-write，由进程单实例锁兜底。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('../atomic-write');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const FENCING_FILE = path.join(AGENTS_DIR, 'agent-fencing.json');

const FENCING_POLICY_VERSION = 'fencing-v1';
const SCHEMA_VERSION = 1;
// 记录上限与 op-ledger 同量级（B 类，未压测）；只淘汰"已撤销且任务已终态"的记录。
const MAX_RECORDS = 5000;

const STALE_GENERATION = 'stale_generation';
const FENCING_REVOKED = 'fencing_revoked';
const TOKEN_INVALID = 'fencing_token_invalid';
const TOKEN_MISSING = 'fencing_token_missing';
const FENCING_UNAVAILABLE = 'fencing_unavailable';

const DENIAL_CODES = Object.freeze([
  STALE_GENERATION,
  FENCING_REVOKED,
  TOKEN_INVALID,
  TOKEN_MISSING,
  FENCING_UNAVAILABLE,
]);

// §10 迁移映射里需要换代次的两类：节点未开始就迁到新版本（migrated）。
const ISSUE_MAPPINGS = Object.freeze(['migrated']);
// 步骤被删（cancelled）与产物不可复用需重执行（revalidated）：旧代次的写入资格一律收回。
const REVOKE_MAPPINGS = Object.freeze(['cancelled', 'revalidated']);

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, counter: 0, tasks: {} };
}

function iso(ms) {
  const value = typeof ms === 'number' ? ms : Date.now();
  if (!Number.isFinite(value)) {
    throw new AgentError(FENCING_UNAVAILABLE, '代次时间戳无效', 500);
  }
  return new Date(value).toISOString();
}

function unavailable(reason) {
  return new AgentError(FENCING_UNAVAILABLE, `代次存储不可用：${reason}`, 500);
}

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new AgentError(TOKEN_INVALID, 'taskId 必须是非空字符串', 400);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRecord(key, record, counter) {
  if (!isPlainObject(record)) return false;
  if (record.taskId !== key) return false;
  if (!Number.isInteger(record.generation) || record.generation < 1) return false;
  // 代次不可能超过计数器；超过即文件被改坏（或计数器回退），必须拒绝而不是采信。
  if (record.generation > counter) return false;
  if (typeof record.tokenId !== 'string' || record.tokenId.length === 0) return false;
  if (record.planId !== null && typeof record.planId !== 'string') return false;
  if (record.planVersion !== null && !Number.isInteger(record.planVersion)) return false;
  if (record.runId !== null && typeof record.runId !== 'string') return false;
  if (typeof record.issuedAt !== 'string') return false;
  if (record.revokedAt !== null && typeof record.revokedAt !== 'string') return false;
  if (record.revokeReason !== null && typeof record.revokeReason !== 'string') return false;
  return true;
}

function validateStore(raw) {
  if (!isPlainObject(raw) || raw.version !== SCHEMA_VERSION) {
    throw unavailable('结构无效');
  }
  if (!Number.isInteger(raw.counter) || raw.counter < 0) {
    throw unavailable('代次计数器无效');
  }
  if (!isPlainObject(raw.tasks)) throw unavailable('代次记录表无效');
  for (const [key, record] of Object.entries(raw.tasks)) {
    if (!validRecord(key, record, raw.counter)) {
      throw unavailable(`代次记录无效：${key}`);
    }
  }
  return raw;
}

function read() {
  ensureDir();
  if (!fs.existsSync(FENCING_FILE)) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FENCING_FILE, 'utf8'));
  } catch (_) {
    throw unavailable('文件无法解析');
  }
  return validateStore(parsed);
}

function write(store) {
  ensureDir();
  writeFileAtomicSync(FENCING_FILE, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(FENCING_FILE, 0o600);
  } catch (_) {
    // Windows chmod 语义有限；文件只含 id 与代次，不含正文。
  }
}

function tokenOf(record) {
  return {
    taskId: record.taskId,
    tokenId: record.tokenId,
    generation: record.generation,
    planId: record.planId,
    planVersion: record.planVersion,
    runId: record.runId,
    issuedAt: record.issuedAt,
    policyVersion: FENCING_POLICY_VERSION,
  };
}

/**
 * 签发新代次（同一任务重新签发即让旧令牌过期）。落盘成功后才返回令牌。
 * planId/planVersion 允许 null：没有冻结计划的任务同样要有写入资格判定。
 */
function issue({ taskId, planId = null, planVersion = null, runId = null, now } = {}) {
  assertTaskId(taskId);
  const store = read();
  store.counter += 1;
  const record = {
    taskId,
    planId: planId === null || planId === undefined ? null : String(planId),
    planVersion:
      planVersion === null || planVersion === undefined ? null : Number(planVersion),
    generation: store.counter,
    tokenId: `ft_${crypto.randomUUID()}`,
    runId: runId === null || runId === undefined ? null : String(runId),
    issuedAt: iso(now),
    revokedAt: null,
    revokeReason: null,
  };
  if (record.planVersion !== null && !Number.isInteger(record.planVersion)) {
    throw new AgentError(TOKEN_INVALID, 'planVersion 必须是整数或 null', 400);
  }
  store.tasks[taskId] = record;
  write(store);
  return tokenOf(record);
}

/**
 * 撤销写入资格（任务终态、步骤被删、产物需重执行）。幂等：已撤销不再写盘。
 * 返回记录副本附 `changed`，调用方据此决定要不要落审计（重复撤销不该重复报事件）。
 */
function revoke({ taskId, reason = 'revoked', now } = {}) {
  assertTaskId(taskId);
  const store = read();
  const record = store.tasks[taskId];
  if (!record) return null;
  if (record.revokedAt !== null) return { ...record, changed: false };
  record.revokedAt = iso(now);
  record.revokeReason = String(reason).slice(0, 120);
  write(store);
  return { ...record, changed: true };
}

function denial(code, { taskId = null, token = null, record = null } = {}) {
  return {
    ok: false,
    code,
    policyVersion: FENCING_POLICY_VERSION,
    taskId: taskId === null ? null : String(taskId),
    heldGeneration:
      token && Number.isInteger(token.generation) ? token.generation : null,
    currentGeneration: record ? record.generation : null,
  };
}

/**
 * 校验一次写入资格。纯判定 + 读盘，不写盘、不抛错：调用方（副作用闸门、产物落盘前）
 * 拿到 ok:false 就拒绝执行。读盘失败也走 ok:false（fencing_unavailable），绝不降级放行。
 */
function verify({ taskId, token } = {}) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return denial(TOKEN_INVALID, { taskId });
  }
  if (!isPlainObject(token)) return denial(TOKEN_MISSING, { taskId });

  let store;
  try {
    store = read();
  } catch (_) {
    return denial(FENCING_UNAVAILABLE, { taskId, token });
  }

  const record = store.tasks[taskId];
  if (!record) return denial(TOKEN_MISSING, { taskId, token });
  // 先比代次再比 tokenId：同一任务重新签发后，旧令牌的 tokenId 必然对不上，
  // 但它的真实含义是"代次过期"（stale_generation），不是伪造。
  if (!Number.isInteger(token.generation) || token.generation > record.generation) {
    return denial(TOKEN_INVALID, { taskId, token, record });
  }
  if (token.generation < record.generation) {
    return denial(STALE_GENERATION, { taskId, token, record });
  }
  if (token.taskId !== taskId || token.tokenId !== record.tokenId) {
    return denial(TOKEN_INVALID, { taskId, token, record });
  }
  if (record.revokedAt !== null) {
    return denial(FENCING_REVOKED, { taskId, token, record });
  }
  return {
    ok: true,
    code: null,
    policyVersion: FENCING_POLICY_VERSION,
    taskId,
    generation: record.generation,
    heldGeneration: record.generation,
    currentGeneration: record.generation,
  };
}

/** 当前记录（观测与用例用；Worker 不得用它给自己领新资格）。 */
function current(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const record = read().tasks[taskId];
  return record ? { ...record } : null;
}

function snapshot() {
  const store = read();
  const records = Object.values(store.tasks);
  return {
    policyVersion: FENCING_POLICY_VERSION,
    counter: store.counter,
    records: records.length,
    active: records.filter(record => record.revokedAt === null).length,
    revoked: records.filter(record => record.revokedAt !== null).length,
    overCap: Math.max(0, records.length - MAX_RECORDS),
    targets: records.map(record => ({
      taskId: record.taskId,
      generation: record.generation,
      planId: record.planId,
      planVersion: record.planVersion,
      revoked: record.revokedAt !== null,
    })),
  };
}

/**
 * 启动恢复：读回并校验（代次回退 / 结构损坏一律抛错，由调用方把绑定任务收敛 recovery）。
 * 刻意不"重建"计数器：重建等于把旧令牌重新变成有效。
 */
function recover() {
  const store = read();
  const records = Object.values(store.tasks);
  return {
    policyVersion: FENCING_POLICY_VERSION,
    counter: store.counter,
    records: records.length,
    active: records.filter(record => record.revokedAt === null).length,
    revoked: records.filter(record => record.revokedAt !== null).length,
  };
}

/**
 * §10 迁移映射 → 代次处置。由 workflow-store.migratePlanVersion 在分配出新版本后调用。
 * continued（running/waiting_approval/recovery 保持原版本）与 reused/unchanged 不动令牌：
 * 它们按原文继续持有原代次的写入资格，计划出新版本本身不构成撤销理由。
 */
function applyMigration({ planId, toVersion, migrations = [], now } = {}) {
  const issued = [];
  const revoked = [];
  const kept = [];
  for (const migration of Array.isArray(migrations) ? migrations : []) {
    if (!migration || typeof migration.taskId !== 'string') continue;
    const taskId = migration.taskId;
    if (ISSUE_MAPPINGS.includes(migration.mapping)) {
      issue({ taskId, planId, planVersion: toVersion, now });
      issued.push(taskId);
      continue;
    }
    if (REVOKE_MAPPINGS.includes(migration.mapping)) {
      revoke({ taskId, reason: `plan_migration:${migration.mapping}`, now });
      // 没有令牌可撤（任务从未运行）也算处置完成，不报成 kept。
      revoked.push(taskId);
      continue;
    }
    kept.push(taskId);
  }
  return {
    policyVersion: FENCING_POLICY_VERSION,
    planId: planId === undefined ? null : planId,
    toVersion: toVersion === undefined ? null : toVersion,
    issued,
    revoked,
    kept,
  };
}

/**
 * 清理：只删"已撤销 + 任务已终态"的记录；活跃记录永不自动删除。
 * 删掉记录不会让旧令牌复活——verify 对无记录一律 fencing_token_missing。
 */
function cleanup({ terminalTaskIds = [], dryRun = false } = {}) {
  const store = read();
  const terminal = new Set(Array.isArray(terminalTaskIds) ? terminalTaskIds : []);
  const removable = Object.keys(store.tasks).filter(key => {
    const record = store.tasks[key];
    return record.revokedAt !== null && terminal.has(key);
  });
  for (const key of removable) delete store.tasks[key];

  let removedByCap = 0;
  const remaining = Object.keys(store.tasks).length;
  if (remaining > MAX_RECORDS) {
    const excess = remaining - MAX_RECORDS;
    const candidates = Object.values(store.tasks)
      .filter(record => record.revokedAt !== null && terminal.has(record.taskId))
      .sort((a, b) => String(a.revokedAt).localeCompare(String(b.revokedAt)));
    for (const record of candidates) {
      if (removedByCap >= excess) break;
      delete store.tasks[record.taskId];
      removedByCap += 1;
    }
  }

  const changed = removable.length + removedByCap > 0;
  if (changed && !dryRun) write(store);
  return {
    removed: removable.length + removedByCap,
    removedByCap,
    remaining: Object.keys(store.tasks).length,
    overCap: Math.max(0, Object.keys(store.tasks).length - MAX_RECORDS),
  };
}

module.exports = {
  FENCING_FILE,
  FENCING_POLICY_VERSION,
  SCHEMA_VERSION,
  MAX_RECORDS,
  STALE_GENERATION,
  FENCING_REVOKED,
  TOKEN_INVALID,
  TOKEN_MISSING,
  FENCING_UNAVAILABLE,
  DENIAL_CODES,
  ISSUE_MAPPINGS,
  REVOKE_MAPPINGS,
  read,
  issue,
  revoke,
  verify,
  current,
  snapshot,
  recover,
  applyMigration,
  cleanup,
};