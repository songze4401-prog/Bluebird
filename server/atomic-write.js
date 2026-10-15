'use strict';

/**
 * 云岫 Bluebird — 持久化写入工具（原子 + fsync）
 *
 * 三个 JSON 状态模块（memory.js / emotion.js / sessions.js）共用本模块落盘，
 * 保证写入策略只有一套：先写带 pid 的临时文件，fsync 把数据钉死，再原子
 * rename 覆盖目标，最后尽力把 rename 的目录项也钉死。
 *
 * 为什么需要 fsync（AGENTS.md C2）：
 * 只 writeFile + rename 的话，rename 可能在页面缓存真正落盘之前就被提交，
 * 断电后目标文件可能是空文件或旧内容。fsync 把"数据已写稳"排在 rename 之前，
 * 关掉这个窗口。
 *
 * Windows 注意事项（实测）：
 * - 临时文件必须以 'w' 打开再 fsync；对只读 fd 调 fsync 会抛 EPERM。
 * - 目录 fsync 在 Windows 上要用 'r+' 打开目录（'r' 会 EPERM），
 *   而 POSIX 上 'r+' 打开目录会 EISDIR（'r' 才行）。两种都试，都不行就放弃：
 *   目录项这一步失败不影响已 fsync 的文件内容本身。
 */

const fs = require('fs');
const path = require('path');

/** 尽最大努力把目录项变更（rename）也钉到磁盘；不支持就静默放弃 */
function fsyncDirectory(dir) {
  for (const flag of ['r+', 'r']) {
    let fd;
    try {
      fd = fs.openSync(dir, flag);
    } catch (_) {
      continue; // 这种打开方式不行，换下一种
    }
    try {
      fs.fsyncSync(fd);
      return;
    } catch (_) {
      return; // 打开成功但 fsync 不被支持（如某些文件系统），放弃
    } finally {
      fs.closeSync(fd);
    }
  }
}

/**
 * 把 data 原子且持久地写入 filePath。
 *
 * - 临时文件名带 pid：多实例不会抢同一个固定名，避免 Windows 上后打开的一方
 *   撞 EPERM 直接崩溃。
 * - 任何一步失败都抛错，由调用方按自己的语义处理（回滚内存、上报错误）——
 *   绝不"写失败了还当成功"。
 *
 * @param {string} filePath 目标文件路径
 * @param {string} data 要写入的文本内容
 */
function writeFileDurable(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tmpFile = `${filePath}.tmp.${process.pid}`;

  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpFile, filePath);
  fsyncDirectory(path.dirname(filePath));
}

module.exports = { writeFileDurable };
