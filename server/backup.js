/* global __dirname */
/**
 * Bluebird 数据备份核心（零第三方依赖）。
 *
 * 设计要点：
 * - **递归采集**：数据范围不只是顶层 JSON，还包含 uploads/ 与 sticker-repo/ 两棵目录树
 *   （聊天图片、表情包仓库）。旧的 blue-backup.sh / .ps1 只 `cp` 顶层文件，会静默漏掉
 *   这两棵目录——本模块是唯一实现，两个旧脚本改为委托到这里，杜绝两套行为分叉。
 * - **只读源目录**：只 stat / readFile / copyFile，从不写、不删、不改源数据。
 * - **可追溯运行记录**：每次运行追加一行 JSON 到 `<备份根>/_state/runs.jsonl`（只追加），
 *   并覆盖写 `last-status.json`（最近一次结果 + 最近一次成功时间 + 连续失败数）。
 * - **陈旧可发现**：`checkStatus()` 按 `staleAfterHours` 判断「备份长期未成功」，
 *   供 `--check` 作为告警挂点（退出码 2）。它只判定状态，不代表已配置定时任务。
 * - **完整性**：非空 + JSON 结构 + SHA-256（源与副本双向比对）。
 * - **一致性**：因为每个数据文件都是「临时文件 + fsync + 原子 rename」落盘，单文件必然
 *   自洽；跨文件没有事务，故采集前后各读一次源文件的 size/mtime，发现变化就重拷一次，
 *   仍变化则判定 `consistent:false` 并整轮失败——不拿可能错位的快照冒充一致备份。
 * - **故障域**：备份根落在数据目录内直接拒绝；与数据目录同一卷则记录并告警，
 *   不把同盘副本当成灾难恢复备份（AGENTS.md 有对应说明）。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_KIND = 'bluebird-data-backup';
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_KEEP = 7;
const MAX_COPY_ATTEMPTS = 2;

const STATE_DIR_NAME = '_state';
const RUN_LOG_NAME = 'runs.jsonl';
const STATUS_FILE_NAME = 'last-status.json';
const DRILL_LOG_NAME = 'drills.jsonl';
const MANIFEST_JSON = 'MANIFEST.json';
const MANIFEST_TXT = 'MANIFEST.txt';

const DEFAULT_DATA_DIR = path.join(__dirname, 'data');

// ---------------------------------------------------------------- 基础工具

function resolveDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BLUEBIRD_DATA_DIR) {
    return path.resolve(process.env.BLUEBIRD_DATA_DIR);
  }

  return DEFAULT_DATA_DIR;
}

function resolveOutRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BLUEBIRD_BACKUP_DIR) {
    return path.resolve(process.env.BLUEBIRD_BACKUP_DIR);
  }

  return path.join(os.homedir(), 'bluebird-backups');
}

/** 运行期产物：单实例锁、写入中的临时文件。混进备份会在恢复时误报「已有实例在运行」。 */
function isRuntimeArtifact(name) {
  return name === '.bluebird.lock' || /\.tmp[.-]/.test(name);
}

/**
 * 密钥文件：默认不进备份。api-keys.json 是明文密钥库（API key 等），
 * 进快照等于把密钥存进一份可能被同步/外发的副本。默认排除；若业务确有需求，
 * 走加密通道（见 createBackup 的 encryptSecrets）。
 *
 * 跨平台判定：relPath 可能来自 collectEntries 的 POSIX 拼接（永远是 `/`），
 * 也可能在某些调用方传入 Windows 风格 `\\`。先统一成 `/` 再取 basename，
 * 保证「嵌套目录里的 api-keys.json」在两种分隔符下都能正确排除。
 */
function isSecretFile(relPath) {
  const normalized = String(relPath).replace(/\\/g, '/');
  const base = normalized.split('/').pop();

  return base === 'api-keys.json';
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));

  return hash.digest('hex').toUpperCase();
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
}

// ---------------------------------------------------------------- 密钥加密
// 仅用于「业务确实要求备份密钥」时的可选通道：AES-256-GCM。
// 密钥本身由调用方通过环境变量 BLUEBIRD_BACKUP_KEY 提供（高熵口令），
// 经 SHA-256 派生为 32 字节。口令不得写入备份、日志或测试报告。
//
// 已知限制（本轮刻意不改，待独立审查）：单次摘要无 KDF 拉伸，若部署方使用低
// 熵口令，抗暴力破解能力弱。后续若引入 PBKDF2/scrypt 拉伸，会同时改变加密方
// （encryptBuffer）与解密方（decryptBuffer）约定，并使既有 .enc 副本无法解密——
// 属于加密格式变更，必须经专门审查，不能随手改。本轮仅保留当前行为，风险单独记录。

