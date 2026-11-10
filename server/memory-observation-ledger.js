/* 记忆观察台账（Phase 2 最小闭环，Notion 提案《自动记忆系统》原则 3）。
 *
 * 「有价值但证据不足」的低置信候选不再无痕丢弃：这里按**内容哈希**记录每一次
 * 被拒观察，累计独立会话数，为后续轮次的渐进式晋升（观察 → 候选）提供数据底座。
 *
 * 隐私边界：绝不存正文/原话/关键词——只存 sha256(canonical(content))、会话 id、
 * 拒写短码与置信度数值。台账是观测数据，不是记忆事实源；晋升语义（何时把
 * 独立会话支持转成 needs_confirmation）刻意不在本模块实现，留待单独评审。
 *
 * 落盘：与 memory.json 同一目录（BLUEBIRD_DATA_DIR），atomic-write + 写队列；
 * 损坏走 corruption 契约（隔离重命名 + 回退空台账），策略与 memory 一致。
 * 上限：条目数 500，超出按 lastSeenAt 淘汰最旧。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { handleCorruption, registerCorruptionHandler } = require('./corruption');
const { logDataEvent } = require('./data-events');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'memory-observation-ledger.json');
const LEDGER_VERSION = 1;
const LEDGER_MAX_ENTRIES = 500;
const MAX_SESSIONS_PER_KEY = 8;

registerCorruptionHandler('memory-observations', {
  detect(data) {
    if (data.error) {
      return { corrupt: true, reason: data.reason || 'read_error', error: data.error };
    }

    let parsed;

    try {
      parsed = JSON.parse(data.text);
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== LEDGER_VERSION ||
      !parsed.observations ||
      typeof parsed.observations !== 'object'
    ) {
      return { corrupt: true, reason: 'invalid_shape' };
    }

    return { corrupt: false, parsed };
  },

  recover(context) {
    // 与 memory 同策略：隔离重命名 + 回退空台账；结构化日志由 handleCorruption 统一记。
    let isolatedPath = null;

    try {
      const corruptPath = `${context.file}.corrupt-${Date.now()}`;
      fs.renameSync(context.file, corruptPath);
      isolatedPath = corruptPath;
      console.error(`Corrupt memory observation ledger backed up: ${isolatedPath}`);
    } catch (backupError) {
      console.error('Memory observation ledger backup error:', backupError.message);
    }

    return {
      action: isolatedPath ? 'isolated_file' : 'isolation_failed',
      isolatedPath,
    };
  },
});

function emptyLedger() {
  return { version: LEDGER_VERSION, observations: {} };
}

let ledgerState = emptyLedger();
let loaded = false;
let writeChain = Promise.resolve();

function loadLedger() {
  if (loaded) return ledgerState;

  loaded = true;

  let text = null;
  let error = null;

  try {
    text = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (readError) {
    if (readError && readError.code !== 'ENOENT') error = readError;
  }

  if (text === null && !error) {
    return ledgerState; // 首次使用，文件尚不存在
  }

  const outcome = handleCorruption(
    'memory-observations',
    { text, error },
    { file: LEDGER_FILE }
  );

  if (outcome.corrupt || !outcome.parsed) {
    ledgerState = emptyLedger();
    return ledgerState;
  }

  ledgerState = outcome.parsed;
  return ledgerState;
}

function saveLedger() {
  writeChain = writeChain
    .then(() =>
      writeFileAtomic(LEDGER_FILE, JSON.stringify(ledgerState, null, 2))
    )
    .catch(error => {
      logDataEvent({
        module: 'memory',
        file: LEDGER_FILE,
        event: 'write_queue_error',
        error,
        action: 'write_failed',
      });
    });
  return writeChain;
}

// 内容哈希：规范化空白后加域前缀哈希，跨重启稳定、不可反推正文。
function observationKey(content) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`v1:${normalized}`)
    .digest('hex');
}

function enforceCap() {
  const keys = Object.keys(ledgerState.observations);
  if (keys.length <= LEDGER_MAX_ENTRIES) return;
  const ordered = keys
    .map(key => ({ key, lastSeenAt: ledgerState.observations[key].lastSeenAt }))
    .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));
  for (const { key } of ordered.slice(0, keys.length - LEDGER_MAX_ENTRIES)) {
    delete ledgerState.observations[key];
  }
}

/** 记录一次被拒观察；返回该事实当前的观测概要（attempts / independentSessions）。 */
function observe({ content, sessionId = null, reason = null, confidence = null } = {}) {
  loadLedger();

  const key = observationKey(content);
  const now = new Date().toISOString();
  let entry = ledgerState.observations[key];

  if (!entry) {
    entry = {
      key,
      firstSeenAt: now,
      lastSeenAt: now,
      attempts: 0,
      sessions: [],
      lastReason: null,
      lastConfidence: null,
    };
    ledgerState.observations[key] = entry;
  }

  entry.attempts += 1;
  entry.lastSeenAt = now;
  entry.lastReason = typeof reason === 'string' ? reason.slice(0, 60) : null;
  entry.lastConfidence =
    Number.isFinite(confidence) ? Math.round(confidence * 10000) / 10000 : null;

  const sid = sessionId ? String(sessionId).slice(0, 64) : null;
  if (sid && !entry.sessions.includes(sid)) {
    entry.sessions.push(sid);
    while (entry.sessions.length > MAX_SESSIONS_PER_KEY) entry.sessions.shift();
  }

  enforceCap();
  saveLedger();

  return weigh(key);
}

/** 该事实当前的观测概要：尝试次数与独立会话数（不返回任何内容）。 */
function weigh(keyOrContent) {
  loadLedger();
  const raw = String(keyOrContent || '');
  // 64 位十六进制串视为 observationKey 的产物，其余按内容现场哈希
  const key = /^[0-9a-f]{64}$/.test(raw) ? raw : observationKey(raw);
  const entry = ledgerState.observations[key];

  if (!entry) {
    return { attempts: 0, independentSessions: 0, sessions: [] };
  }

  return {
    attempts: entry.attempts,
    independentSessions: entry.sessions.length,
    sessions: [...entry.sessions],
    lastReason: entry.lastReason,
    lastConfidence: entry.lastConfidence,
  };
}

/** 只读审计视图（观测元数据，无内容），按最近出现排序。 */
function getObservations(limit = 50) {
  loadLedger();
  return Object.values(ledgerState.observations)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, Math.max(0, Math.floor(limit)) || 50)
    .map(entry => ({
      key: entry.key,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      attempts: entry.attempts,
      independentSessions: entry.sessions.length,
      lastReason: entry.lastReason,
      lastConfidence: entry.lastConfidence,
    }));
}

function observationCount() {
  loadLedger();
  return Object.keys(ledgerState.observations).length;
}

/** 测试辅助：清空缓存，下一次读取重新从磁盘加载（tasks.reloadForTests 同款语义）。 */
function reloadForTests() {
  loaded = false;
  ledgerState = emptyLedger();
}

/** 测试辅助：等待已排队的原子写全部落盘。 */
function flushForTests() {
  return writeChain;
}

module.exports = {
  observe,
  weigh,
  observationKey,
  getObservations,
  observationCount,
  reloadForTests,
  flushForTests,
  LEDGER_FILE,
  LEDGER_MAX_ENTRIES,
};
