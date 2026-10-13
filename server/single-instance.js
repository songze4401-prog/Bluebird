/* global process */
const fs = require('fs');
const path = require('path');

// 启动锁守卫：把"多实例静默覆盖数据"变成"启动即报错"。
//
// 背景（AGENTS.md A3）：server/data 下的 JSON 状态在启动时一次性读入进程内存，
// 之后只信内存、写回时全量覆写；memory.js / emotion.js 的写队列只在单进程内串行。
// 两个实例共用同一数据目录时，后写的一份会整份抹掉先写的那份，且不报错、不可恢复
// （数据目录已被 gitignore）。与其让它在运行期静默丢数据，不如在启动期直接拒绝。
//
// 实现：用 openSync(lockPath, 'wx') 的原子"不存在才创建"语义抢占锁文件，
// 不需要任何第三方依赖。锁里记 pid/port/startedAt/dataDir，供人工排查。

const LOCK_NAME = '.bluebird.lock';

// 当前进程持有的锁文件路径；null 表示没有持锁（例如开了逃生口）
let heldLockPath = null;
let released = false;

// 数据目录的取值规则必须与 memory.js / sessions.js / emotion.js 完全一致：
// BLUEBIRD_DATA_DIR 优先，否则 server/data。
function resolveDataDir() {
  const raw = process.env.BLUEBIRD_DATA_DIR;

  if (typeof raw === 'string' && raw.trim()) {
    return path.resolve(raw.trim());
  }

  return path.join(__dirname, 'data');
}

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

// 返回 'alive' / 'dead' / 'unknown'。
// 保守原则：只有能确定进程已退出（ESRCH）才判 'dead'；权限不足（EPERM）等
// 无法判定的情况一律 'unknown'，此时拒绝启动而不是强行接管 —— 强行接管正是
// "锁失效导致真并发"的入口。
function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (pid === process.pid) return 'alive';

  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function refuse(lockPath, info, state) {
  console.error('==================================================');
  console.error('启动被拒绝：检测到另一个 Bluebird 实例正在使用该数据目录');
  console.error(`  数据目录：${path.dirname(lockPath)}`);
  console.error(`  锁文件：${lockPath}`);

  if (info) {
    const suffix =
      state === 'alive' ? '进程仍在运行' : '进程状态无法判定';

    console.error(
      `  占用者：pid=${info.pid ?? '未知'} port=${info.port ?? '未知'} ` +
        `启动时间=${info.startedAt ?? '未知'}（${suffix}）`
    );
  } else {
    console.error('  占用者：锁文件内容无法解析，无法确认来源');
  }

  console.error(
    '  原因：状态文件是「全量内存缓存 + 全量覆写」，多实例会互相覆盖，' +
      '且覆盖不会报错、不可恢复。'
  );
  console.error('  处理：');
  console.error('    1) 确认没有其他 Bluebird 实例在运行，有则先停掉它；');
  console.error('    2) 确认无实例后，手动删除上面的锁文件再启动；');
  console.error('    3) 确需多实例：给每个实例配不同的 BLUEBIRD_DATA_DIR，');
  console.error(
    '       或临时设 BLUEBIRD_ALLOW_MULTI=1 跳过守卫（数据覆盖风险自负）。'
  );
  console.error('==================================================');

  process.exit(1);
}

// 只删自己写的锁：万一锁内容不是本进程 pid（理论上不会），宁可留着让人处理
function release() {
  if (released || !heldLockPath) return;

  const info = readLock(heldLockPath);

  if (info && info.pid !== process.pid) return;

  released = true;

  try {
    fs.unlinkSync(heldLockPath);
  } catch (_) {
    /* 锁文件已被外部删除，忽略 */
  }
}

// 优雅退出：先关 HTTP server，再释放锁。
// 兜底：server.close 可能因残留长连接迟迟不回调，故加超时强制退出，
// 宁可强制退出也要保证进程能停（锁会由 exit 钩子兜底释放）。
function installShutdownHooks(server) {
  const stop = signal => () => {
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    } catch (_) {
      /* ignore */
    }

    const timer = setTimeout(() => {
      release();
      process.exit(0);
    }, 3000);

    if (timer.unref) timer.unref();

    try {
      server.close(() => {
        clearTimeout(timer);
        release();
        process.exit(0);
      });
    } catch (_) {
      clearTimeout(timer);
      release();
      process.exit(0);
    }

    if (signal) console.log(`[single-instance] 收到 ${signal}，正在停止`);
  };

  process.on('SIGINT', stop('SIGINT'));
  process.on('SIGTERM', stop('SIGTERM'));
}

// 在 server.listen 之前调用。抢占失败直接退出进程，不会返回。
function acquireSingleInstance({ port } = {}) {
  const dataDir = resolveDataDir();
  const lockPath = path.join(dataDir, LOCK_NAME);

  // 逃生口：明确知道自己要干什么时才开，且绝不删别人的锁文件
  if (process.env.BLUEBIRD_ALLOW_MULTI === '1') {
    console.warn(
      '[single-instance] BLUEBIRD_ALLOW_MULTI=1：已允许多实例，' +
        '数据覆盖风险自负（本实例不获取、也不删除任何锁文件）'
    );

    return { acquired: false, skipped: true, dataDir, lockPath };
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    console.error(
      `[single-instance] 数据目录不可用：${dataDir} -> ${error.message}`
    );

    return { acquired: false, skipped: false, dataDir, lockPath };
  }

  let fd;

  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(
        `[single-instance] 无法创建锁文件 ${lockPath}：${error.message}`
      );

      process.exit(1);
    }

    const info = readLock(lockPath);
    const state = info ? pidState(info.pid) : 'unknown';

    // 陈旧锁：仅当确定原进程已死（ESRCH）才清理并接管；否则拒绝
    if (state === 'dead') {
      try {
        fs.unlinkSync(lockPath);
        fd = fs.openSync(lockPath, 'wx');
        console.log(
          `[single-instance] 已清理陈旧锁文件（原 pid=${info.pid}）并接管`
        );
      } catch (cleanupError) {
        console.error(
          `[single-instance] 清理陈旧锁文件失败：${cleanupError.message}`
        );

        refuse(lockPath, info, state);
      }
    } else {
      refuse(lockPath, info, state);
    }
  }

  try {
    fs.writeSync(
      fd,
      JSON.stringify(
        {
          pid: process.pid,
          port: port == null ? null : port,
          startedAt: new Date().toISOString(),
          dataDir,
        },
        null,
        2
      ),
      0,
      'utf8'
    );
  } catch (error) {
    console.error(
      `[single-instance] 写入锁信息失败：${error.message}`
    );
  }

  try {
    fs.closeSync(fd);
  } catch (_) {
    /* ignore */
  }

  heldLockPath = lockPath;
  released = false;

  process.on('exit', release);

  console.log(`[single-instance] 已锁定数据目录：${lockPath}`);

  return { acquired: true, skipped: false, dataDir, lockPath };
}

module.exports = {
  LOCK_NAME,
  acquireSingleInstance,
  installShutdownHooks,
  release,
};