function deriveKey(passphrase) {
  return crypto.createHash('sha256').update(passphrase, 'utf8').digest();
}

function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  cipher.setAAD(Buffer.from('bluebird-secret', 'utf8'));

  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decryptBuffer(payload, key) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64')
  );

  decipher.setAAD(Buffer.from('bluebird-secret', 'utf8'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ct, 'base64')),
    decipher.final(),
  ]);
}

function isPlainObject(value) {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 备份根下设的 _state 目录（运行日志与状态都不在快照里，保留策略动不到它们）。 */
function stateDirOf(outRoot) {
  return path.join(outRoot, STATE_DIR_NAME);
}

function runLogPath(outRoot) {
  return path.join(stateDirOf(outRoot), RUN_LOG_NAME);
}

function statusPath(outRoot) {
  return path.join(stateDirOf(outRoot), STATUS_FILE_NAME);
}

function drillLogPath(outRoot) {
  return path.join(stateDirOf(outRoot), DRILL_LOG_NAME);
}

// ---------------------------------------------------------------- 采集

/**
 * 递归列出数据目录里需要备份的内容。
 * @param {{excludeSecrets?: boolean}} [opts] excludeSecrets 默认 true（密钥不进备份）
 * @returns {{files: string[], dirs: string[], skipped: string[], skippedSecrets: string[]}}
 *          相对路径，POSIX 分隔符
 */
function collectEntries(dataDir, opts = {}) {
  const excludeSecrets = opts.excludeSecrets !== false;
  const files = [];
  const dirs = [];
  const skipped = [];
  const skippedSecrets = [];

  const walk = (absDir, relBase) => {
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const relPath = relBase
        ? `${relBase}/${entry.name}`
        : entry.name;

      if (isRuntimeArtifact(entry.name)) {
        skipped.push(relPath);
        continue;
      }

      const abs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        dirs.push(relPath);
        walk(abs, relPath);
      } else if (entry.isFile()) {
        if (excludeSecrets && isSecretFile(relPath)) {
          skippedSecrets.push(relPath);
          continue;
        }
        files.push(relPath);
      }
      // 符号链接等其它类型既不备份也不报告：避免跟随链接读到数据目录之外
    }
  };

  walk(dataDir, '');

  return { files, dirs, skipped, skippedSecrets };
}

// ---------------------------------------------------------------- 结构校验
// 只断言能确认的形状（其它 .json 只要求可解析）：sessions.json 是权威存储，
// memory.json / chat-history.json 是数组，其余是对象。图片等二进制只判非空。

const SHAPE_RULES = {
  'sessions.json': 'sessions_store',
  'memory.json': 'json_array',
  'chat-history.json': 'json_array',
  'emotion-state.json': 'json_object',
  'presence.json': 'json_object',
  'persona.json': 'json_object',
  'api-configs.json': 'json_object',
  'api-keys.json': 'json_object',
  'stickers.json': 'json_object',
  'sticker-repo/sticker-repo.json': 'json_object',
  'uploads/stickers.json': 'json_object',
};

/**
 * 校验单个数据文件：非空 + 可解析 + 形状。
 * @param {string} relPath 相对数据目录的路径（POSIX 分隔）
 * @param {Buffer} buf 文件内容
 * @returns {{ok: boolean, reason?: string, structure?: string, detail?: string}}
 */
function validateDataFile(relPath, buf) {
  if (!buf || buf.length === 0) {
    return { ok: false, reason: 'empty_file' };
  }

  if (!relPath.toLowerCase().endsWith('.json')) {
    return { ok: true, structure: 'binary' };
  }

  let parsed;

  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (error) {
    // 只记错误类型：JSON.parse 的 message 里会带原始内容片段（可能是聊天文本）
    return { ok: false, reason: 'invalid_json', detail: error.name };
  }

  const rule = SHAPE_RULES[relPath];

  if (!rule) {
    return { ok: true, structure: Array.isArray(parsed) ? 'json_array' : 'json_any' };
  }

  if (rule === 'json_array' && !Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape', detail: 'expected_array' };
  }

  if (rule === 'json_object' && !isPlainObject(parsed)) {
    return { ok: false, reason: 'invalid_shape', detail: 'expected_object' };
  }

  if (rule === 'sessions_store') {
    if (!isPlainObject(parsed)) {
      return { ok: false, reason: 'invalid_shape', detail: 'expected_object' };
    }
    // 形状按 server/sessions.js 的真实存储约定：sessions 是数组，messages 是
    // `{ [sessionId]: Message[] }`。早期版本误判成两个对象，会让一份好备份被判成坏数据。
    if (!Array.isArray(parsed.sessions)) {
      return { ok: false, reason: 'invalid_shape', detail: 'expected_sessions_array' };
    }
    if (!isPlainObject(parsed.messages)) {
      return { ok: false, reason: 'invalid_shape', detail: 'expected_messages_object' };
    }
  }

  return { ok: true, structure: rule };
}

