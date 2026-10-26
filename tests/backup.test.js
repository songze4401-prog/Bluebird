/* eslint-env node */
/**
 * 备份 / 校验 / 恢复演练测试。
 *
 * 全部在 os.tmpdir() 下的临时目录里跑，绝不触碰真实 server/data：
 * 每个用例自建 fixtures，before 就设好 BLUEBIRD_DATA_DIR 兜底。
 *
 * 覆盖（对应任务书 D）：
 *  - 正常备份与校验（含 uploads/ 与 sticker-repo/ 两棵目录树）
 *  - 备份文件缺失 / 损坏 / 为空
 *  - 恢复失败及异常处理（不可用快照、无快照）
 *  - 恢复过程不修改生产数据
 *  - 运行日志与状态准确反映成功 / 失败 / 陈旧
 */

const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');

// 兜底隔离：万一有代码路径回落到默认数据目录，也只会落在临时目录
const GUARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-backup-guard-'));
process.env.BLUEBIRD_DATA_DIR = GUARD_DIR;

const backup = require('../server/backup');

let TMP_ROOT = '';

before(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-backup-test-'));
});

after(() => {
  for (const dir of [TMP_ROOT, GUARD_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* 清理失败不影响结论 */
    }
  }
});

let fixtureSeq = 0;

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * 造一份形状与真实环境一致的数据目录：
 * sessions.json 是 { version, sessions: [...], messages: { [id]: [...] } }，
 * 另有 uploads/ 与 sticker-repo/ 两棵目录树（旧脚本会漏掉它们）。
 */
function makeFixture(options = {}) {
  fixtureSeq += 1;

  const base = path.join(TMP_ROOT, `fx-${fixtureSeq}-${options.name || 'data'}`);
  const dataDir = path.join(base, 'data');
  const outRoot = path.join(base, 'backups');

  writeFile(
    path.join(dataDir, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 's1',
          title: '会话一',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:02.000Z',
        },
      ],
      messages: {
        s1: [
          {
            id: 'm1',
            role: 'user',
            content: '你好',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: '你好呀',
            createdAt: '2026-10-01T00:00:02.000Z',
          },
        ],
      },
    })
  );

  writeFile(
    path.join(dataDir, 'memory.json'),
    JSON.stringify([
      {
        content: '喜欢喝茶',
        type: 'fact',
        keywords: ['茶'],
        confidence: 0.9,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        contributions: [],
      },
    ])
  );

  writeFile(
    path.join(dataDir, 'emotion-state.json'),
    JSON.stringify({
      emotion: 'calm',
      intensity: 50,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
  );

  writeFile(
    path.join(dataDir, 'uploads/2026-10/a.png'),
    'fake-image-bytes'
  );
  writeFile(
    path.join(dataDir, 'sticker-repo/files/b.webp'),
    'fake-sticker-bytes'
  );
  writeFile(
    path.join(dataDir, 'sticker-repo/sticker-repo.json'),
    JSON.stringify({ version: 1, files: {} })
  );

  // 运行期产物：必须被排除
  writeFile(path.join(dataDir, '.bluebird.lock'), '{"pid":1}');
  writeFile(path.join(dataDir, 'sessions.json.tmp.9999'), 'partial');

  return { base, dataDir, outRoot };
}

function readJsonLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function snapshotDirs(outRoot) {
  if (!fs.existsSync(outRoot)) return [];

  return fs
    .readdirSync(outRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('data-'))
    .map(entry => entry.name)
    .sort();
}

describe('备份：正常路径', { concurrency: 1 }, () => {
  test('递归备份含 uploads/ 与 sticker-repo/，且排除运行期产物', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'happy' });
    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));
    assert.strictEqual(result.consistent, true);
    assert.ok(fs.existsSync(result.snapshotDir));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.snapshotDir, 'MANIFEST.json'), 'utf8')
    );
    const paths = manifest.files.map(item => item.path);

    // 旧脚本的致命缺陷：这两棵目录树会被静默跳过
    assert.ok(paths.includes('uploads/2026-10/a.png'), '必须备份聊天图片');
    assert.ok(
      paths.includes('sticker-repo/files/b.webp'),
      '必须备份表情包文件'
    );
    assert.ok(paths.includes('sessions.json'));

    // 运行期产物不得进快照，否则恢复时会误报「已有实例在运行」
    assert.ok(!paths.includes('.bluebird.lock'));
    assert.ok(!paths.some(item => item.includes('.tmp.')));
    assert.ok(manifest.skippedRuntime.includes('.bluebird.lock'));
  });

  test('每个文件都记录字节数与 SHA-256，且与副本实际一致', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'hashes' });
    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.snapshotDir, 'MANIFEST.json'), 'utf8')
    );

    assert.ok(manifest.files.length > 0);

    for (const item of manifest.files) {
      const abs = path.join(result.snapshotDir, item.path);
      const buf = fs.readFileSync(abs);

      assert.strictEqual(buf.length, item.bytes, `字节数不符: ${item.path}`);
      assert.strictEqual(
        backup.sha256Text(buf),
        item.sha256,
        `SHA-256 不符: ${item.path}`
      );
    }
  });

  test('运行日志与状态文件如实记录成功', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'log' });
    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const runs = readJsonLines(backup.runLogPath(outRoot));

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].ok, true);
    assert.strictEqual(runs[0].snapshotDir, result.snapshotDir);
    assert.ok(typeof runs[0].ts === 'string' && runs[0].ts.includes('T'));
    assert.strictEqual(runs[0].files, result.files);
    assert.strictEqual(runs[0].bytes, result.bytes);
    assert.ok(/^[0-9A-F]{64}$/.test(runs[0].manifestSha256), '需有整体校验值');
    assert.strictEqual(runs[0].error, null);

    const status = backup.readStatus(outRoot);

    assert.strictEqual(status.lastRunOk, true);
    assert.strictEqual(status.consecutiveFailures, 0);
    assert.strictEqual(
      status.lastSuccessSnapshot,
      path.basename(result.snapshotDir)
    );
    assert.ok(status.lastSuccessAt);

    const check = backup.checkStatus(outRoot);

    assert.strictEqual(check.ok, true);
    assert.strictEqual(check.stale, false);
  });

  test('一次成功备份即可通过恢复校验', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'verify' });
    const result = backup.createBackup({ dataDir, outRoot });
    const verification = backup.verifySnapshot(result.snapshotDir);

    assert.strictEqual(verification.ok, true, JSON.stringify(verification.problems));
    assert.strictEqual(verification.files, result.files);
    assert.strictEqual(verification.bytes, result.bytes);
  });
});

