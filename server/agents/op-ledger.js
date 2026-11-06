/* global module, __dirname */
/**
 * OP Ledger：有副作用操作的幂等账本（Phase 1 / P1）。
 *
 * 只提供存储能力：schema、读写、幂等键、保留期清理。
 * P1 刻意不接任何执行器——调用点（runtime / approvals）在 P2/P3 才接；
 * 这一步先把「键怎么算、账怎么写、什么时候能删」钉死并测稳。
 *
 * 幂等键 = sha256(JSON.stringify([agentId, taskId, stepId, toolName, canonicalArgs]))。
 * 用 JSON 数组而不是 `a|b|c` 直接拼接：字段里出现分隔符时后者会撞键。
 * 刻意不含 runId / attempt：同一逻辑操作跨重试必须同键，否则重试会重复执行。
 *
 * 参数规范化刻意严格（宁可不同键，也不误判同键）：
 * - 对象键递归排序，键序不同的等价对象得到同一个键；
 * - 数字字符串 "1" 与数字 1 视为**不同**参数：强制类型转换会让 "01" 与 1、
 *   "1.0" 与 1 都撞在一起，结果是真实的调用被误判成重复而跳过——
 *   对副作用来说，漏执行一次和重复执行一次同样危险；
 * - 对象里值为 undefined 的键视为「可选字段缺省」，直接丢弃；显式 null 保留，
 *   与缺省不同（null 是语义上的「无值」，缺省是「没给」）；
 * - 数组顺序敏感，不排序；
 * - 拒绝 NaN/Infinity/bigint/函数/符号/Date/自定义类实例/循环引用：
 *   JSON.stringify 会把 NaN/Infinity 静默变成 null，那样会和 null 撞键。
 *
 * 易变参数（时间戳、随机 id）的过滤属于每个工具的稳定参数白名单，
 * 由工具元数据在 P2 声明；本模块不做猜测性剔除。
 *
 * 单写者假设：本模块是 read-modify-write，多进程并发写没有保证；
 * 与 agent-tasks.json 一样由进程启动时的单实例锁兜底。
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
const LEDGER_FILE = path.join(AGENTS_DIR, 'agent-op-ledger.json');

const SCHEMA_VERSION = 1;
// 终态条目保留 7 天：与 orphan TTL（168h）同口径，A 类待校准。
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// 条目上限 5000：先按时间淘汰最老的终态条目（B 类，未压测）。
const MAX_ENTRIES = 5000;
// 成功结果原文的落盘上限：超过则不存原文（只留 digest），复用方拿不到 body。
const MAX_RESULT_BYTES = 4096;

const STATUSES = Object.freeze(['started', 'succeeded', 'failed', 'unknown']);
// 只有这些状态可以被自动清理；started/unknown 永不自动删除——
// 它们代表「可能已执行、结果未知」，删掉就等于把风险抹掉。
const CLEANABLE = new Set(['succeeded', 'failed']);

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, ops: {} };
}

function iso(ms) {
  const value = typeof ms === 'number' ? ms : Date.now();
  if (!Number.isFinite(value)) {
    throw new AgentError('agent_op_ledger_invalid', '账本时间戳无效', 500);
  }
  return new Date(value).toISOString();
}

function invalidArgs(reason) {
  return new AgentError(
    'agent_op_args_invalid',
    `幂等参数无法规范化：${reason}`,
    400
  );
}

function canonicalizeValue(value, seen) {
  if (value === null) return null;

  const type = typeof value;

  if (type === 'string' || type === 'boolean') return value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      // NaN / Infinity 在 JSON 里会变成 null，与显式 null 撞键。
      throw invalidArgs('出现 NaN/Infinity');
    }
    return value;
  }

  if (type === 'undefined') {
    // 对象里的 undefined 在调用方被丢弃；数组里的 undefined 不能丢弃，
    // 否则 [1, undefined] 会与 [1] 或 [1, null] 撞键。
    throw invalidArgs('数组或顶层出现 undefined');
  }

  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw invalidArgs(`不支持的参数类型 ${type}`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw invalidArgs('参数存在循环引用');
    seen.add(value);
    const out = value.map(item => canonicalizeValue(item, seen));
    seen.delete(value);
    return out;
  }

  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw invalidArgs('只接受纯对象（Date/类实例请显式转成字符串或数字）');
    }
    if (seen.has(value)) throw invalidArgs('参数存在循环引用');
    seen.add(value);
    const out = {};
    // 默认 sort 按 UTF-16 code unit 排序，跨平台稳定；不要用 localeCompare。
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      // 可选字段缺省：undefined 键直接丢弃（JSON.stringify 本身也会丢）。
      if (item === undefined) continue;
      out[key] = canonicalizeValue(item, seen);
    }
    seen.delete(value);
    return out;
  }

  throw invalidArgs(`不支持的参数类型 ${type}`);
}

/**
 * 参数 → 规范化 JSON 字符串。
 * 无参数（undefined/null）与空对象 {} 等价：都表示「这次调用没有参数」。
 */