// ---------------------------------------------------------------- 故障域

function volumeKey(target) {
  // 目标可能尚未创建：沿父目录上溯到第一个已存在的路径
  let current = path.resolve(target);

  for (;;) {
    try {
      const st = fs.statSync(current);

      return { root: path.parse(current).root.toLowerCase(), dev: st.dev };
    } catch (_) {
      const parent = path.dirname(current);

      if (parent === current) return { root: null, dev: null };
      current = parent;
    }
  }
}

/**
 * 判断备份根与数据目录是否同一卷（同一故障域）。
 * 不同盘符 → 一定不同卷；同盘符且 dev 可用 → 比 dev；否则保守判为同卷。
 */
function isSameVolume(a, b) {
  const ka = volumeKey(a);
  const kb = volumeKey(b);

  if (ka.root && kb.root && ka.root !== kb.root) return false;
  if (
    typeof ka.dev === 'number' &&
    typeof kb.dev === 'number' &&
    ka.dev !== kb.dev
  ) {
    return false;
  }

  return true;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------- 快照枚举

/**
 * 列出备份根下的快照目录（只认本模块写出的、带 MANIFEST.json 且格式版本匹配的目录）。
 * 旧的 MANIFEST.txt 版本不会被当成可管理快照，保留策略也永远不会删它。
 */
function listSnapshots(outRoot) {
  let names = [];

  try {
    names = fs.readdirSync(outRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const snapshots = [];

  for (const entry of names) {
    if (!entry.isDirectory() || !entry.name.startsWith('data-')) continue;

    const dir = path.join(outRoot, entry.name);
    const manifest = readJsonIfExists(path.join(dir, MANIFEST_JSON));

    if (!manifest || manifest.formatVersion !== BACKUP_FORMAT_VERSION) continue;

    snapshots.push({
      dir,
      name: entry.name,
      createdAt: manifest.createdAt,
      files: manifest.files ? manifest.files.length : 0,
      bytes: manifest.counts ? manifest.counts.bytes : 0,
      consistent: manifest.consistent !== false,
      manifest,
    });
  }

  snapshots.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  return snapshots;
}

/** 最新一个「完整且一致」的快照；没有则 null。 */
function latestSnapshot(outRoot) {
  const all = listSnapshots(outRoot).filter(
    item => item.consistent !== false
  );

  return all.length ? all[all.length - 1] : null;
}

/**
 * 保留策略：只清理本模块产出的 `data-*` 快照，保留最近 keep 个。
 * 不触碰旧 MANIFEST.txt 版本、也不触碰备份根里的任何其它内容。
 */
function applyRetention(outRoot, keep) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;
  const snapshots = listSnapshots(outRoot);
  const removed = [];

  if (snapshots.length <= limit) {
    return { removed, kept: snapshots.length, limit };
  }

  const doomed = snapshots.slice(0, snapshots.length - limit);

  for (const item of doomed) {
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.name);
    } catch (_) {
      /* 删不掉就留着：保留策略失败不影响本次备份结论 */
    }
  }

  return { removed, kept: snapshots.length - removed.length, limit };
}