describe('备份：坏数据必须失败，不能伪报成功', { concurrency: 1 }, () => {
  test('空文件 → 失败并标记 .incomplete', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'empty' });

    writeFile(path.join(dataDir, 'memory.json'), '');

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_data_file:empty_file');
    assert.ok(result.snapshotDir.endsWith('.incomplete'));

    const status = backup.readStatus(outRoot);

    assert.strictEqual(status.lastRunOk, false);
    assert.strictEqual(status.consecutiveFailures, 1);
    assert.strictEqual(status.lastSuccessAt, null);
  });

  test('损坏 JSON → 失败（invalid_json）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'broken' });

    writeFile(path.join(dataDir, 'sessions.json'), '{"version":1,"sess');

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_data_file:invalid_json');
  });

  test('结构不符（sessions 不是数组）→ 失败（invalid_shape）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'shape' });

    writeFile(
      path.join(dataDir, 'sessions.json'),
      JSON.stringify({ version: 1, sessions: {}, messages: {} })
    );

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_data_file:invalid_shape');
  });

  test('数据目录不存在 → 失败（data_dir_missing），不产生快照', () => {
    const base = path.join(TMP_ROOT, 'missing-dir');
    const dataDir = path.join(base, 'nope');
    const outRoot = path.join(base, 'backups');

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'data_dir_missing');
    assert.deepStrictEqual(snapshotDirs(outRoot), []);
  });

  test('备份根落在数据目录内 → 拒绝（out_root_inside_data）', () => {
    const { dataDir } = makeFixture({ name: 'inside' });

    const result = backup.createBackup({
      dataDir,
      outRoot: path.join(dataDir, 'backups'),
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'out_root_inside_data');
  });

  test('采集期间源文件持续被改写 → 失败（source_changed_during_copy）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'churn' });
    const original = fs.copyFileSync;
    let seq = 0;

    // 每次复制都碰一下源文件：故意制造「永远不稳定」的采集期
    fs.copyFileSync = (from, to, ...rest) => {
      const out = original(from, to, ...rest);

      if (String(from).endsWith('sessions.json') && String(to).includes('data-')) {
        seq += 1;
        fs.writeFileSync(from, `${JSON.stringify({ seq, sessions: [], messages: {} })}`);
      }

      return out;
    };

    try {
      const result = backup.createBackup({ dataDir, outRoot });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'source_changed_during_copy');
      assert.ok(result.attempts >= 2, '必须真的重试过');
    } finally {
      fs.copyFileSync = original;
    }
  });

  test('副本被写坏 → 失败（copy_checksum_mismatch），不能只信源文件', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'corrupt-copy' });
    const original = fs.copyFileSync;

    fs.copyFileSync = (from, to, ...rest) => {
      const out = original(from, to, ...rest);

      if (
        String(from).endsWith('memory.json') &&
        String(to).includes('data-')
      ) {
        fs.writeFileSync(to, '[{"content":"写坏的副本"}]');
      }

      return out;
    };

    try {
      const result = backup.createBackup({ dataDir, outRoot });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'copy_checksum_mismatch');
    } finally {
      fs.copyFileSync = original;
    }
  });

  test('失败不清空「上一次成功」，并累计连续失败数', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'keep-success' });
    const first = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(first.ok, true);

    const successAt = backup.readStatus(outRoot).lastSuccessAt;

    writeFile(path.join(dataDir, 'memory.json'), '');

    const second = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(second.ok, false);

    const status = backup.readStatus(outRoot);

    assert.strictEqual(status.lastSuccessAt, successAt, '失败不该抹掉上次成功时间');
    assert.strictEqual(status.consecutiveFailures, 1);
    assert.strictEqual(status.lastRunOk, false);
  });
});

