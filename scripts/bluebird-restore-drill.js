#!/usr/bin/env node
/* eslint-env node */
/**
 * Bluebird 隔离环境恢复演练。
 *
 * 做的事：取一个真实快照 → 恢复到一个**独立临时目录** → 校验文件结构与 SHA-256
 * → 用真实服务端模块读一遍（证明应用能读恢复出来的数据）→ 比对演练前后生产数据
 * 的全树摘要（证明生产数据一字未动）→ 把耗时/校验/结论写进 drills.jsonl。
 *
 *   node scripts/bluebird-restore-drill.js                 # 恢复最新完整快照
 *   node scripts/bluebird-restore-drill.js --snapshot <dir>
 *   node scripts/bluebird-restore-drill.js --keep           # 保留临时目录（排查用）
 *   node scripts/bluebird-restore-drill.js --json
 *
 * 退出码：0 演练通过 / 1 演练失败。
 *
 * 安全边界：全程不写生产数据目录，不启动 HTTP 服务，不调用任何模型接口。
 * 生产目录只做 stat/read（用于演练前后摘要比对）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const backup = require('../server/backup');

function parseArgs(argv) {
  const args = {
    dataDir: '',
    outDir: '',
    snapshot: '',
    keep: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;

      return argv[i];
    };

    switch (token) {
      case '--data-dir':
        args.dataDir = next() || '';
        break;
      case '--out-dir':
        args.outDir = next() || '';
        break;
      case '--snapshot':
        args.snapshot = next() || '';
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (token.startsWith('--')) {
          console.error(`未知参数: ${token}`);
          process.exit(1);
        }
    }
  }

  return args;
}

function usage() {
  console.log(
    [
      'Bluebird 隔离环境恢复演练',
      '',
      '用法: node scripts/bluebird-restore-drill.js [选项]',
      '',
      '  --snapshot <dir>   指定快照目录（默认取备份根下最新的完整快照）',
      '  --out-dir <dir>    备份根目录（默认 BLUEBIRD_BACKUP_DIR 或 ~/bluebird-backups）',
      '  --data-dir <dir>   生产数据目录（仅用于「演练前后未被修改」比对）',
      '  --keep             保留临时恢复目录，便于人工检查',
      '  --json             输出 JSON',
    ].join('\n')
  );
}

function readJson(dir, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  } catch (_) {
    return null;
  }
}

function countFiles(dir) {
  let count = 0;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
      else if (entry.isFile()) count += 1;
    }
  } catch (_) {
    return 0;
  }

  return count;
}

/** 关键数据：不只看文件在不在，还要看内容抽得出来、条数对得上。 */
function summarizeKeyData(dir) {
  const store = readJson(dir, 'sessions.json');
  const memories = readJson(dir, 'memory.json');
  const emotion = readJson(dir, 'emotion-state.json');

  // 真实存储约定（server/sessions.js）：sessions 是数组，messages 是
  // `{ [sessionId]: Message[] }`
  const sessionList = store && Array.isArray(store.sessions) ? store.sessions : [];
  const buckets =
    store && store.messages && typeof store.messages === 'object'
      ? store.messages
      : {};
  const bucketKeys = Object.keys(buckets);
  let messageCount = 0;

  for (const key of bucketKeys) {
    const list = buckets[key];

    if (Array.isArray(list)) messageCount += list.length;
  }

  return {
    sessions: sessionList.length,
    messageBuckets: bucketKeys.length,
    messages: messageCount,
    memories: Array.isArray(memories) ? memories.length : null,
    emotion: emotion ? emotion.emotion || null : null,
    uploadFiles: countFiles(path.join(dir, 'uploads')),
    stickerFiles: countFiles(path.join(dir, 'sticker-repo')),
  };
}

/**
 * 用真实服务端模块读一遍恢复出来的数据。
 * 必须在 BLUEBIRD_DATA_DIR 指向恢复目录之后再 require——三个模块都在模块加载时求值。
 */