// ---------------------------------------------------------------- 备份

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(1)} ${units[index]}`;
}

/**
 * 执行一次备份。
 *
 * 不抛异常：预期内的失败（数据目录不存在、无数据文件、复制失败、校验失败、
 * 采集期数据变化）都通过 `{ok:false, error:{code, message}}` 返回，
 * 失败时快照目录改名为 `<name>.incomplete`，恢复工具不会把它当完整备份。
 *
 * @param {{dataDir?: string, outRoot?: string, keep?: number,
 *          staleHours?: number, now?: number, snapshotName?: string,
 *          excludeSecrets?: boolean, encryptSecrets?: boolean,
 *          backupKey?: string}} [options]
 *   - excludeSecrets 默认 true：api-keys.json 不进快照
 *   - encryptSecrets 默认 false：若 true，需 backupKey（环境变量 BLUEBIRD_BACKUP_KEY
 *     或 options.backupKey），把密钥加密为 <name>.enc 后入库，明文不出现
 */
function createBackup(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const outRoot = resolveOutRoot(options.outRoot);
  const keep = Number.isInteger(options.keep) ? options.keep : DEFAULT_KEEP;
  const staleHours =
    typeof options.staleHours === 'number' ? options.staleHours : DEFAULT_STALE_HOURS;
  const nowMs = typeof options.now === 'number' ? options.now : Date.now();
  const excludeSecrets = options.excludeSecrets !== false;
  const encryptSecrets = options.encryptSecrets === true;
  const backupKey = options.backupKey || process.env.BLUEBIRD_BACKUP_KEY || '';

  const startedAt = nowMs;
  const result = {
    ok: false,
    dataDir,
    outRoot,
    snapshotDir: null,
    durationMs: 0,
    files: 0,
    dirs: 0,
    bytes: 0,
    consistent: false,
    sameVolumeAsSource: null,
    differentLogicalDrive: null,
    attempts: 0,
    skipped: [],
    skippedSecrets: [],
    error: null,
    retention: null,
  };

  const knownStatus = readJsonIfExists(statusPath(outRoot)) || {};
  let snapshotDir = null;

  const fail = (code, message) => {
    result.error = { code, message };
    result.durationMs = Date.now() - startedAt;
    result.consistent = false;

    // 半成品必须显式标记，不能让后续恢复把它当完整备份
    if (snapshotDir) {
      try {
        if (fs.existsSync(snapshotDir)) {
          const marked = `${snapshotDir}.incomplete`;

          fs.rmSync(marked, { recursive: true, force: true });
          fs.renameSync(snapshotDir, marked);
          result.snapshotDir = marked;
        }
      } catch (_) {
        result.snapshotDir = snapshotDir;
      }
    }

    recordFailure(result, knownStatus, staleHours, nowMs);

    return result;
  };

  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return fail('data_dir_missing', `数据目录不存在: ${dataDir}`);
  }

  // 备份根落在数据目录里 → 直接拒绝：那不是备份，只是另一份生产数据
  if (isInside(outRoot, dataDir)) {
    return fail(
      'out_root_inside_data',
      `备份根不能位于数据目录内: ${outRoot}`
    );
  }

  if (isInside(dataDir, outRoot)) {
    return fail(
      'data_inside_out_root',
      `数据目录不能位于备份根内: ${dataDir}`
    );
  }

  // 加密模式下要重新把密钥文件纳入采集，再单独加密入库
  const collectExcludeSecrets = !(encryptSecrets && backupKey);
  const { files, dirs, skipped, skippedSecrets } = collectEntries(dataDir, {
    excludeSecrets: collectExcludeSecrets,
  });
  const derivedKey = encryptSecrets && backupKey ? deriveKey(backupKey) : null;

  result.skipped = skipped;
  result.skippedSecrets = skippedSecrets;

  if (encryptSecrets && !backupKey) {
    return fail(
      'missing_backup_key',
      'encryptSecrets 已开启但缺少 BLUEBIRD_BACKUP_KEY，无法加密密钥文件'
    );
  }

  if (files.length === 0) {
    return fail('no_data_files', `数据目录里没有可备份的数据文件: ${dataDir}`);
  }

  try {
    ensureDir(outRoot);

    const baseName = options.snapshotName || `data-${utcStamp(nowMs)}`;
    let candidate = path.join(outRoot, baseName);
    let suffix = 2;

    // 不覆盖已存在的快照目录
    while (fs.existsSync(candidate)) {
      candidate = path.join(outRoot, `${baseName}-${suffix}`);
      suffix += 1;
    }

    snapshotDir = candidate;
    ensureDir(snapshotDir);
    result.snapshotDir = snapshotDir;

    // ---- 采集：先记源文件 size/mtime，再复制，最后复核源是否在拷贝期间变化
    const sourceStats = new Map();
    const entries = [];

    for (const rel of files) {
      const abs = path.join(dataDir, rel);
      const st = fs.statSync(abs);

      sourceStats.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
    }

    const copyOne = rel => {
      const abs = path.join(dataDir, rel);

      // 加密通道：密钥文件写成 <name>.enc，明文不进快照
      if (encryptSecrets && derivedKey && isSecretFile(rel)) {
        const dest = path.join(snapshotDir, `${rel}.enc`);

        ensureDir(path.dirname(dest));

        const enc = encryptBuffer(fs.readFileSync(abs), derivedKey);

        fs.writeFileSync(dest, `${JSON.stringify(enc)}\n`, 'utf8');
        try {
          fs.chmodSync(dest, 0o600);
        } catch (_) {
          /* best-effort */
        }

        return dest;
      }

      const dest = path.join(snapshotDir, rel);

      ensureDir(path.dirname(dest));
      fs.copyFileSync(abs, dest);

      return dest;
    };

    let attempt = 0;

    for (; attempt < MAX_COPY_ATTEMPTS; attempt += 1) {
      for (const rel of files) copyOne(rel);

      // 复核：采集期源文件是否被改写
      const changed = files.filter(rel => {
        const before = sourceStats.get(rel);
        const st = fs.statSync(path.join(dataDir, rel));

        return st.size !== before.size || st.mtimeMs !== before.mtimeMs;
      });

      if (changed.length === 0) break;

      // 改写了就重来一轮：单文件原子落盘，重读到的是完整的新版本
      for (const rel of changed) {
        const st = fs.statSync(path.join(dataDir, rel));

        sourceStats.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      }

      if (attempt === MAX_COPY_ATTEMPTS - 1) {
        result.attempts = attempt + 1;

        return fail(
          'source_changed_during_copy',
          `采集期间有 ${changed.length} 个源文件被改写，重试后仍不稳定: ${changed
            .slice(0, 5)
            .join(', ')}`
        );
      }
    }

    result.attempts = attempt + 1;

    // ---- 逐文件：SHA-256 + 结构校验（源与副本必须一致）
    let bytes = 0;

    for (const rel of files) {
      const srcAbs = path.join(dataDir, rel);

      // 加密密钥：校验「能解密回明文且与原文件一致」，不校验 JSON 结构
      if (encryptSecrets && derivedKey && isSecretFile(rel)) {
        const destAbs = path.join(snapshotDir, `${rel}.enc`);

        if (!fs.existsSync(destAbs)) {
          return fail('copy_missing', `加密副本缺失: ${rel}.enc`);
        }

        const enc = JSON.parse(fs.readFileSync(destAbs, 'utf8'));
        const plain = fs.readFileSync(srcAbs);

        let restored;

        try {
          restored = decryptBuffer(enc, derivedKey);
        } catch (_) {
          return fail('secret_decrypt_failed', `密钥解密失败: ${rel}`);
        }

        if (restored.toString('utf8') !== plain.toString('utf8')) {
          return fail(
            'secret_decrypt_mismatch',
            `密钥解密后与原文不一致: ${rel}`
          );
        }

        const encBuf = fs.readFileSync(destAbs);

        entries.push({
          path: `${rel}.enc`,
          originalPath: rel,
          bytes: encBuf.length,
          sha256: sha256Text(encBuf),
          plainSha256: sha256Text(plain),
          structure: 'secret_enc',
        });
        bytes += encBuf.length;

        continue;
      }

      const destAbs = path.join(snapshotDir, rel);

      if (!fs.existsSync(destAbs)) {
        return fail('copy_missing', `副本缺失: ${rel}`);
      }

      const buf = fs.readFileSync(srcAbs);
      const check = validateDataFile(rel, buf);

      if (!check.ok) {
        return fail(
          `invalid_data_file:${check.reason}`,
          `数据文件校验失败: ${rel} (${check.reason}${
            check.detail ? ` / ${check.detail}` : ''
          })`
        );
      }

      const srcHash = sha256Text(buf);
      const destHash = sha256File(destAbs);

      if (srcHash !== destHash) {
        return fail('copy_checksum_mismatch', `SHA-256 不一致: ${rel}`);
      }

      entries.push({
        path: rel,
        bytes: buf.length,
        sha256: srcHash,
        structure: check.structure,
      });

      bytes += buf.length;
    }

    result.files = entries.length;
    result.dirs = dirs.length;
    result.bytes = bytes;
    result.consistent = true;
    result.sameVolumeAsSource = isSameVolume(outRoot, dataDir);
    result.differentLogicalDrive = !result.sameVolumeAsSource;

    const manifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      kind: BACKUP_KIND,
      createdAt: new Date(nowMs).toISOString(),
      source: dataDir,
      snapshot: path.basename(snapshotDir),
      durationMs: Date.now() - startedAt,
      consistent: true,
      sameVolumeAsSource: result.sameVolumeAsSource,
      copyAttempts: result.attempts,
      counts: { files: entries.length, dirs: dirs.length, bytes },
      dirs,
      skippedRuntime: skipped,
      skippedSecrets,
      differentLogicalDrive: result.differentLogicalDrive,
      files: entries,
    };

    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = path.join(snapshotDir, MANIFEST_JSON);

    fs.writeFileSync(manifestPath, manifestJson, 'utf8');

    // 人读版清单：保留旧脚本的报告习惯，字段更全
    const txtLines = [
      '# Bluebird data backup',
      `# source:    ${dataDir}`,
      `# created:   ${manifest.createdAt}`,
      `# files:     ${entries.length}`,
      `# dirs:      ${dirs.length}`,
      `# bytes:     ${bytes} (${formatBytes(bytes)})`,
      `# skipped:   ${skipped.length ? skipped.join(' ') : '(none)'}`,
      `# skipped-secrets: ${skippedSecrets.length ? skippedSecrets.join(' ') : '(none)'}`,
      `# same-vol:  ${result.sameVolumeAsSource}`,
      `# diff-drive: ${result.differentLogicalDrive}`,
      `# dr-grade:  false (本地备份无法确认是否异机/远端，需由部署层核实独立存储)`,
      '# files:     (path  bytes  sha256)',
      ...entries.map(e => `${e.path}  ${e.bytes}  ${e.sha256}`),
    ];

    fs.writeFileSync(
      path.join(snapshotDir, MANIFEST_TXT),
      `${txtLines.join('\n')}\n`,
      'utf8'
    );

    // 含明文密钥的副本收紧权限（best-effort；Windows 上 chmod 基本无效，见 AGENTS.md）
    try {
      fs.chmodSync(snapshotDir, 0o700);
      const keysCopy = path.join(snapshotDir, 'api-keys.json');

      if (fs.existsSync(keysCopy)) fs.chmodSync(keysCopy, 0o600);
    } catch (_) {
      /* 权限收紧失败不改变「备份是否可用」的结论，但会在状态里如实反映同卷风险 */
    }

    result.ok = true;
    result.durationMs = Date.now() - startedAt;

    appendJsonLine(runLogPath(outRoot), {
      ts: new Date(nowMs).toISOString(),
      ok: true,
      snapshot: path.basename(snapshotDir),
      snapshotDir,
      source: dataDir,
      durationMs: result.durationMs,
      files: entries.length,
      bytes,
      consistent: true,
      sameVolumeAsSource: result.sameVolumeAsSource,
      manifestSha256: sha256Text(manifestJson),
      error: null,
    });

    writeJsonAtomic(statusPath(outRoot), {
      version: 1,
      staleAfterHours: staleHours,
      lastRunAt: new Date(nowMs).toISOString(),
      lastRunOk: true,
      lastSuccessAt: new Date(nowMs).toISOString(),
      lastSuccessSnapshot: path.basename(snapshotDir),
      lastSuccessBytes: bytes,
      lastSuccessFiles: entries.length,
      consecutiveFailures: 0,
      lastError: null,
      sameVolumeAsSource: result.sameVolumeAsSource,
      differentLogicalDrive: result.differentLogicalDrive,
      // 本地备份路径无法确认目标是否落在异机/远端；真正的灾难恢复需要 off-host。
      // 因此 disasterRecoveryGrade 在本地路径下永远为 false，必须由部署层去核实
      // 备份根是否指向独立存储（另一块物理盘或远端）。不同盘符 ≠ 不同物理盘。
      disasterRecoveryGrade: false,
      offHostUnverified: true,
    });

    result.retention = applyRetention(outRoot, keep);

    return result;
  } catch (error) {
    return fail('io_error', `${error && error.message ? error.message : error}`);
  }
}