describe('保留策略', { concurrency: 1 }, () => {
  test('只保留最近 N 个本模块快照，且不动旧 MANIFEST.txt 快照', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'retention' });
    const startedAt = Date.parse('2026-10-01T00:00:00.000Z');

    // 旧版脚本产出的快照：只有 MANIFEST.txt，没有 MANIFEST.json → 不归我们管
    writeFile(path.join(outRoot, 'data-legacy', 'MANIFEST.txt'), 'legacy\n');
    fs.mkdirSync(path.join(outRoot, 'data-legacy'), { recursive: true });

    for (let i = 0; i < 3; i += 1) {
      const result = backup.createBackup({
        dataDir,
        outRoot,
        keep: 2,
        now: startedAt + i * 3600000,
      });

      assert.strictEqual(result.ok, true, JSON.stringify(result.error));
    }

    const names = snapshotDirs(outRoot).filter(name => name !== 'data-legacy');

    assert.strictEqual(names.length, 2, `应只剩 2 个，实际 ${names.join(',')}`);
    assert.ok(
      fs.existsSync(path.join(outRoot, 'data-legacy', 'MANIFEST.txt')),
      '旧格式快照不得被保留策略删除'
    );
  });
});

describe('恢复：隔离、校验与失败处理', { concurrency: 1 }, () => {
  test('恢复到独立目录：文件齐全、SHA-256 一致、源快照不被改动', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'restore' });
    const result = backup.createBackup({ dataDir, outRoot });
    const before = backup.hashTree(result.snapshotDir);

    const target = path.join(TMP_ROOT, 'restore-target-1');
    const restored = backup.restoreSnapshot(result.snapshotDir, target);

    assert.strictEqual(restored.ok, true, JSON.stringify(restored.problems));
    assert.strictEqual(restored.restored, result.files);
    assert.ok(fs.existsSync(path.join(target, 'uploads/2026-10/a.png')));

    const after = backup.hashTree(result.snapshotDir);

    assert.strictEqual(after.digest, before.digest, '恢复不得改动源快照');
  });

  test('备份文件缺失 → 恢复在 verify 阶段失败，且不写入目标目录', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'missing-file' });
    const result = backup.createBackup({ dataDir, outRoot });

    fs.rmSync(path.join(result.snapshotDir, 'uploads/2026-10/a.png'));

    const target = path.join(TMP_ROOT, 'restore-target-2');
    const restored = backup.restoreSnapshot(result.snapshotDir, target);

    assert.strictEqual(restored.ok, false);
    assert.strictEqual(restored.stage, 'verify');
    assert.ok(
      restored.problems.some(p => p.code === 'missing_file'),
      JSON.stringify(restored.problems)
    );
    assert.ok(!fs.existsSync(path.join(target, 'sessions.json')), '校验失败不该落盘');
  });

  test('备份文件被篡改 → checksum_mismatch', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'tampered' });
    const result = backup.createBackup({ dataDir, outRoot });

    writeFile(path.join(result.snapshotDir, 'memory.json'), '[{"content":"tampered"}]');

    const verification = backup.verifySnapshot(result.snapshotDir);

    assert.strictEqual(verification.ok, false);
    assert.ok(
      verification.problems.some(
        p => p.code === 'size_mismatch' || p.code === 'checksum_mismatch'
      ),
      JSON.stringify(verification.problems)
    );
  });

  test('备份文件为空 → empty_file', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'blank' });
    const result = backup.createBackup({ dataDir, outRoot });

    writeFile(path.join(result.snapshotDir, 'emotion-state.json'), '');

    const verification = backup.verifySnapshot(result.snapshotDir);

    assert.strictEqual(verification.ok, false);
    assert.ok(verification.problems.some(p => p.code === 'empty_file'));
  });

  test('MANIFEST 缺失 → 恢复直接失败，不产生半份数据', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'no-manifest' });
    const result = backup.createBackup({ dataDir, outRoot });

    fs.rmSync(path.join(result.snapshotDir, 'MANIFEST.json'));

    const target = path.join(TMP_ROOT, 'restore-target-3');
    const restored = backup.restoreSnapshot(result.snapshotDir, target);

    assert.strictEqual(restored.ok, false);
    assert.ok(restored.problems.some(p => p.code === 'manifest_missing'));
  });

  test('恢复不修改生产数据（前后全树摘要一致）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'prod-safe' });
    const result = backup.createBackup({ dataDir, outRoot });
    const before = backup.hashTree(dataDir);

    backup.restoreSnapshot(result.snapshotDir, path.join(TMP_ROOT, 'restore-target-4'));

    const after = backup.hashTree(dataDir);

    assert.strictEqual(after.digest, before.digest);
    assert.strictEqual(after.files, before.files);
    assert.strictEqual(after.bytes, before.bytes);
  });
});