function canonicalizeArgs(args) {
  if (args === undefined || args === null) return '{}';
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw invalidArgs('args 必须是纯对象');
  }
  return JSON.stringify(canonicalizeValue(args, new WeakSet()));
}

function assertKeyPart(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentError(
      'agent_op_key_invalid',
      `幂等键字段 ${name} 必须是非空字符串`,
      400
    );
  }
}

/** opKey = sha256([agentId, taskId, stepId, toolName, canonicalArgs])。 */
function buildOpKey({ agentId, taskId, stepId, toolName, args } = {}) {
  assertKeyPart('agentId', agentId);
  assertKeyPart('taskId', taskId);
  assertKeyPart('stepId', stepId);
  assertKeyPart('toolName', toolName);

  const payload = JSON.stringify([
    agentId,
    taskId,
    stepId,
    toolName,
    canonicalizeArgs(args),
  ]);

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * 运行时用 stepId = sha256([toolName, canonicalArgs])。
 *
 * 刻意不用 checkpointVersion/round/toolIndex：那三个位置量在重试与重启后会漂移
 * （checkpoint 版本随运行推进、round 从 1 重新计数），同一次副作用会算出不同的键，
 * 幂等直接失效。按「工具 + 参数」内容寻址则天然稳定：
 * 同一次逻辑操作，无论跑在第几轮、第几次重试，键都一样。
 * 代价是同一任务里两次完全相同参数的调用会被判为一次（这正是幂等要的语义）。
 * 确实需要重复执行两次时，用显式的 dedupeKeyOverride（调用序号）作为第三个分量。
 */
function deriveStepId({ toolName, args, override = null } = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new AgentError('agent_op_key_invalid', 'toolName 必须是非空字符串', 400);
  }
  const payload = JSON.stringify([toolName, canonicalizeArgs(args), override || '']);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** 结果摘要：对规范化后的 JSON 求 sha256（跨进程一致，仅用于回答「复用的是哪次结果」）。 */
function digestResult(result) {
  if (result === undefined) return null;
  const payload = JSON.stringify(canonicalizeValue(result, new WeakSet()));
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function validateEntry(key, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.opKey !== key) return false;
  if (typeof entry.taskId !== 'string' || entry.taskId.length === 0) return false;
  if (typeof entry.toolName !== 'string' || entry.toolName.length === 0) return false;
  if (!STATUSES.includes(entry.status)) return false;
  if (typeof entry.startedAt !== 'string') return false;
  if (entry.finishedAt !== null && typeof entry.finishedAt !== 'string') return false;
  if (entry.errorCode !== null && typeof entry.errorCode !== 'string') return false;
  if (entry.resultDigest !== null && typeof entry.resultDigest !== 'string') return false;
  if (
    entry.result !== undefined &&
    entry.result !== null &&
    (typeof entry.result !== 'object' || Array.isArray(entry.result))
  ) {
    return false;
  }
  if (entry.resultOmitted !== undefined && typeof entry.resultOmitted !== 'boolean') return false;
  return true;
}

function migrate(raw) {
  if (
    !raw ||
    raw.version !== SCHEMA_VERSION ||
    !raw.ops ||
    typeof raw.ops !== 'object' ||
    Array.isArray(raw.ops)
  ) {
    throw new AgentError('agent_op_ledger_corrupted', '幂等账本结构无效', 500);
  }

  for (const [key, entry] of Object.entries(raw.ops)) {
    if (!validateEntry(key, entry)) {
      throw new AgentError('agent_op_ledger_corrupted', '幂等账本条目结构无效', 500);
    }
  }

  return raw;
}

function read() {
  ensureDir();
  if (!fs.existsSync(LEDGER_FILE)) return emptyStore();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_op_ledger_corrupted', '幂等账本无法解析', 500);
  }

  return migrate(parsed);
}

