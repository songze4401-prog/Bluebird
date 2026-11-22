// 记忆持久化簇（健康度审计 R6，2026-11-21 自 memory.js 迁出）。
//
// 职责：磁盘形态升级（hydrateEntries）/ 墓碑状态装载（loadTombstoneState）/
// 记忆库装载（loadMemories，含损坏隔离与重试）/ 原子落盘（saveMemories）/
// 墓碑合写（commitWithTombstones，失败回滚还原墓碑状态）/ 写队列
// （enqueueWrite，Promise 链串行化），加 corruption 注册段。
//
// 设计边界（勿破坏）：
// - 三模块级状态（memories/memoryTombstones/writeQueue）留守 memory.js，
//   经共享容器 server/memory-core.js 的闭包对读写（getMemoryList/
//   setMemoryList/getTombstones/setTombstones/getWriteQueue/setWriteQueue）。
//   红线：memoryTombstones/writeQueue 有 live 重绑定与失败回滚还原
//   （commitWithTombstones 的 previousTombstones 还原路径），绝不能值快照。
// - 圈依赖经容器：registerCorruptionHandler/handleCorruption（corruption.js
//   在 46 圈内，R2b data-events 同款取舍）/logDataEvent。路径常量
//   memoryFile/memoryTombstoneFile 经容器（freshModule 语境跟随）。
// - 叶子依赖直 require：memory-tombstones（appendTombstones/loadTombstones/
//   saveTombstones）、atomic-write（writeFileAtomic/writeFileExclusiveSync）。
// - 零回边：不 require memory.js。同层依赖：ensureUniqueIds/normalizeEntry←
//   memory-extraction。
// - loadMemories() 的顶层调用留守 memory.js（注入块之后，顺序保持）；
//   corruption 注册段随迁（回调经容器与回注符号触达）。
//
// 消费方：memory.js 经解构回注（verifyStoreConsistency 的 hydrateEntries、
// 容器注入的六函数、顶层 loadMemories() 调用），调用点零改动。
const fs = require('fs');
const path = require('path');
const { memoryCore } = require('./memory-core');
const { appendTombstones, loadTombstones, saveTombstones } = require('./memory-tombstones');
const { writeFileAtomic, writeFileExclusiveSync } = require('./atomic-write');
const { ensureUniqueIds, normalizeEntry } = require('./memory-extraction');
// 损坏处理契约：detect 负责判定（读取失败 / JSON 解析失败 / 不是数组），
// recover 保持原有隔离策略（重命名为 <file>.corrupt-<ts>，失败则原地保留）。
function registerMemoryCorruptionHandler() {
  memoryCore().registerCorruptionHandler('memory', {
  detect(data) {
    if (data.error) {
      return {
        corrupt: true,
        // 允许调用方为"非解析型异常"（如初始化写盘失败）显式指定原因短码。
        reason: data.reason || 'read_error',
        error: data.error,
      };
    }

    let parsed;

    try {
      parsed = JSON.parse(data.text);
    } catch (error) {
      return { corrupt: true, reason: 'json_parse_error', error };
    }

    if (!Array.isArray(parsed)) {
      return { corrupt: true, reason: 'invalid_shape' };
    }

    return { corrupt: false, parsed };
  },

  recover(context) {
    // 处理策略不变（隔离重命名 + 回退空库）；结构化日志由 handleCorruption 统一记录，
    // 刻意不再打印 error.message：JSON.parse 的报错可能夹带文件内容（记忆正文）。
    let isolatedPath = null;

    try {
      const corruptPath = `${context.file}.corrupt-${Date.now()}`;

      fs.renameSync(context.file, corruptPath);

      isolatedPath = corruptPath;

      console.error(`Corrupt memory backed up: ${isolatedPath}`);
    } catch (backupError) {
      console.error('Memory backup error:', backupError.message);
    }

    return {
      action: isolatedPath ? 'isolated_file' : 'isolation_failed',
      isolatedPath,
    };
  },
});
}