describe('陈旧与告警状态', { concurrency: 1 }, () => {
  test('无状态文件 → never / no_status_file', () => {
    const outRoot = path.join(TMP_ROOT, 'no-status');
    const check = backup.checkStatus(outRoot);

    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.stale, true);
    assert.strictEqual(check.reason, 'no_status_file');
  });

  test('超过阈值未成功 → stale（可用于长期未备份告警）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'stale' });
    const createdAt = Date.parse('2026-10-01T00:00:00.000Z');

    backup.createBackup({ dataDir, outRoot, now: createdAt });

    const fresh = backup.checkStatus(outRoot, {
      maxAgeHours: 24,
      now: createdAt + 3600000,
    });

    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.stale, false);

    const old = backup.checkStatus(outRoot, {
      maxAgeHours: 24,
      now: createdAt + 25 * 3600000,
    });

    assert.strictEqual(old.ok, false);
    assert.strictEqual(old.stale, true);
    assert.strictEqual(old.reason, 'stale');
    assert.ok(old.ageHours >= 25);
  });

  test('最近一次失败但未陈旧 → last_run_failed', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'failed' });
    const now = Date.parse('2026-10-01T00:00:00.000Z');

    backup.createBackup({ dataDir, outRoot, now });

    writeFile(path.join(dataDir, 'sessions.json'), 'not json');

    backup.createBackup({ dataDir, outRoot, now: now + 60000 });

    const check = backup.checkStatus(outRoot, {
      maxAgeHours: 24,
      now: now + 2 * 60000,
    });

    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.stale, false);
    assert.strictEqual(check.reason, 'last_run_failed');
    assert.ok(check.status.lastError);
  });
});

describe('恢复演练 CLI（端到端）', { concurrency: 1 }, () => {
  const runCli = args =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', args[0]), ...args.slice(1)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });

  test('正常快照 → 退出码 0，生产数据未被修改，drills.jsonl 记录结论', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'drill-ok' });

    const made = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(made.ok, true);

    const before = backup.hashTree(dataDir);
    const out = runCli([
      'bluebird-restore-drill.js',
      '--data-dir',
      dataDir,
      '--out-dir',
      outRoot,
      '--json',
    ]);

    assert.strictEqual(out.status, 0, out.stdout + out.stderr);

    const record = JSON.parse(out.stdout);

    assert.strictEqual(record.ok, true);
    assert.strictEqual(record.production.untouched, true);
    assert.strictEqual(record.appRead.ok, true);
    assert.ok(record.restore.restored > 0);

    const after = backup.hashTree(dataDir);

    assert.strictEqual(after.digest, before.digest);

    const drills = readJsonLines(backup.drillLogPath(outRoot));

    assert.strictEqual(drills.length, 1);
    assert.strictEqual(drills[0].ok, true);
    assert.strictEqual(drills[0].productionUntouched, true);
    assert.ok(typeof drills[0].restoreMs === 'number');
  });

  test('快照被破坏 → 退出码 1，且记录失败原因', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'drill-bad' });
    const made = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(made.ok, true);

    writeFile(path.join(made.snapshotDir, 'sessions.json'), '{"broken":');

    const out = runCli([
      'bluebird-restore-drill.js',
      '--data-dir',
      dataDir,
      '--out-dir',
      outRoot,
      '--json',
    ]);

    assert.strictEqual(out.status, 1, out.stdout + out.stderr);

    const record = JSON.parse(out.stdout);

    assert.strictEqual(record.ok, false);
    assert.ok(record.problems.length > 0);

    const drills = readJsonLines(backup.drillLogPath(outRoot));

    assert.strictEqual(drills[drills.length - 1].ok, false);
  });

  test('没有任何快照 → 退出码 1（no_snapshot）', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'drill-none' });
    const out = runCli([
      'bluebird-restore-drill.js',
      '--data-dir',
      dataDir,
      '--out-dir',
      outRoot,
      '--json',
    ]);

    assert.strictEqual(out.status, 1);

    const record = JSON.parse(out.stdout);

    assert.ok(record.problems.some(p => p.code === 'no_snapshot'));
  });
});

