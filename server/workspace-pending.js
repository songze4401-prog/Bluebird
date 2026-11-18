/**
 * 工作区写入确认往返（任务书接法 a：主聊轻量确认，2026-11-19）。
 *
 * 主聊直连路径里 workspace_write 不再直接落盘：工具层创建一条**待确认写入**
 * 记录（含完整写入参数），随 toolSteps 附到 assistant 消息；用户在聊天里
 * 点「确认写入 / 取消」→ POST /workspace/pending/:id/confirm|reject →
 * 确认后才执行真正的沙箱写入（路径/配额/备份在确认时全部重查）。
 *
 * 设计约束（与仓库既有存储纪律一致）：
 * - 独立 JSON 文件 `BLUEBIRD_DATA_DIR/workspace-pending.json`（不在 workspace/
 *   目录里，避免被 workspace_list 看见、也避免被写工具触碰）；
 * - atomic-write 原子落盘；损坏时隔离改名（.corrupt-<ts>）并按空库继续，
 *   绝不覆盖用户文件；
 * - 记录带 sessionId + userId 归属：确认/取消必须同会话同用户，跨会话/跨用户
 *   一律 forbidden；
 * - TTL 15 分钟，惰性清除；全局 20 条 / 单会话 3 条上限，超限顶掉最旧；
 * - content 明文存于待确认记录（确认时要按原参数执行），与工作区文件本身的
 *   明文存储同级；记录不进日志、不进监控正文。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync } = require('./atomic-write');

const LIMITS = Object.freeze({
  pendingMax: 20,
  perSessionMax: 3,
  ttlMs: 15 * 60 * 1000,
  pathMax: 512,
  contentMaxBytes: 256 * 1024,
});

const MODES = Object.freeze(['create', 'overwrite', 'append']);

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'workspace-pending.json');

function nowIso() {
  return new Date().toISOString();
}

function loadStore() {
  let raw;
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    // 读不出（权限等）→ 按空库继续，不让确认存储拖死主链路；下次保存会重建。
    console.warn(`[workspace-pending] 存储读取失败（${error.code || 'io_error'}），按空库处理`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed && parsed.pending) ? parsed.pending : [];
    return list.filter(item => item && typeof item === 'object' && typeof item.id === 'string');
  } catch (_) {
    // 损坏隔离：改名留证，按空库继续（与 memory/emotion 的 .corrupt-<ts> 同语义）。
    try {
      fs.renameSync(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`);
    } catch (_) {
      // 改名失败也不阻塞：下次成功保存会覆盖坏文件。
    }
    console.warn('[workspace-pending] 存储损坏，已隔离为 .corrupt-* 并按空库继续');
    return [];
  }
}

function saveStore(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomicSync(
    STORE_FILE,
    `${JSON.stringify({ schemaVersion: 1, pending: list }, null, 2)}\n`
  );
}

function purgeExpired(list) {
  const now = Date.now();
  const kept = list.filter(item => {
    const expires = Date.parse(item.expiresAt || '');
    return Number.isFinite(expires) && expires > now;
  });
  return kept;
}

function persist(list) {
  saveStore(list);
  return list;
}

/**
 * 创建待确认写入。路径/模式/大小在这里预检（fail-fast 给模型清晰错误），
 * 确认执行时会用同一套沙箱逻辑重查（防 TOCTOU：创建到确认之间目录可能变化）。
 */
function createPendingWrite({ sessionId, userId, path: relPath, mode, content } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw toolStoreError('workspace_pending_invalid', '缺少 sessionId');
  }
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > LIMITS.pathMax) {
    throw toolStoreError('workspace_pending_invalid', `path 必须是 1-${LIMITS.pathMax} 字符的相对路径`);
  }
  if (relPath.includes('\0')) {
    throw toolStoreError('workspace_pending_invalid', 'path 包含非法空字节');
  }
  if (!MODES.includes(mode)) {
    throw toolStoreError('workspace_pending_invalid', 'mode 必须是 create / overwrite / append');
  }
  if (typeof content !== 'string') {
    throw toolStoreError('workspace_pending_invalid', 'content 必须是字符串');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > LIMITS.contentMaxBytes) {
    throw toolStoreError('workspace_pending_invalid', `content 超过单文件 ${LIMITS.contentMaxBytes} 字节上限`);
  }

  let list = purgeExpired(loadStore());
  const record = {
    id: `wsw_${crypto.randomBytes(12).toString('hex')}`,
    sessionId,
    userId: typeof userId === 'string' && userId ? userId : null,
    path: relPath,
    mode,
    content,
    bytes,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + LIMITS.ttlMs).toISOString(),
  };

  // 单会话上限：同会话最旧的未确认写入被顶掉（模型连发多个写入时只留最近几条）。
  const sameSession = list.filter(item => item.sessionId === sessionId);
  if (sameSession.length >= LIMITS.perSessionMax) {
    list = list.filter(item => item !== sameSession[0]);
  }
  // 全局上限：最旧的被顶掉。
  if (list.length >= LIMITS.pendingMax) {
    list = list.slice(list.length - LIMITS.pendingMax + 1);
  }
  list.push(record);
  persist(list);
  return record;
}

/**
 * 取一条待确认写入（校验归属 + TTL）。返回：
 * { status: 'ok'|'not_found'|'expired'|'forbidden', record? }
 */
function getPendingWrite(id, { sessionId, userId } = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    return { status: 'not_found' };
  }
  // 刻意不做全局预清洗：目标记录若已过期要显式返回 expired（API 层据此给
  // 409「请重新发起」，而不是伪装成不存在）；其余过期条目在移除目标时顺手清理。
  const list = loadStore();
  const index = list.findIndex(item => item.id === id);
  if (index === -1) return { status: 'not_found' };
  const record = list[index];
  const expires = Date.parse(record.expiresAt || '');
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    persist(purgeExpired(list));
    return { status: 'expired' };
  }
  if (record.sessionId !== sessionId) {
    return { status: 'forbidden' };
  }
  if (record.userId && userId && record.userId !== userId) {
    return { status: 'forbidden' };
  }
  return { status: 'ok', record };
}

/** 消费（确认执行后移除）。返回形状同 getPendingWrite。 */
function consumePendingWrite(id, scope) {
  const found = getPendingWrite(id, scope);
  if (found.status !== 'ok') return found;
  const list = purgeExpired(loadStore()).filter(item => item.id !== id);
  persist(list);
  return found;
}

/** 取消（用户拒绝）。返回形状同 getPendingWrite。 */
function cancelPendingWrite(id, scope) {
  return consumePendingWrite(id, scope);
}

/** 会话视角的未确认列表（TTL 内、同会话同用户），旧→新。 */
function listPendingWrites({ sessionId, userId } = {}) {
  const list = purgeExpired(loadStore()).filter(
    item =>
      item.sessionId === sessionId &&
      (!item.userId || !userId || item.userId === userId)
  );
  return list;
}

function toolStoreError(code, error) {
  return { ok: false, code, error, summary: error };
}

module.exports = {
  LIMITS,
  MODES,
  STORE_FILE,
  createPendingWrite,
  getPendingWrite,
  consumePendingWrite,
  cancelPendingWrite,
  listPendingWrites,
};