function recordFailure(result, knownStatus, staleHours, nowMs) {
  const outRoot = result.outRoot;

  try {
    appendJsonLine(runLogPath(outRoot), {
      ts: new Date(nowMs).toISOString(),
      ok: false,
      snapshot: result.snapshotDir ? path.basename(result.snapshotDir) : null,
      snapshotDir: result.snapshotDir,
      source: result.dataDir,
      durationMs: result.durationMs,
      files: result.files,
      bytes: result.bytes,
      consistent: false,
      sameVolumeAsSource: result.sameVolumeAsSource,
      manifestSha256: null,
      error: result.error,
    });

    writeJsonAtomic(statusPath(outRoot), {
      version: 1,
      staleAfterHours: staleHours,
      lastRunAt: new Date(nowMs).toISOString(),
      lastRunOk: false,
      // 失败不清空上一次成功时间：陈旧判定要基于「最后一次真正成功」
      lastSuccessAt: knownStatus.lastSuccessAt || null,
      lastSuccessSnapshot: knownStatus.lastSuccessSnapshot || null,
      lastSuccessBytes: knownStatus.lastSuccessBytes || null,
      lastSuccessFiles: knownStatus.lastSuccessFiles || null,
      consecutiveFailures: (knownStatus.consecutiveFailures || 0) + 1,
      lastError: result.error,
      sameVolumeAsSource:
        result.sameVolumeAsSource === null
          ? knownStatus.sameVolumeAsSource ?? null
          : result.sameVolumeAsSource,
      disasterRecoveryGrade: knownStatus.disasterRecoveryGrade ?? false,
    });
  } catch (_) {
    /* 状态写入失败不能掩盖原始错误 */
  }
}

