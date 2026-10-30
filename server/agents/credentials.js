/* global module, __dirname, Buffer */
/**
 * Bot 凭证库：每个 Bot 的 API Key 只用 AES-256-GCM 密文落盘。
 *
 * - 主密钥优先取 BLUEBIRD_AGENT_VAULT_KEY（64 位十六进制）；
 *   未配置时在数据目录生成 agents/agent-vault.key（尽力 chmod 0600）。
 * - 读取接口只返回 keyHint 与状态，绝不返回完整 Key。
 * - 解密必须同时匹配 botId 与 credentialId，跨 Bot 访问直接拒绝。
 * - Key 永不写日志、事件、Prompt 或模型消息。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomicSync, writeFileExclusiveSync } = require('../atomic-write');
const { findProvider, keyHint } = require('../api-configs');
const { testProviderConnection } = require('../model-adapter');
const { isKnownBot } = require('./manifest');
const { AgentError } = require('./errors');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const VAULT_FILE = path.join(AGENTS_DIR, 'agent-credentials.json');
const KEY_FILE = path.join(AGENTS_DIR, 'agent-vault.key');
const VAULT_VERSION = 1;
const ENV_KEY = 'BLUEBIRD_AGENT_VAULT_KEY';
const MAX_API_KEY_CHARS = 4096;
const HEX_KEY_RE = /^[a-f0-9]{64}$/i;

let vaultCache = null;
let masterKey = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function readMasterKey() {
  if (masterKey) return masterKey;

  const fromEnv = process.env[ENV_KEY];
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const value = fromEnv.trim();
    if (!HEX_KEY_RE.test(value)) {
      throw new AgentError(
        'agent_vault_key_invalid',
        `${ENV_KEY} 必须是 64 位十六进制字符串`,
        500
      );
    }
    masterKey = Buffer.from(value, 'hex');
    return masterKey;
  }

  ensureDir();
  if (fs.existsSync(KEY_FILE)) {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!HEX_KEY_RE.test(raw)) {
      throw new AgentError('agent_vault_key_invalid', '本地凭证主密钥无效', 500);
    }
    masterKey = Buffer.from(raw, 'hex');
    return masterKey;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  const created = writeFileExclusiveSync(KEY_FILE, generated);
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch (_) {
    // Windows 上 chmod 语义有限；失败不影响密钥可用性。
  }
  if (!created) {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!HEX_KEY_RE.test(raw)) {
      throw new AgentError('agent_vault_key_invalid', '本地凭证主密钥无效', 500);
    }
    masterKey = Buffer.from(raw, 'hex');
    return masterKey;
  }
  masterKey = Buffer.from(generated, 'hex');
  return masterKey;
}

function emptyVault() {
  return { version: VAULT_VERSION, credentials: {} };
}

function loadVault() {
  if (vaultCache) return vaultCache;

  if (!fs.existsSync(VAULT_FILE)) {
    vaultCache = emptyVault();
    return vaultCache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch (_) {
    throw new AgentError('agent_credentials_corrupted', 'Bot 凭证库无法解析', 500);
  }
  if (
    !parsed ||
    parsed.version !== VAULT_VERSION ||
    !parsed.credentials ||
    typeof parsed.credentials !== 'object' ||
    Array.isArray(parsed.credentials)
  ) {
    throw new AgentError('agent_credentials_corrupted', 'Bot 凭证库结构无效', 500);
  }
  vaultCache = parsed;
  return vaultCache;
}

function saveVault() {
  ensureDir();
  writeFileAtomicSync(VAULT_FILE, JSON.stringify(vaultCache, null, 2));
  try {
    fs.chmodSync(VAULT_FILE, 0o600);
  } catch (_) {
    // Windows 上 chmod 语义有限；密文仍只保存在数据目录。
  }
}

function assertBot(botId) {
  if (!isKnownBot(botId)) {
    throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  }
}

function assertApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new AgentError('invalid_credential', 'API Key 不能为空');
  if (key.length > MAX_API_KEY_CHARS) {
    throw new AgentError('invalid_credential', 'API Key 过长');
  }
  if (/[\r\n]/.test(key)) {
    throw new AgentError('invalid_credential', 'API Key 不能包含换行');
  }
  return key;
}

function aadFor(record) {
  return Buffer.from(
    `${record.credentialId}\u0000${record.botId}\u0000${record.providerId}`,
    'utf8'
  );
}

function encryptKey(key, plaintext, record) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(record));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptKey(key, record) {
  let decipher;
  try {
    decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(record.iv, 'base64')
    );
    decipher.setAAD(aadFor(record));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (_) {
    throw new AgentError('agent_credential_decrypt_failed', 'Bot 凭证无法解密', 500);
  }
}

function publicCredential(record) {
  if (!record) return null;
  return {
    credentialId: record.credentialId,
    botId: record.botId,
    providerId: record.providerId,
    keyHint: record.keyHint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastVerifiedAt: record.lastVerifiedAt || null,
    lastVerifyOk:
      typeof record.lastVerifyOk === 'boolean' ? record.lastVerifyOk : null,
  };
}

function listCredentials(botId) {
  assertBot(botId);
  const vault = loadVault();
  return Object.values(vault.credentials)
    .filter(record => record.botId === botId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicCredential);
}

function getCredential(credentialId, botId) {
  const vault = loadVault();
  const record = vault.credentials[String(credentialId || '')] || null;
  if (!record) return null;
  if (record.botId !== botId) {
    throw new AgentError('agent_credential_forbidden', '该凭证不属于当前 Bot', 403);
  }
  return record;
}

function getCredentialKey(credentialId, botId) {
  assertBot(botId);
  const record = getCredential(credentialId, botId);
  if (!record) {
    throw new AgentError('credential_not_configured', 'Memory Bot 未配置 API Key', 409);
  }
  return decryptKey(readMasterKey(), record);
}

function putCredential({ botId, providerId, apiKey } = {}) {
  assertBot(botId);
  const provider = findProvider(String(providerId || ''));
  if (!provider) {
    throw new AgentError('provider_not_found', '模型服务商不存在', 404);
  }
  const plaintext = assertApiKey(apiKey);
  const vault = loadVault();
  const now = nowIso();
  const credentialId = `cred_${crypto.randomUUID()}`;
  const record = {
    credentialId,
    botId,
    providerId: provider.id,
    keyHint: keyHint(plaintext),
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: null,
    lastVerifyOk: null,
    iv: '',
    tag: '',
    ciphertext: '',
  };
  const encrypted = encryptKey(readMasterKey(), plaintext, record);
  record.iv = encrypted.iv;
  record.tag = encrypted.tag;
  record.ciphertext = encrypted.ciphertext;

  // 首期一个 Bot 只保留一个活动凭证；替换时删除旧密文，避免残留。
  for (const [id, existing] of Object.entries(vault.credentials)) {
    if (existing.botId === botId) delete vault.credentials[id];
  }
  vault.credentials[credentialId] = record;
  saveVault();
  return publicCredential(record);
}

function deleteCredential(credentialId, botId) {
  assertBot(botId);
  const vault = loadVault();
  const record = getCredential(credentialId, botId);
  if (!record) return { deleted: false };
  delete vault.credentials[record.credentialId];
  saveVault();
  return { deleted: true, credentialId: record.credentialId };
}

async function verifyCredential(credentialId, botId) {
  assertBot(botId);
  const record = getCredential(credentialId, botId);
  if (!record) {
    throw new AgentError('credential_not_found', '凭证不存在', 404);
  }
  const key = decryptKey(readMasterKey(), record);
  const result = await testProviderConnection(record.providerId, {
    keyOverride: key,
  });
  const vault = loadVault();
  const current = vault.credentials[record.credentialId];
  if (current) {
    current.lastVerifiedAt = nowIso();
    current.lastVerifyOk = result.ok === true;
    current.updatedAt = nowIso();
    saveVault();
  }
  return {
    ok: result.ok === true,
    code: result.code || (result.ok ? 'ok' : 'verify_failed'),
    error: result.error || '',
    httpStatus: result.httpStatus || null,
    latencyMs: result.latencyMs || 0,
    credential: publicCredential(current || record),
  };
}

function reloadForTests() {
  vaultCache = null;
  masterKey = null;
}

module.exports = {
  AGENTS_DIR,
  VAULT_FILE,
  KEY_FILE,
  publicCredential,
  listCredentials,
  getCredential,
  getCredentialKey,
  putCredential,
  deleteCredential,
  verifyCredential,
  reloadForTests,
};