// 磁盘数组 → 内存条目：过滤无效项、补齐贡献列表与身份/时效字段、id 去重。
// 读盘与写后自检都走这一条，两边才是同一种形态，比较结果才有意义。
function hydrateEntries(parsed) {
  return ensureUniqueIds(
    (Array.isArray(parsed) ? parsed : [])
      .filter(
        item =>
          item &&
          typeof item === 'object' &&
          typeof item.content === 'string' &&
          item.content.trim()
      )
      .map(normalizeEntry)
  );
}

function loadTombstoneState() {
  const loaded = loadTombstones(memoryCore().memoryTombstoneFile);

  memoryCore().setTombstones(loaded.tombstones);

  if (loaded.corrupt) {
    memoryCore().logDataEvent({
      module: 'memory',
      file: memoryCore().memoryTombstoneFile,
      event: 'data_file_corruption',
      level: 'error',
      reason: loaded.reason || 'invalid_shape',
      action: 'tombstones_unavailable',
      error: loaded.error,
    });
  }
}

function loadMemories() {
  loadTombstoneState();

  if (!fs.existsSync(memoryCore().memoryFile)) {
    let created = false;

    try {
      // 排他创建：并发启动时只有一个进程能创建空库。
      // 另一个进程得到 false（EEXIST）后必须继续读取现存文件，不能把内存设成空库。
      created = writeFileExclusiveSync(memoryCore().memoryFile, '[]\n');
    } catch (error) {
      // 初始化写盘失败：与旧实现一致地走损坏兜底（隔离 + 回退空库），不向上抛。
      memoryCore().handleCorruption(
        'memory',
        { text: null, error, reason: 'io_error' },
        { file: memoryCore().memoryFile }
      );
      memoryCore().setMemoryList([]);
      return;
    }

    if (created) {
      memoryCore().setMemoryList([]);
      return;
    }
  }

  let text = null;
  let error = null;

  try {
    text = fs.readFileSync(memoryCore().memoryFile, 'utf8');
  } catch (readError) {
    error = readError;
  }

  const outcome = memoryCore().handleCorruption(
    'memory',
    { text, error },
    { file: memoryCore().memoryFile }
  );

  if (outcome.corrupt) {
    memoryCore().setMemoryList([]);
    return;
  }

  memoryCore().setMemoryList(hydrateEntries(outcome.parsed));

  console.log(`Memory loaded: ${memoryCore().getMemoryList().length}`);
}

// 先在副本上算出新库 → await 落盘成功 → 才把内存换成新库。
// 落盘失败时异常原样抛给调用方（内存与磁盘都还是旧的，两边一致），
// 绝不出现"接口回 200、磁盘没改"的假成功。
async function saveMemories(nextMemories) {
  const dir = path.dirname(memoryCore().memoryFile);

  fs.mkdirSync(dir, { recursive: true });

  // 原子写（临时文件 'wx' + fsync + rename + 尽力 fsync 父目录），
  // 崩溃时不会出现空文件 / 截断文件。
  await writeFileAtomic(memoryCore().memoryFile, JSON.stringify(nextMemories, null, 2));
}

// 删除类操作先写墓碑再落记忆库：宁可删除失败，也不让已删除内容
// 在异步抽取的下一次写入里复活。记忆库写入失败时回滚墓碑。
async function commitWithTombstones(nextMemories, tombstoneEntries, reason) {
  const hasTombstones =
    Array.isArray(tombstoneEntries) && tombstoneEntries.some(Boolean);
  const previousTombstones = memoryCore().getTombstones();

  if (hasTombstones) {
    const nextTombstones = appendTombstones(
      previousTombstones,
      tombstoneEntries,
      { reason, now: new Date().toISOString() }
    );

    await saveTombstones(memoryCore().memoryTombstoneFile, nextTombstones);
    memoryCore().setTombstones(nextTombstones);
  }

  try {
    await saveMemories(nextMemories);
  } catch (error) {
    if (hasTombstones) {
      memoryCore().setTombstones(previousTombstones);

      try {
        await saveTombstones(memoryCore().memoryTombstoneFile, previousTombstones);
      } catch (rollbackError) {
        memoryCore().logDataEvent({
          module: 'memory',
          file: memoryCore().memoryTombstoneFile,
          event: 'memory_tombstone_rollback_failed',
          level: 'error',
          reason: 'rollback_failed',
          action: 'tombstone_rollback',
          error: rollbackError,
        });
      }
    }

    throw error;
  }
}