describe('密钥备份策略（默认排除，可选加密）', { concurrency: 1 }, () => {
  function withSecret(name) {
    const { dataDir, outRoot } = makeFixture({ name });

    writeFile(
      path.join(dataDir, 'api-keys.json'),
      JSON.stringify({ providers: { deepseek: { apiKey: 'SUPER_SECRET_VALUE' } } })
    );

    return { dataDir, outRoot };
  }

  test('默认排除 api-keys.json：不进快照、不进恢复、明文不出现', () => {
    const { dataDir, outRoot } = withSecret('secret-excl');

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.snapshotDir, 'MANIFEST.json'), 'utf8')
    );
    const paths = manifest.files.map(item => item.path);

    assert.ok(!paths.includes('api-keys.json'), '密钥不得进快照');
    assert.ok(
      manifest.skippedSecrets.includes('api-keys.json'),
      '密钥应记入 skippedSecrets'
    );

    const target = path.join(TMP_ROOT, 'secret-restore');
    const restored = backup.restoreSnapshot(result.snapshotDir, target);

    assert.strictEqual(restored.ok, true, JSON.stringify(restored.problems));
    assert.ok(
      !fs.existsSync(path.join(target, 'api-keys.json')),
      '恢复不得产生密钥文件'
    );

    const manifestDump = fs.readFileSync(
      path.join(result.snapshotDir, 'MANIFEST.json'),
      'utf8'
    );

    assert.ok(
      !manifestDump.includes('SUPER_SECRET_VALUE'),
      '密钥明文不得进入备份清单'
    );
  });

  test('encryptSecrets：密钥加密入库，恢复能解密回原文，明文不出现', () => {
    const { dataDir, outRoot } = withSecret('secret-enc');
    const KEY = 'a-very-strong-passphrase-at-least-32-bytes-long!!';

    const result = backup.createBackup({
      dataDir,
      outRoot,
      encryptSecrets: true,
      backupKey: KEY,
    });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.snapshotDir, 'MANIFEST.json'), 'utf8')
    );
    const encEntry = manifest.files.find(item => item.structure === 'secret_enc');

    assert.ok(encEntry, '应有加密密钥条目');
    assert.strictEqual(encEntry.originalPath, 'api-keys.json');
    assert.ok(
      !manifest.files.some(item => item.path === 'api-keys.json'),
      '明文密钥不得直接入库'
    );

    const manifestDump = fs.readFileSync(
      path.join(result.snapshotDir, 'MANIFEST.json'),
      'utf8'
    );

    assert.ok(
      !manifestDump.includes('SUPER_SECRET_VALUE'),
      '密钥明文不得进入清单'
    );

    const target = path.join(TMP_ROOT, 'secret-enc-restore');

    process.env.BLUEBIRD_BACKUP_KEY = KEY;
    const restored = backup.restoreSnapshot(result.snapshotDir, target);
    delete process.env.BLUEBIRD_BACKUP_KEY;

    assert.strictEqual(restored.ok, true, JSON.stringify(restored.problems));

    const got = fs.readFileSync(path.join(target, 'api-keys.json'), 'utf8');

    assert.strictEqual(
      got,
      JSON.stringify({ providers: { deepseek: { apiKey: 'SUPER_SECRET_VALUE' } } }),
      '恢复出的密钥应与原文一致'
    );
  });

  test('encryptSecrets 但缺少 key → 失败（missing_backup_key）', () => {
    const { dataDir, outRoot } = withSecret('secret-nokey');

    const result = backup.createBackup({ dataDir, outRoot, encryptSecrets: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'missing_backup_key');
  });

  test('恢复含加密密钥的快照但无 key → restore_missing_key', () => {
    const { dataDir, outRoot } = withSecret('secret-restore-nokey');

    const made = backup.createBackup({
      dataDir,
      outRoot,
      encryptSecrets: true,
      backupKey: 'some-key',
    });

    assert.strictEqual(made.ok, true, JSON.stringify(made.error));

    delete process.env.BLUEBIRD_BACKUP_KEY;

    const target = path.join(TMP_ROOT, 'sr-nk');
    const restored = backup.restoreSnapshot(made.snapshotDir, target);

    assert.strictEqual(restored.ok, false);
    assert.strictEqual(restored.problems[0].code, 'restore_missing_key');
  });
});

describe('isSecretFile 跨平台路径判断', { concurrency: 1 }, () => {
  test('顶层 api-keys.json 应识别为密钥', () => {
    assert.strictEqual(backup.isSecretFile('api-keys.json'), true);
  });

  test('嵌套目录（POSIX 分隔符）中的 api-keys.json 也应识别', () => {
    assert.strictEqual(backup.isSecretFile('nested/api-keys.json'), true);
    assert.strictEqual(backup.isSecretFile('a/b/c/api-keys.json'), true);
  });

  test('嵌套目录（Windows 分隔符）中的 api-keys.json 也应识别', () => {
    assert.strictEqual(backup.isSecretFile('nested\\api-keys.json'), true);
    assert.strictEqual(backup.isSecretFile('a\\b\\c\\api-keys.json'), true);
  });

  test('非密钥文件不应被误判（含同名前缀/后缀）', () => {
    assert.strictEqual(backup.isSecretFile('other.json'), false);
    assert.strictEqual(backup.isSecretFile('nested/other.json'), false);
    assert.strictEqual(backup.isSecretFile('api-keys.json.bak'), false);
    assert.strictEqual(backup.isSecretFile('my-api-keys.json'), false);
  });
});

