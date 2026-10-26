#!/usr/bin/env node
/* eslint-env node */
/**
 * Bluebird 数据备份 CLI（跨平台，唯一实现）。
 *
 *   node scripts/bluebird-backup.js                     # 备份到 $HOME/bluebird-backups
 *   node scripts/bluebird-backup.js --out-dir /mnt/usb  # 指定备份根（建议换盘 = 换故障域）
 *   node scripts/bluebird-backup.js --keep 14           # 保留最近 14 个快照
 *   node scripts/bluebird-backup.js --check             # 只查状态：陈旧/失败则退出码 2
 *   node scripts/bluebird-backup.js --json              # 机器可读输出
 *
 * 退出码：0 成功 / 1 备份失败 / 2 状态检查未通过（供定时任务或监控作为告警挂点）。
 *
 * 注意：本 CLI 不安装也不代表已存在定时任务。调度需要在部署环境里显式配置
 * （cron / systemd timer / Task Scheduler），见 AGENTS.md「Data safety & backup」。
 */

const backup = require('../server/backup');

function parseArgs(argv) {
  const args = {
    dataDir: '',
    outDir: '',
    keep: null,
    staleHours: null,
    check: false,
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
      case '--keep':
        args.keep = Number.parseInt(next(), 10);
        break;
      case '--stale-hours':
        args.staleHours = Number.parseFloat(next());
        break;
      case '--check':
        args.check = true;
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
      'Bluebird 数据备份',
      '',
      '用法: node scripts/bluebird-backup.js [选项]',
      '',
      '  --data-dir <dir>     数据目录（默认 BLUEBIRD_DATA_DIR 或 server/data）',
      '  --out-dir <dir>      备份根目录（默认 BLUEBIRD_BACKUP_DIR 或 ~/bluebird-backups）',
      '  --keep <n>           保留最近 n 个快照（默认 7）',
      '  --stale-hours <h>    超过 h 小时没有成功备份即判定陈旧（默认 24）',
      '  --check              只检查状态，不执行备份；陈旧或上次失败退出码 2',
      '  --json               输出 JSON',
    ].join('\n')
  );
}

function humanBytes(bytes) {
  return backup.formatBytes(bytes);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();

    return 0;
  }

  const outRoot = backup.resolveOutRoot(args.outDir);

  if (args.check) {
    const check = backup.checkStatus(outRoot, {
      maxAgeHours: args.staleHours === null ? undefined : args.staleHours,
    });

    if (args.json) {
      console.log(JSON.stringify(check, null, 2));
    } else if (check.ok) {
      console.log('✓ 备份状态正常');
      console.log(`  最近成功: ${check.status.lastSuccessAt}（${check.ageHours} 小时前）`);
      console.log(`  快照:     ${check.status.lastSuccessSnapshot}`);
      console.log(`  连续失败: ${check.status.consecutiveFailures}`);
    } else {
      console.log('✗ 备份状态异常');
      console.log(`  原因:     ${check.reason}`);
      if (check.ageHours !== null) {
        console.log(`  距上次成功: ${check.ageHours} 小时（阈值 ${check.maxAgeHours}）`);
      }
      if (check.status && check.status.lastError) {
        console.log(
          `  最近失败: ${check.status.lastError.code} — ${check.status.lastError.message}`
        );
      }
      console.log(`  备份根:   ${outRoot}`);
    }

    return check.ok ? 0 : 2;
  }

  const result = backup.createBackup({
    dataDir: args.dataDir || undefined,
    outRoot,
    keep: args.keep === null ? undefined : args.keep,
    staleHours: args.staleHours === null ? undefined : args.staleHours,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));

    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    console.log('✗ 备份失败');
    console.log(`  错误: ${result.error.code} — ${result.error.message}`);
    console.log(`  源:   ${result.dataDir}`);
    console.log(`  备份根: ${result.outRoot}`);
    if (result.snapshotDir) {
      console.log(`  半成品（已标记 .incomplete，不会被当成完整备份）: ${result.snapshotDir}`);
    }
    console.log(`  运行日志: ${backup.runLogPath(result.outRoot)}`);

    return 1;
  }

  console.log(`✓ 备份完成 ${new Date().toISOString()}`);
  console.log(`  源:     ${result.dataDir}`);
  console.log(`  目标:   ${result.snapshotDir}`);
  console.log(
    `  内容:   ${result.files} 个文件 / ${result.dirs} 个目录，${humanBytes(result.bytes)}`
  );
  console.log(`  耗时:   ${result.durationMs} ms（复制轮次 ${result.attempts}）`);
  console.log('  校验:   非空 + JSON 结构 + SHA-256（源与副本双向一致）');
  console.log('  一致性: 采集期间源文件未被改写');

  if (result.sameVolumeAsSource) {
    console.log(
      '  ⚠ 故障域: 备份根与数据目录在同一个卷上——这能挡住误删和损坏，'
    );
    console.log(
      '            但挡不住整盘/整机故障。真正灾难恢复请把 --out-dir 指向异机或远端。'
    );
  } else {
    // 不同盘符 ≠ 不同物理盘：本机 C:/D: 同属一块 SSD，落 D: 只是逻辑分离，
    // 不构成灾难恢复。只有异机/远端才能确认 off-host，本地路径一律不宣称 DR。
    console.log(
      '  故障域: 与数据目录不在同一逻辑盘符（仅逻辑分离；若同物理盘不构成灾难恢复）'
    );
    console.log(
      '            真正灾难恢复需指向异机或远端存储；本地路径无法确认，disasterRecoveryGrade=false。'
    );
  }

  console.log(`  运行日志: ${backup.runLogPath(result.outRoot)}`);
  console.log(`  状态:     ${backup.statusPath(result.outRoot)}`);

  if (result.retention) {
    console.log(
      `  保留策略: 上限 ${result.retention.limit}，删除 ${result.retention.removed.length} 个，保留 ${result.retention.kept} 个`
    );
  }

  if (result.skipped.length) {
    console.log(`  未备份（运行期产物）: ${result.skipped.join(' ')}`);
  }

  if (result.skippedSecrets.length) {
    console.log(
      `  未备份（密钥，默认排除）: ${result.skippedSecrets.join(' ')}`
    );
  }

  return 0;
}

process.exitCode = main();