function enqueueWrite(task) {
  const run = memoryCore().getWriteQueue().then(task, task);

  memoryCore().setWriteQueue(run.catch(error => {
    // 结构化记录写入队列里的落盘失败（原本只有一行裸 message，无模块/路径/时间戳）。
    memoryCore().logDataEvent({
      module: 'memory',
      file: memoryCore().memoryFile,
      event: 'write_queue_error',
      error,
      action: 'write_failed',
    });
  }));
  return run;
}


// 这是定位/生命周期一致性检查，不是内容完整性哈希。字段集刻意只含条目 id、状态、
// 有效期/替代关系，以及贡献的会话归属、时间、原话、消息 id 和来源类型；不含 content
// 与 keywords，因此只篡改正文仍会得到 consistent:true。纳入正文会改变
// verifyStoreConsistency 的语义，需先经明确的产品决策。
function storeFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map(item =>
      JSON.stringify([
        (item && item.id) || null,
        (item && item.status) || null,
        (item && item.validFrom) || null,
        (item && item.validTo) || null,
        (item && item.supersededBy) || null,
        (Array.isArray(item && item.contributions) ? item.contributions : []).map(
          c => [
            (c && c.sessionId) || null,
            (c && c.createdAt) || null,
            (c && c.sourceQuote) || null,
            (c && c.messageId) || null,
            (c && c.sourceType) || null,
          ]
        ),
      ])
    )
    .join(';');
}

function verifyStoreConsistency() {
  const memoryList = Array.isArray(memoryCore().getMemoryList())
    ? memoryCore().getMemoryList()
    : [];

  let raw;
  try {
    raw = fs.readFileSync(memoryCore().memoryFile, 'utf8');
  } catch (error) {
    // 从没写过盘（首次运行 / 空库）时文件不存在，与「内存也是空」一致。
    if (error && error.code === 'ENOENT' && !memoryList.length) {
      return { consistent: true, entries: 0, reason: 'ok' };
    }

    return {
      consistent: false,
      entries: memoryList.length,
      reason: error && error.code === 'ENOENT' ? 'missing' : 'corrupt',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { consistent: false, entries: memoryList.length, reason: 'corrupt' };
  }

  if (!Array.isArray(parsed)) {
    return { consistent: false, entries: memoryList.length, reason: 'corrupt' };
  }

  // 磁盘形态先过一遍与读盘相同的升级（贡献列表 + 身份/时效字段 + id 去重）：
  // 旧数据在内存里是升级后的形态，直接拿原始 JSON 比会假报不一致。
  // 这套升级是幂等的，已升级过的库再过一次结果不变。
  const hydratedDisk = hydrateEntries(parsed);
  const diskFingerprint = storeFingerprint(hydratedDisk);
  const memoryFingerprint = storeFingerprint(memoryList);

  if (hydratedDisk.length !== memoryList.length) {
    return {
      consistent: false,
      entries: memoryList.length,
      diskEntries: parsed.length,
      diskValidEntries: hydratedDisk.length,
      reason: 'count-mismatch',
    };
  }

  if (diskFingerprint !== memoryFingerprint) {
    return {
      consistent: false,
      entries: memoryList.length,
      diskEntries: parsed.length,
      diskValidEntries: hydratedDisk.length,
      reason: 'mismatch',
    };
  }

  return { consistent: true, entries: memoryList.length, reason: 'ok' };
}


module.exports = {
  registerMemoryCorruptionHandler,
  verifyStoreConsistency,
  hydrateEntries,
  loadTombstoneState,
  loadMemories,
  saveMemories,
  commitWithTombstones,
  enqueueWrite,
};