describe('嵌套 api-keys.json 实际排除（集成）', { concurrency: 1 }, () => {
  test('位于子目录的 api-keys.json 不进快照，记入 skippedSecrets', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'nested-secret' });

    writeFile(
      path.join(dataDir, 'sub/api-keys.json'),
      JSON.stringify({ providers: { deepseek: { apiKey: 'SUB_SECRET' } } })
    );
    writeFile(
      path.join(dataDir, 'a/b/c/api-keys.json'),
      JSON.stringify({ providers: { deepseek: { apiKey: 'DEEP_SECRET' } } })
    );

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.snapshotDir, 'MANIFEST.json'), 'utf8')
    );

    assert.ok(
      !manifest.files.some(item => item.path === 'sub/api-keys.json'),
      '子目录密钥不得进快照'
    );
    assert.ok(
      !manifest.files.some(item => item.path === 'a/b/c/api-keys.json'),
      '深层密钥不得进快照'
    );
    assert.ok(manifest.skippedSecrets.includes('sub/api-keys.json'));
    assert.ok(manifest.skippedSecrets.includes('a/b/c/api-keys.json'));
  });
});

describe('诚实故障域不变量（disasterRecoveryGrade 恒为 false）', { concurrency: 1 }, () => {
  test('本地路径备份成功后，状态文件 disasterRecoveryGrade 必须为 false 且 offHostUnverified 为 true', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'dr-grade' });
    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const status = backup.readStatus(outRoot);

    assert.strictEqual(status.disasterRecoveryGrade, false, '本地备份不得宣称灾难恢复就绪');
    assert.strictEqual(status.offHostUnverified, true, '是否异机/远端必须由部署层核实');

    // 结果对象本身不得携带任何「灾难恢复就绪」标记，避免被误读
    assert.ok(
      !('disasterRecoveryGrade' in result),
      'createBackup 结果不应误导性地携带 DR 标记'
    );
  });

  test('即使不同逻辑盘符，disasterRecoveryGrade 仍为 false（不同盘符≠不同物理盘）', () => {
    const { dataDir } = makeFixture({ name: 'dr-grade-drive' });
    const outRoot = path.join(TMP_ROOT, 'dr-grade-drive-backups');

    const result = backup.createBackup({ dataDir, outRoot });

    assert.strictEqual(result.ok, true, JSON.stringify(result.error));

    const status = backup.readStatus(outRoot);

    assert.strictEqual(status.disasterRecoveryGrade, false);
  });
});

