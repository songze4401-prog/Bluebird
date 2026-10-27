/* global process */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 原子写盘工具：写临时文件 -> fsync -> close -> rename 覆盖 -> 尽力 fsync 父目录。
//
// 目的：断电 / 进程被杀时，目标文件要么是旧内容、要么是新内容，绝不会是空文件或
// 截断文件。仅 writeFile + rename 不够 —— rename 可能先于数据落盘被提交，崩溃后
// 目标文件可能只剩空文件或旧内容；fsync 把"数据已写稳"钉在 rename 之前。
//
// 临时文件以 'wx' 独占创建（已存在则直接报错，天然防止并发实例互踩同一路径），
// 命名为 <target>.tmp-<pid>-<时间戳>-<随机数>，与目标同目录以保证 rename 是原子操作。
// 权限沿用 open 的默认值（与原先 writeFile 默认一致），不改动。
//
// 任何一步失败都会清理自己创建的临时文件并把错误抛给调用方，绝不静默吞掉。

function tempPathFor(target) {
  const random = crypto.randomBytes(6).toString('hex');
  return `${target}.tmp-${process.pid}-${Date.now()}-${random}`;
}

// 尽力 fsync 父目录，让"目录项已更新"也落盘。
// Windows 只认 'r+' 打开目录（'r' 会 EPERM，之前版本因此在这台机器上
// 实际从未生效），POSIX 只认 'r'（'r+' 打开目录报 EISDIR）。
// 两种 flags 依次尝试，任一成功即返回；都失败则放弃
// （尽力而为，不影响数据正确性——文件本身的 fsync 已在 rename 之前完成）。
function fsyncParentDirSync(dir) {
  for (const flags of ['r+', 'r']) {
    let fd = null;

    try {
      fd = fs.openSync(dir, flags);
      fs.fsyncSync(fd);
      return;
    } catch (_) {
      // 本平台不认这种打开方式 / fsync 失败，换下一个
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          // 关闭失败无可挽回，忽略
        }
      }
    }
  }
}

/** 同步原子写。失败时抛错（与原先 writeFileSync 的错误语义一致，不静默）。 */
function writeFileAtomicSync(target, data) {
  const tmpPath = tempPathFor(target);
  let fd = null;

  try {
    fd = fs.openSync(tmpPath, 'wx');
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, target);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // ignore
      }
    }

    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      // 临时文件可能还没建出来，忽略
    }

    throw error;
  }

  fsyncParentDirSync(path.dirname(target));
}

/**
 * 排他创建：目标已存在时返回 false，绝不覆盖已有文件。
 * 用于首次初始化空文件；打开时用 'wx'（O_CREAT|O_EXCL），并发下只有一个进程能创建成功。
 */
function writeFileExclusiveSync(target, data) {
  const dir = path.dirname(target);

  fs.mkdirSync(dir, { recursive: true });

  let fd = null;

  try {
    fd = fs.openSync(target, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }

  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // ignore
      }
    }

    try {
      fs.unlinkSync(target);
    } catch (_) {
      // 目标可能已被外部移除，忽略
    }

    throw error;
  }

  fsyncParentDirSync(dir);

  return true;
}

/** 异步原子写。失败时 reject（与原先 fs.promises 的错误语义一致，不静默）。 */
async function writeFileAtomic(target, data) {
  const tmpPath = tempPathFor(target);
  let handle = null;

  try {
    handle = await fs.promises.open(tmpPath, 'wx');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmpPath, target);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        // ignore
      }
    }

    try {
      await fs.promises.unlink(tmpPath);
    } catch (_) {
      // 临时文件可能还没建出来，忽略
    }

    throw error;
  }

  fsyncParentDirSync(path.dirname(target));
}

module.exports = { writeFileAtomic, writeFileAtomicSync, writeFileExclusiveSync };