// ---------------------------------------------------------------- 状态判定

/** 读最近一次状态；不存在返回 null。 */
function readStatus(outRoot) {
  const root = outRoot ? resolveOutRoot(outRoot) : resolveOutRoot();

  return readJsonIfExists(statusPath(root));
}

/**
 * 陈旧 / 失败判定：给 `--check` 用。
 * 只根据状态文件判断，不代表本机已配置定时任务。
 *
 * @returns {{exists:boolean, ok:boolean, stale:boolean, ageHours:number|null,
 *            reason:string|null, status:object|null}}
 */
function checkStatus(outRoot, options = {}) {
  const root = resolveOutRoot(outRoot);
  const maxAgeHours =
    typeof options.maxAgeHours === 'number'
      ? options.maxAgeHours
      : typeof options.staleHours === 'number'
        ? options.staleHours
        : DEFAULT_STALE_HOURS;
  const nowMs = typeof options.now === 'number' ? options.now : Date.now();
  const status = readJsonIfExists(statusPath(root));

  if (!status) {
    return {
      exists: false,
      ok: false,
      stale: true,
      ageHours: null,
      reason: 'no_status_file',
      status: null,
      outRoot: root,
    };
  }

  if (!status.lastSuccessAt) {
    return {
      exists: true,
      ok: false,
      stale: true,
      ageHours: null,
      reason: 'never_succeeded',
      status,
      outRoot: root,
    };
  }

  const ageHours =
    Math.round(
      ((nowMs - Date.parse(status.lastSuccessAt)) / 3600000) * 100
    ) / 100;

  if (ageHours > maxAgeHours) {
    return {
      exists: true,
      ok: false,
      stale: true,
      ageHours,
      reason: 'stale',
      maxAgeHours,
      status,
      outRoot: root,
    };
  }

  if (status.lastRunOk === false) {
    return {
      exists: true,
      ok: false,
      stale: false,
      ageHours,
      reason: 'last_run_failed',
      maxAgeHours,
      status,
      outRoot: root,
    };
  }

  return {
    exists: true,
    ok: true,
    stale: false,
    ageHours,
    reason: null,
    maxAgeHours,
    status,
    outRoot: root,
  };
}