describe('看门狗告警链路', { concurrency: 1 }, () => {
  const runWatchdog = args =>
    spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', args[0]), ...args.slice(1)],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DEEPSEEK_API_KEY: '' },
      }
    );

  test('check 未通过（无状态文件）→ 退出码 2，且 alerts.jsonl 记录告警', () => {
    const outRoot = path.join(TMP_ROOT, 'watchdog-empty');

    const out = runWatchdog([
      'bluebird-backup-check-alert.js',
      '--out-dir',
      outRoot,
      '--json',
    ]);

    assert.strictEqual(out.status, 2, out.stdout + out.stderr);

    const record = JSON.parse(out.stdout);

    assert.strictEqual(record.exitCode, 2);
    assert.strictEqual(record.kind, 'backup_status_unhealthy');

    const alerts = readJsonLines(
      path.join(backup.stateDirOf(outRoot), 'alerts.jsonl')
    );

    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].exitCode, 2);
    assert.strictEqual(alerts[0].kind, 'backup_status_unhealthy');
    // 命令未配置：明确记录「未配置 / 未尝试」，不能含糊记为已触发
    assert.strictEqual(alerts[0].alert.commandConfigured, false);
    assert.strictEqual(alerts[0].alert.attempted, false);
    assert.strictEqual(alerts[0].alert.exitCode, null);
    assert.strictEqual(alerts[0].alert.error, null);
  });

  test('BLUEBIRD_ALERT_CMD 配置且命令成功（退出 0）→ 记录 attempted 成功且不误报', () => {
    const outRoot = path.join(TMP_ROOT, 'watchdog-cmd');
    const marker = path.join(TMP_ROOT, 'alert-marker.txt');
    const markerScript = path.join(TMP_ROOT, 'alert-hook.js');

    writeFile(
      markerScript,
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(
        marker
      )}, process.env.BLUEBIRD_ALERT_PAYLOAD || 'EMPTY');\n`
    );

    const out = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'scripts', 'bluebird-backup-check-alert.js'),
        '--out-dir',
        outRoot,
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: '',
          BLUEBIRD_ALERT_CMD: `${process.execPath} ${markerScript}`,
        },
      }
    );

    assert.strictEqual(out.status, 2, out.stdout + out.stderr);
    assert.ok(fs.existsSync(marker), '外发命令应被触发并写标记');

    const record = JSON.parse(out.stdout);

    // 命令已配置、已尝试、成功（退出码 0、无异常）—— 明确区分「尝试」与「成功」
    assert.strictEqual(record.alert.commandConfigured, true);
    assert.strictEqual(record.alert.attempted, true);
    assert.strictEqual(record.alert.exitCode, 0, '命令成功退出码应为 0');
    assert.strictEqual(record.alert.error, null, '成功不应有 error');

    const payload = JSON.parse(fs.readFileSync(marker, 'utf8'));

    assert.strictEqual(payload.exitCode, 2);
    assert.strictEqual(payload.alert.commandConfigured, true);
  });

  test('BLUEBIRD_ALERT_CMD 配置但命令退出非 0 → 记录 attempted 且不误报成功', () => {
    const outRoot = path.join(TMP_ROOT, 'watchdog-cmd-fail');
    const failScript = path.join(TMP_ROOT, 'alert-hook-fail.js');

    // 故意非零退出，且不写任何标记文件
    writeFile(failScript, 'process.exit(3);\n');

    const out = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'scripts', 'bluebird-backup-check-alert.js'),
        '--out-dir',
        outRoot,
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: '',
          BLUEBIRD_ALERT_CMD: `${process.execPath} ${failScript}`,
        },
      }
    );

    assert.strictEqual(out.status, 2, out.stdout + out.stderr);

    const record = JSON.parse(out.stdout);

    assert.strictEqual(record.alert.commandConfigured, true);
    assert.strictEqual(record.alert.attempted, true);
    assert.strictEqual(record.alert.exitCode, 3, '应如实记录非零退出码');
    assert.strictEqual(record.alert.error, null, '命令已执行完成（只是非 0），无 spawn 异常');
  });

  test('BLUEBIRD_ALERT_CMD 执行抛异常（spawnSync 抛错）→ 记录 error 且不误报成功', () => {
    const cp = require('node:child_process');
    const origSpawn = cp.spawnSync;
    const outRoot = path.join(TMP_ROOT, 'wd-cmd-throw');

    // 区分 check 子进程与告警外发命令：外发命令没有 --check 参数
    cp.spawnSync = (cmd, args) => {
      if (Array.isArray(args) && args.includes('--check')) {
        return {
          status: 2,
          stdout: JSON.stringify({ ok: false, reason: 'no_status_file' }),
          stderr: '',
        };
      }

      // 告警外发命令：模拟 spawnSync 抛异常（如命令不可执行）
      throw Object.assign(new Error('spawnSync failed'), { code: 'ENOENT' });
    };

    const prevArgv = process.argv;

    try {
      process.env.BLUEBIRD_ALERT_CMD = 'dummy-unreachable-cmd';
      // 必须在首次 require 看门狗前注入 mock（看门狗在模块加载时即解构 spawnSync）
      const watchdog = require('../scripts/bluebird-backup-check-alert.js');

      process.argv = ['node', 'watchdog', '--out-dir', outRoot, '--json'];

      const code = watchdog.main();

      assert.strictEqual(code, 2, '看门狗应透传 check 的退出码 2');

      const alerts = readJsonLines(
        path.join(backup.stateDirOf(outRoot), 'alerts.jsonl')
      );

      assert.strictEqual(alerts.length, 1, '异常路径必须写一条告警');
      assert.strictEqual(alerts[0].exitCode, 2);
      assert.strictEqual(alerts[0].alert.commandConfigured, true);
      assert.strictEqual(alerts[0].alert.attempted, true);
      assert.ok(alerts[0].alert.error, '应记录执行异常，不得为空');
      assert.strictEqual(
        alerts[0].alert.error.includes('ENOENT'),
        true,
        '异常内容应被脱敏且不夹带密钥'
      );
      assert.strictEqual(alerts[0].alert.exitCode, null, '抛异常时无退出码');
    } finally {
      delete process.env.BLUEBIRD_ALERT_CMD;
      cp.spawnSync = origSpawn;
      process.argv = prevArgv;
      delete require.cache[
        require.resolve('../scripts/bluebird-backup-check-alert.js')
      ];
    }
  });

  test('check 正常 → 退出码 0，不写告警', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'watchdog-ok' });

    backup.createBackup({ dataDir, outRoot });

    const out = runWatchdog([
      'bluebird-backup-check-alert.js',
      '--out-dir',
      outRoot,
      '--json',
    ]);

    assert.strictEqual(out.status, 0, out.stdout + out.stderr);

    const alertsPath = path.join(backup.stateDirOf(outRoot), 'alerts.jsonl');

    assert.ok(!fs.existsSync(alertsPath), '正常时不应写告警');
  });

  test('--check 期间 checkStatus 抛异常时，CLI 显式返回退出码 1（而非崩溃）', () => {
    const cli = require('../scripts/bluebird-backup.js');
    const backupMod = require('../server/backup');
    const orig = backupMod.checkStatus;

    backupMod.checkStatus = () => {
      throw new Error('simulated check failure');
    };

    const prevArgv = process.argv;

    try {
      process.argv = [
        'node',
        'bluebird-backup.js',
        '--check',
        '--out-dir',
        path.join(TMP_ROOT, 'cli-check-err'),
      ];

      const code = cli.main();

      assert.strictEqual(code, 1, '异常路径必须显式返回退出码 1');
    } finally {
      backupMod.checkStatus = orig;
      process.argv = prevArgv;
    }
  });

  test('check 子进程退出码 1 时，看门狗记录 kind=backup_check_error 并透传退出码', () => {
    const cp = require('node:child_process');
    const origSpawn = cp.spawnSync;
    const outRoot = path.join(TMP_ROOT, 'wd-check-err');

    // 让看门狗内部 spawnSync 的 check 子进程返回退出码 1
    cp.spawnSync = (cmd, args) => {
      if (Array.isArray(args) && args.includes('--check')) {
        return { status: 1, stdout: '{}', stderr: '' };
      }

      return origSpawn(cmd, args);
    };

    const prevArgv = process.argv;

    try {
      // 必须在首次 require 看门狗前注入 mock（看门狗在模块加载时即解构 spawnSync）
      const watchdog = require('../scripts/bluebird-backup-check-alert.js');

      process.argv = ['node', 'watchdog', '--out-dir', outRoot, '--json'];

      const code = watchdog.main();

      assert.strictEqual(code, 1, '看门狗应透传 check 的退出码 1');

      const alerts = readJsonLines(
        path.join(backup.stateDirOf(outRoot), 'alerts.jsonl')
      );

      assert.strictEqual(alerts.length, 1, '异常路径必须写一条告警');
      assert.strictEqual(alerts[0].kind, 'backup_check_error', '退出码 1 必须记为 backup_check_error');
      assert.strictEqual(alerts[0].exitCode, 1);
    } finally {
      cp.spawnSync = origSpawn;
      process.argv = prevArgv;
      delete require.cache[
        require.resolve('../scripts/bluebird-backup-check-alert.js')
      ];
    }
  });
});

describe('活跃写入期间的备份与恢复（真实并发）', { concurrency: 1 }, () => {
  test('写入进程活跃改写文件时，一致性守卫生效，最终得到一致快照并恢复成功', () => {
    const { dataDir, outRoot } = makeFixture({ name: 'active-write' });
    const pauseFile = path.join(TMP_ROOT, 'active-pause.flag');
    const writerScript = path.join(TMP_ROOT, 'writer.js');

    writeFile(
      writerScript,
      `const fs=require('fs');
const dataDir=process.argv[2];
const pauseFile=process.argv[3];
let n=0, running=true;
process.on('SIGTERM',()=>{running=false;});
process.on('SIGINT',()=>{running=false;});
function tick(){
  if(!running) return;
  n++;
  if(!fs.existsSync(pauseFile)){
    fs.writeFileSync(dataDir+'/memory.json', JSON.stringify([{content:'msg '+n,type:'fact',keywords:['k'],confidence:0.9,createdAt:new Date().toISOString(),contributions:[]}]));
  }
  setTimeout(tick, 20);
}
tick();
`
    );

    const writer = spawn(process.execPath, [writerScript, dataDir, pauseFile], {
      stdio: 'ignore',
    });

    let okResult = null;
    const outcomes = [];

    try {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        // 前几轮任由写入进程持续改写；后半程暂停写入以稳定地拿到一致快照
        if (!okResult && attempt > 6) writeFile(pauseFile, '');

        const r = backup.createBackup({ dataDir, outRoot, keep: 50 });

        outcomes.push({
          attempt,
          ok: r.ok,
          consistent: r.consistent,
          code: r.error && r.error.code,
        });

        if (r.ok) {
          // 不变量：成功必须伴随一致
          assert.strictEqual(r.consistent, true);
          // 失败路径也必须真的重试过
          if (!okResult) okResult = r;
        } else if (r.error && r.error.code === 'source_changed_during_copy') {
          assert.ok(r.attempts >= 2, '重试守卫生效');
        }
      }

      assert.ok(
        okResult,
        `应在若干次尝试内取得一致快照; outcomes=${JSON.stringify(outcomes)}`
      );

      const target = path.join(TMP_ROOT, 'active-restore');
      const restored = backup.restoreSnapshot(okResult.snapshotDir, target);

      assert.strictEqual(restored.ok, true, JSON.stringify(restored.problems));

      const arr = JSON.parse(
        fs.readFileSync(path.join(target, 'memory.json'), 'utf8')
      );

      assert.ok(Array.isArray(arr) && arr.length === 1, '恢复出的数据为合法 JSON');
    } finally {
      try {
        fs.rmSync(pauseFile, { force: true });
      } catch (_) {
        /* ignore */
      }
      try {
        writer.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
      try {
        if (writer.exitCode === null) writer.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }
  });
});
