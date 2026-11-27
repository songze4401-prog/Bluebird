'use strict';
/**
 * W6-1 受控审计回放。
 *
 * 默认关闭。只有 BLUEBIRD_AUDIT_MODE=1 时才落盘；内容为 AES-256-GCM 加密，
 * 密钥来自 BLUEBIRD_AUDIT_KEY（64 位 hex）或本地 0600 key 文件；只保留短期
 * 摘要（Prompt 截断 + 工具回执摘要 + 回复 hash），不保存原始工具参数/结果正文。
 * 查询复用 Bearer 鉴权，按 requestId 取回，过期记录自动忽略。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'monitoring');
const KEY_FILE = path.join(AUDIT_DIR, '.audit-key');
const REPLAY_FILE = path.join(AUDIT_DIR, 'audit-replay.jsonl');
const DEFAULT_RETENTION_HOURS = 24;
const MAX_RETENTION_HOURS = 72;
const MAX_RECORDS = 2000;
const MAX_USER_TEXT = 4000;
const MAX_SUMMARY = 240;

function enabled() {
  return String(process.env.BLUEBIRD_AUDIT_MODE || '0').trim() === '1';
}

function retentionMs() {
  const raw = Number(process.env.BLUEBIRD_AUDIT_RETENTION_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RETENTION_HOURS) : DEFAULT_RETENTION_HOURS;
  return hours * 60 * 60 * 1000;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function keyBytes() {
  const provided = String(process.env.BLUEBIRD_AUDIT_KEY || '').trim();
  if (/^[a-fA-F0-9]{64}$/.test(provided)) {
    return Buffer.from(provided, 'hex');
  }
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch (_) {
    /* Windows chmod 语义有限；密钥仍在本地数据目录 */
  }
  const bytes = fs.readFileSync(KEY_FILE);
  if (bytes.length !== 32) throw new Error('audit key file corrupted');
  return bytes;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decrypt(line) {
  const [iv, tag, ciphertext] = String(line || '').trim().split('.');
  if (!iv || !tag || !ciphertext) return null;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBytes(),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

function sanitizePayload(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const output = {};
  if (typeof input.userText === 'string') {
    output.userText = input.userText.slice(0, MAX_USER_TEXT);
    output.promptHash = hash(input.userText);
  }
  if (typeof input.replyHash === 'string' && /^[a-f0-9]{64}$/.test(input.replyHash)) {
    output.replyHash = input.replyHash;
  }
  if (typeof input.receiptStatus === 'string') {
    output.receiptStatus = input.receiptStatus.slice(0, 40);
  }
  if (Array.isArray(input.toolSteps)) {
    output.toolSteps = input.toolSteps.slice(0, 20).map(step => ({
      name: String(step && step.name ? step.name : '').slice(0, 60),
      ok: Boolean(step && step.ok === true),
      ...(step && step.code ? { code: String(step.code).slice(0, 60) } : {}),
      ...(step && step.summary
        ? { summary: String(step.summary).slice(0, MAX_SUMMARY) }
        : {}),
    }));
  }
  return output;
}

function capture({ requestId = null, event = 'event', payload = {} } = {}) {
  if (!enabled() || !requestId) return false;
  try {
    const record = {
      v: 1,
      requestId: String(requestId).slice(0, 120),
      event: String(event).slice(0, 60),
      at: new Date().toISOString(),
      payload: sanitizePayload(payload),
    };
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(REPLAY_FILE, `${encrypt(JSON.stringify(record))}\n`, {
      mode: 0o600,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function read(requestId) {
  if (!enabled() || !requestId) return { enabled: false, records: [] };
  const cutoff = Date.now() - retentionMs();
  const records = [];
  try {
    const lines = fs.readFileSync(REPLAY_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_RECORDS)) {
      let record;
      try {
        record = decrypt(line);
      } catch (_) {
        continue;
      }
      if (!record || record.requestId !== requestId) continue;
      if (!Number.isFinite(Date.parse(record.at)) || Date.parse(record.at) < cutoff) continue;
      records.push(record);
    }
  } catch (_) {
    return { enabled: true, records: [] };
  }
  return {
    enabled: true,
    requestId: String(requestId),
    retentionHours: Math.round(retentionMs() / (60 * 60 * 1000)),
    records,
  };
}

module.exports = {
  AUDIT_DIR,
  KEY_FILE,
  REPLAY_FILE,
  enabled,
  capture,
  read,
  hash,
};