// ---------------------------------------------------------------- 校验 / 恢复

/**
 * 校对一个快照目录：MANIFEST 可读、逐文件存在、大小一致、SHA-256 一致、结构有效。
 * 只读，不改任何内容。
 */
function verifySnapshot(snapshotDir) {
  const manifestPath = path.join(snapshotDir, MANIFEST_JSON);
  const manifest = readJsonIfExists(manifestPath);

  if (!manifest) {
    return {
      ok: false,
      problems: [{ code: 'manifest_missing', message: `缺少或无法解析 ${MANIFEST_JSON}` }],
      files: 0,
      bytes: 0,
      missing: 0,
      mismatched: 0,
      invalid: 0,
      manifest: null,
    };
  }

  return verifyAgainstManifest(snapshotDir, manifest);
}

/**
 * 用给定 MANIFEST 校验某个目录里的文件（恢复后复核也走这里：
 * 恢复目标里不该多出 MANIFEST，所以不能重新读目标目录自己的清单）。
 */
function verifyAgainstManifest(baseDir, manifest) {
  const problems = [];

  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    problems.push({
      code: 'manifest_version',
      message: `不支持的 MANIFEST 版本: ${manifest.formatVersion}`,
    });
  }

  const list = Array.isArray(manifest.files) ? manifest.files : [];
  let bytes = 0;
  let missing = 0;
  let mismatched = 0;
  let invalid = 0;

  if (list.length === 0) {
    problems.push({ code: 'empty_snapshot', message: '快照里没有任何文件记录' });
  }

  for (const item of list) {
    const abs = path.join(baseDir, item.path);

    if (!fs.existsSync(abs)) {
      problems.push({ code: 'missing_file', message: `缺少文件: ${item.path}` });
      missing += 1;
      continue;
    }

    const buf = fs.readFileSync(abs);

    if (buf.length === 0) {
      problems.push({ code: 'empty_file', message: `文件为空: ${item.path}` });
      invalid += 1;
      continue;
    }

    if (typeof item.bytes === 'number' && buf.length !== item.bytes) {
      problems.push({
        code: 'size_mismatch',
        message: `大小不一致: ${item.path} (${buf.length} != ${item.bytes})`,
      });
      mismatched += 1;
      continue;
    }

    const hash = sha256Text(buf);

    if (hash !== item.sha256) {
      problems.push({
        code: 'checksum_mismatch',
        message: `SHA-256 不一致: ${item.path}`,
      });
      mismatched += 1;
      continue;
    }

    const check = validateDataFile(item.path, buf);

    if (!check.ok) {
      problems.push({
        code: `invalid_${check.reason}`,
        message: `结构校验失败: ${item.path} (${check.reason})`,
      });
      invalid += 1;
      continue;
    }

    bytes += buf.length;
  }

  return {
    ok: problems.length === 0,
    problems,
    files: list.length,
    bytes,
    missing,
    mismatched,
    invalid,
    manifest,
  };
}

/**
 * 把快照恢复到一个**独立目录**（绝不写快照本身、绝不碰生产数据）。
 * 先校验后复制，复制后再逐文件比对 SHA-256。
 */