function write(store) {
  ensureDir();
  writeFileAtomicSync(LEDGER_FILE, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(LEDGER_FILE, 0o600);
  } catch (_) {
    // Windows chmod 语义有限；账本只含摘要，不含参数原文。
  }
}

function get(opKey) {
  const store = read();
  return store.ops[opKey] || null;
}

/**
 * 写 started 意图（fsync 落盘后才返回），或返回已存在的同键条目。
 * 调用方据 `reused` 判断：true 表示这个 opKey 已经有过记录，
 * 必须按状态分支（succeeded 复用结果 / started|unknown 转人工），
 * 绝不能当成一次全新的执行。
 */
function begin({ agentId, taskId, stepId, toolName, args, attempt = 1, now } = {}) {
  const opKey = buildOpKey({ agentId, taskId, stepId, toolName, args });
  const store = read();
  const existing = store.ops[opKey];

  if (existing) return { opKey, entry: existing, reused: true };

  const entry = {
    opKey,
    taskId,
    toolName,
    status: 'started',
    attempt: Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1,
    startedAt: iso(now),
    finishedAt: null,
    resultDigest: null,
    errorCode: null,
    result: null,
    resultOmitted: false,
    // §7「重复副作用率」的原料：真实执行成功了几次。复用已有结果的路径不会再调
    // finish，所以这个计数只会被真执行抬高——它和 attempt 不同，attempt 是"第几次发起"，
    // 本字段是"第几次真的把副作用做出去了"。旧记录没有该字段，读取端按 unknown 处理，
    // 不回填（回填等于伪造历史执行次数）。
    executions: 0,
  };

  store.ops[opKey] = entry;
  write(store);

  return { opKey, entry, reused: false };
}

function requireEntry(store, opKey) {
  const entry = store.ops[opKey];
  if (!entry) {
    // 没写过 started 就补终态，说明调用顺序错了；静默忽略会掩盖漏记账。
    throw new AgentError('agent_op_not_found', '幂等账本中没有该操作', 404);
  }
  return entry;
}

function requireOpKey(opKey) {
  if (typeof opKey !== 'string' || !/^[0-9a-f]{64}$/.test(opKey)) {
    throw new AgentError('agent_op_key_invalid', 'opKey 必须是 sha256 十六进制串', 400);
  }
}

/**
 * 补终态：succeeded / failed。不改 startedAt/attempt。
 * succeeded 时把结果原文（≤MAX_RESULT_BYTES）一起落盘，供重复调用真正复用；
 * 超限只存 digest 并标记 resultOmitted，绝不把截断后的半截结果当成结果复用。
 */
function finish(opKey, { status, resultDigest = null, result, errorCode = null, now } = {}) {
  requireOpKey(opKey);
  if (status !== 'succeeded' && status !== 'failed') {
    throw new AgentError('agent_op_status_invalid', '终态只能是 succeeded/failed', 400);
  }

  const store = read();
  const entry = requireEntry(store, opKey);
  entry.status = status;
  entry.finishedAt = iso(now);
  entry.errorCode = errorCode === null ? null : String(errorCode);

  if (status === 'succeeded' && result !== undefined) {
    const serialized = JSON.stringify(result);
    const tooLarge = !serialized || serialized.length > MAX_RESULT_BYTES;
    entry.result = tooLarge ? null : JSON.parse(serialized);
    entry.resultOmitted = tooLarge;
    entry.resultDigest = resultDigest === null ? digestResult(result) : String(resultDigest);
  } else {
    entry.result = null;
    entry.resultOmitted = false;
    entry.resultDigest = resultDigest === null ? null : String(resultDigest);
  }
  if (status === 'succeeded') {
    // 旧记录没有 executions 字段时按 0 起算：这一次成功就是第 1 次真实执行。
    entry.executions = (Number.isFinite(Number(entry.executions)) ? Number(entry.executions) : 0) + 1;
    entry.lastExecutedAt = iso(now);
  }

  write(store);

  return entry;
}

/**
 * 失败后重试同一逻辑操作：复用同一 opKey（不新增行），attempt+1 重新置为 started。
 * 只允许从 failed 重试；started/unknown 必须人工核对，succeeded 直接复用。
 */