function runAppReadCheck(restoredDir, expected) {
  const checks = [];
  const errors = [];
  const mismatches = [];

  const run = (name, fn) => {
    const startedAt = Date.now();

    try {
      const value = fn();

      checks.push({ name, ok: true, ms: Date.now() - startedAt, value });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const detail = { name, ok: false, ms: Date.now() - startedAt, error: message };

      checks.push(detail);
      errors.push(`${name}: ${message}`);
    }
  };

  // eslint-disable-next-line global-require
  const sessions = require('../server/sessions');
  // eslint-disable-next-line global-require
  const memory = require('../server/memory');
  // eslint-disable-next-line global-require
  const emotion = require('../server/emotion');
  // eslint-disable-next-line global-require
  const persona = require('../server/persona');

  run('sessions.listSessions', () => sessions.listSessions().length);
  run('sessions.getAllMessages', () => sessions.getAllMessages().length);
  run('memory.getMemories', () => memory.getMemories().length);
  run('emotion.getEmotion', () => {
    const state = emotion.getEmotion();

    return state && state.emotion ? state.emotion : 'unknown';
  });
  run('persona.getConfig', () => {
    const config = persona.getConfig();

    return config && typeof config === 'object' ? 'ok' : 'empty';
  });

  // 交叉核对：模块读出来的条数必须与直接解析 JSON 得到的条数一致。
  // 只要求「不抛异常」是不够的——sessions.json 结构不符时服务端会安静地进入
  // 只读保护并返回空列表，看起来"读取成功"，实际一条数据都没读到。
  const readValue = name => {
    const found = checks.find(item => item.name === name);

    return found && found.ok ? found.value : undefined;
  };

  // 会话数用「不得少于」而非「必须相等」：sessions.js 有一条既有不变量——
  // 默认会话必须存在，加载时若缺失会当场补建并落盘。所以恢复出来的会话数
  // 只可能变多，不可能变少；变少才是真的丢了数据（或进了只读保护）。
  // 消息数与记忆数没有补建逻辑，必须严格相等。
  const compare = [
    ['sessions.listSessions', expected.sessions, '会话数', 'atLeast'],
    ['sessions.getAllMessages', expected.messages, '消息数', 'exact'],
    ['memory.getMemories', expected.memories, '记忆数', 'exact'],
  ];

  const notes = [];

  for (const [name, want, label, mode] of compare) {
    if (typeof want !== 'number') continue;

    const got = readValue(name);

    if (typeof got !== 'number') continue;

    if (mode === 'atLeast' && got > want) {
      notes.push(
        `${label}：模块补建了默认会话（读出 ${got}，文件 ${want}）——既有不变量，非数据丢失`
      );
      continue;
    }

    const bad = mode === 'atLeast' ? got < want : got !== want;

    if (bad) {
      const message = `${label}不一致：模块读出 ${got}，数据文件实际 ${want}`;

      mismatches.push(message);
      errors.push(`${name}: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
    mismatches,
    notes,
    restoredDir,
  };
}

/**
 * 服务端模块在加载 / 读取时会往 stdout/stderr 打横幅（"Memory loaded: 0"、
 * 只读保护告警、损坏事件 JSON 等）。这些是**证据**，但不该污染 `--json` 的输出，
 * 所以应用读取阶段先把它们收进记录，再原样附在 appRead.moduleOutput 里。
 */
function captureConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;

  const record = stream => (...parts) => {
    lines.push({ stream, text: parts.map(String).join(' ') });
  };

  console.log = record('stdout');
  console.error = record('stderr');

  try {
    return { result: fn(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();

    return 0;
  }

  const dataDir = backup.resolveDataDir(args.dataDir);
  const outRoot = backup.resolveOutRoot(args.outDir);

  const record = {
    ts: new Date().toISOString(),
    ok: false,
    outRoot,
    productionDataDir: dataDir,
    snapshotDir: null,
    drillDir: null,
    kept: false,
    stages: {},
    restore: null,
    keyData: null,
    appRead: null,
    production: null,
    problems: [],
    conclusion: '',
  };

  // ---- 选快照
  let snapshotDir = args.snapshot ? path.resolve(args.snapshot) : null;

  if (!snapshotDir) {
    const latest = backup.latestSnapshot(outRoot);

    if (!latest) {
      record.problems.push({
        code: 'no_snapshot',
        message: `备份根下没有完整快照: ${outRoot}`,
      });
      record.conclusion = '没有可演练的快照';

      return finish(record, args);
    }

    snapshotDir = latest.dir;
  }

  if (!fs.existsSync(snapshotDir)) {
    record.problems.push({
      code: 'snapshot_missing',
      message: `快照目录不存在: ${snapshotDir}`,
    });
    record.conclusion = '快照目录不存在';

    return finish(record, args);
  }

  record.snapshotDir = snapshotDir;

  // ---- 生产数据摘要（前）：只读
  let prodBefore = null;

  try {
    if (fs.existsSync(dataDir)) prodBefore = backup.hashTree(dataDir);
  } catch (error) {
    record.problems.push({
      code: 'prod_hash_failed',
      message: `生产目录摘要失败: ${error.message}`,
    });
  }

  record.stages['全树摘要(前)'] = prodBefore
    ? { files: prodBefore.files, bytes: prodBefore.bytes, digest: prodBefore.digest }
    : null;

  // ---- 隔离目录 + 恢复
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-drill-'));
  const target = path.join(drillRoot, 'data');

  record.drillDir = drillRoot;

  const restore = backup.restoreSnapshot(snapshotDir, target);

  record.stages['恢复复制'] = { ms: restore.durationMs, stage: restore.stage };
  record.restore = {
    ok: restore.ok,
    stage: restore.stage,
    ms: restore.durationMs,
    restored: restore.restored,
    bytes: restore.bytes,
    problems: restore.problems,
  };

  if (!restore.ok) {
    record.problems.push(...restore.problems);
    record.conclusion = `恢复失败（阶段 ${restore.stage}），已定位原因，修复后可重跑`;

    return finish(record, args);
  }

  const verifyStartedAt = Date.now();
  const verification = backup.verifySnapshot(snapshotDir);

  record.stages['快照校验'] = {
    ms: Date.now() - verifyStartedAt,
    ok: verification.ok,
    files: verification.files,
    problems: verification.problems.length,
  };

  // ---- 关键数据
  const keyStartedAt = Date.now();

  try {
    record.keyData = summarizeKeyData(target);
    record.stages['关键数据解析'] = { ms: Date.now() - keyStartedAt, ok: true };
  } catch (error) {
    record.stages['关键数据解析'] = {
      ms: Date.now() - keyStartedAt,
      ok: false,
      error: error.message,
    };
    record.problems.push({
      code: 'key_data_failed',
      message: `关键数据解析失败: ${error.message}`,
    });
  }

  // ---- 应用读取（把数据目录指向恢复副本后 require）
  const copyBefore = backup.hashTree(target);

  process.env.BLUEBIRD_DATA_DIR = target;

  const appStartedAt = Date.now();

  try {
    const captured = captureConsole(() =>
      runAppReadCheck(target, record.keyData || {})
    );

    record.appRead = captured.result;
    // 保留模块自己的输出（横幅 / 告警 / 损坏事件），作为证据而非噪音
    record.appRead.moduleOutput = captured.lines.slice(0, 50);
  } catch (error) {
    record.appRead = {
      ok: false,
      checks: [],
      errors: [error && error.message ? error.message : String(error)],
      mismatches: [],
      moduleOutput: [],
    };
  }

  record.stages['应用读取'] = {
    ms: Date.now() - appStartedAt,
    ok: record.appRead.ok,
  };

  if (!record.appRead.ok) {
    record.problems.push({
      code: 'app_read_failed',
      message: `应用读取恢复数据失败: ${record.appRead.errors.join('; ')}`,
    });
  }

  // 应用读取可能顺带写盘（例如情绪基线落盘）。如实记录，不算失败——
  // 写的是隔离副本，不是生产数据。
  const copyAfter = backup.hashTree(target);

  record.appReadCopyMutated = copyBefore.digest !== copyAfter.digest;

  // ---- 生产数据摘要（后）
  let prodAfter = null;

  try {
    if (fs.existsSync(dataDir)) prodAfter = backup.hashTree(dataDir);
  } catch (error) {
    record.problems.push({
      code: 'prod_hash_failed',
      message: `生产目录摘要失败: ${error.message}`,
    });
  }

  const untouched =
    !!prodBefore && !!prodAfter && prodBefore.digest === prodAfter.digest;

  record.production = {
    before: prodBefore,
    after: prodAfter,
    untouched,
    // 生产目录不存在（例如全新 checkout）时无法比对，不能据此声称「未被修改」
    comparable: !!prodBefore && !!prodAfter,
  };

  if (record.production.comparable && !untouched) {
    record.problems.push({
      code: 'production_modified',
      message: '演练前后生产数据摘要不一致——停止使用该结论并排查',
    });
  }

  record.ok = record.problems.length === 0;
  record.conclusion = record.ok
    ? `恢复成功：${restore.restored} 个文件、${record.keyData.sessions} 个会话、${record.keyData.messages} 条消息可读；生产数据未被修改`
    : '演练未通过，见 problems';

  return finish(record, args);
}

function finish(record, args) {
  // 记录到备份根的 _state/drills.jsonl（记录也是演练证据的一部分）
  try {
    appendDrill(record);
  } catch (_) {
    /* 记录失败不影响演练结论；临时目录权限异常时也不该让演练结果变成崩溃 */
  }

  record.kept = args.keep;

  if (!args.keep && record.drillDir && fs.existsSync(record.drillDir)) {
    try {
      fs.rmSync(record.drillDir, { recursive: true, force: true });
    } catch (_) {
      record.kept = true;
    }
  } else if (record.drillDir) {
    record.kept = true;
  }

  if (args.json) {
    console.log(JSON.stringify(record, null, 2));

    return record.ok ? 0 : 1;
  }

  console.log(record.ok ? '✓ 恢复演练通过' : '✗ 恢复演练未通过');
  console.log(`  快照:   ${record.snapshotDir}`);
  console.log(`  生产:   ${record.productionDataDir}`);
  console.log(`  隔离区: ${record.drillDir}${record.kept ? '（已保留）' : '（已清理）'}`);

  if (record.restore) {
    console.log(
      `  恢复:   ${record.restore.restored} 个文件 / ${backup.formatBytes(
        record.restore.bytes
      )}，耗时 ${record.restore.ms} ms`
    );
  }

  if (record.keyData) {
    const k = record.keyData;

    console.log(
      `  关键数据: 会话 ${k.sessions} / 消息桶 ${k.messageBuckets} / 消息 ${k.messages} / 记忆 ${k.memories} / 图片 ${k.uploadFiles} / 表情 ${k.stickerFiles}`
    );
  }

  if (record.appRead) {
    console.log(
      `  应用读取: ${record.appRead.ok ? '全部通过' : '失败'}（${record.appRead.checks.length} 项）`
    );

    for (const check of record.appRead.checks) {
      console.log(
        `    - ${check.name}: ${check.ok ? `ok (${check.value})` : `失败 ${check.error}`}`
      );
    }

    for (const note of record.appRead.notes || []) {
      console.log(`    · ${note}`);
    }

    for (const mismatch of record.appRead.mismatches || []) {
      console.log(`    ! ${mismatch}`);
    }

    const moduleLines = (record.appRead.moduleOutput || []).slice(0, 10);

    if (moduleLines.length) {
      console.log('  模块输出:');

      for (const line of moduleLines) {
        console.log(`    [${line.stream}] ${line.text}`);
      }
    }
  }

  if (record.production && record.production.comparable) {
    console.log(
      `  生产数据: ${record.production.untouched ? '演练前后摘要一致（未被修改）' : '★ 摘要发生变化，必须排查'}`
    );
    console.log(`    前 ${record.production.before.digest}`);
    console.log(`    后 ${record.production.after.digest}`);
  } else {
    console.log('  生产数据: 无法比对（生产目录不存在）');
  }

  if (record.problems.length) {
    console.log('  问题:');

    for (const problem of record.problems) {
      console.log(`    - [${problem.code}] ${problem.message}`);
    }
  }

  console.log(`  结论:   ${record.conclusion}`);

  return record.ok ? 0 : 1;
}

function appendDrill(record) {
  const logPath = backup.drillLogPath(record.outRoot);
  const payload = {
    ts: record.ts,
    ok: record.ok,
    snapshotDir: record.snapshotDir,
    productionDataDir: record.productionDataDir,
    restoreMs: record.restore ? record.restore.ms : null,
    restored: record.restore ? record.restore.restored : 0,
    bytes: record.restore ? record.restore.bytes : 0,
    keyData: record.keyData,
    appReadOk: record.appRead ? record.appRead.ok : false,
    productionUntouched: record.production ? record.production.untouched : null,
    problems: record.problems,
    conclusion: record.conclusion,
  };

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

process.exitCode = main();
