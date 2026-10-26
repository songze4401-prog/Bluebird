#!/usr/bin/env node
/* eslint-env node */
/**
 * Bluebird 备份状态看门狗（告警链路挂点）。
 *
 * 调用 `bluebird-backup.js --check`，按退出码判断：
 *   0  -> 状态正常，不告警，退出 0
 *   2  -> 陈旧或上次失败（checkStatus 未通过），触发告警，退出 2
 *   1  -> check 自身异常，同样视为需要关注，触发告警，退出 1
 *
 * 告警动作：
 *   1. 追加一条记录到备份根 `_state/alerts.jsonl`（可追溯、可轮询）。
 *   2. 若环境变量 BLUEBIRD_ALERT_CMD 非空，则执行该命令（告警外发挂点）。
 *      命令通过环境变量 BLUEBIRD_ALERT_PAYLOAD 收到告警 JSON，不写 stdout/stderr 日志。
 *      典型接法：指向一个会发邮件/Webhook 的脚本；发邮件属于「何时发」的业务决策，
 *      本脚本只负责在状态异常时调用它。
 *
 * 用法：
 *   node scripts/bluebird-backup-check-alert.js --out-dir /path/to/backups
 *   node scripts/bluebird-backup-check-alert.js            # 用默认备份根
 *   node scripts/bluebird-backup-check-alert.js --json
 *
 * 退出码：0 正常；非 0 = 已触发告警（与 check 退出码一致）。
 * 调度器（cron / schtasks）应据此把失败暴露出来。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const backup = require('../server/backup');

const CLI = path.join(__dirname, 'bluebird-backup.js');

function parseArgs(argv) {
  const args = { outDir: '', json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--out-dir') {
      args.outDir = argv[i + 1] || '';
      i += 1;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '-h' || token === '--help') {
      args.help = true;
    }
  }

  return args;
}

function usage() {
  console.log(
    [
      'Bluebird 备份看门狗（状态检查 + 告警）',
      '',
      '用法: node scripts/bluebird-backup-check-alert.js [--out-dir <dir>] [--json]',
      '',
      '  运行 bluebird-backup.js --check；状态异常（退出码非 0）时：',
      '    1. 追加告警到 <备份根>/_state/alerts.jsonl',
      '    2. 若 BLUEBIRD_ALERT_CMD 已设置，则执行该命令（BLUEBIRD_ALERT_PAYLOAD 传告警 JSON）',
      '  退出码与 check 一致：0 正常 / 2 陈旧或上次失败 / 1 异常',
    ].join('\n')
  );
}

// 外发命令的错误只记录操作型信息（如 ENOENT / 退出异常），绝不夹带密钥或告警载荷内容
function sanitizeAlertError(err) {
  if (!err) return null;
  if (err.code) return `spawn_error:${String(err.code)}`;
  return `spawn_error:${String(err.message || err).slice(0, 200)}`;
}

function appendAlert(outRoot, record) {
  const dir = backup.stateDirOf(outRoot);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'alerts.jsonl'),
      `${JSON.stringify(record)}\n`,
      'utf8'
    );
  } catch (_) {
    /* 告警记录本身失败不能吞掉告警，但也不应让进程崩 */
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();

    return 0;
  }

  const outRoot = backup.resolveOutRoot(args.outDir || undefined);

  // 直接复用 CLI，确保「退出码 2」的判定与部署时完全一致
  const child = spawnSync(
    process.execPath,
    [CLI, '--check', '--out-dir', outRoot, '--json'],
    { encoding: 'utf8' }
  );

  const exitCode = child.status === null ? 1 : child.status;
  let check = null;

  try {
    check = JSON.parse(child.stdout || 'null');
  } catch (_) {
    check = null;
  }

  if (exitCode === 0) {
    if (args.json) {
      console.log(
        JSON.stringify({ alerted: false, exitCode, check }, null, 2)
      );
    } else {
      console.log('✓ 备份状态正常，未触发告警');
    }

    return 0;
  }

  // 异常：触发告警。
  // 设计要点（修复「commandFired 永远为 false」的审计缺陷）：
  //   1. 先执行外发命令，拿到真实结果（是否尝试 / 退出码 / 异常），再写最终记录。
  //      alerts.jsonl 为追加写；本设计「一次性写入最终结论」，不依赖事后改写原记录，
  //      因此每条记录都是可追溯的最终结果，不会出现「命令已触发但记录显示未触发」的矛盾。
  //   2. 明确区分两个概念，绝不混为一谈：
  //        attempted  = 是否「已尝试执行」外发命令（命令已配置且确实调用了 spawnSync）
  //        success   = 命令成功 = error 为 null 且 exitCode 为 0
  //      命令「已执行但退出非 0」≠ 成功；命令「因找不到/无法启动而抛异常」由 error 记录。
  //   3. 不记录任何密钥或敏感载荷：record 仅含状态字段（lastError 只携带 {code,message}，
  //      不含文件内容或密钥）；外发命令通过 BLUEBIRD_ALERT_PAYLOAD 收到的是同一份 record。
  const alertCmd = process.env.BLUEBIRD_ALERT_CMD || '';

  const record = {
    ts: new Date().toISOString(),
    kind: exitCode === 2 ? 'backup_status_unhealthy' : 'backup_check_error',
    exitCode,
    outRoot,
    reason: check ? check.reason : 'check_stdout_unparseable',
    ageHours: check ? check.ageHours : null,
    // lastError 只携带操作型 {code,message}（如 invalid_data_file:empty_file），不含任何文件内容或密钥
    lastError: check && check.status ? check.status.lastError : null,
    alert: {
      commandConfigured: Boolean(alertCmd),
      attempted: false,
      exitCode: null,
      error: null,
      firedAt: null,
    },
  };

  if (alertCmd) {
    record.alert.attempted = true;
    record.alert.firedAt = new Date().toISOString();

    try {
      process.env.BLUEBIRD_ALERT_PAYLOAD = JSON.stringify(record);
      const fired = spawnSync(alertCmd, { shell: true, encoding: 'utf8' });

      // 命令确实启动并结束：成功 = 退出码 0 且无异常对象
      if (fired.error) {
        record.alert.error = sanitizeAlertError(fired.error);
      } else {
        record.alert.exitCode = fired.status === null ? null : fired.status;
      }
    } catch (err) {
      // spawnSync 抛异常（如命令不可执行）：记录错误，但不吞掉告警、不让进程崩
      record.alert.error = sanitizeAlertError(err);
    }
  }

  // 最终记录：在外发命令执行完毕后一次性写入，保证可追溯的最终结论（不事后改写）
  appendAlert(outRoot, record);

  if (args.json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log('✗ 备份状态异常，已记录告警');
    console.log(`  原因: ${record.reason}`);
    console.log(`  告警日志: ${path.join(backup.stateDirOf(outRoot), 'alerts.jsonl')}`);
    if (!record.alert.commandConfigured) {
      console.log('  外发命令: 未配置（设置 BLUEBIRD_ALERT_CMD 可外发）');
    } else if (record.alert.error) {
      console.log(`  外发命令: 已尝试但执行异常（${record.alert.error}）`);
    } else if (record.alert.exitCode === 0) {
      console.log('  外发命令: 已触发并成功（退出码 0）');
    } else {
      console.log(`  外发命令: 已触发但返回非 0（退出码 ${record.alert.exitCode}）`);
    }
  }

  return exitCode;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  process.exitCode = main();
}