function restoreSnapshot(snapshotDir, targetDir) {
  const startedAt = Date.now();
  const verification = verifySnapshot(snapshotDir);

  if (!verification.ok) {
    return {
      ok: false,
      stage: 'verify',
      durationMs: Date.now() - startedAt,
      problems: verification.problems,
      restored: 0,
      bytes: 0,
      targetDir,
    };
  }

  try {
    ensureDir(targetDir);

    // 恢复时若遇到加密密钥条目，必须能拿到口令；否则直接失败，绝不落半份数据
    const hasSecret = verification.manifest.files.some(
      item => item.structure === 'secret_enc'
    );
    const restoreKey = hasSecret
      ? process.env.BLUEBIRD_BACKUP_KEY
        ? deriveKey(process.env.BLUEBIRD_BACKUP_KEY)
        : null
      : null;

    if (hasSecret && !restoreKey) {
      return {
        ok: false,
        stage: 'restore',
        durationMs: Date.now() - startedAt,
        problems: [
          {
            code: 'restore_missing_key',
            message: '快照含加密密钥，但恢复时缺少 BLUEBIRD_BACKUP_KEY',
          },
        ],
        restored: 0,
        bytes: 0,
        targetDir,
      };
    }

    for (const item of verification.manifest.files) {
      const src = path.join(snapshotDir, item.path);

      if (item.structure === 'secret_enc') {
        const enc = JSON.parse(fs.readFileSync(src, 'utf8'));
        const plain = decryptBuffer(enc, restoreKey);
        const dest = path.join(targetDir, item.originalPath);

        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, plain);
        try {
          fs.chmodSync(dest, 0o600);
        } catch (_) {
          /* best-effort */
        }

        continue;
      }

      const dest = path.join(targetDir, item.path);

      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }

    // 恢复后再核一遍：复制/解密过程本身也可能出错（磁盘满、权限、口令错）。
    // 目标目录里刻意没有 MANIFEST（数据目录不该被清单污染），故复用源清单；
    // 加密条目翻译为「明文 originalPath + 明文 sha」再校验。
    const recheckManifest = {
      ...verification.manifest,
      files: verification.manifest.files.map(item => {
        if (item.structure === 'secret_enc') {
          const src = path.join(snapshotDir, item.path);
          const enc = JSON.parse(fs.readFileSync(src, 'utf8'));
          const plain = decryptBuffer(enc, restoreKey);

          return {
            ...item,
            path: item.originalPath,
            bytes: plain.length,
            sha256: item.plainSha256,
            structure: 'json_object',
          };
        }

        return item;
      }),
    };
    const recheck = verifyAgainstManifest(targetDir, recheckManifest);

    if (!recheck.ok) {
      return {
        ok: false,
        stage: 'recheck',
        durationMs: Date.now() - startedAt,
        problems: recheck.problems,
        restored: verification.manifest.files.length,
        bytes: verification.bytes,
        targetDir,
      };
    }

    return {
      ok: true,
      stage: 'done',
      durationMs: Date.now() - startedAt,
      problems: [],
      restored: recheck.files,
      bytes: recheck.bytes,
      targetDir,
    };
  } catch (error) {
    return {
      ok: false,
      stage: 'copy',
      durationMs: Date.now() - startedAt,
      problems: [
        {
          code: 'io_error',
          message: error && error.message ? error.message : String(error),
        },
      ],
      restored: 0,
      bytes: 0,
      targetDir,
    };
  }
}

/**
 * 对整个数据目录做「全树摘要」：排序后的 `相对路径:sha256` 再哈希。
 * 用来证明恢复演练前后生产数据一字未动。
 */
function hashTree(dir) {
  const { files } = collectEntries(dir);
  const lines = [];
  let bytes = 0;

  for (const rel of files.slice().sort()) {
    const abs = path.join(dir, rel);
    const buf = fs.readFileSync(abs);

    bytes += buf.length;
    lines.push(`${rel}:${sha256Text(buf)}`);
  }

  return {
    files: files.length,
    bytes,
    digest: sha256Text(lines.join('\n')),
  };
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  DEFAULT_KEEP,
  DEFAULT_STALE_HOURS,
  MANIFEST_JSON,
  MANIFEST_TXT,
  RUN_LOG_NAME,
  STATUS_FILE_NAME,
  DRILL_LOG_NAME,
  STATE_DIR_NAME,
  isRuntimeArtifact,
  isSecretFile,
  deriveKey,
  encryptBuffer,
  decryptBuffer,
  resolveDataDir,
  resolveOutRoot,
  collectEntries,
  validateDataFile,
  sha256File,
  sha256Text,
  isSameVolume,
  isInside,
  createBackup,
  applyRetention,
  listSnapshots,
  latestSnapshot,
  readStatus,
  checkStatus,
  verifySnapshot,
  restoreSnapshot,
  hashTree,
  formatBytes,
  runLogPath,
  statusPath,
  drillLogPath,
  stateDirOf,
};