function retry(opKey, { now } = {}) {
  requireOpKey(opKey);

  const store = read();
  const entry = requireEntry(store, opKey);
  if (entry.status !== 'failed') {
    throw new AgentError('agent_op_status_invalid', '只有 failed 可以原地重试', 409);
  }

  entry.status = 'started';
  entry.attempt = (Number.isInteger(entry.attempt) ? entry.attempt : 1) + 1;
  entry.startedAt = iso(now);
  entry.finishedAt = null;
  entry.resultDigest = null;
  entry.errorCode = null;
  entry.result = null;
  entry.resultOmitted = false;
  write(store);

  return entry;
}

/**
 * 把「可能已执行」标成 unknown。unknown 不自动删除，必须人工核对；
 * 恢复流程不得把它当成 failed（那等于把可能已执行谎报成确定没执行）。
 */
function markUnknown(opKey, { errorCode = null, now } = {}) {
  requireOpKey(opKey);

  const store = read();
  const entry = requireEntry(store, opKey);
  entry.status = 'unknown';
  entry.finishedAt = iso(now);
  entry.errorCode = errorCode === null ? null : String(errorCode);
  write(store);

  return entry;
}

/**
 * 启动封账（P5）：单进程部署下，进程启动时不可能还有正在执行的工具调用，
 * 所有 started 条目都是上次崩溃的残留——统一转 unknown，等待人工核对。
 * 绝不能留 started 让下一次同键调用复用它（那会把「不知道执行没执行」当成可复用）。
 */
function sealStarted({ now, errorCode = 'recovery_side_effect_unknown' } = {}) {
  const store = read();
  const sealed = [];
  for (const entry of Object.values(store.ops)) {
    if (entry.status !== 'started') continue;
    entry.status = 'unknown';
    entry.finishedAt = iso(now);
    entry.errorCode = errorCode;
    sealed.push(entry.opKey);
  }
  if (sealed.length > 0) write(store);
  return sealed;
}

/**
 * 清理：
 *  a) 超过保留期、状态为终态、且所属任务已终态（或已被裁剪）的条目；
 *  b) 超过上限时按时间淘汰最老的「可删」条目。
 * started/unknown 永不自动删除；任务未终态的条目也不删。
 * `terminalTaskIds` 传「已终态或已被裁剪」的 taskId 集合。
 */
function cleanup({ terminalTaskIds = [], now, dryRun = false } = {}) {
  const store = read();
  const terminal = new Set(terminalTaskIds);
  const nowMs = typeof now === 'number' ? now : Date.now();

  if (!Number.isFinite(nowMs)) {
    throw new AgentError('agent_op_ledger_invalid', '清理时间戳无效', 500);
  }

  const removable = new Set(
    Object.keys(store.ops).filter(key => {
      const entry = store.ops[key];
      return CLEANABLE.has(entry.status) && terminal.has(entry.taskId);
    })
  );

  const ageAnchor = entry => {
    const parsed = Date.parse(entry.finishedAt || entry.startedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  let removedByAge = 0;
  for (const key of [...removable]) {
    if (nowMs - ageAnchor(store.ops[key]) > RETENTION_MS) {
      delete store.ops[key];
      removable.delete(key);
      removedByAge += 1;
    }
  }

  const remaining = Object.keys(store.ops).length;
  let removedByCap = 0;
  let overCap = 0;

  if (remaining > MAX_ENTRIES) {
    const excess = remaining - MAX_ENTRIES;
    const ordered = [...removable].sort((a, b) => ageAnchor(store.ops[b]) - ageAnchor(store.ops[a]));
    // 上面的排序是「新的在前」，淘汰要从最老开始，取尾部。
    for (let i = ordered.length - 1; i >= 0 && removedByCap < excess; i -= 1) {
      delete store.ops[ordered[i]];
      removedByCap += 1;
    }
    overCap = Object.keys(store.ops).length - MAX_ENTRIES;
  }

  const changed = removedByAge + removedByCap > 0;
  if (changed && !dryRun) write(store);

  return {
    removedByAge,
    removedByCap,
    overCap: Math.max(0, overCap),
    remaining: Object.keys(store.ops).length,
  };
}

module.exports = {
  LEDGER_FILE,
  SCHEMA_VERSION,
  RETENTION_MS,
  MAX_ENTRIES,
  MAX_RESULT_BYTES,
  STATUSES,
  canonicalizeArgs,
  digestResult,
  deriveStepId,
  buildOpKey,
  read,
  write,
  get,
  begin,
  finish,
  retry,
  markUnknown,
  sealStarted,
  cleanup,
};
